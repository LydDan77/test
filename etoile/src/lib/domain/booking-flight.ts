// Details of a flight booking (product spec 7.9). Stored in bookings.details as JSON.
// A booking in the `needed` state has no segments yet; `search` holds what the person is
// looking for, so the hand-off link can be rebuilt at any time.

import { z } from "zod";
import { airportCodeSchema, idSchema, instantSchema, localDateSchema, shortText, timeZoneSchema } from "./common";
import type { ZonedInstant } from "./zoned-instant";

export const FLIGHT_TRIP_TYPES = ["one_way", "round_trip", "multi_city"] as const;
export type FlightTripType = (typeof FLIGHT_TRIP_TYPES)[number];

export const CABINS = ["economy", "premium_economy", "business", "first"] as const;
export type Cabin = (typeof CABINS)[number];

/** IATA airline designator: two characters, letters or digits ("AS", "B6", "9W"). */
export const airlineCodeSchema = z.string().regex(/^[A-Z0-9]{2}$/, { message: "Use a 2-character airline code" });

export const flightSegmentSchema = z
  .object({
    airlineIata: airlineCodeSchema,
    /** Display name, kept so an old booking still reads right if the code is reassigned. */
    airlineName: shortText(120).optional(),
    /** Digits with an optional letter, without the airline code: "1054". */
    flightNumber: z.string().regex(/^\d{1,4}[A-Z]?$/, { message: "Use the number only, such as 1054" }),
    originIata: airportCodeSchema,
    destinationIata: airportCodeSchema,
    /** Departure instant (UTC) and the origin airport's zone. */
    departsAt: instantSchema,
    originTz: timeZoneSchema,
    /** Arrival instant (UTC) and the destination airport's zone. */
    arrivesAt: instantSchema,
    destinationTz: timeZoneSchema,
    terminal: shortText(20).optional(),
    arrivalTerminal: shortText(20).optional(),
    /** Seat by person id: { "<personId>": "14C" }. */
    seats: z.record(idSchema, shortText(8)).optional(),
    /** Set by hand: "Delayed 40 min". */
    statusNote: shortText(200).optional(),
    /** Set by hand: the new expected arrival. Shown in the destination zone. */
    expectedArrivalAt: instantSchema.optional(),
  })
  .refine((s) => Date.parse(s.arrivesAt) > Date.parse(s.departsAt), {
    message: "A flight lands after it takes off",
    path: ["arrivesAt"],
  });
export type FlightSegment = z.infer<typeof flightSegmentSchema>;

/** What the person is searching for. Everything optional: it fills in as the flow goes. */
export const flightSearchSchema = z.object({
  originIata: airportCodeSchema.optional(),
  destinationIata: airportCodeSchema.optional(),
  departDate: localDateSchema.optional(),
  returnDate: localDateSchema.optional(),
  /** Counts by traveler type, as providers ask for them. */
  adults: z.number().int().min(0).max(20).default(1),
  children: z.number().int().min(0).max(20).default(0),
  infants: z.number().int().min(0).max(20).default(0),
  /** Ages of the children, for providers that need them. */
  childAges: z.array(z.number().int().min(0).max(17)).max(20).optional(),
  /** Extra legs of a multi-city search, in order. */
  legs: z
    .array(z.object({ originIata: airportCodeSchema, destinationIata: airportCodeSchema, date: localDateSchema }))
    .max(8)
    .optional(),
});
export type FlightSearch = z.infer<typeof flightSearchSchema>;

export const flightDetailsSchema = z.object({
  kind: z.literal("flight"),
  tripType: z.enum(FLIGHT_TRIP_TYPES).optional(),
  cabin: z.enum(CABINS).optional(),
  search: flightSearchSchema.optional(),
  /** Recorded flights, in travel order. Empty until the booking is recorded. */
  segments: z.array(flightSegmentSchema).max(12).default([]),
});
export type FlightDetails = z.infer<typeof flightDetailsSchema>;

/** A segment's two ends as ZonedInstants, the shape the timeline and the clock formatter take. */
export function flightSegmentTimes(segment: FlightSegment): { departs: ZonedInstant; arrives: ZonedInstant } {
  return {
    departs: { at: segment.departsAt, tz: segment.originTz },
    arrives: { at: segment.arrivesAt, tz: segment.destinationTz },
  };
}

/** "AS 1054": the way a flight is written everywhere in the app. */
export function flightDesignator(segment: Pick<FlightSegment, "airlineIata" | "flightNumber">): string {
  return `${segment.airlineIata} ${segment.flightNumber}`;
}
