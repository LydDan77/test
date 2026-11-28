import { describe, expect, it } from "vitest";
import { clockOptionsFor, formatClock, formatDuration, zoneAbbreviation } from "./clock";
import { MINUS } from "./symbols";

describe("formatClock", () => {
  it("returns the 12-hour parts, both military styles and the zone abbreviation", () => {
    const c = formatClock("2026-12-19T22:41:00Z", "America/Los_Angeles", { context: "clock" });
    expect(c.h12).toEqual({ hour: 2, minute: 41, period: "PM", time: "2:41", text: "2:41 PM" });
    expect(c.h24).toEqual({ hour: 14, minute: 41, compact: "1441", colon: "14:41" });
    expect(c.zone).toBe("PST");
    expect(c.date).toBe("2026-12-19");
    expect(c.offsetMinutes).toBe(-480);
    expect(c.primary).toBe("2:41 PM");
    expect(c.secondary).toBe("1441 PST");
    expect(c.military).toBe("1441 PST");
  });

  it("follows the user's time style and military style", () => {
    const at = "2026-12-19T22:41:00Z";
    const tz = "America/New_York";
    const context = "clock";
    expect(formatClock(at, tz, { context, style: "12h_with_24h", militaryStyle: "14:41" })).toMatchObject({ primary: "5:41 PM", secondary: "17:41 EST" });
    expect(formatClock(at, tz, { context, style: "12h" })).toMatchObject({ primary: "5:41 PM", secondary: null, military: "1741 EST" });
    expect(formatClock(at, tz, { context, style: "24h" })).toMatchObject({ primary: "1741", secondary: null });
    expect(formatClock(at, tz, { context, style: "24h", militaryStyle: "14:41" })).toMatchObject({ primary: "17:41", secondary: null });
  });

  it("shows the 24-hour line on the world clock, and elsewhere only when the person asked for it", () => {
    const at = "2026-12-19T22:41:00Z";
    const tz = "America/Los_Angeles";
    // Product spec 3.4: always on for the world clock; a setting extends it to schedule rows and the arrivals board.
    expect(formatClock(at, tz).secondary).toBeNull(); // the default is "elsewhere", setting off
    expect(formatClock(at, tz, { context: "elsewhere" }).secondary).toBeNull();
    expect(formatClock(at, tz, { context: "elsewhere", show24hEverywhere: false }).secondary).toBeNull();
    expect(formatClock(at, tz, { context: "elsewhere", show24hEverywhere: true }).secondary).toBe("1441 PST");
    expect(formatClock(at, tz, { show24hEverywhere: true }).secondary).toBe("1441 PST");
    expect(formatClock(at, tz, { context: "clock" }).secondary).toBe("1441 PST");
    expect(formatClock(at, tz, { context: "clock", show24hEverywhere: false }).secondary).toBe("1441 PST");
    // The setting never adds a line to a style that has none.
    expect(formatClock(at, tz, { style: "12h", show24hEverywhere: true }).secondary).toBeNull();
    expect(formatClock(at, tz, { style: "24h", show24hEverywhere: true }).secondary).toBeNull();
    // Whatever is shown, the parts are all there.
    expect(formatClock(at, tz)).toMatchObject({ primary: "2:41 PM", military: "1441 PST", zone: "PST" });
  });

  it("builds its options from the signed-in person's settings", () => {
    const at = "2026-12-19T22:41:00Z";
    const tz = "America/Los_Angeles";
    const quiet = { timeStyle: "12h_with_24h", militaryStyle: "1441", show24hEverywhere: false } as const;
    const everywhere = { timeStyle: "12h_with_24h", militaryStyle: "14:41", show24hEverywhere: true } as const;
    expect(clockOptionsFor(quiet, "elsewhere")).toEqual({ style: "12h_with_24h", militaryStyle: "1441", show24hEverywhere: false, context: "elsewhere" });
    expect(formatClock(at, tz, clockOptionsFor(quiet, "elsewhere")).secondary).toBeNull();
    expect(formatClock(at, tz, clockOptionsFor(quiet, "clock")).secondary).toBe("1441 PST");
    expect(formatClock(at, tz, clockOptionsFor(everywhere, "elsewhere")).secondary).toBe("14:41 PST");
    expect(formatClock(at, tz, clockOptionsFor({ ...everywhere, timeStyle: "24h" }, "elsewhere"))).toMatchObject({ primary: "14:41", secondary: null });
    // A visitor with no account gets the defaults.
    expect(formatClock(at, tz, clockOptionsFor(null, "elsewhere")).secondary).toBeNull();
    expect(formatClock(at, tz, clockOptionsFor(undefined, "clock")).secondary).toBe("1441 PST");
  });

  it("writes midnight and noon the way clocks do", () => {
    const midnight = formatClock("2026-11-26T05:00:00Z", "America/New_York");
    expect(midnight.h12.text).toBe("12:00 AM");
    expect(midnight.h24.compact).toBe("0000");
    expect(midnight.h24.colon).toBe("00:00");
    const noon = formatClock("2026-11-26T17:00:00Z", "America/New_York");
    expect(noon.h12.text).toBe("12:00 PM");
    expect(noon.h24.compact).toBe("1200");
    expect(formatClock("2026-11-26T05:59:59Z", "America/New_York").h12.text).toBe("12:59 AM");
    expect(formatClock("2026-11-26T14:05:00Z", "America/New_York")).toMatchObject({ primary: "9:05 AM", military: "0905 EST" });
  });

  it("uses the daylight abbreviation in summer", () => {
    expect(formatClock("2026-07-04T19:00:00Z", "America/Chicago", { context: "clock" })).toMatchObject({ primary: "2:00 PM", secondary: "1400 CDT" });
    expect(formatClock("2026-01-04T20:00:00Z", "America/Chicago", { context: "clock" }).secondary).toBe("1400 CST");
  });

  it("handles half-hour zones and the far side of the date line", () => {
    const india = formatClock("2026-12-19T22:41:00Z", "Asia/Kolkata");
    expect(india).toMatchObject({ primary: "4:11 AM", military: "0411 IST", date: "2026-12-20", offsetMinutes: 330 });
    const nepal = formatClock("2026-12-19T22:41:00Z", "Asia/Kathmandu");
    expect(nepal.h24.colon).toBe("04:26");
    expect(nepal.zone).toBe("GMT+5:45");
    expect(formatClock("2026-12-19T10:30:00Z", "Pacific/Kiritimati")).toMatchObject({ date: "2026-12-20", primary: "12:30 AM" });
  });

  it("writes a UTC clock as 1441Z", () => {
    expect(formatClock("2026-12-19T14:41:00Z", "UTC", { context: "clock" })).toMatchObject({ zone: "UTC", military: "1441Z", secondary: "1441Z" });
    expect(formatClock("2026-12-19T14:41:00Z", "Etc/UTC", { militaryStyle: "14:41" }).military).toBe("14:41Z");
  });
});

describe("zoneAbbreviation", () => {
  const winter = "2026-01-15T12:00:00Z";
  const summer = "2026-07-15T12:00:00Z";

  it("knows the abbreviations people use", () => {
    expect([zoneAbbreviation(winter, "America/New_York"), zoneAbbreviation(summer, "America/New_York")]).toEqual(["EST", "EDT"]);
    expect([zoneAbbreviation(winter, "America/Denver"), zoneAbbreviation(summer, "America/Denver")]).toEqual(["MST", "MDT"]);
    expect([zoneAbbreviation(winter, "America/Phoenix"), zoneAbbreviation(summer, "America/Phoenix")]).toEqual(["MST", "MST"]);
    expect(zoneAbbreviation(winter, "America/Anchorage")).toBe("AKST");
    expect(zoneAbbreviation(winter, "Pacific/Honolulu")).toBe("HST");
    expect([zoneAbbreviation(winter, "Europe/London"), zoneAbbreviation(summer, "Europe/London")]).toEqual(["GMT", "BST"]);
    expect([zoneAbbreviation(winter, "Europe/Paris"), zoneAbbreviation(summer, "Europe/Paris")]).toEqual(["CET", "CEST"]);
    expect([zoneAbbreviation(winter, "Australia/Sydney"), zoneAbbreviation(summer, "Australia/Sydney")]).toEqual(["AEDT", "AEST"]);
    expect(zoneAbbreviation(winter, "Asia/Kolkata")).toBe("IST");
    expect(zoneAbbreviation(winter, "Asia/Tokyo")).toBe("JST");
    expect(zoneAbbreviation(winter, "Pacific/Auckland")).toBe("NZDT");
  });

  it("falls back to the offset, with a real minus sign, when a zone has no abbreviation", () => {
    expect(zoneAbbreviation(winter, "Asia/Bangkok")).toBe("GMT+7");
    expect(zoneAbbreviation(winter, "Asia/Kathmandu")).toBe("GMT+5:45");
    expect(zoneAbbreviation(winter, "America/Sao_Paulo")).toBe(`GMT${MINUS}3`);
    expect(zoneAbbreviation(winter, "UTC")).toBe("UTC");
  });

  it("changes at the transition instant", () => {
    // New York falls back at 06:00 UTC on 2026-11-01.
    expect(zoneAbbreviation("2026-11-01T05:59:59Z", "America/New_York")).toBe("EDT");
    expect(zoneAbbreviation("2026-11-01T06:00:00Z", "America/New_York")).toBe("EST");
  });
});

describe("formatDuration", () => {
  it("writes hours and minutes compactly", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(125)).toBe("2h 5m");
    expect(formatDuration(13 * 60 + 50)).toBe("13h 50m");
    expect(formatDuration(26 * 60)).toBe("1d 2h");
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-5)).toBe("0m");
  });
});
