import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stand-ins for the request: a cookie jar and request headers.
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
const requestHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => void jar.set(name, { value, options }),
    delete: (name: string) => void jar.delete(name),
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
import { verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, getUser } from "@/lib/auth/session";
import { signIn, signOut, signUp } from "./actions";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => {
  jar.clear();
  requestHeaders.clear();
  requestHeaders.set("x-forwarded-for", "203.0.113.7");
  seedExamplePlan.mockClear();
  seedExamplePlan.mockImplementation(async () => {});
});

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

  it("limits how many accounts one address can create", async () => {
    requestHeaders.set("x-forwarded-for", "198.51.100.20");
    for (let i = 0; i < 20; i++) {
      // Invalid input is refused before it is counted, so it does not use up the allowance.
      expect(await signUp(null, form({ name: "x", email: "bad", password: "short" }))).toMatchObject({ ok: false });
    }
    const { rateLimit, rateLimitKey } = await import("@/lib/rate-limit");
    for (let i = 0; i < 20; i++) await rateLimit(rateLimitKey("sign-up", "198.51.100.20"), { limit: 20, windowMs: 3_600_000 });

    const blocked = await signUp(null, form({ name: "One Too Many", email: "toomany@example.com", password: PASSWORD, timeZone: "America/Chicago" }));
    expect(blocked).toMatchObject({ ok: false, error: "Too many tries. Wait an hour and try again.", values: { name: "One Too Many", email: "toomany@example.com" } });
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "toomany@example.com"))).toEqual([]);

    // Another address is not affected.
    requestHeaders.set("x-forwarded-for", "198.51.100.21");
    expect(await redirectOf(signUp(null, form({ name: "Neighbour", email: "neighbour@example.com", password: PASSWORD })))).toBe("/");
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

describe("signOut", () => {
  it("removes the session and the cookie and goes to the landing page", async () => {
    await redirectOf(signIn(null, form({ email: "lydia@example.com", password: PASSWORD })));
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "lydia@example.com"));
    const before = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    expect(before.length).toBeGreaterThan(0);

    expect(await redirectOf(signOut())).toBe("/");
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(await getUser()).toBeNull();
    const after = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    expect(after.length).toBe(before.length - 1);
  });

  it("is harmless when nobody is signed in", async () => {
    expect(await redirectOf(signOut())).toBe("/");
  });
});
