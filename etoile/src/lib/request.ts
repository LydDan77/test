import "server-only";

import { isIP } from "node:net";
import { ipAddress } from "@vercel/functions";
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

/** What clientIp() gives when no trustworthy address is known. Every such request shares it. */
export const UNKNOWN_ADDRESS = "unknown";

type HeaderReader = { get(name: string): string | null };

let warnedUntrusted = false;

/**
 * One address in the form used for rate-limit keys, or null when the text is not an address.
 * An IPv4 address stays as it is. An IPv6 address is cut to its /64 ("2001:db8:1:2::/64"): one
 * customer line usually holds a whole /64, so counting single addresses would let one machine
 * be millions of visitors. An IPv4 address written the IPv6 way ("::ffff:203.0.113.7") is IPv4.
 */
export function normalizeAddress(value: string | null | undefined): string | null {
  let text = (value ?? "").trim();
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]")); // "[2001:db8::1]:443"
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone); // "fe80::1%eth0"
  if (isIP(text) === 4) return text;
  if (isIP(text) !== 6) {
    // "203.0.113.7:51234": an IPv4 address with a port.
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
    return withPort && isIP(withPort[1]) === 4 ? withPort[1] : null;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  // Expand "::" and keep the first four groups.
  const [head, tail = ""] = text.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  // A trailing dotted quad ("64:ff9b::192.0.2.1") stands for two groups; only its place matters here.
  const tailLength = tailGroups.length + (tailGroups.some((group) => group.includes(".")) ? 1 : 0);
  const zeros = text.includes("::") ? Math.max(0, 8 - headGroups.length - tailLength) : 0;
  const groups = [...headGroups, ...Array<string>(zeros).fill("0"), ...tailGroups].slice(0, 4);
  return `${groups.map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * The address a request came from, read from request headers. The logic behind clientIp(), as a
 * plain function so it can be tested: see clientIp() for the rules.
 */
export function clientIpFrom(h: HeaderReader, env: Record<string, string | undefined> = process.env): string {
  if (env.VERCEL) {
    // The platform sets x-real-ip (what ipAddress() reads) and overwrites x-forwarded-for
    // itself; a visitor cannot choose either.
    const fromPlatform = ipAddress(h as unknown as Headers) ?? h.get("x-forwarded-for")?.split(",")[0];
    return normalizeAddress(fromPlatform) ?? UNKNOWN_ADDRESS;
  }

  const proxies = Number(env.TRUSTED_PROXY_COUNT);
  if (Number.isInteger(proxies) && proxies >= 1) {
    // Each proxy appends the address it saw to the right of x-forwarded-for, so with N proxies
    // of our own in front, the Nth entry from the right was written by the outermost of them
    // and is the visitor's real address. Everything to its left was sent by the visitor.
    const entries = (h.get("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    return normalizeAddress(entries[entries.length - proxies]) ?? UNKNOWN_ADDRESS;
  }

  // No platform and no proxy we were told about: x-forwarded-for and x-real-ip are whatever
  // the visitor sent (Next.js fills x-forwarded-for from the connection only when it is
  // absent), so neither can be believed.
  if (env.NODE_ENV === "production" && !warnedUntrusted) {
    warnedUntrusted = true;
    console.warn(
      "[request] WARNING: TRUSTED_PROXY_COUNT is not set, so the visitor's address is not known. All visitors share one " +
        "allowance for every per-address limit. Set TRUSTED_PROXY_COUNT to the number of reverse proxies in front of this server.",
    );
  }
  return UNKNOWN_ADDRESS;
}

/**
 * The address a request came from, for rate limiting. Reads headers(), so it is request-time
 * data: call it in a Server Action or Route Handler.
 *
 * The address comes from one place that the visitor cannot write to:
 *  - on Vercel: the platform's own header;
 *  - behind your own reverse proxies: set TRUSTED_PROXY_COUNT to how many there are, and the
 *    entry that many places from the right of x-forwarded-for is used;
 *  - otherwise nothing is trusted and the answer is "unknown" for everyone. Per-address limits
 *    then count all visitors together: stricter than intended, never looser. (A header a
 *    visitor can set must not choose the allowance: one client could be a new address on every
 *    request.)
 *
 * IPv6 addresses are counted by /64. Use the result only in a rate-limit key, and pair every
 * per-address limit with one that does not depend on the address (per account, or site-wide):
 * an attacker with many real addresses exists too.
 */
export async function clientIp(): Promise<string> {
  return clientIpFrom(await headers());
}

/** The visitor's IANA time zone as the hosting platform sees it (Vercel only), or null. */
export async function platformTimeZone(): Promise<string | null> {
  const h = await headers();
  return h.get("x-vercel-ip-timezone")?.trim() || null;
}
