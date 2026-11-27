import "server-only";

import { headers } from "next/headers";

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
