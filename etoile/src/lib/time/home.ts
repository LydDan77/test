// How another place's clock relates to home: the "+3h" beside a clock, and "Tomorrow" or
// "Yesterday" when its calendar day differs. Pure.

import { MINUS } from "./symbols";
import { offsetMinutes, utcToZoned, type InstantInput } from "./zoned";

export type HomeOffset = {
  /** Minutes `tz` is ahead of home at that instant (negative when behind). */
  minutes: number;
  /** "+3h", "+5h 30m", "−8h", "+0h". The minus is U+2212 (see MINUS). */
  label: string;
};

/**
 * How far the clocks in `tz` are ahead of the clocks in `homeTz` at `at`, to the minute.
 * The answer depends on the date: New York is +5h from London most of the year and +4h for the
 * weeks when only one of them has changed its clocks. Always pass the instant being shown.
 */
export function offsetFromHome(tz: string, homeTz: string, at: InstantInput): HomeOffset {
  const minutes = offsetMinutes(at, tz) - offsetMinutes(at, homeTz);
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const sign = minutes < 0 ? MINUS : "+";
  return { minutes, label: `${sign}${h}h${m ? ` ${m}m` : ""}` };
}

/** Calendar days the date in `tz` is ahead of the date at home, at `at`: -2 … 2. */
export function dayDifferenceFromHome(tz: string, homeTz: string, at: InstantInput): number {
  const there = utcToZoned(at, tz);
  const home = utcToZoned(at, homeTz);
  return Math.round(
    (Date.UTC(there.year, there.month - 1, there.day) -
      Date.UTC(home.year, home.month - 1, home.day)) /
      86_400_000,
  );
}

export type DayRelation = "Tomorrow" | "Yesterday" | "2 days ahead" | "2 days behind" | null;

/**
 * The word to put beside a clock whose calendar day differs from home's: "Tomorrow" when it is
 * already the next day there, "Yesterday" when it is still the previous day, null when the day
 * is the same. (For an hour or so a day, places 25 or 26 hours apart, such as Pago Pago and
 * Kiritimati, are two days apart; those read "2 days ahead" or "2 days behind".)
 */
export function dayRelation(tz: string, homeTz: string, at: InstantInput): DayRelation {
  const days = dayDifferenceFromHome(tz, homeTz, at);
  if (days === 0) return null;
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return days > 0 ? "2 days ahead" : "2 days behind";
}
