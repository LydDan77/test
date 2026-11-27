import "server-only";

import { z } from "zod";
import { fetchJson, HttpError } from "../http";
import type {
  AlertCertainty,
  AlertPlace,
  AlertSeverity,
  AlertUrgency,
  SourceResult,
  WeatherAlert,
  WeatherAlertsSignal,
} from "../signals";
import { answer, failure, MINUTE_MS, neverThrow, readThroughCache, usablePoint, type SourceOptions } from "./shared";

// Official weather alerts from the US National Weather Service (https://api.weather.gov/,
// public domain: DATA_SOURCES.weatherAlerts). United States and its territories only.
//
// Alerts are safety information, so the shared copy for a place is refreshed every 2 minutes
// and is never shown more than 15 minutes old.

const NWS_ALERTS_URL = "https://api.weather.gov/alerts/active";

/** Country codes the service covers: the United States and its territories. */
const NWS_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP"]);

/** Zones that lie in the United States, for a place that carries no country code. */
const US_ZONES = new Set([
  "America/New_York", "America/Detroit", "America/Chicago", "America/Menominee", "America/Denver",
  "America/Boise", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "America/Juneau",
  "America/Sitka", "America/Metlakatla", "America/Yakutat", "America/Nome", "America/Adak",
  "Pacific/Honolulu", "America/Puerto_Rico", "America/St_Thomas", "Pacific/Guam", "Pacific/Saipan",
  "Pacific/Pago_Pago", "America/Indianapolis", "America/Louisville", "America/Fort_Wayne",
]);
const US_ZONE_PREFIXES = ["America/Indiana/", "America/Kentucky/", "America/North_Dakota/", "US/"];

/**
 * Whether the alert service can know anything about a place. The country code decides when the
 * place has one; otherwise the time zone does, so a US place that lost its country code still
 * gets its warnings.
 */
export function isCoveredByNws(place: AlertPlace): boolean {
  const country = place.countryCode?.trim().toUpperCase();
  if (country) return NWS_COUNTRIES.has(country);
  return US_ZONES.has(place.tz) || US_ZONE_PREFIXES.some((prefix) => place.tz.startsWith(prefix));
}

const text = z.string().nullish();

const alertsSchema = z.object({
  features: z.array(
    z.object({
      properties: z.object({
        id: z.string().min(1),
        event: z.string().min(1),
        status: text,
        messageType: text,
        severity: text,
        urgency: text,
        certainty: text,
        headline: text,
        areaDesc: text,
        sent: text,
        effective: text,
        onset: text,
        expires: text,
        ends: text,
        description: text,
        instruction: text,
        senderName: text,
      }),
    }),
  ),
});

const SEVERITIES: AlertSeverity[] = ["extreme", "severe", "moderate", "minor", "unknown"];
const URGENCIES: AlertUrgency[] = ["immediate", "expected", "future", "past", "unknown"];
const CERTAINTIES: AlertCertainty[] = ["observed", "likely", "possible", "unlikely", "unknown"];

function oneOf<T extends string>(allowed: readonly T[], value: string | null | undefined): T {
  const lower = (value ?? "").toLowerCase();
  return allowed.find((item) => item === lower) ?? (allowed[allowed.length - 1] as T);
}

function instant(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The service wraps its text at about 70 characters. Joins the lines back into paragraphs. */
function reflow(value: string | null | undefined): string | null {
  if (!value) return null;
  const paragraphs = value
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
  return paragraphs.length > 0 ? paragraphs.join("\n\n") : null;
}

/** Most severe first; then most urgent; then the one that ends soonest. */
export function sortAlerts(alerts: WeatherAlert[]): WeatherAlert[] {
  const end = (alert: WeatherAlert) => (alert.endsAt ? Date.parse(alert.endsAt) : Number.POSITIVE_INFINITY);
  return [...alerts].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      URGENCIES.indexOf(a.urgency) - URGENCIES.indexOf(b.urgency) ||
      end(a) - end(b) ||
      a.event.localeCompare(b.event),
  );
}

/** The service's answer as alerts. Exported for tests; use getWeatherAlerts(). */
export function alertsFromResponse(body: z.infer<typeof alertsSchema>): WeatherAlert[] {
  const byId = new Map<string, WeatherAlert>();
  for (const { properties: p } of body.features) {
    // Tests, exercises and drafts are not alerts; a cancellation says the alert is over.
    if ((p.status ?? "").toLowerCase() !== "actual") continue;
    const messageType = (p.messageType ?? "").toLowerCase();
    if (messageType === "cancel") continue;
    const startsAt = instant(p.onset) ?? instant(p.effective) ?? instant(p.sent);
    if (!startsAt) continue;
    byId.set(p.id, {
      id: p.id,
      event: p.event.trim(),
      severity: oneOf(SEVERITIES, p.severity),
      urgency: oneOf(URGENCIES, p.urgency),
      certainty: oneOf(CERTAINTIES, p.certainty),
      headline: p.headline?.trim() || null,
      area: (p.areaDesc ?? "").trim(),
      startsAt,
      // "ends" is when the hazard ends; "expires" is only when this message stops being
      // current, often hours earlier. Use the first, fall back to the second.
      endsAt: instant(p.ends) ?? instant(p.expires),
      description: reflow(p.description),
      instruction: reflow(p.instruction),
      sender: p.senderName?.trim() || null,
      isUpdate: messageType === "update",
    });
  }
  return sortAlerts([...byId.values()]);
}

async function fetchAlerts(point: { text: string }): Promise<WeatherAlertsSignal> {
  // Literal commas: the service checks the point against a pattern.
  const url = `${NWS_ALERTS_URL}?point=${point.text}&status=actual&message_type=alert,update`;
  try {
    const body = await fetchJson(url, alertsSchema, { headers: { Accept: "application/geo+json" } });
    return { coverage: "covered", alerts: alertsFromResponse(body) };
  } catch (error) {
    // A point outside the United States is refused with 400 "out of bounds": that is an
    // answer ("not covered"), not an outage.
    if (error instanceof HttpError && error.status === 400 && /out of bounds/i.test(error.body ?? "")) {
      return { coverage: "not_covered", alerts: [] };
    }
    throw error;
  }
}

/**
 * Official weather alerts in force at a place in the United States, most severe first.
 *
 *   const alerts = await getWeatherAlerts(plan.destination, { now });
 *   if (alerts.ok && alerts.data.coverage === "covered") alerts.data.alerts   // [] means none in force
 *
 * Three outcomes to keep apart:
 *  - `ok` with `coverage: "covered"`: the list is complete; empty means no alerts.
 *  - `ok` with `coverage: "not_covered"`: the place is outside the United States. Nothing is
 *    known, nothing was asked. Show nothing.
 *  - `ok: false`: the service could not be reached and there is no copy under 15 minutes old.
 *    Do not say "no alerts".
 *
 * "Until" is each alert's `endsAt` (the event's end when given, else the message's expiry).
 * Alerts whose end has passed are left out. One shared copy per place (to about a kilometre),
 * refreshed every 2 minutes.
 */
export async function getWeatherAlerts(place: AlertPlace, options: SourceOptions = {}): Promise<SourceResult<WeatherAlertsSignal>> {
  return neverThrow("weather alerts", async () => {
    const now = options.now ?? new Date();
    const point = usablePoint(place);
    if (!point) return failure("invalid_input", "The place has no coordinates or no valid time zone");
    if (!isCoveredByNws(place)) return answer({ coverage: "not_covered", alerts: [] }, now);

    const result = await readThroughCache(`v1:nws:alerts:${point.text}`, 2 * MINUTE_MS, () => fetchAlerts(point), {
      now,
      maxStaleMs: 15 * MINUTE_MS,
    });
    if (!result.ok) return result;

    const inForce = result.data.alerts.filter((alert) => alert.endsAt === null || Date.parse(alert.endsAt) > now.getTime());
    return { ...result, data: { coverage: result.data.coverage, alerts: inForce } };
  });
}
