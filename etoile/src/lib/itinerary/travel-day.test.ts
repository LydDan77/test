import { describe, expect, it } from "vitest";
import type { PlaceRef } from "@/lib/domain";
import { airport, at, makeArrival, makeBooking, makeParty, makePerson, makePlan, makePlanData, seg, timedItem } from "@/lib/people/testing";
import { zonedToUtc } from "@/lib/time";
import { leaveBy, travelDay } from "./travel-day";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const house: PlaceRef = { kind: "lodging", name: "Lakeside house", tz: NY };

describe("leave by", () => {
  const flight = at("2026-12-19T06:10", LA);

  it("works backward from the flight and shows its arithmetic, as the product spec writes it", () => {
    const result = leaveBy(flight, { driveMinutes: 25 }, { flightLabel: "AS 1054" });
    expect(result.sentence).toBe("Leave by about 3:40 AM: 6:10 AM flight, 2 hours at the airport, 25 minutes' drive.");
    expect(result.timeText).toBe("3:40 AM");
    expect(result.at).toEqual(at("2026-12-19T03:40", LA));
    expect(result.label).toBe("Leave home by");
    expect(result.steps.map((s) => [s.label, s.minutes, s.timeText])).toEqual([
      ["AS 1054 leaves", null, "6:10 AM"],
      ["2 hours at the airport", 120, "4:10 AM"],
      ["25 minutes' drive", 25, "3:45 AM"],
      ["5 minutes to spare", 5, "3:40 AM"],
    ]);
    expect(result.steps[3].at).toEqual(result.at);
  });

  it("takes the airport time and the road factor as inputs", () => {
    // An international flight on a severe flying day, with the drive in the hours to avoid.
    const result = leaveBy(flight, { driveMinutes: 25, airportLeadMinutes: 180 + 60, roadFactor: 1.7 });
    expect(result.steps.map((s) => [s.label, s.minutes, s.timeText])).toEqual([
      ["The flight leaves", null, "6:10 AM"],
      ["4 hours at the airport", 240, "2:10 AM"],
      ["43 minutes' drive (25 minutes on a normal day)", 43, "1:27 AM"],
      ["5 minutes to spare", 5, "1:22 AM"],
    ]);
    // Rounded down to five minutes: "about", and never later than the arithmetic.
    expect(result.timeText).toBe("1:20 AM");
    expect(result.sentence).toBe("Leave by about 1:20 AM: 6:10 AM flight, 4 hours at the airport, 43 minutes' drive (25 minutes on a normal day).");
  });

  it("can leave the day before, with no cushion, and for an hour's drive", () => {
    const early = leaveBy(at("2026-12-19T01:30", LA), { driveMinutes: 60, cushionMinutes: 0 });
    expect(early.at).toEqual(at("2026-12-18T22:30", LA));
    expect(early.steps.map((s) => s.label)).toEqual(["The flight leaves", "2 hours at the airport", "1 hour's drive"]);
    expect(early.sentence).toBe("Leave by about 10:30 PM: 1:30 AM flight, 2 hours at the airport, 1 hour's drive.");
  });

  it("is right across a clock change, because it subtracts real minutes", () => {
    // Clocks in Los Angeles go forward at 2 AM on Mar 14, 2027: 1:59 AM is followed by 3:00 AM.
    const result = leaveBy(at("2027-03-14T05:00", LA), { driveMinutes: 30, cushionMinutes: 0 });
    expect(result.steps.map((s) => s.timeText)).toEqual(["5:00 AM", "3:00 AM", "1:30 AM"]);
  });

  it("writes times the way the person chose, and guards against odd inputs", () => {
    expect(leaveBy(flight, { driveMinutes: 25 }, { wording: { style: "24h" } }).sentence).toBe("Leave by about 0340: 0610 flight, 2 hours at the airport, 25 minutes' drive.");
    const odd = leaveBy(flight, { driveMinutes: -10, roadFactor: 0, airportLeadMinutes: -5 });
    expect(odd.steps.map((s) => s.minutes)).toEqual([null, 0, 0, 5]);
    expect(leaveBy(flight, { driveMinutes: 25 }, { fromHome: false }).label).toBe("Leave for the airport by");
  });
});

describe("the travel day", () => {
  function family() {
    const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
    const seattle = makeParty(plan.id, "The Seattle Hartleys", { sortOrder: 0 });
    const tampa = makeParty(plan.id, "Ruth and Dale", { sortOrder: 1 });
    const lydia = makePerson(seattle, "Lydia Hartley");
    const mark = makePerson(seattle, "Mark Hartley");
    const ruth = makePerson(tampa, "Ruth Hartley");
    const dale = makePerson(tampa, "Dale Hartley");
    const flights = makeBooking(
      plan.id,
      "flight",
      { tripType: "round_trip", segments: [seg("AS 1054", "SEA", "2026-12-19T06:10", "MCO", "2026-12-19T14:41"), seg("AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45")] },
      { personIds: [lydia.id, mark.id] },
    );
    const car = makeBooking(plan.id, "car", { vehicleClass: "minivan", pickupPlace: airport("MCO"), pickupAt: at("2026-12-19T15:25", NY), returnPlace: airport("MCO"), returnAt: at("2026-12-27T15:00", NY), driverPersonIds: [mark.id] });
    const stay = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27" });
    const dinner = timedItem(plan.id, "Welcome dinner", "2026-12-19T18:30", "2026-12-19T20:00", { place: house });
    const mine = timedItem(plan.id, "Call the office", "2026-12-19T17:00", null, { personIds: [lydia.id], visibility: "private" });
    const off = timedItem(plan.id, "Fireworks", "2026-12-19T21:00", null, { status: "cancelled" });
    const byRoad = makeArrival(tampa, "arrival", { mode: "drive", scheduledAt: zonedToUtc("2026-12-19T15:00", NY), tz: NY, fromLabel: "Tampa" });
    const data = makePlanData({ plan, parties: [seattle, tampa], people: [lydia, mark, ruth, dale], bookings: [flights, car, stay], items: [dinner, mine, off], arrivals: [byRoad] });
    return { data, seattle, tampa, lydia, mark, ruth };
  }

  it("lists a household's steps in order, starting with when to leave home", () => {
    const { data, seattle } = family();
    const day = travelDay(data, { partyId: seattle.id }, "2026-12-19", { driveMinutes: 25 });
    expect(day).toMatchObject({ date: "2026-12-19", label: "Sat, Dec 19", who: "Lydia and Mark" });
    expect(day.steps.map((s) => [s.kind, s.timeText, s.title])).toEqual([
      ["leave", "3:40 AM", "Leave home"],
      ["takeoff", "6:10 AM", "AS 1054 leaves SEA"],
      ["landing", "2:41 PM", "Land at MCO"],
      ["car_pickup", "3:25 PM", "Pick up the minivan at MCO"],
      ["check_in", "From 4:00 PM", "Check in at Lakeside house"],
      ["event", "5:00 PM", "Call the office"],
      ["event", "6:30 PM", "Welcome dinner"],
    ]);
    expect(day.steps[0].detail).toBe("Leave by about 3:40 AM: 6:10 AM flight, 2 hours at the airport, 25 minutes' drive.");
    expect(day.leaveBy?.steps).toHaveLength(4);
    expect(day.leaveBy?.steps[0].label).toBe("AS 1054 leaves");
    // Each step is in the time of the place where it happens.
    expect(day.steps[1].at?.tz).toBe(LA);
    expect(day.steps[2].at?.tz).toBe(NY);
  });

  it("shows one person only what involves them, and leaves out the leave-by when no drive time is given", () => {
    const { data, mark, lydia } = family();
    const marks = travelDay(data, { personId: mark.id }, "2026-12-19");
    expect(marks.who).toBe("Mark");
    expect(marks.leaveBy).toBeNull();
    expect(marks.steps.map((s) => s.title)).toEqual(["AS 1054 leaves SEA", "Land at MCO", "Pick up the minivan at MCO", "Check in at Lakeside house", "Welcome dinner"]);
    expect(travelDay(data, { personIds: [lydia.id] }, "2026-12-19").steps.map((s) => s.title)).toContain("Call the office");
  });

  it("says 'leave for the airport' on the way home, with check-out and the car return first", () => {
    const { data, seattle } = family();
    const day = travelDay(data, { partyId: seattle.id }, "2026-12-27", { driveMinutes: 35 });
    expect(day.steps.map((s) => [s.kind, s.timeText, s.title])).toEqual([
      ["check_out", "By 11:00 AM", "Check out of Lakeside house"],
      ["leave", "2:50 PM", "Leave for the airport"],
      ["car_return", "3:00 PM", "Return the minivan at MCO"],
      ["takeoff", "5:30 PM", "AS 1055 leaves MCO"],
      ["landing", "8:45 PM", "Land at SEA"],
    ]);
    expect(day.leaveBy?.label).toBe("Leave for the airport by");
    expect(day.leaveBy?.at.tz).toBe(NY);
  });

  it("gives someone who is driving their arrival as a step, with no leave-by", () => {
    const { data, tampa } = family();
    const day = travelDay(data, { partyId: tampa.id }, "2026-12-19", { driveMinutes: 25 });
    expect(day.who).toBe("Ruth and Dale");
    expect(day.leaveBy).toBeNull();
    expect(day.steps.map((s) => [s.kind, s.timeText, s.title, s.detail])).toEqual([
      ["arrive", "About 3:00 PM", "Arrive by road", "From Tampa."],
      ["check_in", "From 4:00 PM", "Check in at Lakeside house", "8 nights."],
      ["event", "6:30 PM", "Welcome dinner", null],
    ]);
  });

  it("splits a red-eye across its two days", () => {
    const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
    const me = makeParty(plan.id, "Me");
    const lydia = makePerson(me, "Lydia Hartley");
    const redEye = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("AS 20", "SEA", "2026-12-18T22:15", "MCO", "2026-12-19T06:40")] }, { personIds: [lydia.id] });
    const stay = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27" });
    const data = makePlanData({ plan, parties: [me], people: [lydia], bookings: [redEye, stay] });

    const night = travelDay(data, { personId: lydia.id }, "2026-12-18", { driveMinutes: 25 });
    expect(night.steps.map((s) => [s.timeText, s.title, s.kind === "takeoff" ? s.detail : null])).toEqual([
      ["7:45 PM", "Leave home", null],
      ["10:15 PM", "AS 20 leaves SEA", "Lands Sat, Dec 19 at 6:40 AM."],
    ]);
    const morning = travelDay(data, { personId: lydia.id }, "2026-12-19", { driveMinutes: 25 });
    expect(morning.leaveBy).toBeNull();
    expect(morning.steps.map((s) => [s.timeText, s.title])).toEqual([
      ["6:40 AM", "Land at MCO"],
      ["From 4:00 PM", "Check in at Lakeside house"],
    ]);
  });

  it("leaves home once for a connection, and uses a delay someone entered for the landing", () => {
    const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
    const me = makeParty(plan.id, "Me");
    const lydia = makePerson(me, "Lydia Hartley");
    const viaDenver = makeBooking(
      plan.id,
      "flight",
      {
        tripType: "one_way",
        segments: [
          seg("UA 410", "SEA", "2026-12-19T06:00", "DEN", "2026-12-19T09:40"),
          seg("UA 1722", "DEN", "2026-12-19T10:45", "MCO", "2026-12-19T16:20", { expectedArrivalAt: zonedToUtc("2026-12-19T17:05", NY).toISOString() }),
        ],
      },
      { personIds: [lydia.id] },
    );
    const day = travelDay(makePlanData({ plan, parties: [me], people: [lydia], bookings: [viaDenver] }), { personId: lydia.id }, "2026-12-19", { driveMinutes: 25 });
    expect(day.steps.map((s) => [s.kind, s.timeText, s.title, s.kind === "landing" ? s.detail : null])).toEqual([
      ["leave", "3:30 AM", "Leave home", null],
      ["takeoff", "6:00 AM", "UA 410 leaves SEA", null],
      ["landing", "9:40 AM", "Land at DEN", null],
      ["takeoff", "10:45 AM", "UA 1722 leaves DEN", null],
      ["landing", "5:05 PM", "Land at MCO", "Was 4:20 PM."],
    ]);
    expect(day.steps.filter((s) => s.kind === "leave")).toHaveLength(1);
  });

  it("is empty on a day with nothing, and for a plan with nobody", () => {
    const { data, seattle } = family();
    expect(travelDay(data, { partyId: seattle.id }, "2026-12-22", { driveMinutes: 25 })).toMatchObject({ steps: [], leaveBy: null, label: "Tue, Dec 22" });
    const empty = travelDay(makePlanData(), { personIds: [] }, "2026-12-19");
    expect(empty).toMatchObject({ who: "Everyone", steps: [], personIds: [] });
  });

  it("names a big household by its name", () => {
    const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
    const party = makeParty(plan.id, "The Nguyens");
    const people = ["An", "Binh", "Cam", "Dung"].map((name) => makePerson(party, name));
    people[3].rsvpStatus = "no";
    const day = travelDay(makePlanData({ plan, parties: [party], people }), { partyId: party.id }, "2026-12-19");
    // Dung said no: three are travelling, few enough to name.
    expect(day.who).toBe("An, Binh and Cam");
    people[3].rsvpStatus = "yes";
    expect(travelDay(makePlanData({ plan, parties: [party], people }), { partyId: party.id }, "2026-12-19").who).toBe("The Nguyens");
  });
});
