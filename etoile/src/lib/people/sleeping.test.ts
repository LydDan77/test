import { describe, expect, it } from "vitest";
import type { Party, Person } from "@/db/schema";
import type { PlaceRef } from "@/lib/domain";
import { zonedToUtc } from "@/lib/time";
import { gapPeople, sleepingPlan } from "./sleeping";
import { makeArrival, makeBooking, makeParty, makePerson, makePlan, makePlanData, seg } from "./testing";

const NY = "America/New_York";
const now = zonedToUtc("2026-12-01T12:00", NY);
const house: PlaceRef = { kind: "lodging", name: "Lakeside house", tz: NY };

function setUp(names: string[][] = [["Lydia Hartley", "Mark Hartley"], ["Dana Hartley", "Chris Hartley"]]) {
  const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-23", kindsInUse: ["lodging"] });
  const parties: Party[] = [];
  const people: Person[] = [];
  names.forEach((members, i) => {
    const party = makeParty(plan.id, `Household ${i + 1}`, { sortOrder: i });
    parties.push(party);
    people.push(...members.map((name) => makePerson(party, name)));
  });
  return { plan, parties, people };
}

describe("one stay for everyone", () => {
  const { plan, parties, people } = setUp();
  const stay = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-23" });
  const result = sleepingPlan(makePlanData({ plan, parties, people, bookings: [stay] }), now);

  it("covers every night for everyone when the stay names nobody", () => {
    expect(result.nights).toEqual(["2026-12-19", "2026-12-20", "2026-12-21", "2026-12-22"]);
    expect(result).toMatchObject({ needed: 16, booked: 16, credit: 1, gaps: [], anyBooked: true });
    expect(result.people.map((p) => p.line)).toEqual(Array(4).fill("Lakeside house, 4 nights"));
    expect(result.people[0].nights[0]).toEqual({ date: "2026-12-19", state: "booked", bookingId: stay.id, placeName: "Lakeside house", room: null, credit: 1 });
  });

  it("says who is where on each night", () => {
    expect(result.byNight[0]).toMatchObject({ date: "2026-12-19", label: "Sat, Dec 19", nowhere: { personIds: [], names: [] } });
    expect(result.byNight[0].stays).toEqual([
      { bookingId: stay.id, placeName: "Lakeside house", state: "booked", personIds: people.map((p) => p.id), names: ["Lydia", "Mark", "Dana", "Chris"] },
    ]);
  });
});

describe("gaps", () => {
  it("finds a night nobody has a bed for, between two stays", () => {
    const { plan, parties, people } = setUp();
    const first = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", checkInDate: "2026-12-19", checkOutDate: "2026-12-21" });
    const second = makeBooking(plan.id, "lodging", { propertyName: "Hotel Ella", checkInDate: "2026-12-22", checkOutDate: "2026-12-23" });
    const result = sleepingPlan(makePlanData({ plan, parties, people, bookings: [first, second] }), now);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ from: "2026-12-21", to: "2026-12-21", nights: ["2026-12-21"], everyone: true, when: "the night of Dec 21" });
    expect(gapPeople(result.gaps[0])).toBe("anyone");
    expect(result).toMatchObject({ needed: 16, booked: 12, credit: 0.75 });
    expect(result.people[0].line).toBe("Lakeside house, 2 nights; Hotel Ella, 1 night. Nowhere yet for Dec 21.");
    expect(result.people[0].uncovered).toEqual(["2026-12-21"]);
  });

  it("finds the people left out when a stay names only some of them, and joins their nights into one gap", () => {
    const { plan, parties, people } = setUp();
    const [lydia, mark, dana, chris] = people;
    const stay = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", checkInDate: "2026-12-19", checkOutDate: "2026-12-23" }, { personIds: [lydia.id, mark.id] });
    const result = sleepingPlan(makePlanData({ plan, parties, people, bookings: [stay] }), now);
    expect(result.gaps).toEqual([
      {
        from: "2026-12-19",
        to: "2026-12-22",
        nights: ["2026-12-19", "2026-12-20", "2026-12-21", "2026-12-22"],
        personIds: [dana.id, chris.id],
        names: ["Dana", "Chris"],
        everyone: false,
        when: "the nights of Dec 19–22",
      },
    ]);
    expect(gapPeople(result.gaps[0])).toBe("Dana and Chris");
    expect(result.people.find((p) => p.personId === dana.id)?.line).toBe("Nowhere to stay yet");
    expect(result.byNight[0].nowhere).toEqual({ personIds: [dana.id, chris.id], names: ["Dana", "Chris"] });
  });

  it("gives partial credit for a stay that is planned or still being looked for, and counts no night as booked", () => {
    const { plan, parties, people } = setUp();
    const dates = { propertyName: "Lakeside house", checkInDate: "2026-12-19", checkOutDate: "2026-12-23" };
    const planned = sleepingPlan(makePlanData({ plan, parties, people, bookings: [makeBooking(plan.id, "lodging", dates, { status: "planned" })] }), now);
    expect(planned).toMatchObject({ credit: 0.25, booked: 0, gaps: [], anyBooked: false });
    expect(planned.people[0].nights[0].state).toBe("planned");
    const looking = sleepingPlan(makePlanData({ plan, parties, people, bookings: [makeBooking(plan.id, "lodging", dates, { status: "looking" })] }), now);
    expect(looking.credit).toBe(0.5);
  });

  it("ignores a stay that is only needed, cancelled or not needed", () => {
    const { plan, parties, people } = setUp();
    const dates = { checkInDate: "2026-12-19", checkOutDate: "2026-12-23" };
    for (const status of ["needed", "cancelled", "not_needed"] as const) {
      const result = sleepingPlan(makePlanData({ plan, parties, people, bookings: [makeBooking(plan.id, "lodging", dates, { status })] }), now);
      expect(result.credit, status).toBe(0);
      expect(result.gaps[0].everyone, status).toBe(true);
    }
  });
});

describe("which nights a person needs", () => {
  const { plan, parties, people } = setUp();
  const [lydia, mark, dana, chris] = people;
  const stay = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", checkInDate: "2026-12-19", checkOutDate: "2026-12-23" });
  const nightsOf = (data: Parameters<typeof sleepingPlan>[0], id: string) => sleepingPlan(data, now).people.find((p) => p.personId === id)!.nights.map((n) => n.date);

  it("follows a household's own arrival and departure when they are on record", () => {
    const arrivals = [
      makeArrival(parties[1], "arrival", { mode: "drive", scheduledAt: zonedToUtc("2026-12-20T15:00", NY), tz: NY }),
      makeArrival(parties[1], "departure", { mode: "drive", scheduledAt: zonedToUtc("2026-12-22T10:00", NY), tz: NY }),
    ];
    const data = makePlanData({ plan, parties, people, bookings: [stay], arrivals });
    expect(nightsOf(data, dana.id)).toEqual(["2026-12-20", "2026-12-21"]);
    expect(nightsOf(data, lydia.id)).toEqual(["2026-12-19", "2026-12-20", "2026-12-21", "2026-12-22"]);
    expect(sleepingPlan(data, now).needed).toBe(12);
  });

  it("counts the night before for a red-eye that lands before 5 AM, and not for one that lands at breakfast", () => {
    const veryEarly = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("B6 98", "LAX", "2026-12-19T16:30", "MCO", "2026-12-20T00:25")] }, { personIds: [dana.id] });
    const breakfast = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("AS 20", "SEA", "2026-12-19T22:15", "MCO", "2026-12-20T06:40")] }, { personIds: [chris.id] });
    const data = makePlanData({ plan, parties, people, bookings: [stay, veryEarly, breakfast] });
    expect(nightsOf(data, dana.id)[0]).toBe("2026-12-19");
    expect(nightsOf(data, chris.id)[0]).toBe("2026-12-20");
  });

  it("does not need the last night for someone who leaves before 5 AM", () => {
    const early = makeArrival(parties[1], "departure", { mode: "drive", scheduledAt: zonedToUtc("2026-12-23T03:30", NY), tz: NY });
    const data = makePlanData({ plan, parties, people, bookings: [stay], arrivals: [early] });
    expect(nightsOf(data, dana.id)).toEqual(["2026-12-19", "2026-12-20", "2026-12-21"]);
  });

  it("needs a night someone stays past the plan's end, and reports it uncovered", () => {
    const lateFlight = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("AS 1055", "MCO", "2026-12-24T17:30", "SEA", "2026-12-24T20:45")] }, { personIds: [mark.id] });
    const result = sleepingPlan(makePlanData({ plan, parties, people, bookings: [stay, lateFlight] }), now);
    expect(result.gaps).toMatchObject([{ from: "2026-12-23", personIds: [mark.id], everyone: false, when: "the night of Dec 23" }]);
  });

  it("needs no bed for someone who lives there, and none for someone who said no", () => {
    const local = makeArrival(parties[1], "arrival", { mode: "local", personIds: [dana.id] });
    const declined = { ...chris, rsvpStatus: "no" as const };
    const result = sleepingPlan(makePlanData({ plan, parties, people: [lydia, mark, dana, declined], bookings: [stay], arrivals: [local] }), now);
    expect(result.people.map((p) => [p.name, p.need, p.line])).toEqual([
      ["Lydia Hartley", "nights", "Lakeside house, 4 nights"],
      ["Mark Hartley", "nights", "Lakeside house, 4 nights"],
      ["Dana Hartley", "lives_here", "Lives nearby"],
    ]);
    expect(result.needed).toBe(8);
  });
});

describe("rooms, room blocks and own arrangements", () => {
  it("reads rooms from the stay, and a person's own stay and room from the person", () => {
    const { plan, parties, people } = setUp();
    const [lydia, mark, dana, chris] = people;
    const hotel = makeBooking(
      plan.id,
      "lodging",
      { lodgingType: "hotel", propertyName: "Hotel Ella", checkInDate: "2026-12-19", checkOutDate: "2026-12-23", rooms: [{ label: "King", personIds: [lydia.id, mark.id] }] },
    );
    const own = makeBooking(plan.id, "lodging", { lodgingType: "family_home", propertyName: "Aunt May's", checkInDate: "2026-12-19", checkOutDate: "2026-12-23" }, { guestProvided: true });
    const danaWithStay = { ...dana, lodgingBookingId: own.id, room: "Guest room" };
    const result = sleepingPlan(makePlanData({ plan, parties, people: [lydia, mark, danaWithStay, chris], bookings: [hotel, own] }), now);
    const byName = Object.fromEntries(result.people.map((p) => [p.name.split(" ")[0], p]));
    expect(byName.Lydia.nights[0]).toMatchObject({ placeName: "Hotel Ella", room: "King" });
    expect(byName.Dana.nights[0]).toMatchObject({ placeName: "Aunt May's", room: "Guest room" });
    expect(byName.Dana.ownArrangement).toBe(true);
    expect(byName.Lydia.ownArrangement).toBe(false);
    // Chris is named nowhere, and both stays name people: neither covers him.
    expect(byName.Chris.line).toBe("Nowhere to stay yet");
  });

  it("does not count a room block as a bed until someone is put in it", () => {
    const { plan, parties, people } = setUp([["Ada Okafor", "Ben Okafor"]]);
    const block = makeBooking(plan.id, "lodging", { lodgingType: "room_block", propertyName: "Hotel Ella", checkInDate: "2026-12-19", checkOutDate: "2026-12-23" });
    const open = sleepingPlan(makePlanData({ plan, parties, people, bookings: [block] }), now);
    expect(open.credit).toBe(0);
    const assigned = sleepingPlan(makePlanData({ plan, parties, people: [{ ...people[0], lodgingBookingId: block.id }, people[1]], bookings: [block] }), now);
    expect(assigned.credit).toBe(0.5);
  });

  it("takes a stay with no dates recorded as covering the plan's dates", () => {
    const { plan, parties, people } = setUp();
    const noDates = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house" });
    expect(sleepingPlan(makePlanData({ plan, parties, people, bookings: [noDates] }), now).credit).toBe(1);
  });
});

describe("plans with nothing to count", () => {
  it("has no nights when the plan has no dates", () => {
    const { parties, people } = setUp();
    const plan = makePlan();
    const result = sleepingPlan(makePlanData({ plan, parties, people }), now);
    expect(result).toMatchObject({ nights: [], needed: 0, credit: null, gaps: [] });
    expect(result.people[0]).toMatchObject({ need: "no_dates", line: "No dates yet" });
  });

  it("has no nights for a one-day plan, or an empty one", () => {
    const { plan, parties, people } = setUp();
    const oneDay = { ...plan, endDate: plan.startDate };
    expect(sleepingPlan(makePlanData({ plan: oneDay, parties, people }), now)).toMatchObject({ needed: 0, credit: null });
    expect(sleepingPlan(makePlanData({ plan: oneDay, parties, people }), now).people[0].line).toBe("No nights needed");
    expect(sleepingPlan(makePlanData(), now)).toMatchObject({ people: [], needed: 0, credit: null, anyBooked: false });
  });

  it("counts 320 person-nights for forty people over eight nights", () => {
    const names = Array.from({ length: 10 }, (_, i) => ["A", "B", "C", "D"].map((n) => `${n}${i} Test`));
    const { parties, people } = setUp(names);
    const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
    const stay = makeBooking(plan.id, "lodging", { propertyName: "The lodge" });
    const result = sleepingPlan(makePlanData({ plan, parties, people, bookings: [stay] }), now);
    expect(result).toMatchObject({ needed: 320, booked: 320, credit: 1 });
  });
});
