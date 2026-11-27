// "Add to calendar" links for Google Calendar and Outlook on the web (research/booking-links.md
// section 8). Neither company documents these; the formats are community-documented and
// long-lived. Apple Calendar has no link: it opens the .ics file (see icsForItems).
//
// Timed entries are written in UTC (…Z), which is the only form that is right for a flight that
// crosses time zones. All-day entries use plain dates with the end on the day AFTER the last day.

import { addDays, compareDates, isLocalDate, localDateOf, utcToZoned, type InstantInput } from "@/lib/time";
import { icsDate, icsUtcStamp } from "./ics";
import { locationText, notesText } from "./text";
import type { CalendarItem, CalendarLink } from "./types";

const GOOGLE_BASE = "https://calendar.google.com/calendar/render";
const OUTLOOK_PERSONAL_BASE = "https://outlook.live.com/calendar/deeplink/compose";
const OUTLOOK_WORK_BASE = "https://outlook.office.com/calendar/deeplink/compose";

/** A timed entry with no end is given this length in a link, because both links need an end. */
const DEFAULT_LENGTH_MINUTES = 60;
/** Outlook stops reading long links; keep every link under this many characters. */
const MAX_URL_LENGTH = 1900;

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad4 = (n: number) => String(n).padStart(4, "0");

/** "2026-12-18T23:00:00Z", the form Outlook reads as UTC. */
function outlookUtc(instant: InstantInput): string {
  const utc = utcToZoned(instant, "UTC");
  return `${pad4(utc.year)}-${pad2(utc.month)}-${pad2(utc.day)}T${pad2(utc.hour)}:${pad2(utc.minute)}:${pad2(utc.second)}Z`;
}

type LinkWhen =
  | { kind: "timed"; startMs: number; endMs: number }
  | { kind: "all_day"; first: string; endExclusive: string };

function linkWhen(item: CalendarItem): LinkWhen | null {
  if (item.start && !item.allDay) {
    const startMs = Date.parse(item.start.at);
    if (!Number.isFinite(startMs)) return null;
    const given = item.end ? Date.parse(item.end.at) : Number.NaN;
    const endMs = Number.isFinite(given) && given > startMs ? given : startMs + DEFAULT_LENGTH_MINUTES * 60_000;
    return { kind: "timed", startMs, endMs };
  }
  const first = item.localDate ?? (item.start ? localDateOf(item.start.at, item.start.tz) : null);
  if (!first || !isLocalDate(first)) return null;
  const last = item.endDate && isLocalDate(item.endDate) && compareDates(item.endDate, first) > 0 ? item.endDate : first;
  return { kind: "all_day", first, endExclusive: addDays(last, 1) };
}

/** `key=value` pairs joined with &, values percent-encoded (a space is %20, as both sites emit). */
function query(pairs: Array<[string, string | null | undefined, { raw?: boolean }?]>): string {
  return pairs
    .filter((pair): pair is [string, string, { raw?: boolean }?] => typeof pair[1] === "string" && pair[1] !== "")
    .map(([key, value, options]) => `${key}=${options?.raw ? value : encodeURIComponent(value)}`)
    .join("&");
}

function googleUrl(item: CalendarItem, when: LinkWhen, notes: string): string {
  const dates =
    when.kind === "timed"
      ? `${icsUtcStamp(when.startMs)}/${icsUtcStamp(when.endMs)}`
      : `${icsDate(when.first)}/${icsDate(when.endExclusive)}`;
  return `${GOOGLE_BASE}?${query([
    ["action", "TEMPLATE"],
    ["text", item.title],
    // The slash between the two halves is part of the format, so this value is not encoded.
    ["dates", dates, { raw: true }],
    ["details", notes],
    ["location", locationText(item)],
  ])}`;
}

function outlookUrl(base: string, item: CalendarItem, when: LinkWhen, notes: string): string {
  const [start, end] =
    when.kind === "timed" ? [outlookUtc(when.startMs), outlookUtc(when.endMs)] : [when.first, when.endExclusive];
  return `${base}?${query([
    ["path", "/calendar/action/compose", { raw: true }],
    ["rru", "addevent"],
    ["subject", item.title],
    // Colons and dashes in a date-time are left as they are, the way Outlook's own links have them.
    ["startdt", start, { raw: true }],
    ["enddt", end, { raw: true }],
    ["allday", when.kind === "all_day" ? "true" : null],
    ["location", locationText(item)],
    ["body", notes],
  ])}`;
}

/** Shortens the notes until the link fits. Notes are the only part that can be long. */
function fitted(build: (notes: string) => string, notes: string): string {
  let text = notes;
  let url = build(text);
  while (url.length > MAX_URL_LENGTH && text.length > 0) {
    const over = url.length - MAX_URL_LENGTH;
    // Encoded text is up to three times as long as the text, so cutting a third of the overshoot
    // each round always ends, and never cuts more than it needs to by much.
    text = text.slice(0, Math.max(0, text.length - Math.max(1, Math.ceil(over / 3)) - 1)).trimEnd();
    url = build(text ? `${text}…` : "");
  }
  return url;
}

/**
 * The "add to calendar" buttons for one item: Google Calendar, Outlook.com (personal accounts)
 * and Outlook for work or school accounts, in that order. Empty when the item has no date.
 *
 * Render each as a real link: `<a href={link.url} target="_blank" rel="noopener noreferrer">`.
 * For Apple Calendar, offer the .ics file from `icsForItems` instead.
 *
 * `localTimeNote` (default true) starts the notes with the time where the item happens, since
 * the link itself carries UTC.
 */
export function calendarLinks(item: CalendarItem, opts: { localTimeNote?: boolean } = {}): CalendarLink[] {
  const when = linkWhen(item);
  if (!when) return [];
  const notes = notesText(item, opts.localTimeNote ?? true);
  const link = (provider: CalendarLink["provider"], name: string, url: string): CalendarLink => ({
    provider,
    name,
    actionLabel: `Add to ${name}`,
    url,
    grade: "observed",
    tested: false,
  });
  return [
    link("google", "Google Calendar", fitted((text) => googleUrl(item, when, text), notes)),
    link("outlook_personal", "Outlook.com", fitted((text) => outlookUrl(OUTLOOK_PERSONAL_BASE, item, when, text), notes)),
    link(
      "outlook_work",
      "Outlook (work or school)",
      fitted((text) => outlookUrl(OUTLOOK_WORK_BASE, item, when, text), notes),
    ),
  ];
}
