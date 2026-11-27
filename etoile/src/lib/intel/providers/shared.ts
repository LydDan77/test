import "server-only";

import { cached } from "@/lib/cache";
import { isValidTimeZone } from "@/lib/time";
import { HttpError } from "../http";
import type { SourceFailure, SourceFailureReason, SourceResult, WeatherPlace } from "../signals";

// What every provider module shares: reading through the signal cache, turning any failure into
// a SourceResult, and rounding coordinates for cache keys.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Options every provider function accepts. */
export type SourceOptions = {
  /** The current time. Pass the request's `now`; tests pass a fixed date. Defaults to the clock. */
  now?: Date;
};

export function failure(reason: SourceFailureReason, detail: string, lastGoodAt: Date | null = null): SourceFailure {
  return { ok: false, reason, detail, lastGoodAt };
}

/** An answer that needed no request (a place the source does not cover, for instance). */
export function answer<T>(data: T, now: Date): SourceResult<T> {
  return { ok: true, data, fetchedAt: now, stale: false };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : "Unknown error";
}

function reasonFor(error: unknown): SourceFailureReason {
  return error instanceof HttpError && error.kind === "rate_limited" ? "rate_limited" : "unavailable";
}

/**
 * Runs a provider's work so that nothing it does can throw to the caller: a bug or an
 * unexpected value becomes `{ ok: false, reason: "unavailable" }` and a line in the log.
 */
export async function neverThrow<T>(source: string, work: () => Promise<SourceResult<T>>): Promise<SourceResult<T>> {
  try {
    return await work();
  } catch (error) {
    console.error(`[intel] ${source} failed unexpectedly:`, describe(error));
    return failure("unavailable", describe(error));
  }
}

/**
 * Reads `key` through the shared signal cache and shapes the outcome as a SourceResult.
 *
 *  - Fresh in the cache: returned without calling `fetcher`.
 *  - Expired or missing: `fetcher` runs; it must throw to signal failure.
 *  - `fetcher` threw: the last good value comes back with `stale: true`, unless it is older
 *    than `maxStaleMs`, in which case the result is a failure that carries `lastGoodAt`.
 *  - A failure is never stored as data.
 */
export async function readThroughCache<T>(
  key: string,
  lifetimeMs: number,
  fetcher: () => Promise<T>,
  options: { now: Date; retryAfterMs?: number; maxStaleMs?: number },
): Promise<SourceResult<T>> {
  let thrown: unknown;
  const result = await cached<T>(
    key,
    lifetimeMs,
    async () => {
      try {
        return await fetcher();
      } catch (error) {
        thrown = error;
        throw error;
      }
    },
    { now: options.now, retryAfterMs: options.retryAfterMs },
  );
  if (!result.ok) return failure(reasonFor(thrown), result.reason);

  const fetchedAt = result.fetchedAt instanceof Date ? result.fetchedAt : new Date(result.fetchedAt);
  const age = options.now.getTime() - fetchedAt.getTime();
  if (result.stale && options.maxStaleMs !== undefined && age > options.maxStaleMs) {
    return failure(reasonFor(thrown), "The source is failing and its last good answer is too old to show", fetchedAt);
  }
  return { ok: true, data: result.data, fetchedAt, stale: result.stale };
}

/** A coordinate rounded to two decimals (about a kilometre): close places share one cached answer. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100 + 0; // "+ 0" turns -0 into 0
}

export type UsablePoint = {
  lat: number;
  lon: number;
  tz: string;
  /** "41.88,-87.63": for cache keys and for the request itself, so the key decides the answer. */
  text: string;
};

/** The place as a rounded point, or null when it has no usable coordinates or zone. */
export function usablePoint(place: WeatherPlace): UsablePoint | null {
  const { lat, lon, tz } = place;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (!isValidTimeZone(tz)) return null;
  const roundedLat = roundCoordinate(lat);
  const roundedLon = roundCoordinate(lon);
  return { lat: roundedLat, lon: roundedLon, tz, text: `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}` };
}

/** True for a two-letter country code, in either case. */
export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim());
}
