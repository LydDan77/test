// ZonedInstant: a UTC instant together with the IANA zone it should be shown in.

import { z } from "zod";
import { instantSchema, timeZoneSchema } from "./common";

export const zonedInstantSchema = z.object({
  /** ISO 8601 UTC instant: "2026-12-19T22:41:00Z". */
  at: instantSchema,
  /** IANA zone of the place where it happens. */
  tz: timeZoneSchema,
});
export type ZonedInstant = z.infer<typeof zonedInstantSchema>;

/** Builds a ZonedInstant from a Date (as read from a timestamptz column) and its zone. */
export function zonedInstant(at: Date, tz: string): ZonedInstant {
  return { at: at.toISOString(), tz };
}

/** The instant as a Date, for arithmetic and for writing to a timestamptz column. */
export function instantOf(value: ZonedInstant): Date {
  return new Date(value.at);
}
