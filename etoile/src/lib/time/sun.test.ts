import { describe, expect, it } from "vitest";
import { formatClock } from "./clock";
import { addDays } from "./dates";
import { sunTimes } from "./sun";
import { utcToZoned, zonedToUtc } from "./zoned";

// An independent implementation: the equations of NOAA's solar calculator spreadsheet
// (gml.noaa.gov/grad/solcalc), evaluated for the instant of local noon. Used only as an oracle.
// Like the library it takes the sun's position at noon for the whole day, so it cannot see the
// error that shortcut makes near the poles; `followTheSun` below can.
function noaa(lat: number, lon: number, date: string, tz: string) {
  const rad = Math.PI / 180;
  const noon = zonedToUtc(`${date}T12:00`, tz);
  const jd = noon.getTime() / 86_400_000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (((280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * rad) * 0.000289;
  const appLong = l0 + c - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * rad);
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * t) * rad);
  const decl = Math.asin(Math.sin(obliq * rad) * Math.sin(appLong * rad));
  const y = Math.tan((obliq / 2) * rad) ** 2;
  const eqTime =
    (4 / rad) *
    (y * Math.sin(2 * l0 * rad) -
      2 * e * Math.sin(m * rad) +
      4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad) -
      0.5 * y * y * Math.sin(4 * l0 * rad) -
      1.25 * e * e * Math.sin(2 * m * rad));
  const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
  // Minutes after 00:00 UTC of the UTC day that contains local noon.
  const utcMidnight = Math.floor(noon.getTime() / 86_400_000) * 86_400_000;
  let noonMinutes = 720 - 4 * lon - eqTime;
  // Bring solar noon to within half a day of local noon.
  const noonOffset = (noon.getTime() - utcMidnight) / 60_000;
  while (noonMinutes - noonOffset > 720) noonMinutes -= 1440;
  while (noonMinutes - noonOffset < -720) noonMinutes += 1440;
  if (cosHa > 1 || cosHa < -1) return { polar: cosHa > 1 ? "night" : "day", noon: utcMidnight + noonMinutes * 60_000 } as const;
  const ha = Math.acos(cosHa) / rad;
  return {
    polar: null,
    sunrise: utcMidnight + (noonMinutes - 4 * ha) * 60_000,
    sunset: utcMidnight + (noonMinutes + 4 * ha) * 60_000,
    noon: utcMidnight + noonMinutes * 60_000,
  } as const;
}

// A second, slower reference with no shortcut: the sun's height above the horizon from NOAA's
// equations at each minute of the day, and the minutes at which it crosses the horizon.
function sunHeight(lat: number, lon: number, ms: number): number {
  const rad = Math.PI / 180;
  const t = (ms / 86_400_000 + 2440587.5 - 2451545) / 36525;
  const l0 = (((280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * rad) * 0.000289;
  const appLong = l0 + c - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * rad);
  const obliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * rad);
  const decl = Math.asin(Math.sin(obliq * rad) * Math.sin(appLong * rad));
  const y = Math.tan((obliq / 2) * rad) ** 2;
  const eqTime =
    (4 / rad) *
    (y * Math.sin(2 * l0 * rad) -
      2 * e * Math.sin(m * rad) +
      4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad) -
      0.5 * y * y * Math.sin(4 * l0 * rad) -
      1.25 * e * e * Math.sin(2 * m * rad));
  const minutesUtc = (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
  const hourAngle = ((((minutesUtc + eqTime + 4 * lon) % 1440) + 1440) % 1440) / 4 - 180;
  return Math.asin(Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle * rad)) / rad;
}

/** Sunrise before and sunset after `noonMs`, found by following the sun through the 24 hours around it. */
function followTheSun(lat: number, lon: number, noonMs: number) {
  const HORIZON = -0.833;
  const MINUTE = 60_000;
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let minutesUp = 0;
  let before = sunHeight(lat, lon, noonMs - 720 * MINUTE);
  for (let i = -719; i <= 720; i++) {
    const ms = noonMs + i * MINUTE;
    const height = sunHeight(lat, lon, ms);
    if (height > HORIZON) minutesUp++;
    const crossedAt = ms - (MINUTE * (height - HORIZON)) / (height - before);
    if (before <= HORIZON && height > HORIZON && i <= 0 && sunrise === null) sunrise = crossedAt;
    if (before > HORIZON && height <= HORIZON && i > 0 && sunset === null) sunset = crossedAt;
    before = height;
  }
  if (sunrise === null || sunset === null) return { kind: minutesUp > 720 ? "polar_day" : "polar_night" } as const;
  return { kind: "normal", sunrise, sunset } as const;
}

/** Every day of 2026 at one place: the largest error on ordinary days, and the days the two disagree on what kind of day it is. */
function yearAgainstTheSun(lat: number, lon: number, tz: string) {
  let worstMinutes = 0;
  const disagreements: string[] = [];
  for (let i = 0; i < 365; i++) {
    const date = addDays("2026-01-01", i);
    const mine = sunTimes(lat, lon, date, tz);
    const ref = followTheSun(lat, lon, mine.solarNoon.getTime());
    if (mine.kind !== ref.kind) disagreements.push(date);
    else if (ref.kind === "normal") {
      worstMinutes = Math.max(worstMinutes, minutesApart(mine.sunrise!, ref.sunrise), minutesApart(mine.sunset!, ref.sunset));
    }
  }
  return { worstMinutes, disagreements };
}

const minutesApart = (a: Date, b: number) => Math.abs(a.getTime() - b) / 60_000;
const clock = (d: Date | null, tz: string) => (d ? formatClock(d, tz).h24.colon : null);

const PLACES = [
  { name: "Minneapolis", lat: 44.98, lon: -93.27, tz: "America/Chicago" },
  { name: "Orlando", lat: 28.54, lon: -81.38, tz: "America/New_York" },
  { name: "Seattle", lat: 47.61, lon: -122.33, tz: "America/Los_Angeles" },
  { name: "London", lat: 51.51, lon: -0.13, tz: "Europe/London" },
  { name: "Quito", lat: -0.18, lon: -78.47, tz: "America/Guayaquil" },
  { name: "Sydney", lat: -33.87, lon: 151.21, tz: "Australia/Sydney" },
  { name: "Tokyo", lat: 35.68, lon: 139.69, tz: "Asia/Tokyo" },
  { name: "Mumbai", lat: 19.08, lon: 72.88, tz: "Asia/Kolkata" },
  { name: "Kashgar", lat: 39.47, lon: 75.99, tz: "Asia/Shanghai" }, // clock runs ~3 h ahead of the sun
  { name: "Kiritimati", lat: 1.87, lon: -157.43, tz: "Pacific/Kiritimati" }, // UTC+14 at a UTC-10.5 longitude
  { name: "Apia", lat: -13.83, lon: -171.77, tz: "Pacific/Apia" },
  { name: "Anchorage", lat: 61.22, lon: -149.9, tz: "America/Anchorage" },
  { name: "Ushuaia", lat: -54.8, lon: -68.3, tz: "America/Argentina/Ushuaia" },
];

describe("sunTimes", () => {
  it("matches well-known sunrise and sunset times to within a few minutes", () => {
    // Winter solstice in Minneapolis: about 7:48 AM and 4:34 PM CST.
    const msp = sunTimes(44.98, -93.27, "2026-12-21", "America/Chicago");
    expect(msp.kind).toBe("normal");
    expect(minutesApart(msp.sunrise!, zonedToUtc("2026-12-21T07:48", "America/Chicago").getTime())).toBeLessThan(4);
    expect(minutesApart(msp.sunset!, zonedToUtc("2026-12-21T16:34", "America/Chicago").getTime())).toBeLessThan(4);

    // Summer solstice in London: about 4:43 AM and 9:21 PM BST.
    const lon = sunTimes(51.51, -0.13, "2026-06-21", "Europe/London");
    expect(minutesApart(lon.sunrise!, zonedToUtc("2026-06-21T04:43", "Europe/London").getTime())).toBeLessThan(4);
    expect(minutesApart(lon.sunset!, zonedToUtc("2026-06-21T21:21", "Europe/London").getTime())).toBeLessThan(4);

    // Orlando in mid-December: sunset about 5:31 PM EST (the product spec's own example).
    const mco = sunTimes(28.54, -81.38, "2026-12-19", "America/New_York");
    expect(minutesApart(mco.sunset!, zonedToUtc("2026-12-19T17:32", "America/New_York").getTime())).toBeLessThan(4);
    expect(minutesApart(mco.sunrise!, zonedToUtc("2026-12-19T07:13", "America/New_York").getTime())).toBeLessThan(4);
  });

  it("agrees with NOAA's noon-based calculator within two minutes, all year, at thirteen places up to 61 degrees", () => {
    // Both sides take the sun's position at noon for the whole day, so this checks the arithmetic
    // and which solar day belongs to which date. It says nothing about higher latitudes: the
    // two tests after this one do.
    let checked = 0;
    for (const place of PLACES) {
      for (let i = 0; i < 366; i += 3) {
        const date = addDays("2026-01-01", i);
        const mine = sunTimes(place.lat, place.lon, date, place.tz);
        const ref = noaa(place.lat, place.lon, date, place.tz);
        const label = `${place.name} ${date}`;
        expect(ref.polar, label).toBeNull();
        if (ref.polar !== null) continue;
        expect(mine.kind, label).toBe("normal");
        expect(minutesApart(mine.sunrise!, ref.sunrise), `${label} sunrise`).toBeLessThan(2);
        expect(minutesApart(mine.sunset!, ref.sunset), `${label} sunset`).toBeLessThan(2);
        expect(minutesApart(mine.solarNoon, ref.noon), `${label} noon`).toBeLessThan(2);
        checked++;
      }
    }
    expect(checked).toBe(PLACES.length * 122);
  });

  it("stays within four minutes of the sun itself up to 62 degrees, every day of the year", () => {
    const places = [
      { name: "Quito", lat: -0.18, lon: -78.47, tz: "America/Guayaquil" },
      { name: "Orlando", lat: 28.54, lon: -81.38, tz: "America/New_York" },
      { name: "Minneapolis", lat: 44.98, lon: -93.27, tz: "America/Chicago" },
      { name: "London", lat: 51.51, lon: -0.13, tz: "Europe/London" },
      { name: "Ushuaia", lat: -54.8, lon: -68.3, tz: "America/Argentina/Ushuaia" },
      { name: "Anchorage", lat: 61.22, lon: -149.9, tz: "America/Anchorage" },
    ];
    for (const place of places) {
      const year = yearAgainstTheSun(place.lat, place.lon, place.tz);
      expect(year.disagreements, place.name).toEqual([]);
      expect(year.worstMinutes, place.name).toBeLessThan(4);
      expect(sunTimes(place.lat, place.lon, "2026-06-21", place.tz).approximate, place.name).toBe(false);
    }
  });

  it("is only approximate near the poles, and says so", () => {
    // Measured, not hoped for: around the start and end of the midnight sun and of the polar
    // night the noon shortcut is out by up to half an hour, and the first or last such day can
    // be a day off. The interface marks these places `approximate`.
    const places = [
      { name: "Rovaniemi", lat: 66.5, lon: 25.73, tz: "Europe/Helsinki" },
      { name: "Tromsø", lat: 69.65, lon: 18.96, tz: "Europe/Oslo" },
      { name: "Utqiagvik", lat: 71.29, lon: -156.79, tz: "America/Anchorage" },
      { name: "Longyearbyen", lat: 78.22, lon: 15.63, tz: "Arctic/Longyearbyen" },
      { name: "McMurdo", lat: -77.85, lon: 166.67, tz: "Antarctica/McMurdo" },
    ];
    let worstAnywhere = 0;
    for (const place of places) {
      const year = yearAgainstTheSun(place.lat, place.lon, place.tz);
      worstAnywhere = Math.max(worstAnywhere, year.worstMinutes);
      expect(year.worstMinutes, place.name).toBeLessThan(45);
      // At most a handful of days a year, each at the edge of a polar season, are called differently.
      expect(year.disagreements.length, `${place.name}: ${year.disagreements.join(", ")}`).toBeLessThanOrEqual(4);
      for (const date of ["2026-03-20", "2026-06-21", "2026-12-21"]) {
        expect(sunTimes(place.lat, place.lon, date, place.tz).approximate, `${place.name} ${date}`).toBe(true);
      }
    }
    // If this ever drops below ten minutes the caveat (and `approximate`) can go.
    expect(worstAnywhere).toBeGreaterThan(10);
    // Away from the polar seasons the same places are as good as anywhere: Tromsø at the equinox.
    const equinox = sunTimes(69.65, 18.96, "2026-03-20", "Europe/Oslo");
    const ref = followTheSun(69.65, 18.96, equinox.solarNoon.getTime());
    expect(ref.kind).toBe("normal");
    if (ref.kind === "normal") {
      expect(minutesApart(equinox.sunrise!, ref.sunrise)).toBeLessThan(6);
      expect(minutesApart(equinox.sunset!, ref.sunset)).toBeLessThan(6);
    }
  });

  it("returns the sunrise and sunset of the requested local date", () => {
    for (const place of PLACES) {
      for (const date of ["2026-03-20", "2026-06-21", "2026-09-22", "2026-12-21"]) {
        const sun = sunTimes(place.lat, place.lon, date, place.tz);
        expect(utcToZoned(sun.solarNoon, place.tz).date, `${place.name} ${date} noon`).toBe(date);
        expect(utcToZoned(sun.sunrise!, place.tz).date, `${place.name} ${date} sunrise`).toBe(date);
        expect(utcToZoned(sun.sunset!, place.tz).date, `${place.name} ${date} sunset`).toBe(date);
        expect(sun.sunrise!.getTime()).toBeLessThan(sun.solarNoon.getTime());
        expect(sun.solarNoon.getTime()).toBeLessThan(sun.sunset!.getTime());
      }
    }
  });

  it("gives about twelve hours of daylight at the equator and at an equinox", () => {
    expect(sunTimes(-0.18, -78.47, "2026-06-21", "America/Guayaquil").daylightMinutes).toBeGreaterThan(12 * 60);
    expect(sunTimes(-0.18, -78.47, "2026-06-21", "America/Guayaquil").daylightMinutes).toBeLessThan(12 * 60 + 15);
    const equinox = sunTimes(44.98, -93.27, "2026-03-20", "America/Chicago");
    expect(Math.abs(equinox.daylightMinutes - 12 * 60)).toBeLessThan(15);
  });

  it("has long days in a northern summer and short ones in winter, reversed in the south", () => {
    const tz = "America/Chicago";
    expect(sunTimes(44.98, -93.27, "2026-06-21", tz).daylightMinutes).toBeGreaterThan(15 * 60 + 30);
    expect(sunTimes(44.98, -93.27, "2026-12-21", tz).daylightMinutes).toBeLessThan(8 * 60 + 50);
    expect(sunTimes(-33.87, 151.21, "2026-12-21", "Australia/Sydney").daylightMinutes).toBeGreaterThan(14 * 60 + 20);
    expect(sunTimes(-33.87, 151.21, "2026-06-21", "Australia/Sydney").daylightMinutes).toBeLessThan(10 * 60);
  });

  it("reports polar night: no sunrise in Tromsø at the winter solstice", () => {
    const sun = sunTimes(69.65, 18.96, "2026-12-21", "Europe/Oslo");
    expect(sun).toMatchObject({ kind: "polar_night", sunrise: null, sunset: null, daylightMinutes: 0 });
    expect(utcToZoned(sun.solarNoon, "Europe/Oslo").date).toBe("2026-12-21");
    expect(sunTimes(78.22, 15.63, "2026-01-10", "Arctic/Longyearbyen").kind).toBe("polar_night");
  });

  it("reports polar day: no sunset in Tromsø at the summer solstice", () => {
    const sun = sunTimes(69.65, 18.96, "2026-06-21", "Europe/Oslo");
    expect(sun).toMatchObject({ kind: "polar_day", sunrise: null, sunset: null, daylightMinutes: 1440 });
    expect(sunTimes(78.22, 15.63, "2026-05-15", "Arctic/Longyearbyen").kind).toBe("polar_day");
  });

  it("mirrors the polar seasons in Antarctica and survives the poles themselves", () => {
    expect(sunTimes(-77.85, 166.67, "2026-12-21", "Antarctica/McMurdo").kind).toBe("polar_day");
    expect(sunTimes(-77.85, 166.67, "2026-06-21", "Antarctica/McMurdo").kind).toBe("polar_night");
    expect(sunTimes(90, 0, "2026-06-21", "UTC").kind).toBe("polar_day");
    expect(sunTimes(90, 0, "2026-12-21", "UTC").kind).toBe("polar_night");
    expect(sunTimes(-90, 0, "2026-12-21", "UTC").kind).toBe("polar_day");
    expect(sunTimes(-90, 0, "2026-06-21", "UTC").kind).toBe("polar_night");
  });

  it("returns to ordinary days between the polar seasons", () => {
    const sun = sunTimes(69.65, 18.96, "2026-03-20", "Europe/Oslo");
    expect(sun.kind).toBe("normal");
    expect(Math.abs(sun.daylightMinutes - 12 * 60)).toBeLessThan(30);
  });

  it("lets a far-north summer sunset fall after local midnight", () => {
    // Reykjavik on the solstice: the sun sets a little after midnight and is back before 3 AM.
    const sun = sunTimes(64.15, -21.94, "2026-06-21", "Atlantic/Reykjavik");
    expect(sun.kind).toBe("normal");
    expect(utcToZoned(sun.sunset!, "Atlantic/Reykjavik").date).toBe("2026-06-22");
    expect(clock(sun.sunrise, "Atlantic/Reykjavik")! < "03:10").toBe(true);
    expect(sun.daylightMinutes).toBeGreaterThan(20 * 60);
  });

  it("rejects bad input", () => {
    expect(() => sunTimes(91, 0, "2026-06-21", "UTC")).toThrow(RangeError);
    expect(() => sunTimes(0, 181, "2026-06-21", "UTC")).toThrow(RangeError);
    expect(() => sunTimes(0, 0, "2026-02-30", "UTC")).toThrow(RangeError);
    expect(() => sunTimes(0, 0, "2026-06-21", "Mars/Olympus")).toThrow(RangeError);
    expect(() => sunTimes(Number.NaN, 0, "2026-06-21", "UTC")).toThrow(RangeError);
  });
});
