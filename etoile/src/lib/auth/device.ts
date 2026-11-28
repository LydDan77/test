import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { BRAND } from "@/lib/brand";
import { isToken, newToken } from "@/lib/ids";
import { SECURE_COOKIE } from "./session";

// "This browser has signed in to this account before."
//
// Why it exists: the limit on password tries for one account from anywhere is what stops slow
// guessing from many addresses, and it is also something other people can use up on purpose.
// A browser that has already proved it knows the password keeps a small allowance of its own,
// so the owner can still get in while that limit is reached (src/features/auth/actions.ts).
//
// How: a cookie holding a random device id and an HMAC of it, keyed by the account's password
// hash. The hash never leaves the database, so nobody else can make the cookie; no table and no
// server secret are needed; and changing the password ends every such cookie at once.
// The cookie proves nothing on its own and signs nobody in: the password is still checked.

const PLAIN_NAME = `${BRAND.ascii}_device`;
export const DEVICE_COOKIE = SECURE_COOKIE ? `__Host-${PLAIN_NAME}` : PLAIN_NAME;
const DEVICE_COOKIE_MS = 365 * 24 * 60 * 60 * 1000;

type Account = { id: string; passwordHash: string };

function proofFor(account: Account, deviceId: string): string {
  return createHmac("sha256", account.passwordHash).update(`${BRAND.ascii}-device:v1:${account.id}:${deviceId}`).digest("base64url");
}

/**
 * Marks this browser as one that has signed in to `account`. Call it after a password has
 * been checked and found right (sign-up, sign-in, password change), from a Server Action.
 */
export async function rememberDevice(account: Account): Promise<void> {
  const deviceId = newToken();
  const cookieStore = await cookies();
  cookieStore.set(DEVICE_COOKIE, `${deviceId}.${proofFor(account, deviceId)}`, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: "lax",
    path: "/",
    expires: new Date(Date.now() + DEVICE_COOKIE_MS),
  });
}

/**
 * The id of this browser if it has signed in to `account` before (and the password has not
 * changed since), otherwise null. An id to key a rate limit on, nothing more.
 */
export async function knownDeviceId(account: Account): Promise<string | null> {
  const value = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (!value) return null;
  const [deviceId, proof, ...rest] = value.split(".");
  if (rest.length > 0 || !isToken(deviceId) || !isToken(proof)) return null;
  const expected = Buffer.from(proofFor(account, deviceId));
  const given = Buffer.from(proof);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return deviceId;
}
