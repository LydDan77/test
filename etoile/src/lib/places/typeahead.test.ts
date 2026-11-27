import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The two typeahead routes, called the way Next calls them: GET(request). Who is signed in is
// the one thing stubbed; the rate limiter, the cache and the airport table are the real ones.
const session: { user: { id: string } | null } = { user: null };
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getUser: async () => session.user,
}));

import { GET as airports } from "@/app/api/airports/route";
import { GET as places } from "@/app/api/places/route";
import { createTestDb, type TestDb } from "@/db/testing";
import { placeRefSchema } from "@/lib/domain";
import { newId } from "@/lib/ids";

const fixture = (name: string) => readFileSync(path.join(process.cwd(), "src/lib/places/__fixtures__", `${name}.json`), "utf8");
const get = (pathAndQuery: string) => new Request(`http://localhost:3000${pathAndQuery}`);

let fetched = 0;
function serve(body: string | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      fetched += 1;
      if (body instanceof Error) throw body;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => {
  // A fresh person every test, so one test's searches never count against another's limit.
  session.user = { id: newId() };
  fetched = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/airports", () => {
  it("answers a signed-in person with airports, each ready to store as a place", async () => {
    const response = await airports(get("/api/airports?q=orlando"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.source).toContain("CC BY 4.0");
    expect(body.results[0]).toEqual({
      iata: "MCO",
      name: "Orlando International Airport",
      city: "Orlando",
      country: "US",
      countryName: "United States",
      tz: "America/New_York",
      place: { kind: "airport", name: "Orlando International Airport", locality: "Orlando", countryCode: "US", lat: 28.4322, lon: -81.3083, tz: "America/New_York", iata: "MCO" },
      label: "Orlando International Airport (MCO), Orlando, United States",
    });
    expect(body.results.length).toBeLessThanOrEqual(8);
    for (const result of body.results) expect(placeRefSchema.safeParse(result.place).success).toBe(true);
  });

  it("finds by code, and answers an empty list for nothing typed or nothing found", async () => {
    expect((await (await airports(get("/api/airports?q=msp"))).json()).results[0].iata).toBe("MSP");
    for (const query of ["", "?q=", "?q=%20", "?q=m", "?q=zzzzqqqxj"]) {
      const response = await airports(get(`/api/airports${query}`));
      expect(response.status, query).toBe(200);
      expect((await response.json()).results, query).toEqual([]);
    }
  });

  it("refuses a visitor who is not signed in", async () => {
    session.user = null;
    const response = await airports(get("/api/airports?q=orlando"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "Sign in to search." });
  });

  it("refuses a query that is too long", async () => {
    const response = await airports(get(`/api/airports?q=${"a".repeat(81)}`));
    expect(response.status).toBe(400);
    expect((await response.json()).ok).toBe(false);
    expect((await airports(get(`/api/airports?q=${"a".repeat(80)}`))).status).toBe(200);
  });

  it("slows down someone who asks far more often than typing can", async () => {
    let last = await airports(get("/api/airports?q=sea"));
    for (let i = 1; i < 120; i++) last = await airports(get("/api/airports?q=sea"));
    expect(last.status).toBe(200);

    const over = await airports(get("/api/airports?q=sea"));
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await over.json()).error).toMatch(/^Too many searches\. Wait .+ and try again\.$/);

    // The limit is per person and per route.
    expect((await places(get("/api/places?q=x"))).status).toBe(200);
    session.user = { id: newId() };
    expect((await airports(get("/api/airports?q=sea"))).status).toBe(200);
  });
});

describe("GET /api/places", () => {
  it("answers a signed-in person with places, each with a label that tells namesakes apart", async () => {
    serve(fixture("open-meteo-geocoding-springfield-us"));
    const response = await places(get("/api/places?q=Springfield"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, stale: false, unavailable: false, source: "Location data based on GeoNames, via Open-Meteo" });
    expect(body.results).toHaveLength(5);
    expect(body.results[0]).toEqual({
      place: { kind: "city", name: "Springfield", region: "Missouri", countryCode: "US", lat: 37.21533, lon: -93.29824, tz: "America/Chicago" },
      label: "Springfield, Missouri, United States",
      detail: "Missouri, United States",
    });
    for (const result of body.results) expect(placeRefSchema.safeParse(result.place).success).toBe(true);
  });

  it("answers an empty list, without asking the service, for nothing typed", async () => {
    serve(new Error("must not be called"));
    for (const query of ["", "?q=", "?q=l"]) {
      const body = await (await places(get(`/api/places${query}`))).json();
      expect(body).toMatchObject({ ok: true, results: [], unavailable: false });
    }
    expect(fetched).toBe(0);
  });

  it("says so when there is no such place, and says something else when the service is down", async () => {
    serve(fixture("open-meteo-geocoding-empty"));
    const none = await (await places(get("/api/places?q=zzzzqqqxj"))).json();
    expect(none).toMatchObject({ ok: true, results: [], unavailable: false, stale: false });

    serve(new Error("network down"));
    const down = await places(get("/api/places?q=Reykjavik"));
    // Still a 200: the typeahead carries on and offers "use it as typed".
    expect(down.status).toBe(200);
    expect(await down.json()).toMatchObject({ ok: true, results: [], unavailable: true, stale: true });
  });

  it("refuses a visitor who is not signed in, before anything is looked up", async () => {
    serve(new Error("must not be called"));
    session.user = null;
    const response = await places(get("/api/places?q=Lisbon"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "Sign in to search." });
    expect(fetched).toBe(0);
  });

  it("refuses a query that is too long", async () => {
    serve(new Error("must not be called"));
    const response = await places(get(`/api/places?q=${"a".repeat(200)}`));
    expect(response.status).toBe(400);
    expect(fetched).toBe(0);
  });
});
