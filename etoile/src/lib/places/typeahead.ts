import "server-only";

import { getUser } from "@/lib/auth";
import { describeWait, rateLimit, rateLimitKey } from "@/lib/rate-limit";

// What the two typeahead routes (/api/places and /api/airports) share: only a signed-in person
// may ask, not too often, and only with a query of a sensible size.

export const TYPEAHEAD_QUERY_MAX = 80;
/** A fast typist sends a request every few keystrokes; this is far above that and far below a scrape. */
const LIMIT = { limit: 120, windowMs: 60_000 } as const;

const HEADERS = { "cache-control": "private, no-store" } as const;

export function typeaheadJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...headers } });
}

export type TypeaheadRequest = { ok: true; query: string } | { ok: false; response: Response };

/**
 * Checks a typeahead request: 401 without a session, 429 over the limit, 400 for a query that
 * is too long. A missing or empty `q` is fine and comes back as "" (the route answers with no
 * results). `scope` names the limit, one per route.
 */
export async function readTypeaheadRequest(request: Request, scope: string): Promise<TypeaheadRequest> {
  const user = await getUser();
  if (!user) {
    return { ok: false, response: typeaheadJson({ ok: false, error: "Sign in to search." }, 401) };
  }

  const limit = await rateLimit(rateLimitKey(scope, user.id), LIMIT);
  if (!limit.ok) {
    return {
      ok: false,
      response: typeaheadJson(
        { ok: false, error: `Too many searches. Wait ${describeWait(limit.retryAfterMs)} and try again.` },
        429,
        { "retry-after": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) },
      ),
    };
  }

  const query = (new URL(request.url).searchParams.get("q") ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (query.length > TYPEAHEAD_QUERY_MAX) {
    return { ok: false, response: typeaheadJson({ ok: false, error: "That search is too long. Try the name of a city." }, 400) };
  }
  return { ok: true, query };
}
