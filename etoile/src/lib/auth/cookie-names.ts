// The session cookie's two possible names, in a module with no server-only imports so that
// src/proxy.ts (which must stay cheap and never touch the database) can share them with
// src/lib/auth/session.ts.

import { BRAND } from "@/lib/brand";

/** Used on plain http (local development, the end-to-end test server). */
export const PLAIN_SESSION_COOKIE = `${BRAND.ascii}_session`;
/**
 * Used when the cookie is Secure. The __Host- prefix makes the browser refuse the cookie unless
 * it is Secure, has Path=/ and has no Domain attribute, so a sibling subdomain cannot plant or
 * overwrite it.
 */
export const SECURE_SESSION_COOKIE = `__Host-${PLAIN_SESSION_COOKIE}`;

export const SESSION_COOKIE_NAMES = [SECURE_SESSION_COOKIE, PLAIN_SESSION_COOKIE] as const;
