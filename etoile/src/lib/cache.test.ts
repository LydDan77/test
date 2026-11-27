import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { cached, invalidateCached, peekCached } from "./cache";

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
