// Small shared pieces of the domain schemas: dates, times, zones, ids, short text.

import { z } from "zod";
import { isLocalDate } from "../time/dates";
import { isIanaTimeZone } from "../time/zoned";

/** A local calendar date of a place: `YYYY-MM-DD`, and a real day. */
export const localDateSchema = z
  .string()
  .refine(isLocalDate, { message: "Use a real date in the form YYYY-MM-DD" });
export type LocalDate = z.infer<typeof localDateSchema>;

/** A local time of day: `HH:mm`, 24-hour. */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "Use a time in the form HH:mm" });
export type LocalTime = z.infer<typeof localTimeSchema>;

/**
 * An IANA zone id in region/city form, such as "America/Chicago" (or "UTC"). Abbreviations such
 * as "EST" are refused: see isIanaTimeZone.
 */
export const timeZoneSchema = z
  .string()
  .refine(isIanaTimeZone, { message: "Unknown time zone" });

/** A UTC instant as an ISO 8601 string ending in Z: "2026-12-19T22:41:00Z". */
export const instantSchema = z.iso.datetime({ message: "Use a UTC time such as 2026-12-19T22:41:00Z" });

/** The id of another row (people, bookings, arrivals …). Shape only; ownership is checked in queries. */
export const idSchema = z.string().min(1).max(64);

/** ISO 4217 currency code, upper case. */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, { message: "Use a 3-letter currency code" });

/** ISO 3166-1 alpha-2 country code, upper case. */
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, { message: "Use a 2-letter country code" });

/** IATA airport code. */
export const airportCodeSchema = z.string().regex(/^[A-Z0-9]{3}$/, { message: "Use a 3-letter airport code" });

/** A web address. Only http and https, so a stored link can never be a `javascript:` URL. */
export const httpUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "Use a web address that starts with https://" },
  );

/** One line of text a person typed. Trimmed; empty is not allowed. */
export const shortText = (max = 200) => z.string().trim().min(1).max(max);
/** Longer free text. Trimmed; empty is not allowed (leave the field out instead). */
export const longText = (max = 4000) => z.string().trim().min(1).max(max);
