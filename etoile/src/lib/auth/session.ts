import "server-only";

import { createHash } from "node:crypto";
import { and, eq, gt, lt, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { getDb, schema } from "@/db";
import type { User } from "@/db/schema";
import { newId, newToken } from "@/lib/ids";
import { PLAIN_SESSION_COOKIE, SECURE_SESSION_COOKIE, SESSION_COOKIE_NAMES } from "./cookie-names";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a session lasts without being used. Each visit in the second half of this window
 * moves the end out again, so a person who keeps coming back stays signed in.
 */
export const SESSION_MS = 30 * DAY_MS;
/**
 * The longest a session can live, however much it is used: after this the person signs in
 * again. Without it a copied token, used once every few weeks, would work for ever.
 */
export const SESSION_MAX_AGE_MS = 90 * DAY_MS;
/** Extend a session once less than this much of its idle window remains. */
const RENEW_BELOW_MS = SESSION_MS / 2;

const isProduction = process.env.NODE_ENV === "production";

// The __Host- name needs HTTPS, so it is only used when the cookie is Secure.
// SESSION_COOKIE_INSECURE=1 is for `next start` on plain-http localhost (the end-to-end test
// server). It is ignored on Vercel, as RATE_LIMIT_DISABLED is: a hosted site is always HTTPS, so
// the switch could only ever weaken the cookie there.
const insecureAsked = process.env.SESSION_COOKIE_INSECURE === "1";
export const SECURE_COOKIE = isProduction && !(insecureAsked && !process.env.VERCEL);
if (isProduction && !SECURE_COOKIE) {
  console.warn(
    "[session] WARNING: SESSION_COOKIE_INSECURE=1 in a production build. The session cookie is sent WITHOUT Secure and " +
      "without the __Host- prefix. This is only for the end-to-end test server on plain-http localhost.",
  );
}
export const SESSION_COOKIE = SECURE_COOKIE ? SECURE_SESSION_COOKIE : PLAIN_SESSION_COOKIE;
export { SESSION_COOKIE_NAMES };

/** The attributes the session cookie is set with, and must be removed with. */
const COOKIE_ATTRIBUTES = { httpOnly: true, secure: SECURE_COOKIE, sameSite: "lax", path: "/" } as const;

/** The signed-in person: their whole users row except the password hash. */
export type SessionUser = Omit<User, "passwordHash">;

/** The cookie holds the raw token; the database holds only its SHA-256. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Call from a Server Action or Route Handler only: cookies cannot be set while rendering.
 *
 * Two clocks run from here. The session row ends after SESSION_MS without a visit and is
 * extended by getUser() while the person keeps coming back. The cookie is set once, for
 * SESSION_MAX_AGE_MS, which is also the oldest a row may get: so the cookie never ends before
 * the session it names, and an active person is signed out after 90 days, not after exactly 30.
 */
export async function createSession(userId: string): Promise<void> {
  const token = newToken(); // 256 bits from the OS CSPRNG
  const now = Date.now();
  const db = await getDb();
  await db
    .insert(schema.sessions)
    .values({ id: newId(), tokenHash: hashSessionToken(token), userId, expiresAt: new Date(now + SESSION_MS) });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, { ...COOKIE_ATTRIBUTES, expires: new Date(now + SESSION_MAX_AGE_MS) });
}

/** Call from a Server Action or Route Handler only. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token)));
  }
  // Removed by setting it again, empty and already expired, with the attributes it was set
  // with. cookies().delete(name) sends the header without Secure, and a browser ignores any
  // Set-Cookie for a "__Host-" name that is not Secure: the cookie would stay.
  cookieStore.set(SESSION_COOKIE, "", { ...COOKIE_ATTRIBUTES, maxAge: 0 });
}

/**
 * The signed-in user, or null. Safe in Server Components, Server Actions and Route Handlers.
 * React's cache() makes repeated calls within one request cost one query.
 * It reads cookies(), so with Cache Components the caller must sit inside <Suspense>.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = await getDb();
  const now = new Date();
  const tokenHash = hashSessionToken(token);
  const [row] = await db
    .select({ user: schema.users, expiresAt: schema.sessions.expiresAt, createdAt: schema.sessions.createdAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.tokenHash, tokenHash),
        gt(schema.sessions.expiresAt, now),
        // However often it has been extended, a session ends for good at its maximum age.
        gt(schema.sessions.createdAt, new Date(now.getTime() - SESSION_MAX_AGE_MS)),
      ),
    )
    .limit(1);
  if (!row) return null;

  if (row.expiresAt.getTime() - now.getTime() < RENEW_BELOW_MS) {
    const lastMoment = row.createdAt.getTime() + SESSION_MAX_AGE_MS;
    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Math.min(now.getTime() + SESSION_MS, lastMoment)) })
      .where(eq(schema.sessions.tokenHash, tokenHash));
  }
  // The hash never leaves this module.
  const { passwordHash: _passwordHash, ...user } = row.user;
  void _passwordHash;
  return user;
});

/**
 * Housekeeping: removes sessions that have expired or passed their maximum age.
 * Called opportunistically at sign-in.
 */
export async function deleteExpiredSessions(now = new Date()): Promise<void> {
  const db = await getDb();
  await db
    .delete(schema.sessions)
    .where(or(lt(schema.sessions.expiresAt, now), lt(schema.sessions.createdAt, new Date(now.getTime() - SESSION_MAX_AGE_MS))));
}

/** Signs a person out everywhere: for a password change or "sign out of all devices". */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}
