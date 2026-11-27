import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { HTTP_DEFAULTS } from "../http";
import { airportStatusOf, type AirportEvent, type AirportStatus } from "../signals";
import { getAirportStatus, isPartialClosure, noticeValidity, parseDelayText, plainReason } from "./airport-status";
import { fixture, html, json, stubFetch, xml, type Scripted } from "./test-support";

// Fixtures:
//  real          faa-airport-events.json, faa-airport-status-information.xml (2026-11-26T00:07Z)
//  real          faa-airport-events.2026-11-27.json, faa-airport-status-information.2026-11-27.xml
//  reconstructed faa-airport-events.all-types.reconstructed.json and the two *.reconstructed.xml
//                files: real field names, invented values (ground stops, ground delays, deicing
//                and whole-airport closures were not active when the captures were taken).

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

const NOW = new Date("2026-11-26T00:08:00Z");
const MINUTE = 60_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const isJson = (url: URL) => url.pathname === "/api/airport-events";

/** Serves one body for the JSON document and another for the XML document. */
function faa(jsonAnswer: Scripted, xmlAnswer: Scripted = html("<html>not used</html>", 500)) {
  return stubFetch((url) => (isJson(url) ? jsonAnswer : xmlAnswer));
}

function eventsOf(status: AirportStatus): AirportEvent[] {
  if (status.state !== "events") throw new Error(`${status.airport} is ${status.state}`);
  return status.events;
}

describe("getAirportStatus, from the JSON document", () => {
  it("reports delays from the real capture and nothing for airports the FAA does not list", async () => {
    const stub = faa(json(fixture("faa-airport-events.json")));
    const result = await getAirportStatus(["FLL", "MIA", "ORD"], { now: NOW });
    expect(result).toMatchObject({ ok: true, stale: false, fetchedAt: NOW });
    expect(stub.calls.map((call) => call.url.href)).toEqual(["https://nasstatus.faa.gov/api/airport-events"]);

    const fll = airportStatusOf(result, "FLL");
    expect(fll).toEqual({
      state: "events",
      airport: "FLL",
      name: "Fort Lauderdale/Hollywood International",
      events: [
        {
          kind: "departure_delay",
          description: "Departures are running 16–30 minutes late because of weather, and getting longer.",
          reason: "weather",
          startsAt: null,
          endsAt: null,
          endsAtLocalText: null,
          delay: { minMinutes: 16, maxMinutes: 30, averageMinutes: 15, trend: "increasing" },
          extensionLikelihood: null,
          updatedAt: "2026-11-25T23:07:00.000Z",
        },
      ],
    });
    expect(eventsOf(airportStatusOf(result, "MIA"))[0]).toMatchObject({
      kind: "departure_delay",
      description: "Departures are running 1 hour 1 minute – 1 hour 15 minutes late because of weather, and getting longer.",
      delay: { minMinutes: 61, maxMinutes: 75, averageMinutes: 60, trend: "increasing" },
    });
    expect(airportStatusOf(result, "ORD")).toEqual({ state: "no_delays", airport: "ORD" });
  });

  it("never shows a notice for private aircraft as a closure: LAX, LAS and SAN are simply fine", async () => {
    faa(json(fixture("faa-airport-events.json")));
    const result = await getAirportStatus(["LAX", "LAS", "SAN"], { now: NOW });
    expect(result.ok && result.data.airports).toEqual([
      { state: "no_delays", airport: "LAX" },
      { state: "no_delays", airport: "LAS" },
      { state: "no_delays", airport: "SAN" },
    ]);
  });

  it("does the same for the next day's capture, where Honolulu is 'closed' only to one military aircraft type", async () => {
    faa(json(fixture("faa-airport-events.2026-11-27.json")));
    const result = await getAirportStatus(["HNL", "LAX", "LAS", "SAN"], { now: NOW });
    expect(result.ok && result.data.airports.map((airport) => airport.state)).toEqual(["no_delays", "no_delays", "no_delays", "no_delays"]);
  });

  it("answers in the order asked, once per airport, whatever the letter case, from places or codes", async () => {
    faa(json(fixture("faa-airport-events.json")));
    const result = await getAirportStatus([" mia ", "ORD", { iata: "FLL", countryCode: "US" }, "MIA", { iata: "ord" }, { countryCode: "US" }, ""], { now: NOW });
    expect(result.ok && result.data.airports.map((airport) => `${airport.airport}:${airport.state}`)).toEqual(["MIA:events", "ORD:no_delays", "FLL:events"]);
  });

  it("reads every kind of event (reconstructed: real field names, invented values)", async () => {
    faa(json(fixture("faa-airport-events.all-types.reconstructed.json")));
    const result = await getAirportStatus(["LGA", "SFO", "ORD", "SNA"], { now: NOW });

    expect(eventsOf(airportStatusOf(result, "LGA"))).toEqual([
      {
        kind: "ground_stop",
        description: "Flights heading here are being held at their departure airports because of heavy traffic.",
        reason: "heavy traffic",
        startsAt: "2026-11-16T23:05:00.000Z",
        endsAt: "2026-11-17T00:45:00.000Z",
        endsAtLocalText: null,
        delay: null,
        extensionLikelihood: "medium",
        updatedAt: "2026-11-16T23:06:10.000Z",
      },
    ]);

    // Most serious first: the ground delay programme before the arrival delay.
    const sfo = eventsOf(airportStatusOf(result, "SFO"));
    expect(sfo.map((event) => event.kind)).toEqual(["ground_delay", "arrival_delay"]);
    expect(sfo[0]).toMatchObject({
      description: "Flights heading here are being held before take-off because of low clouds, about 1 hour 38 minutes on average.",
      reason: "low clouds",
      endsAt: "2026-11-17T04:59:00.000Z",
      delay: { minMinutes: null, maxMinutes: null, averageMinutes: 98, trend: null },
    });
    expect(sfo[1]).toMatchObject({
      description: "Arrivals are running 31–45 minutes late because of low clouds, and easing.",
      delay: { minMinutes: 31, maxMinutes: 45, averageMinutes: 30, trend: "decreasing" },
    });

    expect(eventsOf(airportStatusOf(result, "ORD"))).toMatchObject([
      { kind: "deicing", description: "Planes are being de-iced before take-off, so expect a longer wait at the gate.", startsAt: "2026-11-16T21:30:00.000Z", reason: null },
    ]);
    // "DLY 0730-1415": shut for part of each day, which airlines plan around. Not a closure.
    expect(airportStatusOf(result, "SNA")).toEqual({ state: "no_delays", airport: "SNA" });
  });

  it("reports a closure that shuts the airport to everyone (reconstructed)", async () => {
    const quiet = { groundStop: null, groundDelay: null, airportClosure: null, freeForm: null, arrivalDelay: null, departureDelay: null, deicing: null };
    faa(
      json([
        { ...quiet, airportId: "MCO", airportLongName: "Orlando International", airportClosure: { airportId: "MCO", startTime: "2026-11-26T00:00:00Z", endTime: "2026-11-26T19:00:00Z", text: "DUE TO HURRICANE", updatedAt: "2026-11-25T22:10:00Z" } },
        { ...quiet, airportId: "TPA", airportLongName: "Tampa International", freeForm: { startTime: "2026-11-26T02:00:00Z", endTime: "2026-11-26T20:00:00Z", simpleText: "!TPA 11/041 TPA AD AP CLSD 2611260200-2611262000", text: "", updatedAt: null } },
        { ...quiet, airportId: "PIE", airportLongName: "St Pete-Clearwater", freeForm: { startTime: null, endTime: null, simpleText: "!PIE 11/007 PIE RWY 04/22 CLSD 2611260200-2611262000", text: "RWY 04/22", updatedAt: null } },
      ]),
    );
    const result = await getAirportStatus(["MCO", "TPA", "PIE"], { now: NOW });
    expect(eventsOf(airportStatusOf(result, "MCO"))).toMatchObject([
      { kind: "closure", description: "The airport is closed because of a tropical storm.", startsAt: "2026-11-26T00:00:00.000Z", endsAt: "2026-11-26T19:00:00.000Z" },
    ]);
    expect(eventsOf(airportStatusOf(result, "TPA"))).toMatchObject([{ kind: "closure", description: "The airport is closed.", endsAt: "2026-11-26T20:00:00.000Z" }]);
    // A closed runway is not a closed airport.
    expect(airportStatusOf(result, "PIE").state).toBe("no_delays");
  });

  it("reports no delays for everyone when the FAA lists nothing at all", async () => {
    faa(json([]));
    const result = await getAirportStatus(["ATL", "JFK"], { now: NOW });
    expect(result.ok && result.data.airports).toEqual([
      { state: "no_delays", airport: "ATL" },
      { state: "no_delays", airport: "JFK" },
    ]);
  });

  it("keeps one copy of the national feed for 60 seconds, for every airport", async () => {
    const stub = faa(json(fixture("faa-airport-events.json")));
    await getAirportStatus(["MIA"], { now: NOW });
    await getAirportStatus(["SEA", "FLL"], { now: later(59_000) });
    expect(stub.calls).toHaveLength(1);
    await getAirportStatus(["MIA"], { now: later(61_000) });
    expect(stub.calls).toHaveLength(2);
  });
});

describe("getAirportStatus, falling back to the XML document", () => {
  it("reads the XML when the JSON answer is an HTML block page", async () => {
    const stub = faa(html("<html><head><title>Access Denied</title></head><body>Access Denied</body></html>", 403), xml(fixture("faa-airport-status-information.xml")));
    const result = await getAirportStatus(["FLL", "MIA", "LAX", "ORD"], { now: NOW });
    expect(stub.calls.map((call) => call.url.pathname)).toEqual(["/api/airport-events", "/api/airport-status-information"]);
    expect(result).toMatchObject({ ok: true, stale: false, data: { feedUpdatedAt: "2026-11-26T00:06:59.000Z" } });

    expect(eventsOf(airportStatusOf(result, "FLL"))).toEqual([
      {
        kind: "departure_delay",
        description: "Departures are running 16–30 minutes late because of weather, and getting longer.",
        reason: "weather",
        startsAt: null,
        endsAt: null,
        endsAtLocalText: null,
        delay: { minMinutes: 16, maxMinutes: 30, averageMinutes: null, trend: "increasing" },
        extensionLikelihood: null,
        updatedAt: null,
      },
    ]);
    expect(eventsOf(airportStatusOf(result, "MIA"))[0].delay).toEqual({ minMinutes: 61, maxMinutes: 75, averageMinutes: null, trend: "increasing" });
    expect(airportStatusOf(result, "LAX")).toEqual({ state: "no_delays", airport: "LAX" }); // the private-aircraft notice again
    expect(airportStatusOf(result, "ORD").state).toBe("no_delays");
  });

  it.each([
    ["an HTML page with status 200", () => html("<!DOCTYPE html><html><body>Website Unavailable</body></html>")],
    ["a server error (not retried: the XML is the second try)", () => html("oops", 500)],
    ["broken JSON", () => json("[{")],
    ["a document missing one of the event fields", () => {
      const body = JSON.parse(fixture("faa-airport-events.json"));
      for (const airport of body) delete airport.departureDelay;
      return json(body);
    }],
    ["an object where the list should be", () => json({ message: "moved" })],
    ["a dropped connection", (): Scripted => "network-error"],
  ])("uses the XML after the JSON gives %s", async (_label, respond) => {
    const stub = faa(respond(), xml(fixture("faa-airport-status-information.xml")));
    const result = await getAirportStatus(["MIA"], { now: NOW });
    expect(airportStatusOf(result, "MIA").state).toBe("events");
    expect(stub.calls.filter((call) => isJson(call.url))).toHaveLength(1);
  });

  it("uses the XML after the JSON times out", async () => {
    HTTP_DEFAULTS.timeoutMs = 40;
    faa("hang", xml(fixture("faa-airport-status-information.xml")));
    expect(airportStatusOf(await getAirportStatus(["MIA"], { now: NOW }), "MIA").state).toBe("events");
  });

  it("reads every kind of XML row (reconstructed), and drops what is not about one airport", async () => {
    faa(html("down", 503), xml(fixture("faa-airport-status-information.all-types.reconstructed.xml")));
    const result = await getAirportStatus(["SFO", "EWR", "LGA", "MIA", "ORD", "SNA", "LAX", "FCAA05"], { now: NOW });

    expect(eventsOf(airportStatusOf(result, "SFO"))).toMatchObject([
      { kind: "ground_delay", reason: "low clouds", delay: { minMinutes: null, maxMinutes: 324, averageMinutes: 98, trend: null } },
    ]);
    expect(eventsOf(airportStatusOf(result, "EWR"))[0]).toMatchObject({ kind: "ground_delay", reason: "wind", delay: { averageMinutes: 43, maxMinutes: 127 } });
    expect(eventsOf(airportStatusOf(result, "LGA"))).toMatchObject([
      { kind: "ground_stop", reason: "heavy traffic", endsAt: null, endsAtLocalText: "7:45 pm EST", description: "Flights heading here are being held at their departure airports because of heavy traffic." },
    ]);
    expect(eventsOf(airportStatusOf(result, "MIA"))[0].kind).toBe("departure_delay");
    expect(eventsOf(airportStatusOf(result, "ORD"))[0]).toMatchObject({
      kind: "arrival_delay",
      reason: "snow and ice",
      description: "Arrivals are running 31–45 minutes late because of snow and ice, and easing.",
    });
    expect(airportStatusOf(result, "SNA").state).toBe("no_delays"); // closed for part of each day only
    expect(airportStatusOf(result, "LAX").state).toBe("no_delays");
    expect(airportStatusOf(result, "FCAA05")).toEqual({ state: "unavailable", airport: "FCAA05", why: "not_covered" }); // not an airport code
  });

  it("reads the XML with nothing active (reconstructed) and today's real XML as 'no delays'", async () => {
    faa(html("down", 503), xml(fixture("faa-airport-status-information.no-delays.reconstructed.xml")));
    const quiet = await getAirportStatus(["ATL"], { now: NOW });
    expect(quiet).toMatchObject({ ok: true, data: { airports: [{ state: "no_delays", airport: "ATL" }], feedUpdatedAt: "2026-11-26T09:12:03.000Z" } });

    await t.db.delete(schema.signalCache);
    faa(html("down", 503), xml(fixture("faa-airport-status-information.2026-11-27.xml")));
    const real = await getAirportStatus(["HNL", "LAX", "SAN", "LAS"], { now: NOW });
    expect(real.ok && real.data.feedUpdatedAt).toBe("2026-11-27T22:49:00.000Z");
    expect(real.ok && real.data.airports.every((airport) => airport.state === "no_delays")).toBe(true);
  });

  it("reports an XML closure of the whole airport with the notice's own dates (reconstructed)", async () => {
    const body =
      "<AIRPORT_STATUS_INFORMATION><Update_Time>Thu Nov 26 00:06:59 2026 GMT</Update_Time><Delay_type><Name>Airport Closures</Name><Airport_Closure_List>" +
      "<Airport><ARPT>TPA</ARPT><Reason>!TPA 11/041 TPA AD AP CLSD 2612302200-2701010600</Reason><Start>Dec 30 at 22:00 UTC.</Start><Reopen>Jan 01 at 06:00 UTC.</Reopen></Airport>" +
      "</Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>";
    faa(html("down", 503), xml(body));
    const result = await getAirportStatus(["TPA"], { now: NOW });
    // "Reopen: Jan 01" has no year; the notice says 2027.
    expect(eventsOf(airportStatusOf(result, "TPA"))).toMatchObject([{ kind: "closure", startsAt: "2026-12-30T22:00:00.000Z", endsAt: "2027-01-01T06:00:00.000Z" }]);
  });
});

describe("getAirportStatus, when the FAA cannot be read", () => {
  it("fails, and every airport is 'unavailable', never 'no delays'", async () => {
    const stub = faa(html(fixture("npr-error-403.html"), 403), html(fixture("npr-error-403.html"), 403));
    const result = await getAirportStatus(["MCO", "ORD"], { now: NOW });
    expect(result).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: null });
    if (!result.ok) expect(result.detail).toBe("FAA airport status: nasstatus.faa.gov/api/airport-events: HTTP 403; then nasstatus.faa.gov/api/airport-status-information: HTTP 403");
    expect(stub.calls).toHaveLength(2);
    expect(airportStatusOf(result, "MCO")).toEqual({ state: "unavailable", airport: "MCO", why: "source_down" });
    expect(airportStatusOf(result, "mco").state).toBe("unavailable");
  });

  it.each([
    ["HTML with status 200 from both", () => html("<html><body>Website Unavailable</body></html>")],
    ["both timing out", (): Scripted => "hang"],
    ["both unreachable", (): Scripted => "network-error"],
  ])("fails with %s", async (_label, respond) => {
    HTTP_DEFAULTS.timeoutMs = 40;
    stubFetch(respond);
    expect(await getAirportStatus(["MCO"], { now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("fails when the XML is cut off or is a different document", async () => {
    const whole = fixture("faa-airport-status-information.xml");
    faa(html("down", 503), xml(whole.slice(0, 500)));
    expect(await getAirportStatus(["MIA"], { now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
    await t.db.delete(schema.signalCache);
    faa(html("down", 503), xml("<rss><channel/></rss>"));
    expect(await getAirportStatus(["MIA"], { now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("uses the last good copy for ten minutes, marked stale, then stops", async () => {
    let healthy = true;
    stubFetch((url) => (healthy ? (isJson(url) ? json(fixture("faa-airport-events.json")) : html("x", 500)) : html("<html>Access Denied</html>", 403)));
    await getAirportStatus(["MIA"], { now: NOW });
    healthy = false;

    const stale = await getAirportStatus(["MIA", "ORD"], { now: later(5 * MINUTE) });
    expect(stale).toMatchObject({ ok: true, stale: true, fetchedAt: NOW });
    expect(airportStatusOf(stale, "MIA").state).toBe("events");
    expect(airportStatusOf(stale, "ORD").state).toBe("no_delays");

    const gone = await getAirportStatus(["MIA", "ORD"], { now: later(11 * MINUTE) });
    expect(gone).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: NOW });
    expect(airportStatusOf(gone, "ORD")).toEqual({ state: "unavailable", airport: "ORD", why: "source_down" });
  });

  it("recovers as soon as the FAA answers again", async () => {
    let healthy = false;
    stubFetch((url) => (healthy && isJson(url) ? json(fixture("faa-airport-events.json")) : html("down", 503)));
    expect((await getAirportStatus(["MIA"], { now: NOW })).ok).toBe(false);
    healthy = true;
    expect(await getAirportStatus(["MIA"], { now: later(2 * MINUTE) })).toMatchObject({ ok: true, stale: false, fetchedAt: later(2 * MINUTE) });
  });
});

describe("getAirportStatus, outside the United States", () => {
  it("answers 'unavailable, not covered' for a foreign airport, and never 'no delays'", async () => {
    const stub = faa(json(fixture("faa-airport-events.json")));
    const result = await getAirportStatus([{ iata: "CDG", countryCode: "FR" }, { iata: "MIA", countryCode: "US" }, { iata: "SJU", countryCode: "PR" }], { now: NOW });
    expect(result.ok && result.data.airports).toMatchObject([
      { state: "unavailable", airport: "CDG", why: "not_covered" },
      { state: "events", airport: "MIA" },
      { state: "no_delays", airport: "SJU" },
    ]);
    expect(stub.calls).toHaveLength(1);
  });

  it("asks the FAA nothing when no airport on the list is American, or the list is empty", async () => {
    const stub = faa(json(fixture("faa-airport-events.json")));
    const abroad = await getAirportStatus([{ iata: "LIS", countryCode: "PT" }, { iata: "NRT", countryCode: "jp" }], { now: NOW });
    expect(abroad).toEqual({
      ok: true,
      stale: false,
      fetchedAt: NOW,
      data: { feedUpdatedAt: null, airports: [{ state: "unavailable", airport: "LIS", why: "not_covered" }, { state: "unavailable", airport: "NRT", why: "not_covered" }] },
    });
    expect(await getAirportStatus([], { now: NOW })).toMatchObject({ ok: true, data: { airports: [] } });
    expect(stub.calls).toHaveLength(0);
  });

  it("treats a four-letter code as not covered rather than guessing", async () => {
    faa(json(fixture("faa-airport-events.json")));
    const result = await getAirportStatus(["KMIA"], { now: NOW });
    expect(airportStatusOf(result, "KMIA")).toEqual({ state: "unavailable", airport: "KMIA", why: "not_covered" });
  });

  it("says 'unavailable' for an airport that was not asked about", async () => {
    faa(json(fixture("faa-airport-events.json")));
    const result = await getAirportStatus(["MIA"], { now: NOW });
    expect(airportStatusOf(result, "FLL").state).toBe("unavailable");
  });
});

describe("reading the FAA's wording", () => {
  it("recognises closures that do not stop airline flights", () => {
    for (const notice of [
      "!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ATLANTIC AVIATION 310-258-9884 2605271826-2705281600",
      "!SAN 10/004 SAN AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC PPR 619-298-7704 2610011633-2701010800",
      "!HNL 11/428 HNL AD AP CLSD TO F-35 VTOL 2611261248-2712291800",
      "TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR 702-261-7775", // the JSON feed's shortened text
      "TO F-35 VTOL",
      "!XYZ 01/001 XYZ AD AP CLSD EXC EMERG ACFT",
      "!XYZ 01/002 XYZ AD AP CLSD NON-SKED ACFT",
      "!XYZ 01/003 XYZ AD AP CLSD GA ACFT",
      "!XYZ 01/004 XYZ AD AP CLSD PPR 555-0100",
      "!SNA 11/020 SNA AD AP CLSD DLY 0730-1415 2611150730-2611211415",
      "DLY 0730-1415",
    ]) {
      expect(isPartialClosure(notice), notice).toBe(true);
    }
  });

  it("lets a real closure through", () => {
    for (const notice of ["!TPA 11/041 TPA AD AP CLSD 2611260200-2611262000", "DUE TO HURRICANE", "", "!MCO 10/200 MCO AD AP CLSD DUE WX 2610090000-2610101200"]) {
      expect(isPartialClosure(notice), notice).toBe(false);
    }
  });

  it("reads the FAA's delay wording as minutes", () => {
    expect(parseDelayText("16 minutes")).toBe(16);
    expect(parseDelayText("1 minute")).toBe(1);
    expect(parseDelayText("1 hour and 1 minute")).toBe(61);
    expect(parseDelayText("1 hour and 15 minutes")).toBe(75);
    expect(parseDelayText("5 hours and 24 minutes")).toBe(324);
    expect(parseDelayText("2 hours")).toBe(120);
    expect(parseDelayText(" 1 Hour 5 Minutes ")).toBe(65);
    expect(parseDelayText("60")).toBe(60);
    expect(parseDelayText(98)).toBe(98);
    for (const nothing of [null, undefined, "", "soon", "minutes", "-5", Number.NaN, -3]) expect(parseDelayText(nothing)).toBeNull();
  });

  it("puts the FAA's reason codes in plain words, or leaves them out", () => {
    expect(plainReason("TM Initiatives:MIT:WX")).toBe("weather");
    expect(plainReason("WX:Low Ceilings")).toBe("low clouds");
    expect(plainReason("LOW CEILINGS")).toBe("low clouds");
    expect(plainReason("WX:Snow/Ice")).toBe("snow and ice");
    expect(plainReason("WEATHER / THUNDERSTORMS")).toBe("thunderstorms");
    expect(plainReason("WX:Fog")).toBe("fog");
    expect(plainReason("wind")).toBe("wind");
    expect(plainReason("VOLUME")).toBe("heavy traffic");
    expect(plainReason("airport volume")).toBe("heavy traffic");
    expect(plainReason("VOL:Multi-taxi")).toBe("heavy traffic");
    expect(plainReason("STAFFING")).toBe("staffing");
    expect(plainReason("RWY:Construction")).toBe("runway work");
    expect(plainReason("EQUIPMENT:Outage")).toBe("an equipment problem");
    for (const unclear of ["OTHER", "", null, undefined, "customer service", "training", "rewind"]) expect(plainReason(unclear)).toBeNull();
  });

  it("reads a notice's validity, which carries the year the Start and Reopen fields lack", () => {
    expect(noticeValidity("!LAX 05/277 LAX AD AP CLSD TO NON SKED 2605271826-2705281600")).toEqual({ startsAt: "2026-05-27T18:26:00.000Z", endsAt: "2027-05-28T16:00:00.000Z" });
    expect(noticeValidity("!XYZ 01/001 XYZ AD AP CLSD 2601011200-PERM")).toEqual({ startsAt: "2026-01-01T12:00:00.000Z", endsAt: null });
    expect(noticeValidity("!XYZ 01/001 XYZ AD AP CLSD 2601011200-2601021200EST")).toEqual({ startsAt: "2026-01-01T12:00:00.000Z", endsAt: "2026-01-02T12:00:00.000Z" });
    expect(noticeValidity("!XYZ 01/001 XYZ AD AP CLSD 2613451200-2601021200")).toEqual({ startsAt: null, endsAt: "2026-01-02T12:00:00.000Z" }); // month 13
    expect(noticeValidity("no dates here")).toEqual({ startsAt: null, endsAt: null });
  });
});
