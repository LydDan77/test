// The holiday periods that pull booking deadlines forward (product spec 10.4, "when the dates
// touch a holiday period"). The eleven US periods of research/holiday-traffic-rules.json, kept
// here as plain date windows: each is an anchor day and how many days either side are busy.
//
// This is deliberately the small version. The full day-by-day road and airport rules belong to
// the heads-up engine; this file only answers "do these dates touch a holiday, and which one".
// actByFor accepts another answer through its `holidayPeriod` option, so the two can be made to
// agree exactly once that engine exists.

import { addDays, compareDates, diffDays, parseLocalDate, toLocalDate, weekday } from "@/lib/time";

export type HolidayPeriod = {
  id: string;
  /** For a sentence: "Your dates include Thanksgiving". */
  name: string;
  /** For a short tag: "holiday week" or "holiday weekend". */
  tag: "holiday week" | "holiday weekend";
  /** First and last busy day, inclusive. */
  start: string;
  end: string;
  /** The holiday itself. */
  anchor: string;
};

function nthWeekday(year: number, month: number, day: number, nth: number): string {
  const first = toLocalDate(year, month, 1);
  return addDays(first, ((day - weekday(first) + 7) % 7) + 7 * (nth - 1));
}

function lastWeekday(year: number, month: number, day: number): string {
  const last = addDays(month === 12 ? toLocalDate(year + 1, 1, 1) : toLocalDate(year, month + 1, 1), -1);
  return addDays(last, -((weekday(last) - day + 7) % 7));
}

/** Western Easter Sunday (the anonymous Gregorian algorithm). */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return toLocalDate(year, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
}

type Window = readonly [before: number, after: number];
const MONDAY = 1;
const THURSDAY = 4;

// Busy days around a fixed-date holiday depend on the weekday it falls on (index 0 = Sunday).
// Taken from the day tables of the rules file, kept to the run of days next to the holiday.
const CHRISTMAS_END: readonly number[] = [8, 8, 8, 11, 11, 10, 9];
const JULY_4: readonly Window[] = [[-3, 2], [-4, 1], [-4, 1], [-5, 4], [-5, 4], [-6, 3], [-7, 2]];
const JUNETEENTH: readonly Window[] = [[-2, 1], [-3, 0], [-4, 0], [0, 0], [-1, 3], [-1, 2], [-2, 1]];
const VETERANS: readonly Window[] = [[0, 0], [-3, 0], [0, 0], [0, 0], [0, 0], [-1, 2], [0, 0]];

function period(id: string, name: string, tag: HolidayPeriod["tag"], anchor: string, [before, after]: Window): HolidayPeriod {
  return { id, name, tag, anchor, start: addDays(anchor, before), end: addDays(anchor, after) };
}

/** The holiday periods anchored in one calendar year, in calendar order. */
export function holidayPeriodsForYear(year: number): HolidayPeriod[] {
  const christmas = toLocalDate(year, 12, 25);
  const july4 = toLocalDate(year, 7, 4);
  const juneteenth = toLocalDate(year, 6, 19);
  const veterans = toLocalDate(year, 11, 11);
  return [
    period("mlk-day", "the Martin Luther King Jr. Day weekend", "holiday weekend", nthWeekday(year, 1, MONDAY, 3), [-4, 0]),
    period("presidents-day", "the Presidents' Day weekend", "holiday weekend", nthWeekday(year, 2, MONDAY, 3), [-4, 0]),
    period("easter", "Easter", "holiday weekend", easterSunday(year), [-3, 1]),
    period("memorial-day", "the Memorial Day weekend", "holiday weekend", lastWeekday(year, 5, MONDAY), [-4, 1]),
    period("juneteenth", "Juneteenth", "holiday weekend", juneteenth, JUNETEENTH[weekday(juneteenth)]),
    period("independence-day", "the Fourth of July", "holiday week", july4, JULY_4[weekday(july4)]),
    period("labor-day", "the Labor Day weekend", "holiday weekend", nthWeekday(year, 9, MONDAY, 1), [-4, 1]),
    period("columbus-day", "the Columbus Day weekend", "holiday weekend", nthWeekday(year, 10, MONDAY, 2), [-4, 0]),
    period("veterans-day", "Veterans Day", "holiday weekend", veterans, VETERANS[weekday(veterans)]),
    period("thanksgiving", "Thanksgiving", "holiday week", nthWeekday(year, 11, THURSDAY, 4), [-3, 5]),
    period("christmas-new-year", "Christmas", "holiday week", christmas, [-8, CHRISTMAS_END[weekday(christmas)]]),
  ];
}

/** Christmas and Easter are busy almost everywhere. The rest are US holidays. */
const WORLDWIDE = new Set(["christmas-new-year", "easter"]);

/**
 * The holiday period that the dates `start` to `end` (inclusive local dates) touch, or null.
 * When several do, the one the trip shares the most days with wins (a trip from Dec 1 to 28 is
 * a Christmas trip, though its first day is the tail of Thanksgiving week); on a tie, the one
 * whose holiday is nearest to `start`.
 *
 * `unitedStates` (default true) says whether the trip starts or ends in the US. When false,
 * only Christmas and Easter count.
 */
export function holidayPeriodTouching(start: string, end: string | null | undefined, opts: { unitedStates?: boolean } = {}): HolidayPeriod | null {
  const last = end && compareDates(end, start) >= 0 ? end : start;
  const us = opts.unitedStates ?? true;
  const { year } = parseLocalDate(start);
  const endYear = parseLocalDate(last).year;
  const candidates: HolidayPeriod[] = [];
  // A Christmas period runs into the next January, so look a year back as well.
  for (let y = year - 1; y <= endYear; y++) {
    for (const p of holidayPeriodsForYear(y)) {
      if (!us && !WORLDWIDE.has(p.id)) continue;
      if (compareDates(p.start, last) <= 0 && compareDates(p.end, start) >= 0) candidates.push(p);
    }
  }
  if (candidates.length === 0) return null;
  const shared = (p: HolidayPeriod) => diffDays(compareDates(p.start, start) > 0 ? p.start : start, compareDates(p.end, last) < 0 ? p.end : last) + 1;
  const distance = (p: HolidayPeriod) => Math.abs(diffDays(start, p.anchor));
  return candidates.sort((a, b) => shared(b) - shared(a) || distance(a) - distance(b))[0];
}
