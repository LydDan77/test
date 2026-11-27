// PlaceRef: a place embedded wherever one is needed. There is no places table.

import { z } from "zod";
import { zoneCityName } from "../time/zoned";
import { airportCodeSchema, countryCodeSchema, httpUrlSchema, longText, shortText, timeZoneSchema } from "./common";
import { PLACE_KINDS } from "./enums";

export const placeRefSchema = z
  .object({
    kind: z.enum(PLACE_KINDS),
    name: shortText(200),
    addressLines: z.array(shortText(200)).max(4).optional(),
    locality: shortText(120).optional(),
    region: shortText(120).optional(),
    postalCode: shortText(20).optional(),
    /** ISO 3166-1 alpha-2. Drives which signals apply. */
    countryCode: countryCodeSchema.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    /** IANA zone. Always present: the app never asks a person to choose a time zone. */
    tz: timeZoneSchema,
    iata: airportCodeSchema.optional(),
    phone: shortText(40).optional(),
    url: httpUrlSchema.optional(),
    notes: longText(2000).optional(),
  })
  .refine((place) => (place.lat === undefined) === (place.lon === undefined), {
    message: "Latitude and longitude go together",
    path: ["lat"],
  });

export type PlaceRef = z.infer<typeof placeRefSchema>;

/**
 * The home place for a new account, from the browser's time zone alone: "America/Chicago"
 * becomes a place named "Chicago". First run confirms it; until then the zone is what matters.
 */
export function homePlaceFromTimeZone(tz: string): PlaceRef {
  return { kind: "home", name: zoneCityName(tz), tz };
}

/** True when a place can be put on a map or given sunrise and sunset. */
export function hasCoordinates(place: PlaceRef): place is PlaceRef & { lat: number; lon: number } {
  return place.lat !== undefined && place.lon !== undefined;
}
