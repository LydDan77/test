// How a place is written for people. Pure, with no server-only imports: safe in a Client
// Component (import from "@/lib/places/labels", not from "@/lib/places").

import type { PlaceRef } from "@/lib/domain";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** "United States" for "US". The code itself when Intl does not know it; "" for nothing. */
export function countryName(countryCode: string | null | undefined): string {
  if (!countryCode) return "";
  try {
    return regionNames.of(countryCode.toUpperCase()) ?? countryCode;
  } catch {
    return countryCode;
  }
}

/**
 * The words after the name that tell two places apart: "Florida, United States",
 * "Lisbon District, Portugal". For an airport: its city and country. May be "".
 */
export function placeDetail(place: PlaceRef): string {
  const parts: string[] = [];
  if (place.kind === "airport" && place.locality && place.locality !== place.name) parts.push(place.locality);
  if (place.region && place.region !== place.name) parts.push(place.region);
  const country = countryName(place.countryCode);
  if (country && country !== place.name) parts.push(country);
  return parts.join(", ");
}

/**
 * One line for a picker row or a confirmation: "Orlando, Florida, United States",
 * "Orlando International Airport (MCO), Orlando, United States". Always show this in a list
 * of search results: there are 30 Springfields.
 */
export function placeLabel(place: PlaceRef): string {
  const name = place.iata && place.kind === "airport" ? `${place.name} (${place.iata})` : place.name;
  const detail = placeDetail(place);
  return detail ? `${name}, ${detail}` : name;
}

/**
 * The short form used in sentences and on plan rows: "Orlando, Florida" inside the United
 * States, "Lisbon, Portugal" elsewhere, just the name when nothing else is known.
 */
export function placeShortLabel(place: PlaceRef): string {
  if (place.countryCode === "US" && place.region && place.region !== place.name) return `${place.name}, ${place.region}`;
  const country = countryName(place.countryCode);
  if (place.countryCode && place.countryCode !== "US" && country && country !== place.name) return `${place.name}, ${country}`;
  return place.name;
}
