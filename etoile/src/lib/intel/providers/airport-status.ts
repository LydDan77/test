import "server-only";

import { z } from "zod";
import { zonedToUtc } from "@/lib/time";
import { fetchJson, fetchXml, HttpError } from "../http";
import {
  formatMinuteRange,
  formatMinutes,
  type AirportEvent,
  type AirportEventKind,
  type AirportStatus,
  type AirportStatusSignal,
  type SourceResult,
} from "../signals";
import { answer, MINUTE_MS, neverThrow, readThroughCache, type SourceOptions } from "./shared";
import { childText, childrenNamed, type XmlElement } from "./xml";

// Airport status from the FAA's National Airspace System status service
// (https://nasstatus.faa.gov/, US government work: DATA_SOURCES.airportStatus).
//
// One document covers every US airport, so there is one shared copy for everyone, refreshed
// every 60 seconds while someone is looking. The JSON document the FAA's own dashboard reads is
// tried first; if it fails in any way (an HTML block page, a missing field), the older XML
// document is read instead.
//
// It knows about airports, not flights: it cannot see one flight, its gate or an airline's own
// delay. And it knows nothing outside the United States.

const FAA_JSON_URL = "https://nasstatus.faa.gov/api/airport-events";
const FAA_XML_URL = "https://nasstatus.faa.gov/api/airport-status-information";

/** A copy this old is shown no longer: after it the status is "unavailable". */
const MAX_STALE_MS = 10 * MINUTE_MS;

/** Countries and territories the FAA reports on. */
const FAA_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP"]);

/** The order the FAA's dashboard lists things in: most serious first. */
const KIND_ORDER: AirportEventKind[] = ["closure", "ground_stop", "ground_delay", "arrival_delay", "departure_delay", "deicing"];

type StoredAirport = { name: string | null; events: AirportEvent[] };
type StoredFeed = { via: "json" | "xml"; feedUpdatedAt: string | null; airports: Record<string, StoredAirport> };

// --- reading the FAA's wording ---------------------------------------------------------------

/**
 * True when a closure notice does not close the airport to airline flights: it shuts out only
 * some aircraft (private and non-scheduled flights, a military type), or allows exceptions, or
 * applies for part of each day. On the day this was researched every "closure" in the feed was
 * of this kind ("AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR…"). Such notices are dropped.
 */
export function isPartialClosure(notice: string): boolean {
  const text = notice.toUpperCase();
  return (
    /\bCLSD\s+TO\b/.test(text) ||
    /^\s*TO\b/.test(text) || // the JSON feed's "text" field starts after the word CLSD
    /\bNON[\s-]?SKED\b/.test(text) ||
    /\bGA\s+ACFT\b/.test(text) ||
    /\bEXC(EPT)?\b/.test(text) ||
    /\bPPR\b/.test(text) ||
    /\b(DLY|DAILY)\b/.test(text)
  );
}

const SAYS_AIRPORT_CLOSED = /\b(AP|AD|ARPT|AIRPORT)\s+(CLSD|CLOSED)\b/i;

/** "1 hour and 1 minute", "16 minutes", "2 hours", "60" as minutes. Null when it is none of those. */
export function parseDelayText(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const text = value.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(?:(\d+)\s*hours?)?(?:\s*(?:and\s*)?(\d+)\s*minutes?)?$/.exec(text);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

/** The FAA's reason codes ("TM Initiatives:MIT:WX", "WX:Low Ceilings", "VOLUME") in plain words, or null. */
export function plainReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.toLowerCase();
  if (/thunder|tstm/.test(text)) return "thunderstorms";
  if (/hurricane|tropical/.test(text)) return "a tropical storm";
  if (/snow|\bice\b|icing/.test(text)) return "snow and ice";
  if (/\bfog\b/.test(text)) return "fog";
  if (/ceiling/.test(text)) return "low clouds";
  if (/visib/.test(text)) return "poor visibility";
  if (/\bwinds?\b/.test(text)) return "wind";
  if (/\brain\b/.test(text)) return "rain";
  if (/\bwx\b|weather/.test(text)) return "weather";
  if (/\bvol\b|volume|demand/.test(text)) return "heavy traffic";
  if (/staff/.test(text)) return "staffing";
  if (/rwy|runway|construction|maintenance/.test(text)) return "runway work";
  if (/equip|outage|\beq\b/.test(text)) return "an equipment problem";
  return null;
}

function trendOf(value: string | null | undefined): "increasing" | "decreasing" | null {
  const text = (value ?? "").toLowerCase();
  return text === "increasing" ? "increasing" : text === "decreasing" ? "decreasing" : null;
}

function instant(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The validity at the end of a notice, "2605271826-2705281600" (yymmddhhmm, UTC), as instants. */
export function noticeValidity(notice: string): { startsAt: string | null; endsAt: string | null } {
  const match = /\b(\d{10})-(\d{10}|PERM)(?:EST)?\s*$/.exec(notice.trim());
  if (!match) return { startsAt: null, endsAt: null };
  const read = (stamp: string): string | null => {
    if (!/^\d{10}$/.test(stamp)) return null;
    const local = `20${stamp.slice(0, 2)}-${stamp.slice(2, 4)}-${stamp.slice(4, 6)}T${stamp.slice(6, 8)}:${stamp.slice(8, 10)}`;
    try {
      return zonedToUtc(local, "UTC").toISOString();
    } catch {
      return null;
    }
  };
  return { startsAt: read(match[1]), endsAt: read(match[2]) };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Thu Nov 26 00:06:59 2026 GMT" as an instant. */
function feedTime(value: string | null): string | null {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month === -1) return null;
  const local = `${match[6]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}T${match[3]}:${match[4]}:${match[5]}`;
  try {
    return zonedToUtc(local, "UTC").toISOString();
  } catch {
    return null;
  }
}

function describe(kind: AirportEventKind, delay: AirportEvent["delay"], reason: string | null): string {
  const because = reason ? ` because of ${reason}` : "";
  const trend = delay?.trend === "increasing" ? ", and getting longer" : delay?.trend === "decreasing" ? ", and easing" : "";
  const range = delay ? formatMinuteRange(delay.minMinutes, delay.maxMinutes) : null;
  switch (kind) {
    case "closure":
      return `The airport is closed${because}.`;
    case "ground_stop":
      return `Flights heading here are being held at their departure airports${because}.`;
    case "ground_delay":
      return delay?.averageMinutes
        ? `Flights heading here are being held before take-off${because}, about ${formatMinutes(delay.averageMinutes)} on average.`
        : `Flights heading here are being held before take-off${because}.`;
    case "arrival_delay":
      return `Arrivals are running ${range ? `${range} ` : ""}late${because}${trend}.`;
    case "departure_delay":
      return `Departures are running ${range ? `${range} ` : ""}late${because}${trend}.`;
    case "deicing":
      return "Planes are being de-iced before take-off, so expect a longer wait at the gate.";
  }
}

function event(kind: AirportEventKind, fields: Partial<Omit<AirportEvent, "kind" | "description">> & { rawReason?: string | null }): AirportEvent {
  const reason = plainReason(fields.rawReason);
  const delay = fields.delay ?? null;
  return {
    kind,
    description: describe(kind, delay, reason),
    reason,
    startsAt: fields.startsAt ?? null,
    endsAt: fields.endsAt ?? null,
    endsAtLocalText: fields.endsAtLocalText ?? null,
    delay,
    extensionLikelihood: fields.extensionLikelihood ?? null,
    updatedAt: fields.updatedAt ?? null,
  };
}

function addEvent(feed: StoredFeed, airportId: string, name: string | null, item: AirportEvent): void {
  const code = airportId.trim().toUpperCase();
  if (!code) return;
  const airport = (feed.airports[code] ??= { name: null, events: [] });
  if (name && !airport.name) airport.name = name;
  airport.events.push(item);
  airport.events.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

// --- the JSON document -----------------------------------------------------------------------

const text = z.string().nullish();
const minutes = z.union([z.string(), z.number()]).nullish();

const delaySchema = z
  .object({
    reason: text,
    arrivalDeparture: z.object({ type: text, min: text, max: text, trend: text }).nullish(),
    updateTime: text,
    averageDelay: minutes,
    trend: text,
  })
  .nullable();

// Each of the seven event keys must be present (null when nothing is happening). If the FAA
// renames or drops one, validation fails and the XML document is used instead of quietly
// reporting "no delays".
const jsonSchema = z.array(
  z.object({
    airportId: z.string().trim().min(2).max(5),
    airportLongName: text,
    groundStop: z.object({ startTime: text, endTime: text, impactingCondition: text, probabilityOfExtension: text, updatedAt: text }).nullable(),
    groundDelay: z.object({ startTime: text, endTime: text, avgDelay: minutes, impactingCondition: text, updatedAt: text }).nullable(),
    airportClosure: z.object({ startTime: text, endTime: text, text: text, updatedAt: text }).nullable(),
    freeForm: z.object({ startTime: text, endTime: text, simpleText: text, text: text, updatedAt: text }).nullable(),
    arrivalDelay: delaySchema,
    departureDelay: delaySchema,
    deicing: z.object({ eventTime: text }).nullable(),
  }),
);

/** The JSON document as events. Exported for tests; use getAirportStatus(). */
export function eventsFromJson(body: z.infer<typeof jsonSchema>): StoredFeed {
  const feed: StoredFeed = { via: "json", feedUpdatedAt: null, airports: {} };
  for (const airport of body) {
    const name = airport.airportLongName?.trim() || null;
    const add = (item: AirportEvent) => addEvent(feed, airport.airportId, name, item);

    const closure = airport.airportClosure;
    if (closure && !isPartialClosure(closure.text ?? "")) {
      add(event("closure", { startsAt: instant(closure.startTime), endsAt: instant(closure.endTime), updatedAt: instant(closure.updatedAt), rawReason: closure.text }));
    }
    // "Free form" entries are closure notices too: the FAA's dashboard prints them as
    // "Airport Closure". Keep one only when it closes the airport to everyone.
    const notice = airport.freeForm;
    if (notice) {
      const full = `${notice.simpleText ?? ""}`.trim();
      const partial = isPartialClosure(full) || isPartialClosure(notice.text ?? "");
      const saysClosed = full === "" || SAYS_AIRPORT_CLOSED.test(full);
      if (!partial && saysClosed) {
        add(event("closure", { startsAt: instant(notice.startTime), endsAt: instant(notice.endTime), updatedAt: instant(notice.updatedAt), rawReason: notice.text }));
      }
    }
    const stop = airport.groundStop;
    if (stop) {
      const likelihood = (stop.probabilityOfExtension ?? "").toLowerCase();
      add(
        event("ground_stop", {
          startsAt: instant(stop.startTime),
          endsAt: instant(stop.endTime),
          updatedAt: instant(stop.updatedAt),
          rawReason: stop.impactingCondition,
          extensionLikelihood: likelihood === "low" || likelihood === "medium" || likelihood === "high" ? likelihood : null,
        }),
      );
    }
    const program = airport.groundDelay;
    if (program) {
      add(
        event("ground_delay", {
          startsAt: instant(program.startTime),
          endsAt: instant(program.endTime),
          updatedAt: instant(program.updatedAt),
          rawReason: program.impactingCondition,
          delay: { minMinutes: null, maxMinutes: null, averageMinutes: parseDelayText(program.avgDelay), trend: null },
        }),
      );
    }
    for (const [kind, delay] of [["arrival_delay", airport.arrivalDelay], ["departure_delay", airport.departureDelay]] as const) {
      if (!delay) continue;
      add(
        event(kind, {
          updatedAt: instant(delay.updateTime),
          rawReason: delay.reason,
          delay: {
            minMinutes: parseDelayText(delay.arrivalDeparture?.min),
            maxMinutes: parseDelayText(delay.arrivalDeparture?.max),
            averageMinutes: parseDelayText(delay.averageDelay),
            trend: trendOf(delay.trend ?? delay.arrivalDeparture?.trend),
          },
        }),
      );
    }
    if (airport.deicing) add(event("deicing", { startsAt: instant(airport.deicing.eventTime) }));
  }
  return feed;
}

// --- the XML document (the back-up) ----------------------------------------------------------

/** The XML document as events. Exported for tests; use getAirportStatus(). */
export function eventsFromXml(root: XmlElement): StoredFeed {
  const feed: StoredFeed = { via: "xml", feedUpdatedAt: feedTime(childText(root, "Update_Time")), airports: {} };
  // The same kind of list can appear in more than one Delay_type block: read them all, and go
  // by the list element, not the block's name.
  for (const block of childrenNamed(root, "Delay_type")) {
    for (const list of childrenNamed(block, "Arrival_Departure_Delay_List")) {
      for (const row of childrenNamed(list, "Delay")) {
        const airportId = childText(row, "ARPT");
        if (!airportId) continue;
        for (const part of childrenNamed(row, "Arrival_Departure")) {
          const kind = (part.attributes.Type ?? "").toLowerCase() === "arrival" ? "arrival_delay" : "departure_delay";
          const min = parseDelayText(childText(part, "Min"));
          const max = parseDelayText(childText(part, "Max"));
          addEvent(feed, airportId, null, event(kind, { rawReason: childText(row, "Reason"), delay: { minMinutes: min, maxMinutes: max, averageMinutes: null, trend: trendOf(childText(part, "Trend")) } }));
        }
      }
    }
    for (const list of childrenNamed(block, "Airport_Closure_List")) {
      for (const row of childrenNamed(list, "Airport")) {
        const airportId = childText(row, "ARPT");
        const notice = childText(row, "Reason") ?? "";
        if (!airportId || isPartialClosure(notice)) continue;
        // Start and Reopen carry no year ("May 27 at 18:26 UTC."): the notice's own validity does.
        addEvent(feed, airportId, null, event("closure", { ...noticeValidity(notice) }));
      }
    }
    for (const list of childrenNamed(block, "Ground_Delay_List")) {
      for (const row of childrenNamed(list, "Ground_Delay")) {
        const airportId = childText(row, "ARPT");
        if (!airportId) continue;
        const delay = { minMinutes: null, maxMinutes: parseDelayText(childText(row, "Max")), averageMinutes: parseDelayText(childText(row, "Avg")), trend: null };
        addEvent(feed, airportId, null, event("ground_delay", { rawReason: childText(row, "Reason"), delay }));
      }
    }
    for (const list of childrenNamed(block, "Ground_Stop_List")) {
      for (const row of childrenNamed(list, "Program")) {
        const airportId = childText(row, "ARPT");
        if (!airportId) continue;
        addEvent(feed, airportId, null, event("ground_stop", { rawReason: childText(row, "Reason"), endsAtLocalText: childText(row, "End_Time") }));
      }
    }
    // Airspace flow programs and CTOP entries are not about one airport: left out.
  }
  return feed;
}

async function fetchFeed(): Promise<StoredFeed> {
  let jsonFailure: HttpError;
  try {
    // No second try here: the XML document is the second try.
    return eventsFromJson(await fetchJson(FAA_JSON_URL, jsonSchema, { retries: 0 }));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    jsonFailure = error;
  }
  try {
    return eventsFromXml(await fetchXml(FAA_XML_URL, { root: "AIRPORT_STATUS_INFORMATION" }));
  } catch (error) {
    const xmlFailure = error instanceof Error ? error.message : "failed";
    throw new HttpError(jsonFailure.kind, `FAA airport status: ${jsonFailure.message}; then ${xmlFailure}`, { status: jsonFailure.status });
  }
}

// --- the question ----------------------------------------------------------------------------

/** An airport to ask about: its three-letter code, or a place that carries one (a PlaceRef fits). */
export type AirportQuery = string | { iata?: string; countryCode?: string };

/**
 * FAA status for a list of US airports.
 *
 *   const result = await getAirportStatus(["MCO", "ORD"], { now });
 *   const mco = airportStatusOf(result, "MCO");   // from ../signals: always one of three states
 *
 * Each airport is in exactly one state (see AirportStatus): "no_delays", "events" with what is
 * happening, or "unavailable". Pass the three-letter code the airline uses ("LAX", not "KLAX").
 * Pass places rather than bare codes when you have them: an airport whose `countryCode` is
 * outside the United States is answered "unavailable" (`why: "not_covered"`) instead of a
 * misleading "no delays". A bare code is taken to be a US airport.
 *
 * One shared copy of the national feed, refreshed every 60 seconds. If the FAA cannot be read,
 * the last copy is used for up to 10 minutes (`stale: true`); after that the result is
 * `ok: false` with `lastGoodAt`, which airportStatusOf() reports as "unavailable". Never show
 * "no delays" for a failed result.
 */
export async function getAirportStatus(airports: readonly AirportQuery[], options: SourceOptions = {}): Promise<SourceResult<AirportStatusSignal>> {
  return neverThrow("airport status", async () => {
    const now = options.now ?? new Date();

    const asked = new Map<string, { covered: boolean }>();
    for (const query of airports) {
      const code = (typeof query === "string" ? query : (query.iata ?? "")).trim().toUpperCase();
      if (!code || asked.has(code)) continue;
      const country = typeof query === "string" ? undefined : query.countryCode?.trim().toUpperCase();
      asked.set(code, { covered: /^[A-Z0-9]{3}$/.test(code) && (country === undefined || country === "" || FAA_COUNTRIES.has(country)) });
    }

    const notCovered = (code: string): AirportStatus => ({ state: "unavailable", airport: code, why: "not_covered" });
    if (![...asked.values()].some((entry) => entry.covered)) {
      // Nothing the FAA could know about: no request at all.
      return answer({ airports: [...asked.keys()].map(notCovered), feedUpdatedAt: null }, now);
    }

    const feed = await readThroughCache("v1:faa:airport-status", MINUTE_MS, fetchFeed, { now, maxStaleMs: MAX_STALE_MS });
    if (!feed.ok) return feed;

    const statuses = [...asked.entries()].map(([code, entry]): AirportStatus => {
      if (!entry.covered) return notCovered(code);
      const found = feed.data.airports[code];
      if (!found || found.events.length === 0) return { state: "no_delays", airport: code };
      return { state: "events", airport: code, name: found.name, events: found.events };
    });
    return { ok: true, data: { airports: statuses, feedUpdatedAt: feed.data.feedUpdatedAt }, fetchedAt: feed.fetchedAt, stale: feed.stale };
  });
}
