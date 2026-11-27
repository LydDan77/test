import { describe, expect, it } from "vitest";
import type { Booking, ItineraryItem, Party, Person } from "@/db/schema";
import type { PlaceRef } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { airport, at, makeArrival, makeBooking, makeParty, makePerson, makePlan, makePlanData, seg, timedItem } from "@/lib/people/testing";
import { zonedToUtc } from "@/lib/time";
import { detectConflicts, type Conflict, type ConflictKind, type ConflictOptions } from "./conflicts";
import { deriveItinerary } from "./derive";

const NY = "America/New_York";
const house: PlaceRef = { kind: "lodging", name: "Lakeside house", tz: NY };

function setUp() {
  const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
  const seattle = makeParty(plan.id, "The Seattle Hartleys", { sortOrder: 0 });
  const portland = makeParty(plan.id, "The Portland Hartleys", { sortOrder: 1 });
  const lydia = makePerson(seattle, "Lydia Hartley");
  const mark = makePerson(seattle, "Mark Hartley");
  const dana = makePerson(portland, "Dana Hartley");
  const chris = makePerson(portland, "Chris Hartley");
  const parties: Party[] = [seattle, portland];
  const people: Person[] = [lydia, mark, dana, chris];
  return { plan, seattle, portland, lydia, mark, dana, chris, parties, people };
}

type Parts = { bookings?: Booking[]; items?: ItineraryItem[]; arrivals?: PlanData["arrivals"] };

function conflictsOf(base: ReturnType<typeof setUp>, parts: Parts, options: ConflictOptions = {}): Conflict[] {
  const data = makePlanData({ plan: base.plan, parties: base.parties, people: base.people, ...parts });
  return detectConflicts(deriveItinerary(data), data, options);
}
const only = (conflicts: Conflict[], kind: ConflictKind) => conflicts.filter((c) => c.kind === kind);

/** A booked stay for everyone for the whole plan, so tests about other things have no missing nights. */
const fullStay = (planId: string) => makeBooking(planId, "lodging", { propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27" });

describe("a night with nowhere to sleep (C1)", () => {
  it("names the night when a booked stay leaves it uncovered", () => {
    const base = setUp();
    const first = makeBooking(base.plan.id, "lodging", { propertyName: "Lakeside house", checkInDate: "2026-12-19", checkOutDate: "2026-12-22" });
    const second = makeBooking(base.plan.id, "lodging", { propertyName: "Hotel Ella", checkInDate: "2026-12-23", checkOutDate: "2026-12-27" });
    const [gap] = only(conflictsOf(base, { bookings: [first, second] }), "no_bed");
    expect(gap).toMatchObject({
      rule: "C1",
      level: "caution",
      sentence: "Nowhere to stay on the night of Dec 22.",
      action: "Add a stay for that night, or check the dates on the one you have.",
      date: "2026-12-22",
      personIds: [],
    });
  });

  it("names the people when only some are left out, and becomes an alert inside two weeks", () => {
    const base = setUp();
    const stay = makeBooking(base.plan.id, "lodging", { propertyName: "Lakeside house", checkInDate: "2026-12-19", checkOutDate: "2026-12-27" }, { personIds: [base.lydia.id, base.mark.id] });
    const far = only(conflictsOf(base, { bookings: [stay] }, { now: zonedToUtc("2026-11-20T09:00", NY) }), "no_bed");
    expect(far).toHaveLength(1);
    expect(far[0]).toMatchObject({ level: "caution", sentence: "Dana and Chris have nowhere to stay on the nights of Dec 19–26.", action: "Add a stay for those nights, or check the dates on the one you have.", personIds: [base.dana.id, base.chris.id] });
    const near = only(conflictsOf(base, { bookings: [stay] }, { now: zonedToUtc("2026-12-06T09:00", NY) }), "no_bed");
    expect(near[0].level).toBe("alert");
  });

  it("stays quiet until something is booked: before that it is a thing to do, not a gap", () => {
    const base = setUp();
    expect(only(conflictsOf(base, {}), "no_bed")).toEqual([]);
    const planned = makeBooking(base.plan.id, "lodging", { checkInDate: "2026-12-19", checkOutDate: "2026-12-22" }, { status: "planned" });
    expect(only(conflictsOf(base, { bookings: [planned] }), "no_bed")).toEqual([]);
    expect(only(conflictsOf(base, { bookings: [fullStay(base.plan.id)] }), "no_bed")).toEqual([]);
  });
});

describe("two things at once for the same person (C2)", () => {
  it("flags an event during someone's flight, for the people on both", () => {
    const base = setUp();
    const flight = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 772", "PDX", "2026-12-19T11:40", "MCO", "2026-12-19T19:55")] }, { personIds: [base.dana.id, base.chris.id] });
    const dinner = timedItem(base.plan.id, "Welcome dinner", "2026-12-19T18:30", "2026-12-19T20:00");
    const [overlap] = only(conflictsOf(base, { bookings: [flight, fullStay(base.plan.id)], items: [dinner] }), "overlap");
    expect(overlap).toMatchObject({
      rule: "C2",
      level: "caution",
      sentence: "Welcome dinner and flight AS 772, PDX to MCO are at the same time for Dana and Chris.",
      action: "Move one of them, or change who is going.",
      personIds: [base.dana.id, base.chris.id],
      date: "2026-12-19",
    });
    expect(overlap.itemKeys).toHaveLength(2);
  });

  it("flags two events for everyone, and leaves alone things that only touch", () => {
    const base = setUp();
    const a = timedItem(base.plan.id, "Lake picnic", "2026-12-20T12:00", "2026-12-20T14:00");
    const b = timedItem(base.plan.id, "Boat tour", "2026-12-20T13:30", "2026-12-20T15:00");
    const c = timedItem(base.plan.id, "Nap", "2026-12-20T15:00", "2026-12-20T16:00");
    const found = only(conflictsOf(base, { bookings: [fullStay(base.plan.id)], items: [a, b, c] }), "overlap");
    expect(found.map((x) => x.sentence)).toEqual(["Lake picnic and Boat tour are at the same time."]);
  });

  it("does not flag different people, cancelled items, items with no end, or parallel tracks", () => {
    const base = setUp();
    const mine = timedItem(base.plan.id, "Spa", "2026-12-20T12:00", "2026-12-20T14:00", { personIds: [base.lydia.id] });
    const theirs = timedItem(base.plan.id, "Golf", "2026-12-20T12:00", "2026-12-20T16:00", { personIds: [base.dana.id] });
    const off = timedItem(base.plan.id, "Parade", "2026-12-20T12:00", "2026-12-20T16:00", { status: "cancelled" });
    const open = timedItem(base.plan.id, "Beach", "2026-12-20T13:00", null);
    const trackA = timedItem(base.plan.id, "Pricing workshop", "2026-12-21T10:00", "2026-12-21T11:00", { type: "session", track: "Sales" });
    const trackB = timedItem(base.plan.id, "Design review", "2026-12-21T10:00", "2026-12-21T11:00", { type: "session", track: "Product" });
    expect(only(conflictsOf(base, { bookings: [fullStay(base.plan.id)], items: [mine, theirs, off, open, trackA, trackB] }), "overlap")).toEqual([]);
    const sameTrack = { ...trackB, track: "Sales" };
    expect(only(conflictsOf(base, { bookings: [fullStay(base.plan.id)], items: [trackA, sameTrack] }), "overlap")).toHaveLength(1);
  });

  it("does not guess that the same people are on two flights with nobody ticked on either", () => {
    const base = setUp();
    const one = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] });
    const two = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 772", "PDX", "2026-12-19T07:40", "MCO", "2026-12-19T15:55")] });
    expect(only(conflictsOf(base, { bookings: [one, two, fullStay(base.plan.id)] }), "overlap")).toEqual([]);
    // Tick the same person on both and it is a real clash.
    const clash = only(conflictsOf(base, { bookings: [{ ...one, personIds: [base.lydia.id] }, { ...two, personIds: [base.lydia.id] }, fullStay(base.plan.id)] }), "overlap");
    expect(clash).toHaveLength(1);
    expect(clash[0].sentence).toBe("Flight AS 1054, SEA to MCO and flight AS 772, PDX to MCO are at the same time for Lydia.");
  });
});

describe("a connection that is too tight (C3)", () => {
  const connecting = (layoverArrives: string, nextDeparts: string, over: Partial<Booking> = {}) => (planId: string) =>
    makeBooking(planId, "flight", { tripType: "one_way", segments: [seg("UA 410", "SEA", "2026-12-19T06:00", "DEN", layoverArrives), seg("UA 1722", "DEN", nextDeparts, "MCO", "2026-12-19T16:20")] }, over);

  it("flags a domestic change of planes under 45 minutes", () => {
    const base = setUp();
    const [tight] = only(conflictsOf(base, { bookings: [connecting("2026-12-19T09:40", "2026-12-19T10:15")(base.plan.id), fullStay(base.plan.id)] }), "tight_connection");
    expect(tight).toMatchObject({
      rule: "C3",
      level: "caution",
      sentence: "Only 35 minutes to change planes at DEN.",
      action: "Airlines want at least 45 minutes there. Ask the airline about a later flight out of DEN.",
      date: "2026-12-19",
    });
  });

  it("is content with 45 minutes at home and wants 90 abroad", () => {
    const base = setUp();
    expect(only(conflictsOf(base, { bookings: [connecting("2026-12-19T09:40", "2026-12-19T10:25")(base.plan.id), fullStay(base.plan.id)] }), "tight_connection")).toEqual([]);

    const abroad = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("BA 48", "SEA", "2026-12-19T18:00", "LHR", "2026-12-20T11:20"), seg("BA 304", "LHR", "2026-12-20T12:30", "CDG", "2026-12-20T14:45")] });
    const [tight] = only(conflictsOf(base, { bookings: [abroad] }), "tight_connection");
    expect(tight.sentence).toBe("Only 1 hour 10 minutes to change planes at LHR.");
    expect(tight.action).toBe("Airlines want at least 1 hour 30 minutes there. Ask the airline about a later flight out of LHR.");
  });

  it("uses real countries when it is given them, so a US to Canada change counts as international", () => {
    const base = setUp();
    const viaChicago = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("UA 500", "SEA", "2026-12-19T06:00", "ORD", "2026-12-19T12:00"), seg("AC 500", "ORD", "2026-12-19T13:00", "YYZ", "2026-12-19T15:30")] });
    expect(only(conflictsOf(base, { bookings: [viaChicago] }), "tight_connection")).toEqual([]);
    const countries: Record<string, string> = { SEA: "US", ORD: "US", YYZ: "CA" };
    expect(only(conflictsOf(base, { bookings: [viaChicago] }, { airportCountry: (iata) => countries[iata] }), "tight_connection")).toHaveLength(1);
  });

  it("says so when the second flight leaves before the first lands, once, not also as an overlap", () => {
    const base = setUp();
    const found = conflictsOf(base, { bookings: [connecting("2026-12-19T10:40", "2026-12-19T10:15", { personIds: [base.lydia.id] })(base.plan.id), fullStay(base.plan.id)] });
    expect(only(found, "tight_connection").map((c) => c.sentence)).toEqual(["UA 1722 leaves DEN at 10:15 AM, before UA 410 lands there at 10:40 AM."]);
    expect(only(found, "overlap")).toEqual([]);
  });

  it("catches a tight connection across two separate bookings for the same person, and ignores strangers", () => {
    const base = setUp();
    const first = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("UA 410", "SEA", "2026-12-19T06:00", "DEN", "2026-12-19T09:40")] }, { personIds: [base.lydia.id] });
    const second = (personId: string) => makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("WN 88", "DEN", "2026-12-19T10:00", "MCO", "2026-12-19T15:40")] }, { personIds: [personId] });
    expect(only(conflictsOf(base, { bookings: [first, second(base.lydia.id)] }), "tight_connection")).toHaveLength(1);
    expect(only(conflictsOf(base, { bookings: [first, second(base.dana.id)] }), "tight_connection")).toEqual([]);
  });

  it("does not call a flight home eight days later, or a day trip's return, a connection", () => {
    const base = setUp();
    const round = makeBooking(base.plan.id, "flight", { segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"), seg("AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45")] });
    const dayTrip = makeBooking(base.plan.id, "flight", { segments: [seg("AS 345", "SEA", "2026-12-21T06:00", "PDX", "2026-12-21T06:55"), seg("AS 346", "PDX", "2026-12-21T07:20", "SEA", "2026-12-21T08:15")] });
    expect(only(conflictsOf(base, { bookings: [round, dayTrip, fullStay(base.plan.id)] }), "tight_connection")).toEqual([]);
  });
});

describe("the car and the flight home (C4)", () => {
  const home = (planId: string, ids: string[]) => makeBooking(planId, "flight", { tripType: "one_way", segments: [seg("AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45")] }, { personIds: ids });
  const carBack = (planId: string, returnLocal: string) =>
    makeBooking(planId, "car", { pickupPlace: airport("MCO"), pickupAt: at("2026-12-19T16:55", NY), returnPlace: airport("MCO"), returnAt: at(returnLocal, NY) });

  it("flags a car due back after the flight leaves", () => {
    const base = setUp();
    const [late] = only(conflictsOf(base, { bookings: [home(base.plan.id, [base.lydia.id]), carBack(base.plan.id, "2026-12-27T18:00"), fullStay(base.plan.id)] }), "car_return");
    expect(late).toMatchObject({
      rule: "C4",
      level: "caution",
      sentence: "The car is due back at 6:00 PM on Sun, Dec 27, after AS 1055 leaves at 5:30 PM.",
      action: "Move the return to 3:00 PM or earlier.",
      date: "2026-12-27",
    });
  });

  it("flags a return less than two hours before the flight, and is content with two", () => {
    const base = setUp();
    const close = only(conflictsOf(base, { bookings: [home(base.plan.id, [base.lydia.id]), carBack(base.plan.id, "2026-12-27T16:10"), fullStay(base.plan.id)] }), "car_return");
    expect(close[0].sentence).toBe("Only 1 hour 20 minutes between returning the car and AS 1055 leaving at 5:30 PM.");
    expect(only(conflictsOf(base, { bookings: [home(base.plan.id, [base.lydia.id]), carBack(base.plan.id, "2026-12-27T15:30"), fullStay(base.plan.id)] }), "car_return")).toEqual([]);
  });

  it("looks at the flight that leaves from where the car goes back, not the flight in", () => {
    const base = setUp();
    const round = makeBooking(base.plan.id, "flight", { segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"), seg("AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45")] });
    expect(only(conflictsOf(base, { bookings: [round, carBack(base.plan.id, "2026-12-27T14:30"), fullStay(base.plan.id)] }), "car_return")).toEqual([]);
    expect(only(conflictsOf(base, { bookings: [round, carBack(base.plan.id, "2026-12-28T09:00"), fullStay(base.plan.id)] }), "car_return")).toHaveLength(1);
  });
});

describe("around check-in and check-out", () => {
  it("notes three hours or more between landing and check-in (C5)", () => {
    const base = setUp();
    const early = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("DL 1420", "MSP", "2026-12-19T06:25", "MCO", "2026-12-19T10:40")] }, { personIds: [base.dana.id, base.chris.id] });
    const [gap] = only(conflictsOf(base, { bookings: [early, fullStay(base.plan.id)] }), "early_arrival");
    expect(gap).toMatchObject({
      rule: "C5",
      level: "info",
      sentence: "5 hours 20 minutes between landing at 10:40 AM and check-in at Lakeside house at 4:00 PM for Dana and Chris.",
      action: "Ask about an early check-in or a place to leave bags.",
      date: "2026-12-19",
    });
    const fine = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("DL 1420", "MSP", "2026-12-19T10:05", "MCO", "2026-12-19T14:20")] }, { personIds: [base.dana.id] });
    expect(only(conflictsOf(base, { bookings: [fine, fullStay(base.plan.id)] }), "early_arrival")).toEqual([]);
  });

  it("warns when nobody reaches the stay on the day it starts", () => {
    const base = setUp();
    // A red-eye that lands the morning after the first night that was booked.
    const redEye = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 20", "SEA", "2026-12-19T22:15", "MCO", "2026-12-20T06:40")] }, { personIds: base.people.map((p) => p.id) });
    const found = conflictsOf(base, { bookings: [redEye, fullStay(base.plan.id)] });
    expect(only(found, "arrives_after_check_in")[0]).toMatchObject({
      level: "caution",
      sentence: "Lakeside house starts on Sat, Dec 19, but nobody gets there until Sun, Dec 20.",
      action: "Tell them you are arriving late so the room is held, or move the first night.",
    });
    // The same flight is also the "you land the next day" note.
    expect(only(found, "lands_another_day")[0].sentence).toBe("AS 20 lands on Sun, Dec 20, the day after you leave.");
  });

  it("does not warn when some of the household is there on the first day", () => {
    const base = setUp();
    const onTime = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] }, { personIds: [base.lydia.id, base.mark.id] });
    const later = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 772", "PDX", "2026-12-21T07:40", "MCO", "2026-12-21T15:55")] }, { personIds: [base.dana.id, base.chris.id] });
    expect(only(conflictsOf(base, { bookings: [onTime, later, fullStay(base.plan.id)] }), "arrives_after_check_in")).toEqual([]);
  });

  it("notes a long wait between check-out and the flight home", () => {
    const base = setUp();
    const evening = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 1055", "MCO", "2026-12-27T19:30", "SEA", "2026-12-27T22:45")] }, { personIds: [base.lydia.id] });
    const [wait] = only(conflictsOf(base, { bookings: [evening, fullStay(base.plan.id)] }), "long_wait_after_check_out");
    expect(wait).toMatchObject({ level: "info", sentence: "8 hours 30 minutes between check-out at Lakeside house at 11:00 AM and the flight at 7:30 PM for Lydia.", action: "Ask about a late check-out or a place to leave bags." });
  });
});

describe("seats (C6)", () => {
  it("flags a rental car with fewer seats than people on it", () => {
    const base = setUp();
    const small = makeBooking(base.plan.id, "car", { seats: 3, pickupAt: at("2026-12-19T16:55", NY) }, { personIds: base.people.map((p) => p.id) });
    const [seats] = only(conflictsOf(base, { bookings: [small, fullStay(base.plan.id)] }), "seats");
    expect(seats).toMatchObject({ rule: "C6", sentence: "The car seats 3, and 4 people are on it.", action: "Look for a bigger car, or plan a second way to get around." });
    const big = { ...small, details: { ...small.details, seats: 5 } as Booking["details"] };
    expect(only(conflictsOf(base, { bookings: [big, fullStay(base.plan.id)] }), "seats")).toEqual([]);
  });

  it("flags a ride and a family driver whose car is too small", () => {
    const base = setUp();
    const ride = makeBooking(base.plan.id, "ride", { rideType: "taxi", vehicleSeats: 3, pickupAt: at("2026-12-19T17:00", NY), passengerIds: base.people.map((p) => p.id) });
    expect(only(conflictsOf(base, { bookings: [ride, fullStay(base.plan.id)] }), "seats")[0].sentence).toBe("The ride has room for 3 passengers, and 4 people are on it.");

    const rob = makePerson(base.seattle, "Rob Hartley", { canDrive: true, vehicleSeats: 1 });
    const arrival = makeArrival(base.portland, "arrival", { mode: "train", scheduledAt: zonedToUtc("2026-12-19T15:00", NY), tz: NY, rideNeed: "driver_assigned", driverPersonId: rob.id, bags: 3 });
    const data = makePlanData({ plan: base.plan, parties: base.parties, people: [...base.people, rob], arrivals: [arrival], bookings: [fullStay(base.plan.id)] });
    const found = only(detectConflicts(deriveItinerary(data), data), "seats");
    expect(found.map((c) => [c.sentence, c.action])).toEqual([["Rob's car seats 1 passenger. This pickup is 2 people and 3 bags.", "Pick a second driver, or plan a ride for some of them."]]);
  });
});

describe("landing on another day (C7) and clocks changing (C8)", () => {
  it("notes a date-line crossing in each direction", () => {
    const base = setUp();
    const west = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("QF 12", "LAX", "2027-01-10T22:30", "SYD", "2027-01-12T08:15")] });
    const east = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("HA 458", "NRT", "2027-01-06T00:30", "HNL", "2027-01-05T12:20")] });
    const notes = only(conflictsOf(base, { bookings: [west, east] }), "lands_another_day");
    expect(notes.map((c) => [c.level, c.sentence, c.action])).toEqual([
      ["info", "HA 458 lands on Tue, Jan 5, the calendar day before you leave.", "Check that your ride and your stay start on Jan 5."],
      ["info", "QF 12 lands on Tue, Jan 12, 2 days after you leave.", "Check that your ride and your stay start on Jan 12."],
    ]);
    expect(notes[0].rule).toBe("C7");
  });

  it("notes the day the clocks change at the plan's place", () => {
    const fall = makePlan({ startDate: "2026-10-28", endDate: "2026-11-03" });
    const back = detectConflicts([], makePlanData({ plan: fall }));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: "clocks_change", rule: "C8", level: "info", sentence: "Clocks in Orlando go back 1 hour on Sun, Nov 1.", date: "2026-11-01" });

    const spring = makePlan({ destination: { kind: "city", name: "London", tz: "Europe/London" }, tz: "Europe/London", startDate: "2027-03-26", endDate: "2027-03-30" });
    expect(detectConflicts([], makePlanData({ plan: spring }))[0].sentence).toBe("Clocks in London go forward 1 hour on Sun, Mar 28.");

    const steady = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
    expect(detectConflicts([], makePlanData({ plan: steady }))).toEqual([]);
    expect(detectConflicts([], makePlanData({ plan: makePlan() }))).toEqual([]);
  });
});

describe("pickups set before the plane lands", () => {
  const landing = (base: ReturnType<typeof setUp>) =>
    makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("AS 772", "PDX", "2026-12-19T07:40", "MCO", "2026-12-19T15:55")] }, { personIds: [base.dana.id, base.chris.id] });

  it("flags a ride timed before the flight it meets", () => {
    const base = setUp();
    const flight = landing(base);
    const ride = makeBooking(base.plan.id, "ride", { rideType: "rideshare", fromPlace: airport("MCO"), toPlace: house, pickupAt: at("2026-12-19T15:30", NY), passengerIds: [base.dana.id, base.chris.id] }, { status: "planned" });
    const [early] = only(conflictsOf(base, { bookings: [flight, ride, fullStay(base.plan.id)] }), "ride_before_landing");
    expect(early).toMatchObject({
      level: "caution",
      sentence: "The ride from MCO is set for 3:30 PM, but AS 772 lands at 3:55 PM.",
      action: "Move it to about 4:25 PM, once they are off the plane with their bags.",
      itemKeys: [`booking:${ride.id}:ride`],
    });
    const after = { ...ride, details: { ...ride.details, pickupAt: at("2026-12-19T16:25", NY) } as Booking["details"] };
    expect(only(conflictsOf(base, { bookings: [flight, after, fullStay(base.plan.id)] }), "ride_before_landing")).toEqual([]);
  });

  it("goes by the later time when someone has entered a delay", () => {
    const base = setUp();
    const delayed = makeBooking(
      base.plan.id,
      "flight",
      { tripType: "one_way", segments: [seg("AS 772", "PDX", "2026-12-19T07:40", "MCO", "2026-12-19T15:55", { expectedArrivalAt: zonedToUtc("2026-12-19T17:05", NY).toISOString() })] },
      { personIds: [base.dana.id, base.chris.id] },
    );
    const arrival = makeArrival(base.portland, "arrival", { id: "arr-pdx", bookingId: delayed.id, segmentIndex: 0 });
    const ride = makeBooking(base.plan.id, "ride", { rideType: "rideshare", pickupAt: at("2026-12-19T16:25", NY), arrivalIds: ["arr-pdx"] });
    const [early] = only(conflictsOf(base, { bookings: [delayed, ride, fullStay(base.plan.id)], arrivals: [arrival] }), "ride_before_landing");
    expect(early.sentence).toBe("The ride is set for 4:25 PM, but AS 772 is now due at 5:05 PM.");
    expect(early.action).toBe("Move it to about 5:35 PM, once they are off the plane with their bags.");
  });

  it("flags a car pickup timed before landing", () => {
    const base = setUp();
    const car = makeBooking(base.plan.id, "car", { pickupPlace: airport("MCO"), pickupAt: at("2026-12-19T15:00", NY) }, { personIds: [base.dana.id] });
    const [early] = only(conflictsOf(base, { bookings: [landing(base), car, fullStay(base.plan.id)] }), "car_before_landing");
    expect(early.sentence).toBe("The car pickup is set for 3:00 PM, but AS 772 lands at 3:55 PM.");
    expect(early.action).toBe("Move it to about 4:40 PM, once they are off the plane with their bags.");
  });
});

describe("the whole list", () => {
  it("is empty for a plan with nothing wrong, for an empty plan, and for one person", () => {
    const base = setUp();
    const flights = makeBooking(base.plan.id, "flight", { segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"), seg("AS 1055", "MCO", "2026-12-27T13:30", "SEA", "2026-12-27T16:45")] }, { personIds: base.people.map((p) => p.id) });
    expect(conflictsOf(base, { bookings: [flights, fullStay(base.plan.id)] })).toEqual([]);
    expect(detectConflicts([], makePlanData())).toEqual([]);
    const solo = makePlan({ startDate: "2026-12-19", endDate: "2026-12-20" });
    const me = makeParty(solo.id, "Me");
    expect(detectConflicts([], makePlanData({ plan: solo, parties: [me], people: [makePerson(me, "Lydia Hartley")] }))).toEqual([]);
  });

  it("puts the most serious first, gives every conflict a stable key, and writes calm sentences", () => {
    const base = setUp();
    const stay = makeBooking(base.plan.id, "lodging", { propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-26" });
    const early = makeBooking(base.plan.id, "flight", { tripType: "one_way", segments: [seg("DL 1420", "MSP", "2026-12-19T06:25", "MCO", "2026-12-19T10:40")] }, { personIds: [base.dana.id] });
    const options = { now: zonedToUtc("2026-12-15T09:00", NY) };
    const first = conflictsOf(base, { bookings: [stay, early] }, options);
    expect(first.map((c) => [c.level, c.kind])).toEqual([
      ["alert", "no_bed"],
      ["info", "early_arrival"],
    ]);
    expect(conflictsOf(base, { bookings: [stay, early] }, options).map((c) => c.key)).toEqual(first.map((c) => c.key));
    expect(new Set(first.map((c) => c.key)).size).toBe(first.length);
    for (const c of first) {
      expect(c.sentence).toMatch(/\.$/);
      expect(c.action).toMatch(/\.$/);
      expect(c.sentence + c.action).not.toMatch(/!/);
    }
  });

  it("copes with forty people", () => {
    const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
    const parties: Party[] = [];
    const people: Person[] = [];
    const bookings: Booking[] = [makeBooking(plan.id, "lodging", { propertyName: "The lodge", checkInDate: "2026-12-19", checkOutDate: "2026-12-27" })];
    for (let i = 0; i < 10; i++) {
      const party = makeParty(plan.id, `Household ${i + 1}`, { sortOrder: i });
      const members = ["A", "B", "C", "D"].map((n) => makePerson(party, `${n}${i} Test`));
      parties.push(party);
      people.push(...members);
      bookings.push(makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg(`AS ${100 + i}`, "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] }, { personIds: members.map((p) => p.id) }));
    }
    const data = makePlanData({ plan, parties, people, bookings, items: [timedItem(plan.id, "Lunch for the early birds", "2026-12-19T12:00", "2026-12-19T13:00")] });
    const found = detectConflicts(deriveItinerary(data), data);
    // Everyone is in the air at lunch: ten flights, each clashing with it, none with each other.
    expect(only(found, "overlap")).toHaveLength(10);
    expect(only(found, "overlap")[0].sentence).toBe("Lunch for the early birds and flight AS 100, SEA to MCO are at the same time for 4 people.");
  });
});
