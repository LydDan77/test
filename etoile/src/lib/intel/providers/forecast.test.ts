import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { peekCached } from "@/lib/cache";
import { HTTP_DEFAULTS } from "../http";
import { FORECAST_DAYS, forecastCoverage, forecastHorizon, getCurrentConditions, getForecast } from "./forecast";
import { fixture, html, json, stubFetch } from "./test-support";

// Fixtures: open-meteo-forecast.json is a real capture (Chicago, imperial units, fetched
// 2026-11-26T00:07Z, when it was still the 25th in Chicago). The error bodies are real too.
// Bodies written inline in this file follow the documented shape with invented values.

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
  vi.restoreAllMocks();
});

const CHICAGO = { lat: 41.8781, lon: -87.6298, tz: "America/Chicago" };
const CAPTURED_AT = new Date("2026-11-26T00:07:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const later = (ms: number) => new Date(CAPTURED_AT.getTime() + ms);
const realForecast = () => json(fixture("open-meteo-forecast.json"));

describe("getForecast", () => {
  it("returns sixteen local days from the real capture, in the person's units", async () => {
    stubFetch(realForecast);
    const result = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toMatchObject({ ok: true, stale: false, fetchedAt: CAPTURED_AT });
    if (!result.ok) return;
    const { data } = result;
    expect(data.tz).toBe("America/Chicago");
    expect(data.units).toBe("imperial");
    expect(data.days).toHaveLength(16);
    expect(data.days[0]).toEqual({
      date: "2026-11-25", // still the 25th in Chicago at 00:07 UTC on the 26th
      condition: { code: 3, label: "Cloudy", sky: "cloudy" },
      high: 41.5,
      low: 33.2,
      precipitationChance: 1,
      precipitation: 0,
      snowfall: 0,
      windGust: 26.6,
    });
    expect(data.days[1]).toMatchObject({ date: "2026-11-26", condition: { code: 55, label: "Heavy drizzle", sky: "drizzle" }, high: 44.8, precipitationChance: 89, precipitation: 0.134, windGust: 42.5 });
    expect(data.days[15].date).toBe("2026-12-10");
    expect(data.days.map((day) => day.condition.label)).not.toContain("Unknown");
  });

  it("asks for exactly what it needs, so the request costs one call", async () => {
    const stub = stubFetch(realForecast);
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(stub.calls).toHaveLength(1);
    const { url } = stub.calls[0];
    expect(`${url.origin}${url.pathname}`).toBe("https://api.open-meteo.com/v1/forecast");
    const params = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      latitude: "41.88",
      longitude: "-87.63",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,snowfall_sum,wind_gusts_10m_max",
      timezone: "America/Chicago",
      forecast_days: "16",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
    });
    // Open-Meteo's own formula: weight = max(1, variables / 10 × max(1, days / 14)).
    const variables = params.daily.split(",").length;
    expect(Math.max(1, (variables / 10) * Math.max(1, FORECAST_DAYS / 14))).toBe(1);
  });

  it("serves the stored copy for an hour, then asks again", async () => {
    const stub = stubFetch(realForecast);
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    const again = await getForecast(CHICAGO, { units: "imperial", now: later(59 * MINUTE) });
    expect(again).toMatchObject({ ok: true, stale: false, fetchedAt: CAPTURED_AT });
    expect(stub.calls).toHaveLength(1);

    const refreshed = await getForecast(CHICAGO, { units: "imperial", now: later(61 * MINUTE) });
    expect(refreshed).toMatchObject({ ok: true, stale: false, fetchedAt: later(61 * MINUTE) });
    expect(stub.calls).toHaveLength(2);
  });

  it("shares one copy between places a few hundred metres apart, and keeps units apart", async () => {
    const stub = stubFetch((url) =>
      url.searchParams.get("temperature_unit") === "celsius"
        ? json({
            daily_units: { time: "iso8601", temperature_2m_max: "°C", precipitation_sum: "mm", snowfall_sum: "cm", wind_gusts_10m_max: "km/h" },
            daily: {
              time: ["2026-11-25", "2026-11-26"],
              weather_code: [3, 71],
              temperature_2m_max: [5.3, 7.1],
              temperature_2m_min: [0.7, -4.2],
              precipitation_probability_max: [1, 89],
              precipitation_sum: [0, 3.4],
              snowfall_sum: [0, 2.8],
              wind_gusts_10m_max: [42.8, 68.4],
            },
          })
        : realForecast(),
    );
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    await getForecast({ lat: 41.8799, lon: -87.6312, tz: "America/Chicago" }, { units: "imperial", now: CAPTURED_AT });
    expect(stub.calls).toHaveLength(1);

    const metric = await getForecast(CHICAGO, { units: "metric", now: CAPTURED_AT });
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1].url.searchParams.get("wind_speed_unit")).toBe("kmh");
    expect(stub.calls[1].url.searchParams.get("precipitation_unit")).toBe("mm");
    expect(metric).toMatchObject({ ok: true, data: { units: "metric" } });
    if (metric.ok) expect(metric.data.days[1]).toMatchObject({ low: -4.2, snowfall: 2.8, condition: { label: "Light snow", sky: "snow" } });
  });

  it("falls back to the last good forecast when the source fails, and says it is stale", async () => {
    let healthy = true;
    const stub = stubFetch(() => (healthy ? realForecast() : html("<html><body>Bad Gateway</body></html>", 502)));
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });

    healthy = false;
    const result = await getForecast(CHICAGO, { units: "imperial", now: later(2 * HOUR) });
    expect(result).toMatchObject({ ok: true, stale: true, fetchedAt: CAPTURED_AT });
    if (result.ok) expect(result.data.days[0].high).toBe(41.5);
    expect(stub.calls).toHaveLength(3); // the good one, then two tries at the 502
  });

  it("starts at local today even when the stored copy was fetched yesterday", async () => {
    let healthy = true;
    stubFetch(() => (healthy ? realForecast() : "network-error"));
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    healthy = false;
    // 11 hours on it is 05:07 on the 26th in Chicago.
    const result = await getForecast(CHICAGO, { units: "imperial", now: later(11 * HOUR) });
    expect(result).toMatchObject({ ok: true, stale: true });
    if (result.ok) {
      expect(result.data.days[0].date).toBe("2026-11-26");
      expect(result.data.days).toHaveLength(15);
    }
  });

  it("stops offering a forecast that is more than twelve hours stale", async () => {
    let healthy = true;
    stubFetch(() => (healthy ? realForecast() : "network-error"));
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    healthy = false;
    expect(await getForecast(CHICAGO, { units: "imperial", now: later(12 * HOUR - MINUTE) })).toMatchObject({ ok: true, stale: true });
    const tooOld = await getForecast(CHICAGO, { units: "imperial", now: later(13 * HOUR) });
    expect(tooOld).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: CAPTURED_AT });
  });

  it("returns a failure, not a throw, when the source is down and nothing is stored", async () => {
    stubFetch(() => html(fixture("nws-error-no-user-agent.html"), 403));
    const result = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toEqual({ ok: false, reason: "unavailable", detail: "api.open-meteo.com/v1/forecast: HTTP 403", lastGoodAt: null });
  });

  it("treats an HTML page served with status 200 as an outage", async () => {
    stubFetch(() => html("<!DOCTYPE html><html><body>Maintenance</body></html>"));
    const result = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if (!result.ok) expect(result.detail).toContain("expected JSON");
  });

  it("passes on Open-Meteo's own reason for a refused request, and does not retry it", async () => {
    const stub = stubFetch(() => json(fixture("open-meteo-error-forecast-days.json"), 400));
    const result = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if (!result.ok) expect(result.detail).toContain("Forecast days is invalid. Allowed range 0 to 16. Given 17.");
    expect(stub.calls).toHaveLength(1);
  });

  it("times out without holding the page, and reports it", async () => {
    HTTP_DEFAULTS.timeoutMs = 40;
    const stub = stubFetch(() => "hang");
    const result = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if (!result.ok) expect(result.detail).toContain("no answer within 40 ms");
    expect(stub.calls).toHaveLength(1);
  });

  it.each([
    ["cut-off JSON", () => json(fixture("open-meteo-forecast.json").slice(0, 400))],
    ["an array (the multi-place form, which is never asked for)", () => json(fixture("open-meteo-forecast-multi-location.json"))],
    ["an error object with status 200", () => json({ error: true, reason: "Something" })],
    ["columns of different lengths", () => {
      const body = JSON.parse(fixture("open-meteo-forecast.json"));
      body.daily.temperature_2m_max.pop();
      return json(body);
    }],
    ["a date that is not a date", () => {
      const body = JSON.parse(fixture("open-meteo-forecast.json"));
      body.daily.time[3] = "2026-13-45";
      return json(body);
    }],
    ["no days at all", () => {
      const body = JSON.parse(fixture("open-meteo-forecast.json"));
      for (const key of Object.keys(body.daily)) body.daily[key] = [];
      return json(body);
    }],
  ])("treats %s as an outage and stores nothing", async (_label, respond) => {
    stubFetch(respond);
    const result = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: null });
    expect((await peekCached("v1:forecast:daily:41.88,-87.63:America/Chicago:imperial"))?.data ?? null).toBeNull();
  });

  it("refuses an answer in the wrong units rather than showing Fahrenheit as Celsius", async () => {
    stubFetch(realForecast); // the capture is in °F
    const result = await getForecast(CHICAGO, { units: "metric", now: CAPTURED_AT });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if (!result.ok) expect(result.detail).toContain("answered in °F");
  });

  it("keeps gaps as null and gives an unknown weather code a neutral label", async () => {
    stubFetch(() => {
      const body = JSON.parse(fixture("open-meteo-forecast.json"));
      body.daily.weather_code[0] = 42; // not in the table
      body.daily.weather_code[1] = null;
      body.daily.temperature_2m_max[0] = null;
      body.daily.precipitation_probability_max[0] = null;
      return json(body);
    });
    const result = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days[0]).toMatchObject({ condition: { code: 42, label: "Unknown", sky: "unknown" }, high: null, low: 33.2, precipitationChance: null });
    expect(result.data.days[1].condition.sky).toBe("unknown");
  });

  it("stands back after a 429 and sends nothing more until the pause is over", async () => {
    let limited = true;
    const stub = stubFetch(() => (limited ? json({ error: true, reason: "Hourly API request limit exceeded. Please try again in the next hour." }, 429) : realForecast()));
    const first = await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(first).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(stub.calls).toHaveLength(1); // a 429 is never retried

    // Another place, ten minutes later: the pause covers the whole service, so nothing is sent.
    const other = await getForecast({ lat: 38.7251, lon: -9.1498, tz: "Europe/Lisbon" }, { units: "metric", now: later(10 * MINUTE) });
    expect(other).toMatchObject({ ok: false, reason: "rate_limited" });
    if (!other.ok) expect(other.detail).toContain("nothing was sent");
    expect(stub.calls).toHaveLength(1);

    // The same place a minute later: still "rate limited", still nothing sent.
    expect(await getForecast(CHICAGO, { units: "imperial", now: later(MINUTE) })).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(await getCurrentConditions(CHICAGO, { units: "imperial", now: later(2 * MINUTE) })).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(stub.calls).toHaveLength(1);

    // After the hour it asks again.
    limited = false;
    expect(await getForecast(CHICAGO, { units: "imperial", now: later(61 * MINUTE) })).toMatchObject({ ok: true, stale: false });
    expect(stub.calls).toHaveLength(2);
  });

  it("keeps showing the last good forecast through a rate limit", async () => {
    let limited = false;
    stubFetch(() => (limited ? json(fixture("open-meteo-archive-error-daily-limit.json"), 429) : realForecast()));
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    limited = true;
    expect(await getForecast(CHICAGO, { units: "imperial", now: later(2 * HOUR) })).toMatchObject({ ok: true, stale: true, fetchedAt: CAPTURED_AT });
  });

  it("leaves a failing source alone for five minutes", async () => {
    const stub = stubFetch(() => html("<html>502</html>", 502));
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(stub.calls).toHaveLength(2);
    expect(await getForecast(CHICAGO, { units: "imperial", now: later(4 * MINUTE) })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(stub.calls).toHaveLength(2);
    await getForecast(CHICAGO, { units: "imperial", now: later(6 * MINUTE) });
    expect(stub.calls).toHaveLength(4);
  });

  it("says a place without coordinates or a real zone cannot be asked about, without a request", async () => {
    const stub = stubFetch(realForecast);
    for (const place of [
      { tz: "America/Chicago" },
      { lat: 41.9, tz: "America/Chicago" },
      { lat: 91, lon: 0, tz: "America/Chicago" },
      { lat: 0, lon: 181, tz: "America/Chicago" },
      { lat: Number.NaN, lon: 0, tz: "America/Chicago" },
      { lat: 41.9, lon: -87.6, tz: "Mars/Olympus_Mons" },
    ]) {
      expect(await getForecast(place, { units: "imperial", now: CAPTURED_AT })).toMatchObject({ ok: false, reason: "invalid_input" });
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("never throws, whatever the network does", async () => {
    vi.stubGlobal("fetch", () => {
      throw "a bare string";
    });
    expect(await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT })).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("getCurrentConditions", () => {
  it("reads the sky from the real capture", async () => {
    stubFetch(realForecast);
    const result = await getCurrentConditions(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toEqual({
      ok: true,
      stale: false,
      fetchedAt: CAPTURED_AT,
      data: {
        tz: "America/Chicago",
        units: "imperial",
        observedAt: "2026-11-26T00:00:00.000Z", // "2026-11-25T18:00" on Chicago's clocks
        condition: { code: 3, label: "Cloudy", sky: "cloudy" },
        isDay: false,
        temperature: 40.6,
        feelsLike: 29.6,
        cloudCover: null, // the capture did not ask for cloud cover
        precipitation: 0,
        windSpeed: 15.9,
      },
    });
  });

  it("asks for the seven things a sky needs, for one day, with instants as numbers", async () => {
    const stub = stubFetch(() =>
      json({
        timezone: "Europe/Lisbon",
        current_units: { time: "unixtime", temperature_2m: "°C", cloud_cover: "%" },
        current: { time: 1795651200, interval: 900, temperature_2m: 16.4, apparent_temperature: 15.1, weather_code: 61, cloud_cover: 88, precipitation: 0.4, wind_speed_10m: 21.3, is_day: 1 },
      }),
    );
    const result = await getCurrentConditions({ lat: 38.7251, lon: -9.1498, tz: "Europe/Lisbon" }, { units: "metric", now: CAPTURED_AT });
    expect(Object.fromEntries(stub.calls[0].url.searchParams)).toEqual({
      latitude: "38.73",
      longitude: "-9.15",
      current: "temperature_2m,apparent_temperature,weather_code,cloud_cover,precipitation,wind_speed_10m,is_day",
      timezone: "Europe/Lisbon",
      timeformat: "unixtime",
      forecast_days: "1",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        observedAt: new Date(1795651200 * 1000).toISOString(),
        condition: { code: 61, label: "Light rain", sky: "rain" },
        isDay: true,
        temperature: 16.4,
        feelsLike: 15.1,
        cloudCover: 88,
        precipitation: 0.4,
        windSpeed: 21.3,
      },
    });
  });

  it("is refreshed every fifteen minutes and kept apart from the daily forecast", async () => {
    const stub = stubFetch(realForecast);
    await getForecast(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    await getCurrentConditions(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(stub.calls).toHaveLength(2);
    await getCurrentConditions(CHICAGO, { units: "imperial", now: later(14 * MINUTE) });
    expect(stub.calls).toHaveLength(2);
    await getCurrentConditions(CHICAGO, { units: "imperial", now: later(16 * MINUTE) });
    expect(stub.calls).toHaveLength(3);
  });

  it("falls back to the last reading for two hours, then admits it does not know", async () => {
    let healthy = true;
    stubFetch(() => (healthy ? realForecast() : html("<html>Error</html>", 500)));
    await getCurrentConditions(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    healthy = false;
    expect(await getCurrentConditions(CHICAGO, { units: "imperial", now: later(90 * MINUTE) })).toMatchObject({ ok: true, stale: true, fetchedAt: CAPTURED_AT });
    expect(await getCurrentConditions(CHICAGO, { units: "imperial", now: later(3 * HOUR) })).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: CAPTURED_AT });
  });

  it("treats a missing temperature or an unreadable time as an outage", async () => {
    stubFetch(() => json({ current_units: { temperature_2m: "°F" }, current: { time: "2026-11-25T18:00", weather_code: 3, is_day: 0 } }));
    expect(await getCurrentConditions(CHICAGO, { units: "imperial", now: CAPTURED_AT })).toMatchObject({ ok: false, reason: "unavailable" });
    await t.db.delete(schema.signalCache);
    stubFetch(() => json({ current_units: { temperature_2m: "°F" }, current: { time: "half past six", temperature_2m: 40, weather_code: 3, is_day: 0 } }));
    const result = await getCurrentConditions(CHICAGO, { units: "imperial", now: CAPTURED_AT });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if (!result.ok) expect(result.detail).toContain("current time that cannot be read");
  });

  it("refuses a place without coordinates", async () => {
    expect(await getCurrentConditions({ tz: "America/Chicago" }, { units: "imperial", now: CAPTURED_AT })).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("the forecast horizon", () => {
  const now = new Date("2026-11-27T18:00:00Z"); // the 27th in Chicago, already the 28th in Auckland

  it("ends fifteen days after local today", () => {
    expect(forecastHorizon(now, "America/Chicago")).toBe("2026-12-12");
    expect(forecastHorizon(now, "Pacific/Auckland")).toBe("2026-12-13");
  });

  it("says how much of a date range the forecast can cover", () => {
    const tz = "America/Chicago";
    expect(forecastCoverage("2026-11-27", "2026-12-12", tz, now)).toBe("all");
    expect(forecastCoverage("2026-12-01", "2026-12-05", tz, now)).toBe("all");
    expect(forecastCoverage("2026-12-10", "2026-12-20", tz, now)).toBe("some");
    expect(forecastCoverage("2026-11-20", "2026-11-30", tz, now)).toBe("some"); // began before today
    expect(forecastCoverage("2026-12-13", "2026-12-20", tz, now)).toBe("none");
    expect(forecastCoverage("2026-12-19", "2026-12-26", tz, now)).toBe("none");
    expect(forecastCoverage("2026-11-01", "2026-11-26", tz, now)).toBe("none"); // already over
  });
});
