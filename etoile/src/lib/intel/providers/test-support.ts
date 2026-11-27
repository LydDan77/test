// Test helper. Import only from *.test.ts files.
//
// Loads the captured responses in ../__fixtures__ and replaces the global fetch with a
// scripted one, so the real http helper, the real parsers and the real cache run in every
// provider test and only the network is pretend.

import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";

const FIXTURES = path.join(process.cwd(), "src", "lib", "intel", "__fixtures__");

/** The text of a file in src/lib/intel/__fixtures__. */
export function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** What the pretend network answers with. */
export type Scripted =
  | { status?: number; contentType?: string; body?: string; headers?: Record<string, string> }
  /** Never answers: the request ends when its time limit aborts it. */
  | "hang"
  /** The connection fails the way a refused connection does. */
  | "network-error";

export const json = (body: string | object, status = 200, contentType = "application/json"): Scripted => ({
  status,
  contentType,
  body: typeof body === "string" ? body : JSON.stringify(body),
});
export const xml = (body: string, contentType = "application/xml"): Scripted => ({ status: 200, contentType, body });
export const html = (body: string, status = 200): Scripted => ({ status, contentType: "text/html", body });
export const empty = (status = 204): Scripted => ({ status, body: "" });

export type FetchStub = {
  /** Every request made so far, oldest first. */
  calls: { url: URL; headers: Headers; init: RequestInit }[];
  /** Forgets the requests made so far. */
  reset: () => void;
};

/**
 * Replaces the global fetch until vi.unstubAllGlobals(). `respond` is called for each request,
 * with how many requests were made before it.
 */
export function stubFetch(respond: (url: URL, index: number) => Scripted | Promise<Scripted>): FetchStub {
  const stub: FetchStub = {
    calls: [],
    reset: () => {
      stub.calls.length = 0;
    },
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const index = stub.calls.length;
    stub.calls.push({ url, headers: new Headers(init.headers), init });
    const scripted = await respond(url, index);
    if (scripted === "network-error") {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.1:443"), { code: "ECONNREFUSED" }) });
    }
    if (scripted === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return; // would wait for ever: the helper must always pass a signal
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const status = scripted.status ?? 200;
    const headers = new Headers(scripted.headers);
    if (scripted.contentType) headers.set("content-type", scripted.contentType);
    const hasBody = status !== 204 && status !== 304 && scripted.body !== undefined;
    return new Response(hasBody ? scripted.body : null, { status, headers });
  });
  return stub;
}
