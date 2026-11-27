import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/db/testing";
import { placeRefSchema, type PlaceRef } from "@/lib/domain";
import { airportStatusOf } from "../signals";
import { getAirportStatus, getCurrentConditions, getForecast, getTypicalWeather, getWeatherAlerts } from "./index";
import { fixture, json, stubFetch } from "./test-support";

// The place-taking functions are meant to be handed a PlaceRef as it is stored on a plan, a
// clock or a flight segment. This file fails to type-check if that ever stops being true.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
afterEach(() => vi.unstubAllGlobals());

const NOW = new Date("2026-11-26T00:08:00Z");

const miami: PlaceRef = placeRefSchema.parse({
  kind: "airport",
  name: "Miami International Airport",
  locality: "Miami",
  region: "FL",
  countryCode: "US",
  lat: 25.7959,
  lon: -80.2871,
  tz: "America/New_York",
  iata: "MIA",
});
const paris: PlaceRef = placeRefSchema.parse({ kind: "airport", name: "Paris Charles de Gaulle", countryCode: "FR", lat: 49.0097, lon: 2.5479, tz: "Europe/Paris", iata: "CDG" });
const homeFromZoneOnly: PlaceRef = { kind: "home", name: "Chicago", tz: "America/Chicago" };

it("takes a stored place for weather, alerts and airport status", async () => {
  stubFetch((url) => {
    if (url.host === "api.open-meteo.com") {
      // The real capture is for Chicago; here only its shape matters.
      return json(fixture("open-meteo-forecast.json"));
    }
    if (url.host === "archive-api.open-meteo.com") return json(fixture("open-meteo-archive.reconstructed.json"));
    if (url.host === "api.weather.gov") return json(fixture("nws-alerts-point-empty.json"), 200, "application/geo+json");
    return json(fixture("faa-airport-events.json"));
  });

  expect((await getForecast(miami, { units: "imperial", now: NOW })).ok).toBe(true);
  expect((await getCurrentConditions(miami, { units: "imperial", now: NOW })).ok).toBe(true);
  expect((await getTypicalWeather(miami, { startDate: "2027-12-20", endDate: "2027-12-26" }, { units: "imperial", now: NOW, years: 3 })).ok).toBe(true);
  expect(await getWeatherAlerts(miami, { now: NOW })).toMatchObject({ ok: true, data: { coverage: "covered", alerts: [] } });
  expect(await getWeatherAlerts(paris, { now: NOW })).toMatchObject({ ok: true, data: { coverage: "not_covered" } });

  const airports = await getAirportStatus([miami, paris, homeFromZoneOnly], { now: NOW });
  expect(airportStatusOf(airports, "MIA").state).toBe("events");
  expect(airportStatusOf(airports, "CDG")).toEqual({ state: "unavailable", airport: "CDG", why: "not_covered" });
  expect(airports.ok && airports.data.airports).toHaveLength(2); // the home place has no airport code
});

it("says a place known only by its time zone cannot be asked about", async () => {
  const stub = stubFetch(() => json({}));
  expect(await getForecast(homeFromZoneOnly, { units: "imperial", now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
  expect(await getCurrentConditions(homeFromZoneOnly, { units: "metric", now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
  expect(await getWeatherAlerts(homeFromZoneOnly, { now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
  expect(stub.calls).toHaveLength(0);
});
