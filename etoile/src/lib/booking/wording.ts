// Small pieces of wording shared by proposals, links and next steps, so the same thing is
// always said the same way. Plain, warm, specific; sentence case; en dashes for ranges.

import { clockText } from "@/lib/calendar";
import type { Cabin, LodgingType, MealType, PlaceRef, ZonedInstant } from "@/lib/domain";
import { EN_DASH, formatClock, formatDate, utcToZoned } from "@/lib/time";

/** What an empty line of a proposal says. */
export const NOT_SET = "Not set yet";

/** "1 adult", "2 adults", "1 child", "3 children". */
export function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a, b and c". */
export function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Sat, Dec 19". */
export function dateText(date: string): string {
  return formatDate(date, { weekday: true });
}

/** "Sat, Dec 19, 4:40 PM" from a local date and a local time. */
export function dateTimeText(date: string, time: string): string {
  return `${dateText(date)}, ${clockText(time)}`;
}

/** "Sat, Dec 19 at 4:40 PM": the same, for the middle of a sentence. */
export function dateAtTimeText(date: string, time: string): string {
  return `${dateText(date)} at ${clockText(time)}`;
}

/** "Sat, Dec 19 – Sun, Dec 27": both ends with their weekday, an en dash between. */
export function dateSpanText(start: string, end: string): string {
  return `${dateText(start)} ${EN_DASH} ${dateText(end)}`;
}

/** "6:30 PM – 7:30 PM". */
export function timeSpanText(start: string, end: string): string {
  return `${clockText(start)} ${EN_DASH} ${clockText(end)}`;
}

/** The local date and time of an instant where it happens. */
export function localParts(at: ZonedInstant): { date: string; time: string } {
  const zoned = utcToZoned(at.at, at.tz);
  return { date: zoned.date, time: zoned.time };
}

/** "4:10 PM" for an instant, on the clocks of its own place. */
export function clockAt(at: ZonedInstant): string {
  return formatClock(at.at, at.tz).h12.text;
}

/** "Sat, Dec 19, 4:10 PM" for an instant, on the clocks of its own place. */
export function whenText(at: ZonedInstant): string {
  const { date, time } = localParts(at);
  return dateTimeText(date, time);
}

/** "Sat, Dec 19 at 4:10 PM" for an instant, for the middle of a sentence. */
export function whenAtText(at: ZonedInstant): string {
  const { date, time } = localParts(at);
  return dateAtTimeText(date, time);
}

/**
 * A place for people: "Orlando International Airport (MCO)", "MCO" when only the code is
 * known, otherwise the place's name.
 */
export function placeLabel(place: PlaceRef): string {
  if (place.iata && place.kind === "airport") {
    return place.name && place.name !== place.iata ? `${place.name} (${place.iata})` : place.iata;
  }
  return place.name;
}

/**
 * A place as a search box would want it: "Orlando, FL" for a city, "Lisbon, Portugal" abroad.
 * Uses the locality and region when the place has them, else its name.
 */
export function placeSearchText(place: PlaceRef): string {
  // A name that already says where it is ("Orlando, Florida") is used as it stands.
  if (place.name.includes(",")) return place.name;
  const city = place.kind === "city" || !place.locality ? place.name : place.locality;
  const country = place.countryCode && place.countryCode !== "US" ? countryName(place.countryCode) : undefined;
  const parts = [city, place.region, country].filter((part): part is string => Boolean(part));
  return parts.filter((part, index) => parts.indexOf(part) === index).join(", ");
}

/** A full postal address on one line, for a copy button: "1 Lake Shore Dr, Orlando, FL 32801". Falls back to the name. */
export function addressText(place: PlaceRef): string {
  const cityLine = [place.locality, [place.region, place.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const lines = [...(place.addressLines ?? []), cityLine].filter(Boolean);
  return lines.length > 0 && (place.addressLines?.length ?? 0) > 0 ? lines.join(", ") : placeLabel(place);
}

let regionNames: Intl.DisplayNames | null | undefined;

/** "Portugal" for "PT". The code itself when the runtime cannot name it. */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const CABIN_LABELS: Readonly<Record<Cabin, string>> = {
  economy: "Economy",
  premium_economy: "Premium economy",
  business: "Business",
  first: "First",
};

export const LODGING_TYPE_LABELS: Readonly<Record<LodgingType, string>> = {
  hotel: "Hotel",
  rental: "A whole home",
  family_home: "Staying with family",
  room_block: "A block of hotel rooms",
  other: "Somewhere else",
};

export const MEAL_TYPE_LABELS: Readonly<Record<MealType, string>> = {
  restaurant_delivery: "Dinner delivered",
  groceries: "Groceries delivered",
  catering: "Catering",
};

/** "2 hours 30 minutes", "45 minutes", "1 hour". */
export function durationWords(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts: string[] = [];
  if (hours) parts.push(countOf(hours, "hour", "hours"));
  if (rest || !hours) parts.push(countOf(rest, "minute", "minutes"));
  return parts.join(" ");
}
