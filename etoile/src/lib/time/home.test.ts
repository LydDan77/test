import { describe, expect, it } from "vitest";
import { dayDifferenceFromHome, dayRelation, offsetFromHome } from "./home";
import { MINUS } from "./symbols";

describe("offsetFromHome", () => {
  const winter = "2026-12-19T18:00:00Z";

  it("gives whole hours ahead and behind", () => {
    expect(offsetFromHome("America/New_York", "America/Los_Angeles", winter)).toEqual({ minutes: 180, label: "+3h" });
    expect(offsetFromHome("America/Los_Angeles", "America/New_York", winter)).toEqual({ minutes: -180, label: `${MINUS}3h` });
    expect(offsetFromHome("America/Chicago", "America/Chicago", winter)).toEqual({ minutes: 0, label: "+0h" });
    expect(offsetFromHome("Asia/Tokyo", "America/Chicago", winter).label).toBe("+15h");
  });

  it("is exact to the minute for half-hour and 45-minute zones", () => {
    expect(offsetFromHome("Asia/Kolkata", "Europe/London", winter)).toEqual({ minutes: 330, label: "+5h 30m" });
    expect(offsetFromHome("Asia/Kathmandu", "Europe/London", winter).label).toBe("+5h 45m");
    expect(offsetFromHome("America/St_Johns", "America/New_York", winter).label).toBe("+1h 30m");
    expect(offsetFromHome("America/New_York", "America/St_Johns", winter).label).toBe(`${MINUS}1h 30m`);
    expect(offsetFromHome("Asia/Kolkata", "America/Chicago", winter).label).toBe("+11h 30m");
  });

  it("depends on the date when the two places change clocks on different days", () => {
    // The US springs forward on 2026-03-08, Europe on 2026-03-29.
    expect(offsetFromHome("Europe/London", "America/New_York", "2026-03-01T12:00:00Z").label).toBe("+5h");
    expect(offsetFromHome("Europe/London", "America/New_York", "2026-03-15T12:00:00Z").label).toBe("+4h");
    expect(offsetFromHome("Europe/London", "America/New_York", "2026-04-01T12:00:00Z").label).toBe("+5h");
    // Sydney is on summer time when Chicago is on winter time.
    expect(offsetFromHome("Australia/Sydney", "America/Chicago", "2026-01-15T12:00:00Z").label).toBe("+17h");
    expect(offsetFromHome("Australia/Sydney", "America/Chicago", "2026-07-15T12:00:00Z").label).toBe("+15h");
  });
});

describe("dayRelation", () => {
  it("is nothing when the calendar day is the same", () => {
    expect(dayRelation("America/New_York", "America/Chicago", "2026-12-19T18:00:00Z")).toBeNull();
    expect(dayRelation("America/Chicago", "America/Chicago", "2026-12-19T18:00:00Z")).toBeNull();
  });

  it("says Tomorrow when it is already the next day there", () => {
    // 9 PM Saturday in Chicago is noon Sunday in Tokyo.
    expect(dayRelation("Asia/Tokyo", "America/Chicago", "2026-12-20T03:00:00Z")).toBe("Tomorrow");
    // 11:30 PM in Chicago is 12:30 AM in New York.
    expect(dayRelation("America/New_York", "America/Chicago", "2026-12-20T05:30:00Z")).toBe("Tomorrow");
  });

  it("says Yesterday when it is still the previous day there", () => {
    expect(dayRelation("America/Chicago", "Asia/Tokyo", "2026-12-20T03:00:00Z")).toBe("Yesterday");
    expect(dayRelation("Pacific/Honolulu", "Europe/London", "2026-12-20T03:00:00Z")).toBe("Yesterday");
  });

  it("handles the date line, where neighbours are a day apart all day", () => {
    const at = "2026-12-19T22:00:00Z";
    expect(dayRelation("Pacific/Kiritimati", "Pacific/Honolulu", at)).toBe("Tomorrow"); // same clock, next day
    expect(dayRelation("Pacific/Honolulu", "Pacific/Kiritimati", at)).toBe("Yesterday");
  });

  it("reports the rare two-day difference instead of a wrong word", () => {
    const at = "2026-12-19T10:30:00Z"; // 23:30 on the 18th in Pago Pago, 00:30 on the 20th in Kiritimati
    expect(dayDifferenceFromHome("Pacific/Kiritimati", "Pacific/Pago_Pago", at)).toBe(2);
    expect(dayRelation("Pacific/Kiritimati", "Pacific/Pago_Pago", at)).toBe("2 days ahead");
    expect(dayRelation("Pacific/Pago_Pago", "Pacific/Kiritimati", at)).toBe("2 days behind");
  });
});
