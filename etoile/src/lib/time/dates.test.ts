import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addDays,
  businessDaysBetween,
  compareDates,
  daysUntil,
  diffDays,
  formatDate,
  formatDateRange,
  isBusinessDay,
  isLocalDate,
  isWeekend,
  localDateOf,
  nextBusinessDay,
  nightsBetween,
  parseLocalDate,
  previousBusinessDay,
  toLocalDate,
  weekday,
} from "./dates";
import { EN_DASH } from "./symbols";

describe("local dates", () => {
  it("validates the shape and the calendar", () => {
    expect(isLocalDate("2026-12-19")).toBe(true);
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("2026-13-01")).toBe(false);
    expect(isLocalDate("2026-12-32")).toBe(false);
    expect(isLocalDate("2026-1-5")).toBe(false);
    expect(isLocalDate("12/19/2026")).toBe(false);
    expect(isLocalDate("2026-12-19T00:00:00Z")).toBe(false);
    expect(isLocalDate(null)).toBe(false);
    expect(parseLocalDate("2026-12-19")).toEqual({ year: 2026, month: 12, day: 19 });
    expect(toLocalDate(2026, 3, 8)).toBe("2026-03-08");
    expect(() => toLocalDate(2026, 2, 30)).toThrow(RangeError);
    expect(() => parseLocalDate("soon")).toThrow(RangeError);
  });

  it("adds and subtracts days across months, years and leap days", () => {
    expect(addDays("2026-12-19", 7)).toBe("2026-12-26");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-19", 0)).toBe("2026-12-19");
    expect(() => addDays("2026-12-19", 1.5)).toThrow(RangeError);
  });

  it("is not thrown off by daylight-saving days, which are 23 or 25 hours long", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(diffDays("2026-03-07", "2026-03-09")).toBe(2);
    expect(diffDays("2026-10-31", "2026-11-02")).toBe(2);
  });

  it("counts days between dates", () => {
    expect(diffDays("2026-12-19", "2026-12-26")).toBe(7);
    expect(diffDays("2026-12-26", "2026-12-19")).toBe(-7);
    expect(diffDays("2026-11-26", "2026-12-19")).toBe(23);
    expect(diffDays("2026-12-31", "2027-01-01")).toBe(1);
    expect(nightsBetween("2026-12-19", "2026-12-27")).toBe(8);
    expect(nightsBetween("2026-12-27", "2026-12-19")).toBe(0);
    expect(compareDates("2026-12-19", "2026-12-20")).toBe(-1);
    expect(compareDates("2026-12-19", "2026-12-19")).toBe(0);
    expect(["2027-01-02", "2026-12-19", "2026-12-31"].sort(compareDates)).toEqual(["2026-12-19", "2026-12-31", "2027-01-02"]);
  });

  it("knows the weekday", () => {
    expect(weekday("2026-12-19")).toBe(6); // Saturday
    expect(weekday("2026-12-25")).toBe(5); // Friday
    expect(isWeekend("2026-12-19")).toBe(true);
    expect(isWeekend("2026-12-20")).toBe(true);
    expect(isWeekend("2026-12-21")).toBe(false);
  });

  it("finds today's date in a zone, which depends on the zone", () => {
    const now = "2026-12-20T03:30:00Z";
    expect(localDateOf(now, "America/Chicago")).toBe("2026-12-19");
    expect(localDateOf(now, "Europe/London")).toBe("2026-12-20");
    expect(localDateOf(now, "Asia/Tokyo")).toBe("2026-12-20");
    expect(localDateOf("2026-12-19T10:30:00Z", "Pacific/Kiritimati")).toBe("2026-12-20");
    expect(localDateOf("2026-12-19T10:30:00Z", "Pacific/Pago_Pago")).toBe("2026-12-18");
    expect(daysUntil("2026-12-19", "America/Chicago", "2026-11-26T18:00:00Z")).toBe(23);
    expect(daysUntil("2026-12-19", "America/Chicago", now)).toBe(0);
    expect(daysUntil("2026-12-19", "Asia/Tokyo", now)).toBe(-1);
  });
});

describe("business days", () => {
  const christmas = new Set(["2026-12-25", "2027-01-01"]);

  it("skips weekends", () => {
    expect(addBusinessDays("2026-12-18", 1)).toBe("2026-12-21"); // Fri -> Mon
    expect(addBusinessDays("2026-12-21", 5)).toBe("2026-12-28");
    expect(addBusinessDays("2026-12-21", -1)).toBe("2026-12-18"); // Mon -> Fri
    expect(addBusinessDays("2026-12-21", -5)).toBe("2026-12-14");
    expect(addBusinessDays("2026-12-19", 1)).toBe("2026-12-21"); // from a Saturday
    expect(addBusinessDays("2026-12-19", -1)).toBe("2026-12-18");
    expect(addBusinessDays("2026-12-19", 0)).toBe("2026-12-19");
  });

  it("skips holidays given as a set or a function", () => {
    expect(addBusinessDays("2026-12-24", 1, christmas)).toBe("2026-12-28"); // Thu -> Mon, over Christmas Friday
    expect(addBusinessDays("2026-12-28", -1, christmas)).toBe("2026-12-24");
    expect(addBusinessDays("2026-12-24", 1, (d) => d === "2026-12-25")).toBe("2026-12-28");
    expect(isBusinessDay("2026-12-25", christmas)).toBe(false);
    expect(isBusinessDay("2026-12-25")).toBe(true);
    expect(isBusinessDay("2026-12-26")).toBe(false);
  });

  it("counts business days between two dates", () => {
    expect(businessDaysBetween("2026-12-18", "2026-12-21")).toBe(1);
    expect(businessDaysBetween("2026-12-14", "2026-12-21")).toBe(5);
    expect(businessDaysBetween("2026-12-21", "2026-12-14")).toBe(-5);
    expect(businessDaysBetween("2026-12-19", "2026-12-20")).toBe(0);
    expect(businessDaysBetween("2026-12-21", "2026-12-21")).toBe(0);
    expect(businessDaysBetween("2026-12-21", "2026-12-28", christmas)).toBe(4);
  });

  it("is consistent: adding the count between two business days lands on the second", () => {
    const from = "2026-12-01";
    for (let i = 0; i < 60; i++) {
      const to = addDays(from, i);
      if (!isBusinessDay(to, christmas)) continue;
      expect(addBusinessDays(from, businessDaysBetween(from, to, christmas), christmas)).toBe(to);
    }
  });

  it("rolls to the next or previous business day", () => {
    expect(nextBusinessDay("2026-12-19")).toBe("2026-12-21");
    expect(nextBusinessDay("2026-12-21")).toBe("2026-12-21");
    expect(nextBusinessDay("2026-12-25", christmas)).toBe("2026-12-28");
    expect(previousBusinessDay("2026-12-20")).toBe("2026-12-18");
    expect(previousBusinessDay("2026-12-25", christmas)).toBe("2026-12-24");
  });
});

describe("formatDate", () => {
  it("writes dates the same way everywhere", () => {
    expect(formatDate("2026-12-19")).toBe("Dec 19");
    expect(formatDate("2026-12-19", { weekday: true })).toBe("Sat, Dec 19");
    expect(formatDate("2026-12-19", { year: true })).toBe("Dec 19, 2026");
    expect(formatDate("2026-12-19", { weekday: "long", month: "long", year: true })).toBe("Saturday, December 19, 2026");
    expect(formatDate("2026-05-03", { month: "long" })).toBe("May 3");
  });
});

describe("formatDateRange", () => {
  it("uses an en dash, never a hyphen", () => {
    const text = formatDateRange("2026-12-19", "2026-12-26");
    expect(text).toBe(`Dec 19${EN_DASH}26`);
    expect(text).toBe("Dec 19–26");
    expect(text).not.toContain("-");
  });

  it("names both months when the range crosses a month", () => {
    expect(formatDateRange("2026-11-28", "2026-12-02")).toBe("Nov 28 – Dec 2");
  });

  it("shows both years when the range crosses a year", () => {
    expect(formatDateRange("2026-12-30", "2027-01-02")).toBe("Dec 30, 2026 – Jan 2, 2027");
    expect(formatDateRange("2026-12-30", "2027-01-02", { year: "never" })).toBe("Dec 30 – Jan 2");
  });

  it("collapses a single day", () => {
    expect(formatDateRange("2026-12-19", "2026-12-19")).toBe("Dec 19");
    expect(formatDateRange("2026-12-19")).toBe("Dec 19");
    expect(formatDateRange("2026-12-19", null, { year: "always", weekday: true })).toBe("Sat, Dec 19, 2026");
  });

  it("adds the year, weekdays or long months on request", () => {
    expect(formatDateRange("2026-12-19", "2026-12-26", { year: "always" })).toBe("Dec 19–26, 2026");
    expect(formatDateRange("2026-11-28", "2026-12-02", { year: "always" })).toBe("Nov 28 – Dec 2, 2026");
    expect(formatDateRange("2026-12-19", "2026-12-26", { weekday: true })).toBe("Sat, Dec 19 – Sat, Dec 26");
    expect(formatDateRange("2026-12-19", "2026-12-26", { month: "long" })).toBe("December 19–26");
  });

  it("swaps a backwards range", () => {
    expect(formatDateRange("2026-12-26", "2026-12-19")).toBe("Dec 19–26");
  });
});
