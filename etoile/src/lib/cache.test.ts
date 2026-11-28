import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { eq } from "drizzle-orm";
import { cached, invalidateCached, peekCached, pruneCached } from "./cache";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  // The failure paths log on purpose; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
});

const MINUTE = 60_000;
const at = (ms: number) => new Date(Date.UTC(2026, 11, 1, 12, 0, 0) + ms);

describe("cached", () => {
  it("fetches once, then serves the stored value while it is fresh", async () => {
    const fetcher = vi.fn(async () => ({ tempF: 71, sky: "Clear" }));
    const first = await cached("fresh:orlando", 30 * MINUTE, fetcher, { now: at(0) });
    expect(first).toEqual({ ok: true, data: { tempF: 71, sky: "Clear" }, fetchedAt: at(0), stale: false });

    const second = await cached("fresh:orlando", 30 * MINUTE, fetcher, { now: at(29 * MINUTE) });
    expect(second).toEqual({ ok: true, data: { tempF: 71, sky: "Clear" }, fetchedAt: at(0), stale: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the lifetime has passed", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ({ n: ++n }));
    await cached("expiry", 10 * MINUTE, fetcher, { now: at(0) });
    expect((await cached("expiry", 10 * MINUTE, fetcher, { now: at(10 * MINUTE - 1) })).data).toEqual({ n: 1 });
    const refreshed = await cached("expiry", 10 * MINUTE, fetcher, { now: at(10 * MINUTE) });
    expect(refreshed).toEqual({ ok: true, data: { n: 2 }, fetchedAt: at(10 * MINUTE), stale: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good value when the fetcher fails, and says it is stale", async () => {
    const key = "stale:faa";
    await cached(key, 5 * MINUTE, async () => ({ delays: ["ORD"] }), { now: at(0) });

    const failing = vi.fn(async () => {
      throw new Error("FAA feed returned 503");
    });
    const result = await cached(key, 5 * MINUTE, failing, { now: at(6 * MINUTE) });
    expect(result).toEqual({ ok: true, data: { delays: ["ORD"] }, fetchedAt: at(0), stale: true });
    expect(failing).toHaveBeenCalledTimes(1);

    // The stored row still holds the good value and its original time.
    expect(await peekCached(key)).toMatchObject({ data: { delays: ["ORD"] }, fetchedAt: at(0), ok: false });
  });

  it("does not hammer a failing source: it waits before trying again", async () => {
    const key = "backoff";
    await cached(key, 5 * MINUTE, async () => "v1", { now: at(0) });
    const failing = vi.fn(async (): Promise<string> => {
      throw new Error("down");
    });
    await cached(key, 5 * MINUTE, failing, { now: at(6 * MINUTE) });
    // 30 seconds later: inside the default 60 s back-off, so the source is not called.
    const during = await cached(key, 5 * MINUTE, failing, { now: at(6 * MINUTE + 30_000) });
    expect(during).toMatchObject({ ok: true, data: "v1", stale: true });
    expect(failing).toHaveBeenCalledTimes(1);
    // After the back-off it tries again, and a recovery is fresh.
    const recovered = await cached(key, 5 * MINUTE, async () => "v2", { now: at(7 * MINUTE + 1) });
    expect(recovered).toEqual({ ok: true, data: "v2", fetchedAt: at(7 * MINUTE + 1), stale: false });
    expect((await cached(key, 5 * MINUTE, failing, { now: at(8 * MINUTE) })).stale).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("returns ok: false, without throwing, when the fetcher fails and there is no last good value", async () => {
    const failing = vi.fn(async (): Promise<{ x: number }> => {
      throw new Error("ENOTFOUND api.weather.example");
    });
    const result = await cached("never-good", 5 * MINUTE, failing, { now: at(0) });
    expect(result).toEqual({ ok: false, data: null, fetchedAt: null, stale: true, reason: "ENOTFOUND api.weather.example" });

    // Inside the back-off it answers without calling the source.
    const again = await cached("never-good", 5 * MINUTE, failing, { now: at(10_000) });
    expect(again).toMatchObject({ ok: false, data: null });
    expect(failing).toHaveBeenCalledTimes(1);

    // Later the source works: the first good value is stored.
    const good = await cached("never-good", 5 * MINUTE, async () => ({ x: 1 }), { now: at(2 * MINUTE) });
    expect(good).toEqual({ ok: true, data: { x: 1 }, fetchedAt: at(2 * MINUTE), stale: false });
  });

  it("never throws, whatever the fetcher throws", async () => {
    const odd: unknown[] = ["a string", 42, null, undefined, { message: "object" }, new TypeError("")];
    for (const [i, thrown] of odd.entries()) {
      const result = await cached(`odd:${i}`, MINUTE, async () => {
        throw thrown;
      }, { now: at(0) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.reason).toBe("string");
    }
    // A fetcher that resolves to nothing is a failure, not a value to cache.
    const nothing = await cached("odd:null", MINUTE, async () => null as unknown as string, { now: at(0) });
    expect(nothing.ok).toBe(false);
  });

  it("stores every JSON shape and gives it back unchanged", async () => {
    const values: unknown[] = [
      "plain text",
      42,
      0,
      false,
      [1, "two", { three: 3 }],
      { nested: { list: [{ a: 1 }], text: "é – ✓", nothing: null } },
    ];
    for (const [i, value] of values.entries()) {
      const key = `shapes:${i}`;
      await cached(key, MINUTE, async () => value, { now: at(0) });
      const fetcher = vi.fn(async () => "should not be called");
      const read = await cached(key, MINUTE, fetcher, { now: at(1000) });
      expect(read).toMatchObject({ ok: true, data: value, stale: false });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("shares one fetch between callers that arrive together", async () => {
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { calls };
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => cached("together", MINUTE, slow, { now: at(0) })));
    expect(calls).toBe(1);
    for (const r of results) expect(r).toMatchObject({ ok: true, data: { calls: 1 } });
  });

  it("keeps keys apart, and can forget one", async () => {
    await cached("apart:a", MINUTE, async () => "A", { now: at(0) });
    await cached("apart:b", MINUTE, async () => "B", { now: at(0) });
    expect((await cached("apart:a", MINUTE, async () => "x", { now: at(1) })).data).toBe("A");
    expect((await cached("apart:b", MINUTE, async () => "x", { now: at(1) })).data).toBe("B");

    await invalidateCached("apart:a");
    expect(await peekCached("apart:a")).toBeNull();
    expect((await cached("apart:a", MINUTE, async () => "A2", { now: at(2) })).data).toBe("A2");
    expect((await cached("apart:b", MINUTE, async () => "x", { now: at(2) })).data).toBe("B");
  });

  it("keeps exactly one row per key", async () => {
    for (let i = 0; i < 5; i++) await cached("one-row", MINUTE, async () => i, { now: at(i * 2 * MINUTE) });
    const rows = (await t.db.select().from(schema.signalCache)).filter((r) => r.key === "one-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toBe(4);
  });

  it("uses the real clock when no time is given", async () => {
    const before = Date.now();
    const result = await cached("real-clock", MINUTE, async () => "now");
    expect(result.ok && result.fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect((await cached("real-clock", MINUTE, async () => "later")).data).toBe("now");
  });
});

describe("a fetcher that never answers", () => {
  const never = () => new Promise<string>(() => {});

  it("is given up on after the time limit, and does not hold the callers that arrive behind it", async () => {
    const started = Date.now();
    const first = cached("hang:cold", MINUTE, never, { now: at(0), timeoutMs: 40, retryAfterMs: 0 });
    // A second caller arrives while the first is still waiting; its own fetcher is healthy.
    const healthy = vi.fn(async () => "healthy");
    const second = cached("hang:cold", MINUTE, healthy, { now: at(0), timeoutMs: 40 });

    const [a, b] = await Promise.all([first, second]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(a).toEqual({ ok: false, data: null, fetchedAt: null, stale: true, reason: "The fetcher did not answer within 40 ms" });
    expect(b).toEqual(a); // it shared the one attempt, and was let go with it
    expect(healthy).not.toHaveBeenCalled();

    // The key is free again: the next caller's fetcher runs.
    const third = await cached("hang:cold", MINUTE, healthy, { now: at(1) });
    expect(third).toEqual({ ok: true, data: "healthy", fetchedAt: at(1), stale: false });
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("gives the last good value back as stale, and backs off like any other failure", async () => {
    await cached("hang:warm", 5 * MINUTE, async () => ({ delays: ["ORD"] }), { now: at(0) });
    const hung = vi.fn(never);
    const result = await cached("hang:warm", 5 * MINUTE, hung, { now: at(6 * MINUTE), timeoutMs: 30 });
    expect(result).toEqual({ ok: true, data: { delays: ["ORD"] }, fetchedAt: at(0), stale: true });
    // Inside the back-off nobody waits on the source again.
    const again = await cached("hang:warm", 5 * MINUTE, hung, { now: at(6 * MINUTE + 10_000), timeoutMs: 30 });
    expect(again).toMatchObject({ ok: true, stale: true });
    expect(hung).toHaveBeenCalledTimes(1);
  });

  it("uses ten seconds when no limit, or a nonsense one, is given", async () => {
    vi.useFakeTimers();
    try {
      for (const [i, timeoutMs] of [undefined, Number.NaN, -5, 0, Number.POSITIVE_INFINITY].entries()) {
        let settled = false;
        const pending = cached(`hang:default:${i}`, MINUTE, never, { now: at(0), timeoutMs }).then((r) => ((settled = true), r));
        await vi.advanceTimersByTimeAsync(9_900);
        expect(settled, String(timeoutMs)).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        expect(await pending, String(timeoutMs)).toMatchObject({ ok: false, reason: "The fetcher did not answer within 10000 ms" });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fetcher that fails after it was given up on causes no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const late = () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("too late")), 60));
      const result = await cached("hang:late", MINUTE, late, { now: at(0), timeoutMs: 20 });
      expect(result).toMatchObject({ ok: false, reason: "The fetcher did not answer within 20 ms" });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("what comes back is the same on a fresh fetch and on a cache hit", () => {
  it("returns the JSON form of the value both times", async () => {
    const value = () => ({
      at: new Date("2026-12-19T22:41:00Z"),
      missing: undefined,
      notANumber: Number.NaN,
      lookup: new Map([["MCO", 1]]),
      reading: { get tempC() { return 22; } },
      list: [1, undefined, 3],
    });
    const fresh = await cached("json:same", MINUTE, async () => value(), { now: at(0) });
    const hit = await cached("json:same", MINUTE, async () => value(), { now: at(1000) });
    expect(fresh.ok && hit.ok).toBe(true);
    expect(fresh.data).toEqual(hit.data);
    // And that form is JSON's: a string for the Date, nothing for undefined, null for NaN.
    expect(fresh.data).toEqual({ at: "2026-12-19T22:41:00.000Z", notANumber: null, lookup: {}, reading: { tempC: 22 }, list: [1, null, 3] });
    expect(typeof (fresh.data as unknown as { at: unknown }).at).toBe("string");
    expect(fresh.data).not.toHaveProperty("missing");
  });

  it("gives every caller its own copy: changing one does not change the next", async () => {
    const source = { tags: ["a"] };
    const first = await cached("json:copy", MINUTE, async () => source, { now: at(0) });
    if (first.ok) first.data.tags.push("changed by a caller");
    expect(source.tags).toEqual(["a"]); // not the fetcher's own object
    const second = await cached("json:copy", MINUTE, async () => source, { now: at(1) });
    expect(second.data).toEqual({ tags: ["a"] });
  });

  it("treats a value JSON cannot hold as a failure, not as something to return once", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const unstorable: [string, unknown, RegExp][] = [
      ["bigint", { n: BigInt(5) }, /JSON cannot hold/],
      ["cycle", circular, /JSON cannot hold/],
      ["function", () => 1, /JSON cannot hold/],
      ["nan", Number.NaN, /returned nothing/],
      ["undefined", undefined, /returned nothing/],
    ];
    for (const [name, value, reason] of unstorable) {
      const fetcher = vi.fn(async () => value);
      const result = await cached(`json:bad:${name}`, MINUTE, fetcher, { now: at(0) });
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.reason, name).toMatch(reason);
      // It backs off instead of asking again at once.
      await cached(`json:bad:${name}`, MINUTE, fetcher, { now: at(1000) });
      expect(fetcher, name).toHaveBeenCalledTimes(1);
    }
  });

  it("still caches, in this process, a value the column refuses", async () => {
    // Postgres will not store U+0000 in jsonb. The write fails; the value is not fetched again.
    const fetcher = vi.fn(async () => ({ text: "nul\u0000inside" }));
    const first = await cached("json:nul", MINUTE, fetcher, { now: at(0) });
    const second = await cached("json:nul", MINUTE, fetcher, { now: at(30_000) });
    expect(first).toEqual({ ok: true, data: { text: "nul\u0000inside" }, fetchedAt: at(0), stale: false });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await peekCached("json:nul")).toBeNull(); // really was not stored
    // Once the lifetime has passed it is fetched again.
    await cached("json:nul", MINUTE, fetcher, { now: at(MINUTE) });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("a lifetime that is not a sensible number", () => {
  it("never switches the cache off", async () => {
    for (const lifetime of [Number.NaN, Number.POSITIVE_INFINITY, 1e15, 1e300, -1, Number.NEGATIVE_INFINITY]) {
      const key = `lifetime:${String(lifetime)}`;
      const fetcher = vi.fn(async () => "value");
      expect(await cached(key, lifetime, fetcher, { now: at(0) })).toMatchObject({ ok: true, data: "value" });
      expect(await cached(key, lifetime, fetcher, { now: at(30_000) }), key).toMatchObject({ ok: true, data: "value", stale: false });
      expect(fetcher, key).toHaveBeenCalledTimes(1);
      expect(await peekCached(key), key).not.toBeNull(); // stored, with a date the database accepts
    }
  });

  it("backs off a failing source even then", async () => {
    for (const [i, options] of [{ retryAfterMs: Number.NaN }, { retryAfterMs: Number.POSITIVE_INFINITY }, { retryAfterMs: -1 }].entries()) {
      const failing = vi.fn(async (): Promise<string> => {
        throw new Error("down");
      });
      await cached(`retry:odd:${i}`, Number.NaN, failing, { now: at(0), ...options });
      await cached(`retry:odd:${i}`, Number.NaN, failing, { now: at(30_000), ...options });
      expect(failing, String(i)).toHaveBeenCalledTimes(1);
    }
  });
});

describe("a refresh that fails", () => {
  it("does not put back the older value it read before fetching", async () => {
    const key = "race:newer";
    await cached(key, 5 * MINUTE, async () => ({ v: "old" }), { now: at(0) });
    // While this instance waits on the source, another instance stores a newer good value.
    const slowThenFails = async (): Promise<{ v: string }> => {
      await t.db
        .update(schema.signalCache)
        .set({ ok: true, payload: { v: "new" }, fetchedAt: at(6 * MINUTE), expiresAt: at(11 * MINUTE) })
        .where(eq(schema.signalCache.key, key));
      throw new Error("timed out");
    };
    const result = await cached(key, 5 * MINUTE, slowThenFails, { now: at(6 * MINUTE) });
    // The caller gets the newer value, and it is still what is stored, still marked good.
    expect(result).toEqual({ ok: true, data: { v: "new" }, fetchedAt: at(6 * MINUTE), stale: false });
    expect(await peekCached(key)).toEqual({ data: { v: "new" }, fetchedAt: at(6 * MINUTE), expiresAt: at(11 * MINUTE), ok: true });
    const next = await cached(key, 5 * MINUTE, async () => ({ v: "should not be fetched" }), { now: at(7 * MINUTE) });
    expect(next).toMatchObject({ data: { v: "new" }, stale: false });
  });

  it("keeps a newer value even when that one has expired too", async () => {
    const key = "race:newer-expired";
    await cached(key, MINUTE, async () => ({ v: "old" }), { now: at(0) });
    const fails = async (): Promise<{ v: string }> => {
      await t.db
        .update(schema.signalCache)
        .set({ ok: true, payload: { v: "newer" }, fetchedAt: at(3 * MINUTE), expiresAt: at(4 * MINUTE) })
        .where(eq(schema.signalCache.key, key));
      throw new Error("down");
    };
    const result = await cached(key, MINUTE, fails, { now: at(10 * MINUTE) });
    expect(result).toEqual({ ok: true, data: { v: "newer" }, fetchedAt: at(3 * MINUTE), stale: true });
    expect(await peekCached(key)).toMatchObject({ data: { v: "newer" }, fetchedAt: at(3 * MINUTE), ok: false, expiresAt: at(11 * MINUTE) });
  });
});

describe("pruneCached", () => {
  const DAY = 24 * 60 * MINUTE;

  it("removes rows nobody has asked for in a long time, and only those", async () => {
    const now = at(400 * DAY);
    await cached("prune:long-gone", MINUTE, async () => "a", { now: at(0) }); // a year ago
    await cached("prune:last-month", MINUTE, async () => "b", { now: new Date(now.getTime() - 31 * DAY) });
    await cached("prune:recent", MINUTE, async () => "c", { now: new Date(now.getTime() - 29 * DAY) });
    await cached("prune:fresh", DAY, async () => "d", { now });
    await cached("prune:forever", 50 * 365 * DAY, async () => "e", { now: at(0) });

    const before = (await t.db.select().from(schema.signalCache)).length;
    const removed = await pruneCached(30 * DAY, now);
    const after = (await t.db.select({ key: schema.signalCache.key }).from(schema.signalCache)).map((r) => r.key);
    expect(after).not.toContain("prune:long-gone");
    expect(after).not.toContain("prune:last-month");
    expect(after).toEqual(expect.arrayContaining(["prune:recent", "prune:fresh", "prune:forever"]));
    expect(before - after.length).toBe(removed);
    expect(removed).toBeGreaterThanOrEqual(2);
  });

  it("keeps the last good value of a key that is still being asked for, however long the source has been down", async () => {
    await cached("prune:in-use", MINUTE, async () => "last good", { now: at(0) });
    const failing = async (): Promise<string> => {
      throw new Error("down");
    };
    // Asked for once a week for a year, failing every time.
    for (let week = 1; week <= 52; week++) await cached("prune:in-use", MINUTE, failing, { now: at(week * 7 * DAY) });
    await pruneCached(30 * DAY, at(52 * 7 * DAY + DAY));
    expect(await cached("prune:in-use", MINUTE, failing, { now: at(52 * 7 * DAY + 2 * DAY) })).toEqual({ ok: true, data: "last good", fetchedAt: at(0), stale: true });
  });

  it("removes 200 one-off keys in one call", async () => {
    for (let i = 0; i < 200; i++) await cached(`prune:typed:${i}`, MINUTE, async () => i, { now: at(0) });
    expect(await pruneCached(30 * DAY, at(40 * DAY))).toBeGreaterThanOrEqual(200);
    expect((await t.db.select().from(schema.signalCache)).filter((r) => r.key.startsWith("prune:typed:"))).toEqual([]);
  });

  it("has an index to find old rows by", async () => {
    const { sql } = await import("drizzle-orm");
    const result = await t.db.execute(sql`select indexdef from pg_indexes where tablename = 'signal_cache'`);
    const defs = (result as unknown as { rows: { indexdef: string }[] }).rows.map((r) => r.indexdef);
    expect(defs.some((def) => /\(expires_at\)/.test(def))).toBe(true);
  });
});
