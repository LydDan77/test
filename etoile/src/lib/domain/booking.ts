// The six booking kinds as one discriminated union, plus the shared JSON shapes on a booking.
//
// bookings.details holds one of these objects. It carries its own `kind`, and the database
// checks that it equals bookings.kind, so `switch (booking.details.kind)` is always safe.

import { z } from "zod";
import { flightDetailsSchema, type FlightDetails } from "./booking-flight";
import { lodgingDetailsSchema, type LodgingDetails } from "./booking-lodging";
import { carDetailsSchema, type CarDetails } from "./booking-car";
import { rideDetailsSchema, type RideDetails } from "./booking-ride";
import { mealDetailsSchema, type MealDetails } from "./booking-meal";
import { shipmentDetailsSchema, type ShipmentDetails } from "./booking-shipment";
import { localDateSchema, shortText } from "./common";
import { BOOKING_KINDS, type BookingKind } from "./enums";

export const bookingDetailsSchema = z.discriminatedUnion("kind", [
  flightDetailsSchema,
  lodgingDetailsSchema,
  carDetailsSchema,
  rideDetailsSchema,
  mealDetailsSchema,
  shipmentDetailsSchema,
]);

/** The stored shape of bookings.details: a union discriminated by `kind`. */
export type BookingDetails =
  | FlightDetails
  | LodgingDetails
  | CarDetails
  | RideDetails
  | MealDetails
  | ShipmentDetails;

/** The details type for one kind: BookingDetailsOf<"flight"> is FlightDetails. */
export type BookingDetailsOf<K extends BookingKind> = Extract<BookingDetails, { kind: K }>;

/** The Zod schema for each kind, for code that already knows the kind. */
export const bookingDetailsSchemas = {
  flight: flightDetailsSchema,
  lodging: lodgingDetailsSchema,
  car: carDetailsSchema,
  ride: rideDetailsSchema,
  meal: mealDetailsSchema,
  shipment: shipmentDetailsSchema,
} as const satisfies Record<BookingKind, z.ZodType>;

export type ParsedBookingDetails<K extends BookingKind> =
  | { ok: true; details: BookingDetailsOf<K> }
  | {
      ok: false;
      /** The first problem, with the path of the field. Developer wording: for logs, not for people. */
      error: string;
      issues: z.core.$ZodIssue[];
    };

/**
 * Validates `details` against the booking's kind and fills in the defaults.
 *
 *   const parsed = parseBookingDetails(booking.kind, withoutEmptyText(input));
 *   if (!parsed.ok) {
 *     console.error("[stay] details refused:", parsed.error);          // developer wording: for the log
 *     return fail("Check the dates and try again.", { values });       // your own sentence for the person
 *   }
 *   await db.update(bookings).set({ details: parsed.details })…
 *
 * `parsed.error` reads like "segments.0.arrivesAt: A flight lands after it takes off" or
 * "propertyName: Too small: expected string to have >=1 characters". It names fields by their
 * path and is NOT wording for people: log it, and say something of your own. For messages beside
 * single fields, `invalid({ issues: parsed.issues }, values)` (src/lib/action.ts) files each
 * issue under its top-level field name.
 *
 * A form sends "" for a field left empty, and the optional text fields here refuse "": pass
 * form input through withoutEmptyText() first, as above.
 *
 * `details.kind` may be left out (it is filled in from `kind`); when present it must match.
 * Never throws: bad input comes back as `{ ok: false }` with the first problem in `error`.
 */
export function parseBookingDetails<K extends BookingKind>(kind: K, details: unknown): ParsedBookingDetails<K> {
  if (!BOOKING_KINDS.includes(kind)) {
    return { ok: false, error: `Unknown booking kind: ${String(kind)}`, issues: [] };
  }
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return { ok: false, error: "Booking details must be an object", issues: [] };
  }
  const stated = (details as { kind?: unknown }).kind;
  if (stated !== undefined && stated !== kind) {
    return { ok: false, error: `These are ${String(stated)} details, but the booking is a ${kind}`, issues: [] };
  }
  const result = bookingDetailsSchemas[kind].safeParse({ ...details, kind });
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${first?.message ?? "Invalid booking details"}`, issues: result.error.issues };
  }
  return { ok: true, details: result.data as BookingDetailsOf<K> };
}

/** The details a brand-new booking of each kind starts with: nothing but the defaults. */
export function emptyBookingDetails<K extends BookingKind>(kind: K): BookingDetailsOf<K> {
  return bookingDetailsSchemas[kind].parse({ kind }) as BookingDetailsOf<K>;
}

/** bookings.actBy: the dates of product spec 10.4. All local dates at the plan's place. */
export const actBySchema = z.object({
  /** When it is wise to have this done. */
  recommended: localDateSchema.optional(),
  /** After this it is too late. */
  hard: localDateSchema.optional(),
  /** The first day the provider lets you book. */
  opensOn: localDateSchema.optional(),
})
  .refine((actBy) => !actBy.recommended || !actBy.hard || actBy.hard >= actBy.recommended, {
    message: "The last possible day cannot be before the recommended one",
    path: ["hard"],
  });
export type ActBy = z.infer<typeof actBySchema>;

/** One thing a hand-off link could not prefill, shown with a copy button (handoffs.unfilled). */
export const unfilledFieldSchema = z.object({ label: shortText(80), value: shortText(500) });
export type UnfilledField = z.infer<typeof unfilledFieldSchema>;
export const unfilledListSchema = z.array(unfilledFieldSchema).max(30);

/** plans.kindsInUse and plans.kindsNotNeeded. */
export const bookingKindListSchema = z
  .array(z.enum(BOOKING_KINDS))
  .max(BOOKING_KINDS.length)
  .refine((kinds) => new Set(kinds).size === kinds.length, { message: "Each kind once" });
