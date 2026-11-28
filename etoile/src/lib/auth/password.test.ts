import { scryptSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { HASH_LIMITS, PasswordBusyError, getDummyHash, hashPassword, hashingLoad, isPasswordBusy, verifyPassword } from "./password";

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

  it("hands out one dummy hash, at today's cost, and nothing verifies against it by accident", async () => {
    const dummy = await getDummyHash();
    expect(await getDummyHash()).toBe(dummy);
    // The same settings as a real hash, so checking against it costs what a real check costs.
    const real = await hashPassword("anything at all");
    expect(dummy.split("$").slice(0, 4)).toEqual(real.split("$").slice(0, 4));
    expect(dummy).toMatch(/^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await verifyPassword("", dummy)).toEqual({ ok: false, needsRehash: false });
    expect((await verifyPassword("password", dummy)).ok).toBe(false);
  });

  it("has the dummy hash ready at once: the first unknown email costs one hash, not two", async () => {
    const started = performance.now();
    await getDummyHash();
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("how much hashing runs at once", () => {
  const saved = { ...HASH_LIMITS };
  afterEach(() => Object.assign(HASH_LIMITS, saved));

  it("is two by default, with room for a short queue", () => {
    expect(HASH_LIMITS).toEqual({ concurrent: 2, queue: 32, waitMs: 5_000 });
  });

  it("runs no more than the limit at a time, and everyone still gets an answer", async () => {
    let most = 0;
    const watch = setInterval(() => (most = Math.max(most, hashingLoad().running)), 5);
    try {
      const all = Promise.all(Array.from({ length: 6 }, (_, i) => hashPassword(`password number ${i}`)));
      // The other four are waiting their turn, not hashing.
      expect(hashingLoad()).toEqual({ running: 2, waiting: 4 });
      const hashes = await all;
      expect(new Set(hashes).size).toBe(6);
      expect(most).toBe(2);
      expect(hashingLoad()).toEqual({ running: 0, waiting: 0 });
    } finally {
      clearInterval(watch);
    }
  });

  it("turns callers away at once when the queue is full, and the ones in it are still served", async () => {
    Object.assign(HASH_LIMITS, { concurrent: 1, queue: 2, waitMs: 5_000 });
    const served = [hashPassword("a"), hashPassword("b"), hashPassword("c")]; // one running, two waiting
    const started = performance.now();
    const refused = await hashPassword("d").then(() => null, (error: unknown) => error);
    expect(performance.now() - started).toBeLessThan(100); // no hash was computed for it
    expect(refused).toBeInstanceOf(PasswordBusyError);
    expect(isPasswordBusy(refused)).toBe(true);
    expect(isPasswordBusy(new Error("something else"))).toBe(false);
    await expect(verifyPassword("x", await served[0])).resolves.toMatchObject({ ok: false });
    expect((await Promise.all(served)).every((hash) => hash.startsWith("scrypt$"))).toBe(true);
    expect(hashingLoad()).toEqual({ running: 0, waiting: 0 });
  });

  it("gives up on a turn that does not come within the wait, and leaves the queue tidy", async () => {
    Object.assign(HASH_LIMITS, { concurrent: 1, queue: 5, waitMs: 20 });
    const first = hashPassword("slow one"); // about 0.4 s
    const second = await hashPassword("waits 20 ms").then(() => null, (error: unknown) => error);
    expect(second).toBeInstanceOf(PasswordBusyError);
    expect(hashingLoad()).toEqual({ running: 1, waiting: 0 });
    await first;
    expect(hashingLoad()).toEqual({ running: 0, waiting: 0 });
    // And the slot is free again afterwards.
    await expect(hashPassword("next")).resolves.toMatch(/^scrypt\$/);
  });
});
