import { describe, expect, it } from "vitest";
import { isId, isToken, newId, newToken } from "./ids";

describe("newId", () => {
  it("makes 12 lower-case characters that are safe in a URL", () => {
    for (let i = 0; i < 200; i++) {
      const id = newId();
      expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
      expect(encodeURIComponent(id)).toBe(id);
      expect(isId(id)).toBe(true);
    }
  });

  it("never uses the letters that are easy to misread", () => {
    const all = Array.from({ length: 500 }, newId).join("");
    expect(all).not.toMatch(/[ilou]/);
    expect(all).not.toMatch(/[A-Z]/);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 20_000 }, newId));
    expect(ids.size).toBe(20_000);
  });

  it("uses every symbol of its alphabet about equally", () => {
    const counts = new Map<string, number>();
    for (const ch of Array.from({ length: 4000 }, newId).join("")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    // 48,000 characters over 32 symbols is 1,500 each; allow a wide margin.
    for (const [, n] of counts) {
      expect(n).toBeGreaterThan(1200);
      expect(n).toBeLessThan(1800);
    }
  });
});

describe("isId", () => {
  it("rejects anything that is not the shape of an id", () => {
    for (const bad of ["", "abc", "ABCDEFGHJKMN", "0123456789ab ", "0123456789abi", "../../etc/pw", "0123456789a;", null, undefined, 12, {}]) {
      expect(isId(bad), String(bad)).toBe(false);
    }
    expect(isId("0123456789ab")).toBe(true);
  });
});

describe("newToken", () => {
  it("makes 43 base64url characters (256 bits)", () => {
    for (let i = 0; i < 100; i++) {
      const token = newToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(isToken(token)).toBe(true);
    }
  });

  it("does not repeat, and is not an id", () => {
    const tokens = new Set(Array.from({ length: 5000 }, newToken));
    expect(tokens.size).toBe(5000);
    expect(isId(newToken())).toBe(false);
    expect(isToken(newId())).toBe(false);
    expect(isToken("")).toBe(false);
    expect(isToken(null)).toBe(false);
  });
});
