import "server-only";

import type { z } from "zod";
import { cached, peekCached } from "@/lib/cache";
import type { UnitSystem } from "@/lib/domain";
import { addDays, localDateOf, zonedToUtc } from "@/lib/time";
import { fetchJson, HttpError } from "../http";
import type { SourceResult } from "../signals";
import { HOUR_MS, MINUTE_MS } from "./shared";

// What the two Open-Meteo sources (forecast, historical) share: unit parameters, reading the
// service's own error message, and standing back after it says we have asked too often.
//
// Open-Meteo counts requests per internet address, and a hosting provider's addresses are shared
// with strangers. So a 429 is ordinary here, and the right response is to stop asking for a
// while: the pause is kept in the shared cache, so every server instance honours it.

export type OpenMeteoService = "forecast" | "archive";

export const OPEN_METEO_BASE: Record<OpenMeteoService, string> = {
  forecast: "https://api.open-meteo.com/v1/forecast",
  archive: "https://archive-api.open-meteo.com/v1/archive",
};

/** The query parameters that make Open-Meteo answer in a person's units. */
export function unitParams(units: UnitSystem): Record<string, string> {
  return units === "imperial"
    ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch" }
    : { temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm" };
}

/** The unit strings Open-Meteo echoes back for each system, used to check the answer matches the question. */
export const ECHOED_TEMPERATURE_UNIT: Record<UnitSystem, string> = { imperial: "°F", metric: "°C" };

const pauseKey = (service: OpenMeteoService) => `v1:open-meteo:${service}:paused`;

/** Open-Meteo's own words from an error body: `{"error":true,"reason":"…"}`. */
export function openMeteoReason(error: HttpError): string | null {
  if (!error.body) return null;
  try {
    const parsed: unknown = JSON.parse(error.body);
    if (parsed && typeof parsed === "object" && "reason" in parsed && typeof parsed.reason === "string") return parsed.reason;
  } catch {
    // Not JSON: an HTML error page, most likely.
  }
  return null;
}

/**
 * How long to stop asking after a 429. Open-Meteo says which allowance ran out:
 * "Minutely…", "Hourly…" or "Daily API request limit exceeded. Please try again tomorrow."
 */
export function pauseLengthMs(error: HttpError, now: Date): number {
  const reason = (openMeteoReason(error) ?? "").toLowerCase();
  if (reason.includes("daily")) {
    // Until just after the next midnight UTC, when a daily count starts again.
    const tomorrow = addDays(localDateOf(now, "UTC"), 1);
    const resume = zonedToUtc(`${tomorrow}T00:05`, "UTC").getTime();
    return Math.max(15 * MINUTE_MS, resume - now.getTime());
  }
  if (reason.includes("hourly")) return HOUR_MS;
  if (reason.includes("minutely")) return 2 * MINUTE_MS;
  return Math.min(Math.max(error.retryAfterMs ?? 15 * MINUTE_MS, MINUTE_MS), 6 * HOUR_MS);
}

/** True while a service has told us we are over its allowance and the pause has not run out. */
export async function isOpenMeteoPaused(service: OpenMeteoService, now: Date): Promise<boolean> {
  try {
    const row = await peekCached<{ since: string }>(pauseKey(service));
    return row !== null && row.ok && row.data !== null && row.expiresAt.getTime() > now.getTime();
  } catch {
    // The cache table cannot be read: carry on as if there were no pause.
    return false;
  }
}

/**
 * GETs one Open-Meteo document. Use it instead of fetchJson for these hosts.
 *
 *  - While the service is paused after a 429, throws at once without sending anything.
 *  - On a 429, records the pause and throws; the request is not repeated.
 *  - On a 400, the thrown message carries Open-Meteo's own reason.
 */
export async function fetchOpenMeteo<S extends z.ZodType>(service: OpenMeteoService, url: string, schema: S, now: Date): Promise<z.infer<S>> {
  if (await isOpenMeteoPaused(service, now)) {
    throw new HttpError("rate_limited", `Open-Meteo ${service}: waiting after a rate limit, nothing was sent`, { status: 429 });
  }
  try {
    return await fetchJson(url, schema);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const reason = openMeteoReason(error);
    if (error.kind === "rate_limited") {
      const pauseMs = pauseLengthMs(error, now);
      await cached(pauseKey(service), pauseMs, async () => ({ since: now.toISOString(), reason: reason ?? "HTTP 429" }), { now });
    }
    if (!reason) throw error;
    throw new HttpError(error.kind, `${error.message}: ${reason}`, { status: error.status, retryAfterMs: error.retryAfterMs, body: error.body });
  }
}

/**
 * A failed result with its reason corrected to "rate_limited" while the service is paused.
 * (Inside the cache's own short wait after a failure, the original reason is no longer known.)
 */
export async function withPauseAsReason<T>(result: SourceResult<T>, service: OpenMeteoService, now: Date): Promise<SourceResult<T>> {
  if (result.ok || result.reason === "rate_limited") return result;
  return (await isOpenMeteoPaused(service, now)) ? { ...result, reason: "rate_limited" } : result;
}

/** Builds a request URL with its parameters in a fixed order, so equal questions give equal URLs. */
export function openMeteoUrl(service: OpenMeteoService, params: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) query.set(name, String(value));
  return `${OPEN_METEO_BASE[service]}?${query.toString()}`;
}
