import { scryptSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDummyHash, hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("round-trips and rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword("correct horse battery stapler", stored)).toEqual({ ok: false, needsRehash: false });
  });

  it("uses a fresh salt every time", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toEqual(b);
  });

  it("accepts a hash made with weaker parameters and asks for a rehash", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("old password", salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const legacy = ["scrypt", 2 ** 14, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
    expect(await verifyPassword("old password", legacy)).toEqual({ ok: true, needsRehash: true });
  });

  it("rejects malformed or hostile stored values without throwing", async () => {
    for (const bad of ["", "plain", "scrypt$0$8$1$AAAA$AAAA", "scrypt$1073741824$8$1$AAAA$AAAA", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword("x", bad)).toEqual({ ok: false, needsRehash: false });
    }
  });
});

describe("password hashing, further cases", () => {
  it("treats differently typed forms of the same characters as one password (NFKC)", async () => {
    const composed = "café-au-lait"; // é as one code point
    const decomposed = "café-au-lait"; // e + combining accent
    const stored = await hashPassword(composed);
    expect((await verifyPassword(decomposed, stored)).ok).toBe(true);
  });

  it("keeps spaces and case significant", async () => {
    const stored = await hashPassword("Correct Horse ");
    expect((await verifyPassword("Correct Horse ", stored)).ok).toBe(true);
    expect((await verifyPassword("Correct Horse", stored)).ok).toBe(false);
    expect((await verifyPassword("correct horse ", stored)).ok).toBe(false);
  });

  it("hands out one dummy hash per process, and nothing verifies against it by accident", async () => {
    const dummy = await getDummyHash();
    expect(await getDummyHash()).toBe(dummy);
    expect(dummy).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect((await verifyPassword("", dummy)).ok).toBe(false);
    expect((await verifyPassword("password", dummy)).ok).toBe(false);
  });
});
