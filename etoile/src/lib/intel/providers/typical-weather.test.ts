import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { peekCached } from "@/lib/cache";
import { addDays, diffDays } from "@/lib/time";
import { HTTP_DEFAULTS } from "../http";
import { fixture, html, json, stubFetch, type Scripted } from "./test-support";
import { getTypicalWeather, pastWindows, summariseYears } from "./typical-weather";

// The historical weather host answered "Daily API request limit exceeded" (HTTP 429) to every
// request from the machine this was built on, so there is NO real capture of a good answer.
//  - open-meteo-archive-error-daily-limit.json is the real 429 body.
//  - open-meteo-archive.reconstructed.json has the documented shape with invented values.
//  - The bodies built by archiveBody() below follow the same documented shape (the service
//    says the archive answers exactly like the forecast API), also with invented values.

let t: TestDb;
const original = { ...HTTP_DEFAULTS };
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.delete(schema.signalCache);
  HTTP_DEFAULTS.retryDelayMs = 0;
});
afterEach(() => {
  Object.assign(HTTP_DEFAULTS, original);
  vi.unstubAllGlobals();
});

const ORLANDO = { lat: 28.5384, lon: -81.3789, tz: "America/New_York" };
const CHRISTMAS = { startDate: "2027-12-19", endDate: "2027-12-27" };
const NOW = new Date("2026-11-27T12:00:00Z");
const DAILY_LIMIT = () => json(fixture("open-meteo-archive-error-daily-limit.json"), 429);

/** A metric archive answer for the dates in the request: 24° / 12° every day, rain on the 1st and 5th day. */
function archiveBody(url: URL, change?: (daily: { temperature_2m_max: (number | null)[]; temperature_2m_min: (number | null)[]; precipitation_sum: (number | null)[] }, year: number) => void): Scripted {
  const start = url.searchParams.get("start_date") ?? "";
  const end = url.searchParams.get("end_date") ?? "";
  const days = diffDays(start, end) + 1;
  const daily = {
    time: Array.from({ length: days }, (_, index) => addDays(start, index)),
    temperature_2m_max: Array.from({ length: days }, (): number | null => 24),
    temperature_2m_min: Array.from({ length: days }, (): number | null => 12),
    precipitation_sum: Array.from({ length: days }, (_, index): number | null => (index === 0 || index === 4 ? 5 : 0)),
  };
  change?.(daily, Number(start.slice(0, 4)));
  return json({
    latitude: 28.5,
    longitude: -81.4,
    timezone: "America/New_York",
    daily_units: { time: "iso8601", temperature_2m_max: "°C", temperature_2m_min: "°C", precipitation_sum: "mm" },
    daily,
  });
}

const yearOf = (url: URL) => Number((url.searchParams.get("start_date") ?? "").slice(0, 4));

describe("getTypicalWeather", () => {
  it("averages the same dates over the last ten years, one small request per year", async () => {
    const stub = stubFetch((url) =>
      archiveBody(url, (daily, year) => {
        if (year === 2020) daily.temperature_2m_max[3] = 30; // one hot afternoon
        if (year === 2018) daily.temperature_2m_min[6] = 2; // one cold night
      }),
    );
    const result = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
    expect(result).toEqual({
      ok: true,
      stale: false,
      fetchedAt: NOW,
      data: {
        startDate: "2027-12-19",
        endDate: "2027-12-27",
        days: 9,
        units: "imperial",
        high: 75.3, // mean of 89 days at 24 °C and one at 30 °C, in °F
        low: 53.4,
        warmestHigh: 86,
        coldestLow: 35.6,
        wetDayShare: 0.22, // 2 days in 9, every year
        typicalWetDays: 2,
        years: [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016],
      },
    });

    expect(stub.calls.map((call) => yearOf(call.url))).toEqual([2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016]);
    const { url } = stub.calls[0];
    expect(`${url.origin}${url.pathname}`).toBe("https://archive-api.open-meteo.com/v1/archive");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "28.54",
      longitude: "-81.38",
      start_date: "2025-12-19",
      end_date: "2025-12-27",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
      timezone: "America/New_York",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
    });
    // Open-Meteo's formula: weight = max(1, variables / 10 × max(1, days / 14)). One call each.
    expect(Math.max(1, (3 / 10) * Math.max(1, 9 / 14))).toBe(1);
  });

  it("keeps what it fetched for good: no second request, in either unit system", async () => {
    const stub = stubFetch((url) => archiveBody(url));
    await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
    expect(stub.calls).toHaveLength(10);

    // A month on, the newest finished window is still December 2025: nothing new to ask for.
    const aMonthOn = new Date("2026-12-28T12:00:00Z");
    const metric = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: aMonthOn });
    expect(stub.calls).toHaveLength(10);
    expect(metric).toMatchObject({ ok: true, stale: false, fetchedAt: NOW, data: { units: "metric", high: 24, low: 12, warmestHigh: 24, coldestLow: 12, typicalWetDays: 2 } });
  });

  it("a year later asks only for the one year that has been added", async () => {
    const stub = stubFetch((url) => archiveBody(url));
    await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
    stub.reset();
    const nextYear = new Date("2027-11-27T12:00:00Z");
    const result = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: nextYear });
    expect(stub.calls.map((call) => yearOf(call.url))).toEqual([2026]);
    expect(result).toMatchObject({ ok: true, fetchedAt: nextYear, data: { years: [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017] } });
  });

  it("reads the units the answer names: the reconstructed fixture is in °F and inches", async () => {
    stubFetch(() => json(fixture("open-meteo-archive.reconstructed.json")));
    const chicago = { lat: 41.8781, lon: -87.6298, tz: "America/Chicago" };
    const range = { startDate: "2027-12-20", endDate: "2027-12-26" };
    const imperial = await getTypicalWeather(chicago, range, { units: "imperial", now: NOW });
    // Highs 34.1 30.6 28.9 36.2 41.0 39.4 43.3; precipitation 0.071 in and 0.189 in are wet days, 0.012 in is not.
    expect(imperial).toMatchObject({ ok: true, data: { high: 36.2, low: 27.3, warmestHigh: 43.3, coldestLow: 18.4, wetDayShare: 0.29, typicalWetDays: 2, days: 7 } });
    const metric = await getTypicalWeather(chicago, range, { units: "metric", now: NOW });
    expect(metric).toMatchObject({ ok: true, data: { high: 2.3, low: -2.6 } });
  });

  describe("when the service says the daily allowance is used up (429)", () => {
    it("is 'not available right now': one request, no retry, nothing stored as data", async () => {
      const stub = stubFetch(DAILY_LIMIT);
      const result = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      expect(result).toMatchObject({ ok: false, reason: "rate_limited", lastGoodAt: null });
      if (!result.ok) expect(result.detail).toContain("Daily API request limit exceeded");
      expect(stub.calls).toHaveLength(1);

      const stored = await peekCached("v1:typical:28.54,-81.38:2025-12-19:8");
      expect(stored).toMatchObject({ data: null, ok: false });
      const rows = await t.db.select().from(schema.signalCache);
      expect(rows.filter((row) => row.key.startsWith("v1:typical:")).every((row) => row.payload === null)).toBe(true);
    });

    it("sends nothing more to the host for the rest of the UTC day, for any place", async () => {
      const stub = stubFetch(DAILY_LIMIT);
      await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      stub.reset();

      const lateEvening = new Date("2026-11-27T23:59:00Z");
      expect(await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: lateEvening })).toMatchObject({ ok: false, reason: "rate_limited" });
      const lisbon = { lat: 38.7251, lon: -9.1498, tz: "Europe/Lisbon" };
      expect(await getTypicalWeather(lisbon, { startDate: "2027-06-01", endDate: "2027-06-07" }, { units: "metric", now: lateEvening })).toMatchObject({ ok: false, reason: "rate_limited" });
      expect(stub.calls).toHaveLength(0);
    });

    it("asks again after midnight UTC, and succeeds once the service does", async () => {
      let limited = true;
      const stub = stubFetch((url) => (limited ? DAILY_LIMIT() : archiveBody(url)));
      await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      limited = false;
      stub.reset();
      const nextMorning = new Date("2026-11-28T00:06:00Z");
      expect(await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: nextMorning })).toMatchObject({ ok: true, fetchedAt: nextMorning });
      expect(stub.calls).toHaveLength(10);
    });

    it("keeps the years it got before the limit, answers from them if there are enough, and finishes later", async () => {
      let allowed = 4;
      const stub = stubFetch((url) => (allowed-- > 0 ? archiveBody(url) : DAILY_LIMIT()));
      const partial = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      expect(partial).toMatchObject({ ok: true, stale: false, data: { years: [2025, 2024, 2023, 2022], high: 75.2 } });
      expect(stub.calls).toHaveLength(5); // four good years, then the 429, then nothing

      stub.reset();
      expect(await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: new Date("2026-11-27T18:00:00Z") })).toMatchObject({ ok: true, data: { years: [2025, 2024, 2023, 2022] } });
      expect(stub.calls).toHaveLength(0);

      allowed = 100;
      const complete = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: new Date("2026-11-28T09:00:00Z") });
      expect(stub.calls.map((call) => yearOf(call.url))).toEqual([2021, 2020, 2019, 2018, 2017, 2016]);
      expect(complete.ok && complete.data.years).toHaveLength(10);
    });

    it("gives no answer from fewer than three years, but does not throw the two away", async () => {
      let allowed = 2;
      const stub = stubFetch((url) => (allowed-- > 0 ? archiveBody(url) : DAILY_LIMIT()));
      const result = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
      if (!result.ok) expect(result.detail).toContain("(2 of 10 years in hand)");
      expect(stub.calls).toHaveLength(3);

      stub.reset();
      allowed = 100;
      expect(await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: new Date("2026-11-28T09:00:00Z") })).toMatchObject({ ok: true });
      expect(stub.calls).toHaveLength(8);
    });
  });

  describe("when the service fails in other ways", () => {
    it.each([
      ["an HTML error page with status 200", () => html("<!DOCTYPE html><html><body>Error</body></html>"), 1],
      ["a 403 block page", () => html(fixture("npr-error-403.html"), 403), 1],
      ["a server error (tried twice, then left alone)", () => html("<html>502</html>", 502), 2],
      ["a dropped connection (tried twice, then left alone)", (): Scripted => "network-error", 2],
      ["broken JSON", () => json(`{"daily":`), 1],
      ["an answer with a missing column", () => json({ daily_units: {}, daily: { time: ["2025-12-19"], temperature_2m_max: [20] } }), 1],
    ])("%s ends the attempt at once and stores nothing", async (_label, respond, expectedCalls) => {
      const stub = stubFetch(respond);
      const result = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      expect(result).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: null });
      expect(stub.calls).toHaveLength(expectedCalls); // only the newest year was tried
      const rows = await t.db.select().from(schema.signalCache);
      expect(rows.every((row) => row.payload === null)).toBe(true);
    });

    it("a timeout ends the attempt after one request", async () => {
      HTTP_DEFAULTS.timeoutMs = 40;
      const stub = stubFetch(() => "hang");
      const result = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
      expect(stub.calls).toHaveLength(1);
    });

    it("does not ask a failing year again for ten minutes", async () => {
      const stub = stubFetch(() => html("<html>502</html>", 502));
      await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW });
      stub.reset();
      await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: new Date(NOW.getTime() + 9 * 60_000) });
      expect(stub.calls).toHaveLength(0);
      await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: new Date(NOW.getTime() + 11 * 60_000) });
      expect(stub.calls.length).toBeGreaterThan(0);
    });

    it("never keeps a year that came back with no numbers in it", async () => {
      const stub = stubFetch((url) =>
        archiveBody(url, (daily) => {
          daily.temperature_2m_max.fill(null);
          daily.temperature_2m_min.fill(null);
        }),
      );
      expect(await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "imperial", now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
      expect(stub.calls).toHaveLength(1);
      expect(await peekCached("v1:typical:28.54,-81.38:2025-12-19:8")).toMatchObject({ data: null });
    });

    it("recovers on a later call, keeping the years fetched before the failure", async () => {
      let failFrom = 6;
      const stub = stubFetch((url) => (failFrom-- > 0 ? archiveBody(url) : "network-error"));
      const first = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: NOW });
      expect(first.ok && first.data.years).toHaveLength(6);
      stub.reset();
      failFrom = 100;
      const second = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: new Date(NOW.getTime() + 60 * 60_000) });
      expect(second.ok && second.data.years).toHaveLength(10);
      expect(stub.calls).toHaveLength(4);
    });
  });

  it("can be asked to draw on fewer years, but never fewer than three or more than ten", async () => {
    const stub = stubFetch((url) => archiveBody(url));
    const three = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: NOW, years: 3 });
    expect(three).toMatchObject({ ok: true, data: { years: [2025, 2024, 2023] } });
    expect(stub.calls).toHaveLength(3);

    await t.db.delete(schema.signalCache);
    stub.reset();
    const one = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: NOW, years: 1 });
    expect(one.ok && one.data.years).toEqual([2025, 2024, 2023]);
    const many = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: NOW, years: 50 });
    expect(many.ok && many.data.years).toHaveLength(10);
    const odd = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: NOW, years: Number.NaN });
    expect(odd.ok && odd.data.years).toHaveLength(10);
    expect(stub.calls).toHaveLength(10); // the ten years, each asked for once across the three calls
  });

  it("skips days the archive has no figure for", async () => {
    stubFetch((url) =>
      archiveBody(url, (daily) => {
        daily.temperature_2m_max[0] = null;
        daily.precipitation_sum[0] = null; // was a wet day
      }),
    );
    const result = await getTypicalWeather(ORLANDO, CHRISTMAS, { units: "metric", now: NOW });
    expect(result).toMatchObject({ ok: true, data: { high: 24, wetDayShare: 0.13, typicalWetDays: 1 } }); // 1 wet day in the 8 with figures
  });

  it("shortens a long stay to its first 31 days and says so", async () => {
    const stub = stubFetch((url) => archiveBody(url));
    const result = await getTypicalWeather(ORLANDO, { startDate: "2027-06-01", endDate: "2027-08-31" }, { units: "metric", now: NOW });
    expect(result).toMatchObject({ ok: true, data: { startDate: "2027-06-01", endDate: "2027-07-01", days: 31 } });
    expect(stub.calls[0].url.searchParams.get("start_date")).toBe("2026-06-01");
    expect(stub.calls[0].url.searchParams.get("end_date")).toBe("2026-07-01");
  });

  it("handles a single day and a stay across New Year", async () => {
    const stub = stubFetch((url) => archiveBody(url));
    const oneDay = await getTypicalWeather(ORLANDO, { startDate: "2027-07-04", endDate: "2027-07-04" }, { units: "metric", now: NOW });
    expect(oneDay).toMatchObject({ ok: true, data: { days: 1, wetDayShare: 1, typicalWetDays: 1 } });

    stub.reset();
    await getTypicalWeather(ORLANDO, { startDate: "2027-12-28", endDate: "2028-01-03" }, { units: "metric", now: NOW });
    expect(stub.calls[0].url.searchParams.get("start_date")).toBe("2025-12-28");
    expect(stub.calls[0].url.searchParams.get("end_date")).toBe("2026-01-03");
  });

  it("refuses dates that are not a range and places without coordinates, without a request", async () => {
    const stub = stubFetch((url) => archiveBody(url));
    const options = { units: "imperial" as const, now: NOW };
    expect(await getTypicalWeather(ORLANDO, { startDate: "2027-12-27", endDate: "2027-12-19" }, options)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await getTypicalWeather(ORLANDO, { startDate: "2027-02-30", endDate: "2027-03-02" }, options)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await getTypicalWeather(ORLANDO, { startDate: "next week", endDate: "2027-03-02" }, options)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await getTypicalWeather({ tz: "America/New_York" }, CHRISTMAS, options)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("pastWindows", () => {
  it("uses the ten most recent years whose window has fully ended", () => {
    const windows = pastWindows("2027-12-19", 8, NOW);
    expect(windows).toHaveLength(10);
    expect(windows[0]).toEqual({ year: 2025, start: "2025-12-19", end: "2025-12-27" });
    expect(windows[9]).toEqual({ year: 2016, start: "2016-12-19", end: "2016-12-27" });
  });

  it("includes this year once the dates are safely in the past, and not before", () => {
    // The archive runs about five days behind: a window must have ended a week ago.
    expect(pastWindows("2027-11-10", 3, NOW)[0].year).toBe(2026); // Nov 10-13, 2026 ended two weeks ago
    expect(pastWindows("2027-11-18", 3, NOW)[0].year).toBe(2025); // Nov 18-21, 2026 ended six days ago
    expect(pastWindows("2027-11-17", 3, NOW)[0].year).toBe(2026); // ended exactly seven days ago
  });

  it("turns Feb 29 into Feb 28 in years without one", () => {
    const windows = pastWindows("2028-02-29", 2, NOW, 4);
    expect(windows.map((window) => window.start)).toEqual(["2026-02-28", "2025-02-28", "2024-02-29", "2023-02-28"]);
    expect(windows[2].end).toBe("2024-03-02");
  });

  it("lets a window run into the next year", () => {
    expect(pastWindows("2027-12-28", 6, NOW, 2)).toEqual([
      { year: 2025, start: "2025-12-28", end: "2026-01-03" },
      { year: 2024, start: "2024-12-28", end: "2025-01-03" },
    ]);
  });
});

describe("summariseYears", () => {
  const range = { startDate: "2027-03-01", endDate: "2027-03-04" };

  it("returns null when there are no temperatures to average", () => {
    expect(summariseYears([], range, "metric")).toBeNull();
    expect(summariseYears([{ year: 2025, highs: [null], lows: [null], precipitation: [null] }], range, "metric")).toBeNull();
  });

  it("counts a day as wet from 1 mm, and reports no rain as zero rather than failing", () => {
    const year = { year: 2025, highs: [10, 12, 14, 16], lows: [0, 2, 4, 6], precipitation: [0.9, 1, 12.5, 0] };
    expect(summariseYears([year], range, "metric")).toMatchObject({ high: 13, low: 3, warmestHigh: 16, coldestLow: 0, wetDayShare: 0.5, typicalWetDays: 2, days: 4, years: [2025] });
    expect(summariseYears([{ ...year, precipitation: [null, null, null, null] }], range, "metric")).toMatchObject({ wetDayShare: 0, typicalWetDays: 0 });
  });

  it("converts to Fahrenheit for imperial, including below zero", () => {
    const year = { year: 2025, highs: [-10, -20], lows: [-30, -40], precipitation: [0, 0] };
    expect(summariseYears([year], range, "imperial")).toMatchObject({ high: 5, low: -31, warmestHigh: 14, coldestLow: -40 });
  });
});
