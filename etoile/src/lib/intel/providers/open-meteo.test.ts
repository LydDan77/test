import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { HTTP_DEFAULTS, HttpError } from "../http";
import { fetchOpenMeteo, isOpenMeteoPaused, openMeteoReason, openMeteoUrl, pauseLengthMs, unitParams, withPauseAsReason } from "./open-meteo";
import { fixture, html, json, stubFetch } from "./test-support";

// The error bodies are real: open-meteo-archive-error-daily-limit.json (HTTP 429, captured
// 2026-11-27), open-meteo-error-date-out-of-range.json and -forecast-days.json (HTTP 400).
// The "Hourly" and "Minutely" messages are written from Open-Meteo's known wording; only the
// "Daily" one has been seen.

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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const limited = (reason: string | null, retryAfterMs: number | null = null) =>
  new HttpError("rate_limited", "429", { status: 429, retryAfterMs, body: reason === null ? null : JSON.stringify({ error: true, reason }) });
const DAILY = "Daily API request limit exceeded. Please try again tomorrow.";
const anything = z.object({ ok: z.boolean() });
const URL = "https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2";

describe("pauseLengthMs", () => {
  it("waits until just after the next midnight UTC when the daily allowance is gone", () => {
    expect(pauseLengthMs(limited(DAILY), new Date("2026-11-27T12:00:00Z"))).toBe(12 * HOUR + 5 * MINUTE);
    expect(pauseLengthMs(limited(DAILY), new Date("2026-11-27T00:00:00Z"))).toBe(24 * HOUR + 5 * MINUTE);
    expect(pauseLengthMs(limited(DAILY), new Date("2026-12-31T22:30:00Z"))).toBe(95 * MINUTE); // across the year
  });

  it("never waits less than a quarter of an hour for a daily limit, even at 23:59", () => {
    expect(pauseLengthMs(limited(DAILY), new Date("2026-11-27T23:59:00Z"))).toBe(15 * MINUTE);
    expect(pauseLengthMs(limited(DAILY), new Date("2026-11-27T23:40:00Z"))).toBe(25 * MINUTE);
  });

  it("waits an hour or two minutes for the shorter allowances", () => {
    const now = new Date("2026-11-27T12:00:00Z");
    expect(pauseLengthMs(limited("Hourly API request limit exceeded. Please try again in the next hour."), now)).toBe(HOUR);
    expect(pauseLengthMs(limited("Minutely API request limit exceeded. Please try again in one minute."), now)).toBe(2 * MINUTE);
  });

  it("otherwise honours Retry-After within sensible bounds, or waits fifteen minutes", () => {
    const now = new Date("2026-11-27T12:00:00Z");
    expect(pauseLengthMs(limited(null), now)).toBe(15 * MINUTE);
    expect(pauseLengthMs(limited("Too many requests"), now)).toBe(15 * MINUTE);
    expect(pauseLengthMs(limited(null, 5 * MINUTE), now)).toBe(5 * MINUTE);
    expect(pauseLengthMs(limited(null, 2_000), now)).toBe(MINUTE);
    expect(pauseLengthMs(limited(null, 24 * HOUR), now)).toBe(6 * HOUR);
  });
});

describe("openMeteoReason", () => {
  it("reads the service's own words from its real error bodies", () => {
    expect(openMeteoReason(new HttpError("rate_limited", "x", { body: fixture("open-meteo-archive-error-daily-limit.json") }))).toBe(DAILY);
    expect(openMeteoReason(new HttpError("status", "x", { body: fixture("open-meteo-error-date-out-of-range.json") }))).toBe(
      "Parameter 'start_date' is out of allowed range from 2026-08-25 to 2026-12-11",
    );
    expect(openMeteoReason(new HttpError("status", "x", { body: fixture("open-meteo-error-forecast-days.json") }))).toBe("Forecast days is invalid. Allowed range 0 to 16. Given 17.");
  });

  it("returns null for anything that is not that shape", () => {
    for (const body of [null, "", "<html>Access Denied</html>", "[]", `{"reason": 42}`, `"reason"`, "null"]) {
      expect(openMeteoReason(new HttpError("status", "x", { body })), String(body)).toBeNull();
    }
  });
});

describe("fetchOpenMeteo", () => {
  const now = new Date("2026-11-27T12:00:00Z");

  it("returns the document when all is well, and records no pause", async () => {
    const stub = stubFetch(() => json({ ok: true }));
    expect(await fetchOpenMeteo("forecast", URL, anything, now)).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);
    expect(await isOpenMeteoPaused("forecast", now)).toBe(false);
  });

  it("after a 429 pauses that service only, for exactly as long as the message implies", async () => {
    const stub = stubFetch(() => json(fixture("open-meteo-archive-error-daily-limit.json"), 429));
    await expect(fetchOpenMeteo("archive", URL, anything, now)).rejects.toMatchObject({ kind: "rate_limited", status: 429, message: expect.stringContaining(DAILY) });
    expect(stub.calls).toHaveLength(1);

    expect(await isOpenMeteoPaused("archive", now)).toBe(true);
    expect(await isOpenMeteoPaused("forecast", now)).toBe(false);
    expect(await isOpenMeteoPaused("archive", new Date("2026-11-28T00:04:00Z"))).toBe(true);
    expect(await isOpenMeteoPaused("archive", new Date("2026-11-28T00:06:00Z"))).toBe(false);

    // While paused: an error at once, and nothing on the wire.
    await expect(fetchOpenMeteo("archive", URL, anything, new Date("2026-11-27T18:00:00Z"))).rejects.toMatchObject({ kind: "rate_limited", message: expect.stringContaining("nothing was sent") });
    expect(stub.calls).toHaveLength(1);
  });

  it("keeps the first pause when two requests are refused at the same moment", async () => {
    const stub = stubFetch(() => json(fixture("open-meteo-archive-error-daily-limit.json"), 429));
    const both = await Promise.allSettled([fetchOpenMeteo("forecast", URL, anything, now), fetchOpenMeteo("forecast", `${URL}&x=1`, anything, now)]);
    expect(both.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(stub.calls).toHaveLength(2);
    const rows = (await t.db.select().from(schema.signalCache)).filter((row) => row.key === "v1:open-meteo:forecast:paused");
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt).toEqual(new Date("2026-11-28T00:05:00Z"));
  });

  it("adds the service's reason to a refused request and leaves other failures as they are", async () => {
    stubFetch(() => json(fixture("open-meteo-error-date-out-of-range.json"), 400));
    await expect(fetchOpenMeteo("forecast", URL, anything, now)).rejects.toMatchObject({
      kind: "status",
      status: 400,
      message: "api.open-meteo.com/v1/forecast: HTTP 400: Parameter 'start_date' is out of allowed range from 2026-08-25 to 2026-12-11",
    });
    expect(await isOpenMeteoPaused("forecast", now)).toBe(false);

    stubFetch(() => html("<html>Bad gateway</html>", 502));
    await expect(fetchOpenMeteo("forecast", URL, anything, now)).rejects.toMatchObject({ kind: "status", status: 502, message: "api.open-meteo.com/v1/forecast: HTTP 502" });
    expect(await isOpenMeteoPaused("forecast", now)).toBe(false);
  });
});

describe("withPauseAsReason", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const failed = { ok: false as const, reason: "unavailable" as const, detail: "The source failed recently", lastGoodAt: null };

  it("leaves results alone when the service is not paused", async () => {
    expect(await withPauseAsReason(failed, "forecast", now)).toBe(failed);
    const good = { ok: true as const, data: 1, fetchedAt: now, stale: false };
    expect(await withPauseAsReason(good, "forecast", now)).toBe(good);
  });

  it("names the rate limit as the reason while the service is paused", async () => {
    stubFetch(() => json(fixture("open-meteo-archive-error-daily-limit.json"), 429));
    await fetchOpenMeteo("forecast", URL, anything, now).catch(() => {});
    expect(await withPauseAsReason(failed, "forecast", now)).toEqual({ ...failed, reason: "rate_limited" });
    expect(await withPauseAsReason(failed, "archive", now)).toBe(failed);
  });
});

describe("request building", () => {
  it("names the units for each system", () => {
    expect(unitParams("imperial")).toEqual({ temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch" });
    expect(unitParams("metric")).toEqual({ temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm" });
  });

  it("builds the same address for the same question, and encodes what needs it", () => {
    const url = openMeteoUrl("forecast", { latitude: 41.88, longitude: -87.63, daily: "weather_code,temperature_2m_max", timezone: "America/Chicago" });
    expect(url).toBe("https://api.open-meteo.com/v1/forecast?latitude=41.88&longitude=-87.63&daily=weather_code%2Ctemperature_2m_max&timezone=America%2FChicago");
    expect(openMeteoUrl("archive", { start_date: "2025-12-19" })).toBe("https://archive-api.open-meteo.com/v1/archive?start_date=2025-12-19");
  });
});
