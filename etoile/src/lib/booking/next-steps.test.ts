import { describe, expect, it } from "vitest";
import { ARRIVALS, AIRPORTS, CAR_NEEDED, hartley, LAKESIDE_HOUSE, LAKESIDE_STAY, makeBooking, makePlan, makeTask, NOW, PARTIES, PEOPLE, planData, SEATTLE_FLIGHTS } from "./fixtures/plan";
import { suggestNextSteps, type NextStepOptions } from "./next-steps";

const opts: NextStepOptions = { airport: (iata) => AIRPORTS[iata], homeAirportIata: "SEA" };
const keys = (steps: Array<{ ruleKey: string }>) => steps.map((step) => step.ruleKey);

describe("suggestNextSteps: after the flights and the stay are saved", () => {
  const steps = suggestNextSteps(hartley(), NOW, opts);

  it("offers, in order: rides for each landing and the flight home, the car, food for arrival night, check-in", () => {
    expect(keys(steps)).toEqual([
      "ride:arrival:a-pdx-in",
      "ride:arrival:a-sea-in",
      "ride:departure:a-sea-out",
      "car:pickup:a-sea-in",
      "food:arrival-evening:2026-12-19",
      "flight:check-in:b-flight-sea:0",
      "flight:check-in:b-flight-sea:1",
    ]);
  });

  it("says each one in a plain sentence with a button that says what it does", () => {
    expect(steps.map((s) => [s.sentence, s.actionLabel])).toEqual([
      ["The Portland Hartleys land at MCO on Sat, Dec 19 at 3:55 PM. Plan a ride for 4:25 PM.", "Plan the ride"],
      ["You land at MCO on Sat, Dec 19 at 4:10 PM. Plan a ride for 4:40 PM.", "Plan the ride"],
      ["Your flight home leaves MCO on Sun, Dec 27 at 10:30 AM. Plan a ride to the airport for 7:55 AM.", "Plan the ride"],
      ["Pick up the car at MCO on Sat, Dec 19 at 5:00 PM, once you have your bags.", "Find a car"],
      ["Have dinner or groceries waiting on Sat, Dec 19. You should be in by about 6:30 PM.", "Plan food for arrival night"],
      ["Check in for AS 1054 from Fri, Dec 18 at 7:35 AM, 24 hours before it leaves.", "Remind me"],
      ["Check in for AS 1055 from Sat, Dec 26 at 10:30 AM, 24 hours before it leaves.", "Remind me"],
    ]);
    for (const step of steps) {
      expect(step.sentence).not.toMatch(/!|undefined|null/);
      expect(step.sentence.length).toBeLessThanOrEqual(110);
    }
  });

  it("carries the search to open, already filled in", () => {
    const ride = steps[1];
    expect(ride).toMatchObject({ type: "book", bookingKind: "ride" });
    expect(ride.proposal?.kind === "ride" && ride.proposal.query).toMatchObject({ pickupDate: "2026-12-19", pickupTime: "16:40", passengers: 4, arrivalIds: ["a-sea-in"] });
    const car = steps[3];
    expect(car).toMatchObject({ type: "book", bookingKind: "car", bookingId: "b-car" });
    expect(car.proposal?.kind === "car" && car.proposal.query).toMatchObject({ pickupTime: "17:00", returnTime: "08:00" });
    const food = steps[4];
    expect(food.proposal?.kind === "meal" && food.proposal.query).toMatchObject({ mealType: "restaurant_delivery", date: "2026-12-19", windowStart: "18:30" });
  });

  it("makes reminders ready to save as tasks, due the day before each flight", () => {
    expect(steps[5]).toMatchObject({
      type: "remind",
      bookingKind: "flight",
      bookingId: "b-flight-sea",
      dueDate: "2026-12-18",
      task: { title: "Check in for AS 1054", dueDate: "2026-12-18", essential: false, bookingId: "b-flight-sea" },
    });
    expect(steps[6].dueDate).toBe("2026-12-26");
  });
});

describe("suggestNextSteps: never twice", () => {
  it("leaves out anything that is already a task with the same rule key", () => {
    const data = hartley({ tasks: [makeTask({ id: "t1", title: "Check in for AS 1054", ruleKey: "flight:check-in:b-flight-sea:0" }), makeTask({ id: "t2", title: "By hand" })] });
    expect(keys(suggestNextSteps(data, NOW, opts))).not.toContain("flight:check-in:b-flight-sea:0");
    expect(keys(suggestNextSteps(data, NOW, opts))).toContain("flight:check-in:b-flight-sea:1");
  });

  it("leaves out anything the caller says was seen", () => {
    const seen = ["ride:arrival:a-pdx-in", "car:pickup:a-sea-in", "food:arrival-evening:2026-12-19"];
    expect(keys(suggestNextSteps(hartley(), NOW, { ...opts, seenRuleKeys: seen }))).toEqual(["ride:arrival:a-sea-in", "ride:departure:a-sea-out", "flight:check-in:b-flight-sea:0", "flight:check-in:b-flight-sea:1"]);
    expect(suggestNextSteps(hartley(), NOW, { ...opts, seenRuleKeys: new Set(keys(suggestNextSteps(hartley(), NOW, opts))) })).toEqual([]);
  });

  it("gives the same keys on every call, and no key twice", () => {
    const a = keys(suggestNextSteps(hartley(), NOW, opts));
    const b = keys(suggestNextSteps(hartley(), new Date("2026-12-01T09:00:00Z"), opts));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("stops suggesting a ride once it is planned or covered, and a car once it is booked", () => {
    const planned = makeBooking("ride", { id: "b-ride", status: "planned", title: "Airport ride", details: { rideType: "rideshare", arrivalIds: ["a-sea-in"], pickupAt: { at: "2026-12-19T21:40:00Z", tz: "America/New_York" } } });
    const car = makeBooking("car", { id: "b-car", status: "booked", title: "Hertz", details: { company: "Hertz" } });
    const data = hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, planned, car], arrivals: [ARRIVALS.seattleIn, ARRIVALS.seattleOut, { ...ARRIVALS.portlandIn, rideNeed: "driver_assigned", driverPersonId: "p-rob" }, ARRIVALS.orlandoIn] });
    const result = keys(suggestNextSteps(data, NOW, opts));
    expect(result).not.toContain("ride:arrival:a-sea-in");
    expect(result).not.toContain("ride:arrival:a-pdx-in");
    expect(result).not.toContain("car:pickup:a-sea-in");
    expect(result).toContain("ride:departure:a-sea-out");
    // The planned ride gets its reminder instead.
    expect(result).toContain("ride:reserve:b-ride:2026-12-19");
  });

  it("skips kinds the person said they do not need", () => {
    const data = hartley({ plan: makePlan({ kindsNotNeeded: ["ride", "car", "meal"] }) });
    expect(keys(suggestNextSteps(data, NOW, opts))).toEqual(["flight:check-in:b-flight-sea:0", "flight:check-in:b-flight-sea:1"]);
  });

  it("does not suggest a car or food for a plan that never listed them", () => {
    const data = hartley({ plan: makePlan({ kindsInUse: ["flight", "lodging", "ride"] }), bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY] });
    const result = keys(suggestNextSteps(data, NOW, opts));
    expect(result.some((key) => key.startsWith("car:") || key.startsWith("food:"))).toBe(false);
  });
});

describe("suggestNextSteps: the stay and the flights", () => {
  it("proposes a stay on the days the flights give when none is booked", () => {
    const data = hartley({ bookings: [SEATTLE_FLIGHTS] });
    const stay = suggestNextSteps(data, NOW, opts).find((s) => s.bookingKind === "lodging");
    expect(stay).toMatchObject({
      ruleKey: "stay:dates:2026-12-19:2026-12-27",
      type: "book",
      sentence: "Look for a place to stay from Sat, Dec 19 to Sun, Dec 27, the same days as your flights.",
      actionLabel: "Find a place to stay",
    });
    expect(stay?.proposal?.kind === "lodging" && stay.proposal.query).toMatchObject({ checkInDate: "2026-12-19", checkOutDate: "2026-12-27", lodgingType: "rental" });
  });

  it("says nothing about the stay when its dates match the flights", () => {
    expect(suggestNextSteps(hartley(), NOW, opts).some((s) => s.bookingKind === "lodging")).toBe(false);
  });

  it("points out a booked stay that starts or ends on a different day than the flights", () => {
    const wrong = makeBooking("lodging", { id: "b-stay", status: "booked", title: "Lakeside House", details: { propertyName: "Lakeside House", place: LAKESIDE_HOUSE, checkInDate: "2026-12-20", checkOutDate: "2026-12-26" } });
    const steps = suggestNextSteps(hartley({ bookings: [SEATTLE_FLIGHTS, wrong] }), NOW, opts).filter((s) => s.bookingKind === "lodging");
    expect(steps.map((s) => [s.ruleKey, s.type, s.sentence, s.actionLabel, s.bookingId])).toEqual([
      ["stay:check-in:b-stay:2026-12-20:2026-12-19", "check", "You land on Sat, Dec 19, but check-in at Lakeside House is Sun, Dec 20. Check the stay dates.", "Check the stay", "b-stay"],
      ["stay:check-out:b-stay:2026-12-26:2026-12-27", "check", "You fly home on Sun, Dec 27, but check-out at Lakeside House is Sat, Dec 26. Check the stay dates.", "Check the stay", "b-stay"],
    ]);
  });

  it("offers nothing about a stay before any flight is known", () => {
    const data = planData({ parties: [PARTIES.seattle], people: [PEOPLE.lydia] });
    expect(suggestNextSteps(data, NOW, opts)).toEqual([]);
  });
});

describe("suggestNextSteps: send ahead, through the narrow shipping function", () => {
  const box = makeBooking("shipment", { id: "b-box", status: "planned", title: "Box of gifts", details: { shipByDate: "2026-12-10", parcels: [{ status: "packed" }] } });

  it("reminds about the ship-by day stored on the booking", () => {
    const step = suggestNextSteps(hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, box] }), NOW, opts).find((s) => s.bookingKind === "shipment");
    expect(step).toEqual({
      ruleKey: "send-ahead:ship-by:b-box:2026-12-10",
      bookingKind: "shipment",
      type: "remind",
      sentence: "Box of gifts: ship by Thu, Dec 10 so it is waiting when you arrive.",
      actionLabel: "Remind me",
      bookingId: "b-box",
      dueDate: "2026-12-10",
      task: { title: "Ship by Thu, Dec 10: Box of gifts", dueDate: "2026-12-10", essential: true, bookingId: "b-box" },
    });
  });

  it("prefers the date the shipping function gives, and calls it with the shipment and the plan", () => {
    const calls: string[] = [];
    const data = hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, box] });
    const step = suggestNextSteps(data, NOW, {
      ...opts,
      shipBy: (shipment, plan) => {
        calls.push(`${shipment.id}:${shipment.details.kind}:${plan.plan.id}`);
        return { shipByDate: "2026-12-08", latestRiskyDate: "2026-12-14" };
      },
    }).find((s) => s.bookingKind === "shipment");
    expect(calls).toEqual(["b-box:shipment:plan1"]);
    expect(step).toMatchObject({ ruleKey: "send-ahead:ship-by:b-box:2026-12-08", dueDate: "2026-12-08", sentence: "Box of gifts: ship by Tue, Dec 8 so it is waiting when you arrive." });
  });

  it("falls back to the stored date when the function has no answer", () => {
    const data = hartley({ bookings: [box] });
    expect(suggestNextSteps(data, NOW, { ...opts, shipBy: () => null }).find((s) => s.bookingKind === "shipment")?.dueDate).toBe("2026-12-10");
  });

  it("says so once the day has passed", () => {
    const step = suggestNextSteps(hartley({ bookings: [box] }), new Date("2026-12-12T15:00:00Z"), opts).find((s) => s.bookingKind === "shipment");
    expect(step).toMatchObject({ sentence: "Box of gifts: Thu, Dec 10 was the last safe day to ship. Look at faster ways to send it.", actionLabel: "See faster options" });
  });

  it("is quiet once every parcel is on its way, for a return shipment, and with no date", () => {
    const shipped = makeBooking("shipment", { id: "b-box", title: "Box of gifts", details: { shipByDate: "2026-12-10", parcels: [{ status: "shipped" }] } });
    const coming = makeBooking("shipment", { id: "b-back", title: "Box home", details: { direction: "return", shipByDate: "2026-12-28" } });
    const undated = makeBooking("shipment", { id: "b-new", title: "Skis" });
    expect(suggestNextSteps(hartley({ bookings: [shipped, coming, undated] }), NOW, opts).filter((s) => s.bookingKind === "shipment")).toEqual([]);
  });
});

describe("suggestNextSteps: reserving rides", () => {
  const ride = (pickupAt: string, extra: Partial<Parameters<typeof makeBooking<"ride">>[1]> = {}) =>
    makeBooking("ride", { id: "b-ride", status: "planned", title: "Airport ride", details: { rideType: "rideshare", fromPlace: AIRPORTS.MCO, toPlace: LAKESIDE_HOUSE, pickupAt: { at: pickupAt, tz: "America/New_York" } }, ...extra });

  it("reminds a week ahead for a holiday ride, and says the time is set in the app", () => {
    const step = suggestNextSteps(hartley({ bookings: [ride("2026-12-19T21:40:00Z")] }), NOW, opts).find((s) => s.ruleKey.startsWith("ride:reserve"));
    expect(step).toMatchObject({
      ruleKey: "ride:reserve:b-ride:2026-12-19",
      type: "remind",
      sentence: "Reserve the ride for Sat, Dec 19 at 4:40 PM by Sat, Dec 12. You set the pick-up time in the Uber or Lyft app.",
      actionLabel: "Remind me",
      dueDate: "2026-12-12",
      bookingId: "b-ride",
      task: { title: "Reserve the ride for Sat, Dec 19 at 4:40 PM", dueDate: "2026-12-12", essential: true, bookingId: "b-ride" },
    });
    expect(step?.proposal?.kind).toBe("ride");
  });

  it("reminds two days ahead outside a holiday", () => {
    const data = planData({ plan: makePlan({ startDate: "2027-03-09", endDate: "2027-03-12" }), bookings: [ride("2027-03-09T21:40:00Z")] });
    expect(suggestNextSteps(data, NOW, opts).find((s) => s.ruleKey.startsWith("ride:reserve"))?.dueDate).toBe("2027-03-07");
  });

  it("says rides cannot be booked far ahead, and gives the day the window opens", () => {
    const data = planData({ plan: makePlan({ startDate: "2027-06-10", endDate: "2027-06-15" }), bookings: [ride("2027-06-10T21:40:00Z")] });
    const step = suggestNextSteps(data, NOW, opts).find((s) => s.ruleKey.startsWith("ride:reserve"));
    expect(step?.sentence).toBe("Rides can't be reserved more than 90 days ahead. Reserve the ride for Thu, Jun 10 at 5:40 PM from Fri, Mar 12.");
    expect(step?.dueDate).toBe("2027-06-08");
  });

  it("has no reminder for a ride already reserved, one someone is driving, or one in the past", () => {
    const none = (booking: ReturnType<typeof ride>) => suggestNextSteps(hartley({ bookings: [booking] }), NOW, opts).filter((s) => s.ruleKey.startsWith("ride:reserve"));
    expect(none(ride("2026-12-19T21:40:00Z", { status: "booked" }))).toEqual([]);
    expect(none(makeBooking("ride", { id: "b-ride", status: "planned", title: "Rob is driving", details: { rideType: "personal_pickup", pickupAt: { at: "2026-12-19T21:40:00Z", tz: "America/New_York" } } }))).toEqual([]);
    expect(none(ride("2026-11-20T21:40:00Z"))).toEqual([]);
    expect(none(makeBooking("ride", { id: "b-ride", status: "planned", title: "No time yet" }))).toEqual([]);
  });
});

describe("suggestNextSteps: check-in", () => {
  it("reminds once per journey, not once per connecting flight", () => {
    const connecting = makeBooking("flight", {
      id: "b-ua",
      status: "booked",
      title: "UA 1876 SFO to MCO",
      personIds: ["p-carol"],
      details: {
        segments: [
          { airlineIata: "UA", flightNumber: "1876", originIata: "SFO", destinationIata: "IAD", departsAt: "2026-12-19T06:40:00Z", originTz: "America/Los_Angeles", arrivesAt: "2026-12-19T11:38:00Z", destinationTz: "America/New_York" },
          { airlineIata: "UA", flightNumber: "437", originIata: "IAD", destinationIata: "MCO", departsAt: "2026-12-19T13:15:00Z", originTz: "America/New_York", arrivesAt: "2026-12-19T15:31:00Z", destinationTz: "America/New_York" },
        ],
      },
    });
    const steps = suggestNextSteps(planData({ bookings: [connecting] }), NOW, opts).filter((s) => s.ruleKey.startsWith("flight:check-in"));
    // Leaves San Francisco at 10:40 PM on Dec 18, so check-in opens 10:40 PM on Dec 17, Pacific time.
    expect(steps.map((s) => [s.ruleKey, s.dueDate, s.sentence])).toEqual([["flight:check-in:b-ua:0", "2026-12-17", "Check in for UA 1876 from Thu, Dec 17 at 10:40 PM, 24 hours before it leaves."]]);
  });

  it("does not remind about a flight that has left, or one that is not booked yet", () => {
    const after = suggestNextSteps(hartley(), new Date("2026-12-20T12:00:00Z"), opts);
    expect(keys(after).filter((key) => key.startsWith("flight:check-in"))).toEqual(["flight:check-in:b-flight-sea:1"]);
    const looking = { ...SEATTLE_FLIGHTS, status: "looking" as const };
    expect(keys(suggestNextSteps(hartley({ bookings: [looking] }), NOW, opts)).some((key) => key.startsWith("flight:check-in"))).toBe(false);
  });
});

describe("suggestNextSteps: thin plans", () => {
  it("returns nothing, and does not throw, for a plan with nothing in it", () => {
    expect(suggestNextSteps(planData(), NOW)).toEqual([]);
    expect(suggestNextSteps(planData({ plan: makePlan({ destination: null, startDate: null, endDate: null }) }), NOW)).toEqual([]);
    expect(suggestNextSteps(planData({ bookings: [CAR_NEEDED] }), NOW)).toEqual([]);
  });

  it("works without any options at all", () => {
    const steps = suggestNextSteps(hartley(), NOW);
    expect(keys(steps)).toContain("ride:arrival:a-sea-in");
    // Without the airport table the airport is still named by its code.
    expect(steps.find((s) => s.ruleKey === "car:pickup:a-sea-in")?.sentence).toBe("Pick up the car at MCO on Sat, Dec 19 at 5:00 PM, once you have your bags.");
  });

  it("offers food once a stay is booked, even with no flight", () => {
    const data = planData({ bookings: [LAKESIDE_STAY] });
    const steps = suggestNextSteps(data, NOW, opts);
    expect(steps.map((s) => [s.ruleKey, s.sentence])).toEqual([["food:arrival-evening:2026-12-19", "Have dinner or groceries waiting on Sat, Dec 19. You should be in by about 6:30 PM."]]);
  });

  it("does not offer food again once something is planned for that evening", () => {
    const meal = makeBooking("meal", { id: "b-meal", status: "planned", title: "Dinner", details: { mealType: "groceries", windowStart: { at: "2026-12-19T23:00:00Z", tz: "America/New_York" } } });
    expect(keys(suggestNextSteps(hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, meal] }), NOW, opts)).some((key) => key.startsWith("food:"))).toBe(false);
  });
});
