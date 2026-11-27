import { describe, expect, it } from "vitest";
import { actBySchema } from "@/lib/domain";
import { actByFor } from "./act-by";
import { AIRPORTS, CAR_NEEDED, hartley, LAKESIDE_HOUSE, LAKESIDE_STAY, makeBooking, makePlan, NOW, planData, SEATTLE_FLIGHTS } from "./fixtures/plan";
import { holidayPeriodsForYear, holidayPeriodTouching } from "./holiday-periods";

// A plan well away from any holiday: Tue, Mar 9 to Fri, Mar 12, 2027.
const ordinary = () => planData({ plan: makePlan({ startDate: "2027-03-09", endDate: "2027-03-12" }) });
const at = (iso: string) => new Date(iso);

describe("flights, stay and car: T minus days (product spec 10.4)", () => {
  it("uses 45 and 14 days for flights and a stay, 30 and 7 for the car", () => {
    expect(actByFor("flight", ordinary(), null, NOW)).toMatchObject({ recommended: "2027-01-23", hard: "2027-02-23", holiday: null });
    expect(actByFor("lodging", ordinary(), null, NOW)).toMatchObject({ recommended: "2027-01-23", hard: "2027-02-23" });
    expect(actByFor("car", ordinary(), null, NOW)).toMatchObject({ recommended: "2027-02-07", hard: "2027-03-02" });
    expect(actByFor("flight", ordinary(), null, NOW).opensOn).toBeUndefined();
  });

  it("pulls them forward when the dates touch a holiday: 60 and 21, and 45 and 14 for the car", () => {
    const data = hartley();
    expect(actByFor("flight", data, null, NOW)).toMatchObject({ recommended: "2026-10-20", hard: "2026-11-28" });
    expect(actByFor("lodging", data, null, NOW)).toMatchObject({ recommended: "2026-10-20", hard: "2026-11-28" });
    expect(actByFor("car", data, null, NOW)).toMatchObject({ recommended: "2026-11-04", hard: "2026-12-05" });
    expect(actByFor("car", data, null, NOW).holiday).toMatchObject({ id: "christmas-new-year", name: "Christmas" });
  });

  it("matches the worked example: the Hartleys' car is past its date, and the line reads 'Book by Dec 5 (holiday week)'", () => {
    const car = actByFor("car", hartley(), CAR_NEEDED, NOW);
    expect(car.line).toBe("Book by Dec 5 (holiday week)");
    expect(car.level).toBe("caution");
    expect(car.reason).toBe("Your dates include Christmas, when everything goes early. Book the car by Nov 4; after Dec 5 prices climb and choice shrinks.");
  });

  it("gives the reason in plain words without a holiday too", () => {
    const flight = actByFor("flight", ordinary(), null, NOW);
    expect(flight.reason).toBe("Book flights by Jan 23, about 6 weeks before you leave. After Feb 23 there is little left to choose from.");
    expect(flight.line).toBe("Book by Jan 23");
    expect(actByFor("lodging", ordinary(), null, NOW).reason).toBe("Book a place to stay by Jan 23, about 6 weeks ahead. After Feb 23 there is little left to choose from.");
  });

  it("moves through the levels as the dates pass", () => {
    const level = (now: string) => actByFor("car", ordinary(), CAR_NEEDED, at(now)).level;
    // Recommended Feb 7, hard Mar 2 (Eastern dates).
    expect(level("2027-01-30T17:00:00Z")).toBe("none");
    expect(level("2027-01-31T17:00:00Z")).toBe("info");
    expect(level("2027-02-07T17:00:00Z")).toBe("info");
    expect(level("2027-02-08T17:00:00Z")).toBe("caution");
    expect(level("2027-03-01T17:00:00Z")).toBe("caution");
    expect(level("2027-03-02T17:00:00Z")).toBe("alert");
    expect(level("2027-03-08T17:00:00Z")).toBe("alert");
  });

  it("changes the line from the recommended date to the hard one, then to 'as soon as you can'", () => {
    const line = (now: string) => actByFor("car", ordinary(), CAR_NEEDED, at(now)).line;
    expect(line("2027-02-07T17:00:00Z")).toBe("Book by Feb 7");
    expect(line("2027-02-08T17:00:00Z")).toBe("Book by Mar 2");
    expect(line("2027-03-03T17:00:00Z")).toBe("Book as soon as you can");
  });

  it("reads today in the plan's zone, not the server's", () => {
    // 03:00 UTC on Feb 8 is still Feb 7 in New York: the recommended day itself.
    expect(actByFor("car", ordinary(), CAR_NEEDED, at("2027-02-08T03:00:00Z")).level).toBe("info");
    expect(actByFor("car", ordinary(), CAR_NEEDED, at("2027-02-08T06:00:00Z")).level).toBe("caution");
  });

  it("is quiet for a booking that is booked, done, cancelled or not needed", () => {
    for (const status of ["booked", "done", "cancelled", "not_needed"] as const) {
      const result = actByFor("car", hartley(), { ...CAR_NEEDED, status }, NOW);
      expect(result.level, status).toBe("none");
      expect(result.hard).toBe("2026-12-05");
    }
    expect(actByFor("flight", hartley(), SEATTLE_FLIGHTS, NOW).level).toBe("none");
  });

  it("counts from the booking's own day when it has one", () => {
    const search = makeBooking("flight", { id: "b-f", title: "Flights", details: { search: { departDate: "2027-03-20", adults: 1, children: 0, infants: 0 } } });
    expect(actByFor("flight", ordinary(), search, NOW).recommended).toBe("2027-02-03");
    const stay = makeBooking("lodging", { id: "b-s", title: "Stay", details: { checkInDate: "2027-03-10" } });
    expect(actByFor("lodging", ordinary(), stay, NOW).hard).toBe("2027-02-24");
    const car = makeBooking("car", { id: "b-c", title: "Car", details: { pickupAt: { at: "2027-03-11T03:00:00Z", tz: "America/New_York" } } });
    // 03:00 UTC on Mar 11 is the evening of Mar 10 in New York.
    expect(actByFor("car", ordinary(), car, NOW).hard).toBe("2027-03-03");
  });

  it("ignores a booking of another kind", () => {
    expect(actByFor("car", ordinary(), LAKESIDE_STAY, NOW)).toMatchObject({ recommended: "2027-02-07", hard: "2027-03-02" });
  });

  it("has no dates, and says what to do, when the plan has none", () => {
    const result = actByFor("flight", planData({ plan: makePlan({ startDate: null, endDate: null }) }), null, NOW);
    expect(result).toEqual({ reason: "Pick your dates and we'll work out when to book.", line: null, holiday: null, level: "none" });
  });
});

describe("rides", () => {
  const ride = (pickupAt: string, extra: Record<string, unknown> = {}) =>
    makeBooking("ride", { id: "b-ride", status: "planned", title: "Airport ride", details: { rideType: "rideshare", fromPlace: AIRPORTS.MCO, toPlace: LAKESIDE_HOUSE, pickupAt: { at: pickupAt, tz: "America/New_York" }, ...extra } });

  it("recommends 2 days before, with reservations opening 90 days ahead and the ride's own day as the last moment", () => {
    const result = actByFor("ride", ordinary(), ride("2027-03-09T21:40:00Z"), NOW);
    expect(result).toMatchObject({ recommended: "2027-03-07", hard: "2027-03-09", opensOn: "2026-12-09", holiday: null });
    expect(result.reason).toBe("Uber and Lyft take reservations 90 days ahead, from Dec 9. Reserve by Mar 7; the last moment is about 3 hours before pick-up.");
    expect(result.line).toBe("Reservations open Dec 9");
    expect(actByFor("ride", ordinary(), ride("2027-03-09T21:40:00Z"), at("2027-01-05T17:00:00Z")).line).toBe("Reserve by Mar 7");
    expect(actByFor("ride", ordinary(), ride("2027-03-09T21:40:00Z"), at("2027-03-08T17:00:00Z")).line).toBe("Reserve by Mar 9");
  });

  it("recommends a week before when the dates touch a holiday", () => {
    const result = actByFor("ride", hartley(), ride("2026-12-19T21:40:00Z"), NOW);
    expect(result).toMatchObject({ recommended: "2026-12-12", hard: "2026-12-19", opensOn: "2026-09-20" });
    expect(result.reason).toBe("Uber and Lyft take reservations 90 days ahead, from Sep 20. Your dates include Christmas, so reserve a week ahead, by Dec 12.");
  });

  it("puts the last moment on the day before for a ride in the small hours", () => {
    // 1:30 AM pick-up: three hours before is 10:30 PM the previous evening.
    expect(actByFor("ride", ordinary(), ride("2027-03-10T05:30:00Z"), NOW).hard).toBe("2027-03-09");
  });

  it("asks to confirm with the driver when someone in the plan is driving", () => {
    const result = actByFor("ride", ordinary(), ride("2027-03-09T21:40:00Z", { rideType: "personal_pickup" }), NOW);
    expect(result.opensOn).toBeUndefined();
    expect(result.line).toBe("Confirm by Mar 7");
    expect(result.reason).toBe("Confirm the pick-up with whoever is driving by Mar 7.");
  });

  it("uses the plan's first day when no ride is given", () => {
    expect(actByFor("ride", ordinary(), null, NOW)).toMatchObject({ recommended: "2027-03-07", hard: "2027-03-09", opensOn: "2026-12-09" });
  });
});

describe("food", () => {
  const meal = (provider: string | null, mealType: "restaurant_delivery" | "groceries" | "catering" = "restaurant_delivery") =>
    makeBooking("meal", { id: "b-meal", status: "planned", title: "Dinner", provider, details: { mealType, windowStart: { at: "2026-12-19T23:30:00Z", tz: "America/New_York" } } });

  it("recommends the day the provider's window opens, with the day before as the last", () => {
    expect(actByFor("meal", hartley(), meal("doordash"), NOW)).toMatchObject({ recommended: "2026-12-15", opensOn: "2026-12-15", hard: "2026-12-18" });
    expect(actByFor("meal", hartley(), meal("grubhub"), NOW).opensOn).toBe("2026-12-15");
    expect(actByFor("meal", hartley(), meal("uber_eats"), NOW).opensOn).toBe("2026-12-12");
    expect(actByFor("meal", hartley(), meal("instacart", "groceries"), NOW).opensOn).toBe("2026-12-14");
  });

  it("uses the earliest window for the kind of order when no provider is chosen", () => {
    const dinner = actByFor("meal", hartley(), meal(null), NOW);
    expect(dinner).toMatchObject({ opensOn: "2026-12-12", line: "Order window opens Dec 12" });
    expect(dinner.reason).toBe("Uber Eats takes orders 7 days ahead, so the window opens Dec 12. Order by Dec 18, the day before.");
    expect(actByFor("meal", hartley(), meal(null, "groceries"), NOW).opensOn).toBe("2026-12-14");
  });

  it("switches the line once the window is open", () => {
    expect(actByFor("meal", hartley(), meal("doordash"), at("2026-12-15T15:00:00Z")).line).toBe("Order by Dec 18");
  });

  it("gives catering a week, and two days as the last moment", () => {
    const result = actByFor("meal", hartley(), meal("ezcater", "catering"), NOW);
    expect(result).toMatchObject({ recommended: "2026-12-12", hard: "2026-12-17" });
    expect(result.opensOn).toBeUndefined();
    expect(result.reason).toBe("Caterers need notice. Order by Dec 12 to be comfortable, and no later than Dec 17, 2 days before.");
    expect(result.line).toBe("Order by Dec 12");
  });

  it("is not changed by a holiday", () => {
    const quiet = planData({ plan: makePlan({ startDate: "2027-03-09", endDate: "2027-03-12" }) });
    const booking = makeBooking("meal", { id: "b", title: "Dinner", provider: "doordash", details: { windowStart: { at: "2027-03-09T23:30:00Z", tz: "America/New_York" } } });
    expect(actByFor("meal", quiet, booking, NOW)).toMatchObject({ recommended: "2027-03-05", hard: "2027-03-08", opensOn: "2027-03-05" });
  });
});

describe("send ahead", () => {
  const box = makeBooking("shipment", { id: "b-box", status: "planned", title: "Box of gifts", details: { shipByDate: "2026-12-10", latestRiskyDate: "2026-12-15" } });

  it("recommends messaging the property 5 days before ship-by, with ship-by as the hard date", () => {
    const result = actByFor("shipment", hartley(), box, NOW);
    expect(result).toMatchObject({ recommended: "2026-12-05", hard: "2026-12-10", line: "Ship by Dec 10", holiday: null });
    expect(result.reason).toBe("Ask the property by Dec 5 whether it will hold a parcel. Ship by Dec 10. Dec 15 is cutting it close.");
  });

  it("takes the dates from the shipping function when one is passed in", () => {
    const result = actByFor("shipment", hartley(), box, NOW, { shipBy: () => ({ shipByDate: "2026-12-08" }) });
    expect(result).toMatchObject({ recommended: "2026-12-03", hard: "2026-12-08", line: "Ship by Dec 8" });
  });

  it("says what is needed when there is no shipment or no date yet", () => {
    expect(actByFor("shipment", hartley(), null, NOW).reason).toBe("Add what you're sending and where, and we'll work out the last safe day to ship.");
    const undated = makeBooking("shipment", { id: "b", title: "Skis" });
    expect(actByFor("shipment", hartley(), undated, NOW)).toEqual({ reason: "Add where it's going and when you arrive, and we'll work out the last safe day to ship.", line: null, holiday: null, level: "none" });
  });
});

describe("the result", () => {
  it("can be stored on the booking: the schema keeps the three dates and drops the words", () => {
    expect(actBySchema.parse(actByFor("car", hartley(), CAR_NEEDED, NOW))).toEqual({ recommended: "2026-11-04", hard: "2026-12-05" });
    expect(actBySchema.parse(actByFor("flight", planData({ plan: makePlan({ startDate: null }) }), null, NOW))).toEqual({});
  });

  it("uses plain words: no exclamation marks, no internal vocabulary", () => {
    const bookings = [null, CAR_NEEDED, LAKESIDE_STAY, SEATTLE_FLIGHTS];
    for (const kind of ["flight", "lodging", "car", "ride", "meal", "shipment"] as const) {
      for (const booking of bookings) {
        for (const data of [hartley(), ordinary(), planData({ plan: makePlan({ startDate: null, endDate: null }) })]) {
          const result = actByFor(kind, data, booking, NOW);
          expect(`${result.reason} ${result.line ?? ""}`).not.toMatch(/!|undefined|null|NaN|lodging|rental car|shipment/);
        }
      }
    }
  });

  it("lets the caller supply the holiday calendar", () => {
    const none = actByFor("flight", hartley(), null, NOW, { holidayPeriod: () => null });
    expect(none).toMatchObject({ recommended: "2026-11-04", hard: "2026-12-05", holiday: null });
    const own = actByFor("flight", ordinary(), null, NOW, { holidayPeriod: (start, end) => ({ id: "spring-break", name: "spring break", tag: "holiday week", start, end, anchor: start }) });
    expect(own).toMatchObject({ recommended: "2027-01-08", hard: "2027-02-16" });
    expect(own.reason).toContain("Your dates include spring break");
  });
});

describe("holiday periods", () => {
  it("anchors the eleven periods on the right days in 2026", () => {
    const anchors = Object.fromEntries(holidayPeriodsForYear(2026).map((p) => [p.id, p.anchor]));
    expect(anchors).toEqual({
      "mlk-day": "2026-01-19",
      "presidents-day": "2026-02-16",
      easter: "2026-04-05",
      "memorial-day": "2026-05-25",
      juneteenth: "2026-06-19",
      "independence-day": "2026-07-04",
      "labor-day": "2026-09-07",
      "columbus-day": "2026-10-12",
      "veterans-day": "2026-11-11",
      thanksgiving: "2026-11-26",
      "christmas-new-year": "2026-12-25",
    });
  });

  it("gets Easter and the floating Mondays right in other years", () => {
    const anchor = (year: number, id: string) => holidayPeriodsForYear(year).find((p) => p.id === id)?.anchor;
    expect(anchor(2027, "easter")).toBe("2027-03-28");
    expect(anchor(2028, "easter")).toBe("2028-04-16");
    expect(anchor(2027, "thanksgiving")).toBe("2027-11-25");
    expect(anchor(2027, "memorial-day")).toBe("2027-05-31");
    expect(anchor(2027, "labor-day")).toBe("2027-09-06");
    expect(anchor(2028, "thanksgiving")).toBe("2028-11-23");
  });

  it("gives each period a window around its day", () => {
    const of = (id: string) => holidayPeriodsForYear(2026).find((p) => p.id === id);
    expect(of("thanksgiving")).toMatchObject({ start: "2026-11-23", end: "2026-12-01", tag: "holiday week" });
    // Christmas 2026 is a Friday: the period runs from Dec 17 to Jan 4.
    expect(of("christmas-new-year")).toMatchObject({ start: "2026-12-17", end: "2027-01-04" });
    expect(of("memorial-day")).toMatchObject({ start: "2026-05-21", end: "2026-05-26", tag: "holiday weekend" });
  });

  it("finds the period a trip touches, including one that began the year before", () => {
    expect(holidayPeriodTouching("2026-12-19", "2026-12-27")?.id).toBe("christmas-new-year");
    expect(holidayPeriodTouching("2027-01-02", "2027-01-06")?.id).toBe("christmas-new-year");
    expect(holidayPeriodTouching("2026-11-20", "2026-11-23")?.id).toBe("thanksgiving");
    expect(holidayPeriodTouching("2026-07-01", null)?.id).toBe("independence-day");
    expect(holidayPeriodTouching("2027-03-09", "2027-03-12")).toBeNull();
    expect(holidayPeriodTouching("2026-12-16", "2026-12-16")).toBeNull();
    expect(holidayPeriodTouching("2026-12-17", "2026-12-17")?.id).toBe("christmas-new-year");
  });

  it("picks the holiday a long trip shares the most days with when it touches two", () => {
    // Nov 24 to Dec 20: all of Thanksgiving week, four days of the Christmas period.
    expect(holidayPeriodTouching("2026-11-24", "2026-12-20")?.id).toBe("thanksgiving");
    // Dec 1 to 28: one day of Thanksgiving week's tail, twelve of Christmas.
    expect(holidayPeriodTouching("2026-12-01", "2026-12-28")?.id).toBe("christmas-new-year");
    expect(holidayPeriodTouching("2026-12-10", "2026-12-28")?.id).toBe("christmas-new-year");
  });

  it("counts only Christmas and Easter for a trip that does not touch the United States", () => {
    expect(holidayPeriodTouching("2026-11-24", "2026-11-28", { unitedStates: false })).toBeNull();
    expect(holidayPeriodTouching("2026-12-24", "2026-12-28", { unitedStates: false })?.id).toBe("christmas-new-year");
    const abroad = planData({
      plan: makePlan({ origin: { kind: "home", name: "London", countryCode: "GB", tz: "Europe/London" }, destination: { kind: "city", name: "Lisbon", countryCode: "PT", tz: "Europe/Lisbon" }, startDate: "2026-11-24", endDate: "2026-11-28", tz: "Europe/Lisbon" }),
    });
    expect(actByFor("flight", abroad, null, NOW)).toMatchObject({ recommended: "2026-10-10", hard: "2026-11-10", holiday: null });
    // The same dates from Seattle are Thanksgiving week.
    expect(actByFor("flight", planData({ plan: makePlan({ startDate: "2026-11-24", endDate: "2026-11-28" }) }), null, NOW).holiday?.id).toBe("thanksgiving");
  });
});
