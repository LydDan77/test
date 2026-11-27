import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { HttpError } from "../http";
import { answer, failure, isCountryCode, neverThrow, readThroughCache, roundCoordinate, usablePoint } from "./shared";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.delete(schema.signalCache);
});
afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-27T12:00:00Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);

describe("readThroughCache", () => {
  it("returns a fresh value with the time it was fetched", async () => {
    expect(await readThroughCache("k:fresh", 10 * MINUTE, async () => ({ n: 1 }), { now: NOW })).toEqual({ ok: true, data: { n: 1 }, fetchedAt: NOW, stale: false });
  });

  it("serves the stored value without calling the source while it is fresh", async () => {
    const source = vi.fn(async () => ({ n: 1 }));
    await readThroughCache("k:stored", 10 * MINUTE, source, { now: NOW });
    const again = await readThroughCache("k:stored", 10 * MINUTE, source, { now: at(9) });
    expect(again).toEqual({ ok: true, data: { n: 1 }, fetchedAt: NOW, stale: false });
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last good value when the source throws, and says it is stale", async () => {
    await readThroughCache("k:fallback", 10 * MINUTE, async () => ["good"], { now: NOW });
    const result = await readThroughCache<string[]>("k:fallback", 10 * MINUTE, async () => {
      throw new HttpError("status", "example.org/feed: HTTP 503", { status: 503 });
    }, { now: at(30) });
    expect(result).toEqual({ ok: true, data: ["good"], fetchedAt: NOW, stale: true });
  });

  it("stops offering a stale value once it is older than the limit, but says when it was last good", async () => {
    await readThroughCache("k:limit", 10 * MINUTE, async () => "good", { now: NOW });
    const failing = async (): Promise<string> => {
      throw new Error("down");
    };
    expect(await readThroughCache("k:limit", 10 * MINUTE, failing, { now: at(59), maxStaleMs: 60 * MINUTE })).toMatchObject({ ok: true, stale: true });
    expect(await readThroughCache("k:limit", 10 * MINUTE, failing, { now: at(61), maxStaleMs: 60 * MINUTE })).toEqual({
      ok: false,
      reason: "unavailable",
      detail: "The source is failing and its last good answer is too old to show",
      lastGoodAt: NOW,
    });
    // A fresh value is never refused for its age: the limit is about stale ones.
    expect(await readThroughCache("k:limit", 10 * MINUTE, async () => "new", { now: at(120), maxStaleMs: MINUTE })).toEqual({ ok: true, data: "new", fetchedAt: at(120), stale: false });
  });

  it("reports why the source failed when nothing is stored", async () => {
    const limited = await readThroughCache("k:limited", MINUTE, async () => {
      throw new HttpError("rate_limited", "example.org/feed: HTTP 429, asked to slow down", { status: 429 });
    }, { now: NOW });
    expect(limited).toEqual({ ok: false, reason: "rate_limited", detail: "example.org/feed: HTTP 429, asked to slow down", lastGoodAt: null });

    const broken = await readThroughCache("k:broken", MINUTE, async () => {
      throw new HttpError("content_type", "example.org/feed: expected XML, got an HTML page");
    }, { now: NOW });
    expect(broken).toMatchObject({ ok: false, reason: "unavailable", detail: "example.org/feed: expected XML, got an HTML page" });
  });

  it("never stores a failure as data", async () => {
    await readThroughCache("k:nodata", MINUTE, async () => {
      throw new Error("down");
    }, { now: NOW });
    const rows = await t.db.select().from(schema.signalCache);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "k:nodata", ok: false, payload: null });
  });

  it("waits as long as it is told before asking a failing source again", async () => {
    const source = vi.fn(async (): Promise<string> => {
      throw new Error("down");
    });
    await readThroughCache("k:wait", 60 * MINUTE, source, { now: NOW, retryAfterMs: 10 * MINUTE });
    await readThroughCache("k:wait", 60 * MINUTE, source, { now: at(9), retryAfterMs: 10 * MINUTE });
    expect(source).toHaveBeenCalledTimes(1);
    await readThroughCache("k:wait", 60 * MINUTE, source, { now: at(11), retryAfterMs: 10 * MINUTE });
    expect(source).toHaveBeenCalledTimes(2);
  });
});

describe("neverThrow", () => {
  it("passes a result through", async () => {
    const result = answer({ n: 1 }, NOW);
    expect(await neverThrow("test", async () => result)).toBe(result);
  });

  it("turns a bug into a failure and a line in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await neverThrow("forecast", async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'daily')");
    });
    expect(result).toEqual({ ok: false, reason: "unavailable", detail: "Cannot read properties of undefined (reading 'daily')", lastGoodAt: null });
    expect(log).toHaveBeenCalledWith("[intel] forecast failed unexpectedly:", "Cannot read properties of undefined (reading 'daily')");
  });

  it("copes with anything thrown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const thrown of ["text", 42, null, undefined, { odd: true }]) {
      const result = await neverThrow("test", async () => {
        throw thrown;
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe("small helpers", () => {
  it("builds failures and ready-made answers", () => {
    expect(failure("invalid_input", "no coordinates")).toEqual({ ok: false, reason: "invalid_input", detail: "no coordinates", lastGoodAt: null });
    expect(answer("x", NOW)).toEqual({ ok: true, data: "x", fetchedAt: NOW, stale: false });
  });

  it("rounds coordinates to two decimals without a negative zero", () => {
    expect(roundCoordinate(41.8781)).toBe(41.88);
    expect(roundCoordinate(-87.6298)).toBe(-87.63);
    expect(Object.is(roundCoordinate(-0.001), 0)).toBe(true);
  });

  it("turns a place into a point with a stable text form", () => {
    expect(usablePoint({ lat: 41.8781, lon: -87.6298, tz: "America/Chicago" })).toEqual({ lat: 41.88, lon: -87.63, tz: "America/Chicago", text: "41.88,-87.63" });
    expect(usablePoint({ lat: -0.001, lon: 0.004, tz: "UTC" })?.text).toBe("0.00,0.00");
    expect(usablePoint({ lat: -33.9, lon: 151.2, tz: "Australia/Sydney" })?.text).toBe("-33.90,151.20");
    expect(usablePoint({ lat: 90, lon: -180, tz: "UTC" })?.text).toBe("90.00,-180.00");
  });

  it("refuses places it cannot use", () => {
    for (const place of [{ tz: "UTC" }, { lat: 1, tz: "UTC" }, { lon: 1, tz: "UTC" }, { lat: 90.1, lon: 0, tz: "UTC" }, { lat: 0, lon: -180.1, tz: "UTC" }, { lat: Number.POSITIVE_INFINITY, lon: 0, tz: "UTC" }, { lat: 1, lon: 1, tz: "" }, { lat: 1, lon: 1, tz: "Nowhere/Land" }]) {
      expect(usablePoint(place), JSON.stringify(place)).toBeNull();
    }
  });

  it("recognises two-letter country codes", () => {
    for (const good of ["US", "pt", " GB "]) expect(isCountryCode(good), good).toBe(true);
    for (const bad of ["USA", "U", "", "U1", "ÜS", null, undefined, 42]) expect(isCountryCode(bad), String(bad)).toBe(false);
  });
});
