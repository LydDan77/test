import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { DEFAULT_USER_AGENT, HTTP_DEFAULTS } from "../http";
import type { WeatherAlert } from "../signals";
import { fixture, html, json, stubFetch } from "./test-support";
import { getWeatherAlerts, isCoveredByNws, sortAlerts } from "./weather-alerts";

// Fixtures, all real captures of 2026-11-26T00:07Z: nws-alerts-point-active.json (three alerts
// at Chesapeake, Virginia), nws-alerts-point-empty.json (Chicago), the 400 "out of bounds"
// answer for Lisbon, and the HTML "Access Denied" page sent when no User-Agent is given.

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

const CHESAPEAKE = { lat: 36.7682, lon: -76.2875, tz: "America/New_York", countryCode: "US" };
const CHICAGO = { lat: 41.8781, lon: -87.6298, tz: "America/Chicago", countryCode: "US" };
const LISBON = { lat: 38.7251, lon: -9.1498, tz: "Europe/Lisbon", countryCode: "PT" };
const NOW = new Date("2026-11-26T00:10:00Z");
const MINUTE = 60_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const active = () => json(fixture("nws-alerts-point-active.json"), 200, "application/geo+json");
const none = () => json(fixture("nws-alerts-point-empty.json"), 200, "application/geo+json");

describe("getWeatherAlerts", () => {
  it("returns the real alerts, most severe and most urgent first, then the one ending soonest", async () => {
    stubFetch(active);
    const result = await getWeatherAlerts(CHESAPEAKE, { now: NOW });
    expect(result).toMatchObject({ ok: true, stale: false, fetchedAt: NOW, data: { coverage: "covered" } });
    if (!result.ok) return;
    // All three are "severe". Two are "expected" (the wind one ends first); the watch is "future".
    expect(result.data.alerts.map((alert) => `${alert.event} / ${alert.severity} / ${alert.urgency}`)).toEqual([
      "High Wind Warning / severe / expected",
      "Coastal Flood Warning / severe / expected",
      "Flood Watch / severe / future",
    ]);
    const wind = result.data.alerts[0];
    expect(wind).toMatchObject({
      id: "urn:oid:2.49.0.1.840.0.f25e93e55f16c8e3601c4cda2c8c86fa0b3948d8.001.2",
      certainty: "likely",
      headline: "High Wind Warning issued November 25 at 12:01PM EST until November 26 at 1:00PM EST by NWS Wakefield VA",
      area: "Surry; Chesapeake; Isle of Wight; Suffolk",
      sender: "NWS Wakefield VA",
      isUpdate: false,
      instruction: "People are urged to secure loose objects that could be blown around or damaged by the wind.",
    });
    expect(result.data.alerts[1].isUpdate).toBe(true);
  });

  it("takes 'until' from the event's end, not from the hours-earlier message expiry", async () => {
    stubFetch(active);
    const result = await getWeatherAlerts(CHESAPEAKE, { now: NOW });
    if (!result.ok) throw new Error("expected alerts");
    const wind = result.data.alerts[0];
    // onset 7:00 PM EST on the 25th; ends 1:00 PM EST on the 26th; the message "expires" at 8:15 PM on the 25th.
    expect(wind.startsAt).toBe("2026-11-26T00:00:00.000Z");
    expect(wind.endsAt).toBe("2026-11-26T18:00:00.000Z");
    expect(result.data.alerts[1].endsAt).toBe("2026-11-26T20:00:00.000Z");
  });

  it("keeps an alert whose message has expired while the hazard goes on, and drops it once the hazard ends", async () => {
    stubFetch(active);
    // 05:00 UTC: every message's "expires" (01:15, 03:00, 03:30 UTC) has passed; no hazard has ended.
    const overnight = await getWeatherAlerts(CHESAPEAKE, { now: new Date("2026-11-26T05:00:00Z") });
    expect(overnight.ok && overnight.data.alerts).toHaveLength(3);
    // 19:00 UTC: the wind warning and the flood watch ended at 18:00; the coastal flood warning runs to 20:00.
    const afternoon = await getWeatherAlerts(CHESAPEAKE, { now: new Date("2026-11-26T19:00:00Z") });
    expect(afternoon.ok && afternoon.data.alerts.map((alert) => alert.event)).toEqual(["Coastal Flood Warning"]);
    const evening = await getWeatherAlerts(CHESAPEAKE, { now: new Date("2026-11-26T20:30:00Z") });
    expect(evening).toMatchObject({ ok: true, data: { coverage: "covered", alerts: [] } });
  });

  it("joins the service's hard-wrapped lines back into paragraphs", async () => {
    stubFetch(active);
    const result = await getWeatherAlerts(CHESAPEAKE, { now: NOW });
    if (!result.ok) throw new Error("expected alerts");
    const description = result.data.alerts[0].description ?? "";
    const paragraphs = description.split("\n\n");
    expect(paragraphs[0]).toBe("* WHAT...East winds 30 to 40 mph with gusts up to 60 mph expected.");
    expect(paragraphs.length).toBeGreaterThan(2);
    expect(paragraphs.every((paragraph) => !paragraph.includes("\n") && paragraph === paragraph.trim())).toBe(true);
  });

  it("says 'covered, none in force' for a US place with no alerts", async () => {
    stubFetch(none);
    expect(await getWeatherAlerts(CHICAGO, { now: NOW })).toEqual({ ok: true, stale: false, fetchedAt: NOW, data: { coverage: "covered", alerts: [] } });
  });

  it("asks by point, to two decimals, with the headers the service insists on", async () => {
    const stub = stubFetch(none);
    await getWeatherAlerts(CHICAGO, { now: NOW });
    expect(stub.calls[0].url.href).toBe("https://api.weather.gov/alerts/active?point=41.88,-87.63&status=actual&message_type=alert,update");
    expect(stub.calls[0].headers.get("user-agent")).toBe(DEFAULT_USER_AGENT);
    expect(stub.calls[0].headers.get("accept")).toBe("application/geo+json");
  });

  it("refreshes every two minutes and shares a copy between neighbours", async () => {
    const stub = stubFetch(none);
    await getWeatherAlerts(CHICAGO, { now: NOW });
    await getWeatherAlerts({ ...CHICAGO, lat: 41.8799 }, { now: later(1.9 * MINUTE) });
    expect(stub.calls).toHaveLength(1);
    await getWeatherAlerts(CHICAGO, { now: later(2.1 * MINUTE) });
    expect(stub.calls).toHaveLength(2);
  });

  describe("outside the United States", () => {
    it("answers 'not covered' without asking, by country code", async () => {
      const stub = stubFetch(active);
      expect(await getWeatherAlerts(LISBON, { now: NOW })).toEqual({ ok: true, stale: false, fetchedAt: NOW, data: { coverage: "not_covered", alerts: [] } });
      expect(await getWeatherAlerts({ ...LISBON, countryCode: "ca", tz: "America/Toronto" }, { now: NOW })).toMatchObject({ ok: true, data: { coverage: "not_covered" } });
      expect(stub.calls).toHaveLength(0);
    });

    it("goes by time zone when the place has no country code", async () => {
      const stub = stubFetch(none);
      expect(await getWeatherAlerts({ lat: 38.7251, lon: -9.1498, tz: "Europe/Lisbon" }, { now: NOW })).toMatchObject({ ok: true, data: { coverage: "not_covered" } });
      expect(await getWeatherAlerts({ lat: 43.65, lon: -79.38, tz: "America/Toronto" }, { now: NOW })).toMatchObject({ ok: true, data: { coverage: "not_covered" } });
      expect(stub.calls).toHaveLength(0);
      expect(await getWeatherAlerts({ lat: 41.8781, lon: -87.6298, tz: "America/Chicago" }, { now: NOW })).toMatchObject({ ok: true, data: { coverage: "covered" } });
      expect(stub.calls).toHaveLength(1);
    });

    it("covers the territories and every US zone", () => {
      const at = (tz: string, countryCode?: string) => ({ lat: 0, lon: 0, tz, countryCode });
      for (const code of ["US", "us", "PR", "VI", "GU", "AS", "MP"]) expect(isCoveredByNws(at("UTC", code)), code).toBe(true);
      for (const code of ["CA", "MX", "PT", "GB", "BS"]) expect(isCoveredByNws(at("America/New_York", code)), code).toBe(false);
      for (const tz of ["America/New_York", "America/Phoenix", "America/Indiana/Knox", "America/Kentucky/Louisville", "America/North_Dakota/Center", "Pacific/Honolulu", "America/Anchorage", "America/Puerto_Rico", "Pacific/Guam"]) {
        expect(isCoveredByNws(at(tz)), tz).toBe(true);
      }
      for (const tz of ["America/Toronto", "America/Mexico_City", "America/Vancouver", "Europe/London", "Asia/Tokyo", "UTC"]) expect(isCoveredByNws(at(tz)), tz).toBe(false);
    });

    it("treats the service's own 'out of bounds' refusal as 'not covered', not as an outage", async () => {
      // A place that claims to be in the US but is not (bad data upstream).
      const stub = stubFetch(() => json(fixture("nws-error-point-out-of-bounds.json"), 400, "application/problem+json"));
      const result = await getWeatherAlerts({ ...LISBON, countryCode: "US" }, { now: NOW });
      expect(result).toEqual({ ok: true, stale: false, fetchedAt: NOW, data: { coverage: "not_covered", alerts: [] } });
      expect(stub.calls).toHaveLength(1);
    });
  });

  describe("when the service cannot be read", () => {
    it("fails on the real 'Access Denied' HTML page, and never says 'no alerts'", async () => {
      const stub = stubFetch(() => html(fixture("nws-error-no-user-agent.html"), 403));
      const result = await getWeatherAlerts(CHICAGO, { now: NOW });
      expect(result).toEqual({ ok: false, reason: "unavailable", detail: "api.weather.gov/alerts/active: HTTP 403", lastGoodAt: null });
      expect(stub.calls).toHaveLength(1);
    });

    it.each([
      ["an HTML page with status 200", () => html(fixture("nws-error-no-user-agent.html"))],
      ["a bad-request answer that is not about bounds", () => json({ title: "Bad Request", status: 400, detail: "Bad Request" }, 400, "application/problem+json")],
      ["broken JSON", () => json(`{"features": [`, 200, "application/geo+json")],
      ["a document with no list of features", () => json({ type: "FeatureCollection" }, 200, "application/geo+json")],
      ["an alert with no id", () => json({ features: [{ properties: { event: "Flood Watch", status: "Actual" } }] }, 200, "application/geo+json")],
      ["a server error, twice", () => html("<html>503</html>", 503)],
    ])("fails on %s", async (_label, respond) => {
      stubFetch(respond);
      expect(await getWeatherAlerts(CHICAGO, { now: NOW })).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: null });
    });

    it("fails on a timeout", async () => {
      HTTP_DEFAULTS.timeoutMs = 40;
      stubFetch(() => "hang");
      const result = await getWeatherAlerts(CHICAGO, { now: NOW });
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
      if (!result.ok) expect(result.detail).toContain("no answer within 40 ms");
    });

    it("uses the last good copy for fifteen minutes, marked stale, then stops", async () => {
      let healthy = true;
      stubFetch(() => (healthy ? active() : html(fixture("nws-error-no-user-agent.html"), 403)));
      await getWeatherAlerts(CHESAPEAKE, { now: NOW });
      healthy = false;

      const stale = await getWeatherAlerts(CHESAPEAKE, { now: later(10 * MINUTE) });
      expect(stale).toMatchObject({ ok: true, stale: true, fetchedAt: NOW });
      expect(stale.ok && stale.data.alerts).toHaveLength(3);

      expect(await getWeatherAlerts(CHESAPEAKE, { now: later(16 * MINUTE) })).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: NOW });
    });

    it("reports a rate limit as such", async () => {
      const stub = stubFetch(() => ({ status: 429, contentType: "application/problem+json", body: "{}", headers: { "retry-after": "5" } }));
      expect(await getWeatherAlerts(CHICAGO, { now: NOW })).toMatchObject({ ok: false, reason: "rate_limited" });
      expect(stub.calls).toHaveLength(1);
    });
  });

  it("leaves out tests, drafts and cancellations, and shows each alert once (reconstructed)", async () => {
    const base = { areaDesc: "Cook", sent: "2026-11-25T18:00:00-06:00", effective: "2026-11-25T18:00:00-06:00", onset: null, expires: "2026-11-26T06:00:00-06:00", ends: null, severity: "Moderate", urgency: "Expected", certainty: "Likely" };
    stubFetch(() =>
      json(
        {
          features: [
            { properties: { ...base, id: "a", event: "Winter Weather Advisory", status: "Actual", messageType: "Alert" } },
            { properties: { ...base, id: "a", event: "Winter Weather Advisory", status: "Actual", messageType: "Alert" } },
            { properties: { ...base, id: "b", event: "Test Message", status: "Test", messageType: "Alert" } },
            { properties: { ...base, id: "c", event: "Exercise Message", status: "Exercise", messageType: "Alert" } },
            { properties: { ...base, id: "d", event: "Flood Warning", status: "Actual", messageType: "Cancel" } },
            { properties: { ...base, id: "e", event: "Dense Fog Advisory", status: "Actual", messageType: "Update", severity: "Sideways", urgency: null, certainty: undefined } },
            { properties: { ...base, id: "f", event: "Timeless", status: "Actual", messageType: "Alert", sent: null, effective: "not a time" } },
            { properties: { ...base, id: "g", event: "Tornado Warning", status: "Actual", messageType: "Alert", severity: "Extreme", urgency: "Immediate", certainty: "Observed" } },
          ],
        },
        200,
        "application/geo+json",
      ),
    );
    const result = await getWeatherAlerts(CHICAGO, { now: NOW });
    if (!result.ok) throw new Error("expected alerts");
    expect(result.data.alerts.map((alert) => `${alert.id}:${alert.severity}:${alert.urgency}:${alert.certainty}`)).toEqual([
      "g:extreme:immediate:observed",
      "a:moderate:expected:likely",
      "e:unknown:unknown:unknown",
    ]);
    // No "onset": the start is when the alert took effect. No "ends": the end is the expiry.
    expect(result.data.alerts[1]).toMatchObject({ startsAt: "2026-11-26T00:00:00.000Z", endsAt: "2026-11-26T12:00:00.000Z", headline: null, description: null, instruction: null, sender: null });
  });

  it("refuses a place without coordinates", async () => {
    const stub = stubFetch(none);
    expect(await getWeatherAlerts({ tz: "America/Chicago", countryCode: "US" }, { now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("sortAlerts", () => {
  const alert = (id: string, severity: WeatherAlert["severity"], urgency: WeatherAlert["urgency"], endsAt: string | null): WeatherAlert => ({
    id, event: id, severity, urgency, certainty: "likely", headline: null, area: "", startsAt: "2026-11-26T00:00:00.000Z", endsAt, description: null, instruction: null, sender: null, isUpdate: false,
  });

  it("orders by severity, then urgency, then end, with open-ended and unknown last", () => {
    const sorted = sortAlerts([
      alert("minor", "minor", "immediate", null),
      alert("unknown", "unknown", "immediate", null),
      alert("severe-future", "severe", "future", "2026-11-26T10:00:00.000Z"),
      alert("severe-now-open", "severe", "immediate", null),
      alert("severe-now-late", "severe", "immediate", "2026-11-27T10:00:00.000Z"),
      alert("severe-now-soon", "severe", "immediate", "2026-11-26T10:00:00.000Z"),
      alert("extreme", "extreme", "past", null),
      alert("moderate", "moderate", "expected", null),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["extreme", "severe-now-soon", "severe-now-late", "severe-now-open", "severe-future", "moderate", "minor", "unknown"]);
  });
});
