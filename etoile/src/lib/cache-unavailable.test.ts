import { afterEach, describe, expect, it, vi } from "vitest";

// The cache table cannot be reached at all: every getDb() call rejects.
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  getDb: async () => {
    throw new Error("connection refused");
  },
}));

import { getDb } from "@/db";
import { cached } from "./cache";

afterEach(() => vi.restoreAllMocks());

describe("cached, when the database is down", () => {
  it("really has no database in this file", async () => {
    await expect(getDb()).rejects.toThrow("connection refused");
  });

  it("still returns what the fetcher returned, and logs instead of throwing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cached("down:ok", 60_000, async () => ({ tempF: 71 }));
    expect(result).toMatchObject({ ok: true, data: { tempF: 71 }, stale: false });
    const messages = log.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("[cache] read failed for down:ok"))).toBe(true);
    expect(messages.some((m) => m.includes("[cache] write failed for down:ok"))).toBe(true);
  });

  it("returns ok: false, without throwing, when the fetcher fails too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cached("down:fail", 60_000, async () => {
      throw new Error("provider down");
    });
    expect(result).toEqual({ ok: false, data: null, fetchedAt: null, stale: true, reason: "provider down" });
  });
});
