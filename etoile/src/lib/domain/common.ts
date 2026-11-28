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

/**
 * The web address to store for what a person typed, or null when it is not one we keep.
 * Only http and https, so a stored link can never be a `javascript:` URL. No user name or
 * password in it ("https://bank.example@evil.example" reads as one site and opens another), and
 * no white space or control character inside it: the URL parser quietly drops those, so the
 * text that was checked would not be the text that was stored.
 */
function cleanHttpUrl(value: string): string | null {
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // Store what the parser read. The one exception is the "/" it adds after a bare host:
  // "https://example.com" stays as typed.
  return url.href === `${value}/` ? value : url.href;
}

/**
 * A web address, trimmed and stored the way a browser reads it (lower-case host, default port
 * dropped). Only http and https; no user:password@; no spaces or line breaks inside.
 */
export const httpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => cleanHttpUrl(value) !== null, { message: "Use a web address that starts with https://" })
  .overwrite((value) => cleanHttpUrl(value) ?? value);

// Control characters never belong in text a person typed, and Postgres refuses U+0000 outright
// (a query error, with every value of the statement in it). The text helpers below clean them
// out instead of refusing the whole form over a character nobody can see.
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

/** One line: line breaks and tabs become a space, other control characters are removed. */
export function singleLine(text: string): string {
  return text.replace(LINE_BREAKS, " ").replace(OTHER_CONTROLS, "");
}

/** Several lines: line breaks become "\n", tabs stay, other control characters are removed. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, "\n")
    .replace(OTHER_CONTROLS, "");
}

/**
 * One line of text a person typed. Trimmed; empty is not allowed. Line breaks and tabs become
 * spaces and control characters are removed (see singleLine).
 */
export const shortText = (max = 200) => z.string().overwrite(singleLine).trim().min(1).max(max);
/**
 * Longer free text. Trimmed; empty is not allowed (leave the field out instead; see
 * withoutEmptyText). Line breaks are kept; control characters are removed (see cleanText).
 */
export const longText = (max = 4000) => z.string().overwrite(cleanText).trim().min(1).max(max);

/**
 * A copy of `input` without the fields a form left empty: "" (and text that is only spaces),
 * null and undefined are dropped, at every depth. Arrays keep their length.
 *
 * The optional text fields of the domain schemas (shortText(…).optional(), longText(…).optional())
 * accept a missing field but refuse "", and "" is exactly what formText() gives for an input
 * left empty. So pass what a form sent through this before a domain schema reads it:
 *
 *   const parsed = parseBookingDetails("lodging", withoutEmptyText({ propertyName, contactName, accessNotes }));
 */
export function withoutEmptyText<T>(input: T): T {
  if (Array.isArray(input)) return input.map((entry) => withoutEmptyText(entry)) as T;
  if (input === null || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = withoutEmptyText(value);
  }
  return out as T;
}
