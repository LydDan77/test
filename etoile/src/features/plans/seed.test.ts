import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { Booking } from "@/db/schema";
import { createTestDb, type TestDb } from "@/db/testing";
import {
  actBySchema,
  bookingDetailsSchema,
  expenseSplitSchema,
  placeRefSchema,
  rsvpQuestionsSchema,
  siteSectionsSchema,
  validateRsvpAnswers,
} from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { computeReadiness, toolStates } from "@/lib/readiness";
import { isValidSlug } from "@/lib/slugs";
import { READINESS_COMPONENTS, templateConfig, type ReadinessComponent } from "@/lib/templates";
import { addDays, daysUntil, diffDays, isBusinessDay, localDateOf, nightsBetween, utcToZoned } from "@/lib/time";
import { buildExamplePlan } from "./example-plan";
import { findPlanData } from "./queries";
import { seedExamplePlan } from "./seed";
import { planStatus } from "./status";

// A Thursday afternoon in Minneapolis, 23 days before Saturday, December 19.
const NOW = new Date("2026-11-26T21:30:00Z");
const home = { kind: "home" as const, name: "Minneapolis", tz: "America/Chicago" };

let t: TestDb;
let user: { id: string; home: typeof home };
let data: PlanData;

async function addUser(email: string, zone = home) {
  const [row] = await t.db.insert(schema.users).values({ email, name: "Lydia Hartley", passwordHash: "x", home: zone }).returning();
  await t.db.insert(schema.clocks).values({ userId: row.id, place: zone, isHome: true });
  return { id: row.id, home: zone };
}

beforeAll(async () => {
  t = await createTestDb();
  user = await addUser("lydia@example.com");
  const seeded = await seedExamplePlan(user, { now: NOW });
  expect(seeded.created).toBe(true);
  data = (await findPlanData(user, seeded.planId!))!;
});
afterAll(() => t.close());

/**
 * Product spec 11.2, written out plainly and independently of src/lib/readiness: the points each
 * component earns for a plan in this state. Section 11.5 says the example must come to 68.
 */
function readinessPoints(plan: PlanData, now: Date): Record<ReadinessComponent, number> {
  const weights = templateConfig(plan.plan).weights;
  const today = localDateOf(now, plan.plan.tz);
  const coming = plan.people.filter((person) => person.rsvpStatus !== "no");
  const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

  // needed 0; planned 0.25; planned and waiting for the provider's window 0.5; looking 0.5; booked 1.
  const credit = (booking: Booking): number => {
    if (booking.status === "booked" || booking.status === "done") return 1;
    if (booking.status === "looking") return 0.5;
    if (booking.status === "planned") return booking.actBy.opensOn && booking.actBy.opensOn > today ? 0.5 : 0.25;
    return 0;
  };
  const ofKind = (kind: Booking["kind"]) => plan.bookings.filter((booking) => booking.kind === kind && booking.status !== "not_needed" && booking.status !== "cancelled");

  // Getting there: an arrival counts 60%, a departure 40%, per person who is coming.
  const travelling = (direction: "arrival" | "departure") => {
    const covered = new Set<string>();
    for (const row of plan.arrivals.filter((arrival) => arrival.direction === direction)) {
      const booking = plan.bookings.find((candidate) => candidate.id === row.bookingId);
      if (row.mode !== "flight" || booking?.status === "booked") row.personIds.forEach((id) => covered.add(id));
    }
    return coming.filter((person) => covered.has(person.id)).length / coming.length;
  };

  // Lodging: person-nights covered over person-nights needed.
  const nights = nightsBetween(plan.plan.startDate!, plan.plan.endDate!);
  let coveredNights = 0;
  for (const booking of ofKind("lodging")) {
    if (booking.details.kind !== "lodging" || booking.status !== "booked") continue;
    const stay = nightsBetween(booking.details.checkInDate!, booking.details.checkOutDate!);
    coveredNights += booking.personIds.filter((id) => coming.some((person) => person.id === id)).length * Math.min(stay, nights);
  }

  // Send ahead: planned 0.25, booked 0.5, shipped 0.75, delivered 1.
  const shipments = ofKind("shipment").map((booking) => {
    if (booking.details.kind !== "shipment") return 0;
    const statuses = booking.details.parcels.map((parcel) => parcel.status);
    if (statuses.length && statuses.every((status) => status === "delivered" || status === "picked_up")) return 1;
    if (statuses.some((status) => status === "shipped")) return 0.75;
    return booking.status === "booked" ? 0.5 : booking.status === "planned" ? 0.25 : 0;
  });

  const invited = plan.people.filter((person) => person.rsvpStatus !== "not_invited");
  const replied = invited.filter((person) => person.rsvpStatus !== "invited");
  const moments = plan.items.filter((item) => item.isKeyMoment);
  const essential = plan.tasks.filter((task) => task.essential);

  const fraction: Record<ReadinessComponent, number> = {
    gettingThere: 0.6 * travelling("arrival") + 0.4 * travelling("departure"),
    lodging: coveredNights / (coming.length * nights),
    car: average(ofKind("car").map(credit)),
    rides: average(ofKind("ride").map(credit)),
    meals: average(ofKind("meal").map(credit)),
    shipAhead: average(shipments),
    people: replied.length / invited.length,
    schedule: moments.filter((item) => item.startsAt && item.place).length / moments.length,
    site: plan.site?.status === "published" ? 1 : 0,
    tasks: essential.filter((task) => task.done).length / essential.length,
  };
  return Object.fromEntries(READINESS_COMPONENTS.map((component) => [component, weights[component] * fraction[component]])) as Record<ReadinessComponent, number>;
}

describe("the example plan", () => {
  it("is Hartley Family Christmas, marked as the example, 23 days out for 8 nights", () => {
    expect(data.plan).toMatchObject({
      title: "Hartley Family Christmas",
      isExample: true,
      template: "family_event",
      workMode: null,
      ownerId: user.id,
      startDate: "2026-12-19",
      endDate: "2026-12-27",
      dateStatus: "fixed",
      tz: "America/New_York",
      expectedPeople: 9,
      currency: "USD",
      archivedAt: null,
    });
    expect(daysUntil(data.plan.startDate!, data.plan.tz, NOW)).toBe(23);
    expect(nightsBetween(data.plan.startDate!, data.plan.endDate!)).toBe(8);
    expect(planStatus(data.plan, NOW)).toBe("upcoming");
    expect(data.plan.destination).toMatchObject({ kind: "city", name: "Orlando", region: "Florida", countryCode: "US" });
    expect(data.plan.kindsInUse).toEqual(["flight", "lodging", "car", "ride", "meal", "shipment"]);
    expect(data.plan.replyDeadline).toBe("2026-11-28");
  });

  it("computes to 68 with the weights and credits of product spec 11.2", () => {
    const points = readinessPoints(data, NOW);
    // The table of section 11.5, row by row.
    expect(points.gettingThere).toBeCloseTo(15, 5);
    expect(points.lodging).toBeCloseTo(15, 5);
    expect(points.car).toBe(0);
    expect(points.rides).toBeCloseTo(1.25, 5);
    expect(points.meals).toBeCloseTo(8.3333, 3);
    expect(points.shipAhead).toBeCloseTo(3.75, 5);
    expect(points.people).toBeCloseTo(11.6667, 3);
    expect(points.schedule).toBeCloseTo(4, 5);
    expect(points.site).toBe(5);
    expect(points.tasks).toBeCloseTo(4, 5);
    const total = Object.values(points).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(68, 5);
    expect(Math.round(total)).toBe(68);
  });

  it("computes to 68 and \"Needs attention\" with the app's own readiness function, the minivan first", () => {
    // The seam BUILD-SPEC section 6 names: computeReadiness(planData, templateConfig(plan), now).
    const readiness = computeReadiness(data, templateConfig(data.plan), NOW);
    expect(readiness.score).toBe(68);
    expect(readiness.pace).toBe("needs_attention");
    expect(readiness.leftOut).toEqual([]);
    expect(readiness.nextAction).toMatchObject({ component: "car", sentence: "Find the minivan.", dueBy: "2026-12-05", gain: 10 });
    const points = Object.fromEntries(readiness.breakdown.map((row) => [row.component, row.points]));
    expect(points).toMatchObject({ gettingThere: 15, lodging: 15, car: 0, rides: 1.25, shipAhead: 3.75, schedule: 4, site: 5, tasks: 4 });
    expect(points.meals).toBeCloseTo(8.33, 1);
    expect(points.people).toBeCloseTo(11.67, 1);
    // And the ten tiles read the way the plan was described.
    const tiles = Object.fromEntries(toolStates(data, templateConfig(data.plan), NOW).map((tile) => [tile.tool, tile.state]));
    expect(tiles).toMatchObject({
      flights: "All 9 booked",
      stay: "Booked: Lakeside house",
      car: "Needs you",
      food: "2 deliveries set",
      "send-ahead": "1 box on its way, arrives Dec 21",
      people: "7 of 9",
      schedule: "5 things planned",
      money: "$4,280 so far",
      page: "Live",
    });
  });

  it("has nine people in three households coming from three cities", () => {
    expect(data.people).toHaveLength(9);
    expect(data.parties.map((party) => party.name)).toEqual(["The Minneapolis Hartleys", "The Seattle Hartleys", "Dana and Chris"]);
    expect(data.parties.map((party) => party.origin?.name)).toEqual(["Minneapolis", "Seattle", "Portland"]);
    const sizes = data.parties.map((party) => data.people.filter((person) => person.partyId === party.id).length);
    expect(sizes).toEqual([5, 2, 2]);
    expect(data.people.filter((person) => person.role === "organizer").map((person) => person.name)).toEqual(["Lydia Hartley"]);
    expect(data.people.filter((person) => person.ageGroup === "child").map((person) => person.childAge).sort()).toEqual([11, 5, 8]);
    // Every household has its own secret link.
    expect(new Set(data.parties.map((party) => party.guestToken)).size).toBe(3);
  });

  it("has flights booked for all nine, both ways", () => {
    const flights = data.bookings.filter((booking) => booking.kind === "flight");
    expect(flights).toHaveLength(3);
    expect(flights.every((booking) => booking.status === "booked" && booking.confirmationCode)).toBe(true);
    expect(new Set(flights.flatMap((booking) => booking.personIds)).size).toBe(9);
    for (const booking of flights) {
      if (booking.details.kind !== "flight") throw new Error("not a flight");
      const { segments } = booking.details;
      // Out to Orlando on the first day, home from Orlando on the last.
      expect(segments.some((segment) => segment.destinationIata === "MCO" && utcToZoned(segment.arrivesAt, segment.destinationTz).date === "2026-12-19")).toBe(true);
      expect(segments.some((segment) => segment.originIata === "MCO" && utcToZoned(segment.departsAt, segment.originTz).date === "2026-12-27")).toBe(true);
      // Each leg lands after it takes off, and each connection leaves after the leg before lands.
      segments.forEach((segment, index) => {
        expect(Date.parse(segment.arrivesAt)).toBeGreaterThan(Date.parse(segment.departsAt));
        if (index > 0) expect(Date.parse(segment.departsAt)).toBeGreaterThan(Date.parse(segments[index - 1].arrivesAt));
      });
      expect(booking.startsAt?.toISOString()).toBe(new Date(segments[0].departsAt).toISOString());
      expect(booking.endsAt?.toISOString()).toBe(new Date(segments.at(-1)!.arrivesAt).toISOString());
    }
    // The canonical one: Alaska 1054 from Seattle.
    expect(flights.map((booking) => booking.title)).toContain("AS 1054 SEA to MCO");
  });

  it("has an arrival and a departure for each household, read from its flight", () => {
    expect(data.arrivals).toHaveLength(6);
    for (const party of data.parties) {
      const rows = data.arrivals.filter((arrival) => arrival.partyId === party.id);
      expect(rows.map((arrival) => arrival.direction).sort()).toEqual(["arrival", "departure"]);
      for (const row of rows) {
        const booking = data.bookings.find((candidate) => candidate.id === row.bookingId);
        if (booking?.details.kind !== "flight") throw new Error("arrival without its flight");
        const segment = booking.details.segments[row.segmentIndex!];
        // The segment an arrival points at lands in Orlando; a departure's leaves from it.
        expect(row.direction === "arrival" ? segment.destinationIata : segment.originIata).toBe("MCO");
        expect(row.scheduledAt?.toISOString()).toBe(new Date(row.direction === "arrival" ? segment.arrivesAt : segment.departsAt).toISOString());
        expect(row.tz).toBe("America/New_York");
        expect([...row.personIds].sort()).toEqual([...booking.personIds].sort());
        expect(row.toPlace?.iata).toBe("MCO");
      }
    }
  });

  it("has the lakeside house booked for eight nights, with everyone in a room", () => {
    const [house] = data.bookings.filter((booking) => booking.kind === "lodging");
    expect(house).toMatchObject({ status: "booked", title: "Lakeside house", priceAmount: 384_000, priceCurrency: "USD" });
    if (house.details.kind !== "lodging") throw new Error("not lodging");
    expect(house.details.lodgingType).toBe("rental");
    expect(nightsBetween(house.details.checkInDate!, house.details.checkOutDate!)).toBe(8);
    expect(house.details.checkInDate).toBe(data.plan.startDate);
    expect(house.personIds).toHaveLength(9);
    expect(house.details.rooms.flatMap((room) => room.personIds).sort()).toEqual(data.people.map((person) => person.id).sort());
    expect(data.people.every((person) => person.lodgingBookingId === house.id && person.room)).toBe(true);
    // The private part exists, so the share page has something real to keep hidden.
    expect(house.details.accessNotes).toContain("code");
    expect(house.details.place?.addressLines).toEqual(["418 Lakeshore Loop"]);
  });

  it("has the rental car needing booking, past its recommended date and before its hard one", () => {
    const [car] = data.bookings.filter((booking) => booking.kind === "car");
    expect(car.status).toBe("needed");
    expect(car.confirmationCode).toBeNull();
    // T minus 45 and T minus 14 (Dec 5 when the plan starts Dec 19).
    expect(car.actBy).toEqual({ recommended: "2026-11-04", hard: "2026-12-05" });
    const today = localDateOf(NOW, data.plan.tz);
    expect(car.actBy.recommended! < today && today < car.actBy.hard!).toBe(true);
  });

  it("has one airport pickup planned, meeting the two households that land in the evening", () => {
    const rides = data.bookings.filter((booking) => booking.kind === "ride");
    expect(rides).toHaveLength(1);
    const [pickup] = rides;
    expect(pickup.status).toBe("planned");
    if (pickup.details.kind !== "ride") throw new Error("not a ride");
    expect(pickup.details.rideType).toBe("personal_pickup");
    expect(pickup.details.fromPlace?.iata).toBe("MCO");
    expect(pickup.details.passengerIds).toHaveLength(4);
    const met = data.arrivals.filter((arrival) => pickup.details.kind === "ride" && pickup.details.arrivalIds.includes(arrival.id));
    expect(met).toHaveLength(2);
    expect(met.every((arrival) => arrival.direction === "arrival" && arrival.rideNeed === "needs_ride" && arrival.rideBookingId === pickup.id)).toBe(true);
    // One run: they land within 45 minutes of each other, and the pickup is after the last one.
    const landings = met.map((arrival) => arrival.scheduledAt!.getTime());
    expect(Math.abs(landings[0] - landings[1])).toBeLessThanOrEqual(45 * 60_000);
    expect(Date.parse(pickup.details.pickupAt!.at)).toBeGreaterThan(Math.max(...landings));
    // Planned, not settled: who, when and where are set, and no driver has been named yet.
    expect(pickup.details.driverPersonId).toBeUndefined();
    expect(met.every((arrival) => arrival.driverPersonId === null)).toBe(true);
    expect(data.people.filter((person) => person.canDrive && person.vehicleSeats).map((person) => person.name)).toEqual(["Rob Hartley"]);
    // Nobody else is waiting on a ride that does not exist.
    expect(data.arrivals.filter((arrival) => arrival.rideNeed === "needs_ride" || arrival.rideNeed === "unknown")).toHaveLength(2);
  });

  it("has two food deliveries set and a grocery order planned whose window is not open yet", () => {
    const meals = data.bookings.filter((booking) => booking.kind === "meal");
    expect(meals.map((booking) => [booking.title, booking.status])).toEqual([
      ["Groceries for the first days", "planned"],
      ["Pizza night", "booked"],
      ["Christmas Eve dinner", "booked"],
    ]);
    const groceries = meals[0];
    if (groceries.details.kind !== "meal") throw new Error("not a meal");
    expect(groceries.details.mealType).toBe("groceries");
    expect(groceries.details.orderOpensOn).toBe("2026-12-12");
    expect(groceries.actBy.opensOn).toBe("2026-12-12");
    expect(groceries.actBy.opensOn! > localDateOf(NOW, data.plan.tz)).toBe(true);
    for (const meal of meals) {
      if (meal.details.kind !== "meal") throw new Error("not a meal");
      expect(meal.details.headcount).toBe(9);
      expect(meal.details.dietarySummary).toBe("1 vegetarian, 1 nut allergy");
      expect(meal.details.deliverToPlace?.name).toBe("Lakeside house");
    }
    // The roll-up matches the people.
    expect(data.people.filter((person) => person.dietaryTags.includes("vegetarian"))).toHaveLength(1);
    expect(data.people.filter((person) => person.dietaryTags.includes("nut_allergy"))).toHaveLength(1);
  });

  it("has one box sent ahead and on its way, due on a delivery day on or after check-in", () => {
    const boxes = data.bookings.filter((booking) => booking.kind === "shipment");
    expect(boxes).toHaveLength(1);
    const [box] = boxes;
    if (box.details.kind !== "shipment") throw new Error("not a shipment");
    expect(box.status).toBe("booked");
    expect(box.details.parcels).toHaveLength(1);
    expect(box.details.parcels[0]).toMatchObject({ status: "shipped", trackingNumber: "1Z999AA10123456784" });
    // Product spec 15.1: a rental house, so not before check-in. Dec 19 is a Saturday: Monday Dec 21.
    expect(box.details.destinationType).toBe("vacation_rental");
    expect(box.details.targetDeliveryDate).toBe("2026-12-21");
    expect(box.details.targetDeliveryDate! >= data.plan.startDate!).toBe(true);
    expect(isBusinessDay(box.details.targetDeliveryDate!)).toBe(true);
    expect(box.details.shipByDate).toBe("2026-12-10");
    expect(box.details.propertyAnswers?.confirmed).toBe(true);
    expect(box.details.lodgingBookingId).toBe(data.bookings.find((booking) => booking.kind === "lodging")?.id);
  });

  it("has seven of nine replied", () => {
    const invited = data.people.filter((person) => person.rsvpStatus !== "not_invited");
    expect(invited).toHaveLength(9);
    expect(data.people.filter((person) => person.rsvpStatus === "yes")).toHaveLength(7);
    const waiting = data.people.filter((person) => person.rsvpStatus === "invited");
    expect(waiting.map((person) => person.name)).toEqual(["Chris Okafor", "Dana Hartley"]);
    expect(waiting.every((person) => person.rsvpAt === null)).toBe(true);
    expect(data.people.filter((person) => person.rsvpStatus === "yes").every((person) => person.rsvpAt && person.rsvpVia)).toBe(true);
  });

  it("has five key moments, two of them with a time and a place", () => {
    expect(data.items).toHaveLength(5);
    expect(data.items.every((item) => item.isKeyMoment && item.type === "event")).toBe(true);
    const settled = data.items.filter((item) => item.startsAt && item.place);
    expect(settled.map((item) => item.title)).toEqual(["Christmas Eve dinner", "Christmas morning brunch"]);
    // The other three have neither, so no reading of "a time and a place" counts them.
    expect(data.items.filter((item) => !item.startsAt && !item.place)).toHaveLength(3);
    for (const item of data.items) {
      expect(item.localDate >= data.plan.startDate! && item.localDate <= data.plan.endDate!).toBe(true);
      if (item.startsAt) expect(utcToZoned(item.startsAt, item.startTz).date).toBe(item.localDate);
      // Schedule items can be public: none carries the house's street or coordinates.
      expect(item.place?.addressLines).toBeUndefined();
      expect(item.place?.lat).toBeUndefined();
    }
    expect(utcToZoned(settled[0].startsAt!, settled[0].startTz).time).toBe("18:00");
  });

  it("has a published share page at a readable address", () => {
    expect(data.site).toMatchObject({ status: "published", slug: "hartley-christmas", access: "link", theme: "invitation", title: "Hartley Family Christmas", repliesOpen: true });
    expect(isValidSlug(data.site!.slug)).toBe(true);
    expect(data.site!.publishedAt!.getTime()).toBeLessThan(NOW.getTime());
    expect(data.site!.unpublishOn).toBe(addDays(data.plan.endDate!, 30));
    expect(data.site!.sections.filter((section) => section.enabled).map((section) => section.type)).toEqual([
      "cover", "announcement", "details", "schedule", "rsvp", "stay", "getting_there", "who", "bring", "weather", "faq", "contact",
    ]);
  });

  it("has five essential tasks with two done, and three things to bring with two claimed", () => {
    const essential = data.tasks.filter((task) => task.essential);
    expect(essential).toHaveLength(5);
    expect(essential.filter((task) => task.done).map((task) => task.title)).toEqual(["Ask about dietary needs", "Send everyone the link to the page"]);
    expect(essential.filter((task) => task.done).every((task) => task.doneAt)).toBe(true);
    const bring = data.tasks.filter((task) => task.kind === "bring");
    expect(bring).toHaveLength(3);
    expect(bring.filter((task) => task.claimedByPersonId)).toHaveLength(2);
    // The template's own tasks are all there, under their keys.
    const keys = data.tasks.map((task) => task.ruleKey).filter(Boolean);
    expect(keys.sort()).toEqual(templateConfig(data.plan).seededTasks.map((task) => task.ruleKey).sort());
  });

  it("has a few expenses: $4,280.00 paid so far, split by household, and one still to come", () => {
    expect(data.expenses).toHaveLength(5);
    const paid = data.expenses.filter((expense) => expense.status === "paid");
    expect(paid.reduce((sum, expense) => sum + expense.amount, 0)).toBe(428_000);
    expect(data.expenses.filter((expense) => expense.status === "planned").map((expense) => expense.amount)).toEqual([36_200]);
    expect(data.expenses.filter((expense) => expense.split.method === "by_party")).toHaveLength(4);
    // A booking with a price points at its expense, and the expense points back.
    for (const booking of data.bookings.filter((candidate) => candidate.priceAmount !== null)) {
      const expense = data.expenses.find((candidate) => candidate.id === booking.expenseId);
      expect(expense?.bookingId, booking.title).toBe(booking.id);
    }
    expect(data.settlements).toEqual([]);
    expect(data.handoffs).toEqual([]);
  });

  it("stores only shapes the domain schemas accept, and ids that point at rows of this plan", () => {
    const personIds = new Set(data.people.map((person) => person.id));
    expect(placeRefSchema.safeParse(data.plan.destination).success).toBe(true);
    expect(placeRefSchema.safeParse(data.plan.origin).success).toBe(true);
    for (const party of data.parties) expect(placeRefSchema.safeParse(party.origin).success).toBe(true);
    for (const booking of data.bookings) {
      expect(bookingDetailsSchema.safeParse(booking.details).success, booking.title).toBe(true);
      expect(actBySchema.safeParse(booking.actBy).success).toBe(true);
      expect(booking.personIds.every((id) => personIds.has(id)), booking.title).toBe(true);
      if (booking.paidByPersonId) expect(personIds.has(booking.paidByPersonId)).toBe(true);
    }
    for (const expense of data.expenses) {
      expect(expenseSplitSchema.safeParse(expense.split).success).toBe(true);
      expect(expense.split.parts.every((part) => personIds.has(part.personId))).toBe(true);
    }
    for (const arrival of data.arrivals) expect(arrival.personIds.every((id) => personIds.has(id))).toBe(true);
    for (const item of data.items) if (item.place) expect(placeRefSchema.safeParse(item.place).success).toBe(true);
    expect(siteSectionsSchema.safeParse(data.site!.sections).success).toBe(true);
    expect(rsvpQuestionsSchema.safeParse(data.site!.rsvpQuestions).success).toBe(true);
    // The answers people gave are answers to the page's own questions.
    for (const person of data.people.filter((candidate) => Object.keys(candidate.rsvpAnswers).length > 0)) {
      const checked = validateRsvpAnswers(data.site!.rsvpQuestions, person.rsvpAnswers);
      expect(checked.ok && Object.keys(checked.answers).length === Object.keys(person.rsvpAnswers).length, person.name).toBe(true);
    }
  });

  it("puts the destination's clock on Home, tagged with the plan, to leave a week after it ends", async () => {
    const clocks = await t.db.select().from(schema.clocks).where(eq(schema.clocks.userId, user.id));
    expect(clocks).toHaveLength(2);
    const orlando = clocks.find((clock) => !clock.isHome)!;
    expect(orlando).toMatchObject({ source: "plan", planId: data.plan.id, pinned: false, expiresOn: "2027-01-03" });
    expect(orlando.place.name).toBe("Orlando");
  });
});

describe("seeding again", () => {
  it("does not make a second example", async () => {
    const count = async (table: typeof schema.plans | typeof schema.people | typeof schema.bookings | typeof schema.sites | typeof schema.clocks) =>
      (await t.db.select().from(table)).length;
    const before = { plans: await count(schema.plans), people: await count(schema.people), bookings: await count(schema.bookings), sites: await count(schema.sites), clocks: await count(schema.clocks) };

    const again = await seedExamplePlan(user, { now: new Date(NOW.getTime() + 3 * 86_400_000) });
    expect(again).toEqual({ planId: data.plan.id, created: false });
    // Two at once (a double submit) are no different.
    const both = await Promise.all([seedExamplePlan(user), seedExamplePlan(user)]);
    expect(both.map((result) => result.created)).toEqual([false, false]);

    const after = { plans: await count(schema.plans), people: await count(schema.people), bookings: await count(schema.bookings), sites: await count(schema.sites), clocks: await count(schema.clocks) };
    expect(after).toEqual(before);
    // And the one that is there was not touched.
    const [plan] = await t.db.select().from(schema.plans).where(eq(schema.plans.id, data.plan.id));
    expect(plan.startDate).toBe("2026-12-19");
  });

  it("gives every account its own example at its own address", async () => {
    const other = await addUser("other@example.com", { kind: "home", name: "Tokyo", tz: "Asia/Tokyo" });
    const seeded = await seedExamplePlan(other, { now: NOW });
    expect(seeded.created).toBe(true);
    expect(seeded.planId).not.toBe(data.plan.id);
    const theirs = (await findPlanData(other, seeded.planId!))!;
    expect(theirs.site!.slug).toMatch(/^hartley-christmas-[0-9a-z]{6}$/);
    expect(isValidSlug(theirs.site!.slug)).toBe(true);
    expect(theirs.people).toHaveLength(9);
    // No row is shared between the two plans.
    const mine = new Set([...data.people, ...data.parties, ...data.bookings, ...data.tasks].map((row) => row.id));
    expect([...theirs.people, ...theirs.parties, ...theirs.bookings, ...theirs.tasks].some((row) => mine.has(row.id))).toBe(false);
    // One user's example is not the other's to load.
    expect(await findPlanData(user, seeded.planId!)).toBeNull();
    expect(await findPlanData(other, data.plan.id)).toBeNull();
  });

  it("leaves the example removed for someone who removed it, unless asked to bring it back", async () => {
    const gone = await addUser("gone@example.com");
    await t.db.update(schema.users).set({ exampleState: "removed" }).where(eq(schema.users.id, gone.id));
    expect(await seedExamplePlan(gone, { now: NOW })).toEqual({ planId: null, created: false });
    expect(await t.db.select().from(schema.plans).where(eq(schema.plans.ownerId, gone.id))).toHaveLength(0);

    const back = await seedExamplePlan(gone, { now: NOW, restore: true });
    expect(back.created).toBe(true);
    const [account] = await t.db.select().from(schema.users).where(eq(schema.users.id, gone.id));
    expect(account.exampleState).toBe("seeded");
  });

  it("does nothing for an account that does not exist", async () => {
    expect(await seedExamplePlan({ id: "nobody000000", home }, { now: NOW })).toEqual({ planId: null, created: false });
  });
});

describe("the example's dates", () => {
  it("always start 23 days out for 8 nights, whenever the account is made", () => {
    const moments = [
      "2026-11-26T21:30:00Z",
      "2026-11-27T04:59:00Z", // 11:59 PM in Orlando
      "2026-11-27T05:00:00Z", // midnight in Orlando
      "2026-03-07T12:00:00Z", // the plan straddles the start of daylight saving
      "2026-10-10T12:00:00Z", // and its end
      "2027-02-05T18:00:00Z", // crosses February into March
      "2026-12-20T12:00:00Z", // crosses New Year
    ];
    for (const moment of moments) {
      const now = new Date(moment);
      const rows = buildExamplePlan({ ownerId: "owner0000000", slug: "hartley-christmas", now });
      expect(daysUntil(rows.plan.startDate!, rows.plan.tz, now), moment).toBe(23);
      expect(diffDays(rows.plan.startDate!, rows.plan.endDate!), moment).toBe(8);
      // Whatever the season, every booking still parses and the flights still make sense.
      for (const booking of rows.bookings) {
        expect(bookingDetailsSchema.safeParse(booking.details).success, `${moment} ${booking.title}`).toBe(true);
        if (booking.startsAt && booking.endsAt) expect(booking.endsAt.getTime(), booking.title).toBeGreaterThan(booking.startsAt.getTime());
      }
      const box = rows.bookings.find((booking) => booking.kind === "shipment")!;
      if (box.details.kind !== "shipment") throw new Error("not a shipment");
      expect(box.details.targetDeliveryDate! >= rows.plan.startDate!, moment).toBe(true);
      expect(isBusinessDay(box.details.targetDeliveryDate!), moment).toBe(true);
      expect(box.details.targetDeliveryDate!.endsWith("-12-25"), moment).toBe(false);
    }
  });

  it("builds fresh ids every time", () => {
    const a = buildExamplePlan({ ownerId: "owner0000000", slug: "a-slug", now: NOW });
    const b = buildExamplePlan({ ownerId: "owner0000000", slug: "b-slug", now: NOW });
    expect(a.plan.id).not.toBe(b.plan.id);
    expect(a.people.map((person) => person.id)).not.toEqual(b.people.map((person) => person.id));
  });
});
