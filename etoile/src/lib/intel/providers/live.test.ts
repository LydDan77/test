import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/db/testing";
import { fetchXml, userAgent } from "../http";
import { airportStatusOf, type SourceResult, type TravelAdvisorySignal } from "../signals";
import { NEWS_SOURCES } from "../sources";
import { eventsFromXml, getAirportStatus } from "./airport-status";
import { getTravelAdvisory } from "./advisories";
import { getCurrentConditions, getForecast } from "./forecast";
import { getPublicHolidays } from "./holidays";
import { getNews } from "./news";
import { pickRelevantNews } from "./news-relevance";
import { getTypicalWeather } from "./typical-weather";
import { getWeatherAlerts } from "./weather-alerts";

// Calls every real source ONCE and checks the shape of what comes back. Skipped unless LIVE=1:
//
//   LIVE=1 npx vitest run src/lib/intel/providers/live.test.ts --silent=false
//
// (Behind an HTTPS proxy, add NODE_USE_ENV_PROXY=1 so Node's fetch uses it.)
//
// It is gentle on purpose: at most 2 requests to the forecast host, at most 3 to the historical
// host, 1 to the weather service, and one or two each to the other sources. Do not put it in a
// loop or in CI on a schedule.
//
// The two Open-Meteo hosts count requests per internet address and often answer 429 ("Daily
// API request limit exceeded") on shared addresses. When they do, the test is marked SKIPPED
// with a note: the provider did the right thing, but the shape of a good answer was not seen.
// Passed means the shape was checked; failed means something is wrong.
//
// Each test prints one "LIVE …" line saying what the source returned.

const LIVE = process.env.LIVE === "1";
const report: string[] = [];
const say = (line: string) => {
  report.push(line);
  console.log(`LIVE ${line}`);
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHICAGO = { lat: 41.8781, lon: -87.6298, tz: "America/Chicago", countryCode: "US" };
const RATE_LIMIT_NOTE = "Open-Meteo says this address has used up its allowance; a good answer was not seen";

describe.skipIf(!LIVE)("the real sources, once each", () => {
  let t: TestDb;
  const now = new Date();
  beforeAll(async () => {
    t = await createTestDb();
    say(`user agent: ${userAgent()}`);
  });
  afterAll(async () => {
    console.log(`\nLIVE REPORT\n${report.map((line) => `  ${line}`).join("\n")}\n`);
    await t.close();
  });

  it("forecast (Open-Meteo): sixteen days starting today", async ({ skip }) => {
    const result = await getForecast(CHICAGO, { units: "imperial", now });
    if (!result.ok) {
      say(`forecast: NOT CHECKED (${result.reason}): ${result.detail}`);
      if (result.reason === "rate_limited") skip(RATE_LIMIT_NOTE);
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { days } = result.data;
    say(`forecast: ok, ${days.length} days ${days[0].date} to ${days[days.length - 1].date}; first day ${days[0].condition.label}, ${days[0].high}/${days[0].low} °F, rain chance ${days[0].precipitationChance}%, gust ${days[0].windGust} mph`);
    expect(days.length).toBe(16);
    for (const day of days) {
      expect(day.date).toMatch(LOCAL_DATE);
      expect(day.condition.sky).not.toBe("unknown");
      expect(typeof day.high).toBe("number");
      expect(typeof day.low).toBe("number");
    }
  });

  it("current conditions (Open-Meteo): everything a sky needs", async ({ skip }) => {
    const result = await getCurrentConditions(CHICAGO, { units: "metric", now });
    if (!result.ok) {
      say(`current conditions: NOT CHECKED (${result.reason}): ${result.detail}`);
      if (result.reason === "rate_limited") skip(RATE_LIMIT_NOTE);
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sky = result.data;
    say(`current conditions: ok, observed ${sky.observedAt}; ${sky.condition.label}, ${sky.temperature} °C, cloud ${sky.cloudCover}%, precipitation ${sky.precipitation} mm, ${sky.isDay ? "day" : "night"}`);
    expect(sky.observedAt).toMatch(ISO_INSTANT);
    expect(Math.abs(Date.parse(sky.observedAt) - now.getTime())).toBeLessThan(2 * 3_600_000);
    expect(typeof sky.temperature).toBe("number");
    expect(typeof sky.cloudCover).toBe("number");
    expect(typeof sky.precipitation).toBe("number");
    expect(typeof sky.isDay).toBe("boolean");
    expect(sky.condition.sky).not.toBe("unknown");
  });

  it("typical weather (Open-Meteo historical): the usual high, low and wet days", async ({ skip }) => {
    const result = await getTypicalWeather(CHICAGO, { startDate: "2027-12-20", endDate: "2027-12-26" }, { units: "imperial", now, years: 3 });
    if (!result.ok) {
      say(`typical weather: NOT CHECKED (${result.reason}): ${result.detail}`);
      if (result.reason === "rate_limited") skip(RATE_LIMIT_NOTE);
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const typical = result.data;
    say(`typical weather: ok, ${typical.high}/${typical.low} °F, wet on ${typical.typicalWetDays} of ${typical.days} days, from ${typical.years.join(", ")}`);
    expect(typical.years.length).toBeGreaterThanOrEqual(3);
    expect(typical.high).toBeGreaterThan(typical.low);
    expect(typical.wetDayShare).toBeGreaterThanOrEqual(0);
    expect(typical.wetDayShare).toBeLessThanOrEqual(1);
  });

  it("airport status (FAA JSON): one of three states per airport", async () => {
    const result = await getAirportStatus(["ORD", "MIA", "LAX", "HNL"], { now });
    if (!result.ok) say(`airport status: FAILED ${result.reason}: ${result.detail}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    say(`airport status: ok, ${result.data.airports.map((airport) => `${airport.airport} ${airport.state}${airport.state === "events" ? ` (${airport.events.map((event) => event.kind).join(", ")})` : ""}`).join("; ")}`);
    for (const code of ["ORD", "MIA", "LAX", "HNL"]) {
      const status = airportStatusOf(result, code);
      expect(["no_delays", "events"]).toContain(status.state);
      if (status.state === "events") {
        for (const event of status.events) {
          expect(event.description.length).toBeGreaterThan(10);
          expect(event.description).not.toMatch(/!/);
        }
      }
    }
  });

  it("airport status (FAA XML, the back-up document): readable", async () => {
    const root = await fetchXml("https://nasstatus.faa.gov/api/airport-status-information", { root: "AIRPORT_STATUS_INFORMATION" });
    const feed = eventsFromXml(root);
    say(`airport status XML: ok, updated ${feed.feedUpdatedAt}; airports with events: ${Object.keys(feed.airports).join(", ") || "none"}`);
    expect(feed.feedUpdatedAt).toMatch(ISO_INSTANT);
    expect(Math.abs(Date.parse(feed.feedUpdatedAt ?? "") - now.getTime())).toBeLessThan(3_600_000);
  });

  it("weather alerts (NWS): a complete list for a US point", async () => {
    const result = await getWeatherAlerts(CHICAGO, { now });
    if (!result.ok) say(`weather alerts: FAILED ${result.reason}: ${result.detail}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    say(`weather alerts: ok, ${result.data.coverage}, ${result.data.alerts.length} in force${result.data.alerts.map((alert) => `; ${alert.event} (${alert.severity}) until ${alert.endsAt}`).join("")}`);
    expect(result.data.coverage).toBe("covered");
    for (const alert of result.data.alerts) {
      expect(alert.startsAt).toMatch(ISO_INSTANT);
      expect(alert.event.length).toBeGreaterThan(2);
    }
  });

  it("public holidays (Nager v4): a covered country and an uncovered one", async () => {
    const year = now.getUTCFullYear() + 1;
    const us = await getPublicHolidays("US", year, { now });
    if (!us.ok) say(`holidays US: FAILED ${us.reason}: ${us.detail}`);
    expect(us.ok).toBe(true);
    if (us.ok && us.data.coverage === "covered") {
      say(`holidays US ${year}: ok, ${us.data.holidays.length} public holidays, ${us.data.longWeekends.length} long weekends; first ${us.data.holidays[0].date} ${us.data.holidays[0].name}`);
      expect(us.data.holidays.length).toBeGreaterThanOrEqual(9);
      expect(us.data.holidays.map((holiday) => holiday.name)).toContain("Thanksgiving Day");
      expect(us.data.longWeekends.length).toBeGreaterThanOrEqual(5);
    } else if (us.ok) {
      throw new Error("The United States came back as not covered");
    }

    const india = await getPublicHolidays("IN", year, { now });
    say(`holidays IN ${year}: ${india.ok ? `ok, coverage ${india.data.coverage}` : `FAILED ${india.reason}: ${india.detail}`}`);
    expect(india).toMatchObject({ ok: true, data: { coverage: "unknown" } });
  });

  it("travel advisories (State Department): the whole feed, keyed by country", async () => {
    const mexico = await getTravelAdvisory("MX", { now });
    if (!mexico.ok) say(`advisories: FAILED ${mexico.reason}: ${mexico.detail}`);
    expect(mexico.ok).toBe(true);
    if (!mexico.ok) return;
    // The feed is in the cache now: these ask nothing more of the Department.
    const [switzerland, gaza, home, uk] = await Promise.all([getTravelAdvisory("CH", { now }), getTravelAdvisory("PS", { now }), getTravelAdvisory("US", { now }), getTravelAdvisory("GB", { now })]);
    const line = (code: string, result: SourceResult<TravelAdvisorySignal>) =>
      result.ok ? (result.data.status === "published" ? `${code} level ${result.data.advisory.level} (${result.data.advisory.area}, ${result.data.advisory.publishedOn})` : `${code} none`) : `${code} FAILED`;
    say(`advisories: ok, ${line("MX", mexico)}; ${line("CH", switzerland)}; ${line("PS", gaza)}; ${line("GB", uk)}; ${line("US", home)}`);
    if (mexico.data.status === "published") say(`advisories: Mexico summary: ${mexico.data.advisory.summary}`);
    expect(mexico.data).toMatchObject({ status: "published", advisory: { area: "Mexico" } });
    expect(switzerland).toMatchObject({ ok: true, data: { status: "published", advisory: { area: "Switzerland" } } });
    expect(uk).toMatchObject({ ok: true, data: { status: "published", advisory: { area: "United Kingdom" } } });
    expect(gaza).toMatchObject({ ok: true, data: { status: "published" } });
    expect(home).toMatchObject({ ok: true, data: { status: "none" } });
    if (mexico.data.status === "published") {
      expect([1, 2, 3, 4]).toContain(mexico.data.advisory.level);
      expect(mexico.data.advisory.url).toMatch(/^https:\/\/travel\.state\.gov\//);
      expect(mexico.data.advisory.publishedOn).toMatch(LOCAL_DATE);
    }
  });

  it("news: all four feeds answer with headlines", async () => {
    const result = await getNews({ sourceIds: NEWS_SOURCES.map((source) => source.id), now });
    if (!result.ok) say(`news: FAILED ${result.reason}: ${result.detail}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const source of result.data.sources) {
      const items = result.data.items.filter((item) => item.sourceId === source.id);
      say(`news ${source.id}: ${source.ok ? `ok, ${items.length} headlines, newest ${items[0]?.publishedAt ?? "undated"}` : "FAILED"}`);
    }
    const picked = pickRelevantNews(result.data.items, { places: ["Mexico", "Canada", "London"], airports: ["Heathrow"], limit: 3 });
    say(`news: ${result.data.items.length} headlines in all; ${picked.length} picked for Mexico, Canada, London, Heathrow`);
    expect(result.data.sources.map((source) => `${source.id}:${source.ok}`)).toEqual(NEWS_SOURCES.map((source) => `${source.id}:true`));
    expect(picked.length).toBeLessThanOrEqual(3);
    for (const item of result.data.items) {
      expect(item.headline.length).toBeGreaterThan(3);
      expect(item.link).toMatch(/^https?:\/\//);
      if (item.publishedAt !== null) expect(item.publishedAt).toMatch(ISO_INSTANT);
    }
  });
});
