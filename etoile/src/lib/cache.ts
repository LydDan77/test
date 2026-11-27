import "server-only";

import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { newId } from "@/lib/ids";

// A read-through cache on the signal_cache table that keeps the last good value.
//
// Every external feed (weather, airport delays, holidays, advisories, news) is read through
// here, so there is one shared copy per feed for all users and all server instances, and a
// provider that is down never takes a page down with it.

export type Cached<T> =
  | {
      ok: true;
      data: T;
      /** When `data` was fetched from the source. */
      fetchedAt: Date;
      /** True when `data` is past its lifetime and the latest attempt to refresh it failed. */
      stale: boolean;
    }
  | {
      /** The source failed and there has never been a good value. */
      ok: false;
      data: null;
      fetchedAt: null;
      stale: true;
      /** A short description for logs. Not wording for people. */
      reason: string;
    };

export type CachedOptions = {
  /**
   * After a failed fetch, wait this long before asking the source again (default 60 s, never
   * longer than the lifetime). Stops one broken provider being called on every request.
   */
  retryAfterMs?: number;
  /** The current time. For tests; defaults to now. */
  now?: Date;
};

const DEFAULT_RETRY_MS = 60_000;

// Two requests arriving together for the same key share one call to the source.
const inFlight = new Map<string, Promise<Cached<unknown>>>();

/**
 * Returns the cached value for `key`, fetching it when it is missing or older than `lifetimeMs`.
 *
 *   const forecast = await cached(`weather:${lat},${lon}`, 30 * 60_000, () => fetchForecast(lat, lon));
 *   if (!forecast.ok) return { ok: false, reason: forecast.reason };   // never had a value
 *   forecast.data; forecast.fetchedAt; forecast.stale;
 *
 * Rules:
 *  - Fresh value in the table: returned without calling `fetcher`.
 *  - Missing or expired: `fetcher` runs. On success the value is stored and returned.
 *  - `fetcher` throws: the last good value comes back with `stale: true`, however old it is.
 *    With no last good value the result is `{ ok: false, reason }`.
 *  - Never throws, not even when the database write fails.
 *
 * `fetcher` must return something JSON can hold (it is stored in a jsonb column, so a Date
 * comes back as a string). Throw from `fetcher` to signal failure; do not return null for it.
 * Put everything that changes the answer in the key, and nothing personal: keys are shared.
 */
export async function cached<T>(
  key: string,
  lifetimeMs: number,
  fetcher: () => Promise<T>,
  options: CachedOptions = {},
): Promise<Cached<T>> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<Cached<T>>;

  const run = readThrough(key, lifetimeMs, fetcher, options).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run as Promise<Cached<unknown>>);
  return run;
}

async function readThrough<T>(
  key: string,
  lifetimeMs: number,
  fetcher: () => Promise<T>,
  options: CachedOptions,
): Promise<Cached<T>> {
  const now = options.now ?? new Date();
  const retryMs = Math.min(options.retryAfterMs ?? DEFAULT_RETRY_MS, Math.max(0, lifetimeMs));

  type Row = typeof schema.signalCache.$inferSelect;
  let row: Row | undefined;
  try {
    const db = await getDb();
    [row] = await db.select().from(schema.signalCache).where(eq(schema.signalCache.key, key)).limit(1);
  } catch (error) {
    // The cache table is unreachable: behave as if there were no cache.
    console.error(`[cache] read failed for ${key}:`, describe(error));
  }

  // payload is null only when nothing has ever been fetched successfully.
  const lastGood = row && row.payload !== null && row.payload !== undefined ? row : undefined;
  const waiting = row ? row.expiresAt.getTime() > now.getTime() : false;

  if (row && waiting) {
    if (row.ok && lastGood) {
      return { ok: true, data: lastGood.payload as T, fetchedAt: lastGood.fetchedAt, stale: false };
    }
    // The last attempt failed a moment ago: do not call the source again yet.
    if (lastGood) return { ok: true, data: lastGood.payload as T, fetchedAt: lastGood.fetchedAt, stale: true };
    return { ok: false, data: null, fetchedAt: null, stale: true, reason: "The source failed recently" };
  }

  let data: T;
  try {
    data = await fetcher();
    if (data === undefined || data === null) throw new Error("The fetcher returned nothing");
  } catch (error) {
    const reason = describe(error);
    await write(key, {
      ok: false,
      // Keep the last good value and its time; only note the failure and when to retry.
      payload: lastGood ? lastGood.payload : null,
      fetchedAt: lastGood ? lastGood.fetchedAt : now,
      expiresAt: new Date(now.getTime() + retryMs),
    });
    if (lastGood) return { ok: true, data: lastGood.payload as T, fetchedAt: lastGood.fetchedAt, stale: true };
    return { ok: false, data: null, fetchedAt: null, stale: true, reason };
  }

  await write(key, { ok: true, payload: data, fetchedAt: now, expiresAt: new Date(now.getTime() + lifetimeMs) });
  return { ok: true, data, fetchedAt: now, stale: false };
}

async function write(
  key: string,
  values: { ok: boolean; payload: unknown; fetchedAt: Date; expiresAt: Date },
): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insert(schema.signalCache)
      .values({ id: newId(), key, ...values })
      .onConflictDoUpdate({
        target: schema.signalCache.key,
        set: { ...values, updatedAt: sql`now()` },
      });
  } catch (error) {
    console.error(`[cache] write failed for ${key}:`, describe(error));
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : "Unknown error";
}

/** Reads what is stored for `key` without fetching: for diagnostics and tests. */
export async function peekCached<T>(key: string): Promise<{ data: T | null; fetchedAt: Date; expiresAt: Date; ok: boolean } | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.signalCache).where(eq(schema.signalCache.key, key)).limit(1);
  if (!row) return null;
  return { data: (row.payload as T | null) ?? null, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt, ok: row.ok };
}

/** Forgets `key`, so the next cached() call fetches again. */
export async function invalidateCached(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.signalCache).where(eq(schema.signalCache.key, key));
}
