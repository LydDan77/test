import "server-only";

import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { getDb, schema } from "@/db";
import type { User } from "@/db/schema";
import { BRAND } from "@/lib/brand";
import { newId, newToken } from "@/lib/ids";

const SESSION_DAYS = 30;
export const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
/** Extend a session once less than this much of its life remains (sliding expiry, DB side). */
const RENEW_BELOW_MS = SESSION_MS / 2;

const isProduction = process.env.NODE_ENV === "production";

// The __Host- prefix makes the browser refuse the cookie unless it is Secure, has Path=/ and has
// no Domain attribute, so a sibling subdomain cannot plant or overwrite it.
// It needs HTTPS, so it is only used when the cookie is Secure.
const SECURE_COOKIE = isProduction && process.env.SESSION_COOKIE_INSECURE !== "1";
const PLAIN_COOKIE_NAME = `${BRAND.ascii}_session`;
export const SESSION_COOKIE = SECURE_COOKIE ? `__Host-${PLAIN_COOKIE_NAME}` : PLAIN_COOKIE_NAME;
/** Both names the cookie can have, for proxy.ts, which only checks that one is present. */
export const SESSION_COOKIE_NAMES = [`__Host-${PLAIN_COOKIE_NAME}`, PLAIN_COOKIE_NAME] as const;

/** The signed-in person: their whole users row except the password hash. */
export type SessionUser = Omit<User, "passwordHash">;

/** The cookie holds the raw token; the database holds only its SHA-256. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Call from a Server Action or Route Handler only: cookies cannot be set while rendering. */
export async function createSession(userId: string): Promise<void> {
  const token = newToken(); // 256 bits from the OS CSPRNG
  const expiresAt = new Date(Date.now() + SESSION_MS);
  const db = await getDb();
  await db.insert(schema.sessions).values({ id: newId(), tokenHash: hashSessionToken(token), userId, expiresAt });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Call from a Server Action or Route Handler only. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token)));
  }
  cookieStore.delete(SESSION_COOKIE);
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
    .select({ user: schema.users, expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, tokenHash), gt(schema.sessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;

  if (row.expiresAt.getTime() - now.getTime() < RENEW_BELOW_MS) {
    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(now.getTime() + SESSION_MS) })
      .where(eq(schema.sessions.tokenHash, tokenHash));
  }
  // The hash never leaves this module.
  const { passwordHash: _passwordHash, ...user } = row.user;
  void _passwordHash;
  return user;
});

/** Housekeeping: removes sessions that have expired. Called opportunistically at sign-in. */
export async function deleteExpiredSessions(now = new Date()): Promise<void> {
  const db = await getDb();
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
}

/** Signs a person out everywhere: for a password change or "sign out of all devices". */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}
