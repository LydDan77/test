import { Temporal } from "temporal-polyfill"; // dev-only oracle
import { describe, expect, it } from "vitest";
import {
  calendarDayDifference,
  formatLocalDateTime,
  isIanaTimeZone,
  isValidTimeZone,
  localTimeKind,
  offsetMinutes,
  parseLocalDateTime,
  toDate,
  utcToZoned,
  zoneCityName,
  zonedToUtc,
} from "./zoned";

const iso = (d: Date) => d.toISOString();

describe("isValidTimeZone", () => {
  it("accepts what Intl accepts and nothing else", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe("isIanaTimeZone", () => {
  it("accepts region/city ids and UTC, the forms fit to store", () => {
    for (const tz of ["America/Chicago", "America/Argentina/Buenos_Aires", "Asia/Kolkata", "Asia/Calcutta", "Europe/London", "Pacific/Port_Moresby", "America/Port-au-Prince", "Etc/GMT+5", "Etc/UTC", "UTC"]) {
      expect(isIanaTimeZone(tz), tz).toBe(true);
    }
  });

  it("refuses abbreviations and offsets, even though Intl accepts them", () => {
    // "EST" is a fixed UTC-5 with no daylight saving: a trap if stored with a place.
    for (const tz of ["EST", "PST", "MST", "CET", "GMT", "EST5EDT", "+05:30", "Eastern", "America/Nowhere", "America/", "/Chicago", "America/Chicago ", "", null, undefined, 5]) {
      expect(isIanaTimeZone(tz), String(tz)).toBe(false);
    }
  });
});

describe("utcToZoned", () => {
  it("gives the wall clock, date, weekday and offset", () => {
    const z = utcToZoned("2026-12-19T22:41:07Z", "America/Los_Angeles");
    expect(z).toMatchObject({
      year: 2026, month: 12, day: 19, hour: 14, minute: 41, second: 7,
      date: "2026-12-19", time: "14:41", weekday: 6, offsetMinutes: -480, tz: "America/Los_Angeles",
    });
  });

  it("handles half-hour and 45-minute zones", () => {
    expect(utcToZoned("2026-12-01T00:00:00Z", "Asia/Kolkata")).toMatchObject({ time: "05:30", offsetMinutes: 330 });
    expect(utcToZoned("2026-12-01T00:00:00Z", "Asia/Kathmandu")).toMatchObject({ time: "05:45", offsetMinutes: 345 });
    expect(utcToZoned("2026-01-01T00:00:00Z", "America/St_Johns")).toMatchObject({ date: "2025-12-31", time: "20:30", offsetMinutes: -210 });
    expect(utcToZoned("2026-12-01T14:30:00Z", "Australia/Lord_Howe")).toMatchObject({ date: "2026-12-02", time: "01:30", offsetMinutes: 660 });
    expect(utcToZoned("2026-07-01T00:00:00Z", "Pacific/Chatham")).toMatchObject({ time: "12:45", offsetMinutes: 765 });
  });

  it("prints midnight as 00:00, never 24:00", () => {
    expect(utcToZoned("2026-11-26T05:00:00Z", "America/New_York")).toMatchObject({ date: "2026-11-26", time: "00:00", hour: 0 });
  });

  it("sits on the right side of the date line", () => {
    const at = "2026-12-19T10:30:00Z";
    expect(utcToZoned(at, "Pacific/Kiritimati")).toMatchObject({ date: "2026-12-20", time: "00:30", offsetMinutes: 840 });
    expect(utcToZoned(at, "Pacific/Pago_Pago")).toMatchObject({ date: "2026-12-18", time: "23:30", offsetMinutes: -660 });
    expect(utcToZoned(at, "Pacific/Auckland").date).toBe("2026-12-19");
    expect(utcToZoned(at, "Pacific/Honolulu").date).toBe("2026-12-19");
  });

  it("accepts a Date, epoch milliseconds or an ISO string, and rejects junk", () => {
    const d = new Date("2026-06-01T12:00:00Z");
    expect(utcToZoned(d, "Europe/Paris").time).toBe("14:00");
    expect(utcToZoned(d.getTime(), "Europe/Paris").time).toBe("14:00");
    expect(utcToZoned("2026-06-01T12:00:00.000Z", "Europe/Paris").time).toBe("14:00");
    expect(() => utcToZoned("not a date", "Europe/Paris")).toThrow(RangeError);
    expect(() => toDate(Number.NaN)).toThrow(RangeError);
  });
});

describe("offsetMinutes", () => {
  it("follows daylight saving", () => {
    expect(offsetMinutes("2026-07-01T00:00:00Z", "Europe/London")).toBe(60);
    expect(offsetMinutes("2026-01-01T00:00:00Z", "Europe/London")).toBe(0);
    expect(offsetMinutes("2026-01-15T12:00:00Z", "America/Chicago")).toBe(-360);
    expect(offsetMinutes("2026-07-15T12:00:00Z", "America/Chicago")).toBe(-300);
    expect(offsetMinutes("2026-07-15T12:00:00Z", "America/Phoenix")).toBe(-420);
  });
});

describe("zonedToUtc", () => {
  it("converts ordinary readings, from objects or strings", () => {
    expect(iso(zonedToUtc({ year: 2026, month: 12, day: 1, hour: 9, minute: 30 }, "America/New_York"))).toBe("2026-12-01T14:30:00.000Z");
    expect(iso(zonedToUtc("2026-12-01T09:30", "Asia/Kathmandu"))).toBe("2026-12-01T03:45:00.000Z");
    expect(iso(zonedToUtc("2026-12-01 09:30:15", "Asia/Kolkata"))).toBe("2026-12-01T04:00:15.000Z");
    expect(iso(zonedToUtc("2026-12-20T00:30", "Pacific/Kiritimati"))).toBe("2026-12-19T10:30:00.000Z");
  });

  it("round-trips with utcToZoned", () => {
    for (const tz of ["America/Chicago", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Apia", "Europe/London"]) {
      const instant = new Date("2026-08-09T03:17:00Z");
      const z = utcToZoned(instant, tz);
      expect(iso(zonedToUtc(z, tz)), tz).toBe(iso(instant));
    }
  });

  it("spring forward: a reading in the gap moves the same distance past it (compatible)", () => {
    // 2026-03-08 02:30 does not exist in New York: becomes 03:30 EDT.
    expect(iso(zonedToUtc("2026-03-08T02:30", "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(localTimeKind("2026-03-08T02:30", "America/New_York")).toBe("gap");
    // The edges of the gap are ordinary.
    expect(iso(zonedToUtc("2026-03-08T01:59", "America/New_York"))).toBe("2026-03-08T06:59:00.000Z");
    expect(iso(zonedToUtc("2026-03-08T03:00", "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
    expect(localTimeKind("2026-03-08T03:00", "America/New_York")).toBe("valid");
    // Europe changes at 01:00 UTC: 02:30 in Paris on the last Sunday of March does not exist.
    expect(iso(zonedToUtc("2026-03-29T02:30", "Europe/Paris"))).toBe("2026-03-29T01:30:00.000Z");
  });

  it("fall back: a reading that happens twice resolves to the first one (compatible)", () => {
    // 2026-11-01 01:30 happens twice in New York: the first one is EDT.
    expect(iso(zonedToUtc("2026-11-01T01:30", "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    expect(localTimeKind("2026-11-01T01:30", "America/New_York")).toBe("ambiguous");
    expect(iso(zonedToUtc("2026-11-01T00:59", "America/New_York"))).toBe("2026-11-01T04:59:00.000Z");
    expect(iso(zonedToUtc("2026-11-01T02:00", "America/New_York"))).toBe("2026-11-01T07:00:00.000Z");
  });

  it("offers earlier, later and reject for the two awkward cases", () => {
    const overlap = "2026-11-01T01:30";
    expect(iso(zonedToUtc(overlap, "America/New_York", { disambiguation: "earlier" }))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(zonedToUtc(overlap, "America/New_York", { disambiguation: "later" }))).toBe("2026-11-01T06:30:00.000Z");
    expect(() => zonedToUtc(overlap, "America/New_York", { disambiguation: "reject" })).toThrow(/happens twice/);

    const gap = "2026-03-08T02:30";
    expect(iso(zonedToUtc(gap, "America/New_York", { disambiguation: "earlier" }))).toBe("2026-03-08T06:30:00.000Z"); // 01:30 EST
    expect(iso(zonedToUtc(gap, "America/New_York", { disambiguation: "later" }))).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(() => zonedToUtc(gap, "America/New_York", { disambiguation: "reject" })).toThrow(/does not exist/);
    // An ordinary reading is never rejected.
    expect(iso(zonedToUtc("2026-06-01T12:00", "America/New_York", { disambiguation: "reject" }))).toBe("2026-06-01T16:00:00.000Z");
  });

  it("handles Lord Howe's 30-minute shift and a zone with no daylight saving", () => {
    // Lord Howe goes forward 30 minutes at 02:00 on 2026-10-04: 02:15 does not exist.
    expect(localTimeKind("2026-10-04T02:15", "Australia/Lord_Howe")).toBe("gap");
    expect(iso(zonedToUtc("2026-10-04T02:15", "Australia/Lord_Howe"))).toBe("2026-10-03T15:45:00.000Z"); // 02:45 +11
    // and back 30 minutes at 02:00 on 2026-04-05: 01:45 happens twice.
    expect(localTimeKind("2026-04-05T01:45", "Australia/Lord_Howe")).toBe("ambiguous");
    expect(localTimeKind("2026-03-08T02:30", "America/Phoenix")).toBe("valid");
    expect(iso(zonedToUtc("2026-03-08T02:30", "America/Phoenix"))).toBe("2026-03-08T09:30:00.000Z");
  });

  it("skips a whole missing day (Samoa crossed the date line on 2011-12-30)", () => {
    expect(localTimeKind("2011-12-30T12:00", "Pacific/Apia")).toBe("gap");
    expect(utcToZoned(zonedToUtc("2011-12-30T12:00", "Pacific/Apia"), "Pacific/Apia").date).toBe("2011-12-31");
  });

  it("rejects readings that are not real", () => {
    expect(() => zonedToUtc("2026-02-30T10:00", "America/Chicago")).toThrow(RangeError);
    expect(() => zonedToUtc("2026-12-01T25:00", "America/Chicago")).toThrow(RangeError);
    expect(() => zonedToUtc({ year: 2026, month: 13, day: 1, hour: 0, minute: 0 }, "America/Chicago")).toThrow(RangeError);
    expect(() => zonedToUtc("tomorrow", "America/Chicago")).toThrow(RangeError);
    expect(() => zonedToUtc("2026-12-01T10:00", "Mars/Olympus")).toThrow(RangeError);
  });

  it("agrees with Temporal on 4000 random wall-clock readings across 40 zones", () => {
    const zones = [
      "America/New_York", "America/Los_Angeles", "America/Chicago", "America/Denver", "America/Phoenix", "America/Anchorage",
      "Pacific/Honolulu", "America/St_Johns", "America/Sao_Paulo", "America/Santiago", "America/Punta_Arenas", "America/Mexico_City",
      "America/Chihuahua", "America/Havana", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin",
      "Europe/Athens", "Europe/Istanbul", "Europe/Moscow", "Europe/Kyiv", "Africa/Cairo", "Africa/Casablanca", "Africa/Johannesburg",
      "Asia/Dubai", "Asia/Tehran", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo", "Asia/Jerusalem",
      "Australia/Sydney", "Australia/Adelaide", "Australia/Lord_Howe", "Pacific/Auckland", "Pacific/Chatham", "Pacific/Apia",
    ];
    let seed = 20261127;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    for (let i = 0; i < 4000; i++) {
      const zone = zones[rand(zones.length)];
      const local = { year: 2024 + rand(5), month: 1 + rand(12), day: 1 + rand(28), hour: rand(24), minute: rand(60), second: 0 };
      for (const disambiguation of ["compatible", "earlier", "later"] as const) {
        const expected = Temporal.PlainDateTime.from(local).toZonedDateTime(zone, { disambiguation }).epochMilliseconds;
        expect(zonedToUtc(local, zone, { disambiguation }).getTime(), `${JSON.stringify(local)} ${zone} ${disambiguation}`).toBe(expected);
      }
    }
  });

  it("agrees with Temporal on every minute of the 2026 transition nights", () => {
    const nights = [
      ["America/New_York", 2026, 3, 8], ["America/New_York", 2026, 11, 1],
      ["Europe/London", 2026, 3, 29], ["Europe/London", 2026, 10, 25],
      ["Australia/Lord_Howe", 2026, 4, 5], ["Australia/Lord_Howe", 2026, 10, 4],
      ["Australia/Sydney", 2026, 4, 5], ["Australia/Sydney", 2026, 10, 4],
      ["America/Santiago", 2026, 4, 4], ["America/Santiago", 2026, 9, 6],
      ["Pacific/Chatham", 2026, 4, 5], ["Pacific/Chatham", 2026, 9, 27],
    ] as const;
    for (const [zone, y, m, d] of nights) {
      for (let minute = 0; minute < 300; minute++) {
        const local = { year: y, month: m, day: d, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 };
        for (const disambiguation of ["compatible", "earlier", "later"] as const) {
          const expected = Temporal.PlainDateTime.from(local).toZonedDateTime(zone, { disambiguation }).epochMilliseconds;
          expect(zonedToUtc(local, zone, { disambiguation }).getTime(), `${JSON.stringify(local)} ${zone} ${disambiguation}`).toBe(expected);
        }
      }
    }
  });
});

describe("parseLocalDateTime and formatLocalDateTime", () => {
  it("parses datetime-local values and rejects impossible ones", () => {
    expect(parseLocalDateTime("2026-12-01T09:30")).toEqual({ year: 2026, month: 12, day: 1, hour: 9, minute: 30, second: 0 });
    expect(parseLocalDateTime("2026-12-01 09:30:45")).toMatchObject({ second: 45 });
    expect(parseLocalDateTime("2028-02-29T00:00")).not.toBeNull(); // leap year
    expect(parseLocalDateTime("2026-02-29T00:00")).toBeNull();
    expect(parseLocalDateTime("2026-02-30T10:00")).toBeNull();
    expect(parseLocalDateTime("2026-12-01T24:00")).toBeNull();
    expect(parseLocalDateTime("2026-12-01T09:60")).toBeNull();
    expect(parseLocalDateTime("2026-12-01")).toBeNull();
    expect(parseLocalDateTime("2026-12-01T09:30Z")).toBeNull();
  });

  it("formats back to the same shape", () => {
    expect(formatLocalDateTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 5 })).toBe("2026-03-08T02:05");
    expect(formatLocalDateTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 5, second: 9 })).toBe("2026-03-08T02:05:09");
  });
});

describe("itinerary arithmetic", () => {
  it("measures a flight across the date line and marks the day change", () => {
    const depart = zonedToUtc("2026-12-03T22:15", "Australia/Sydney");
    const arrive = zonedToUtc("2026-12-03T17:05", "America/Los_Angeles");
    expect((arrive.getTime() - depart.getTime()) / 60_000).toBe(13 * 60 + 50); // lands "before" it left
    expect(calendarDayDifference(depart, "Australia/Sydney", arrive, "America/Los_Angeles")).toBe(0);

    const redEyeOut = zonedToUtc("2026-12-19T22:40", "America/Los_Angeles");
    const redEyeIn = zonedToUtc("2026-12-20T06:35", "America/New_York");
    expect(calendarDayDifference(redEyeOut, "America/Los_Angeles", redEyeIn, "America/New_York")).toBe(1);

    const westOut = zonedToUtc("2026-12-19T11:00", "America/Los_Angeles");
    const westIn = zonedToUtc("2026-12-20T17:15", "Asia/Tokyo");
    expect(calendarDayDifference(westOut, "America/Los_Angeles", westIn, "Asia/Tokyo")).toBe(1);
  });
});

describe("zoneCityName", () => {
  it("makes a readable name from a zone id", () => {
    expect(zoneCityName("America/Los_Angeles")).toBe("Los Angeles");
    expect(zoneCityName("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneCityName("Asia/Calcutta")).toBe("Kolkata");
    expect(zoneCityName("Europe/Kiev")).toBe("Kyiv");
    expect(zoneCityName("America/Chicago")).toBe("Chicago");
    expect(zoneCityName("UTC")).toBe("UTC");
  });
});
