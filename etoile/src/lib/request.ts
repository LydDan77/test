import "server-only";

import { io } from "next/cache";
import { headers } from "next/headers";

/**
 * The current time, on the server. Use this instead of a bare `new Date()` in a Server
 * Component: `await io()` tells Next.js that what follows is request-time data, so the value can
 * never be frozen into a prerendered shell. The caller must be inside <Suspense>.
 * Pass the result down as `now` to the pure functions in @/lib/time, always with a zone:
 *
 *   const now = await requestNow();
 *   const today = localDateOf(now, plan.tz);
 *
 * (In a Server Action or Route Handler a plain `new Date()` is fine.)
 */
export async function requestNow(): Promise<Date> {
  await io();
  return new Date();
}

/**
 * The address a request came from, for rate limiting. Reads headers(), so it is request-time
 * data: call it in a Server Action or Route Handler.
 *
 * On Vercel the platform sets these headers and they can be trusted. Behind an unknown proxy a
 * client can forge x-forwarded-for, so never use this for anything but a rate-limit key, and
 * pair every per-address limit with one that does not depend on the address.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

/** The visitor's IANA time zone as the hosting platform sees it (Vercel only), or null. */
export async function platformTimeZone(): Promise<string | null> {
  const h = await headers();
  return h.get("x-vercel-ip-timezone")?.trim() || null;
}
