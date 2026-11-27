// Small helpers for the sentences the plan logic writes for people: lists of names, counts,
// clock times and lengths of time. Pure. Shared by itinerary/, people/, money/ and readiness/.
//
// House style (BUILD-SPEC section 3): plain words, sentence case, no exclamation marks, real
// numbers and real times.

import { formatClock, formatDate, type ClockOptions, type InstantInput, type LocalDate } from "@/lib/time";

/**
 * How times are written inside sentences. Pass the signed-in user's `timeStyle` and
 * `militaryStyle`; left out, times read "4:10 PM".
 *
 * Every result also carries the instants themselves, so a screen can always render a time with
 * its own component instead of using the sentence.
 */
export type Wording = Pick<ClockOptions, "style" | "militaryStyle">;

/** "4:10 PM" (or "1610" / "16:10" for a person who chose 24-hour time), in the zone given. */
export function clockText(at: InstantInput, tz: string, wording: Wording = {}): string {
  return formatClock(at, tz, wording).primary;
}

/** "Sat, Dec 19". */
export function dayText(date: LocalDate): string {
  return formatDate(date, { weekday: true });
}

/** "Saturday". */
export function weekdayName(date: LocalDate): string {
  return formatDate(date, { weekday: "long" }).split(",")[0];
}

/** "Ruth", "Ruth and Dale", "Ruth, Dale and Ann". An empty list gives "". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "1 box", "2 boxes". Give the plural when it is not the singular plus "s". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The first word of a name: "Ruth Hartley" gives "Ruth". */
export function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first || name.trim();
}

/**
 * First names for a group, falling back to full names when two of them share a first name
 * (two Chrises read as "Chris Hartley and Chris Okafor").
 */
export function firstNames(people: readonly { name: string }[]): string[] {
  const firsts = people.map((person) => firstNameOf(person.name));
  const clash = new Set(firsts).size !== firsts.length;
  return clash ? people.map((person) => person.name.trim()) : firsts;
}

/** "45 minutes", "1 hour", "5 hours 20 minutes", "2 days", "1 day 3 hours". Rounded to the minute. */
export function durationWords(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < 60) return count(minutes, "minute");
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${count(hours, "hour")} ${count(rest, "minute")}` : count(hours, "hour");
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.round((minutes % 1440) / 60);
  if (hours === 24) return count(days + 1, "day");
  return hours ? `${count(days, "day")} ${count(hours, "hour")}` : count(days, "day");
}

/** Adds a full stop unless the text already ends a sentence. "Hold the mail" gives "Hold the mail." */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.?!…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Lower-cases the first letter, for putting a title in the middle of a sentence. */
export function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/** Upper-cases the first letter. */
export function upperFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
