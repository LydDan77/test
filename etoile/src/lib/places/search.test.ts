import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/db/testing";
import { peekCached } from "@/lib/cache";
import { placeRefSchema } from "@/lib/domain";
import { placeDetail, placeLabel, placeShortLabel } from "./labels";
import { normalizePlaceQuery, searchPlaces } from "./search";

// The place service is never called from tests: fetch is replaced by the real responses saved
// in __fixtures__ (see the README there for the request behind each).

const fixture = (name: string) => readFileSync(path.join(process.cwd(), "src/lib/places/__fixtures__", `${name}.json`), "utf8");

type Reply = { status?: number; body: string; contentType?: string } | Error;
const calls: URL[] = [];
function serve(reply: Reply | ((url: URL) => Reply)) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      calls.push(url);
      const answer = typeof reply === "function" ? reply(url) : reply;
      if (answer instanceof Error) throw answer;
      return new Response(answer.body, {
        status: answer.status ?? 200,
        headers: { "content-type": answer.contentType ?? "application/json; charset=utf-8" },
      });
    }),
  );
}

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("searchPlaces", () => {
  it("returns places with name, region, country, coordinates and time zone", async () => {
    serve({ body: fixture("open-meteo-geocoding-lisbon") });
    const found = await searchPlaces("Lisbon");
    expect(found.ok).toBe(true);
    expect(found.places[0]).toEqual({
      kind: "city",
      name: "Lisbon",
      region: "Lisbon District",
      countryCode: "PT",
      lat: 38.72509,
      lon: -9.1498,
      tz: "Europe/Lisbon",
    });
    // Every result is a PlaceRef the database accepts as it stands.
    expect(found.places).toHaveLength(5);
    for (const place of found.places) expect(placeRefSchema.safeParse(place).success).toBe(true);
    if (found.ok) expect(found.stale).toBe(false);
  });

  it("asks the documented endpoint, with the query, a count and a language", async () => {
    serve({ body: fixture("open-meteo-geocoding-lisbon") });
    await searchPlaces("  New   LISBON ");
    expect(calls).toHaveLength(1);
    expect(calls[0].origin + calls[0].pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({ name: "new lisbon", count: "10", language: "en", format: "json" });
  });

  it("puts the bigger place first when several share the name", async () => {
    // The service's own order is Missouri, Illinois, Massachusetts, Ohio, Tennessee: not by size.
    serve({ body: fixture("open-meteo-geocoding-springfield-us") });
    const found = await searchPlaces("Springfield");
    expect(found.places.map((place) => place.region)).toEqual(["Missouri", "Massachusetts", "Illinois", "Ohio", "Tennessee"]);
    // Same name five times: the label is what tells them apart.
    expect(found.places.map(placeLabel)).toEqual([
      "Springfield, Missouri, United States",
      "Springfield, Massachusetts, United States",
      "Springfield, Illinois, United States",
      "Springfield, Ohio, United States",
      "Springfield, Tennessee, United States",
    ]);
  });

  it("understands one qualifier after a comma, keeps towns ahead of parks, and leaves airports to the airport table", async () => {
    serve({ body: fixture("open-meteo-geocoding-qualifier-springfield-il") });
    const found = await searchPlaces("Springfield, IL");
    expect(calls[0].searchParams.get("name")).toBe("springfield, il");
    // The fixture holds the city, a park and an airport.
    expect(found.places.map((place) => [place.kind, place.name])).toEqual([
      ["city", "Springfield"],
      ["venue", "Springfield Park"],
    ]);
  });

  it("finds a city by postal code", async () => {
    serve({ body: fixture("open-meteo-geocoding-postal-60601") });
    const found = await searchPlaces("60601");
    expect(found.places).toHaveLength(1);
    expect(found.places[0]).toMatchObject({ name: "Chicago", region: "Illinois", countryCode: "US", tz: "America/Chicago" });
  });

  it("answers no places, and says the service was fine, when nothing matches", async () => {
    // HTTP 200 with no `results` key at all.
    serve({ body: fixture("open-meteo-geocoding-empty") });
    const found = await searchPlaces("zzzzqqqxj");
    expect(found).toEqual({ ok: true, places: [], stale: false });
  });

  it("remembers an answer, the empty one included, and does not ask again", async () => {
    serve({ body: fixture("open-meteo-geocoding-empty") });
    await searchPlaces("Qqqxjzz");
    await searchPlaces("qqqxjzz ");
    await searchPlaces("QQQXJZZ");
    expect(calls).toHaveLength(1);
    expect((await peekCached("places:v1:qqqxjzz"))?.ok).toBe(true);
  });

  it("does not ask the service about fewer than two characters", async () => {
    serve(new Error("must not be called"));
    expect(await searchPlaces("")).toEqual({ ok: true, places: [], stale: false });
    expect(await searchPlaces(" a ")).toEqual({ ok: true, places: [], stale: false });
    expect(calls).toHaveLength(0);
  });

  it("says the service failed, which is not the same as no such place", async () => {
    serve(new Error("getaddrinfo ENOTFOUND geocoding-api.open-meteo.com"));
    const down = await searchPlaces("Reykjavik");
    expect(down.ok).toBe(false);
    expect(down.places).toEqual([]);
    if (!down.ok) expect(down.reason).toContain("ENOTFOUND");
  });

  it("treats an error status, an HTML page and an unexpected shape as failures, and never throws", async () => {
    serve({ status: 503, body: "<html>Service unavailable</html>", contentType: "text/html" });
    expect((await searchPlaces("Oslo")).ok).toBe(false);

    serve({ status: 200, body: "<html>captive portal</html>", contentType: "text/html" });
    expect((await searchPlaces("Bergen")).ok).toBe(false);

    serve({ status: 400, body: JSON.stringify({ error: true, reason: "Parameter count must be between 1 and 100." }) });
    expect((await searchPlaces("Tromso")).ok).toBe(false);

    serve({ status: 200, body: JSON.stringify({ results: "nope" }) });
    expect((await searchPlaces("Narvik")).ok).toBe(false);

    serve({ status: 200, body: "not json at all" });
    expect((await searchPlaces("Alta")).ok).toBe(false);
  });

  it("keeps answering with what it learned earlier when the service goes down", async () => {
    const day = 24 * 60 * 60_000;
    serve({ body: fixture("open-meteo-geocoding-lisbon") });
    expect((await searchPlaces("lisbon, pt")).ok).toBe(true);

    // Make the stored answer look two days old, then take the service away.
    const { schema } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    await t.db
      .update(schema.signalCache)
      .set({ fetchedAt: new Date(Date.now() - 2 * day), expiresAt: new Date(Date.now() - day) })
      .where(eq(schema.signalCache.key, "places:v1:lisbon, pt"));
    serve({ status: 503, body: "down", contentType: "text/plain" });

    const later = await searchPlaces("Lisbon, PT");
    expect(later.ok).toBe(true);
    expect(later.places[0]?.name).toBe("Lisbon");
    if (later.ok) expect(later.stale).toBe(true);
  });

  it("skips results it cannot use instead of failing the whole search", async () => {
    serve({
      body: JSON.stringify({
        results: [
          { id: 1, name: "No Zone", latitude: 1, longitude: 1, feature_code: "PPL", country_code: "US" },
          { id: 2, name: "Bad Zone", latitude: 1, longitude: 1, feature_code: "PPL", timezone: "EST" },
          { id: 3, name: "Off The Map", latitude: 123, longitude: 1, feature_code: "PPL", timezone: "UTC" },
          { name: "No Id", latitude: 1, longitude: 1, timezone: "UTC" },
          { id: 5, name: "Good Town", latitude: 10.5, longitude: 20.25, feature_code: "PPL", timezone: "Africa/Lagos", country_code: "ng", population: 12 },
        ],
      }),
    });
    const found = await searchPlaces("good town");
    // A lower-case country code is not a code: the place is kept without one.
    expect(found.places).toEqual([{ kind: "city", name: "Good Town", lat: 10.5, lon: 20.25, tz: "Africa/Lagos" }]);
  });

  it("puts the airport first when what was typed is its code", async () => {
    serve({ body: fixture("open-meteo-geocoding-empty") });
    const found = await searchPlaces("mco");
    expect(found.places[0]).toMatchObject({ kind: "airport", iata: "MCO", name: "Orlando International Airport", tz: "America/New_York" });
    expect(placeLabel(found.places[0])).toBe("Orlando International Airport (MCO), Orlando, United States");

    // The airport table is ours: the code still works when the place service does not.
    serve(new Error("offline"));
    const offline = await searchPlaces("MSP");
    expect(offline.ok).toBe(true);
    expect(offline.places.map((place) => place.iata)).toEqual(["MSP"]);
    if (offline.ok) expect(offline.stale).toBe(true);
  });
});

describe("normalizePlaceQuery", () => {
  it("makes one cache key of the ways people type the same thing", () => {
    expect(normalizePlaceQuery("  Springfield ,IL ")).toBe("springfield, il");
    expect(normalizePlaceQuery("SPRINGFIELD,   il")).toBe("springfield, il");
    expect(normalizePlaceQuery("São  Paulo")).toBe("são paulo");
  });
});

describe("labels", () => {
  it("writes a place so that it can be told from its namesakes", () => {
    const orlando = { kind: "city" as const, name: "Orlando", region: "Florida", countryCode: "US", tz: "America/New_York" };
    expect(placeLabel(orlando)).toBe("Orlando, Florida, United States");
    expect(placeDetail(orlando)).toBe("Florida, United States");
    expect(placeShortLabel(orlando)).toBe("Orlando, Florida");

    const lisbon = { kind: "city" as const, name: "Lisbon", region: "Lisbon District", countryCode: "PT", tz: "Europe/Lisbon" };
    expect(placeShortLabel(lisbon)).toBe("Lisbon, Portugal");

    // A city-state, a place with nothing but a name, and one used as typed.
    expect(placeLabel({ kind: "city", name: "Singapore", region: "Singapore", countryCode: "SG", tz: "Asia/Singapore" })).toBe("Singapore");
    expect(placeLabel({ kind: "venue", name: "Grandma's lake house", tz: "America/Chicago" })).toBe("Grandma's lake house");
    expect(placeShortLabel({ kind: "home", name: "Chicago", tz: "America/Chicago" })).toBe("Chicago");
  });
});
