// Words shared by the calendar file and the calendar links: where an item is, and the line that
// says what the clocks show there.

import type { PlaceRef, ZonedInstant } from "@/lib/domain";
import { EN_DASH, formatClock, formatDate } from "@/lib/time";
import type { CalendarItem } from "./types";

/**
 * A place as one line for a calendar's "where" box: "Lakeside House, 1 Lake Shore Dr, Orlando,
 * FL 32801". Uses the name and the street address only. The phone number and the notes on a
 * place are private and never appear.
 */
export function placeLine(place: PlaceRef): string {
  const cityLine = [place.locality, [place.region, place.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const parts = [place.name, ...(place.addressLines ?? []), cityLine].map((part) => part?.trim()).filter(Boolean);
  // A name that already is the first address line ("1 Lake Shore Dr") is not said twice.
  return parts.filter((part, index) => parts.indexOf(part) === index).join(", ");
}

/** The words for an item's "where" box, or an empty string. */
export function locationText(item: CalendarItem): string {
  if (item.location?.trim()) return item.location.trim();
  return item.place ? placeLine(item.place) : "";
}

function dayAndTime(at: ZonedInstant): { day: string; time: string; zone: string } {
  const clock = formatClock(at.at, at.tz);
  return { day: formatDate(clock.date, { weekday: true }), time: clock.h12.text, zone: clock.zone };
}

/**
 * The time where the item happens, for a reader in another zone:
 *   "Sat, Dec 19, 8:10 AM PST"
 *   "Sat, Dec 19, 8:10 AM PST – 4:10 PM EST"              (same day, another zone)
 *   "Sat, Dec 19, 6:30 PM – 7:30 PM EST"                  (same day and zone)
 *   "Fri, Dec 18, 11:30 PM PST – Sat, Dec 19, 7:45 AM EST" (lands the next day)
 * Null for an all-day item.
 */
export function localTimeLine(item: CalendarItem): string | null {
  if (!item.start || item.allDay) return null;
  const start = dayAndTime(item.start);
  if (!item.end) return `${start.day}, ${start.time} ${start.zone}`;
  const end = dayAndTime(item.end);
  if (start.day === end.day && start.zone === end.zone) {
    return `${start.day}, ${start.time} ${EN_DASH} ${end.time} ${end.zone}`;
  }
  if (start.day === end.day) {
    return `${start.day}, ${start.time} ${start.zone} ${EN_DASH} ${end.time} ${end.zone}`;
  }
  return `${start.day}, ${start.time} ${start.zone} ${EN_DASH} ${end.day}, ${end.time} ${end.zone}`;
}

/** The notes for an item: the local-time line (when asked for), then the description. */
export function notesText(item: CalendarItem, withLocalTime: boolean): string {
  const lines: string[] = [];
  const local = withLocalTime ? localTimeLine(item) : null;
  if (local) lines.push(`Local time: ${local}`);
  if (item.description?.trim()) lines.push(item.description.trim());
  return lines.join("\n");
}

/**
 * A local time of day for people: "16:00" becomes "4:00 PM". Formatted by the time library so it
 * reads exactly like every other time in the app. Returns the input unchanged when it is not HH:mm.
 */
export function clockText(time: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return time;
  return formatClock(`2000-01-01T${time}:00Z`, "UTC").h12.text;
}
