// Identifiers and secret tokens. Uses the Web Crypto global (present in Node 22 and in
// browsers), so this module has no imports and is safe anywhere. Generate ids on the server.
//
// Cache Components note: random values are request-time data. Call these in Server Actions,
// Route Handlers, or after `await getDb()`; never while rendering a static shell.

// Crockford base 32, lower case: no i, l, o or u, so an id cannot be misread or spell much.
// 32 symbols means each random byte maps to a symbol with no modulo bias (byte & 31).
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 12; // 60 bits

/**
 * A short random id for a database row: 12 characters of [0-9a-z] (60 bits), safe in a URL.
 * Ids are NOT secrets: never grant access because someone knows an id. Check ownership
 * (`requirePlan`) or use `newToken()` for anything that works as a key.
 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[bytes[i] & 31];
  return id;
}

const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{12}$/;

/** True when `value` has the shape `newId()` produces. Use it to reject junk before a query. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * A secret token: 32 random bytes as base64url (43 characters, 256 bits). For guest links,
 * session cookies and anything else where knowing the value is the permission.
 */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** True when `value` has the shape `newToken()` produces. */
export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}
