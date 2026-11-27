// Validation of the `?next=` target used after sign-in. Pure.
//
// proxy.ts sends a signed-out visitor to /sign-in?next=/plans/abc. After signing in they go
// back there. The value comes from the URL, so anyone can put anything in it: without this
// check, a link to /sign-in?next=https://evil.example would turn the sign-in page into a
// redirect to another site.

const FALLBACK = "/";

/**
 * Returns `value` when it is a path on this site, otherwise "/".
 * Accepts only a string that starts with exactly one "/" and stays on this origin.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return FALLBACK;
  if (value.length === 0 || value.length > 2000) return FALLBACK;
  // Must be a path: "/plans/abc". Not "//host", not "/\host" (browsers treat \ as /).
  if (value[0] !== "/" || value[1] === "/" || value[1] === "\\") return FALLBACK;
  // No backslashes or control characters anywhere (tabs and newlines are stripped by browsers,
  // which can turn "/\t/host" into "//host").
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return FALLBACK;

  let url: URL;
  try {
    url = new URL(value, "http://internal.invalid");
  } catch {
    return FALLBACK;
  }
  if (url.origin !== "http://internal.invalid") return FALLBACK;

  const path = `${url.pathname}${url.search}${url.hash}`;
  // Sending someone who just signed in back to an auth page would loop.
  if (/^\/(sign-in|sign-up)(\/|$|\?|#)/.test(path)) return FALLBACK;
  return path;
}
