// Validation of the `?next=` target used after sign-in. Pure.
//
// proxy.ts sends a signed-out visitor to /sign-in?next=/plans/abc. After signing in they go
// back there. The value comes from the URL, so anyone can put anything in it: without this
// check, a link to /sign-in?next=https://evil.example would turn the sign-in page into a
// redirect to another site.

const FALLBACK = "/";
const BASE = "http://internal.invalid";

/**
 * True when `path` is a path on this site as a browser reads it: it starts with exactly one
 * "/", holds no backslash or control character, and resolves to this origin.
 */
function isLocalPath(path: string): boolean {
  // Must be a path: "/plans/abc". Not "//host", not "/\host" (browsers treat \ as /).
  if (path[0] !== "/" || path[1] === "/" || path[1] === "\\") return false;
  // No backslashes or control characters anywhere (tabs and newlines are stripped by browsers,
  // which can turn "/\t/host" into "//host").
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    return new URL(path, BASE).origin === BASE;
  } catch {
    return false;
  }
}

/**
 * Returns `value` when it is a path on this site, otherwise "/".
 * Accepts only a string that starts with exactly one "/" and stays on this origin.
 *
 * The answer is the path after the URL parser has normalised it, and it is that RESULT which
 * is checked, not only what came in: dot segments are removed by the parser, so "/.//evil.example"
 * (one leading slash, harmless to look at) comes out as "//evil.example", an address on another
 * site.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return FALLBACK;
  if (value.length === 0 || value.length > 2000) return FALLBACK;
  if (!isLocalPath(value)) return FALLBACK;

  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== BASE) return FALLBACK;
  // An empty path segment ("/a//b") is never one of ours, and it is how a normalised path ends
  // up starting with "//".
  if (url.pathname.includes("//")) return FALLBACK;

  const path = `${url.pathname}${url.search}${url.hash}`;
  // Check what is about to be returned, and that normalising it again changes nothing.
  if (!isLocalPath(path)) return FALLBACK;
  const again = new URL(path, BASE);
  if (`${again.pathname}${again.search}${again.hash}` !== path) return FALLBACK;

  // Sending someone who just signed in back to an auth page would loop.
  if (/^\/(sign-in|sign-up)(\/|$|\?|#)/.test(path)) return FALLBACK;
  return path;
}
