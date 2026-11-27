import { describe, expect, it } from "vitest";
import { addDays, weekday } from "@/lib/time";
import {
  addTransitDays,
  calendarConfidence,
  carrierDay,
  closedDaysBetween,
  federalHolidays,
  inPeakSeason,
  isDeliveryDay,
  isServiceKey,
  isShipDay,
  nextDeliveryDay,
  nextShipDay,
  previousDeliveryDay,
  previousShipDay,
  subtractTransitDays,
  zoneFromMiles,
} from "./calendar";
import {
  CALENDAR_CARRIERS,
  CALENDAR_PUBLISHED_THROUGH,
  CARRIER_CALENDAR,
  DESTINATION_POLICIES,
  GROUND_DAYS_BY_ZONE,
  PEAK_WINDOWS,
  PUBLISHED_LAST_SHIP_DATES,
  SERVICES,
  SERVICE_KEYS,
  USPS_GROUND_ADVANTAGE_DAYS_BY_ZONE,
  type CalendarCarrier,
  type ServiceKey,
} from "./config";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayName = (date: string) => DAYS[weekday(date)];

/** One ground and one air service per carrier, to ask the calendar about. */
const GROUND: Record<CalendarCarrier, ServiceKey> = { usps: "usps_ground_advantage", ups: "ups_ground", fedex: "fedex_ground" };
const AIR: Record<CalendarCarrier, ServiceKey> = { usps: "usps_priority_mail_express", ups: "ups_next_day_air", fedex: "fedex_overnight" };

describe("federal holidays", () => {
  it("computes the 2026 dates and weekdays the report checked", () => {
    const h = federalHolidays(2026);
    expect(h).toEqual({
      newYear: "2026-01-01", mlk: "2026-01-19", presidents: "2026-02-16", memorial: "2026-05-25",
      juneteenth: "2026-06-19", independence: "2026-07-04", labor: "2026-09-07", columbus: "2026-10-12",
      veterans: "2026-11-11", thanksgiving: "2026-11-26", christmas: "2026-12-25",
    });
    expect(dayName(h.thanksgiving)).toBe("Thu");
    expect(dayName(h.christmas)).toBe("Fri");
    expect(dayName(h.independence)).toBe("Sat");
  });

  it("computes the 2027 dates and weekdays the report checked", () => {
    const h = federalHolidays(2027);
    expect(h).toEqual({
      newYear: "2027-01-01", mlk: "2027-01-18", presidents: "2027-02-15", memorial: "2027-05-31",
      juneteenth: "2027-06-19", independence: "2027-07-04", labor: "2027-09-06", columbus: "2027-10-11",
      veterans: "2027-11-11", thanksgiving: "2027-11-25", christmas: "2027-12-25",
    });
    expect(dayName(h.newYear)).toBe("Fri");
    expect(dayName(h.juneteenth)).toBe("Sat");
    expect(dayName(h.independence)).toBe("Sun");
    expect(dayName(h.christmas)).toBe("Sat");
  });

  it("puts Monday holidays on Mondays and Thanksgiving on a Thursday, every year", () => {
    for (let year = 2024; year <= 2032; year++) {
      const h = federalHolidays(year);
      for (const monday of [h.mlk, h.presidents, h.memorial, h.labor, h.columbus]) expect(dayName(monday)).toBe("Mon");
      expect(dayName(h.thanksgiving)).toBe("Thu");
      // Memorial Day is the LAST Monday of May.
      expect(addDays(h.memorial, 7) > `${year}-05-31`).toBe(true);
    }
  });

  it("agrees with the hand-entered USPS calendar, apart from the one observed date", () => {
    const differences: string[] = [];
    for (const year of [2026, 2027]) {
      for (const [name, date] of Object.entries(federalHolidays(year))) {
        if (CARRIER_CALENDAR.usps[date]?.status !== "closed") differences.push(`${year} ${name} ${date}`);
      }
    }
    // July 4, 2027 is a Sunday: USPS closes Monday July 5 instead (the reference prints the same line).
    expect(differences).toEqual(["2027 independence 2027-07-04"]);
    expect(CARRIER_CALENDAR.usps["2027-07-05"]?.status).toBe("closed");
    expect(Object.keys(CARRIER_CALENDAR.usps)).toHaveLength(22);
  });
});

describe("carrier calendars", () => {
  it("every special day behaves as its status says", () => {
    for (const carrier of CALENDAR_CARRIERS) {
      for (const [date, day] of Object.entries(CARRIER_CALENDAR[carrier])) {
        const ground = GROUND[carrier];
        const air = AIR[carrier];
        const worksThatWeekday = (carrier === "usps" ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]).includes(weekday(date));
        const label = `${carrier} ${date} ${day.status}`;
        if (!worksThatWeekday || day.status === "closed") {
          expect(isDeliveryDay(ground, date), label).toBe(false);
          expect(isShipDay(ground, date), label).toBe(false);
          expect(isDeliveryDay(air, date), label).toBe(false);
          expect(isShipDay(air, date), label).toBe(false);
        } else if (day.status === "no_pickup" || day.status === "modified") {
          expect(isDeliveryDay(ground, date), label).toBe(true);
          expect(isShipDay(ground, date), label).toBe(false);
          expect(isDeliveryDay(air, date), label).toBe(true);
          expect(isShipDay(air, date), label).toBe(false);
        } else {
          // air_only: air and express move, ground does not.
          expect(isDeliveryDay(ground, date), label).toBe(false);
          expect(isShipDay(ground, date), label).toBe(false);
          expect(isDeliveryDay(air, date), label).toBe(true);
          expect(isShipDay(air, date), label).toBe(true);
        }
      }
    }
  });

  it("matches the report's table for the rest of 2026 and New Year", () => {
    // [date, service, delivers, safe to ship]
    const rows: [string, ServiceKey, boolean, boolean][] = [
      // Wed Nov 25: USPS and UPS normal, FedEx modified.
      ["2026-11-25", "usps_ground_advantage", true, true],
      ["2026-11-25", "ups_ground", true, true],
      ["2026-11-25", "fedex_ground", true, false],
      // Thu Nov 26, Thanksgiving: everyone closed.
      ["2026-11-26", "usps_ground_advantage", false, false],
      ["2026-11-26", "ups_ground", false, false],
      ["2026-11-26", "ups_next_day_air", false, false],
      ["2026-11-26", "fedex_overnight", false, false],
      // Fri Nov 27: USPS and UPS normal, FedEx modified.
      ["2026-11-27", "usps_priority_mail", true, true],
      ["2026-11-27", "ups_ground", true, true],
      ["2026-11-27", "fedex_ground", true, false],
      // Thu Dec 24: USPS normal; UPS delivers but does not pick up; FedEx modified.
      ["2026-12-24", "usps_ground_advantage", true, true],
      ["2026-12-24", "ups_ground", true, false],
      ["2026-12-24", "ups_next_day_air", true, false],
      ["2026-12-24", "fedex_ground", true, false],
      // Fri Dec 25: everyone closed.
      ["2026-12-25", "usps_priority_mail_express", false, false],
      ["2026-12-25", "ups_ground", false, false],
      ["2026-12-25", "fedex_overnight", false, false],
      // Thu Dec 31: USPS normal; UPS air only; FedEx modified.
      ["2026-12-31", "usps_ground_advantage", true, true],
      ["2026-12-31", "ups_ground", false, false],
      ["2026-12-31", "ups_2nd_day_air", true, true],
      ["2026-12-31", "ups_worldwide_expedited", false, false],
      ["2026-12-31", "fedex_ground", true, false],
      // Fri Jan 1, 2027: everyone closed.
      ["2027-01-01", "usps_ground_advantage", false, false],
      ["2027-01-01", "ups_next_day_air", false, false],
      ["2027-01-01", "fedex_ground", false, false],
      // Sat Jan 2 and Sun Jan 3, across the year boundary.
      ["2027-01-02", "usps_ground_advantage", true, true],
      ["2027-01-02", "ups_ground", false, false],
      ["2027-01-03", "usps_ground_advantage", false, false],
      ["2027-01-04", "ups_ground", true, true],
      ["2027-01-04", "fedex_ground", true, true],
    ];
    for (const [date, service, delivers, ships] of rows) {
      expect(isDeliveryDay(service, date), `${service} delivers ${date}`).toBe(delivers);
      expect(isShipDay(service, date), `${service} ships ${date}`).toBe(ships);
    }
  });

  it("matches the report's full-year table where carriers differ", () => {
    // MLK Day: USPS and UPS closed, FedEx modified.
    expect(isDeliveryDay("ups_ground", "2026-01-19")).toBe(false);
    expect(isDeliveryDay("fedex_ground", "2026-01-19")).toBe(true);
    expect(isShipDay("fedex_ground", "2026-01-19")).toBe(false);
    expect(isDeliveryDay("ups_ground", "2027-01-18")).toBe(false);
    // Presidents' Day, Columbus Day and Veterans Day: USPS closed, UPS open, FedEx modified.
    for (const date of ["2026-02-16", "2026-10-12", "2026-11-11", "2027-02-15", "2027-10-11", "2027-11-11"]) {
      expect(isDeliveryDay("usps_priority_mail", date), date).toBe(false);
      expect(isShipDay("ups_ground", date), date).toBe(true);
      expect(isDeliveryDay("fedex_ground", date), date).toBe(true);
      expect(isShipDay("fedex_ground", date), date).toBe(false);
    }
    // Juneteenth: USPS closed, UPS and FedEx open. In 2027 it is a Saturday; USPS is open Friday June 18.
    expect(isDeliveryDay("usps_ground_advantage", "2026-06-19")).toBe(false);
    expect(isShipDay("ups_ground", "2026-06-19")).toBe(true);
    expect(isShipDay("fedex_ground", "2026-06-19")).toBe(true);
    expect(isDeliveryDay("usps_ground_advantage", "2027-06-19")).toBe(false);
    expect(isDeliveryDay("usps_ground_advantage", "2027-06-18")).toBe(true);
    // Independence Day 2026 is a Saturday: USPS closed that Saturday; Friday July 3 UPS open, FedEx modified.
    expect(isDeliveryDay("usps_ground_advantage", "2026-07-04")).toBe(false);
    expect(isShipDay("ups_ground", "2026-07-03")).toBe(true);
    expect(isShipDay("fedex_ground", "2026-07-03")).toBe(false);
    expect(isDeliveryDay("fedex_ground", "2026-07-03")).toBe(true);
    // Independence Day 2027 is a Sunday: USPS and UPS close Monday July 5, FedEx is modified.
    expect(isDeliveryDay("usps_priority_mail", "2027-07-05")).toBe(false);
    expect(isDeliveryDay("usps_priority_mail", "2027-07-03")).toBe(true);
    expect(isDeliveryDay("ups_ground", "2027-07-05")).toBe(false);
    expect(isDeliveryDay("fedex_ground", "2027-07-05")).toBe(true);
    expect(isShipDay("fedex_ground", "2027-07-05")).toBe(false);
    // Memorial Day, Labor Day and Thanksgiving: everyone closed, both years.
    for (const date of ["2026-05-25", "2026-09-07", "2026-11-26", "2027-05-31", "2027-09-06", "2027-11-25"]) {
      for (const service of ["usps_ground_advantage", "ups_ground", "fedex_ground"] as const) {
        expect(isDeliveryDay(service, date), `${service} ${date}`).toBe(false);
      }
    }
    // Christmas 2027 is a Saturday: USPS closed that Saturday and open Friday December 24.
    expect(isDeliveryDay("usps_ground_advantage", "2027-12-25")).toBe(false);
    expect(isShipDay("usps_ground_advantage", "2027-12-24")).toBe(true);
    expect(isShipDay("ups_ground", "2027-12-24")).toBe(false);
    expect(isDeliveryDay("ups_ground", "2027-12-24")).toBe(true);
  });

  it("USPS works Saturdays, nobody works Sundays", () => {
    expect(dayName("2026-12-12")).toBe("Sat");
    expect(isDeliveryDay("usps_ground_advantage", "2026-12-12")).toBe(true);
    expect(isShipDay("usps_priority_mail", "2026-12-12")).toBe(true);
    for (const service of ["ups_ground", "fedex_home_delivery", "dhl_express_worldwide", "lugless_ground"] as const) {
      expect(isDeliveryDay(service, "2026-12-12"), service).toBe(false);
    }
    for (const service of SERVICE_KEYS) {
      expect(isDeliveryDay(service, "2026-12-13"), service).toBe(false);
      expect(isShipDay(service, "2026-12-13"), service).toBe(false);
    }
  });

  it("names the day", () => {
    expect(carrierDay("ups_ground", "2026-12-24")).toEqual({ status: "no_pickup", name: "Christmas Eve" });
    expect(carrierDay("fedex_ground", "2026-11-27")).toEqual({ status: "modified", name: "the day after Thanksgiving" });
    expect(carrierDay("usps_priority_mail", "2027-07-05")).toEqual({ status: "closed", name: "the Independence Day holiday" });
    expect(carrierDay("ups_ground", "2026-12-23")).toBeNull();
  });

  it("marks exactly the unpublished 2027 dates as projected", () => {
    for (const carrier of CALENDAR_CARRIERS) {
      for (const [date, day] of Object.entries(CARRIER_CALENDAR[carrier])) {
        const shouldBeProjected = carrier !== "usps" && date > "2027-01-01";
        expect(day.projected === true, `${carrier} ${date}`).toBe(shouldBeProjected);
      }
    }
    expect(CALENDAR_PUBLISHED_THROUGH).toEqual({ usps: "2027-12-31", ups: "2027-01-01", fedex: "2027-01-02" });
  });

  it("says how far each calendar can be trusted", () => {
    expect(calendarConfidence("ups_ground", "2027-01-01")).toBe("published");
    expect(calendarConfidence("ups_ground", "2027-01-04")).toBe("projected");
    expect(calendarConfidence("fedex_ground", "2027-01-02")).toBe("published");
    expect(calendarConfidence("fedex_ground", "2027-03-12")).toBe("projected");
    expect(calendarConfidence("usps_priority_mail", "2027-12-31")).toBe("published");
    expect(calendarConfidence("usps_priority_mail", "2028-01-03")).toBe("unknown");
    expect(calendarConfidence("ups_ground", "2028-01-03")).toBe("unknown");
    expect(calendarConfidence("dhl_express_worldwide", "2026-12-28")).toBe("published");
    expect(calendarConfidence("dhl_express_worldwide", "2027-02-01")).toBe("projected");
  });

  it("gives DHL and the luggage services the days both UPS and FedEx close", () => {
    for (const service of ["dhl_express_worldwide", "lugless_ground", "luggage_forward_domestic", "luggage_free_intl"] as const) {
      // Closed: New Year's Day, Memorial Day, Labor Day, Thanksgiving, Christmas Day.
      for (const date of ["2026-11-26", "2026-12-25", "2027-01-01", "2027-05-31", "2027-09-06", "2027-11-25"]) {
        expect(isDeliveryDay(service, date), `${service} ${date}`).toBe(false);
      }
      // Open: days only one of them closes or limits.
      for (const date of ["2027-01-18", "2026-11-27", "2026-12-24", "2027-02-15"]) {
        expect(isShipDay(service, date), `${service} ${date}`).toBe(true);
      }
    }
  });
});

describe("stepping through delivery days", () => {
  it("steps back over a weekend and a holiday", () => {
    // Mon Dec 28, 2026 back one UPS day: Sat, Sun and Christmas Day are skipped.
    expect(subtractTransitDays("ups_ground", "2026-12-28", 1)).toBe("2026-12-24");
    // USPS counts the Saturday.
    expect(subtractTransitDays("usps_ground_advantage", "2026-12-28", 1)).toBe("2026-12-26");
    expect(subtractTransitDays("usps_ground_advantage", "2026-12-28", 2)).toBe("2026-12-24");
    expect(subtractTransitDays("ups_ground", "2026-12-21", 7)).toBe("2026-12-10");
    expect(subtractTransitDays("ups_ground", "2026-12-21", 0)).toBe("2026-12-21");
  });

  it("steps across the year boundary", () => {
    // UPS Ground: Dec 31 is air only and Jan 1 is closed, so Mon Jan 4 back one is Wed Dec 30.
    expect(subtractTransitDays("ups_ground", "2027-01-04", 1)).toBe("2026-12-30");
    // UPS air still moves on Dec 31.
    expect(subtractTransitDays("ups_2nd_day_air", "2027-01-04", 1)).toBe("2026-12-31");
    expect(subtractTransitDays("fedex_ground", "2027-01-04", 1)).toBe("2026-12-31");
    expect(subtractTransitDays("usps_priority_mail", "2027-01-04", 1)).toBe("2027-01-02");
    expect(addTransitDays("ups_ground", "2026-12-30", 1)).toBe("2027-01-04");
    expect(addTransitDays("usps_priority_mail", "2026-12-31", 2)).toBe("2027-01-04");
  });

  it("finds the nearest delivery and ship days", () => {
    expect(previousDeliveryDay("ups_ground", "2026-12-25")).toBe("2026-12-24");
    expect(previousDeliveryDay("ups_ground", "2026-12-23")).toBe("2026-12-23");
    expect(nextDeliveryDay("ups_ground", "2026-12-19")).toBe("2026-12-21");
    expect(nextDeliveryDay("usps_ground_advantage", "2026-12-19")).toBe("2026-12-19");
    expect(nextDeliveryDay("ups_ground", "2026-12-31")).toBe("2027-01-04");
    // UPS will not pick up on Christmas Eve; FedEx is on modified service Nov 25 to 27.
    expect(previousShipDay("ups_ground", "2026-12-24")).toBe("2026-12-23");
    expect(previousShipDay("fedex_ground", "2026-11-27")).toBe("2026-11-24");
    expect(nextShipDay("fedex_ground", "2026-11-25")).toBe("2026-11-30");
    expect(nextShipDay("ups_ground", "2026-12-24")).toBe("2026-12-28");
  });

  it("refuses a count that is not a whole number", () => {
    expect(() => subtractTransitDays("ups_ground", "2026-12-21", 1.5)).toThrow(RangeError);
    expect(() => subtractTransitDays("ups_ground", "2026-12-21", -1)).toThrow(RangeError);
    expect(() => addTransitDays("ups_ground", "2026-12-21", -1)).toThrow(RangeError);
    expect(() => isDeliveryDay("ups_ground", "soon")).toThrow(RangeError);
  });

  it("lists the closed days a count stepped over", () => {
    expect(closedDaysBetween("ups_ground", "2026-12-22", "2027-01-05")).toEqual([
      { date: "2026-12-25", name: "Christmas Day", status: "closed" },
      { date: "2026-12-31", name: "New Year's Eve", status: "air_only" },
      { date: "2027-01-01", name: "New Year's Day", status: "closed" },
    ]);
    expect(closedDaysBetween("ups_2nd_day_air", "2026-12-28", "2027-01-05").map((d) => d.name)).toEqual(["New Year's Day"]);
    expect(closedDaysBetween("ups_ground", "2026-12-10", "2026-12-21")).toEqual([]);
    // The ends themselves are not counted.
    expect(closedDaysBetween("ups_ground", "2026-12-25", "2026-12-28")).toEqual([]);
  });
});

describe("peak season", () => {
  it("covers UPS's stated window, to the day", () => {
    expect(inPeakSeason("2026-11-15")).toBe(false);
    expect(inPeakSeason("2026-11-16")).toBe(true);
    expect(inPeakSeason("2026-12-25")).toBe(true);
    expect(inPeakSeason("2027-01-08")).toBe(true);
    expect(inPeakSeason("2027-01-09")).toBe(false);
    expect(inPeakSeason("2027-07-04")).toBe(false);
    expect(inPeakSeason("2027-11-15")).toBe(true);
    expect(inPeakSeason("2028-01-07")).toBe(true);
    expect(inPeakSeason("2028-01-08")).toBe(false);
    expect(PEAK_WINDOWS[1].projected).toBe(true);
  });
});

describe("zones and the transit table", () => {
  it("turns miles into zones the way the reference does", () => {
    expect([40, 151, 300, 601, 1400, 1801, 2500].map(zoneFromMiles)).toEqual([2, 3, 3, 5, 6, 8, 8]);
    expect([150, 600, 1000, 1001, 1800].map(zoneFromMiles)).toEqual([2, 4, 5, 6, 7]);
  });

  it("has the reference's ground days per zone", () => {
    const pairs = (table: typeof GROUND_DAYS_BY_ZONE) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((z) => [table[z].best, table[z].plan]);
    expect(pairs(GROUND_DAYS_BY_ZONE)).toEqual([[1, 1], [1, 1], [1, 2], [2, 3], [2, 3], [3, 4], [4, 5], [4, 5], [5, 7]]);
    expect(pairs(USPS_GROUND_ADVANTAGE_DAYS_BY_ZONE)).toEqual([[2, 2], [2, 2], [2, 3], [2, 3], [3, 4], [3, 4], [4, 5], [4, 5], [5, 8]]);
  });

  it("has the reference's fixed transit days", () => {
    const fixed = Object.fromEntries(
      SERVICE_KEYS.flatMap((key) => {
        const transit = SERVICES[key].transit;
        return transit.kind === "fixed" ? [[key, [transit.days.best, transit.days.plan]]] : [];
      }),
    );
    expect(fixed).toMatchObject({
      ups_3_day_select: [3, 3], fedex_express_saver: [3, 3], usps_priority_mail: [2, 3],
      ups_2nd_day_air: [2, 2], fedex_2day: [2, 2], ups_next_day_air: [1, 1], fedex_overnight: [1, 1],
      usps_priority_mail_express: [1, 3], fedex_intl_priority_express: [1, 3], ups_worldwide_express: [1, 3],
      dhl_express_worldwide: [1, 3], fedex_intl_economy: [2, 5], ups_worldwide_expedited: [2, 5],
      ups_standard_canada_mexico: [2, 7], usps_priority_mail_express_intl: [3, 5], usps_priority_mail_intl: [6, 10],
      // Luggage services: the report's planning numbers (section 1.3).
      lugless_ground: [2, 6], lugless_express: [1, 3], luggage_forward_domestic: [1, 5],
      luggage_forward_intl_standard: [7, 11], luggage_forward_intl_express: [4, 9],
      luggage_free_domestic: [1, 5], luggage_free_intl: [1, 7],
    });
    const priority = SERVICES.usps_priority_mail.transit;
    expect(priority.kind === "fixed" && priority.offshoreDays).toEqual({ best: 3, plan: 5 });
  });

  it("flags air, international and customs padding exactly as the reference's patterns do", () => {
    // The reference derives these from the key with regular expressions; the port stores them.
    const referenceAir = (key: string) =>
      /overnight|next_day|2day|2nd_day|3day|3_day|express|priority_mail/.test(key) && !/ground/.test(key);
    const referenceInternational = (key: string) => /intl|worldwide|canada_mexico/.test(key);
    const referenceCustoms = (key: string) =>
      referenceInternational(key) ? (/economy|expedited|standard|priority_mail_intl/.test(key) ? 2 : 1) : 0;
    // The 20 services of the reference table; the luggage services were added here and are not in it.
    const referenceKeys = SERVICE_KEYS.filter((key) => !/^lug/.test(key));
    expect(referenceKeys).toHaveLength(20);
    for (const key of referenceKeys) {
      expect(SERVICES[key].air, `${key} air`).toBe(referenceAir(key));
      expect(SERVICES[key].international, `${key} international`).toBe(referenceInternational(key));
      expect(SERVICES[key].customsPadDays, `${key} customs`).toBe(referenceCustoms(key));
    }
  });

  it("recognises service keys", () => {
    expect(isServiceKey("ups_ground")).toBe(true);
    expect(isServiceKey("ups_teleport")).toBe(false);
    expect(isServiceKey("toString")).toBe(false);
    expect(isServiceKey(undefined)).toBe(false);
    for (const key of SERVICE_KEYS) expect(key.length).toBeLessThanOrEqual(60); // fits details.serviceKey
  });

  it("has the reference's buffer and hold window for every destination", () => {
    const pairs = Object.fromEntries(Object.entries(DESTINATION_POLICIES).map(([k, p]) => [k, [p.bufferDays, p.holdDays]]));
    expect(pairs).toEqual({
      hotel: [2, 3], resort: [2, 5], conference_venue: [2, 3], relative_home: [3, 21], vacation_rental: [0, 0],
      cruise_precruise_hotel: [2, 3], ups_access_point: [1, 5], fedex_hold_at_location: [1, 4],
      usps_general_delivery: [2, 21], amazon_locker: [0, 1], amazon_counter: [1, 5],
    });
    expect(DESTINATION_POLICIES.vacation_rental.afterArrival).toBe(true);
  });

  it("has the carriers' published last days to ship for Christmas 2026", () => {
    const last = (service: ServiceKey, laneDays?: number) =>
      PUBLISHED_LAST_SHIP_DATES.find((row) => row.service === service && row.laneDays === laneDays)?.lastShip;
    expect(last("usps_ground_advantage")).toBe("2026-12-17");
    expect(last("usps_priority_mail")).toBe("2026-12-18");
    expect(last("usps_priority_mail_express")).toBe("2026-12-19");
    expect(last("ups_3_day_select")).toBe("2026-12-21");
    expect(last("ups_2nd_day_air")).toBe("2026-12-22");
    expect(last("ups_next_day_air")).toBe("2026-12-23");
    expect([5, 4, 3, 2, 1].map((lane) => last("fedex_ground", lane))).toEqual([
      "2026-12-17", "2026-12-18", "2026-12-21", "2026-12-22", "2026-12-23",
    ]);
    // Every published date is a day that carrier really accepts parcels.
    for (const row of PUBLISHED_LAST_SHIP_DATES) expect(isShipDay(row.service, row.lastShip), `${row.service} ${row.lastShip}`).toBe(true);
  });
});
