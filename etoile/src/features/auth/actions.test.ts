import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stand-ins for the request: a cookie jar and request headers. Like a browser, the jar drops a
// cookie that is set with maxAge 0, and remembers how it was asked to.
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
const removals: { name: string; options?: Record<string, unknown> }[] = [];
const requestHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (options?.maxAge === 0) {
        removals.push({ name, options });
        jar.delete(name);
      } else jar.set(name, { value, options });
    },
    delete: () => {
      throw new Error("cookies().delete() must not be used: it cannot remove a __Host- cookie");
    },
  }),
  headers: async () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
// redirect() throws inside Next; here it throws something the tests can read.
class Redirect extends Error {
  constructor(public url: string) {
    super(`REDIRECT ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
const seedExamplePlan = vi.fn<(user: { id: string }) => Promise<void>>(async () => {});
vi.mock("@/features/plans/seed", () => ({ seedExamplePlan: (user: { id: string }) => seedExamplePlan(user) }));

import { eq } from "drizzle-orm";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { DEVICE_COOKIE } from "@/lib/auth/device";
import { HASH_LIMITS, verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, getUser } from "@/lib/auth/session";
import { cached, peekCached } from "@/lib/cache";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { changePassword, signIn, signOut, signOutEverywhere, signUp } from "./actions";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => {
  jar.clear();
  removals.length = 0;
  requestHeaders.clear();
  // One reverse proxy of our own in front: the entry it appended is the visitor's address.
  vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
  requestHeaders.set("x-forwarded-for", "203.0.113.7");
  seedExamplePlan.mockClear();
  seedExamplePlan.mockImplementation(async () => {});
});
afterEach(() => vi.unstubAllEnvs());

/** The request now comes from this address. */
const from = (address: string) => requestHeaders.set("x-forwarded-for", address);
/** How many tries are counted against a key right now. */
async function counted(key: string): Promise<number> {
  const [row] = await t.db.select().from(schema.rateLimits).where(eq(schema.rateLimits.key, key));
  return row?.count ?? 0;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** Runs an action that is expected to finish with redirect(); returns where it went. */
async function redirectOf(run: Promise<unknown>): Promise<string> {
  const outcome = await run.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if ("error" in outcome && outcome.error instanceof Redirect) return outcome.error.url;
  throw new Error(`Expected a redirect, got ${JSON.stringify(outcome)}`);
}

const PASSWORD = "correct horse battery staple";

describe("signUp", () => {
  it("creates the account, its home place and home clock, signs the person in and goes to Home", async () => {
    const to = await redirectOf(
      signUp(null, form({ name: "  Lydia Hartley ", email: " Lydia@Example.COM ", password: PASSWORD, timeZone: "America/Chicago", locale: "en-US" })),
    );
    expect(to).toBe("/");

    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "lydia@example.com"));
    expect(user).toMatchObject({
      name: "Lydia Hartley",
      email: "lydia@example.com", // trimmed and lower-cased
      home: { kind: "home", name: "Chicago", tz: "America/Chicago" },
      units: "imperial",
      currency: "USD",
      timeStyle: "12h_with_24h",
      militaryStyle: "1441",
      exampleState: "seeded",
    });
    // Stored as a scrypt hash, never as typed.
    expect(user.passwordHash).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, user.passwordHash)).toEqual({ ok: true, needsRehash: false });

    const clocks = await t.db.select().from(schema.clocks).where(eq(schema.clocks.userId, user.id));
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ isHome: true, source: "manual", place: { kind: "home", name: "Chicago", tz: "America/Chicago" } });

    // Signed in: the cookie resolves to the new user.
    expect(jar.get(SESSION_COOKIE)?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect((await getUser())?.id).toBe(user.id);

    // The example plan hook is called once, with the new user and without the password hash.
    expect(seedExamplePlan).toHaveBeenCalledTimes(1);
    expect(seedExamplePlan.mock.calls[0][0]).toMatchObject({ id: user.id });
    expect(seedExamplePlan.mock.calls[0][0]).not.toHaveProperty("passwordHash");
  });

  it("takes units and currency from the browser's language", async () => {
    await redirectOf(signUp(null, form({ name: "Amélie", email: "amelie@example.com", password: PASSWORD, timeZone: "Europe/Paris", locale: "fr-FR" })));
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "amelie@example.com"));
    expect(user).toMatchObject({ units: "metric", currency: "EUR", home: { kind: "home", name: "Paris", tz: "Europe/Paris" } });
  });

  it("falls back when the browser sent no usable time zone", async () => {
    await redirectOf(signUp(null, form({ name: "No JS", email: "nojs@example.com", password: PASSWORD })));
    const [plain] = await t.db.select().from(schema.users).where(eq(schema.users.email, "nojs@example.com"));
    expect(plain.home).toEqual({ kind: "home", name: "UTC", tz: "UTC" });

    // A forged or legacy value is not stored.
    await redirectOf(signUp(null, form({ name: "Odd", email: "odd@example.com", password: PASSWORD, timeZone: "EST" })));
    const [odd] = await t.db.select().from(schema.users).where(eq(schema.users.email, "odd@example.com"));
    expect(odd.home.tz).toBe("UTC");
    // Nor is a fixed offset under its Etc name.
    await redirectOf(signUp(null, form({ name: "Fixed", email: "fixed@example.com", password: PASSWORD, timeZone: "Etc/GMT+5" })));
    const [fixed] = await t.db.select().from(schema.users).where(eq(schema.users.email, "fixed@example.com"));
    expect(fixed.home.tz).toBe("UTC");
    // A zone sent in the wrong letter case is stored the usual way, and named properly.
    await redirectOf(signUp(null, form({ name: "Lower", email: "lower@example.com", password: PASSWORD, timeZone: "america/chicago" })));
    const [lower] = await t.db.select().from(schema.users).where(eq(schema.users.email, "lower@example.com"));
    expect(lower.home).toEqual({ kind: "home", name: "Chicago", tz: "America/Chicago" });

    // On Vercel the platform's own guess is used before UTC.
    requestHeaders.set("x-vercel-ip-timezone", "America/Denver");
    await redirectOf(signUp(null, form({ name: "Geo", email: "geo@example.com", password: PASSWORD, timeZone: "<script>" })));
    const [geo] = await t.db.select().from(schema.users).where(eq(schema.users.email, "geo@example.com"));
    expect(geo.home).toEqual({ kind: "home", name: "Denver", tz: "America/Denver" });
  });

  it("returns field errors, and what was typed, for bad input", async () => {
    const result = await signUp(null, form({ name: "", email: "not-an-email", password: "short" }));
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { name: ["Enter your name"], email: ["Enter a valid email address"], password: ["Use at least 10 characters"] },
      values: { name: "", email: "not-an-email" },
    });
    // The password is never echoed back.
    expect(JSON.stringify(result)).not.toContain("short");
    expect(jar.size).toBe(0);
    expect(seedExamplePlan).not.toHaveBeenCalled();
  });

  it("refuses an email that already has an account, whatever its case", async () => {
    const result = await signUp(null, form({ name: "Imposter", email: "LYDIA@example.com", password: PASSWORD, timeZone: "America/Chicago" }));
    expect(result).toMatchObject({
      ok: false,
      error: "An account with this email already exists. Sign in instead.",
      fieldErrors: { email: ["An account with this email already exists"] },
      values: { name: "Imposter", email: "lydia@example.com" },
    });
    expect(jar.size).toBe(0);
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "lydia@example.com"))).toHaveLength(1);
    expect(seedExamplePlan).not.toHaveBeenCalled();
  });

  it("still creates the account when the example plan fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    seedExamplePlan.mockRejectedValueOnce(new Error("seed exploded"));
    const to = await redirectOf(signUp(null, form({ name: "Sturdy", email: "sturdy@example.com", password: PASSWORD, timeZone: "America/Chicago" })));
    expect(to).toBe("/");
    expect((await getUser())?.email).toBe("sturdy@example.com");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses a name or an email with characters nobody can see, before any hashing, and logs nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // U+0000 used to reach the database, which refuses it: a 500, with the email and the
      // password hash in the server log. Now the character never gets that far.
      const to = await redirectOf(signUp(null, form({ name: "Nul\u0000Name\u0007", email: "nul\u0000-prod@example.com", password: PASSWORD })));
      expect(to).toBe("/");
      const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "nul-prod@example.com"));
      expect(user.name).toBe("NulName");
      // A name on two lines is a field error, not a stored value.
      const twoLines = await signUp(null, form({ name: "Two\nLines", email: "two-lines@example.com", password: PASSWORD }));
      expect(twoLines).toMatchObject({ ok: false, fieldErrors: { name: ["Write your name on one line"] } });
      expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "two-lines@example.com"))).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("refuses the passwords everybody tries first, and the person's own name or email", async () => {
    const tries: [string, string][] = [
      ["1234567890", "That password is too easy to guess. Try a few words together"],
      ["qwertyuiop", "That password is too easy to guess. Try a few words together"],
      ["          ", "That password is too easy to guess. Try a few words together"],
      ["Password2026!", "That password is too easy to guess. Try a few words together"],
      ["easy@example.com", "Do not use your own name or email address as the password"],
      ["Easy Target Person", "Do not use your own name or email address as the password"],
    ];
    for (const [password, message] of tries) {
      const result = await signUp(null, form({ name: "Easy Target Person", email: "easy@example.com", password }));
      expect(result, JSON.stringify(password)).toMatchObject({ ok: false, error: `${message}.`, fieldErrors: { password: [message] }, values: { name: "Easy Target Person", email: "easy@example.com" } });
      // The password is never sent back: only the name and the email are.
      expect(Object.keys(result!.values ?? {})).toEqual(["name", "email"]);
    }
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "easy@example.com"))).toEqual([]);
    expect(jar.size).toBe(0);
  });

  it("answers 'busy' instead of queueing without end when too many passwords are being hashed", async () => {
    const saved = { ...HASH_LIMITS };
    Object.assign(HASH_LIMITS, { concurrent: 1, queue: 0, waitMs: 50 });
    try {
      const first = redirectOf(signUp(null, form({ name: "First In", email: "first-in@example.com", password: PASSWORD })));
      // Let the first one reach its hash, then send a second while it is still hashing.
      await vi.waitFor(async () => expect((await import("@/lib/auth/password")).hashingLoad().running).toBe(1));
      const second = await signUp(null, form({ name: "Second In", email: "second-in@example.com", password: PASSWORD }));
      expect(second).toEqual({ ok: false, error: "We are busy right now. Wait a moment and try again.", values: { name: "Second In", email: "second-in@example.com" } });
      expect(await first).toBe("/");
      expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "second-in@example.com"))).toEqual([]);
      // Sign-in says the same, and keeps the email in the form.
      jar.clear();
      const signingIn = redirectOf(signIn(null, form({ email: "first-in@example.com", password: PASSWORD })));
      await vi.waitFor(async () => expect((await import("@/lib/auth/password")).hashingLoad().running).toBe(1));
      expect(await signIn(null, form({ email: "lydia@example.com", password: PASSWORD }))).toEqual({ ok: false, error: "We are busy right now. Wait a moment and try again.", values: { email: "lydia@example.com" } });
      expect(await signingIn).toBe("/");
    } finally {
      Object.assign(HASH_LIMITS, saved);
    }
  });

  it("limits how many accounts one address can create", async () => {
    requestHeaders.set("x-forwarded-for", "198.51.100.20");
    for (let i = 0; i < 20; i++) {
      // Invalid input is refused before it is counted, so it does not use up the allowance.
      expect(await signUp(null, form({ name: "x", email: "bad", password: "short" }))).toMatchObject({ ok: false });
    }
    for (let i = 0; i < 20; i++) await rateLimit(rateLimitKey("sign-up", "198.51.100.20"), { limit: 20, windowMs: 3_600_000 });

    const blocked = await signUp(null, form({ name: "One Too Many", email: "toomany@example.com", password: PASSWORD, timeZone: "America/Chicago" }));
    expect(blocked).toMatchObject({ ok: false, error: "Too many tries. Wait an hour and try again.", values: { name: "One Too Many", email: "toomany@example.com" } });
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "toomany@example.com"))).toEqual([]);

    // Another address is not affected.
    requestHeaders.set("x-forwarded-for", "198.51.100.21");
    expect(await redirectOf(signUp(null, form({ name: "Neighbour", email: "neighbour@example.com", password: PASSWORD })))).toBe("/");
  });

  it("does not let a header the visitor wrote choose the address", async () => {
    // What one client could do before: a new "address" on every request, by sending its own
    // X-Forwarded-For entry or X-Real-IP. Only the entry our own proxy appended counts.
    const real = "198.51.100.77";
    for (let i = 0; i < 20; i++) await rateLimit(rateLimitKey("sign-up", real), { limit: 20, windowMs: 3_600_000 });
    for (const [i, spoof] of ["10.9.8.1", "10.9.8.2", "10.9.8.3"].entries()) {
      requestHeaders.set("x-forwarded-for", `${spoof}, ${real}`);
      requestHeaders.set("x-real-ip", spoof);
      const result = await signUp(null, form({ name: "Many Faces", email: `many-faces-${i}@example.com`, password: PASSWORD }));
      expect(result, spoof).toMatchObject({ ok: false, error: "Too many tries. Wait an hour and try again." });
    }
    expect((await t.db.select().from(schema.users)).filter((u) => u.email.startsWith("many-faces-"))).toEqual([]);
  });

  it("has a ceiling for the whole site that many addresses cannot get around", async () => {
    vi.stubEnv("SIGN_UP_MAX_PER_HOUR", "3");
    await t.db.delete(schema.rateLimits).where(eq(schema.rateLimits.key, rateLimitKey("sign-up-all")));
    for (let i = 0; i < 3; i++) {
      from(`192.0.2.${10 + i}`);
      expect(await redirectOf(signUp(null, form({ name: "Crowd", email: `crowd-${i}@example.com`, password: PASSWORD })))).toBe("/");
    }
    from("192.0.2.99"); // an address never seen before
    const refused = await signUp(null, form({ name: "Crowd", email: "crowd-3@example.com", password: PASSWORD }));
    expect(refused).toEqual({ ok: false, error: "We cannot create new accounts right now. Try again in an hour.", values: { name: "Crowd", email: "crowd-3@example.com" } });
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "crowd-3@example.com"))).toEqual([]);
    // It also holds when the address is not known at all (no proxy, no platform).
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    expect(await signUp(null, form({ name: "Crowd", email: "crowd-4@example.com", password: PASSWORD }))).toMatchObject({ ok: false, error: "We cannot create new accounts right now. Try again in an hour." });
    await t.db.delete(schema.rateLimits).where(eq(schema.rateLimits.key, rateLimitKey("sign-up-all")));
  });

  it("marks the browser as one that has signed in to the account", async () => {
    await redirectOf(signUp(null, form({ name: "Device Owner", email: "device-owner@example.com", password: PASSWORD })));
    const device = jar.get(DEVICE_COOKIE)!;
    expect(DEVICE_COOKIE).toBe("etoile_device");
    expect(device.value).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(device.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false });
    // It holds nothing that signs anyone in: no session token, no password hash.
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "device-owner@example.com"));
    expect(device.value).not.toContain(jar.get(SESSION_COOKIE)!.value);
    expect(user.passwordHash).not.toContain(device.value.split(".")[1]);
  });
});

describe("signIn", () => {
  const GENERIC = "That email or password is not right. Check them and try again.";

  it("signs in with the right password and goes to Home", async () => {
    expect(await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })))).toBe("/");
    expect((await getUser())?.email).toBe("lydia@example.com");
  });

  it("accepts the email in any case and with spaces around it", async () => {
    expect(await redirectOf(signIn(null, form({ email: "  Lydia@EXAMPLE.com ", password: PASSWORD })))).toBe("/");
  });

  it("refuses a wrong password, an unknown email and empty fields with one and the same message", async () => {
    const wrong = await signIn(null, form({ email: "lydia@example.com", password: "not the password" }));
    const unknown = await signIn(null, form({ email: "nobody@example.com", password: PASSWORD }));
    const empty = await signIn(null, form({ email: "", password: "" }));
    const almost = await signIn(null, form({ email: "lydia@example.com", password: `${PASSWORD} ` }));
    for (const result of [wrong, unknown, empty, almost]) {
      expect(result).toMatchObject({ ok: false, error: GENERIC });
      expect(result?.fieldErrors).toBeUndefined();
    }
    expect(wrong?.values).toEqual({ email: "lydia@example.com" });
    expect(JSON.stringify(wrong)).not.toContain("not the password");
    expect(jar.size).toBe(0);
    expect(await getUser()).toBeNull();
  });

  it("goes back to where the person was headed, but never off the site", async () => {
    const go = (next: string) => redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD, next })));
    expect(await go("/plans/0123456789ab/flights?step=2")).toBe("/plans/0123456789ab/flights?step=2");
    expect(await go("https://evil.example/steal")).toBe("/");
    expect(await go("//evil.example")).toBe("/");
    expect(await go("/\\evil.example")).toBe("/");
    expect(await go("javascript:alert(1)")).toBe("/");
    expect(await go("/sign-in?next=/plans")).toBe("/");
  });

  it("locks out repeated wrong passwords for one account from one address", async () => {
    requestHeaders.set("x-forwarded-for", "198.51.100.30");
    for (let i = 0; i < 8; i++) {
      expect(await signIn(null, form({ email: "amelie@example.com", password: "wrong wrong wrong" }))).toMatchObject({ error: GENERIC });
    }
    // The ninth try is refused before the password is even checked, right or wrong.
    const blocked = await signIn(null, form({ email: "amelie@example.com", password: PASSWORD }));
    expect(blocked).toMatchObject({ ok: false, error: "Too many tries. Wait 15 minutes and try again." });
    expect(await getUser()).toBeNull();

    // Someone else at the same address can still sign in, and so can the same person elsewhere.
    expect(await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })))).toBe("/");
    jar.clear();
    requestHeaders.set("x-forwarded-for", "198.51.100.31");
    expect(await redirectOf(signIn(null, form({ email: "amelie@example.com", password: PASSWORD })))).toBe("/");
  });

  it("forgets the failed tries after a successful sign-in", async () => {
    requestHeaders.set("x-forwarded-for", "198.51.100.40");
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 6; i++) await signIn(null, form({ email: "sturdy@example.com", password: "wrong wrong wrong" }));
      expect(await redirectOf(signIn(null, form({ email: "sturdy@example.com", password: PASSWORD })))).toBe("/");
    }
  });

  it("clears out expired sessions as it goes", async () => {
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "lydia@example.com"));
    await t.db.insert(schema.sessions).values({ tokenHash: "long-gone", userId: user.id, expiresAt: new Date(Date.now() - 86_400_000) });
    await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })));
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, "long-gone"))).toEqual([]);
  });

  it("upgrades a hash made with weaker settings on the next sign-in", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("old password!", salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const legacy = ["scrypt", 2 ** 14, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
    await t.db.insert(schema.users).values({ email: "legacy@example.com", name: "Legacy", passwordHash: legacy, home: { kind: "home", name: "UTC", tz: "UTC" } });

    await redirectOf(signIn(null, form({ email: "legacy@example.com", password: "old password!" })));
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "legacy@example.com"));
    expect(user.passwordHash).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(await verifyPassword("old password!", user.passwordHash)).toEqual({ ok: true, needsRehash: false });
  });
});

describe("signIn: nobody can lock an account out for its owner", () => {
  const GENERIC = "That email or password is not right. Check them and try again.";
  const TOO_MANY = "Too many tries. Wait 15 minutes and try again.";
  const VICTIM = "victim@example.com";
  const emailKey = rateLimitKey("sign-in-email", VICTIM);
  let victimDevice: { value: string; options?: Record<string, unknown> };

  beforeAll(async () => {
    requestHeaders.set("x-forwarded-for", "198.51.100.1");
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    await redirectOf(signUp(null, form({ name: "Victim", email: VICTIM, password: PASSWORD })));
    victimDevice = jar.get(DEVICE_COOKIE)!; // the victim's own browser remembers it has signed in
  });
  beforeEach(async () => {
    await t.db.delete(schema.rateLimits);
  });

  it("31 wrong tries from one address, then the right password from another address succeeds", async () => {
    from("203.0.113.66");
    const answers: string[] = [];
    for (let i = 0; i < 31; i++) answers.push((await signIn(null, form({ email: VICTIM, password: "wrong wrong wrong" })))!.error);
    expect(answers.slice(0, 8)).toEqual(Array(8).fill(GENERIC));
    expect(answers.slice(8)).toEqual(Array(23).fill(TOO_MANY));
    // Only the eight tries that reached a password check count against the account.
    expect(await counted(emailKey)).toBe(8);
    expect(await counted(rateLimitKey("sign-in", VICTIM, "203.0.113.66"))).toBe(31);

    // The owner, from their own address, with the right password and no cookie at all.
    jar.clear();
    from("198.51.100.1");
    expect(await redirectOf(signIn(null, form({ email: VICTIM, password: PASSWORD })))).toBe("/");
    // And from an address never used before.
    jar.clear();
    from("192.0.2.200");
    expect(await redirectOf(signIn(null, form({ email: VICTIM, password: PASSWORD })))).toBe("/");
  });

  it("a try refused for the address is not counted against the account either", async () => {
    from("203.0.113.67");
    // The address has used up its allowance across all accounts.
    for (let i = 0; i < 60; i++) await rateLimit(rateLimitKey("sign-in-ip", "203.0.113.67"), { limit: 60, windowMs: 15 * 60_000 });
    for (let i = 0; i < 40; i++) expect(await signIn(null, form({ email: VICTIM, password: "wrong wrong wrong" }))).toMatchObject({ error: TOO_MANY });
    expect(await counted(emailKey)).toBe(0);
    expect(await counted(rateLimitKey("sign-in", VICTIM, "203.0.113.67"))).toBe(0);
  });

  it("the right password clears the failed tries for the account", async () => {
    from("203.0.113.68");
    for (let i = 0; i < 5; i++) await signIn(null, form({ email: VICTIM, password: "wrong wrong wrong" }));
    expect(await counted(emailKey)).toBe(5);
    expect(await redirectOf(signIn(null, form({ email: VICTIM, password: PASSWORD })))).toBe("/");
    expect(await counted(emailKey)).toBe(0);
    expect(await counted(rateLimitKey("sign-in", VICTIM, "203.0.113.68"))).toBe(0);
  });

  it("when many addresses together use up the account's limit, the owner's own browser still gets in", async () => {
    // Four addresses, eight tries each: 32 tries that each reached a password check.
    for (let address = 0; address < 4; address++) {
      from(`203.0.113.${80 + address}`);
      for (let i = 0; i < 8; i++) await signIn(null, form({ email: VICTIM, password: "wrong wrong wrong" }));
    }
    expect(await counted(emailKey)).toBe(32);

    // A browser that has never signed in to this account is refused, right password or not.
    jar.clear();
    from("192.0.2.201");
    expect(await signIn(null, form({ email: VICTIM, password: PASSWORD }))).toMatchObject({ ok: false, error: TOO_MANY });
    expect(await getUser()).toBeNull();

    // A made-up cookie, and another account's cookie, are no help.
    jar.set(DEVICE_COOKIE, { value: `${"a".repeat(43)}.${"b".repeat(43)}` });
    expect(await signIn(null, form({ email: VICTIM, password: PASSWORD }))).toMatchObject({ error: TOO_MANY });
    jar.clear();
    from("192.0.2.202");
    await redirectOf(signUp(null, form({ name: "Someone Else", email: "someone-else@example.com", password: PASSWORD })));
    const othersDevice = jar.get(DEVICE_COOKIE)!;
    jar.clear();
    jar.set(DEVICE_COOKIE, othersDevice);
    expect(await signIn(null, form({ email: VICTIM, password: PASSWORD }))).toMatchObject({ error: TOO_MANY });

    // The owner's browser: still asked for the password (a wrong one is refused as usual) …
    jar.clear();
    jar.set(DEVICE_COOKIE, victimDevice);
    from("198.51.100.1");
    expect(await signIn(null, form({ email: VICTIM, password: "not quite right" }))).toMatchObject({ ok: false, error: GENERIC });
    expect(await getUser()).toBeNull();
    // … and let in with the right one.
    expect(await redirectOf(signIn(null, form({ email: VICTIM, password: PASSWORD })))).toBe("/");
    expect((await getUser())?.email).toBe(VICTIM);
    expect(await counted(emailKey)).toBe(0); // and that clears the account's count
    victimDevice = jar.get(DEVICE_COOKIE)!;
  });

  it("the known browser's own allowance is small", async () => {
    for (let i = 0; i < 31; i++) await rateLimit(emailKey, { limit: 30, windowMs: 15 * 60_000 });
    jar.clear();
    jar.set(DEVICE_COOKIE, victimDevice);
    from("198.51.100.2");
    const answers: string[] = [];
    for (let i = 0; i < 7; i++) answers.push((await signIn(null, form({ email: VICTIM, password: "wrong wrong wrong" })))!.error);
    expect(answers).toEqual([GENERIC, GENERIC, GENERIC, GENERIC, GENERIC, TOO_MANY, TOO_MANY]);
  });

  it("an email with no account is refused the same way once its limit is reached", async () => {
    const ghostKey = rateLimitKey("sign-in-email", "ghost@example.com");
    for (let i = 0; i < 31; i++) await rateLimit(ghostKey, { limit: 30, windowMs: 15 * 60_000 });
    jar.set(DEVICE_COOKIE, victimDevice);
    from("192.0.2.210");
    expect(await signIn(null, form({ email: "ghost@example.com", password: PASSWORD }))).toMatchObject({ ok: false, error: TOO_MANY });
  });

  it("with no address to go by, the limits that need none still hold", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    requestHeaders.set("x-real-ip", "10.9.8.1"); // ignored
    // No per-address limit applies (the address is unknown, for everyone alike) …
    for (let i = 0; i < 12; i++) expect(await signIn(null, form({ email: VICTIM, password: "wrong wrong wrong" }))).toMatchObject({ error: GENERIC });
    expect(await counted(emailKey)).toBe(12);
    // … but the account's own limit does.
    for (let i = 0; i < 18; i++) await rateLimit(emailKey, { limit: 30, windowMs: 15 * 60_000 });
    expect(await signIn(null, form({ email: VICTIM, password: "wrong wrong wrong" }))).toMatchObject({ error: TOO_MANY });
  });
});

describe("signIn housekeeping", () => {
  it("clears out cache rows nobody has asked for in a long time", async () => {
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60_000);
    await cached("places:v1:typed-once", 60_000, async () => ["a place"], { now: longAgo });
    await cached("places:v1:typed-just-now", 60_000, async () => ["another"]);
    expect(await peekCached("places:v1:typed-once")).not.toBeNull();
    await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })));
    expect(await peekCached("places:v1:typed-once")).toBeNull();
    expect(await peekCached("places:v1:typed-just-now")).not.toBeNull();
  });
});

describe("signOut", () => {
  it("removes the session and the cookie and goes to the landing page", async () => {
    await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })));
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "lydia@example.com"));
    const before = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    expect(before.length).toBeGreaterThan(0);

    expect(await redirectOf(signOut())).toBe("/");
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    // Removed with the attributes it was set with (a bare delete cannot remove a __Host- cookie).
    expect(removals).toEqual([{ name: SESSION_COOKIE, options: { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 0 } }]);
    expect(await getUser()).toBeNull();
    const after = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    expect(after.length).toBe(before.length - 1);
  });

  it("is harmless when nobody is signed in", async () => {
    expect(await redirectOf(signOut())).toBe("/");
  });
});

describe("signOutEverywhere", () => {
  it("ends every session of the account, on every device, and nobody else's", async () => {
    await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })));
    const phone = jar.get(SESSION_COOKIE)!;
    jar.clear();
    await redirectOf(signIn(null, form({ email: "amelie@example.com", password: PASSWORD })));
    const other = jar.get(SESSION_COOKIE)!;
    jar.clear();
    await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })));

    expect(await redirectOf(signOutEverywhere())).toBe("/");
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    const [lydia] = await t.db.select().from(schema.users).where(eq(schema.users.email, "lydia@example.com"));
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, lydia.id))).toEqual([]);
    // The phone's token is dead too.
    jar.set(SESSION_COOKIE, phone);
    expect(await getUser()).toBeNull();
    // Someone else is untouched.
    jar.set(SESSION_COOKIE, other);
    expect((await getUser())?.email).toBe("amelie@example.com");
  });

  it("sends a signed-out visitor to sign-in", async () => {
    await expect(signOutEverywhere()).rejects.toThrow("REDIRECT /sign-in");
  });
});

describe("changePassword", () => {
  const NEW = "a brand new long password";
  const EMAIL = "changer@example.com";

  beforeAll(async () => {
    requestHeaders.set("x-forwarded-for", "198.51.100.90");
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    await redirectOf(signUp(null, form({ name: "Pat Changer", email: EMAIL, password: PASSWORD })));
  });

  it("needs to be signed in", async () => {
    await expect(changePassword(null, form({ currentPassword: PASSWORD, newPassword: NEW }))).rejects.toThrow("REDIRECT /sign-in");
  });

  it("refuses a wrong current password, a weak new one and the same one again, and changes nothing", async () => {
    await redirectOf(signIn(null, form({ email: EMAIL, password: PASSWORD })));
    expect(await changePassword(null, form({ currentPassword: "", newPassword: NEW }))).toMatchObject({ ok: false, fieldErrors: { currentPassword: ["Enter your current password"] } });
    expect(await changePassword(null, form({ currentPassword: "not my password", newPassword: NEW }))).toMatchObject({ ok: false, fieldErrors: { currentPassword: ["That is not your current password"] } });
    expect(await changePassword(null, form({ currentPassword: PASSWORD, newPassword: "short" }))).toMatchObject({ ok: false, fieldErrors: { newPassword: ["Use at least 10 characters"] } });
    expect(await changePassword(null, form({ currentPassword: PASSWORD, newPassword: "qwertyuiop" }))).toMatchObject({ ok: false, fieldErrors: { newPassword: ["That password is too easy to guess. Try a few words together"] } });
    expect(await changePassword(null, form({ currentPassword: PASSWORD, newPassword: "Pat Changer" }))).toMatchObject({ ok: false, fieldErrors: { newPassword: ["Do not use your own name or email address as the password"] } });
    expect(await changePassword(null, form({ currentPassword: PASSWORD, newPassword: PASSWORD }))).toMatchObject({ ok: false, fieldErrors: { newPassword: ["Choose a different password"] } });
    const result = await changePassword(null, form({ currentPassword: "not my password", newPassword: NEW }));
    // Neither password is ever sent back.
    expect(JSON.stringify(result)).not.toContain(NEW);
    expect(JSON.stringify(result)).not.toContain("not my password");
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, EMAIL));
    expect((await verifyPassword(PASSWORD, user.passwordHash)).ok).toBe(true);
  });

  it("changes the password, signs every other device out and keeps this one signed in", async () => {
    await redirectOf(signIn(null, form({ email: EMAIL, password: PASSWORD })));
    const laptop = jar.get(SESSION_COOKIE)!;
    const oldDevice = jar.get(DEVICE_COOKIE)!;
    jar.clear();
    await redirectOf(signIn(null, form({ email: EMAIL, password: PASSWORD }))); // the phone

    expect(await changePassword(null, form({ currentPassword: PASSWORD, newPassword: NEW }))).toEqual({ ok: true });
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, EMAIL));
    expect(user.passwordHash).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(await verifyPassword(NEW, user.passwordHash)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword(PASSWORD, user.passwordHash)).ok).toBe(false);

    // This device has a fresh session; the laptop's is gone.
    expect((await getUser())?.email).toBe(EMAIL);
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))).toHaveLength(1);
    const phone = jar.get(SESSION_COOKIE)!;
    jar.set(SESSION_COOKIE, laptop);
    expect(await getUser()).toBeNull();
    jar.set(SESSION_COOKIE, phone);

    // The old password no longer signs in; the new one does.
    jar.clear();
    expect(await signIn(null, form({ email: EMAIL, password: PASSWORD }))).toMatchObject({ ok: false });
    expect(await redirectOf(signIn(null, form({ email: EMAIL, password: NEW })))).toBe("/");

    // A "known browser" cookie from before the change no longer counts as one.
    await t.db.delete(schema.rateLimits);
    for (let i = 0; i < 31; i++) await rateLimit(rateLimitKey("sign-in-email", EMAIL), { limit: 30, windowMs: 15 * 60_000 });
    jar.clear();
    jar.set(DEVICE_COOKIE, oldDevice);
    expect(await signIn(null, form({ email: EMAIL, password: NEW }))).toMatchObject({ ok: false, error: "Too many tries. Wait 15 minutes and try again." });
    await t.db.delete(schema.rateLimits);
  });
});
