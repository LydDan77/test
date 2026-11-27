import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The signal cache table cannot be reached at all: every getDb() call rejects. The providers
// must still answer from the source when it works, and fail quietly when it does not.
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  getDb: async () => {
    throw new Error("connection refused");
  },
}));

import { getDb } from "@/db";
import { HTTP_DEFAULTS } from "../http";
import { airportStatusOf } from "../signals";
import { getAirportStatus } from "./airport-status";
import { getTravelAdvisory } from "./advisories";
import { getCurrentConditions, getForecast } from "./forecast";
import { getPublicHolidays } from "./holidays";
import { getNews } from "./news";
import { fixture, html, json, stubFetch, xml, type Scripted } from "./test-support";
import { getTypicalWeather } from "./typical-weather";
import { getWeatherAlerts } from "./weather-alerts";

const original = { ...HTTP_DEFAULTS };
beforeEach(() => {
  HTTP_DEFAULTS.retryDelayMs = 0;
  vi.spyOn(console, "error").mockImplementation(() => {}); // the cache logs each failed read and write
});
afterEach(() => {
  Object.assign(HTTP_DEFAULTS, original);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = new Date("2026-11-26T00:08:00Z");
const CHICAGO = { lat: 41.8781, lon: -87.6298, tz: "America/Chicago", countryCode: "US" };

const REAL: Record<string, () => Scripted> = {
  "api.open-meteo.com": () => json(fixture("open-meteo-forecast.json")),
  "archive-api.open-meteo.com": () => json(fixture("open-meteo-archive.reconstructed.json")),
  "nasstatus.faa.gov": () => json(fixture("faa-airport-events.json")),
  "api.weather.gov": () => json(fixture("nws-alerts-point-active.json"), 200, "application/geo+json"),
  "date.nager.at": () => json(fixture("nager-v4-holidays-us-2026.json")),
  "travel.state.gov": () => xml(fixture("state-advisories.trimmed.xml"), "text/xml"),
  "feeds.bbci.co.uk": () => xml(fixture("bbc-news.xml"), "text/xml"),
  "skift.com": () => xml(fixture("skift.xml"), "application/rss+xml"),
  "wwwnc.cdc.gov": () => ({ status: 200, contentType: "text/html", body: fixture("cdc-notices.xml") }),
};

describe("every provider, with the cache table unreachable", () => {
  it("really has no database in this file", async () => {
    await expect(getDb()).rejects.toThrow("connection refused");
  });

  it("still answers from the source when the source works", async () => {
    stubFetch((url) => REAL[url.host]());
    const fresh = { ok: true, stale: false, fetchedAt: NOW };

    expect(await getForecast(CHICAGO, { units: "imperial", now: NOW })).toMatchObject({ ...fresh, data: { days: { length: 16 } } });
    expect(await getCurrentConditions(CHICAGO, { units: "imperial", now: NOW })).toMatchObject({ ...fresh, data: { temperature: 40.6 } });
    expect(await getTypicalWeather(CHICAGO, { startDate: "2027-12-20", endDate: "2027-12-26" }, { units: "imperial", now: NOW, years: 3 })).toMatchObject({ ...fresh, data: { high: 36.2 } });
    const airports = await getAirportStatus(["MIA", "ORD"], { now: NOW });
    expect(airports).toMatchObject(fresh);
    expect(airportStatusOf(airports, "MIA").state).toBe("events");
    expect(airportStatusOf(airports, "ORD").state).toBe("no_delays");
    expect(await getWeatherAlerts({ ...CHICAGO, lat: 36.7682, lon: -76.2875 }, { now: NOW })).toMatchObject({ ...fresh, data: { coverage: "covered", alerts: { length: 3 } } });
    expect(await getPublicHolidays("US", 2026, { now: NOW })).toMatchObject({ ...fresh, data: { coverage: "covered", holidays: { length: 10 } } });
    expect(await getTravelAdvisory("MX", { now: NOW })).toMatchObject({ ...fresh, data: { status: "published", advisory: { level: 2 } } });
    expect(await getNews({ now: NOW })).toMatchObject({ ...fresh, data: { items: { length: 50 } } });
  });

  it("fails without throwing when the source is down too", async () => {
    stubFetch(() => html("<html><body>Service unavailable</body></html>", 503));
    const down = { ok: false, reason: "unavailable", lastGoodAt: null };

    expect(await getForecast(CHICAGO, { units: "imperial", now: NOW })).toMatchObject(down);
    expect(await getCurrentConditions(CHICAGO, { units: "imperial", now: NOW })).toMatchObject(down);
    expect(await getTypicalWeather(CHICAGO, { startDate: "2027-12-20", endDate: "2027-12-26" }, { units: "imperial", now: NOW })).toMatchObject(down);
    const airports = await getAirportStatus(["MIA"], { now: NOW });
    expect(airports).toMatchObject(down);
    expect(airportStatusOf(airports, "MIA").state).toBe("unavailable");
    expect(await getWeatherAlerts(CHICAGO, { now: NOW })).toMatchObject(down);
    expect(await getPublicHolidays("US", 2026, { now: NOW })).toMatchObject(down);
    expect(await getTravelAdvisory("MX", { now: NOW })).toMatchObject(down);
    expect(await getNews({ now: NOW })).toMatchObject(down);
  });

  it("cannot remember a rate limit without the table, so it simply reports each one", async () => {
    const stub = stubFetch(() => json(fixture("open-meteo-archive-error-daily-limit.json"), 429));
    expect(await getForecast(CHICAGO, { units: "imperial", now: NOW })).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(await getTypicalWeather(CHICAGO, { startDate: "2027-12-20", endDate: "2027-12-26" }, { units: "imperial", now: NOW })).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(stub.calls).toHaveLength(2); // one request each, never a retry
  });
});
