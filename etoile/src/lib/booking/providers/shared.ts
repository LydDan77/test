// What every provider link builder shares. A builder is a small pure function:
//
//   (query, env) => { url, grade, unfilled }
//
// It follows research/booking-links.md exactly, and it THROWS CannotPrefill when the query lacks
// something the link format needs. handoffLinks() catches that (and any other error) and opens
// the provider's home page instead, with every detail listed to copy.

import type { LinkGrade, PlaceRef, UnfilledField } from "@/lib/domain";
import { isLocalDate, parseLocalDate } from "@/lib/time";
import type { PartnerIds } from "../types";
import { addressText, placeSearchText } from "../wording";

export type BuiltLink = {
  url: string;
  grade: LinkGrade;
  /** What this link could not carry, each with the value to copy. */
  unfilled: UnfilledField[];
};

export type LinkEnv = {
  partnerIds?: PartnerIds;
  /** ISO currency for prices, from the plan. Default USD. */
  currency?: string;
};

/** Thrown by a builder when the query is missing something its link format requires. */
export class CannotPrefill extends Error {
  constructor(what: string) {
    super(`Cannot prefill: ${what} is missing`);
    this.name = "CannotPrefill";
  }
}

/** The value, or a CannotPrefill naming what is missing. */
export function need<T>(value: T | null | undefined | "", what: string): T {
  if (value === null || value === undefined || value === "") throw new CannotPrefill(what);
  return value as T;
}

/** A local date that the link can carry as it is. Throws CannotPrefill when missing or not a real date. */
export function needDate(value: string | null | undefined, what: string): string {
  const date = need(value, what);
  if (!isLocalDate(date)) throw new CannotPrefill(what);
  return date;
}

/** A local time of day (`HH:mm`), or undefined. Anything else counts as missing. */
export function timeOrNone(value: string | null | undefined): string | undefined {
  return value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined;
}

/**
 * `a=1&b=two%20words`: values encoded with encodeURIComponent (a space is %20, a comma %2C),
 * which is how most of the observed links are written. Pairs with an empty value are dropped
 * unless `keepEmpty` is set for them.
 */
export function encodedQuery(pairs: Array<[key: string, value: string | number | null | undefined, keepEmpty?: boolean]>): string {
  return pairs
    .filter(([, value, keepEmpty]) => keepEmpty || (value !== null && value !== undefined && value !== ""))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ""))}`)
    .join("&");
}

/** One line for the "you'll need to enter" list. Empty values are left out by `compact`. */
export function unfilledField(label: string, value: string | number | null | undefined): UnfilledField | null {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (!text) return null;
  return { label: label.slice(0, 80), value: text.slice(0, 500) };
}

export function compact(fields: Array<UnfilledField | null>): UnfilledField[] {
  return fields.filter((field): field is UnfilledField => field !== null);
}

/** "12/18/2026" (zero-padded) from "2026-12-18". */
export function usDatePadded(date: string): string {
  const { year, month, day } = parseLocalDate(date);
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}

/** "1/5/2027" (no padding) from "2027-01-05". */
export function usDatePlain(date: string): string {
  const { year, month, day } = parseLocalDate(date);
  return `${month}/${day}/${year}`;
}

/** "261218" from "2026-12-18". */
export function yymmdd(date: string): string {
  const { year, month, day } = parseLocalDate(date);
  return `${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/** A coordinate as a link wants it: up to six decimals, no trailing zeros. */
export function coordinate(value: number): string {
  return String(Number(value.toFixed(6)));
}

export function hasCoordinates(place: PlaceRef | undefined): place is PlaceRef & { lat: number; lon: number } {
  return place !== undefined && place.lat !== undefined && place.lon !== undefined;
}

/** A place as a provider's destination box wants it: "Lisbon, Portugal", "Orlando, FL". */
export function destinationText(place: PlaceRef): string {
  return placeSearchText(place);
}

/**
 * A place as a maps search wants it: the street address when there is one, an airport by name,
 * coordinates when that is all there is, otherwise the name and region.
 */
export function mapsQueryText(place: PlaceRef | string): string {
  if (typeof place === "string") return place.trim();
  if ((place.addressLines?.length ?? 0) > 0) return addressText(place);
  if (place.kind === "airport" && place.iata) {
    return place.name && place.name !== place.iata ? place.name : `${place.iata} airport`;
  }
  if (place.lat !== undefined && place.lon !== undefined && !place.locality && !place.region) {
    return `${coordinate(place.lat)},${coordinate(place.lon)}`;
  }
  return placeSearchText(place);
}

/** Adults spread over rooms as evenly as they go: 7 adults in 3 rooms is [3, 2, 2]. */
export function adultsPerRoom(adults: number, rooms: number): number[] {
  const count = Math.max(1, Math.min(rooms, Math.max(1, adults)));
  const base = Math.floor(adults / count);
  const extra = adults % count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

/** "9 and 5", "12, 9 and 5". */
export function agesText(ages: readonly number[]): string {
  const words = ages.map(String);
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
