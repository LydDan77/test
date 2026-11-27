import "server-only";

import { z } from "zod";
import { cached } from "@/lib/cache";
import { placeRefSchema, type PlaceRef } from "@/lib/domain";
import { isIanaTimeZone } from "@/lib/time";
import { airportByIata, airportPlace } from "./airports";

// Place search through Open-Meteo's free geocoding service (GeoNames data, CC BY; city level,
// no street addresses; research/live-data.md section 2). Every answer goes through the shared
// cache for a day, so a typeahead never asks the service the same thing twice, and a service
// that is down still answers with what it said last time.

const ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const CACHE_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 8_000;
const RESULT_COUNT = 10;

export const PLACE_QUERY_MIN = 2;
export const PLACE_QUERY_MAX = 80;

/** Credit to show beside results (the data licence asks for it). */
export const placesSource = "Location data based on GeoNames, via Open-Meteo";

export type PlaceSearchResult =
  | {
      ok: true;
      /** Best match first. Empty means the service knows no such place. */
      places: PlaceRef[];
      /** True when the service could not be reached and these are an earlier answer. */
      stale: boolean;
    }
  | {
      /** The service failed and there is no earlier answer. Not the same as "no such place". */
      ok: false;
      places: [];
      /** For logs. Not wording for people. */
      reason: string;
    };

// One result as the service sends it. Only `id`, `name`, the coordinates and the zone are always
// there: "empty fields are not returned".
const resultSchema = z.object({
  id: z.number(),
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().optional(),
  feature_code: z.string().optional(),
  country_code: z.string().optional(),
  country: z.string().optional(),
  admin1: z.string().optional(),
  population: z.number().optional(),
});

// No match is HTTP 200 with no `results` key at all, not an empty list.
const responseSchema = z.object({ results: z.array(z.unknown()).optional() });

type StoredPlace = { place: PlaceRef; population: number; populated: boolean };

/** Lower-case, single spaces, no space before a comma: the form used as the cache key. */
export function normalizePlaceQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").toLowerCase();
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function toPlace(raw: unknown): StoredPlace | null {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  // A place without a zone is no use here: the app never asks a person for one.
  if (!isIanaTimeZone(r.timezone)) return null;
  const code = r.feature_code ?? "";
  // Airports come from our own table, which has their codes.
  if (code === "AIRP") return null;
  const populated = code.startsWith("PPL");
  const place = placeRefSchema.safeParse({
    kind: populated ? "city" : "venue",
    name: r.name,
    ...(r.admin1 && r.admin1 !== r.name ? { region: r.admin1 } : {}),
    ...(r.country_code && /^[A-Z]{2}$/.test(r.country_code) ? { countryCode: r.country_code } : {}),
    lat: r.latitude,
    lon: r.longitude,
    tz: r.timezone,
  });
  if (!place.success) return null;
  return { place: place.data, population: r.population ?? 0, populated };
}

async function fetchPlaces(query: string): Promise<StoredPlace[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("name", query);
  url.searchParams.set("count", String(RESULT_COUNT));
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  // Nothing about the person or the plan goes along: only the words typed into the search box.
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Place search answered ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    throw new Error("Place search did not answer with JSON");
  }
  const body = responseSchema.safeParse(await response.json());
  if (!body.success) throw new Error("Place search answered in an unexpected shape");

  const wanted = fold(query.split(",")[0].trim());
  const places = (body.data.results ?? []).map(toPlace).filter((p): p is StoredPlace => p !== null);
  // The service does not order by size. Cities and towns before parks and lakes; a name that is
  // exactly what was typed before a longer one; then the bigger place. The sort is stable, so
  // ties keep the service's order.
  const exact = (p: StoredPlace) => (fold(p.place.name) === wanted ? 1 : 0);
  places.sort(
    (a, b) => Number(b.populated) - Number(a.populated) || exact(b) - exact(a) || b.population - a.population,
  );
  return places;
}

/**
 * Places matching what a person typed: a city or town ("lisbon"), a name with one qualifier
 * after a comma ("Springfield, IL", "Paris, France"), or a postal code. An airport code
 * ("MCO") gives that airport first. Each result is a PlaceRef with name, region, country code,
 * coordinates and time zone, ready to store; show it with placeLabel() so that two
 * Springfields can be told apart.
 *
 * Never throws. `{ ok: true, places: [] }` means there is no such place; `{ ok: false }` means
 * the service could not be asked, which is a different sentence on the screen.
 */
export async function searchPlaces(query: string): Promise<PlaceSearchResult> {
  const normalized = normalizePlaceQuery(query).slice(0, PLACE_QUERY_MAX);
  if (normalized.length < PLACE_QUERY_MIN) return { ok: true, places: [], stale: false };

  // "Airport codes work": three letters that are a code put that airport first.
  const airport = /^[a-z]{3}$/.test(normalized) ? airportByIata(normalized) : undefined;
  const leading = airport ? [airportPlace(airport)] : [];

  const result = await cached<StoredPlace[]>(`places:v1:${normalized}`, CACHE_MS, () => fetchPlaces(normalized));
  if (!result.ok) {
    // Our own table still knows the airport, whatever happened to the service.
    if (leading.length > 0) return { ok: true, places: leading, stale: true };
    return { ok: false, places: [], reason: result.reason };
  }
  return { ok: true, places: [...leading, ...result.data.map((entry) => entry.place)], stale: result.stale };
}
