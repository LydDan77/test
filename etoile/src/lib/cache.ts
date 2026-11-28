import "server-only";

import { eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { newId } from "@/lib/ids";

// A read-through cache on the signal_cache table that keeps the last good value.
//
// Every external feed (weather, airport delays, holidays, advisories, news) is read through
// here, so there is one shared copy per feed for all users and all server instances, and a
// provider that is down, or that never answers, does not take a page down with it.
//
// What "shared" does and does not mean: the stored value is shared by every instance. The
// fetch is shared only inside one instance (callers that arrive together wait for one call).
// Two instances that both find a key missing or expired at the same moment each call the
// source once; the later answer is the one that stays.

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
  /**
   * How long the fetcher may take (default 10 s). After that the attempt counts as a failure:
   * the last good value comes back as stale, and the next caller is not left waiting behind a
   * fetcher that never settles. Keep your own, shorter, timeout on the request itself as well,
   * so the connection is actually closed.
   */
  timeoutMs?: number;
  /** The current time. For tests; defaults to now. */
  now?: Date;
};

/** What a fetcher may return: anything JSON can hold. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** "Keep it for good" is spelled as a very long lifetime; a date further out than this is not one Postgres and JavaScript agree on. */
const MAX_LIFETIME_MS = 100 * 365 * DAY_MS;
const DEFAULT_PRUNE_AFTER_MS = 30 * DAY_MS;

type Stored = { ok: boolean; payload: unknown; fetchedAt: Date; expiresAt: Date };

// Two requests arriving together for the same key share one call to the source.
const inFlight = new Map<string, Promise<Cached<unknown>>>();

// What the table could be read for but would not take: a value the jsonb column refuses (text
// containing U+0000, for one). It is kept in this process so that the source is still not asked
// again before its time. Small and bounded: a stopgap, not a second cache. When the table
// cannot be reached at all there is no cache, here or anywhere: every call asks the source.
const remembered = new Map<string, Stored>();
const REMEMBERED_MAX = 200;

function remember(key: string, value: Stored): void {
  remembered.delete(key);
  remembered.set(key, value);
  while (remembered.size > REMEMBERED_MAX) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

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
 *  - `fetcher` throws, or takes longer than `timeoutMs`: the last good value comes back with
 *    `stale: true`, however old it is. With no last good value the result is `{ ok: false, reason }`.
 *  - Never throws, not even when the database cannot be read or written. With the table out of
 *    reach there is no cache: each call asks the source, and nothing is remembered.
 *
 * `fetcher` must return something JSON can hold, and what comes back is always the JSON form
 * of it, on the first call as on every later one: a Date is a string, `undefined` fields and
 * Map contents are gone, NaN is null. Code that works on a fresh fetch therefore works on a
 * cache hit. A value JSON cannot hold at all (a BigInt, a cycle, a bare `undefined` or `null`)
 * is a failure. Throw from `fetcher` to signal failure; do not return null for it.
 * Put everything that changes the answer in the key, and nothing personal: keys are shared.
 * `lifetimeMs` is a finite number of milliseconds; a value that is not (NaN, a negative number)
 * is logged and replaced by one minute, so a bad sum can never switch the cache off.
 */
export async function cached<T>(
  key: string,
  lifetimeMs: number,
  fetcher: () => Promise<T>,
  options: CachedOptions = {},
): Promise<Cached<T>> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<Cached<T>>;

  const run = readThrough(key, lifetimeMs, fetcher, options)
    .catch((error): Cached<T> => {
      // Nothing above should throw; if something does, the promise of "never throws" still holds.
      console.error(`[cache] unexpected failure for ${key}:`, describe(error));
      return { ok: false, data: null, fetchedAt: null, stale: true, reason: describe(error) };
    })
    .finally(() => {
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
  const lifetime = usableLifetime(key, lifetimeMs);
  const retryMs = Math.min(usableDuration(options.retryAfterMs, DEFAULT_RETRY_MS, true), lifetime);
  const timeoutMs = usableDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS, false);

  let row: Stored | undefined;
  let tableReachable = true;
  try {
    const db = await getDb();
    [row] = await db.select().from(schema.signalCache).where(eq(schema.signalCache.key, key)).limit(1);
  } catch (error) {
    // The cache table is unreachable: behave as if there were no cache.
    tableReachable = false;
    console.error(`[cache] read failed for ${key}:`, describe(error));
  }
  if (tableReachable) {
    // Something this process could not write is newer than whatever the table holds.
    const kept = remembered.get(key);
    if (kept && (!row || kept.expiresAt.getTime() > row.expiresAt.getTime())) row = kept;
  }

  if (row && row.expiresAt.getTime() > now.getTime()) {
    const waiting = answerFrom<T>(row, now);
    // The last attempt failed a moment ago and there is nothing to show: do not call the source again yet.
    return waiting ?? { ok: false, data: null, fetchedAt: null, stale: true, reason: "The source failed recently" };
  }

  let data: T;
  try {
    data = jsonCopy(await withDeadline(fetcher, timeoutMs)) as T;
  } catch (error) {
    const reason = describe(error);
    const current = await noteFailure(key, now, retryMs, row, tableReachable);
    return (current && answerFrom<T>(current, now)) ?? { ok: false, data: null, fetchedAt: null, stale: true, reason };
  }

  await store(key, { ok: true, payload: data, fetchedAt: now, expiresAt: new Date(now.getTime() + lifetime) }, tableReachable);
  return { ok: true, data, fetchedAt: now, stale: false };
}

/** The answer a stored row gives, or null when it holds no good value. */
function answerFrom<T>(row: Stored, now: Date): Cached<T> | null {
  // payload is null only when nothing has ever been fetched successfully.
  if (row.payload === null || row.payload === undefined) return null;
  const fresh = row.ok && row.expiresAt.getTime() > now.getTime();
  return { ok: true, data: row.payload as T, fetchedAt: row.fetchedAt, stale: !fresh };
}

function usableLifetime(key: string, lifetimeMs: number): number {
  if (lifetimeMs === Number.POSITIVE_INFINITY) return MAX_LIFETIME_MS;
  if (Number.isFinite(lifetimeMs) && lifetimeMs >= 0) return Math.min(lifetimeMs, MAX_LIFETIME_MS);
  console.error(`[cache] ${key}: lifetimeMs must be a number of milliseconds, got ${String(lifetimeMs)}; using ${DEFAULT_RETRY_MS} ms`);
  return DEFAULT_RETRY_MS;
}

function usableDuration(value: number | undefined, fallback: number, zeroAllowed: boolean): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || (value === 0 && !zeroAllowed)) return fallback;
  return Math.min(value, MAX_LIFETIME_MS);
}

/** Runs the fetcher, and gives up on it (without stopping it) after `timeoutMs`. */
function withDeadline<T>(fetcher: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The fetcher did not answer within ${timeoutMs} ms`)), timeoutMs);
    // A fetcher that never settles must not keep a finished script or test run alive.
    (timer as { unref?: () => void }).unref?.();
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(fetcher());
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    // Both branches are handled here, so a rejection that arrives after the deadline is not
    // an unhandled one.
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The value as the jsonb column will hand it back. Throws when there is nothing JSON can hold. */
function jsonCopy(value: unknown): unknown {
  if (value === undefined || value === null) throw new Error("The fetcher returned nothing");
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error(`The fetcher returned something JSON cannot hold: ${describe(error)}`);
  }
  if (text === undefined) throw new Error("The fetcher returned something JSON cannot hold");
  const copy: unknown = JSON.parse(text);
  if (copy === null) throw new Error("The fetcher returned nothing");
  return copy;
}

async function store(key: string, values: Stored, tableReachable: boolean): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insert(schema.signalCache)
      .values({ id: newId(), key, ...values })
      .onConflictDoUpdate({
        target: schema.signalCache.key,
        set: { ...values, updatedAt: sql`now()` },
      });
    remembered.delete(key);
  } catch (error) {
    console.error(`[cache] write failed for ${key}:`, describe(error));
    // The table answered a moment ago, so it is this value it will not take: keep it here.
    if (tableReachable) remember(key, values);
  }
}

/**
 * Records that a fetch failed: only the flag and when to try again. The stored value and its
 * time are never rewritten, so a newer value another instance stored while this one was
 * waiting on the source is kept, not replaced by the older one read before the fetch.
 * Returns the row as it now stands.
 */
async function noteFailure(
  key: string,
  now: Date,
  retryMs: number,
  before: Stored | undefined,
  tableReachable: boolean,
): Promise<Stored | undefined> {
  const expiresAt = new Date(now.getTime() + retryMs);
  const t = schema.signalCache;
  try {
    const db = await getDb();
    const [updated] = await db
      .insert(t)
      .values({ id: newId(), key, ok: false, payload: null, fetchedAt: now, expiresAt })
      .onConflictDoUpdate({
        target: t.key,
        set: { ok: false, expiresAt, updatedAt: sql`now()` },
        // Leave a row alone that someone else has just refreshed.
        setWhere: sql`${t.expiresAt} <= ${now.toISOString()}::timestamptz`,
      })
      .returning();
    remembered.delete(key);
    if (updated) return updated;
    const [current] = await db.select().from(t).where(eq(t.key, key)).limit(1);
    return current;
  } catch (error) {
    console.error(`[cache] write failed for ${key}:`, describe(error));
    const kept: Stored = { ok: false, payload: before?.payload ?? null, fetchedAt: before?.fetchedAt ?? now, expiresAt };
    if (tableReachable) remember(key, kept);
    return kept;
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
  remembered.delete(key);
  const db = await getDb();
  await db.delete(schema.signalCache).where(eq(schema.signalCache.key, key));
}

/**
 * Housekeeping: removes rows nobody has asked for in a long time, those whose time to refresh
 * passed more than `olderThanMs` ago (default 30 days). Keys carry coordinates, dates and what
 * people typed into a search box, so without this the table only ever grows.
 *
 * A key that is still being asked for is never removed, however long its source has been down:
 * each failed attempt moves its refresh time forward. Called at sign-in, with the other
 * housekeeping; safe to call from a scheduled job as well. Returns how many rows went.
 */
export async function pruneCached(olderThanMs = DEFAULT_PRUNE_AFTER_MS, now = new Date()): Promise<number> {
  const age = Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : DEFAULT_PRUNE_AFTER_MS;
  const db = await getDb();
  const removed = await db
    .delete(schema.signalCache)
    .where(lt(schema.signalCache.expiresAt, new Date(now.getTime() - age)))
    .returning({ id: schema.signalCache.id });
  return removed.length;
}
