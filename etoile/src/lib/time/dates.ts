// Local calendar dates: plain `YYYY-MM-DD` strings with no time and no zone, the way the
// database stores a check-in date or a ship-by date. Pure.
//
// All arithmetic here is on the calendar (via UTC midnight, which has no daylight saving), so
// adding a day never lands on the wrong date. To get "today" somewhere, you must say where and
// when: localDateOf(now, tz).

import { EN_DASH } from "./symbols";
import { utcToZoned, type InstantInput } from "./zoned";

/** `YYYY-MM-DD`. */
export type LocalDate = string;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtcMs(date: LocalDate): number {
  const m = DATE_PATTERN.exec(date);
  if (!m) throw new RangeError(`Not a local date (YYYY-MM-DD): ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    throw new RangeError(`Not a real calendar date: ${date}`);
  }
  return ms;
}

function fromUtcMs(ms: number): LocalDate {
  const d = new Date(ms);
  const year = String(d.getUTCFullYear()).padStart(4, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True for a `YYYY-MM-DD` string naming a real day (2026-02-30 is not one). */
export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== "string") return false;
  try {
    toUtcMs(value);
    return true;
  } catch {
    return false;
  }
}

/** `{ year, month (1-12), day }` for a local date. Throws RangeError on an invalid one. */
export function parseLocalDate(date: LocalDate): { year: number; month: number; day: number } {
  const d = new Date(toUtcMs(date));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** `YYYY-MM-DD` from numbers. Throws RangeError when they do not name a real day. */
export function toLocalDate(year: number, month: number, day: number): LocalDate {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  toUtcMs(text);
  return text;
}

/** The calendar date shown in `tz` at `instant`. "Today" is localDateOf(now, tz). */
export function localDateOf(instant: InstantInput, tz: string): LocalDate {
  return utcToZoned(instant, tz).date;
}

/** `date` moved by `days` calendar days (negative moves back). */
export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new RangeError(`days must be a whole number: ${days}`);
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Calendar days from `from` to `to`: positive when `to` is later. Dec 19 to Dec 26 is 7. */
export function diffDays(from: LocalDate, to: LocalDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** -1, 0 or 1: for sorting dates, or `compareDates(a, b) < 0` for "a is before b". */
export function compareDates(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  const diff = toUtcMs(a) - toUtcMs(b);
  return diff < 0 ? -1 : diff > 0 ? 1 : 0;
}

/** Nights between check-in and check-out, or the number of days a range covers minus one. */
export function nightsBetween(checkIn: LocalDate, checkOut: LocalDate): number {
  return Math.max(0, diffDays(checkIn, checkOut));
}

/** Calendar days from today in `tz` until `date`: 23 for "23 days away", 0 today, negative after. */
export function daysUntil(date: LocalDate, tz: string, now: InstantInput): number {
  return diffDays(localDateOf(now, tz), date);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: LocalDate): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function isWeekend(date: LocalDate): boolean {
  const day = weekday(date);
  return day === 0 || day === 6;
}

/** Says whether a date is a holiday, for business-day counting. A Set of dates also works. */
export type HolidayCheck = ((date: LocalDate) => boolean) | ReadonlySet<LocalDate>;

function isHoliday(date: LocalDate, holidays: HolidayCheck | undefined): boolean {
  if (!holidays) return false;
  return typeof holidays === "function" ? holidays(date) : holidays.has(date);
}

/** Monday to Friday and not a holiday. */
export function isBusinessDay(date: LocalDate, holidays?: HolidayCheck): boolean {
  return !isWeekend(date) && !isHoliday(date, holidays);
}

/**
 * `date` moved by `count` business days, skipping weekends and any holidays given.
 * Counting starts the day after `date` (or the day before, for a negative count):
 *   addBusinessDays("2026-12-18", 1)  -> "2026-12-21"  (Friday -> Monday)
 *   addBusinessDays("2026-12-21", -5) -> "2026-12-14"
 * A count of 0 returns `date` unchanged, even on a weekend; use nextBusinessDay() to roll one.
 */
export function addBusinessDays(date: LocalDate, count: number, holidays?: HolidayCheck): LocalDate {
  if (!Number.isInteger(count)) throw new RangeError(`count must be a whole number: ${count}`);
  const step = count < 0 ? -1 : 1;
  let remaining = Math.abs(count);
  let ms = toUtcMs(date);
  let guard = 0;
  while (remaining > 0) {
    ms += step * DAY_MS;
    if (isBusinessDay(fromUtcMs(ms), holidays)) remaining--;
    if (++guard > 100_000) throw new RangeError("addBusinessDays: no business days found");
  }
  return fromUtcMs(ms);
}

/**
 * Business days after `from`, up to and including `to`. Friday to the next Monday is 1.
 * Negative when `to` is earlier. Matches addBusinessDays: when `to` is a business day,
 * addBusinessDays(from, businessDaysBetween(from, to)) gives `to`.
 */
export function businessDaysBetween(from: LocalDate, to: LocalDate, holidays?: HolidayCheck): number {
  const start = toUtcMs(from);
  const end = toUtcMs(to);
  if (start === end) return 0;
  const step = end > start ? 1 : -1;
  let count = 0;
  for (let ms = start + step * DAY_MS; step > 0 ? ms <= end : ms >= end; ms += step * DAY_MS) {
    if (isBusinessDay(fromUtcMs(ms), holidays)) count += step;
  }
  return count;
}

/** `date` itself when it is a business day, otherwise the first business day after it. */
export function nextBusinessDay(date: LocalDate, holidays?: HolidayCheck): LocalDate {
  return isBusinessDay(date, holidays) ? date : addBusinessDays(date, 1, holidays);
}

/** `date` itself when it is a business day, otherwise the last business day before it. */
export function previousBusinessDay(date: LocalDate, holidays?: HolidayCheck): LocalDate {
  return isBusinessDay(date, holidays) ? date : addBusinessDays(date, -1, holidays);
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type DateFormatOptions = {
  /** Put the weekday first: "Sat, Dec 19". Default false. */
  weekday?: boolean | "long";
  /** "short" gives "Dec", "long" gives "December". Default "short". */
  month?: "short" | "long";
  /** Add the year: "Dec 19, 2026". Default false. */
  year?: boolean;
};

/**
 * A local date for people: "Dec 19", "Sat, Dec 19", "Saturday, December 19, 2026".
 * English (US) order, written by hand so the server and every browser print the same text.
 */
export function formatDate(date: LocalDate, options: DateFormatOptions = {}): string {
  const { year, month, day } = parseLocalDate(date);
  const months = options.month === "long" ? MONTHS_LONG : MONTHS_SHORT;
  let text = `${months[month - 1]} ${day}`;
  if (options.year) text += `, ${year}`;
  if (options.weekday) {
    const names = options.weekday === "long" ? WEEKDAYS_LONG : WEEKDAYS_SHORT;
    text = `${names[weekday(date)]}, ${text}`;
  }
  return text;
}

export type DateRangeFormatOptions = {
  /** Weekday on both ends: "Sat, Dec 19 – Sat, Dec 26". Default false. */
  weekday?: boolean;
  /** Default "short". */
  month?: "short" | "long";
  /**
   * "auto" (default): the year appears only when the range crosses into another year.
   * "always": "Dec 19–26, 2026". "never": no year even across New Year.
   */
  year?: "auto" | "always" | "never";
};

/**
 * A date range for people, with an en dash (U+2013), never a hyphen:
 *   same month            "Dec 19–26"
 *   across months         "Nov 28 – Dec 2"
 *   across years          "Dec 30, 2026 – Jan 2, 2027"
 *   one day (or no end)   "Dec 19"
 * The dash is tight between two bare numbers and spaced when either side has words in it,
 * which is how careful typesetting does it. If `end` is before `start` they are swapped.
 */
export function formatDateRange(
  start: LocalDate,
  end?: LocalDate | null,
  options: DateRangeFormatOptions = {},
): string {
  const yearMode = options.year ?? "auto";
  const month = options.month ?? "short";
  const withWeekday = options.weekday ?? false;

  let a = start;
  let b = end ?? start;
  if (compareDates(a, b) > 0) [a, b] = [b, a];

  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  const crossesYear = pa.year !== pb.year;

  if (a === b) {
    return formatDate(a, { weekday: withWeekday, month, year: yearMode === "always" });
  }

  if (crossesYear && yearMode !== "never") {
    const side = (d: LocalDate) => formatDate(d, { weekday: withWeekday, month, year: true });
    return `${side(a)} ${EN_DASH} ${side(b)}`;
  }

  const sameMonth = pa.month === pb.month && !crossesYear;
  const yearSuffix = yearMode === "always" ? `, ${pb.year}` : "";

  if (sameMonth && !withWeekday) {
    // "Dec 19–26": the month once, a tight dash between the two day numbers.
    return `${formatDate(a, { month })}${EN_DASH}${pb.day}${yearSuffix}`;
  }
  const side = (d: LocalDate) => formatDate(d, { weekday: withWeekday, month });
  return `${side(a)} ${EN_DASH} ${side(b)}${yearSuffix}`;
}
