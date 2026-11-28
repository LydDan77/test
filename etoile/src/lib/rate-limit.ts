import "server-only";

import { createHash } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { newId } from "@/lib/ids";

// Fixed-window rate limiting on the rate_limits table. One atomic statement per check, so it
// is correct across server instances and concurrent requests. Time is the DATABASE's clock,
// read inside that statement: every instance judges a window by the same clock, so one whose
// own clock runs fast can neither reset everyone's count nor open a window that never ends.

export type RateLimitOptions = {
  /** How many attempts are allowed in one window. */
  limit: number;
  /** Length of the window in milliseconds. */
  windowMs: number;
  /** The current time. FOR TESTS ONLY: leave it out and the database's clock is used. */
  now?: Date;
};

/** The longest window: 366 days. */
const MAX_WINDOW_MS = 366 * 24 * 60 * 60_000;

export type RateLimitResult = {
  /** False when this attempt is over the limit and must be refused. */
  ok: boolean;
  /** Attempts left in the current window (0 when refused). */
  remaining: number;
  /** How long until the window ends and the count starts again. */
  retryAfterMs: number;
};

/**
 * True when rate limiting is switched off.
 *  - RATE_LIMIT_DISABLED=1 turns it off: the end-to-end test server sets this, because every
 *    test signs up from the same address.
 *  - Under `next dev` it is off unless RATE_LIMIT_DISABLED=0, so the shared development server
 *    never locks out the engineers and tools working against it.
 *  - On Vercel it is always on: the switch cannot be left off in production by accident.
 * Unit tests (Vitest) run with it on.
 */
export function rateLimitDisabled(): boolean {
  if (process.env.VERCEL) return false;
  const flag = process.env.RATE_LIMIT_DISABLED;
  const disabled = flag === "1" ? true : flag === "0" ? false : process.env.NODE_ENV === "development";
  if (disabled && process.env.NODE_ENV === "production" && !warnedDisabled) {
    warnedDisabled = true;
    console.warn(
      "[rate-limit] WARNING: RATE_LIMIT_DISABLED=1 in a production build. Every limit is OFF: sign-in, sign-up and guest " +
        "actions can be tried without end. This is only for the end-to-end test server on localhost.",
    );
  }
  return disabled;
}
let warnedDisabled = false;

/**
 * A key that names what is being limited without storing who: `scope` stays readable
 * ("sign-in"), the parts (an email, an IP address, a slug) are hashed together.
 *
 *   rateLimitKey("sign-in", email, ip)   // "sign-in:3f9a…"
 */
export function rateLimitKey(scope: string, ...parts: (string | null | undefined)[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `${scope}:${digest}`;
}

/**
 * Counts one attempt against `key` and says whether it is allowed.
 *
 *   const limit = await rateLimit(rateLimitKey("rsvp", slug, ip), { limit: 10, windowMs: 10 * 60_000 });
 *   if (!limit.ok) return { ok: false, error: "Too many tries. Wait a few minutes and try again." };
 *
 * The first attempt opens a window; attempts are counted until it ends, then the count starts
 * again. Call it BEFORE the expensive or sensitive work (password hashing, a passcode check).
 * Every public (guest) action must call this.
 */
export async function rateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const { limit, windowMs } = options;
  // A limit of NaN would allow nothing and a window of NaN would never end: both are mistakes
  // in the calling code, so say so plainly instead of failing somewhere inside the database.
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError(`rateLimit: limit must be a number of at least 1, got ${String(limit)}`);
  if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > MAX_WINDOW_MS) {
    throw new RangeError(`rateLimit: windowMs must be a number of milliseconds between 1 and ${MAX_WINDOW_MS}, got ${String(windowMs)}`);
  }
  if (options.now !== undefined && Number.isNaN(options.now.getTime())) throw new RangeError("rateLimit: now is not a valid date");
  if (rateLimitDisabled()) return { ok: true, remaining: limit, retryAfterMs: 0 };

  const t = schema.rateLimits;
  // The database's clock, unless a test supplies the time.
  const now = options.now ? sql`${options.now.toISOString()}::timestamptz` : sql`now()`;
  const windowLength = sql`make_interval(secs => ${windowMs / 1000}::double precision)`;
  // The window has ended when it started at or before (now - windowMs).
  const ended = sql`${t.windowStart} <= ${now} - ${windowLength}`;
  const epochMs = (value: SQL) => sql<number>`(extract(epoch from ${value}) * 1000)::double precision`.mapWith(Number);

  const db = await getDb();
  const [row] = await db
    .insert(t)
    .values({ id: newId(), key, count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        count: sql`case when ${ended} then 1 else ${t.count} + 1 end`,
        windowStart: sql`case when ${ended} then ${now} else ${t.windowStart} end`,
        updatedAt: now,
      },
    })
    .returning({ count: t.count, windowStartMs: epochMs(sql`${t.windowStart}`), nowMs: epochMs(now) });

  const windowEndsAt = row.windowStartMs + windowMs;
  return {
    ok: row.count <= limit,
    remaining: Math.max(0, Math.floor(limit) - row.count),
    // Never longer than the window itself, whatever the row says.
    retryAfterMs: Math.min(windowMs, Math.max(0, Math.round(windowEndsAt - row.nowMs))),
  };
}

/** Forgets the count for `key`: for example after a successful sign-in. */
export async function resetRateLimit(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.rateLimits).where(eq(schema.rateLimits.key, key));
}

/**
 * Housekeeping: removes counters whose window started more than `olderThanMs` ago (default one
 * day). Like rateLimit() it goes by the database's clock; `now` is for tests.
 */
export async function pruneRateLimits(olderThanMs = 24 * 60 * 60_000, now?: Date): Promise<void> {
  const age = Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : 24 * 60 * 60_000;
  const reference = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  const db = await getDb();
  await db
    .delete(schema.rateLimits)
    .where(sql`${schema.rateLimits.windowStart} < ${reference} - make_interval(secs => ${age / 1000}::double precision)`);
}

/** "a minute", "5 minutes", "an hour", "2 hours": for the sentence that tells a person to wait. */
export function describeWait(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  if (minutes === 1) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
