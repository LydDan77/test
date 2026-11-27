import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_USER_AGENT, fetchJson, fetchXml, HTTP_DEFAULTS, HttpError, userAgent } from "./http";
import { empty, fixture, html, json, stubFetch, xml } from "./providers/test-support";

const original = { ...HTTP_DEFAULTS };
beforeEach(() => {
  HTTP_DEFAULTS.retryDelayMs = 0; // no real pause between attempts in tests
});
afterEach(() => {
  Object.assign(HTTP_DEFAULTS, original);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const schema = z.object({ temp: z.number(), sky: z.string() });
const URL_WITH_QUERY = "https://api.example.org/v1/weather?latitude=41.88&longitude=-87.63";

/** Runs a request that must fail and returns the HttpError it threw. */
async function failureOf(work: Promise<unknown>): Promise<HttpError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("Expected the request to fail");
}

describe("userAgent", () => {
  it("is a generic name with no personal details by default", () => {
    vi.stubEnv("LIVE_DATA_USER_AGENT", "");
    expect(userAgent()).toBe(DEFAULT_USER_AGENT);
    expect(DEFAULT_USER_AGENT).toBe("trip-planner/1.0");
    expect(DEFAULT_USER_AGENT).not.toMatch(/@|https?:/);
  });

  it("can be replaced with an environment variable", () => {
    vi.stubEnv("LIVE_DATA_USER_AGENT", "  Example Planner/2.0 (https://example.org; ops@example.org)  ");
    expect(userAgent()).toBe("Example Planner/2.0 (https://example.org; ops@example.org)");
  });

  it("ignores a value that cannot go in a header", () => {
    for (const bad of ["line\nbreak", "tab\there", "naïve", "x".repeat(201)]) {
      vi.stubEnv("LIVE_DATA_USER_AGENT", bad);
      expect(userAgent()).toBe(DEFAULT_USER_AGENT);
    }
  });
});

describe("every request", () => {
  it("carries the User-Agent, an Accept header, a time limit, and opts out of the framework's cache", async () => {
    const stub = stubFetch(() => json({ temp: 71, sky: "Clear" }));
    await fetchJson(URL_WITH_QUERY, schema);
    const [call] = stub.calls;
    expect(call.url.href).toBe(URL_WITH_QUERY);
    expect(call.headers.get("user-agent")).toBe(DEFAULT_USER_AGENT);
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.init.cache).toBe("no-store");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.method).toBe("GET");
  });

  it("sends the configured User-Agent, and a caller cannot replace it by accident", async () => {
    vi.stubEnv("LIVE_DATA_USER_AGENT", "Example Planner/2.0");
    const stub = stubFetch(() => json({ temp: 71, sky: "Clear" }));
    await fetchJson(URL_WITH_QUERY, schema, { headers: { Accept: "application/geo+json", "User-Agent": "something else" } });
    expect(stub.calls[0].headers.get("user-agent")).toBe("Example Planner/2.0");
    expect(stub.calls[0].headers.get("accept")).toBe("application/geo+json");
  });
});

describe("fetchJson", () => {
  it("returns the validated document, without fields the schema does not name", async () => {
    stubFetch(() => json({ temp: 71, sky: "Clear", extra: "ignored" }));
    expect(await fetchJson(URL_WITH_QUERY, schema)).toEqual({ temp: 71, sky: "Clear" });
  });

  it("accepts the JSON content types these sources use", async () => {
    for (const type of ["application/json; charset=utf-8", "application/geo+json", "application/problem+json", "text/json"]) {
      stubFetch(() => json({ temp: 1, sky: "x" }, 200, type));
      expect(await fetchJson(URL_WITH_QUERY, schema), type).toEqual({ temp: 1, sky: "x" });
    }
  });

  it("accepts plain JSON sent with no content type or a vague one", async () => {
    for (const type of ["", "text/plain", "application/octet-stream"]) {
      stubFetch(() => ({ status: 200, contentType: type, body: `{"temp":1,"sky":"x"}` }));
      expect(await fetchJson(URL_WITH_QUERY, schema), type || "none").toEqual({ temp: 1, sky: "x" });
    }
  });

  it("refuses an HTML page served with status 200, before trying to parse it", async () => {
    stubFetch(() => html(fixture("nws-error-no-user-agent.html")));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.kind).toBe("content_type");
    expect(error.message).toContain("expected JSON, got text/html");
  });

  it("refuses XML where JSON was asked for", async () => {
    stubFetch(() => xml("<rss/>"));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).kind).toBe("content_type");
    stubFetch(() => ({ status: 200, contentType: "text/plain", body: "<rss/>" }));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).kind).toBe("content_type");
  });

  it("reports a body that claims to be JSON and is not", async () => {
    for (const body of ["{", `{"temp": 71,`, "<html>oops</html>", "undefined"]) {
      stubFetch(() => json(body));
      expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).kind, body).toBe("malformed");
    }
  });

  it("reports a document of the wrong shape, naming the field but not its value", async () => {
    stubFetch(() => json({ temp: "seventy-one-secret", sky: "Clear" }));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.kind).toBe("shape");
    expect(error.message).toContain("unexpected shape at temp");
    expect(error.message).not.toContain("seventy-one-secret");

    stubFetch(() => json([1, 2, 3]));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).message).toContain("(top level)");
  });

  it("treats an empty answer as a failure unless the caller expects one", async () => {
    stubFetch(() => empty(204));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.kind).toBe("malformed");
    expect(error.status).toBe(204);

    stubFetch(() => empty(204));
    expect(await fetchJson(URL_WITH_QUERY, schema, { allowEmpty: true })).toBeNull();
    stubFetch(() => ({ status: 200, contentType: "application/json", body: "  \n" }));
    expect(await fetchJson(URL_WITH_QUERY, schema, { allowEmpty: true })).toBeNull();
  });

  it("never puts the query string in an error message", async () => {
    stubFetch(() => html("<html>down</html>", 503));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema, { retries: 0 }));
    expect(error.message).toBe("api.example.org/v1/weather: HTTP 503");
    expect(error.message).not.toContain("41.88");
  });
});

describe("retrying", () => {
  it("tries once more after a server error, and succeeds if the second answer is good", async () => {
    const stub = stubFetch((_url, index) => (index === 0 ? html("<html>Bad gateway</html>", 502) : json({ temp: 71, sky: "Clear" })));
    expect(await fetchJson(URL_WITH_QUERY, schema)).toEqual({ temp: 71, sky: "Clear" });
    expect(stub.calls).toHaveLength(2);
  });

  it("gives up after the second server error", async () => {
    const stub = stubFetch(() => html("<html>Service unavailable</html>", 503));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.kind).toBe("status");
    expect(error.status).toBe(503);
    expect(stub.calls).toHaveLength(2);
  });

  it("tries once more after a network error", async () => {
    const stub = stubFetch((_url, index) => (index === 0 ? "network-error" : json({ temp: 71, sky: "Clear" })));
    expect(await fetchJson(URL_WITH_QUERY, schema)).toEqual({ temp: 71, sky: "Clear" });
    expect(stub.calls).toHaveLength(2);
  });

  it("reports a network error that happens twice, with the system's code", async () => {
    const stub = stubFetch(() => "network-error");
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
    expect(error.message).toBe("api.example.org/v1/weather: ECONNREFUSED");
    expect(stub.calls).toHaveLength(2);
  });

  it("makes exactly one attempt when told not to retry", async () => {
    const stub = stubFetch(() => html("down", 500));
    await failureOf(fetchJson(URL_WITH_QUERY, schema, { retries: 0 }));
    expect(stub.calls).toHaveLength(1);
  });

  it("waits between the two attempts", async () => {
    const stub = stubFetch(() => html("down", 500));
    const started = Date.now();
    await failureOf(fetchJson(URL_WITH_QUERY, schema, { retryDelayMs: 60 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a 4xx, and keeps the start of the body for the caller to read", async () => {
    const stub = stubFetch(() => json(fixture("nws-error-point-out-of-bounds.json"), 400, "application/problem+json"));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.kind).toBe("status");
    expect(error.status).toBe(400);
    expect(error.body).toContain("out of bounds");
    expect(stub.calls).toHaveLength(1);
  });

  it("does not retry a 404 HTML page either", async () => {
    const stub = stubFetch(() => html("<html><body>Website Unavailable</body></html>", 404));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.status).toBe(404);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("being asked to slow down (429)", () => {
  it("is reported as rate_limited and never retried", async () => {
    const stub = stubFetch(() => json(fixture("open-meteo-archive-error-daily-limit.json"), 429));
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema));
    expect(error.kind).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBeNull();
    expect(error.body).toContain("Daily API request limit exceeded");
    expect(stub.calls).toHaveLength(1);
  });

  it("passes on Retry-After given in seconds", async () => {
    stubFetch(() => ({ status: 429, contentType: "application/json", body: "{}", headers: { "retry-after": "120" } }));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).retryAfterMs).toBe(120_000);
  });

  it("passes on Retry-After given as a date, and caps a silly one at a day", async () => {
    const inFiveMinutes = new Date(Date.now() + 5 * 60_000).toUTCString();
    stubFetch(() => ({ status: 429, body: "", headers: { "retry-after": inFiveMinutes } }));
    const wait = (await failureOf(fetchJson(URL_WITH_QUERY, schema))).retryAfterMs ?? 0;
    expect(wait).toBeGreaterThan(4 * 60_000);
    expect(wait).toBeLessThanOrEqual(5 * 60_000);

    stubFetch(() => ({ status: 429, body: "", headers: { "retry-after": "99999999" } }));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).retryAfterMs).toBe(24 * 60 * 60_000);
    stubFetch(() => ({ status: 429, body: "", headers: { "retry-after": "soon" } }));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).retryAfterMs).toBeNull();
  });
});

describe("time limit", () => {
  it("gives up when the source does not answer in time, without a second attempt", async () => {
    const stub = stubFetch(() => "hang");
    const started = Date.now();
    const error = await failureOf(fetchJson(URL_WITH_QUERY, schema, { timeoutMs: 40 }));
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("api.example.org/v1/weather: no answer within 40 ms");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stub.calls).toHaveLength(1);
  });

  it("uses the default limit of eight seconds", () => {
    expect(original.timeoutMs).toBe(8_000);
    expect(original.retries).toBe(1);
  });
});

describe("size limit", () => {
  it("refuses a body the source says is too large", async () => {
    stubFetch(() => ({ status: 200, contentType: "application/json", body: "{}", headers: { "content-length": "999999999" } }));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema))).kind).toBe("too_large");
  });

  it("refuses a body that turns out to be too large", async () => {
    stubFetch(() => json({ temp: 1, sky: "x".repeat(500) }));
    expect((await failureOf(fetchJson(URL_WITH_QUERY, schema, { maxBytes: 100 }))).kind).toBe("too_large");
  });
});

describe("fetchXml", () => {
  const FEED = "https://feeds.example.org/news/rss.xml";

  it("returns the root element of a real feed", async () => {
    const stub = stubFetch(() => xml(fixture("bbc-news.xml"), "text/xml; charset=utf-8"));
    const root = await fetchXml(FEED, { root: ["rss", "feed"] });
    expect(root.name).toBe("rss");
    expect(stub.calls[0].headers.get("accept")).toContain("application/rss+xml");
    expect(stub.calls[0].headers.get("user-agent")).toBe(DEFAULT_USER_AGENT);
  });

  it("accepts the XML content types these sources use", async () => {
    for (const type of ["application/xml", "text/xml", "application/rss+xml; charset=UTF-8", "application/atom+xml"]) {
      stubFetch(() => xml(fixture("skift.xml"), type));
      expect((await fetchXml(FEED, { root: "rss" })).name, type).toBe("rss");
    }
  });

  it("accepts a real feed that is mislabelled as text/html, as the CDC's is", async () => {
    stubFetch(() => ({ status: 200, contentType: "text/html; charset=utf-8", body: fixture("cdc-notices.xml") }));
    expect((await fetchXml(FEED, { root: "rss" })).name).toBe("rss");
  });

  it("accepts a document with no declaration that starts with the expected root, or with a comment", async () => {
    stubFetch(() => ({ status: 200, contentType: "", body: fixture("faa-airport-status-information.xml") }));
    expect((await fetchXml(FEED, { root: "AIRPORT_STATUS_INFORMATION" })).name).toBe("AIRPORT_STATUS_INFORMATION");
    stubFetch(() => ({ status: 200, contentType: "text/plain", body: fixture("faa-airport-status-information.no-delays.reconstructed.xml") }));
    expect((await fetchXml(FEED, { root: "AIRPORT_STATUS_INFORMATION" })).name).toBe("AIRPORT_STATUS_INFORMATION");
  });

  it("refuses the HTML block pages these sources really serve, whatever they are labelled", async () => {
    for (const name of ["npr-error-403.html", "nws-error-no-user-agent.html", "google-news-blocked-503.html"]) {
      for (const type of ["text/html", "application/xml", ""]) {
        stubFetch(() => ({ status: 200, contentType: type, body: fixture(name) }));
        const error = await failureOf(fetchXml(FEED, { root: ["rss", "feed"] }));
        expect(error.kind, `${name} as ${type || "nothing"}`).toBe("content_type");
      }
    }
  });

  it("reports a 403 block page by its status", async () => {
    const stub = stubFetch(() => html(fixture("npr-error-403.html"), 403));
    const error = await failureOf(fetchXml(FEED, { root: "rss" }));
    expect(error.kind).toBe("status");
    expect(error.status).toBe(403);
    expect(stub.calls).toHaveLength(1);
  });

  it("reports XML that is cut off or broken", async () => {
    const whole = fixture("skift.xml");
    stubFetch(() => xml(whole.slice(0, Math.floor(whole.length / 2))));
    const error = await failureOf(fetchXml(FEED, { root: "rss" }));
    expect(error.kind).toBe("malformed");
    expect(error.message).toContain("not well-formed XML");
  });

  it("reports an empty answer, JSON, and a different kind of XML document", async () => {
    stubFetch(() => xml(""));
    expect((await failureOf(fetchXml(FEED, { root: "rss" }))).kind).toBe("malformed");
    stubFetch(() => json({ error: true }));
    expect((await failureOf(fetchXml(FEED, { root: "rss" }))).kind).toBe("content_type");
    stubFetch(() => xml(`<?xml version="1.0"?><soap:Envelope><soap:Body/></soap:Envelope>`));
    const error = await failureOf(fetchXml(FEED, { root: ["rss", "feed"] }));
    expect(error.kind).toBe("shape");
    expect(error.message).toContain("unexpected root element <soap:Envelope>");
  });

  it("retries a server error and times out like fetchJson", async () => {
    const stub = stubFetch((_url, index) => (index === 0 ? html("down", 500) : xml(fixture("npr-top.xml"), "text/xml;charset=UTF-8")));
    expect((await fetchXml(FEED, { root: "rss" })).name).toBe("rss");
    expect(stub.calls).toHaveLength(2);

    stubFetch(() => "hang");
    expect((await failureOf(fetchXml(FEED, { root: "rss", timeoutMs: 30 }))).kind).toBe("timeout");
  });
});
