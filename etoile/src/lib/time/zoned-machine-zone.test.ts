import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatClock } from "./clock";
import { daysUntil, localDateOf } from "./dates";
import { sunTimes } from "./sun";
import { offsetMinutes, toEpochMs, utcToZoned, zonedToUtc } from "./zoned";

// The rest of the suite runs wherever it is run, usually on a machine set to UTC, where a bug
// that leans on the machine's own zone cannot show. This file moves the machine to Chicago
// first. Node re-reads TZ when it is assigned (in the main thread of a process, which is where
// Vitest's default "forks" pool runs a test file); the first test proves that it took.

const saved = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
});

describe("with the machine's own zone set to Chicago", () => {
  it("really is running six hours behind UTC", () => {
    expect(new Date(2026, 11, 19, 12, 0).getTimezoneOffset()).toBe(360);
    // This is the trap: JavaScript reads a string with no zone in the machine's zone.
    expect(new Date("2026-12-19T08:10").toISOString()).toBe("2026-12-19T14:10:00.000Z");
  });

  it("refuses a string with no zone instead of reading it as Chicago time", () => {
    expect(() => toEpochMs("2026-12-19T08:10")).toThrow(RangeError);
    expect(() => utcToZoned("2026-12-19T08:10", "UTC")).toThrow(RangeError);
    expect(() => formatClock("2026-12-19T08:10", "UTC")).toThrow(RangeError);
    expect(() => localDateOf("12/19/2026", "UTC")).toThrow(RangeError);
    expect(() => daysUntil("2026-12-25", "UTC", "Dec 19, 2026 8:10 AM")).toThrow(RangeError);
  });

  it("gives the same answers as on a UTC machine", () => {
    expect(utcToZoned("2026-12-19T08:10:00Z", "UTC")).toMatchObject({ date: "2026-12-19", time: "08:10", offsetMinutes: 0 });
    expect(utcToZoned("2026-12-19T22:41:07Z", "America/Los_Angeles")).toMatchObject({ date: "2026-12-19", time: "14:41", weekday: 6, offsetMinutes: -480 });
    expect(utcToZoned("2026-12-19T08:10:00+05:30", "Asia/Kolkata").time).toBe("08:10");
    expect(offsetMinutes("2026-07-01T00:00:00Z", "Europe/London")).toBe(60);
    expect(zonedToUtc("2026-12-19T08:10", "Asia/Tokyo").toISOString()).toBe("2026-12-18T23:10:00.000Z");
    expect(zonedToUtc("2026-03-08T02:30", "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(formatClock("2026-12-19T22:41:00Z", "America/Los_Angeles", { context: "clock" })).toMatchObject({ primary: "2:41 PM", secondary: "1441 PST", date: "2026-12-19" });
    expect(localDateOf("2026-12-19T03:00:00Z", "America/Los_Angeles")).toBe("2026-12-18");
    expect(daysUntil("2026-12-25", "Pacific/Kiritimati", "2026-12-19T10:30:00Z")).toBe(5);
    const sun = sunTimes(44.98, -93.27, "2026-12-21", "America/Chicago");
    expect(utcToZoned(sun.sunrise!, "America/Chicago").time >= "07:44").toBe(true);
    expect(utcToZoned(sun.sunrise!, "America/Chicago").time <= "07:52").toBe(true);
  });
});
