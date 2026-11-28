import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb, schema } from "@/db";
import type { Site } from "@/db/schema";
import { hashPasscode, isPasswordBusy, verifyPassword } from "@/lib/auth/password";
import { SECURE_COOKIE } from "@/lib/auth/session";
import { BRAND } from "@/lib/brand";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { UNKNOWN_ADDRESS, clientIp } from "@/lib/request";
import { isValidSlug } from "@/lib/slugs";

// A share page's shared passcode (product spec 9.3): "Anyone with the link and the shared
// passcode. Remembered on a device for 30 days. Wrong attempts are rate-limited."
//
//   setSitePasscode(planId, passcode)   the organizer sets, changes or removes it
//   checkSitePasscode(slug, passcode)   a visitor enters it; on success this browser is remembered
//   isSiteUnlocked(site)                has this browser entered the current passcode
//
// The "remembered" cookie needs no table and no server secret: it holds an expiry time and an
// HMAC of it, keyed by the stored passcode hash. Nobody without the database can make one, and
// changing the passcode ends every one of them at once. It never holds the passcode or its hash.

export const PASSCODE_MIN_LENGTH = 4;
export const PASSCODE_MAX_LENGTH = 64;
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

const LIMITS = {
  /** Wrong-or-right tries at one page from one address. */
  perSlugAndAddress: { limit: 10, windowMs: 10 * MINUTE },
  /**
   * Tries at one page from anywhere. An address can be many addresses, so this is the limit
   * that actually bounds guessing a short word: 60 tries every 10 minutes at most.
   */
  perSlug: { limit: 60, windowMs: 10 * MINUTE },
} as const;

type SiteSecret = Pick<Site, "id" | "passcodeHash">;

const cookieName = (siteId: string) => `${SECURE_COOKIE ? "__Host-" : ""}${BRAND.ascii}_page_${siteId}`;

function proofFor(site: { id: string; passcodeHash: string }, expiresAtSeconds: number): string {
  return createHmac("sha256", site.passcodeHash).update(`${BRAND.ascii}-page:v1:${site.id}:${expiresAtSeconds}`).digest("base64url");
}

export type SetPasscodeResult = { ok: true } | { ok: false; reason: "too_short" | "too_long" | "no_page" | "busy" };

/**
 * Sets the passcode of a plan's share page, or removes it with `null`. The caller has already
 * checked that the plan is the user's (requirePlan). A passcode is taken as typed apart from
 * the spaces around it. Setting or changing one ends every "remembered" browser.
 * Removing it also turns the page back to "anyone with the link".
 */
export async function setSitePasscode(planId: string, passcode: string | null): Promise<SetPasscodeResult> {
  const db = await getDb();
  if (passcode === null) {
    const cleared = await db.update(schema.sites).set({ passcodeHash: null, access: "link" }).where(eq(schema.sites.planId, planId)).returning({ id: schema.sites.id });
    return cleared.length > 0 ? { ok: true } : { ok: false, reason: "no_page" };
  }
  const text = passcode.normalize("NFKC").trim();
  if (text.length < PASSCODE_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (text.length > PASSCODE_MAX_LENGTH) return { ok: false, reason: "too_long" };
  let passcodeHash: string;
  try {
    passcodeHash = await hashPasscode(text);
  } catch (error) {
    if (isPasswordBusy(error)) return { ok: false, reason: "busy" };
    throw error;
  }
  const updated = await db.update(schema.sites).set({ passcodeHash, access: "passcode" }).where(eq(schema.sites.planId, planId)).returning({ id: schema.sites.id });
  return updated.length > 0 ? { ok: true } : { ok: false, reason: "no_page" };
}

export type CheckPasscodeResult =
  | { ok: true }
  | { ok: false; reason: "wrong" }
  /** Tell the person to wait: describeWait(retryAfterMs). */
  | { ok: false; reason: "too_many_tries"; retryAfterMs: number }
  | { ok: false; reason: "busy" };

/**
 * A visitor enters the passcode of the page at `slug`. Call from a Server Action. On success
 * this browser is remembered for 30 days (see isSiteUnlocked). Counts every try, right or
 * wrong, per page and per page + address, before any hashing.
 *
 * A page that does not exist, is not published or has no passcode answers "wrong" like any
 * other miss, after the same limits: this function never says which pages exist.
 */
export async function checkSitePasscode(slug: string, passcode: string): Promise<CheckPasscodeResult> {
  const cleanSlug = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  const address = await clientIp();
  if (address !== UNKNOWN_ADDRESS) {
    const byAddress = await rateLimit(rateLimitKey("passcode", cleanSlug, address), LIMITS.perSlugAndAddress);
    if (!byAddress.ok) return { ok: false, reason: "too_many_tries", retryAfterMs: byAddress.retryAfterMs };
  }
  const bySlug = await rateLimit(rateLimitKey("passcode-page", cleanSlug), LIMITS.perSlug);
  if (!bySlug.ok) return { ok: false, reason: "too_many_tries", retryAfterMs: bySlug.retryAfterMs };

  const text = typeof passcode === "string" ? passcode.normalize("NFKC").trim() : "";
  if (!isValidSlug(cleanSlug) || text.length < PASSCODE_MIN_LENGTH || text.length > PASSCODE_MAX_LENGTH) return { ok: false, reason: "wrong" };

  const db = await getDb();
  const [site] = await db
    .select({ id: schema.sites.id, passcodeHash: schema.sites.passcodeHash, status: schema.sites.status })
    .from(schema.sites)
    .where(eq(schema.sites.slug, cleanSlug))
    .limit(1);
  if (!site || site.status !== "published" || !site.passcodeHash) return { ok: false, reason: "wrong" };

  let matches: boolean;
  try {
    matches = (await verifyPassword(text, site.passcodeHash)).ok;
  } catch (error) {
    if (isPasswordBusy(error)) return { ok: false, reason: "busy" };
    throw error;
  }
  if (!matches) return { ok: false, reason: "wrong" };

  await rememberSiteUnlocked({ id: site.id, passcodeHash: site.passcodeHash });
  return { ok: true };
}

/** Marks this browser as having entered the page's current passcode. Server Action only. */
export async function rememberSiteUnlocked(site: SiteSecret): Promise<void> {
  if (!site.passcodeHash) return;
  const expiresAt = Date.now() + REMEMBER_MS;
  const seconds = Math.floor(expiresAt / 1000);
  const cookieStore = await cookies();
  cookieStore.set(cookieName(site.id), `${seconds}.${proofFor({ id: site.id, passcodeHash: site.passcodeHash }, seconds)}`, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

/**
 * True when this browser has entered the page's CURRENT passcode within the last 30 days.
 * Reads a cookie only, so it works while rendering (inside <Suspense>). A page without a
 * passcode is never "unlocked": there is nothing to have entered.
 */
export async function isSiteUnlocked(site: SiteSecret, now = new Date()): Promise<boolean> {
  if (!site.passcodeHash) return false;
  const value = (await cookies()).get(cookieName(site.id))?.value;
  if (!value) return false;
  const [seconds, proof, ...rest] = value.split(".");
  if (rest.length > 0 || !/^\d{1,12}$/.test(seconds ?? "") || !proof) return false;
  const expiresAtSeconds = Number(seconds);
  if (expiresAtSeconds * 1000 <= now.getTime()) return false;
  // A cookie cannot claim more than the 30 days it is ever given.
  if (expiresAtSeconds * 1000 > now.getTime() + REMEMBER_MS + MINUTE) return false;
  const expected = Buffer.from(proofFor({ id: site.id, passcodeHash: site.passcodeHash }, expiresAtSeconds));
  const given = Buffer.from(proof);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
