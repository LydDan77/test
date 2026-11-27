import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal stand-in for Next's request cookie store. cookies() only works inside a request.
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => void jar.set(name, { value, options }),
    delete: (name: string) => void jar.delete(name),
  }),
}));
// React's cache() only memoises inside a Server Component render; make it a pass-through here.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
// redirect() and notFound() throw special errors inside Next; here they throw plain ones.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { eq } from "drizzle-orm";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { newId } from "@/lib/ids";
import { findOwnedPlan, requirePlan, requireUser } from "./require";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_NAMES,
  SESSION_MS,
  createSession,
  deleteAllSessionsForUser,
  deleteExpiredSessions,
  destroySession,
  getUser,
  hashSessionToken,
} from "./session";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => jar.clear());

async function makeUser(email: string, name = "Test Person") {
  const [user] = await t.db
    .insert(schema.users)
    .values({ email, name, passwordHash: "scrypt$not$a$real$hash$x", home: { kind: "home", name: "Chicago", tz: "America/Chicago" } })
    .returning();
  return user;
}

async function makePlan(ownerId: string, title: string) {
  const [plan] = await t.db
    .insert(schema.plans)
    .values({ ownerId, template: "trip", title, origin: { kind: "home", name: "Chicago", tz: "America/Chicago" }, tz: "America/Chicago" })
    .returning();
  return plan;
}

describe("cookie sessions", () => {
  it("names the cookie after the brand and tells the proxy both names", () => {
    expect(SESSION_COOKIE).toBe("etoile_session"); // not production under Vitest
    expect(SESSION_COOKIE_NAMES).toEqual(["__Host-etoile_session", "etoile_session"]);
  });

  it("creates a session, resolves the user from the cookie, and destroys it", async () => {
    const user = await makeUser("s1@example.com", "Lydia Hartley");
    expect(await getUser()).toBeNull();

    await createSession(user.id);
    const cookie = jar.get(SESSION_COOKIE)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false });
    const expires = cookie.options!.expires as Date;
    expect(Math.abs(expires.getTime() - (Date.now() + SESSION_MS))).toBeLessThan(5000);

    // Only the SHA-256 of the token is stored.
    const [row] = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(hashSessionToken(cookie.value));
    expect(JSON.stringify(row)).not.toContain(cookie.value);

    const current = await getUser();
    expect(current).toMatchObject({ id: user.id, email: "s1@example.com", name: "Lydia Hartley", timeStyle: "12h_with_24h", militaryStyle: "1441" });
    expect(current!.home).toEqual({ kind: "home", name: "Chicago", tz: "America/Chicago" });
    // The password hash never leaves the session module.
    expect(current).not.toHaveProperty("passwordHash");

    await destroySession();
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))).toEqual([]);
    expect(await getUser()).toBeNull();
  });

  it("ignores an unknown token, a tampered token and an expired session", async () => {
    jar.set(SESSION_COOKIE, { value: "not-a-real-token" });
    expect(await getUser()).toBeNull();

    const user = await makeUser("s2@example.com");
    await createSession(user.id);
    const real = jar.get(SESSION_COOKIE)!.value;
    jar.set(SESSION_COOKIE, { value: real.slice(0, -1) + (real.endsWith("A") ? "B" : "A") });
    expect(await getUser()).toBeNull();
    // The stored hash is not accepted in place of the token.
    jar.set(SESSION_COOKIE, { value: hashSessionToken(real) });
    expect(await getUser()).toBeNull();

    jar.set(SESSION_COOKIE, { value: real });
    expect(await getUser()).not.toBeNull();
    await t.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.sessions.userId, user.id));
    expect(await getUser()).toBeNull();
  });

  it("extends a session that is past half of its lifetime, and leaves a fresh one alone", async () => {
    const user = await makeUser("s3@example.com");
    await createSession(user.id);
    const [fresh] = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    await getUser();
    const [untouched] = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    expect(untouched.expiresAt.getTime()).toBe(fresh.expiresAt.getTime());

    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await t.db.update(schema.sessions).set({ expiresAt: soon }).where(eq(schema.sessions.userId, user.id));
    expect(await getUser()).not.toBeNull();
    const [row] = await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    expect(row.expiresAt.getTime()).toBeGreaterThan(soon.getTime() + 20 * 24 * 60 * 60 * 1000);
  });

  it("signing out on one device leaves the other signed in", async () => {
    const user = await makeUser("s4@example.com");
    await createSession(user.id);
    const phone = jar.get(SESSION_COOKIE)!.value;
    jar.clear();
    await createSession(user.id);
    const laptop = jar.get(SESSION_COOKIE)!.value;
    expect(phone).not.toBe(laptop);

    await destroySession(); // laptop
    jar.set(SESSION_COOKIE, { value: phone });
    expect((await getUser())?.id).toBe(user.id);
    jar.set(SESSION_COOKIE, { value: laptop });
    expect(await getUser()).toBeNull();
  });

  it("cleans up expired sessions and can sign a person out everywhere", async () => {
    const user = await makeUser("s5@example.com");
    const other = await makeUser("s6@example.com");
    await t.db.insert(schema.sessions).values([
      { id: newId(), tokenHash: "expired-1", userId: user.id, expiresAt: new Date(Date.now() - 60_000) },
      { id: newId(), tokenHash: "expired-2", userId: other.id, expiresAt: new Date(Date.now() - 1) },
      { id: newId(), tokenHash: "live-1", userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
      { id: newId(), tokenHash: "live-2", userId: other.id, expiresAt: new Date(Date.now() + 60_000) },
    ]);
    await deleteExpiredSessions();
    const left = (await t.db.select({ h: schema.sessions.tokenHash }).from(schema.sessions)).map((r) => r.h);
    expect(left).toEqual(expect.arrayContaining(["live-1", "live-2"]));
    expect(left).not.toContain("expired-1");
    expect(left).not.toContain("expired-2");

    await deleteAllSessionsForUser(user.id);
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))).toEqual([]);
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, other.id))).toHaveLength(1);
  });

  it("deleting a user deletes their sessions", async () => {
    const user = await makeUser("s7@example.com");
    await createSession(user.id);
    await t.db.delete(schema.users).where(eq(schema.users.id, user.id));
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))).toEqual([]);
    expect(await getUser()).toBeNull();
  });
});

describe("requireUser", () => {
  it("returns the user when signed in", async () => {
    const user = await makeUser("r1@example.com");
    await createSession(user.id);
    expect((await requireUser()).id).toBe(user.id);
  });

  it("redirects to sign-in when signed out, carrying where to come back to", async () => {
    await expect(requireUser()).rejects.toThrow("REDIRECT /sign-in");
    await expect(requireUser("/plans/abc?tab=1")).rejects.toThrow("REDIRECT /sign-in?next=%2Fplans%2Fabc%3Ftab%3D1");
  });
});

describe("requirePlan", () => {
  it("loads a plan only for its owner", async () => {
    const lydia = await makeUser("owner@example.com");
    const stranger = await makeUser("stranger@example.com");
    const plan = await makePlan(lydia.id, "Hartley Family Christmas");

    expect((await requirePlan(lydia, plan.id)).title).toBe("Hartley Family Christmas");
    expect((await findOwnedPlan(lydia.id, plan.id))?.id).toBe(plan.id);

    // Someone else's plan and a plan that does not exist are the same answer.
    await expect(requirePlan(stranger, plan.id)).rejects.toThrow("NOT_FOUND");
    await expect(requirePlan(lydia, newId())).rejects.toThrow("NOT_FOUND");
    expect(await findOwnedPlan(stranger.id, plan.id)).toBeNull();
  });

  it("rejects ids that are not ids without touching the database", async () => {
    const lydia = await makeUser("owner2@example.com");
    for (const bad of ["", "abc", "' or 1=1 --", "../../x", "0123456789AB"]) {
      await expect(requirePlan(lydia, bad), bad).rejects.toThrow("NOT_FOUND");
    }
  });
});
