import "server-only";

import type { z } from "zod";
import { parseXml, XmlError, type XmlElement } from "./providers/xml";

// The one way this app asks an outside source for data.
//
// Every live-data provider goes through fetchJson() or fetchXml(). They add what each source
// needs and none of them gives for free:
//  - a time limit, so a slow source cannot hold a page;
//  - one more try after a server error (5xx) or a dropped connection, never after a 4xx;
//  - a User-Agent (the US weather service refuses requests without one);
//  - a check that the answer is the kind of document that was asked for, before parsing it:
//    several of these sources answer an outage with an HTML page and status 200;
//  - validation of the parsed shape, so a changed feed is treated like an outage rather than
//    shown as "nothing to report".
//
// Both functions throw HttpError and nothing else. Providers call them inside cached(), which
// turns a throw into "use the last good answer".

/**
 * Sent when LIVE_DATA_USER_AGENT is not set. It says what kind of program is asking and nothing
 * about who runs it. A deployment should set LIVE_DATA_USER_AGENT to its own name and a contact
 * address, which the weather service asks for: "Example Planner/1.0 (https://example.org; ops@example.org)".
 */
export const DEFAULT_USER_AGENT = "trip-planner/1.0";

/** The User-Agent every request carries: LIVE_DATA_USER_AGENT when it is set and usable. */
export function userAgent(): string {
  const configured = process.env.LIVE_DATA_USER_AGENT?.trim();
  // Printable ASCII only: anything else cannot go in a header.
  if (configured && configured.length <= 200 && /^[\x20-\x7e]+$/.test(configured)) return configured;
  return DEFAULT_USER_AGENT;
}

/** Starting values for every request. Tests shorten the pause; nothing else should change them. */
export const HTTP_DEFAULTS = {
  /** How long one attempt may take, connection and body together. */
  timeoutMs: 8_000,
  /** Extra attempts after a 5xx answer or a network error. */
  retries: 1,
  /** The pause before the extra attempt. */
  retryDelayMs: 1_500,
  /** Bodies larger than this are refused. The largest feed in use is about 0.6 MB. */
  maxBytes: 5_000_000,
};

export type HttpFailureKind =
  /** No answer within the time limit. Not retried: the page has waited long enough. */
  | "timeout"
  /** The connection failed (DNS, refused, reset, TLS), also on the second try. */
  | "network"
  /** A status outside 200-299 other than 429. `status` says which. */
  | "status"
  /** 429: the source says to slow down. Never retried here; `retryAfterMs` says how long it asked for. */
  | "rate_limited"
  /** The body is not the kind of document asked for (an HTML error page instead of JSON or XML). */
  | "content_type"
  /** The body is empty or does not parse. */
  | "malformed"
  /** The body parsed but is not the shape this app understands. */
  | "shape"
  /** The body is larger than `maxBytes`. */
  | "too_large";

export class HttpError extends Error {
  readonly kind: HttpFailureKind;
  /** The HTTP status, when there was an answer. */
  readonly status: number | null;
  /** How long the source asked us to wait (429 with Retry-After). */
  readonly retryAfterMs: number | null;
  /** The start of the body of a non-2xx answer, so a provider can read the source's own error message. */
  readonly body: string | null;

  constructor(
    kind: HttpFailureKind,
    message: string,
    details: { status?: number | null; retryAfterMs?: number | null; body?: string | null } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.status = details.status ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.body = details.body ?? null;
  }
}

export type HttpOptions = {
  /** Default 8 s. The State Department feed (0.6 MB) gets 15 s. */
  timeoutMs?: number;
  /** Extra attempts after a 5xx or a network error. Default 1. */
  retries?: number;
  retryDelayMs?: number;
  maxBytes?: number;
  /** Extra request headers. `Accept` here replaces the default for the document kind. */
  headers?: Record<string, string>;
};

type RawResponse = { status: number; contentType: string; body: string; headers: Headers };

/** Host and path only: a query string can hold a person's coordinates, which do not belong in a log. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid URL";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return "request failed";
  const cause = (error as { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : "";
  return code || error.message || error.name;
}

/** `Retry-After` as milliseconds from now: either a number of seconds or an HTTP date. */
function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(value)) ms = Number(value) * 1000;
  else {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return null;
    ms = at - Date.now();
  }
  return Math.min(Math.max(0, Math.round(ms)), 24 * 60 * 60_000);
}

async function request(url: string, accept: string, options: HttpOptions): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? HTTP_DEFAULTS.timeoutMs;
  const retries = options.retries ?? HTTP_DEFAULTS.retries;
  const retryDelayMs = options.retryDelayMs ?? HTTP_DEFAULTS.retryDelayMs;
  const maxBytes = options.maxBytes ?? HTTP_DEFAULTS.maxBytes;
  const where = describeUrl(url);

  for (let attempt = 0; ; attempt++) {
    const mayRetry = attempt < retries;
    let response: Response;
    let body: string;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: accept, ...options.headers, "User-Agent": userAgent() },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
        // The answer is kept in signal_cache by the caller, shared by every server instance.
        cache: "no-store",
      });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError("too_large", `${where}: the answer is larger than ${maxBytes} bytes`, { status: response.status });
      }
      body = response.status === 204 ? "" : await response.text();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (isTimeout(error)) throw new HttpError("timeout", `${where}: no answer within ${timeoutMs} ms`);
      if (mayRetry) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new HttpError("network", `${where}: ${describeCause(error)}`);
    }

    if (body.length > maxBytes) {
      throw new HttpError("too_large", `${where}: the answer is larger than ${maxBytes} bytes`, { status: response.status });
    }
    if (response.status === 429) {
      throw new HttpError("rate_limited", `${where}: HTTP 429, asked to slow down`, {
        status: 429,
        retryAfterMs: retryAfterMs(response.headers),
        body: body.slice(0, 2000),
      });
    }
    if (response.status >= 500 && mayRetry) {
      await sleep(retryDelayMs);
      continue;
    }
    if (response.status < 200 || response.status > 299) {
      throw new HttpError("status", `${where}: HTTP ${response.status}`, { status: response.status, body: body.slice(0, 2000) });
    }
    return { status: response.status, contentType: (response.headers.get("content-type") ?? "").toLowerCase(), body, headers: response.headers };
  }
}

const looksLikeHtml = (body: string) => /^\s*(<!doctype\s+html|<html[\s>])/i.test(body);

/**
 * GETs a JSON document and returns it validated against `schema`.
 *
 *   const data = await fetchJson(url, forecastSchema);
 *
 * An answer with no body (HTTP 204, which one source uses for "no data for this country") is a
 * "malformed" failure unless `allowEmpty` is set, in which case the result is `null`.
 * Throws HttpError; `error.kind`, `error.status` and `error.body` say what happened.
 */
export async function fetchJson<S extends z.ZodType>(url: string, schema: S, options?: HttpOptions & { allowEmpty?: false }): Promise<z.infer<S>>;
export async function fetchJson<S extends z.ZodType>(url: string, schema: S, options: HttpOptions & { allowEmpty: true }): Promise<z.infer<S> | null>;
export async function fetchJson<S extends z.ZodType>(
  url: string,
  schema: S,
  options: HttpOptions & { allowEmpty?: boolean } = {},
): Promise<z.infer<S> | null> {
  const where = describeUrl(url);
  const raw = await request(url, "application/json", options);
  const text = raw.body.trim();
  if (text === "") {
    if (options.allowEmpty) return null;
    throw new HttpError("malformed", `${where}: the answer is empty (HTTP ${raw.status})`, { status: raw.status });
  }
  // "application/json", "application/geo+json", "application/problem+json" all qualify. A source
  // that forgets the header still qualifies when the body plainly is JSON.
  const declaredJson = raw.contentType.includes("json");
  const plainlyJson = (text[0] === "{" || text[0] === "[") && !raw.contentType.includes("html") && !raw.contentType.includes("xml");
  if (!declaredJson && !plainlyJson) {
    throw new HttpError("content_type", `${where}: expected JSON, got ${raw.contentType || "no content type"}`, { status: raw.status });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError("malformed", `${where}: the answer is not valid JSON`, { status: raw.status });
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "(top level)";
    throw new HttpError("shape", `${where}: unexpected shape at ${path}: ${issue?.message ?? "invalid"}`, { status: raw.status });
  }
  return checked.data;
}

/**
 * GETs an XML document and returns its root element.
 *
 *   const rss = await fetchXml(feedUrl, { root: ["rss", "feed"] });
 *
 * `root` names the root elements this caller understands; any other root is a "shape" failure.
 * The content type is checked first, but the body has the last word: one government feed
 * declares its RSS as text/html, and an HTML error page can arrive as anything.
 * Throws HttpError.
 */
export async function fetchXml(url: string, options: HttpOptions & { root: string | readonly string[] }): Promise<XmlElement> {
  const where = describeUrl(url);
  const roots = typeof options.root === "string" ? [options.root] : [...options.root];
  const raw = await request(url, "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1", options);
  const text = raw.body.replace(/^\uFEFF/, "").trim();
  if (text === "") throw new HttpError("malformed", `${where}: the answer is empty (HTTP ${raw.status})`, { status: raw.status });

  const declaredXml = raw.contentType.includes("xml");
  // "<?xml", or the expected root straight away (after any leading comments).
  const start = text.replace(/^(\s*<!--[\s\S]*?-->)+\s*/, "");
  const plainlyXml = start.startsWith("<?xml") || roots.some((root) => start.startsWith(`<${root}`));
  if (looksLikeHtml(text) || (!declaredXml && !plainlyXml)) {
    throw new HttpError("content_type", `${where}: expected XML, got ${looksLikeHtml(text) ? "an HTML page" : raw.contentType || "no content type"}`, {
      status: raw.status,
    });
  }
  let rootElement: XmlElement;
  try {
    rootElement = parseXml(text);
  } catch (error) {
    const why = error instanceof XmlError ? error.message : "parse error";
    throw new HttpError("malformed", `${where}: the answer is not well-formed XML: ${why}`, { status: raw.status });
  }
  if (!roots.includes(rootElement.name)) {
    throw new HttpError("shape", `${where}: unexpected root element <${rootElement.name}>`, { status: raw.status });
  }
  return rootElement;
}
