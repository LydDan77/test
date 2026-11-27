// A correct .ics file (RFC 5545) for any list of plan items. Pure: `now` is an argument.
//
// What "correct" means here, each covered by a test:
//  - timed entries are written as UTC instants (…Z), so no VTIMEZONE block is needed and every
//    calendar app shows them at the right moment; the notes say what the clocks show on the spot;
//  - all-day entries use VALUE=DATE with an EXCLUSIVE end (the day after the last day);
//  - UIDs are stable, `{id}@etoile`, so a second download updates instead of duplicating;
//  - lines end in CRLF and are folded at 75 octets counted in UTF-8 bytes, never inside a character;
//  - text is escaped (backslash, semicolon, comma, newline);
//  - nothing private can appear, because CalendarItem has no field for it.
//
// Serve the result as `text/calendar; charset=utf-8` with a `.ics` file name.

import { BRAND } from "@/lib/brand";
import { addDays, compareDates, isLocalDate, localDateOf, utcToZoned, type InstantInput } from "@/lib/time";
import { locationText, notesText } from "./text";
import type { CalendarItem, IcsOptions } from "./types";

const CRLF = "\r\n";
const MAX_LINE_OCTETS = 75;

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad4 = (n: number) => String(n).padStart(4, "0");

/** "20261218T230000Z" for an instant. Built from UTC clock fields, not from toISOString(). */
export function icsUtcStamp(instant: InstantInput): string {
  const utc = utcToZoned(instant, "UTC");
  return `${pad4(utc.year)}${pad2(utc.month)}${pad2(utc.day)}T${pad2(utc.hour)}${pad2(utc.minute)}${pad2(utc.second)}Z`;
}

/** "20261218" for the local date "2026-12-18". The string is used as stored: no Date involved. */
export function icsDate(date: string): string {
  if (!isLocalDate(date)) throw new RangeError(`Not a local date (YYYY-MM-DD): ${date}`);
  return date.replace(/-/g, "");
}

/** Escapes a TEXT value: `\` `;` `,` and newlines. Other control characters are dropped. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Folds one content line so that no physical line is longer than 75 octets of UTF-8. A fold is
 * CRLF followed by one space; the space counts toward the next line's 75. Never splits a
 * character (an accented letter or an emoji stays whole).
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const character of line) {
    const size = utf8Length(character.codePointAt(0) ?? 0);
    if (octets + size > MAX_LINE_OCTETS) {
      out.push(current);
      current = " ";
      octets = 1;
    }
    current += character;
    octets += size;
  }
  out.push(current);
  return out.join(CRLF);
}

/** The UID for an item id: `{id}@etoile`. Characters a UID should not carry become "-". */
export function icsUid(id: string): string {
  const safe = id.trim().replace(/[^A-Za-z0-9._:-]/g, "-");
  if (!safe) throw new RangeError("A calendar item needs an id");
  return `${safe}@${BRAND.ascii}`;
}

type When =
  | { kind: "timed"; start: string; end: string | null }
  | { kind: "all_day"; start: string; endExclusive: string };

/** The dates of an item as they go in the file, or null when it has none. */
export function icsWhen(item: CalendarItem): When | null {
  if (item.start && !item.allDay) {
    const startMs = Date.parse(item.start.at);
    if (!Number.isFinite(startMs)) return null;
    const endMs = item.end ? Date.parse(item.end.at) : Number.NaN;
    // An end at or before the start is a mistake upstream; a point in time is the honest reading.
    const end = Number.isFinite(endMs) && endMs > startMs ? icsUtcStamp(endMs) : null;
    return { kind: "timed", start: icsUtcStamp(startMs), end };
  }
  const first = item.localDate ?? (item.start ? localDateOf(item.start.at, item.start.tz) : null);
  if (!first || !isLocalDate(first)) return null;
  const last = item.endDate && isLocalDate(item.endDate) && compareDates(item.endDate, first) > 0 ? item.endDate : first;
  return { kind: "all_day", start: icsDate(first), endExclusive: icsDate(addDays(last, 1)) };
}

function eventLines(item: CalendarItem, stamp: string, withLocalTime: boolean): string[] | null {
  const when = icsWhen(item);
  if (!when) return null;
  const lines = ["BEGIN:VEVENT", `UID:${icsUid(item.id)}`, `DTSTAMP:${stamp}`];
  if (when.kind === "timed") {
    lines.push(`DTSTART:${when.start}`);
    if (when.end) lines.push(`DTEND:${when.end}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${when.start}`, `DTEND;VALUE=DATE:${when.endExclusive}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(item.title.trim() || "Untitled")}`);
  const location = locationText(item);
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  const notes = notesText(item, withLocalTime);
  if (notes) lines.push(`DESCRIPTION:${escapeIcsText(notes)}`);
  // URL is a URI value, not TEXT: it is not escaped, only kept to one line.
  const url = item.url?.trim();
  if (url && /^https?:\/\/\S+$/.test(url)) lines.push(`URL:${url}`);
  if (item.cancelled) lines.push("STATUS:CANCELLED");
  // An all-day stay should not block the whole week as "busy".
  if (when.kind === "all_day") lines.push("TRANSP:TRANSPARENT");
  lines.push("END:VEVENT");
  return lines;
}

/**
 * A complete .ics file for the items given, ready to download (Apple Calendar, Outlook, Google
 * import). Items without a date are left out. Lines end in CRLF; the file ends with one.
 *
 *   const file = icsForItems(calendarItemsForBooking(booking), { now, calendarName: plan.title });
 *   return new Response(file, { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
 */
export function icsForItems(items: readonly CalendarItem[], opts: IcsOptions): string {
  const stamp = icsUtcStamp(opts.now);
  const withLocalTime = opts.localTimeNote ?? true;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${BRAND.ascii}//Plans//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (opts.calendarName?.trim()) lines.push(`X-WR-CALNAME:${escapeIcsText(opts.calendarName.trim())}`);
  const seen = new Set<string>();
  for (const item of items) {
    // Two entries with one UID would overwrite each other in the reader's calendar.
    if (seen.has(item.id)) continue;
    const event = eventLines(item, stamp, withLocalTime);
    if (!event) continue;
    seen.add(item.id);
    lines.push(...event);
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
