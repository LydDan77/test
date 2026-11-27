import "server-only";

import { createHash } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { newId } from "@/lib/ids";

// Fixed-window rate limiting on the rate_limits table. One atomic statement per check, so it
// is correct across server instances and concurrent requests.

export type RateLimitOptions = {
  /** How many attempts are allowed in one window. */
  limit: number;
  /** Length of the window in milliseconds. */
  windowMs: number;
  /** The current time. For tests; defaults to now. */
  now?: Date;
};

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
  if (flag === "1") return true;
  if (flag === "0") return false;
  return process.env.NODE_ENV === "development";
}

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
  if (rateLimitDisabled()) return { ok: true, remaining: limit, retryAfterMs: 0 };

  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const windowStartedBefore = new Date(now.getTime() - windowMs).toISOString();
  const t = schema.rateLimits;

  const db = await getDb();
  // The window has ended when it started at or before (now - windowMs).
  const ended = sql`${t.windowStart} <= ${windowStartedBefore}::timestamptz`;
  const [row] = await db
    .insert(t)
    .values({ id: newId(), key, count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        count: sql`case when ${ended} then 1 else ${t.count} + 1 end`,
        windowStart: sql`case when ${ended} then ${nowIso}::timestamptz else ${t.windowStart} end`,
        updatedAt: sql`${nowIso}::timestamptz`,
      },
    })
    .returning({ count: t.count, windowStart: t.windowStart });

  const windowEndsAt = row.windowStart.getTime() + windowMs;
  return {
    ok: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    retryAfterMs: Math.max(0, windowEndsAt - now.getTime()),
  };
}

/** Forgets the count for `key`: for example after a successful sign-in. */
export async function resetRateLimit(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.rateLimits).where(eq(schema.rateLimits.key, key));
}

/** Housekeeping: removes counters whose window started more than `olderThanMs` ago (default one day). */
export async function pruneRateLimits(olderThanMs = 24 * 60 * 60_000, now = new Date()): Promise<void> {
  const db = await getDb();
  await db.delete(schema.rateLimits).where(lt(schema.rateLimits.windowStart, new Date(now.getTime() - olderThanMs)));
}

/** "a minute", "5 minutes", "an hour", "2 hours": for the sentence that tells a person to wait. */
export function describeWait(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  if (minutes === 1) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
