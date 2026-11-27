import { describe, expect, it } from "vitest";
import type { Arrival, Booking, Party, Person } from "@/db/schema";
import { zonedToUtc } from "@/lib/time";
import { isOnRecord, resolveArrivals, travelByPerson } from "./arrivals";
import { flightEnds, isConnection } from "./shared";
import { airport, at, makeArrival, makeBooking, makeParty, makePerson, makePlan, makePlanData, seg } from "./testing";

const NY = "America/New_York";
const noon = zonedToUtc("2026-12-01T12:00", NY);

/** Orlando, Sat Dec 19 to Sun Dec 27, 2026, with nobody in it yet. */
function orlandoPlan() {
  return makePlan({ startDate: "2026-12-19", endDate: "2026-12-27", kindsInUse: ["flight", "lodging", "car", "ride"] });
}

function household(planId: string, name: string, members: string[], over: Partial<Party> = {}): { party: Party; people: Person[] } {
  const party = makeParty(planId, name, over);
  return { party, people: members.map((member) => makePerson(party, member)) };
}

function roundTrip(planId: string, people: Person[], out: Parameters<typeof seg>, back: Parameters<typeof seg>, over: Partial<Booking> = {}): Booking {
  return makeBooking(planId, "flight", { tripType: "round_trip", segments: [seg(...out), seg(...back)] }, { personIds: people.map((p) => p.id), ...over });
}

describe("a row linked to a recorded flight", () => {
  const plan = orlandoPlan();
  const seattle = household(plan.id, "The Seattle Hartleys", ["Lydia Hartley", "Mark Hartley", "Theo Hartley", "June Hartley"]);
  const flight = roundTrip(
    plan.id,
    seattle.people,
    ["AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10", { arrivalTerminal: "B" }],
    ["AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45", { terminal: "A" }],
  );

  it("reads the time, the flight and the airport from the booking, not from the arrival's own columns", () => {
    const stale = makeArrival(seattle.party, "arrival", {
      bookingId: flight.id,
      segmentIndex: 0,
      // Left over from before the flight was recorded. All of it must be ignored.
      carrier: "ZZ",
      number: "9",
      scheduledAt: zonedToUtc("2026-12-18T09:00", NY),
      tz: NY,
      fromLabel: "Somewhere else",
      mode: "drive",
    });
    const board = resolveArrivals(makePlanData({ plan, parties: [seattle.party], people: seattle.people, bookings: [flight], arrivals: [stale] }), noon);
    const [row] = board.arrivals.rows;
    expect(row).toMatchObject({
      key: `arrival:${stale.id}`,
      arrivalId: stale.id,
      partyName: "The Seattle Hartleys",
      who: "The Seattle Hartleys (4)",
      headCount: 4,
      mode: "flight",
      timeText: "4:10 PM",
      localDate: "2026-12-19",
      otherEnd: "SEA",
      expected: null,
      status: { value: "unknown", label: "Scheduled" },
    });
    expect(row.scheduled).toEqual(at("2026-12-19T16:10", NY));
    expect(row.flight).toEqual({ designator: "AS 1054", bookingId: flight.id, segmentIndex: 0, originIata: "SEA", destinationIata: "MCO", connections: [] });
    expect(row.place).toEqual({ key: "MCO", label: "MCO", iata: "MCO", terminal: "B" });
  });

  it("shows a departure in the time of the airport it leaves from", () => {
    const leaving = makeArrival(seattle.party, "departure", { bookingId: flight.id, segmentIndex: 1 });
    const board = resolveArrivals(makePlanData({ plan, parties: [seattle.party], people: seattle.people, bookings: [flight], arrivals: [leaving] }), noon);
    const [row] = board.departures.rows;
    expect(row.timeText).toBe("5:30 PM");
    expect(row.at).toEqual(at("2026-12-27T17:30", NY));
    expect(row.otherEnd).toBe("SEA");
    expect(row.place).toMatchObject({ iata: "MCO", terminal: "A" });
    expect(board.departures.summary).toBe("4 leaving Sunday · 0 have rides · 0 need a ride · 4 not known yet");
  });

  it("works out which segment is meant when the arrival does not say", () => {
    const arrival = makeArrival(seattle.party, "arrival", { bookingId: flight.id });
    const departure = makeArrival(seattle.party, "departure", { bookingId: flight.id });
    const board = resolveArrivals(makePlanData({ plan, parties: [seattle.party], people: seattle.people, bookings: [flight], arrivals: [arrival, departure] }), noon);
    expect(board.arrivals.rows[0].flight?.designator).toBe("AS 1054");
    expect(board.departures.rows[0].flight?.designator).toBe("AS 1055");
  });

  it("puts a later time entered on the flight beside the scheduled one", () => {
    const delayed = makeBooking(
      plan.id,
      "flight",
      { segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10", { expectedArrivalAt: zonedToUtc("2026-12-19T17:05", NY).toISOString(), statusNote: "Delayed 55 min" })] },
      { personIds: seattle.people.map((p) => p.id) },
    );
    const arrival = makeArrival(seattle.party, "arrival", { bookingId: delayed.id, segmentIndex: 0 });
    const [row] = resolveArrivals(makePlanData({ plan, parties: [seattle.party], people: seattle.people, bookings: [delayed], arrivals: [arrival] }), noon).arrivals.rows;
    expect(row.scheduled).toEqual(at("2026-12-19T16:10", NY));
    expect(row.expected).toEqual(at("2026-12-19T17:05", NY));
    expect(row.at).toEqual(row.expected);
    expect(row.timeText).toBe("5:05 PM");
  });

  it("falls back to what was typed when the booking is gone or cancelled", () => {
    const cancelled = { ...flight, status: "cancelled" as const };
    const typed = makeArrival(seattle.party, "arrival", {
      bookingId: flight.id,
      segmentIndex: 0,
      carrier: "AS",
      number: "1054",
      scheduledAt: zonedToUtc("2026-12-19T16:10", NY),
      tz: NY,
      toPlace: airport("MCO"),
      fromLabel: "Seattle",
    });
    for (const bookings of [[cancelled], []]) {
      const [row] = resolveArrivals(makePlanData({ plan, parties: [seattle.party], people: seattle.people, bookings, arrivals: [typed] }), noon).arrivals.rows;
      expect(row.flight).toEqual({ designator: "AS 1054", bookingId: null, segmentIndex: null, originIata: null, destinationIata: null, connections: [] });
      expect(row.timeText).toBe("4:10 PM");
      expect(row.otherEnd).toBe("Seattle");
      expect(row.place.label).toBe("MCO");
    }
  });

  it("names the journey's first airport and where they change planes", () => {
    const viaDenver = makeBooking(
      plan.id,
      "flight",
      {
        tripType: "round_trip",
        segments: [
          seg("UA 410", "SEA", "2026-12-19T06:00", "DEN", "2026-12-19T09:40"),
          seg("UA 1722", "DEN", "2026-12-19T10:45", "MCO", "2026-12-19T16:20"),
          seg("UA 1731", "MCO", "2026-12-27T08:00", "DEN", "2026-12-27T10:05"),
          seg("UA 415", "DEN", "2026-12-27T11:30", "SEA", "2026-12-27T13:20"),
        ],
      },
      { personIds: seattle.people.map((p) => p.id) },
    );
    const board = resolveArrivals(makePlanData({ plan, parties: [seattle.party], people: seattle.people, bookings: [viaDenver] }), noon);
    expect(board.arrivals.rows[0]).toMatchObject({ otherEnd: "SEA", timeText: "4:20 PM", flight: { designator: "UA 1722", connections: ["DEN"], segmentIndex: 1 } });
    expect(board.departures.rows[0]).toMatchObject({ otherEnd: "SEA", timeText: "8:00 AM", flight: { designator: "UA 1731", connections: ["DEN"], segmentIndex: 2 } });
  });
});

describe("where rows come from", () => {
  it("gives one row per household per direction, and a second one when a household is split across two flights", () => {
    const plan = orlandoPlan();
    const h = household(plan.id, "The Seattle Hartleys", ["Lydia Hartley", "Mark Hartley", "Theo Hartley", "June Hartley"]);
    const [lydia, mark, theo, june] = h.people;
    const early = roundTrip(plan.id, [lydia, theo], ["AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"], ["AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45"]);
    const late = roundTrip(plan.id, [mark, june], ["DL 2203", "SEA", "2026-12-19T11:00", "MCO", "2026-12-19T19:35"], ["DL 2204", "MCO", "2026-12-27T18:10", "SEA", "2026-12-27T21:20"]);
    // The database allows one arrival per household per direction: it can only point at one flight.
    const stored = makeArrival(h.party, "arrival", { personIds: [lydia.id, theo.id], bookingId: early.id, segmentIndex: 0, rideNeed: "rental_car" });
    const board = resolveArrivals(makePlanData({ plan, parties: [h.party], people: h.people, bookings: [early, late], arrivals: [stored] }), noon);

    expect(board.arrivals.rows.map((row) => [row.who, row.timeText, row.flight?.designator, row.arrivalId === null])).toEqual([
      ["Lydia and Theo (2)", "4:10 PM", "AS 1054", false],
      ["Mark and June (2)", "7:35 PM", "DL 2203", true],
    ]);
    expect(board.arrivals.rows[1].key).toBe(`flight:${late.id}:0:${h.party.id}`);
    expect(board.arrivals.rows[1].ride).toMatchObject({ state: "unknown", resolved: false, label: "Ride not known yet" });
    expect(board.arrivals.missing).toEqual([]);
    // No stored departures at all: both come straight from the flights.
    expect(board.departures.rows.map((row) => row.who)).toEqual(["Lydia and Theo (2)", "Mark and June (2)"]);
    const travel = travelByPerson(board);
    expect(travel.get(june.id)?.arrival?.flight?.designator).toBe("DL 2203");
    expect(travel.get(lydia.id)?.departure?.flight?.designator).toBe("AS 1055");
  });

  it("treats an arrival with no names on it as the whole household", () => {
    const plan = orlandoPlan();
    const h = household(plan.id, "The Okafors", ["Ada Okafor", "Ben Okafor", "Chidi Okafor"]);
    const driving = makeArrival(h.party, "arrival", { mode: "drive", scheduledAt: zonedToUtc("2026-12-19T15:00", NY), tz: NY, fromLabel: "Tampa", source: "guest" });
    const board = resolveArrivals(makePlanData({ plan, parties: [h.party], people: h.people, arrivals: [driving] }), noon);
    expect(board.arrivals.rows[0]).toMatchObject({
      who: "The Okafors (3)",
      headCount: 3,
      timeText: "About 3:00 PM",
      otherEnd: "Tampa",
      place: { key: "road", label: "By road" },
      ride: { state: "driving", label: "Own car", resolved: true, credit: null },
      flight: null,
    });
    expect(board.arrivals.summary).toBe("3 arriving Saturday · 3 have rides · 0 need a ride");
    expect(board.arrivals.text).toBe("Arriving Sat, Dec 19 by road\nAbout 3:00 PM  The Okafors (3), driving from Tampa");
  });

  it("leaves out people who said no, and drops the row when nobody on it is coming", () => {
    const plan = orlandoPlan();
    const a = household(plan.id, "The Lees", ["Min Lee", "Jun Lee"]);
    const b = household(plan.id, "The Diazes", ["Ana Diaz", "Leo Diaz"]);
    a.people[1].rsvpStatus = "no";
    b.people.forEach((person) => (person.rsvpStatus = "no"));
    const arrivals = [a.party, b.party].map((party) => makeArrival(party, "arrival", { mode: "drive", scheduledAt: zonedToUtc("2026-12-19T15:00", NY), tz: NY }));
    const board = resolveArrivals(makePlanData({ plan, parties: [a.party, b.party], people: [...a.people, ...b.people], arrivals }), noon);
    expect(board.arrivals.rows.map((row) => row.who)).toEqual(["Min"]);
    expect(board.arrivals.missing).toEqual([]);
  });

  it("lists people who are expected and have nothing on record", () => {
    const plan = orlandoPlan();
    const portland = household(plan.id, "The Portland Hartleys", ["Dana Hartley", "Chris Hartley"], { origin: { kind: "city", name: "Portland", tz: "America/Los_Angeles" } });
    const rob = household(plan.id, "Rob", ["Rob Hartley"]);
    const big = household(plan.id, "The Nguyens", ["An", "Binh", "Cam", "Dung", "Em"]);
    const board = resolveArrivals(makePlanData({ plan, parties: [portland.party, rob.party, big.party], people: [...portland.people, ...rob.people, ...big.people] }), noon);
    expect(board.arrivals.rows).toEqual([]);
    expect(board.arrivals.missing.map((m) => m.label)).toEqual(["Dana and Chris (Portland)", "Rob", "The Nguyens"]);
    expect(board.arrivals.missingLine).toBe("No arrival yet: Dana and Chris (Portland), Rob, The Nguyens");
    expect(board.departures.missingLine).toBe("No trip home yet: Dana and Chris (Portland), Rob, The Nguyens");
    expect(board.arrivals.summary).toBe("");
    expect(board.isEmpty).toBe(true);
  });

  it("does not guess who is on a flight when nobody is ticked and there are several households", () => {
    const plan = orlandoPlan();
    const a = household(plan.id, "The Lees", ["Min Lee"]);
    const b = household(plan.id, "The Diazes", ["Ana Diaz"]);
    const flight = makeBooking(plan.id, "flight", { segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] });
    const board = resolveArrivals(makePlanData({ plan, parties: [a.party, b.party], people: [...a.people, ...b.people], bookings: [flight] }), noon);
    expect(board.arrivals.rows).toEqual([]);
    expect(board.arrivals.missing).toHaveLength(2);
  });

  it("takes an unticked flight as everyone's when there is one household", () => {
    const plan = orlandoPlan();
    const h = household(plan.id, "Us", ["Lydia Hartley", "Mark Hartley"]);
    const flight = makeBooking(plan.id, "flight", { segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10")] });
    const board = resolveArrivals(makePlanData({ plan, parties: [h.party], people: h.people, bookings: [flight] }), noon);
    expect(board.arrivals.rows.map((row) => row.who)).toEqual(["Us (2)"]);
    expect(board.departures.missing.map((m) => m.label)).toEqual(["Lydia and Mark"]);
  });

  it("only reads flights that are booked: a flight still being looked for puts nobody on the board", () => {
    const plan = orlandoPlan();
    const h = household(plan.id, "Us", ["Lydia Hartley"]);
    const looking = makeBooking(plan.id, "flight", {}, { status: "looking", personIds: [h.people[0].id] });
    expect(resolveArrivals(makePlanData({ plan, parties: [h.party], people: h.people, bookings: [looking] }), noon).arrivals.rows).toEqual([]);
  });
});

describe("someone who is already there, and someone with no time yet", () => {
  const plan = orlandoPlan();
  const local = household(plan.id, "Grandma", ["Ruth Hartley"]);
  const later = household(plan.id, "The Lees", ["Min Lee", "Jun Lee"]);
  const rows = [
    makeArrival(local.party, "arrival", { mode: "local" }),
    makeArrival(later.party, "arrival", { mode: "flight" }),
  ];
  const board = resolveArrivals(makePlanData({ plan, parties: [local.party, later.party], people: [...local.people, ...later.people], arrivals: rows }), noon);

  it("counts a local as here, needing no ride, and not as arriving", () => {
    const row = board.arrivals.rows.find((r) => r.mode === "local")!;
    expect(row).toMatchObject({ here: true, timeText: null, place: { key: "here", label: "Already here" }, ride: { state: "already_here", credit: null }, status: { label: "Already here" } });
    expect(isOnRecord(row)).toBe(true);
    expect(board.arrivals.counts).toEqual({ people: 2, haveRides: 0, needRide: 0, notKnown: 2 });
  });

  it("shows a flight with no number and no time as not booked, and not on record", () => {
    const row = board.arrivals.rows.find((r) => r.mode === "flight")!;
    expect(row.status.label).toBe("Not booked");
    expect(row.place.label).toBe("Airport not known yet");
    expect(isOnRecord(row)).toBe(false);
    expect(board.arrivals.undated).toHaveLength(2);
    expect(board.arrivals.days).toEqual([]);
    expect(board.arrivals.text).toBe("No time yet\nThe Lees (2), ride not known yet\nAlready here: Ruth");
  });
});

describe("rides", () => {
  const plan = orlandoPlan();
  const sea = household(plan.id, "The Seattle Hartleys", ["Lydia Hartley", "Mark Hartley", "Theo Hartley", "June Hartley"]);
  sea.people[2].ageGroup = "child";
  sea.people[3].ageGroup = "child";
  const pdx = household(plan.id, "The Portland Hartleys", ["Dana Hartley", "Chris Hartley"]);
  const msp = household(plan.id, "Ruth and Dale", ["Ruth Hartley", "Dale Hartley"]);
  const rob = household(plan.id, "Rob", ["Rob Hartley"]);
  rob.people[0].canDrive = true;
  rob.people[0].vehicleSeats = 4;
  const people = [...sea.people, ...pdx.people, ...msp.people, ...rob.people];
  const parties = [sea.party, pdx.party, msp.party, rob.party];
  const seaFlight = roundTrip(plan.id, sea.people, ["AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"], ["AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45"]);
  const pdxFlight = roundTrip(plan.id, pdx.people, ["AS 772", "PDX", "2026-12-19T07:40", "MCO", "2026-12-19T15:55"], ["AS 773", "MCO", "2026-12-27T16:45", "PDX", "2026-12-27T19:50"]);
  const mspFlight = roundTrip(plan.id, msp.people, ["DL 1420", "MSP", "2026-12-19T10:05", "MCO", "2026-12-19T14:20"], ["DL 1421", "MCO", "2026-12-27T15:10", "MSP", "2026-12-27T17:40"]);
  const flights = [seaFlight, pdxFlight, mspFlight];
  const link = (booking: Booking) => ({ bookingId: booking.id, segmentIndex: 0 });

  it("says who is driving, and checks the seats against the whole pickup run", () => {
    const arrivals = [
      makeArrival(sea.party, "arrival", { ...link(seaFlight), rideNeed: "driver_assigned", driverPersonId: rob.people[0].id, bags: 4 }),
      makeArrival(pdx.party, "arrival", { ...link(pdxFlight), rideNeed: "needs_ride", bags: 2 }),
      makeArrival(msp.party, "arrival", { ...link(mspFlight), rideNeed: "own_car" }),
      makeArrival(rob.party, "arrival", { mode: "local" }),
    ];
    const board = resolveArrivals(makePlanData({ plan, parties, people, bookings: flights, arrivals }), noon);
    const seattle = board.arrivals.rows.find((row) => row.partyId === sea.party.id)!;
    const portland = board.arrivals.rows.find((row) => row.partyId === pdx.party.id)!;

    expect(seattle.ride).toMatchObject({ state: "driver", label: "Rob is driving", inline: "Rob is driving", resolved: true, credit: 1, driver: { personId: rob.people[0].id, name: "Rob" } });
    expect(seattle.childCount).toBe(2);
    expect(portland.ride).toMatchObject({ state: "needs_ride", label: "Needs a ride", inline: "needs a ride", resolved: false, credit: 0 });

    // 3:55 PM and 4:10 PM into MCO: one run, six people. The 2:20 PM arrival has its own car.
    expect(board.arrivals.runs).toHaveLength(1);
    const [run] = board.arrivals.runs;
    expect(run).toMatchObject({ headCount: 6, childCount: 2, bags: 6, waitMinutes: 15, rowKeys: [portland.key, seattle.key], driver: { name: "Rob" } });
    expect(run.sentence).toBe("One trip can meet both: 6 people, first lands 3:55 PM, last 4:10 PM.");
    expect(seattle.runId).toBe(run.id);
    expect(portland.runId).toBe(run.id);
    expect(seattle.ride.seatCheck).toEqual({
      ok: false,
      seats: 4,
      passengers: 6,
      bags: 6,
      sentence: "Rob's car seats 4 passengers. This run is 6 people and 6 bags.",
    });
    expect(run.seatCheck).toBe(seattle.ride.seatCheck);

    expect(board.arrivals.summary).toBe("8 arriving Saturday · 6 have rides · 2 need a ride");
    expect(board.arrivals.days[0].groups).toHaveLength(1);
    expect(board.arrivals.days[0].groups[0].runs).toEqual([run]);
    expect(board.arrivals.text).toBe(
      [
        "Arriving Sat, Dec 19 at MCO",
        "2:20 PM  Ruth and Dale (2), DL 1420 from MSP, own car",
        "3:55 PM  The Portland Hartleys (2), AS 772 from PDX, needs a ride",
        "4:10 PM  The Seattle Hartleys (4), AS 1054 from SEA, Rob is driving",
        "Already here: Rob",
      ].join("\n"),
    );
  });

  it("passes the seat check when the car is big enough, and says so when the seats are not known", () => {
    const driver = { ...rob.people[0], vehicleSeats: 4 };
    const arrival = makeArrival(pdx.party, "arrival", { ...link(pdxFlight), rideNeed: "driver_assigned", driverPersonId: driver.id });
    const data = makePlanData({ plan, parties, people: [...pdx.people, driver], bookings: [pdxFlight], arrivals: [arrival] });
    expect(resolveArrivals(data, noon).arrivals.rows[0].ride.seatCheck).toEqual({
      ok: true,
      seats: 4,
      passengers: 2,
      bags: null,
      sentence: "Rob's car seats 4 passengers. This pickup is 2 people.",
    });
    const unknown = { ...driver, vehicleSeats: null };
    const again = resolveArrivals({ ...data, people: [...pdx.people, unknown] }, noon).arrivals.rows[0].ride.seatCheck;
    expect(again).toMatchObject({ ok: null, seats: null, sentence: "No seat count for Rob's car yet. This pickup is 2 people." });
  });

  it("reads a planned or booked ride, by name when the provider is known", () => {
    const base = { rideType: "rideshare" as const, fromPlace: airport("MCO"), pickupAt: at("2026-12-19T14:50", NY) };
    const planned = makeBooking(plan.id, "ride", base, { status: "planned", provider: "uber" });
    const booked = makeBooking(plan.id, "ride", { ...base, rideType: "shuttle" }, { status: "booked" });
    const personal = makeBooking(plan.id, "ride", { ...base, rideType: "personal_pickup", driverPersonId: rob.people[0].id, vehicleSeats: 6 }, { status: "planned" });
    const arrivalFor = (ride: Booking, viaList = false) =>
      makeArrival(msp.party, "arrival", { ...link(mspFlight), rideNeed: "rideshare", rideBookingId: viaList ? null : ride.id, id: "arr-msp" });
    const rideOf = (ride: Booking, viaList = false) => {
      const linked = viaList ? { ...ride, details: { ...ride.details, arrivalIds: ["arr-msp"] } as Booking["details"] } : ride;
      return resolveArrivals(makePlanData({ plan, parties, people, bookings: [mspFlight, linked], arrivals: [arrivalFor(ride, viaList)] }), noon).arrivals.rows[0].ride;
    };
    expect(rideOf(planned)).toMatchObject({ state: "rideshare", label: "Uber planned", inline: "Uber planned", resolved: true, credit: 0.25, rideBookingId: planned.id });
    expect(rideOf(booked)).toMatchObject({ label: "Shuttle booked", inline: "shuttle booked", credit: 1 });
    // A ride that lists the arrival counts as linked even when the arrival does not point back at it.
    expect(rideOf(planned, true)).toMatchObject({ label: "Uber planned", rideBookingId: planned.id });
    // Someone in the plan driving: the seats come from the ride, not from the person.
    const personalRide = rideOf(personal);
    expect(personalRide).toMatchObject({ state: "driver", label: "Rob is driving", credit: 1 });
    expect(personalRide.seatCheck).toMatchObject({ ok: true, seats: 6, passengers: 2 });
  });

  it("finds the ride for people on a flight with no stored arrival, by who, where and when", () => {
    const solo = orlandoPlan();
    const me = household(solo.id, "Lydia", ["Lydia Hartley"]);
    const flights = roundTrip(solo.id, me.people, ["AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"], ["AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45"]);
    const rideAt = (local: string, over: Record<string, unknown> = {}) =>
      makeBooking(solo.id, "ride", { rideType: "rideshare", fromPlace: airport("MCO"), pickupAt: at(local, NY), passengerIds: [me.people[0].id], ...over }, { provider: "lyft" });
    const arrivalRide = (ride: Booking) => resolveArrivals(makePlanData({ plan: solo, parties: [me.party], people: me.people, bookings: [flights, ride] }), noon).arrivals.rows[0].ride;

    expect(arrivalRide(rideAt("2026-12-19T16:40"))).toMatchObject({ state: "rideshare", label: "Lyft booked", credit: 1 });
    // Hours before the plane lands, at another airport, or for somebody else: not this arrival's ride.
    expect(arrivalRide(rideAt("2026-12-19T13:00")).state).toBe("unknown");
    expect(arrivalRide(rideAt("2026-12-19T16:40", { fromPlace: airport("TPA") })).state).toBe("unknown");
    expect(arrivalRide(rideAt("2026-12-19T16:40", { passengerIds: ["someone-else"] })).state).toBe("unknown");
    // A ride that names the arrivals it meets is never guessed onto another one.
    expect(arrivalRide(rideAt("2026-12-19T16:40", { arrivalIds: ["another-arrival"] })).state).toBe("unknown");

    const toAirport = makeBooking(solo.id, "ride", { rideType: "taxi", toPlace: airport("MCO"), pickupAt: at("2026-12-27T14:30", NY), passengerIds: [me.people[0].id] }, { status: "planned" });
    const board = resolveArrivals(makePlanData({ plan: solo, parties: [me.party], people: me.people, bookings: [flights, toAirport] }), noon);
    expect(board.departures.rows[0].ride).toMatchObject({ state: "rideshare", label: "Taxi planned", credit: 0.25 });
    expect(board.arrivals.rows[0].ride.state).toBe("unknown");
  });

  it("treats 'nobody has said' as an open question for an arrival, and not as a ride to arrange for the trip home", () => {
    const arrival = makeArrival(msp.party, "arrival", { ...link(mspFlight) });
    const departure = makeArrival(msp.party, "departure", { bookingId: mspFlight.id, segmentIndex: 1 });
    const board = resolveArrivals(makePlanData({ plan, parties, people, bookings: [mspFlight], arrivals: [arrival, departure] }), noon);
    expect(board.arrivals.rows[0].ride).toMatchObject({ state: "unknown", resolved: false, credit: 0 });
    expect(board.departures.rows[0].ride).toMatchObject({ state: "unknown", resolved: false, credit: null, label: "Ride not known yet" });
    // Once they ask for one, it counts.
    const asked = { ...departure, rideNeed: "needs_ride" as const };
    expect(resolveArrivals(makePlanData({ plan, parties, people, bookings: [mspFlight], arrivals: [asked] }), noon).departures.rows[0].ride.credit).toBe(0);
  });

  it("covers every other answer to 'does it need a ride'", () => {
    const labelFor = (rideNeed: Arrival["rideNeed"]) => {
      const arrival = makeArrival(msp.party, "arrival", { ...link(mspFlight), rideNeed });
      const ride = resolveArrivals(makePlanData({ plan, parties, people, bookings: [mspFlight], arrivals: [arrival] }), noon).arrivals.rows[0].ride;
      return [ride.label, ride.resolved, ride.credit];
    };
    expect(labelFor("unknown")).toEqual(["Ride not known yet", false, 0]);
    expect(labelFor("needs_ride")).toEqual(["Needs a ride", false, 0]);
    expect(labelFor("driver_assigned")).toEqual(["Needs a driver", false, 0]); // assigned, but to nobody
    expect(labelFor("rideshare")).toEqual(["Rideshare", true, 1]);
    expect(labelFor("rental_car")).toEqual(["Renting a car", true, null]);
    expect(labelFor("own_car")).toEqual(["Own car", true, null]);
    expect(labelFor("not_needed")).toEqual(["No ride needed", true, null]);
  });

  it("keeps landings more than 45 minutes apart, and landings with different drivers, as separate trips", () => {
    const mark = { ...sea.people[1], canDrive: true, vehicleSeats: 4 };
    const far = [
      makeArrival(msp.party, "arrival", { ...link(mspFlight), rideNeed: "needs_ride" }), // 2:20 PM
      makeArrival(pdx.party, "arrival", { ...link(pdxFlight), rideNeed: "needs_ride" }), // 3:55 PM
    ];
    const twoFlights = makePlanData({ plan, parties, people: [...msp.people, ...pdx.people], bookings: [mspFlight, pdxFlight], arrivals: far });
    expect(resolveArrivals(twoFlights, noon).arrivals.runs).toEqual([]);

    const twoDrivers = [
      makeArrival(pdx.party, "arrival", { ...link(pdxFlight), rideNeed: "driver_assigned", driverPersonId: rob.people[0].id }),
      makeArrival(sea.party, "arrival", { ...link(seaFlight), rideNeed: "driver_assigned", driverPersonId: mark.id }),
    ];
    expect(resolveArrivals(makePlanData({ plan, parties, people: [...people, mark], bookings: flights, arrivals: twoDrivers }), noon).arrivals.runs).toEqual([]);

    const within = resolveArrivals(twoFlights, noon, { runWindowMinutes: 120 }).arrivals.runs;
    expect(within).toHaveLength(1);
    expect(within[0].waitMinutes).toBe(95);
  });
});

describe("statuses, the day and 'now'", () => {
  const plan = orlandoPlan();
  const a = household(plan.id, "The Lees", ["Min Lee", "Jun Lee"]);
  const b = household(plan.id, "The Diazes", ["Ana Diaz"]);
  const c = household(plan.id, "The Roys", ["Dev Roy"]);
  const d = household(plan.id, "The Kims", ["Sora Kim"]);
  const parties = [a.party, b.party, c.party, d.party];
  const people = [...a.people, ...b.people, ...c.people, ...d.people];
  const timed = (local: string) => ({ mode: "train" as const, scheduledAt: zonedToUtc(local, NY), tz: NY, toPlace: { kind: "station" as const, name: "Orlando station", tz: NY } });
  const arrivals = [
    makeArrival(a.party, "arrival", { ...timed("2026-12-19T13:00"), status: "landed", statusAt: zonedToUtc("2026-12-19T13:02", NY) }),
    makeArrival(b.party, "arrival", { ...timed("2026-12-19T14:00"), status: "arrived", statusAt: zonedToUtc("2026-12-19T14:40", NY) }),
    makeArrival(c.party, "arrival", { ...timed("2026-12-19T18:00"), status: "cancelled" }),
    makeArrival(d.party, "arrival", { ...timed("2026-12-20T09:00"), status: "en_route" }),
  ];
  const data = makePlanData({ plan, parties, people, arrivals });
  const board = resolveArrivals(data, zonedToUtc("2026-12-19T15:00", NY));

  it("words each status", () => {
    expect(board.arrivals.rows.map((row) => row.status.label)).toEqual(["Landed 1:02 PM", "Arrived", "Canceled", "On the way"]);
    expect(resolveArrivals(data, noon, { wording: { style: "24h" } }).arrivals.rows[0].status.label).toBe("Landed 1302");
    expect(resolveArrivals(data, noon, { wording: { style: "24h", militaryStyle: "14:41" } }).arrivals.rows[0].timeText).toBe("13:00");
  });

  it("groups by day and place, marks today and what is past, and never counts a cancelled row", () => {
    expect(board.arrivals.days.map((day) => [day.date, day.label, day.isToday, day.hereCount])).toEqual([
      ["2026-12-19", "Sat, Dec 19", true, 1],
      ["2026-12-20", "Sun, Dec 20", false, 0],
    ]);
    expect(board.arrivals.days[0].groups[0].place.label).toBe("Orlando station");
    expect(board.arrivals.rows.map((row) => row.past)).toEqual([true, true, false, false]);
    expect(board.arrivals.rows.map((row) => row.here)).toEqual([false, true, false, false]);
    expect(board.arrivals.counts.people).toBe(4);
    expect(board.arrivals.summary).toBe("4 arriving · 0 have rides · 0 need a ride · 4 not known yet");
    expect(board.arrivals.days[1].summary).toBe("1 arriving Sunday · 0 have rides · 0 need a ride · 1 not known yet");
    // The cancelled household is expected again: nothing on record for them.
    expect(board.arrivals.missing.map((m) => m.partyName)).toEqual(["The Roys"]);
    expect(travelByPerson(board).get(c.people[0].id)).toBeUndefined();
  });
});

describe("awkward plans", () => {
  it("handles an empty plan and a plan with no dates", () => {
    const board = resolveArrivals(makePlanData(), noon);
    expect(board).toMatchObject({ isEmpty: true, arrivals: { rows: [], days: [], missing: [], summary: "", text: "", missingLine: null } });
  });

  it("puts a red-eye on the day it lands, and a date-line crossing on the right local day", () => {
    const plan = makePlan({ destination: { kind: "city", name: "Sydney", tz: "Australia/Sydney" }, tz: "Australia/Sydney", startDate: "2027-01-12", endDate: "2027-01-20" });
    const h = household(plan.id, "Us", ["Lydia Hartley"]);
    // Leaves Los Angeles on the evening of Jan 10 and lands in Sydney on the morning of Jan 12.
    const flight = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("QF 12", "LAX", "2027-01-10T22:30", "SYD", "2027-01-12T08:15")] }, { personIds: [h.people[0].id] });
    const home = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("QF 11", "SYD", "2027-01-20T09:50", "LAX", "2027-01-20T06:10")] }, { personIds: [h.people[0].id] });
    const board = resolveArrivals(makePlanData({ plan, parties: [h.party], people: h.people, bookings: [flight, home] }), noon);
    expect(board.arrivals.rows[0]).toMatchObject({ localDate: "2027-01-12", timeText: "8:15 AM", who: "Lydia" });
    expect(board.arrivals.days[0].label).toBe("Tue, Jan 12");
    // The flight home leaves Sydney on the 20th (and lands in Los Angeles earlier the same calendar day).
    expect(board.departures.rows[0]).toMatchObject({ localDate: "2027-01-20", timeText: "9:50 AM", otherEnd: "LAX" });
  });

  it("stays quick and correct with forty people in ten households", () => {
    const plan = orlandoPlan();
    const parties: Party[] = [];
    const people: Person[] = [];
    const arrivals = [];
    for (let i = 0; i < 10; i++) {
      const h = household(plan.id, `Household ${i + 1}`, ["A", "B", "C", "D"].map((n) => `${n}${i}`), { sortOrder: i });
      parties.push(h.party);
      people.push(...h.people);
      arrivals.push(makeArrival(h.party, "arrival", { mode: "train", scheduledAt: zonedToUtc(`2026-12-19T${String(8 + i).padStart(2, "0")}:00`, NY), tz: NY, rideNeed: i < 3 ? "needs_ride" : "own_car" }));
    }
    const board = resolveArrivals(makePlanData({ plan, parties, people, arrivals }), noon);
    expect(board.arrivals.rows).toHaveLength(10);
    expect(board.arrivals.summary).toBe("40 arriving Saturday · 28 have rides · 12 need a ride");
    expect(board.departures.missing).toHaveLength(10);
    expect(board.departures.missing[0].label).toBe("Household 1");
  });
});

describe("reading a flight booking's two ends", () => {
  const plan = { destination: null, startDate: "2026-12-19", endDate: "2026-12-27", tz: NY };
  const out = seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10");
  const back = seg("AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45");

  it("splits a round trip into the way there and the way home", () => {
    expect(flightEnds({ segments: [out, back], tripType: "round_trip" }, plan)).toEqual({ arrival: 0, departure: 1 });
    expect(flightEnds({ segments: [out, back], tripType: undefined }, plan)).toEqual({ arrival: 0, departure: 1 });
  });

  it("tells a one-way out from a one-way home by the plan's dates", () => {
    expect(flightEnds({ segments: [out], tripType: "one_way" }, plan)).toEqual({ arrival: 0, departure: null });
    expect(flightEnds({ segments: [back], tripType: "one_way" }, plan)).toEqual({ arrival: null, departure: 0 });
    // With no dates there is nothing to compare with: a single journey is the way there.
    expect(flightEnds({ segments: [back], tripType: undefined }, { ...plan, startDate: null, endDate: null })).toEqual({ arrival: 0, departure: null });
  });

  it("follows connections, and does not mistake a day trip's return for one", () => {
    const a = seg("UA 410", "SEA", "2026-12-19T06:00", "DEN", "2026-12-19T09:40");
    const b = seg("UA 1722", "DEN", "2026-12-19T10:45", "MCO", "2026-12-19T16:20");
    expect(isConnection(a, b)).toBe(true);
    expect(flightEnds({ segments: [a, b], tripType: "one_way" }, plan)).toEqual({ arrival: 1, departure: null });
    const there = seg("AS 345", "SEA", "2026-12-19T06:00", "PDX", "2026-12-19T06:55");
    const andBack = seg("AS 346", "PDX", "2026-12-19T18:00", "SEA", "2026-12-19T18:55");
    expect(isConnection(there, andBack)).toBe(false);
    expect(flightEnds({ segments: [there, andBack], tripType: undefined }, { ...plan, endDate: "2026-12-19" })).toEqual({ arrival: 0, departure: 1 });
  });

  it("uses the destination airport when the plan names one, and copes with no segments", () => {
    const viaMco = { ...plan, destination: airport("MCO") };
    const hop = seg("B6 88", "MCO", "2026-12-22T09:00", "TPA", "2026-12-22T09:50");
    expect(flightEnds({ segments: [out, hop, back], tripType: "multi_city" }, viaMco)).toEqual({ arrival: 0, departure: 1 });
    expect(flightEnds({ segments: [], tripType: undefined }, plan)).toEqual({ arrival: null, departure: null });
  });
});
