import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { emptyBookingDetails, type PlaceRef } from "@/lib/domain";
import { findBookingInPlan, findPartyInPlan, findPersonInPlan, peopleInPlan, requireBooking, requireParty, requirePerson } from "@/lib/auth/require";
import { newId } from "@/lib/ids";
import { isForeignKeyViolation } from "./errors";
import { schema } from "./index";
import { bookingDetailsWithoutPerson, removePerson } from "./people";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const home: PlaceRef = { kind: "home", name: "Seattle", tz: "America/Los_Angeles" };
const failure = (promise: PromiseLike<unknown>) => Promise.resolve(promise).then(
  () => null,
  (error: unknown) => error,
);

type Fixture = { userId: string; planId: string; partyId: string; carol: string; mark: string; theo: string };
let counter = 0;

/** A plan with one household of three. Every test builds its own. */
async function makePlan(title = "Hartley Family Christmas"): Promise<Fixture> {
  counter += 1;
  const [user] = await t.db.insert(schema.users).values({ email: `owner-${counter}@example.com`, name: "Owner", passwordHash: "x", home }).returning();
  const [plan] = await t.db.insert(schema.plans).values({ ownerId: user.id, template: "family_event", title, origin: home, tz: "America/New_York" }).returning();
  const [party] = await t.db.insert(schema.parties).values({ planId: plan.id, name: "The Hartleys" }).returning();
  const people = await t.db
    .insert(schema.people)
    .values([
      { planId: plan.id, partyId: party.id, name: "Aunt Carol" },
      { planId: plan.id, partyId: party.id, name: "Mark" },
      { planId: plan.id, partyId: party.id, name: "Theo" },
    ])
    .returning();
  return { userId: user.id, planId: plan.id, partyId: party.id, carol: people[0].id, mark: people[1].id, theo: people[2].id };
}

describe("a row belongs to the same plan as its parent, and the database says so", () => {
  let mallory: Fixture; // plan A
  let lydia: Fixture; // plan B, another person's
  beforeEach(async () => {
    mallory = await makePlan("Mallory's plan");
    lydia = await makePlan("Lydia's plan");
  });

  it("refuses a person in one plan with a party from another", async () => {
    const injected = await failure(t.db.insert(schema.people).values({ planId: mallory.planId, partyId: lydia.partyId, name: "Injected by Mallory" }));
    expect(isForeignKeyViolation(injected)).toBe(true);
    // Lydia's own household is as she left it.
    const parties = await t.db.query.parties.findMany({ where: eq(schema.parties.planId, lydia.planId), with: { people: true } });
    expect(parties.map((party) => party.people.map((person) => person.name).sort())).toEqual([["Aunt Carol", "Mark", "Theo"]]);
    // Moving an existing person across is refused the same way.
    const moved = await failure(t.db.update(schema.people).set({ partyId: lydia.partyId }).where(eq(schema.people.id, mallory.carol)));
    expect(isForeignKeyViolation(moved)).toBe(true);
    const reassigned = await failure(t.db.update(schema.people).set({ planId: lydia.planId }).where(eq(schema.people.id, mallory.carol)));
    expect(isForeignKeyViolation(reassigned)).toBe(true);
  });

  it("refuses an arrival in one plan for a party of another", async () => {
    const arrival = await failure(t.db.insert(schema.arrivals).values({ planId: mallory.planId, partyId: lydia.partyId, direction: "arrival", mode: "drive" }));
    expect(isForeignKeyViolation(arrival)).toBe(true);
    expect(await t.db.select().from(schema.arrivals).where(eq(schema.arrivals.partyId, lydia.partyId))).toEqual([]);
  });

  it("refuses a hand-off in one plan for a booking of another, and a settlement between plans", async () => {
    const [booking] = await t.db.insert(schema.bookings).values({ planId: lydia.planId, kind: "car", title: "Minivan", details: emptyBookingDetails("car") }).returning();
    const handoff = await failure(
      t.db.insert(schema.handoffs).values({ planId: mallory.planId, bookingId: booking.id, provider: "kayak", url: "https://www.kayak.com/cars", linkGrade: "observed" }),
    );
    expect(isForeignKeyViolation(handoff)).toBe(true);

    const acrossPlans = await failure(t.db.insert(schema.settlements).values({ planId: mallory.planId, fromPersonId: mallory.mark, toPersonId: lydia.carol, amount: 100, currency: "USD" }));
    expect(isForeignKeyViolation(acrossPlans)).toBe(true);
    const wrongPlan = await failure(t.db.insert(schema.settlements).values({ planId: lydia.planId, fromPersonId: mallory.mark, toPersonId: mallory.carol, amount: 100, currency: "USD" }));
    expect(isForeignKeyViolation(wrongPlan)).toBe(true);
    // Inside one plan it is an ordinary insert.
    await t.db.insert(schema.settlements).values({ planId: mallory.planId, fromPersonId: mallory.mark, toPersonId: mallory.carol, amount: 100, currency: "USD" });
  });

  it("still removes a party's people and arrivals with the party, and a booking's hand-offs with the booking", async () => {
    await t.db.insert(schema.arrivals).values({ planId: lydia.planId, partyId: lydia.partyId, direction: "arrival", mode: "drive" });
    const [booking] = await t.db.insert(schema.bookings).values({ planId: lydia.planId, kind: "car", title: "Minivan", details: emptyBookingDetails("car") }).returning();
    await t.db.insert(schema.handoffs).values({ planId: lydia.planId, bookingId: booking.id, provider: "kayak", url: "https://www.kayak.com/cars", linkGrade: "observed" });

    await t.db.delete(schema.bookings).where(eq(schema.bookings.id, booking.id));
    expect(await t.db.select().from(schema.handoffs).where(eq(schema.handoffs.planId, lydia.planId))).toEqual([]);
    await t.db.delete(schema.parties).where(eq(schema.parties.id, lydia.partyId));
    expect(await t.db.select().from(schema.people).where(eq(schema.people.planId, lydia.planId))).toEqual([]);
    expect(await t.db.select().from(schema.arrivals).where(eq(schema.arrivals.planId, lydia.planId))).toEqual([]);
    // Mallory's plan is untouched by any of it.
    expect(await t.db.select().from(schema.people).where(eq(schema.people.planId, mallory.planId))).toHaveLength(3);
  });

  it("gives every id from a browser one tested check against the plan", async () => {
    const [booking] = await t.db.insert(schema.bookings).values({ planId: lydia.planId, kind: "lodging", title: "Lake house", details: emptyBookingDetails("lodging") }).returning();
    const hers = { id: lydia.planId };
    const his = { id: mallory.planId };

    expect((await requireParty(hers, lydia.partyId)).name).toBe("The Hartleys");
    expect((await requirePerson(hers, lydia.carol)).name).toBe("Aunt Carol");
    expect((await requireBooking(hers, booking.id)).title).toBe("Lake house");
    // The same ids against another plan, ids that do not exist, and things that are not ids.
    for (const check of [
      () => requireParty(his, lydia.partyId),
      () => requirePerson(his, lydia.carol),
      () => requireBooking(his, booking.id),
      () => requireParty(hers, newId()),
      () => requirePerson(hers, "' or 1=1 --"),
      () => requireBooking(hers, undefined),
      () => requirePerson(hers, lydia.partyId), // a party's id is not a person's
    ]) {
      await expect(check()).rejects.toThrow("NOT_FOUND");
    }
    expect(await findPartyInPlan(mallory.planId, lydia.partyId)).toBeNull();
    expect(await findPersonInPlan(mallory.planId, lydia.carol)).toBeNull();
    expect(await findBookingInPlan(mallory.planId, booking.id)).toBeNull();
    expect((await findPersonInPlan(lydia.planId, lydia.carol))?.id).toBe(lydia.carol);

    // A list bound for a jsonb column: only this plan's people come back, each once, in order.
    expect(await peopleInPlan(lydia.planId, [lydia.theo, mallory.carol, lydia.carol, lydia.theo, "junk", 7, null])).toEqual([lydia.theo, lydia.carol]);
    expect(await peopleInPlan(lydia.planId, [])).toEqual([]);

    // The link the database cannot check for us: a person's lodging booking is a single column.
    // This is the write the helper exists to stop; nothing else does.
    await t.db.update(schema.people).set({ lodgingBookingId: booking.id }).where(eq(schema.people.id, mallory.carol));
    const [crossed] = await t.db.select().from(schema.people).where(eq(schema.people.id, mallory.carol));
    expect(crossed.lodgingBookingId).toBe(booking.id);
    expect(await findBookingInPlan(crossed.planId, crossed.lodgingBookingId)).toBeNull();
  });
});

describe("removing a person", () => {
  it("is refused by the database itself when payments are recorded to or from them", async () => {
    const f = await makePlan();
    await t.db.insert(schema.settlements).values({ planId: f.planId, fromPersonId: f.mark, toPersonId: f.carol, amount: 3000, currency: "USD" });
    // Carol was paid back 30.00 by Mark. Neither of them can simply be deleted.
    expect(isForeignKeyViolation(await failure(t.db.delete(schema.people).where(eq(schema.people.id, f.carol))))).toBe(true);
    expect(isForeignKeyViolation(await failure(t.db.delete(schema.people).where(eq(schema.people.id, f.mark))))).toBe(true);
    expect(await t.db.select().from(schema.settlements).where(eq(schema.settlements.planId, f.planId))).toHaveLength(1);
    // Nor their whole household.
    expect(isForeignKeyViolation(await failure(t.db.delete(schema.parties).where(eq(schema.parties.id, f.partyId))))).toBe(true);
    // Deleting the plan still takes everything with it.
    await t.db.delete(schema.plans).where(eq(schema.plans.id, f.planId));
    expect(await t.db.select().from(schema.settlements).where(eq(schema.settlements.planId, f.planId))).toEqual([]);
    expect(await t.db.select().from(schema.people).where(eq(schema.people.planId, f.planId))).toEqual([]);
  });

  it("removePerson refuses, and changes nothing, when they paid, share a cost or have a payment recorded", async () => {
    const f = await makePlan();
    // Carol paid 90.00, split three ways, and was paid back 30.00 by Mark.
    const [expense] = await t.db
      .insert(schema.expenses)
      .values({
        planId: f.planId, date: "2026-12-20", merchant: "Publix", category: "meals", amount: 9000, currency: "USD", paidByPersonId: f.carol,
        split: { method: "equal", parts: [{ personId: f.carol }, { personId: f.mark }, { personId: f.theo }] }, attendeeIds: [f.carol, f.mark, f.theo],
      })
      .returning();
    await t.db.insert(schema.settlements).values({ planId: f.planId, fromPersonId: f.mark, toPersonId: f.carol, amount: 3000, currency: "USD" });

    expect(await removePerson(f.planId, f.carol)).toEqual({ ok: false, reason: "has_money", settlements: 1, expensesPaid: 1, expensesShared: 1 });
    expect(await removePerson(f.planId, f.mark)).toEqual({ ok: false, reason: "has_money", settlements: 1, expensesPaid: 0, expensesShared: 1 });
    expect(await removePerson(f.planId, f.theo)).toEqual({ ok: false, reason: "has_money", settlements: 0, expensesPaid: 0, expensesShared: 1 });

    // Everyone, every payment and the expense are exactly as they were.
    expect(await t.db.select().from(schema.people).where(eq(schema.people.planId, f.planId))).toHaveLength(3);
    expect(await t.db.select().from(schema.settlements).where(eq(schema.settlements.planId, f.planId))).toHaveLength(1);
    const [after] = await t.db.select().from(schema.expenses).where(eq(schema.expenses.id, expense.id));
    expect(after).toMatchObject({ paidByPersonId: f.carol, attendeeIds: [f.carol, f.mark, f.theo] });
    expect(after.split.parts.map((part) => part.personId)).toEqual([f.carol, f.mark, f.theo]);
  });

  it("removePerson takes the person out of every list that named them, and leaves the rest alone", async () => {
    const f = await makePlan();
    const flight = {
      ...emptyBookingDetails("flight"),
      segments: [
        {
          airlineIata: "AS", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO", departsAt: "2026-12-19T16:10:00Z", originTz: "America/Los_Angeles",
          arrivesAt: "2026-12-19T21:35:00Z", destinationTz: "America/New_York", seats: { [f.carol]: "14C", [f.mark]: "14D" },
        },
      ],
    };
    const [flightBooking, lodging, car, ride, meal] = await t.db
      .insert(schema.bookings)
      .values([
        { planId: f.planId, kind: "flight", title: "AS 1054", personIds: [f.carol, f.mark], paidByPersonId: f.carol, details: flight },
        { planId: f.planId, kind: "lodging", title: "Lake house", personIds: [f.carol, f.mark, f.theo], details: { ...emptyBookingDetails("lodging"), rooms: [{ label: "Blue room", personIds: [f.carol] }, { label: "Bunk room", personIds: [f.theo] }] } },
        { planId: f.planId, kind: "car", title: "Minivan", details: { ...emptyBookingDetails("car"), driverPersonIds: [f.carol, f.mark] } },
        { planId: f.planId, kind: "ride", title: "Airport run", personIds: [f.mark], details: { ...emptyBookingDetails("ride"), driverPersonId: f.carol, passengerIds: [f.mark, f.theo] } },
        { planId: f.planId, kind: "meal", title: "Groceries", personIds: [f.mark], details: emptyBookingDetails("meal") },
      ])
      .returning();
    const [arrival] = await t.db
      .insert(schema.arrivals)
      .values({ planId: f.planId, partyId: f.partyId, personIds: [f.carol, f.mark], direction: "arrival", mode: "flight", driverPersonId: f.carol })
      .returning();
    const [shared, solo, everyone] = await t.db
      .insert(schema.itineraryItems)
      .values([
        { planId: f.planId, type: "event", title: "Pie baking", startTz: "America/New_York", localDate: "2026-12-23", personIds: [f.carol, f.theo], visibility: "guests" },
        { planId: f.planId, type: "note", title: "Carol's hair appointment", startTz: "America/New_York", localDate: "2026-12-22", personIds: [f.carol], visibility: "guests" },
        { planId: f.planId, type: "event", title: "Dinner", startTz: "America/New_York", localDate: "2026-12-24", personIds: [], visibility: "public" },
      ])
      .returning();
    const [task] = await t.db.insert(schema.tasks).values({ planId: f.planId, title: "Bring pies", assigneePersonId: f.carol, claimedByPersonId: f.carol, claimedByName: "Aunt Carol" }).returning();
    const [expense] = await t.db
      .insert(schema.expenses)
      .values({ planId: f.planId, date: "2026-12-20", merchant: "Publix", category: "meals", amount: 9000, currency: "USD", paidByPersonId: f.mark, attendeeIds: [f.carol, f.mark] })
      .returning();
    await t.db.update(schema.people).set({ lodgingBookingId: lodging.id }).where(eq(schema.people.id, f.carol));

    expect(await removePerson(f.planId, f.carol)).toEqual({ ok: true, itemsLeftWithNobody: [solo.id] });

    // She is gone, and nothing in the plan still holds her id.
    expect((await t.db.select().from(schema.people).where(eq(schema.people.planId, f.planId))).map((p) => p.name).sort()).toEqual(["Mark", "Theo"]);
    const everything = {
      bookings: await t.db.select().from(schema.bookings).where(eq(schema.bookings.planId, f.planId)),
      arrivals: await t.db.select().from(schema.arrivals).where(eq(schema.arrivals.planId, f.planId)),
      items: await t.db.select().from(schema.itineraryItems).where(eq(schema.itineraryItems.planId, f.planId)),
      tasks: await t.db.select().from(schema.tasks).where(eq(schema.tasks.planId, f.planId)),
      expenses: await t.db.select().from(schema.expenses).where(eq(schema.expenses.planId, f.planId)),
    };
    expect(JSON.stringify(everything)).not.toContain(f.carol);

    // And everything else is still there, with the others still in it.
    const byId = <T extends { id: string }>(rows: T[], id: string) => rows.find((row) => row.id === id)!;
    const flightAfter = byId(everything.bookings, flightBooking.id);
    expect(flightAfter).toMatchObject({ personIds: [f.mark], paidByPersonId: null });
    expect(flightAfter.details.kind === "flight" && flightAfter.details.segments[0].seats).toEqual({ [f.mark]: "14D" });
    const lodgingAfter = byId(everything.bookings, lodging.id);
    expect(lodgingAfter.personIds).toEqual([f.mark, f.theo]);
    expect(lodgingAfter.details.kind === "lodging" && lodgingAfter.details.rooms).toEqual([{ label: "Blue room", personIds: [] }, { label: "Bunk room", personIds: [f.theo] }]);
    const carAfter = byId(everything.bookings, car.id);
    expect(carAfter.details.kind === "car" && carAfter.details.driverPersonIds).toEqual([f.mark]);
    const rideAfter = byId(everything.bookings, ride.id);
    expect(rideAfter.details).toMatchObject({ kind: "ride", passengerIds: [f.mark, f.theo] });
    expect(rideAfter.details).not.toHaveProperty("driverPersonId");
    expect(byId(everything.bookings, meal.id).personIds).toEqual([f.mark]);
    expect(byId(everything.arrivals, arrival.id)).toMatchObject({ personIds: [f.mark], driverPersonId: null });
    expect(byId(everything.items, shared.id)).toMatchObject({ personIds: [f.theo], visibility: "guests" });
    // The item that was hers alone is kept, for the organizer only: an empty list means "everyone".
    expect(byId(everything.items, solo.id)).toMatchObject({ personIds: [], visibility: "private" });
    expect(byId(everything.items, everyone.id)).toMatchObject({ personIds: [], visibility: "public" });
    expect(byId(everything.tasks, task.id)).toMatchObject({ assigneePersonId: null, claimedByPersonId: null, claimedByName: "Aunt Carol" });
    expect(byId(everything.expenses, expense.id)).toMatchObject({ attendeeIds: [f.mark], paidByPersonId: f.mark, amount: 9000 });
  });

  it("removePerson says not found for a person of another plan, and touches nothing", async () => {
    const mine = await makePlan();
    const theirs = await makePlan();
    expect(await removePerson(mine.planId, theirs.carol)).toEqual({ ok: false, reason: "not_found" });
    expect(await removePerson(mine.planId, newId())).toEqual({ ok: false, reason: "not_found" });
    expect(await t.db.select().from(schema.people).where(eq(schema.people.planId, theirs.planId))).toHaveLength(3);
  });

  it("bookingDetailsWithoutPerson returns null when there is nothing to change", () => {
    expect(bookingDetailsWithoutPerson(emptyBookingDetails("flight"), "p")).toBeNull();
    expect(bookingDetailsWithoutPerson(emptyBookingDetails("lodging"), "p")).toBeNull();
    expect(bookingDetailsWithoutPerson(emptyBookingDetails("car"), "p")).toBeNull();
    expect(bookingDetailsWithoutPerson(emptyBookingDetails("ride"), "p")).toBeNull();
    expect(bookingDetailsWithoutPerson(emptyBookingDetails("meal"), "p")).toBeNull();
    expect(bookingDetailsWithoutPerson(emptyBookingDetails("shipment"), "p")).toBeNull();
  });
});
