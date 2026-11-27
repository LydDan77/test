import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import {
  describeWait,
  pruneRateLimits,
  rateLimit,
  rateLimitDisabled,
  rateLimitKey,
  resetRateLimit,
} from "./rate-limit";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const saved = { ...process.env };
afterEach(() => {
  process.env.RATE_LIMIT_DISABLED = saved.RATE_LIMIT_DISABLED;
  process.env.VERCEL = saved.VERCEL;
  if (saved.RATE_LIMIT_DISABLED === undefined) delete process.env.RATE_LIMIT_DISABLED;
  if (saved.VERCEL === undefined) delete process.env.VERCEL;
});

const MINUTE = 60_000;
const at = (ms: number) => new Date(Date.UTC(2026, 11, 1, 12, 0, 0) + ms);

describe("rateLimit", () => {
  it("allows up to the limit, then refuses", async () => {
    const key = rateLimitKey("test-basic", "a");
    const options = { limit: 3, windowMs: 10 * MINUTE };
    expect(await rateLimit(key, { ...options, now: at(0) })).toEqual({ ok: true, remaining: 2, retryAfterMs: 10 * MINUTE });
    expect(await rateLimit(key, { ...options, now: at(1000) })).toMatchObject({ ok: true, remaining: 1 });
    expect(await rateLimit(key, { ...options, now: at(2000) })).toMatchObject({ ok: true, remaining: 0 });
    const refused = await rateLimit(key, { ...options, now: at(3000) });
    expect(refused).toEqual({ ok: false, remaining: 0, retryAfterMs: 10 * MINUTE - 3000 });
    // Still refused later in the same window, and the wait shrinks.
    expect(await rateLimit(key, { ...options, now: at(9 * MINUTE) })).toEqual({ ok: false, remaining: 0, retryAfterMs: MINUTE });
  });

  it("starts counting again when the window ends", async () => {
    const key = rateLimitKey("test-window", "a");
    const options = { limit: 2, windowMs: MINUTE };
    await rateLimit(key, { ...options, now: at(0) });
    await rateLimit(key, { ...options, now: at(10) });
    expect((await rateLimit(key, { ...options, now: at(59_999) })).ok).toBe(false);
    // Exactly one window after the first attempt, the count starts again.
    expect(await rateLimit(key, { ...options, now: at(MINUTE) })).toEqual({ ok: true, remaining: 1, retryAfterMs: MINUTE });
    expect((await rateLimit(key, { ...options, now: at(MINUTE + 1) })).ok).toBe(true);
    expect((await rateLimit(key, { ...options, now: at(MINUTE + 2) })).ok).toBe(false);
  });

  it("keeps separate counts for separate keys", async () => {
    const options = { limit: 1, windowMs: MINUTE, now: at(0) };
    expect((await rateLimit(rateLimitKey("test-keys", "a"), options)).ok).toBe(true);
    expect((await rateLimit(rateLimitKey("test-keys", "b"), options)).ok).toBe(true);
    expect((await rateLimit(rateLimitKey("test-keys", "a"), options)).ok).toBe(false);
    expect((await rateLimit(rateLimitKey("test-other", "a"), options)).ok).toBe(true);
  });

  it("counts concurrent attempts exactly once each", async () => {
    const key = rateLimitKey("test-concurrent", "a");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimit(key, { limit: 5, windowMs: MINUTE, now: at(0) })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(15);
  });

  it("can be reset, for example after a successful sign-in", async () => {
    const key = rateLimitKey("test-reset", "a");
    const options = { limit: 1, windowMs: MINUTE, now: at(0) };
    await rateLimit(key, options);
    expect((await rateLimit(key, options)).ok).toBe(false);
    await resetRateLimit(key);
    expect((await rateLimit(key, options)).ok).toBe(true);
  });

  it("prunes counters whose window is long over", async () => {
    await rateLimit("prune:old", { limit: 1, windowMs: MINUTE, now: at(0) });
    await rateLimit("prune:new", { limit: 1, windowMs: MINUTE, now: at(48 * 60 * MINUTE) });
    await pruneRateLimits(24 * 60 * MINUTE, at(48 * 60 * MINUTE));
    const keys = (await t.db.select({ key: schema.rateLimits.key }).from(schema.rateLimits)).map((r) => r.key);
    expect(keys).toContain("prune:new");
    expect(keys).not.toContain("prune:old");
  });

  it("works against the real clock too", async () => {
    const key = rateLimitKey("test-real-clock", "a");
    expect((await rateLimit(key, { limit: 1, windowMs: MINUTE })).ok).toBe(true);
    const refused = await rateLimit(key, { limit: 1, windowMs: MINUTE });
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(MINUTE - 5000);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(MINUTE);
  });
});

describe("rateLimitKey", () => {
  it("keeps the scope readable and hashes who it is about", () => {
    const key = rateLimitKey("sign-in", "lydia@example.com", "203.0.113.9");
    expect(key).toMatch(/^sign-in:[0-9a-f]{32}$/);
    expect(key).not.toContain("lydia");
    expect(key).not.toContain("203.0.113.9");
    expect(rateLimitKey("sign-in", "lydia@example.com", "203.0.113.9")).toBe(key);
    expect(rateLimitKey("sign-in", "lydia@example.com", "203.0.113.10")).not.toBe(key);
    // Parts are separated, so ("ab", "c") and ("a", "bc") differ.
    expect(rateLimitKey("s", "ab", "c")).not.toBe(rateLimitKey("s", "a", "bc"));
    expect(rateLimitKey("s", null, undefined)).toMatch(/^s:[0-9a-f]{32}$/);
  });
});

describe("the off switch", () => {
  it("is on under tests, off with RATE_LIMIT_DISABLED=1, and cannot be turned off on Vercel", async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    delete process.env.VERCEL;
    expect(rateLimitDisabled()).toBe(false);

    process.env.RATE_LIMIT_DISABLED = "1";
    expect(rateLimitDisabled()).toBe(true);
    const key = rateLimitKey("test-disabled", "a");
    for (let i = 0; i < 5; i++) {
      expect(await rateLimit(key, { limit: 1, windowMs: MINUTE })).toEqual({ ok: true, remaining: 1, retryAfterMs: 0 });
    }

    process.env.VERCEL = "1";
    expect(rateLimitDisabled()).toBe(false);
  });
});

describe("describeWait", () => {
  it("rounds up to something a person can act on", () => {
    expect(describeWait(1)).toBe("a minute");
    expect(describeWait(60_000)).toBe("a minute");
    expect(describeWait(60_001)).toBe("2 minutes");
    expect(describeWait(15 * MINUTE)).toBe("15 minutes");
    expect(describeWait(59 * MINUTE + 1)).toBe("an hour");
    expect(describeWait(60 * MINUTE)).toBe("an hour");
    expect(describeWait(61 * MINUTE)).toBe("2 hours");
  });
});
