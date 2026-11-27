import { describe, expect, it } from "vitest";
import type { Booking, Party, Person } from "@/db/schema";
import type { BookingKind, PlaceRef } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { airport, at, makeArrival, makeBooking, makeExpense, makeItem, makeParty, makePerson, makePlan, makePlanData, makeSite, makeTask, seg, timedItem } from "@/lib/people/testing";
import { zonedToUtc } from "@/lib/time";
import { computeReadiness, toolStates } from "./readiness";
import { READINESS_COMPONENTS, TOOLS, type ReadinessConfig, type ReadinessWeights } from "./types";

const NY = "America/New_York";
const ALL_KINDS: BookingKind[] = ["flight", "lodging", "car", "ride", "meal", "shipment"];
const house: PlaceRef = { kind: "lodging", name: "Lakeside house", tz: NY };

// The four columns of product spec 11.2.
const FAMILY: ReadinessWeights = { gettingThere: 15, lodging: 15, car: 10, rides: 5, meals: 10, shipAhead: 5, people: 15, schedule: 10, site: 5, tasks: 10 };
const TRIP: ReadinessWeights = { gettingThere: 25, lodging: 25, car: 10, rides: 5, meals: 5, shipAhead: 5, people: 5, schedule: 5, site: 5, tasks: 10 };
const WORK_TRAVEL: ReadinessWeights = { gettingThere: 30, lodging: 25, car: 5, rides: 10, meals: 5, shipAhead: 5, people: 0, schedule: 10, site: 0, tasks: 10 };
const WORK_EVENT: ReadinessWeights = { gettingThere: 15, lodging: 15, car: 0, rides: 5, meals: 10, shipAhead: 5, people: 15, schedule: 15, site: 10, tasks: 10 };
const family: ReadinessConfig = { weights: FAMILY, words: { person: "guest", people: "guests", party: "household", parties: "households" } };

const on = (local: string) => zonedToUtc(local, NY);
const sentences = (data: PlanData, config: ReadinessConfig, now: Date) => computeReadiness(data, config, now).thingsLeft.map((t) => t.sentence);
const tile = (data: PlanData, config: ReadinessConfig, now: Date, tool: string) => {
  const t = toolStates(data, config, now).find((s) => s.tool === tool)!;
  return [t.state, t.note, t.tone];
};

it("every column of weights in the product spec adds up to 100", () => {
  for (const weights of [FAMILY, TRIP, WORK_TRAVEL, WORK_EVENT]) {
    expect(READINESS_COMPONENTS.reduce((sum, c) => sum + weights[c], 0)).toBe(100);
  }
});

describe("a brand-new family plan: no dates, nobody added, nothing booked", () => {
  const plan = makePlan({ title: "Reunion", expectedPeople: 9, kindsInUse: ALL_KINDS });
  const data = makePlanData({ plan });
  const now = on("2026-06-01T10:00");
  const r = computeReadiness(data, family, now);

  it("starts at zero, on track, with the next action the spec names", () => {
    expect(r.score).toBe(0);
    expect(r.pace).toBe("on_track");
    expect(r.paceReason).toBeNull();
    expect(r.nextAction).toMatchObject({ sentence: "Add your flights.", actionLabel: "Add flights", target: { tool: "flights", href: `/plans/${plan.id}/flights` }, dueBy: null, urgency: 1 });
    expect(r.nextAction?.detail).toBe("Search with your dates filled in, or record what you already booked.");
  });

  it("lists what there is to do in plain sentences, each with its own button", () => {
    expect(r.thingsLeft.map((t) => [t.sentence, t.actionLabel, t.waiting])).toEqual([
      ["Add your flights.", "Add flights", false],
      ["Find a place to stay.", "Find a stay", false],
      ["Add the guests coming.", "Add people", false],
      ["Find the car.", "Find a car", false],
      ["Plan the food.", "Plan food", false],
      ["Add the main moments to the schedule.", "Open the schedule", false],
      ["Decide what to send ahead.", "Plan what to send", false],
      ["Publish your page.", "Review and publish", false],
      ["Rides come after arrivals.", "See arrivals", true],
    ]);
    expect(r.headline).toBe("8 things left");
    // No essential to-dos yet, so that component is left out and the rest are scaled to 100.
    expect(r.leftOut).toEqual(["tasks"]);
    expect(r.breakdown.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(100, 1);
    expect(r.breakdown.find((row) => row.component === "gettingThere")?.weight).toBeCloseTo(16.67, 2);
  });

  it("gives every tool a line", () => {
    const tools = toolStates(data, family, now);
    expect(tools.map((t) => t.tool)).toEqual([...TOOLS]);
    expect(tools.map((t) => [t.tool, t.state, t.tone])).toEqual([
      ["flights", "Needs you", "needs_you"],
      ["stay", "Needs you", "needs_you"],
      ["car", "Needs you", "needs_you"],
      ["rides", "Nothing to plan yet", "waiting"],
      ["food", "Needs you", "needs_you"],
      ["send-ahead", "Needs you", "needs_you"],
      ["people", "Add people", "needs_you"],
      ["schedule", "Nothing yet", "needs_you"],
      ["money", "Nothing yet", "off"],
      ["page", "Not started", "needs_you"],
    ]);
  });
});

/** One person, one work trip, everything done. */
function soloWorkTrip() {
  const austin: PlaceRef = { kind: "city", name: "Austin", tz: "America/Chicago" };
  const plan = makePlan({ template: "work", workMode: "travel", title: "Austin kickoff", destination: austin, tz: austin.tz, startDate: "2027-01-12", endDate: "2027-01-15", kindsInUse: ["flight", "lodging", "ride"] });
  const me = makeParty(plan.id, "Me");
  const lydia = makePerson(me, "Lydia Hartley", { role: "organizer" });
  const flights = makeBooking(
    plan.id,
    "flight",
    { tripType: "round_trip", segments: [seg("AS 580", "SEA", "2027-01-12T08:00", "AUS", "2027-01-12T14:10"), seg("AS 581", "AUS", "2027-01-15T16:00", "SEA", "2027-01-15T18:25")] },
    { personIds: [lydia.id] },
  );
  const hotel = makeBooking(plan.id, "lodging", { lodgingType: "hotel", propertyName: "Hotel Ella", checkInDate: "2027-01-12", checkOutDate: "2027-01-15" });
  const ride = makeBooking(plan.id, "ride", { rideType: "rideshare", fromPlace: airport("AUS"), pickupAt: at("2027-01-12T14:40", austin.tz), passengerIds: [lydia.id] }, { provider: "lyft" });
  const kickoff = timedItem(plan.id, "Kickoff", "2027-01-13T09:00", "2027-01-13T17:00", { startTz: austin.tz, place: { kind: "venue", name: "Client office", tz: austin.tz }, isKeyMoment: true });
  const tasks = [makeTask(plan.id, "Confirm approval", { essential: true, done: true }), makeTask(plan.id, "Note the project code", { essential: true, done: true })];
  const data = makePlanData({ plan, parties: [me], people: [lydia], bookings: [flights, hotel, ride], items: [kickoff], tasks });
  return { data, plan, lydia, flights, hotel, ride, kickoff };
}
const workTravel: ReadinessConfig = { weights: WORK_TRAVEL, words: { person: "traveler", people: "travelers", party: "team", parties: "teams", timeline: "Schedule" } };

describe("one person, travelling for work", () => {
  const now = zonedToUtc("2027-01-02T09:00", "America/Chicago");

  it("is ready, at 100, when everything that counts is done", () => {
    const { data } = soloWorkTrip();
    const r = computeReadiness(data, workTravel, now);
    expect(r).toMatchObject({ score: 100, pace: "ready", paceLabel: "Ready", nextAction: null, thingsLeft: [], thingsLeftCount: 0, headline: "All set" });
    // Car, food and send-ahead are not in this plan; who's coming and the share page carry no weight.
    expect(r.leftOut).toEqual(["car", "meals", "shipAhead", "people", "site"]);
    expect(r.breakdown.map((row) => [row.component, row.weight, row.credit])).toEqual([
      // 30, 25, 10, 10 and 10 of the 85 points that apply, scaled to 100.
      ["gettingThere", 35.29, 1],
      ["lodging", 29.41, 1],
      ["rides", 11.76, 1],
      ["schedule", 11.76, 1],
      ["tasks", 11.76, 1],
    ]);
    expect(r.breakdown.find((row) => row.component === "schedule")?.label).toBe("Schedule");
    expect(r.breakdown.find((row) => row.component === "lodging")?.state).toBe("Hotel Ella, 3 nights, sorted");
  });

  it("describes a solo trip's tools without counting heads", () => {
    const { data } = soloWorkTrip();
    const tools = Object.fromEntries(toolStates(data, workTravel, now).map((t) => [t.tool, [t.state, t.tone, t.label]]));
    expect(tools).toMatchObject({
      flights: ["Booked", "done", "Flights"],
      stay: ["Booked: Hotel Ella", "done", "Stay"],
      car: ["Not planned", "off", "Car"],
      rides: ["Airport pickup set", "done", "Rides"],
      food: ["Not planned", "off", "Food"],
      "send-ahead": ["Not planned", "off", "Send ahead"],
      people: ["Just you", "done", "Who's coming"],
      schedule: ["1 thing planned", "done", "Schedule"],
      page: ["Not started", "needs_you", "Share page"],
    });
  });

  it("stops at 99 until the last thing is done, however small", () => {
    const { data, plan } = soloWorkTrip();
    const tasks = Array.from({ length: 200 }, (_, i) => makeTask(plan.id, `Thing ${i}`, { essential: true, done: i !== 0 }));
    const r = computeReadiness({ ...data, tasks }, workTravel, now);
    expect(r.score).toBe(99);
    expect(r.pace).toBe("on_track");
    expect(r.headline).toBe("1 thing left");
    expect(r.thingsLeft[0]).toMatchObject({ sentence: "Thing 0.", detail: null, actionLabel: "Mark done", kind: "task", target: { tool: "hub", href: `/plans/${plan.id}` } });
  });

  it("asks a lone traveler for their own travel, in the second person", () => {
    const { data, hotel } = soloWorkTrip();
    const nothing = computeReadiness({ ...data, bookings: [hotel] }, workTravel, now);
    expect(nothing.thingsLeft.map((t) => [t.sentence, t.detail, t.actionLabel, t.target.tool])).toContainEqual([
      "Add how you are getting there and back.",
      "Add your flight, or say you are driving.",
      "Add your travel",
      "flights",
    ]);
    const { flights } = soloWorkTrip();
    const oneWay = { ...flights, details: { ...flights.details, segments: [seg("AS 580", "SEA", "2027-01-12T08:00", "AUS", "2027-01-12T14:10")], tripType: "one_way" } as Booking["details"] };
    const half = computeReadiness({ ...data, bookings: [hotel, oneWay] }, workTravel, now);
    expect(half.thingsLeft.map((t) => t.sentence)).toContain("Add how you are getting home.");
    // The way there is 60% of getting there.
    expect(half.breakdown.find((row) => row.component === "gettingThere")?.credit).toBe(0.6);
  });
});

/** Four people in two households, a week in Orlando. The base for most of what follows. */
function trip(over: Partial<Parameters<typeof makePlan>[0]> = {}) {
  const plan = makePlan({ template: "trip", startDate: "2026-12-19", endDate: "2026-12-27", expectedPeople: 4, kindsInUse: ["flight", "lodging", "car", "ride"], ...over });
  const seattle = makeParty(plan.id, "The Seattle Hartleys", { sortOrder: 0 });
  const portland = makeParty(plan.id, "The Portland Hartleys", { sortOrder: 1 });
  const lydia = makePerson(seattle, "Lydia Hartley");
  const mark = makePerson(seattle, "Mark Hartley");
  const dana = makePerson(portland, "Dana Hartley");
  const chris = makePerson(portland, "Chris Hartley");
  const parties: Party[] = [seattle, portland];
  const people: Person[] = [lydia, mark, dana, chris];
  const flightsFor = (who: Person[], n: number) =>
    makeBooking(plan.id, "flight", { tripType: "round_trip", segments: [seg(`AS ${n}`, "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"), seg(`AS ${n + 1}`, "MCO", "2026-12-27T13:30", "SEA", "2026-12-27T16:45")] }, { personIds: who.map((p) => p.id) });
  const stay = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27" });
  const car = makeBooking(plan.id, "car", { company: "Hertz", vehicleClass: "suv" });
  const site = makeSite(plan.id, { status: "published" });
  const moment = timedItem(plan.id, "Theme park day", "2026-12-21T09:00", null, { place: { kind: "venue", name: "The park", tz: NY }, isKeyMoment: true });
  const ownCar = (party: Party) => [makeArrival(party, "arrival", { mode: "drive", scheduledAt: on("2026-12-19T15:00"), tz: NY }), makeArrival(party, "departure", { mode: "drive", scheduledAt: on("2026-12-27T10:00"), tz: NY })];
  const data = (parts: Partial<PlanData> = {}) => makePlanData({ plan, parties, people, site, items: [moment], ...parts });
  return { plan, seattle, portland, lydia, mark, dana, chris, parties, people, flightsFor, stay, car, site, moment, ownCar, data };
}
const tripConfig: ReadinessConfig = { weights: TRIP, words: { person: "traveler", people: "travelers", party: "group", parties: "groups", timeline: "Schedule" } };
const early = on("2026-10-01T10:00");

describe("what counts, and what is left out", () => {
  it("leaves out kinds the plan does not use, and scales the rest to 100", () => {
    const t = trip();
    const r = computeReadiness(t.data({ bookings: [t.flightsFor(t.people, 100), t.stay, t.car] }), tripConfig, early);
    expect(r.leftOut).toEqual(["meals", "shipAhead", "tasks"]);
    expect(r.breakdown.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(100, 1);
    // 25 of the 80 points that apply.
    expect(r.breakdown.find((row) => row.component === "lodging")?.weight).toBe(31.25);
  });

  it("counts a kind that is off in the template once something of it is planned", () => {
    const t = trip();
    const groceries = makeBooking(t.plan.id, "meal", { mealType: "groceries", windowStart: at("2026-12-19T17:00", NY) }, { status: "planned" });
    const r = computeReadiness(t.data({ bookings: [groceries] }), tripConfig, early);
    expect(r.leftOut).not.toContain("meals");
    expect(r.breakdown.find((row) => row.component === "meals")).toMatchObject({ credit: 0.25, state: "0 of 1 order placed" });
  });

  it("drops a kind the person marked not needed, whichever way they said it", () => {
    const t = trip({ kindsNotNeeded: ["car"] });
    expect(computeReadiness(t.data(), tripConfig, early).leftOut).toContain("car");
    expect(tile(t.data(), tripConfig, early, "car")).toEqual(["Not needed", null, "off"]);

    const u = trip();
    const declined = { ...u.car, status: "not_needed" as const };
    expect(computeReadiness(u.data({ bookings: [declined] }), tripConfig, early).leftOut).toContain("car");
    // Cancelled is different: it was wanted, and is not booked any more.
    const cancelled = { ...u.car, status: "cancelled" as const };
    const r = computeReadiness(u.data({ bookings: [cancelled] }), tripConfig, early);
    expect(r.leftOut).not.toContain("car");
    expect(r.breakdown.find((row) => row.component === "car")).toMatchObject({ credit: 0, state: "Needs you" });
  });

  it("drops flights when the person said they are not needed, and the stay for a one-day plan", () => {
    const t = trip({ kindsNotNeeded: ["flight"], endDate: "2026-12-19" });
    const r = computeReadiness(t.data(), tripConfig, early);
    expect(r.leftOut).toEqual(expect.arrayContaining(["gettingThere", "lodging"]));
    expect(tile(t.data(), tripConfig, early, "flights")).toEqual(["Not needed", null, "off"]);
  });

  it("leaves out who's coming for a plan of one, and counts it for a plan expecting more", () => {
    const { data } = soloWorkTrip();
    expect(computeReadiness(data, { weights: FAMILY }, early).leftOut).toContain("people");
    const expecting = { ...data, plan: { ...data.plan, expectedPeople: 6 } };
    expect(computeReadiness(expecting, { weights: FAMILY }, early).leftOut).not.toContain("people");
  });
});

describe("partial credit for a booking (product spec 11.2)", () => {
  const credit = (data: PlanData, component: string, config = tripConfig) => computeReadiness(data, config, early).breakdown.find((row) => row.component === component)?.credit;

  it("gives 0 needed, 0.25 planned, 0.5 looking, 1 booked", () => {
    const t = trip();
    const car = (status: Booking["status"]) => t.data({ bookings: [{ ...t.car, status }] });
    expect([credit(car("needed"), "car"), credit(car("planned"), "car"), credit(car("looking"), "car"), credit(car("booked"), "car"), credit(car("done"), "car")]).toEqual([0, 0.25, 0.5, 1, 1]);
    // Two cars: the average.
    const second = makeBooking(t.plan.id, "car", {}, { status: "planned" });
    expect(credit(t.data({ bookings: [t.car, second] }), "car")).toBe(0.63);
  });

  it("counts a meal that is planned and waiting for its order window as half done", () => {
    const t = trip();
    const meal = (opensOn: string) => makeBooking(t.plan.id, "meal", { mealType: "groceries", windowStart: at("2026-12-19T17:00", NY), orderOpensOn: opensOn }, { status: "planned" });
    expect(credit(t.data({ bookings: [meal("2026-12-14")] }), "meals")).toBe(0.5);
    expect(credit(t.data({ bookings: [meal("2026-09-01")] }), "meals")).toBe(0.25);
  });

  it("walks a shipment from planned to delivered", () => {
    const t = trip();
    const box = (status: Booking["status"], parcels: { status: "planned" | "packed" | "shipped" | "delivered" | "picked_up" }[]) =>
      t.data({ bookings: [makeBooking(t.plan.id, "shipment", { shipmentKind: "box", shipByDate: "2026-12-10", targetDeliveryDate: "2026-12-21", parcels }, { status })] });
    expect(credit(box("planned", []), "shipAhead")).toBe(0.25);
    expect(credit(box("booked", [{ status: "packed" }]), "shipAhead")).toBe(0.5);
    expect(credit(box("booked", [{ status: "shipped" }]), "shipAhead")).toBe(0.75);
    expect(credit(box("booked", [{ status: "shipped" }, { status: "packed" }]), "shipAhead")).toBe(0.5);
    expect(credit(box("booked", [{ status: "delivered" }, { status: "picked_up" }]), "shipAhead")).toBe(1);
  });

  it("counts arrival as 60% and departure as 40% of getting there, per person", () => {
    const t = trip();
    const arrivalOnly = makeBooking(t.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 100", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] }, { personIds: [t.lydia.id, t.mark.id] });
    const data = t.data({ bookings: [arrivalOnly] });
    // Two of four have a way there (60% each), nobody has a way home.
    expect(credit(data, "gettingThere")).toBe(0.3);
    expect(computeReadiness(data, tripConfig, early).breakdown.find((row) => row.component === "gettingThere")?.state).toBe("2 of 4 have a way there, 0 of 4 a way home");
  });

  it("gives half credit both ways while a flight is still being looked for", () => {
    const t = trip();
    const looking = makeBooking(t.plan.id, "flight", {}, { status: "looking", provider: "kayak", personIds: t.people.map((p) => p.id), actBy: { recommended: "2026-11-04", hard: "2026-12-05" } });
    const r = computeReadiness(t.data({ bookings: [looking] }), tripConfig, early);
    expect(r.breakdown.find((row) => row.component === "gettingThere")?.credit).toBe(0.5);
    expect(r.thingsLeft.find((x) => x.kind === "flights")).toMatchObject({
      sentence: "Did you book the flights?",
      detail: "You were looking on Kayak. Book by Nov 4.",
      actionLabel: "Record the booking",
      dueBy: "2026-11-04",
    });
    expect(tile(t.data({ bookings: [looking] }), tripConfig, early, "flights")).toEqual(["Still looking", null, "needs_you"]);
  });

  it("counts person-nights for the stay", () => {
    const t = trip();
    const half = makeBooking(t.plan.id, "lodging", { propertyName: "Lakeside house", checkInDate: "2026-12-19", checkOutDate: "2026-12-23" });
    const r = computeReadiness(t.data({ bookings: [half] }), tripConfig, early);
    expect(r.breakdown.find((row) => row.component === "lodging")).toMatchObject({ credit: 0.5, state: "16 of 32 nights booked" });
    expect(r.thingsLeft.find((x) => x.kind === "stay")).toMatchObject({ sentence: "Nowhere to stay on the nights of Dec 23–26 yet.", actionLabel: "Sort out the stay" });
    expect(tile(t.data({ bookings: [half] }), tripConfig, early, "stay")).toEqual(["16 of 32 nights booked", "Lakeside house", "needs_you"]);
  });
});

describe("pace (product spec 11.3)", () => {
  const t = trip();
  const carWith = (actBy: Booking["actBy"]) => t.data({ bookings: [t.flightsFor(t.people, 100), t.stay, { ...t.car, status: "needed" as const, actBy }] });
  const dates = { recommended: "2026-11-19", hard: "2026-12-12" };

  it("is on track before the recommended date, and more urgent in the week before it", () => {
    const far = computeReadiness(carWith(dates), tripConfig, on("2026-11-01T10:00"));
    expect(far).toMatchObject({ pace: "on_track", paceLabel: "On track", paceReason: null });
    expect(far.thingsLeft.find((x) => x.kind === "car")).toMatchObject({ urgency: 1, dueBy: "2026-11-19", detail: "Book by Nov 19." });
    const close = computeReadiness(carWith(dates), tripConfig, on("2026-11-13T10:00"));
    expect(close.pace).toBe("on_track");
    expect(close.thingsLeft.find((x) => x.kind === "car")?.urgency).toBe(1.5);
    // On the recommended day itself it has not passed yet.
    expect(computeReadiness(carWith(dates), tripConfig, on("2026-11-19T23:00")).pace).toBe("on_track");
  });

  it("needs attention once the recommended date has passed", () => {
    const r = computeReadiness(carWith(dates), tripConfig, on("2026-11-20T08:00"));
    expect(r).toMatchObject({ pace: "needs_attention", paceLabel: "Needs attention", paceReason: "Find the SUV." });
    expect(r.nextAction).toMatchObject({ sentence: "Find the SUV.", detail: "Book by Dec 12.", actionLabel: "Find an SUV", urgency: 2, dueBy: "2026-12-12" });
  });

  it("is at risk on the last day and after it", () => {
    const lastDay = computeReadiness(carWith(dates), tripConfig, on("2026-12-12T08:00"));
    expect(lastDay).toMatchObject({ pace: "at_risk", paceLabel: "At risk" });
    expect(lastDay.nextAction).toMatchObject({ detail: "Book today.", urgency: 3 });
    const after = computeReadiness(carWith(dates), tripConfig, on("2026-12-15T08:00"));
    expect(after.nextAction?.detail).toBe("This was due Dec 12.");
    expect(after.pace).toBe("at_risk");
  });

  it("is at risk when an essential to-do is overdue, and not for one that is only due today", () => {
    const task = makeTask(t.plan.id, "Renew the passports", { essential: true, dueDate: "2026-11-10" });
    const base = t.data({ bookings: [t.flightsFor(t.people, 100), t.stay, t.car], tasks: [task] });
    const dueToday = computeReadiness(base, tripConfig, on("2026-11-10T12:00"));
    expect(dueToday.pace).toBe("on_track");
    expect(dueToday.thingsLeft.find((x) => x.kind === "task")).toMatchObject({ detail: "Due today.", dueBy: "2026-11-10", urgency: 1.5 });
    const overdue = computeReadiness(base, tripConfig, on("2026-11-11T12:00"));
    expect(overdue).toMatchObject({ pace: "at_risk", paceReason: "Renew the passports." });
    expect(overdue.thingsLeft.find((x) => x.kind === "task")).toMatchObject({ detail: "This was due Nov 10.", dueBy: "2026-11-10", urgency: 3 });
    // An ordinary to-do that is overdue does not count.
    const ordinary = { ...base, tasks: [{ ...task, essential: false }] };
    expect(computeReadiness(ordinary, tripConfig, on("2026-11-20T12:00")).pace).toBe("on_track");
  });

  it("uses the template's dates for a kind with no booking yet, and adds the holiday reason", () => {
    const withDates: ReadinessConfig = { ...tripConfig, holidayPeriod: true, actBy: { car: dates, flight: { recommended: "2026-10-20", hard: "2026-11-28" }, lodging: { recommended: "2026-10-20", hard: "2026-11-28" } } };
    const r = computeReadiness(t.data(), withDates, on("2026-11-20T08:00"));
    expect(r.pace).toBe("needs_attention");
    const byKind = Object.fromEntries(r.thingsLeft.map((x) => [x.key, x.detail]));
    expect(byKind["car:none"]).toBe("Book by Dec 12. Holiday rentals sell out.");
    expect(byKind["stay:none"]).toBe("8 nights for 4 people. Book by Nov 28. Holiday stays go early.");
    expect(byKind["flights:missing"]).toBe("Add their flight, or say they are driving. Book by Nov 28.");
    // Without the template's dates nothing has a deadline, so nothing is late.
    expect(computeReadiness(t.data(), tripConfig, on("2026-12-18T08:00")).pace).toBe("on_track");
  });

  it("never lets the share page's date set the pace, though it moves it up the list", () => {
    const draft = t.data({ bookings: [t.flightsFor(t.people, 100), t.stay, t.car], site: makeSite(t.plan.id, { status: "draft" }) });
    const r = computeReadiness(draft, tripConfig, on("2026-12-01T08:00"));
    expect(r.pace).toBe("on_track");
    expect(r.thingsLeft.find((x) => x.kind === "page")).toMatchObject({ sentence: "Publish your page.", detail: "The draft is ready. One link gives everyone the details.", urgency: 2, dueBy: "2026-11-19" });
  });
});

describe("the next action (product spec 11.4)", () => {
  it("is the most to gain times how pressing it is: a small thing past its last day beats a big thing with time", () => {
    const t = trip();
    // The stay (25 points) has months; the car (10 points) is past its last day: 10 × 3 beats 25 × 1.
    const car = { ...t.car, status: "needed" as const, actBy: { recommended: "2026-09-01", hard: "2026-09-20" } };
    const r = computeReadiness(t.data({ bookings: [t.flightsFor(t.people, 100), car] }), tripConfig, on("2026-10-01T10:00"));
    expect(r.thingsLeft.slice(0, 2).map((x) => x.kind)).toEqual(["car", "stay"]);
    const relaxed = { ...car, actBy: {} };
    const s = computeReadiness(t.data({ bookings: [t.flightsFor(t.people, 100), relaxed] }), tripConfig, on("2026-10-01T10:00"));
    expect(s.thingsLeft.slice(0, 2).map((x) => x.kind)).toEqual(["stay", "car"]);
  });

  it("breaks ties in the fixed order: flights, stay, car, rides, food, send ahead", () => {
    const t = trip();
    const r = computeReadiness(t.data(), tripConfig, early);
    // Getting there and the stay are both worth 25 with nothing done.
    expect(r.thingsLeft.slice(0, 2).map((x) => x.kind)).toEqual(["flights", "stay"]);
  });

  it("is never something that is only waiting", () => {
    const { data, plan } = soloWorkTrip();
    const box = makeBooking(plan.id, "shipment", { shipmentKind: "luggage", shipByDate: "2027-01-05", targetDeliveryDate: "2027-01-11", parcels: [{ status: "shipped" }, { status: "shipped" }] });
    const r = computeReadiness({ ...data, bookings: [...data.bookings, box] }, workTravel, zonedToUtc("2027-01-06T09:00", "America/Chicago"));
    expect(r.nextAction).toBeNull();
    expect(r.thingsLeft.map((x) => [x.sentence, x.detail, x.waiting])).toEqual([["2 bags are on their way.", "They should arrive Jan 11.", true]]);
    expect(r.headline).toBe("Nothing needs you right now");
    expect(r.score).toBe(99);
    expect(r.pace).toBe("on_track");
  });
});

describe("getting there", () => {
  it("is complete for a household split across two flights", () => {
    const t = trip();
    const a = t.flightsFor([t.lydia, t.dana], 100);
    const b = t.flightsFor([t.mark, t.chris], 200);
    const stored = makeArrival(t.seattle, "arrival", { personIds: [t.lydia.id], bookingId: a.id, segmentIndex: 0, rideNeed: "rental_car" });
    const data = t.data({ bookings: [a, b, t.stay, t.car], arrivals: [stored] });
    expect(computeReadiness(data, tripConfig, early).breakdown.find((row) => row.component === "gettingThere")).toMatchObject({ credit: 1, state: "4 of 4 seats booked, both ways" });
    expect(tile(data, tripConfig, early, "flights")).toEqual(["All 4 booked", null, "done"]);
  });

  it("is complete when people drive, or already live there, and says 'sorted' rather than 'booked'", () => {
    const t = trip();
    const local = makeArrival(t.portland, "arrival", { mode: "local" });
    const localHome = makeArrival(t.portland, "departure", { mode: "local" });
    const data = t.data({ bookings: [t.stay, t.car], arrivals: [...t.ownCar(t.seattle), local, localHome] });
    const r = computeReadiness(data, tripConfig, early);
    expect(r.breakdown.find((row) => row.component === "gettingThere")).toMatchObject({ credit: 1, state: "All 4 have a way there and back" });
    expect(tile(data, tripConfig, early, "flights")).toEqual(["All 4 sorted", null, "done"]);
    // The two who live there need no bed: 16 person-nights, all covered.
    expect(r.breakdown.find((row) => row.component === "lodging")?.state).toBe("Lakeside house, 8 nights, all 4");
    // Nobody needs a ride, so rides do not count.
    expect(r.leftOut).toContain("rides");
    expect(tile(data, tripConfig, early, "rides")).toEqual(["Everyone is covered", null, "done"]);
  });

  it("names the people with nothing on record, and tells a missing way home from a missing way there", () => {
    const t = trip();
    const outOnly = makeBooking(t.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 100", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] }, { personIds: [t.lydia.id, t.mark.id] });
    const r = computeReadiness(t.data({ bookings: [outOnly, t.stay, t.car] }), tripConfig, early);
    // The larger gap first: four trips home against two trips there.
    expect(r.thingsLeft.filter((x) => x.kind === "flights").map((x) => [x.sentence, x.detail, x.actionLabel, x.target.tool])).toEqual([
      ["4 travelers have no way home yet.", "Add their flight, or say they are driving.", "Add their travel", "people"],
      ["Dana and Chris have no way there yet.", "Add their flight, or say they are driving.", "Add their travel", "people"],
    ]);
    const nobody = computeReadiness(t.data({ bookings: [t.stay, t.car] }), tripConfig, early);
    expect(nobody.thingsLeft.find((x) => x.kind === "flights")?.sentence).toBe("4 travelers have no travel on record yet.");
    expect(tile(t.data({ bookings: [outOnly, t.stay, t.car] }), tripConfig, early, "flights")).toEqual(["2 of 4 booked", "4 trips home to add", "needs_you"]);
  });

  it("points out a booked flight with nobody ticked on it", () => {
    const t = trip();
    const unticked = makeBooking(t.plan.id, "flight", { segments: [seg("AS 100", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] });
    const r = computeReadiness(t.data({ bookings: [unticked] }), tripConfig, early);
    expect(r.thingsLeft.find((x) => x.kind === "flights")?.detail).toBe("Add their flight, or say they are driving. If they are on a flight you already added, tick their names on it.");
  });
});

describe("rides", () => {
  const t = trip();
  const flights = [t.flightsFor([t.lydia, t.mark], 100), t.flightsFor([t.dana, t.chris], 200)];
  const arrivalFor = (party: Party, booking: Booking, over: Partial<Parameters<typeof makeArrival>[2]> = {}) => makeArrival(party, "arrival", { bookingId: booking.id, segmentIndex: 0, ...over });
  const leaving = [makeArrival(t.seattle, "departure", { bookingId: flights[0].id, segmentIndex: 1, rideNeed: "rental_car" }), makeArrival(t.portland, "departure", { bookingId: flights[1].id, segmentIndex: 1, rideNeed: "rental_car" })];

  it("says who lands with no ride, and gets urgent as the day comes", () => {
    const arrivals = [arrivalFor(t.seattle, flights[0], { rideNeed: "rental_car" }), arrivalFor(t.portland, flights[1], { rideNeed: "needs_ride" }), ...leaving];
    const data = t.data({ bookings: [...flights, t.stay, t.car], arrivals });
    const far = computeReadiness(data, tripConfig, early);
    expect(far.thingsLeft.find((x) => x.kind === "rides")).toMatchObject({
      sentence: "Dana and Chris land Sat, Dec 19 with no ride.",
      detail: "Pick someone to drive, or plan a ride.",
      actionLabel: "Sort out the ride",
      target: { tool: "rides" },
      urgency: 1,
    });
    expect(far.breakdown.find((row) => row.component === "rides")).toMatchObject({ credit: 0, state: "0 of 1 ride sorted" });
    expect(tile(data, tripConfig, early, "rides")).toEqual(["2 need a ride", null, "needs_you"]);
    expect(computeReadiness(data, tripConfig, on("2026-12-13T09:00")).pace).toBe("needs_attention");
    expect(computeReadiness(data, tripConfig, on("2026-12-17T09:00")).pace).toBe("at_risk");
  });

  it("is sorted once a driver is named, and asks when nobody has said", () => {
    const driven = [arrivalFor(t.seattle, flights[0], { rideNeed: "rental_car" }), arrivalFor(t.portland, flights[1], { rideNeed: "driver_assigned", driverPersonId: t.mark.id }), ...leaving];
    const done = computeReadiness(t.data({ bookings: [...flights, t.stay, t.car], arrivals: driven }), tripConfig, early);
    expect(done.breakdown.find((row) => row.component === "rides")).toMatchObject({ credit: 1, state: "1 of 1 ride sorted" });
    expect(done.thingsLeft.filter((x) => x.kind === "rides")).toEqual([]);

    const unknown = [arrivalFor(t.seattle, flights[0]), arrivalFor(t.portland, flights[1]), ...leaving];
    const ask = computeReadiness(t.data({ bookings: [...flights, t.stay, t.car], arrivals: unknown }), tripConfig, early);
    expect(ask.thingsLeft.find((x) => x.kind === "rides")).toMatchObject({ sentence: "Ask The Seattle Hartleys and The Portland Hartleys about a ride.", target: { tool: "people" } });
    expect(tile(t.data({ bookings: [...flights, t.stay, t.car], arrivals: unknown }), tripConfig, early, "rides")).toEqual(["2 groups to ask", null, "needs_you"]);
  });

  it("asks the organizer to decide their own ride, and to ask everyone else", () => {
    const organizer = { ...t.lydia, role: "organizer" as const };
    const people = [organizer, t.mark, t.dana, t.chris];
    const unknown = [arrivalFor(t.seattle, flights[0]), arrivalFor(t.portland, flights[1]), ...leaving];
    const r = computeReadiness({ ...t.data({ bookings: [...flights, t.stay, t.car], arrivals: unknown }), people }, tripConfig, early);
    expect(r.thingsLeft.filter((x) => x.kind === "rides").map((x) => [x.sentence, x.detail, x.actionLabel, x.target.tool])).toEqual([
      ["Decide how you are getting from the airport.", "A ride, a car you rent, or someone picking you up.", "Plan the ride", "rides"],
      ["Ask The Portland Hartleys about a ride.", "Nobody has said whether they need one from the airport.", "See arrivals", "people"],
    ]);
    // The trips home were never asked about: they are not rides to arrange, so two rides are open, not four.
    const unasked = unknown.map((a) => (a.direction === "departure" ? { ...a, rideNeed: "unknown" as const } : a));
    const s = computeReadiness({ ...t.data({ bookings: [...flights, t.stay, t.car], arrivals: unasked }), people }, tripConfig, early);
    expect(s.breakdown.find((row) => row.component === "rides")?.state).toBe("0 of 2 rides sorted");
  });

  it("words a ride that still has to be reserved, found a driver for, or recorded", () => {
    const ride = (over: Partial<Booking>, details = {}) =>
      makeBooking(t.plan.id, "ride", { rideType: "rideshare", toPlace: airport("MCO"), pickupAt: at("2026-12-27T10:30", NY), ...details }, { status: "planned", ...over });
    const things = (booking: Booking) => computeReadiness(t.data({ bookings: [...flights, t.stay, t.car, booking], arrivals: [...t.ownCar(t.seattle), ...t.ownCar(t.portland)] }), tripConfig, early).thingsLeft.filter((x) => x.kind === "rides");
    expect(things(ride({}))[0]).toMatchObject({ sentence: "Reserve the ride to the airport.", detail: "Planned for Sun, Dec 27 at 10:30 AM. Reserve by Dec 25.", actionLabel: "Reserve the ride", dueBy: "2026-12-25" });
    expect(things(ride({ status: "looking" }))[0]).toMatchObject({ sentence: "Did you reserve the ride to the airport?", actionLabel: "Record the booking" });
    expect(things(ride({ status: "needed" }, { pickupAt: undefined }))[0]).toMatchObject({ sentence: "Plan the ride to the airport.", detail: null, actionLabel: "Plan the ride" });
    expect(things(ride({}, { rideType: "personal_pickup", toPlace: undefined }))[0]).toMatchObject({ sentence: "Find a driver for the ride.", actionLabel: "Pick a driver" });
    expect(things(ride({ status: "booked" }))).toEqual([]);
  });
});

describe("food and send ahead", () => {
  const t = trip({ kindsInUse: ALL_KINDS });
  const settled = [t.flightsFor(t.people, 100), t.stay, t.car];
  const arrivals = [...t.ownCar(t.seattle), ...t.ownCar(t.portland)];
  const things = (bookings: Booking[], now: Date, kind: string) => computeReadiness(t.data({ bookings: [...settled, ...bookings], arrivals }), tripConfig, now).thingsLeft.filter((x) => x.kind === kind);

  it("words each state of a food order", () => {
    const groceries = (over: Partial<Booking>, opensOn?: string) =>
      makeBooking(t.plan.id, "meal", { mealType: "groceries", windowStart: at("2026-12-19T17:00", NY), orderOpensOn: opensOn }, { status: "planned", ...over });
    expect(things([groceries({}, "2026-12-14")], on("2026-12-10T09:00"), "food")[0]).toMatchObject({ sentence: "The groceries can be ordered from Dec 14.", waiting: true, actionLabel: "See the plan" });
    expect(things([groceries({}, "2026-12-14")], on("2026-12-14T09:00"), "food")[0]).toMatchObject({
      sentence: "Order the groceries for Sat, Dec 19.",
      detail: "The order window is open. Order by Dec 18.",
      waiting: false,
      actionLabel: "Place the order",
    });
    expect(things([groceries({ status: "looking" })], early, "food")[0]).toMatchObject({ sentence: "Did you order the groceries for Sat, Dec 19?", actionLabel: "Record the order" });
    const dinner = makeBooking(t.plan.id, "meal", { mealType: "restaurant_delivery", vendorName: "Luigi's Kitchen" }, { status: "needed" });
    expect(things([dinner], early, "food")[0]).toMatchObject({ sentence: "Plan the food from Luigi's Kitchen.", actionLabel: "Plan it" });
    expect(things([], early, "food")[0]).toMatchObject({ sentence: "Plan the food.", detail: "Dinner on the first night, or groceries waiting at the door." });
    // The day before with nothing ordered is the last day.
    const late = computeReadiness(t.data({ bookings: [...settled, groceries({}, "2026-12-14")], arrivals }), tripConfig, on("2026-12-18T09:00"));
    expect(late.pace).toBe("at_risk");
    expect(late.thingsLeft.find((x) => x.kind === "food")?.detail).toBe("The order window is open. Order today.");
  });

  it("describes the food tile", () => {
    const meal = (status: Booking["status"]) => makeBooking(t.plan.id, "meal", { mealType: "catering", windowStart: at("2026-12-20T12:00", NY) }, { status });
    const state = (bookings: Booking[]) => tile(t.data({ bookings: [...settled, ...bookings], arrivals }), tripConfig, early, "food");
    expect(state([meal("booked")])).toEqual(["1 delivery set", null, "done"]);
    expect(state([meal("booked"), meal("booked"), meal("planned")])).toEqual(["2 deliveries set", "1 more planned", "needs_you"]);
    expect(state([meal("planned"), meal("planned")])).toEqual(["2 deliveries planned", null, "needs_you"]);
    expect(state([meal("looking")])).toEqual(["Still looking", null, "needs_you"]);
    expect(state([])).toEqual(["Needs you", null, "needs_you"]);
  });

  it("words each state of something sent ahead", () => {
    const box = (status: Booking["status"], parcels: { status: "planned" | "packed" | "shipped" | "delivered" }[], over: Record<string, unknown> = {}) =>
      makeBooking(t.plan.id, "shipment", { shipmentKind: "box", shipByDate: "2026-12-10", targetDeliveryDate: "2026-12-21", parcels, ...over }, { status });
    const packed = [{ status: "packed" as const }];
    expect(things([box("planned", packed)], on("2026-11-20T09:00"), "send-ahead")[0]).toMatchObject({ sentence: "Send the box by Dec 10.", detail: "That gets it there by Dec 21.", actionLabel: "Get it ready", dueBy: "2026-12-10", urgency: 1 });
    // Five days before the send-by day is when to start (asking the property takes time): the week before that is "soon".
    expect(things([box("planned", packed)], on("2026-12-01T09:00"), "send-ahead")[0].urgency).toBe(1.5);
    expect(things([box("booked", packed)], on("2026-12-07T09:00"), "send-ahead")[0]).toMatchObject({ actionLabel: "Record the tracking", urgency: 2 });
    expect(things([box("planned", packed)], on("2026-12-10T09:00"), "send-ahead")[0]).toMatchObject({ sentence: "Send the box today.", urgency: 3 });
    expect(things([box("planned", packed)], on("2026-12-12T09:00"), "send-ahead")[0]).toMatchObject({
      sentence: "Send the box as soon as you can.",
      detail: "The last safe day was Dec 10. A faster service may still get it there.",
    });
    expect(things([box("planned", [], { shipByDate: undefined })], early, "send-ahead")[0]).toMatchObject({ sentence: "Finish planning the box.", dueBy: null });
    const shipped = [{ status: "shipped" as const }];
    expect(things([box("booked", shipped)], on("2026-12-15T09:00"), "send-ahead")[0]).toMatchObject({ sentence: "1 box is on its way.", waiting: true });
    expect(things([box("booked", shipped)], on("2026-12-22T09:00"), "send-ahead")[0]).toMatchObject({ sentence: "Check that the box arrived.", detail: "It was due Dec 21.", actionLabel: "Mark it delivered", waiting: false });
    expect(things([box("booked", [{ status: "delivered" }])], on("2026-12-22T09:00"), "send-ahead")).toEqual([]);
    expect(things([], early, "send-ahead")[0]).toMatchObject({ sentence: "Decide what to send ahead.", actionLabel: "Plan what to send" });

    const state = (bookings: Booking[], now: Date) => tile(t.data({ bookings: [...settled, ...bookings], arrivals }), tripConfig, now, "send-ahead");
    expect(state([box("planned", packed)], early)).toEqual(["Send by Dec 10", null, "needs_you"]);
    expect(state([box("booked", shipped)], on("2026-12-22T09:00"))).toEqual(["1 box on its way, was due Dec 21", null, "needs_you"]);
    expect(state([box("booked", [{ status: "delivered" }, { status: "delivered" }])], early)).toEqual(["2 boxes arrived", null, "done"]);
  });
});

describe("who's coming, the schedule and the page", () => {
  const t = trip();
  const settled = { bookings: [t.flightsFor(t.people, 100), t.stay, t.car], arrivals: [] };

  it("asks for an invite when nobody has been asked, and a nudge when some have not replied", () => {
    const notAsked = t.people.map((person) => ({ ...person, rsvpStatus: "not_invited" as const }));
    const fresh = computeReadiness({ ...t.data(settled), people: notAsked }, tripConfig, early);
    expect(fresh.thingsLeft.find((x) => x.kind === "people")).toMatchObject({ sentence: "Invite your travelers.", detail: "4 travelers on the list, and nobody has been asked yet.", actionLabel: "Copy the invite" });

    const waiting = [t.lydia, t.mark, { ...t.dana, rsvpStatus: "invited" as const }, { ...t.chris, rsvpStatus: "no" as const }];
    const plan = { ...t.plan, replyDeadline: "2026-11-19" };
    const data = { ...t.data(settled), plan, people: waiting };
    const r = computeReadiness(data, tripConfig, on("2026-11-01T09:00"));
    expect(r.thingsLeft.find((x) => x.kind === "people")).toMatchObject({ sentence: "Dana has not replied.", detail: "Replies are due Nov 19.", actionLabel: "Send a nudge", dueBy: "2026-11-19" });
    expect(r.breakdown.find((row) => row.component === "people")).toMatchObject({ credit: 0.75, state: "3 of 4 replied" });
    expect(tile(data, tripConfig, early, "people")).toEqual(["2 of 4", "1 has not replied", "underway"]);
    const late = computeReadiness(data, tripConfig, on("2026-11-25T09:00"));
    expect(late.pace).toBe("needs_attention");
    expect(late.thingsLeft.find((x) => x.kind === "people")?.detail).toBe("Replies were due Nov 19.");
    // The page's own reply date wins over the plan's.
    const sooner = { ...data, site: makeSite(plan.id, { status: "published", replyDeadline: "2026-11-05" }) };
    expect(computeReadiness(sooner, tripConfig, on("2026-11-01T09:00")).thingsLeft.find((x) => x.kind === "people")?.dueBy).toBe("2026-11-05");
  });

  it("asks for key moments, then for the time and place each one lacks", () => {
    const none = computeReadiness({ ...t.data(settled), items: [makeItem(t.plan.id, "Pack snacks", { localDate: "2026-12-20" })] }, tripConfig, early);
    expect(none.thingsLeft.find((x) => x.kind === "schedule")).toMatchObject({ sentence: "Add the main moments to the schedule.", actionLabel: "Open the schedule" });
    expect(tile({ ...t.data(settled), items: [makeItem(t.plan.id, "Pack snacks", { localDate: "2026-12-20" })] }, tripConfig, early, "schedule")).toEqual(["1 thing planned", null, "underway"]);

    const picnic = makeItem(t.plan.id, "Lake picnic", { localDate: "2026-12-20", isKeyMoment: true });
    const one = computeReadiness({ ...t.data(settled), items: [t.moment, picnic] }, tripConfig, early);
    expect(one.thingsLeft.find((x) => x.kind === "schedule")).toMatchObject({ sentence: "Lake picnic needs a time and a place.", detail: "It is on Sun, Dec 20.", actionLabel: "Finish the schedule", target: { tool: "schedule", itemId: picnic.id } });
    const timed = timedItem(t.plan.id, "Fireworks", "2026-12-24T21:00", null, { isKeyMoment: true });
    const placed = makeItem(t.plan.id, "Brunch", { localDate: "2026-12-27", place: house, isKeyMoment: true });
    expect(computeReadiness({ ...t.data(settled), items: [t.moment, timed] }, tripConfig, early).thingsLeft.find((x) => x.kind === "schedule")?.sentence).toBe("Fireworks needs a place.");
    expect(computeReadiness({ ...t.data(settled), items: [t.moment, placed] }, tripConfig, early).thingsLeft.find((x) => x.kind === "schedule")?.sentence).toBe("Brunch needs a time.");

    // An all-day moment has its time; a cancelled one does not count at all.
    const allDay = makeItem(t.plan.id, "Christmas Day", { localDate: "2026-12-25", allDay: true, place: house, isKeyMoment: true });
    const off = { ...picnic, status: "cancelled" as const };
    const done = computeReadiness({ ...t.data(settled), items: [t.moment, allDay, off] }, tripConfig, early);
    expect(done.breakdown.find((row) => row.component === "schedule")).toMatchObject({ credit: 1, state: "2 of 2 key moments have a time and place" });
  });

  it("words the page's states", () => {
    const state = (site: PlanData["site"]) => [tile({ ...t.data(settled), site }, tripConfig, early, "page")[0], sentences({ ...t.data(settled), site }, tripConfig, early).find((s) => s.includes("page")) ?? null];
    expect(state(null)).toEqual(["Not started", "Publish your page."]);
    expect(state(makeSite(t.plan.id, { status: "draft" }))).toEqual(["Draft", "Publish your page."]);
    expect(state(makeSite(t.plan.id, { status: "unpublished" }))).toEqual(["Taken down", "Put your page back up."]);
    expect(state(makeSite(t.plan.id, { status: "published" }))).toEqual(["Live", null]);
  });
});

describe("awkward plans", () => {
  it("works with people and no dates yet", () => {
    const t = trip({ startDate: null, endDate: null, dateStatus: "undecided" });
    const r = computeReadiness(t.data(), tripConfig, early);
    expect(r.score).toBe(19); // 15 of the 80 points that apply: everyone replied, the page is live, the one key moment is set
    expect(r.pace).toBe("on_track");
    expect(r.thingsLeft.map((x) => x.sentence)).toEqual(["4 travelers have no travel on record yet.", "Find a place to stay.", "Find the car.", "Rides come after arrivals."]);
    expect(r.breakdown.find((row) => row.component === "lodging")?.state).toBe("Nowhere to stay yet");
  });

  it("reads 'today' in the plan's own zone, across the date line", () => {
    const sydney: PlaceRef = { kind: "city", name: "Sydney", tz: "Australia/Sydney" };
    const plan = makePlan({ template: "trip", destination: sydney, tz: sydney.tz, startDate: "2027-01-12", endDate: "2027-01-20", kindsInUse: ["flight", "lodging"] });
    const me = makeParty(plan.id, "Me");
    const lydia = makePerson(me, "Lydia Hartley");
    const flights = makeBooking(plan.id, "flight", { tripType: "round_trip", segments: [seg("QF 12", "LAX", "2027-01-10T22:30", "SYD", "2027-01-12T08:15"), seg("QF 11", "SYD", "2027-01-20T11:50", "LAX", "2027-01-20T06:10")] }, { personIds: [lydia.id] });
    const stay = makeBooking(plan.id, "lodging", { propertyName: "Harbour hotel", checkInDate: "2027-01-12", checkOutDate: "2027-01-20" });
    const task = makeTask(plan.id, "Print the visa", { essential: true, dueDate: "2027-01-09" });
    const data = makePlanData({ plan, parties: [me], people: [lydia], bookings: [flights, stay], tasks: [task] });
    // 8 PM on Jan 9 in Los Angeles is already 3 PM on Jan 10 in Sydney: the to-do is overdue there.
    const r = computeReadiness(data, tripConfig, zonedToUtc("2027-01-09T20:00", "America/Los_Angeles"));
    expect(r.pace).toBe("at_risk");
    expect(r.thingsLeft.find((x) => x.kind === "task")?.detail).toBe("This was due Jan 9.");
    // Eight nights, from the morning they land to the morning they leave.
    expect(r.breakdown.find((row) => row.component === "lodging")?.state).toBe("Harbour hotel, 8 nights, sorted");
    expect(r.breakdown.find((row) => row.component === "gettingThere")?.credit).toBe(1);
  });

  it("covers a red-eye that lands the morning after the stay starts", () => {
    const t = trip();
    const redEye = makeBooking(t.plan.id, "flight", { tripType: "round_trip", segments: [seg("AS 20", "SEA", "2026-12-18T22:15", "MCO", "2026-12-19T06:40"), seg("AS 21", "MCO", "2026-12-27T13:30", "SEA", "2026-12-27T16:45")] }, { personIds: t.people.map((p) => p.id) });
    const r = computeReadiness(t.data({ bookings: [redEye, t.stay, t.car] }), tripConfig, early);
    expect(r.breakdown.find((row) => row.component === "lodging")?.credit).toBe(1);
    expect(r.breakdown.find((row) => row.component === "gettingThere")?.credit).toBe(1);
  });

  it("stays quick and sensible with forty people", () => {
    const plan = makePlan({ template: "work", workMode: "event", startDate: "2027-01-12", endDate: "2027-01-15", expectedPeople: 40, kindsInUse: ["flight", "lodging", "ride", "meal", "shipment"] });
    const parties: Party[] = [];
    const people: Person[] = [];
    const bookings: Booking[] = [makeBooking(plan.id, "lodging", { lodgingType: "hotel", propertyName: "Hotel Ella", checkInDate: "2027-01-12", checkOutDate: "2027-01-15" })];
    for (let i = 0; i < 10; i++) {
      const party = makeParty(plan.id, `Team ${i + 1}`, { sortOrder: i });
      const members = ["A", "B", "C", "D"].map((n) => makePerson(party, `${n}${i} Person`, { rsvpStatus: i < 7 ? "yes" : "invited" }));
      parties.push(party);
      people.push(...members);
      if (i < 6) bookings.push(makeBooking(plan.id, "flight", { tripType: "round_trip", segments: [seg(`AS ${100 + i}`, "SEA", "2027-01-12T08:00", "AUS", "2027-01-12T14:10"), seg(`AS ${200 + i}`, "AUS", "2027-01-15T16:00", "SEA", "2027-01-15T18:25")] }, { personIds: members.map((p) => p.id) }));
    }
    const event: ReadinessConfig = { weights: WORK_EVENT, words: { person: "attendee", people: "attendees", party: "team", parties: "teams", timeline: "Agenda" } };
    const started = Date.now();
    const data = makePlanData({ plan, parties, people, bookings });
    const r = computeReadiness(data, event, zonedToUtc("2027-01-02T09:00", "America/Chicago"));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.leftOut).toEqual(["car", "tasks"]);
    expect(r.breakdown.find((row) => row.component === "gettingThere")).toMatchObject({ credit: 0.6, state: "24 of 40 have a way there, 24 of 40 a way home" });
    expect(r.breakdown.find((row) => row.component === "people")).toMatchObject({ credit: 0.7, state: "28 of 40 replied" });
    expect(r.breakdown.find((row) => row.component === "schedule")?.label).toBe("Agenda");
    const said = r.thingsLeft.map((x) => x.sentence);
    expect(said).toContain("16 attendees have no travel on record yet.");
    expect(said).toContain("12 attendees have not replied.");
    expect(said).toContain("Ask 6 teams about a ride.");
    expect(said).toContain("Add the main moments to the agenda.");
    expect(tile(data, event, early, "flights")).toEqual(["24 of 40 booked", "16 trips home to add", "needs_you"]);
    expect(toolStates(data, event, early).find((x) => x.tool === "schedule")?.label).toBe("Agenda");
  });

  it("shows money on its tile without letting it into the score", () => {
    const t = trip();
    const data = t.data({ bookings: [t.flightsFor(t.people, 100), t.stay, t.car], arrivals: [], plan: { ...t.plan, budgetTotal: 100_000 }, expenses: [makeExpense(t.plan.id, "Lakeside house", 250_000, { paidByPersonId: t.lydia.id })] });
    expect(tile(data, tripConfig, early, "money")).toEqual(["$2,500 so far", "$1,500 over $1,000", "needs_you"]);
    const without = { ...data, expenses: [] };
    expect(computeReadiness(data, tripConfig, early).score).toBe(computeReadiness(without, tripConfig, early).score);
  });

  it("copes with weights that are all zero", () => {
    const zero = Object.fromEntries(READINESS_COMPONENTS.map((c) => [c, 0])) as ReadinessWeights;
    const r = computeReadiness(makePlanData(), { weights: zero }, early);
    expect(r).toMatchObject({ score: 100, pace: "ready", thingsLeft: [], breakdown: [], headline: "All set" });
    expect(r.leftOut).toEqual([...READINESS_COMPONENTS]);
  });
});
