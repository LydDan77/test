// Finding dates and times in confirmation text. Everything found is LOCAL: a date as the email
// printed it, a time as the clock on the spot will show it. Nothing here knows a time zone.

import { addDays, diffDays, isLocalDate, toLocalDate } from "@/lib/time";

export type DateHit = {
  /** `YYYY-MM-DD`, or null when the text gave no year and none could be worked out. */
  date: string | null;
  month: number;
  day: number;
  /** True when the year came from outside the text (the caller's reference date). */
  yearAssumed: boolean;
  /** True for 03/04/2026-style dates where day and month could be read either way. */
  ambiguous: boolean;
  index: number;
  end: number;
  raw: string;
};

export type TimeHit = {
  /** `HH:mm`, 24-hour. */
  time: string;
  index: number;
  end: number;
  raw: string;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORD = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

const monthNumber = (word: string) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;

type Raw = { year: number | null; month: number; day: number; ambiguous: boolean; index: number; end: number; raw: string };

function collect(text: string): Raw[] {
  const found: Raw[] = [];
  const add = (match: RegExpExecArray, year: number | null, month: number, day: number, ambiguous = false) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    found.push({ year, month, day, ambiguous, index: match.index, end: match.index + match[0].length, raw: match[0] });
  };
  let m: RegExpExecArray | null;

  // 2026-12-19
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) add(m, Number(m[1]), Number(m[2]), Number(m[3]));

  // Dec 19, 2026 · December 19 · Sat, Dec 19th
  const monthFirst = new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "gi");
  while ((m = monthFirst.exec(text))) add(m, m[3] ? Number(m[3]) : null, monthNumber(m[1]), Number(m[2]));

  // 19 Dec 2026 · 19 December
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_WORD}\\b\\.?(?:,?\\s+(20\\d{2}))?`, "gi");
  while ((m = dayFirst.exec(text))) add(m, m[3] ? Number(m[3]) : null, monthNumber(m[2]), Number(m[1]));

  // 19DEC26 · 19DEC (airline style, capitals only)
  const compact = /\b(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(20\d{2}|\d{2})?\b/g;
  while ((m = compact.exec(text))) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    add(m, year, monthNumber(m[2]), Number(m[1]));
  }

  // 12/19/2026 · 12/19/26 (US order unless the first number cannot be a month)
  const slashed = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2}|\d{2})\b/g;
  while ((m = slashed.exec(text))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (a > 12) add(m, year, b, a);
    else add(m, year, a, b, b <= 12 && a !== b);
  }

  // 19.12.2026 (day first)
  const dotted = /\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/g;
  while ((m = dotted.exec(text))) add(m, Number(m[3]), Number(m[2]), Number(m[1]));

  // Longest match wins where two patterns overlap ("19 Dec 2026" also contains "Dec 20").
  found.sort((x, y) => x.index - y.index || y.end - y.index - (x.end - x.index));
  const kept: Raw[] = [];
  for (const hit of found) {
    const clash = kept.findIndex((other) => hit.index < other.end && other.index < hit.end);
    if (clash === -1) kept.push(hit);
    else if (hit.end - hit.index > kept[clash].end - kept[clash].index) kept[clash] = hit;
  }
  return kept.sort((x, y) => x.index - y.index);
}

function safeDate(year: number, month: number, day: number): string | null {
  try {
    return toLocalDate(year, month, day);
  } catch {
    return null;
  }
}

/** The occurrence of month/day that is nearest to `reference` without being more than 60 days before it. */
function nearestYear(month: number, day: number, reference: string): string | null {
  const year = Number(reference.slice(0, 4));
  const candidates = [year - 1, year, year + 1]
    .map((y) => safeDate(y, month, day))
    .filter((d): d is string => d !== null && diffDays(reference, d) >= -60);
  candidates.sort((a, b) => Math.abs(diffDays(reference, a)) - Math.abs(diffDays(reference, b)));
  return candidates[0] ?? null;
}

/**
 * Every date in the text, in reading order.
 *
 * A date printed without a year ("Sat, Dec 19") takes its year from, in order: `sentDate` (the
 * day the email was sent), the first date in the text that does have a year, then
 * `referenceDate` from the caller (which marks the hit `yearAssumed`). With none of those the
 * hit's `date` is null: the reader will leave the field empty rather than guess.
 */
export function findDates(text: string, opts: { sentDate?: string; referenceDate?: string } = {}): DateHit[] {
  const raw = collect(text);
  const firstFull = raw.map((hit) => (hit.year ? safeDate(hit.year, hit.month, hit.day) : null)).find((date): date is string => date !== null);
  const anchor = opts.sentDate ?? firstFull;
  return raw.map((hit) => {
    let date: string | null = null;
    let yearAssumed = false;
    if (hit.year) date = safeDate(hit.year, hit.month, hit.day);
    else if (anchor) date = nearestYear(hit.month, hit.day, anchor);
    else if (opts.referenceDate && isLocalDate(opts.referenceDate)) {
      date = nearestYear(hit.month, hit.day, opts.referenceDate);
      yearAssumed = date !== null;
    }
    return { date, month: hit.month, day: hit.day, yearAssumed, ambiguous: hit.ambiguous, index: hit.index, end: hit.end, raw: hit.raw };
  });
}

const DURATION_LEAD = /(duration|travel time|flight time|layover|connection time|total time|elapsed)\s*:?\s*$/i;

/** Every clock time in the text, in reading order, as 24-hour `HH:mm`. Durations ("Duration: 5:30") are skipped. */
export function findTimes(text: string): TimeHit[] {
  const found: TimeHit[] = [];
  const push = (match: RegExpExecArray, hour: number, minute: number) => {
    if (hour > 23 || minute > 59) return;
    if (DURATION_LEAD.test(text.slice(Math.max(0, match.index - 30), match.index))) return;
    found.push({ time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, index: match.index, end: match.index + match[0].length, raw: match[0] });
  };
  let m: RegExpExecArray | null;

  // 4:10 PM · 4:10pm · 4 PM · 4:10 p.m. · 4:10p
  const twelve = /(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s?([AaPp])(?:\.?\s?[Mm]\.?)?(?![A-Za-z])/g;
  while ((m = twelve.exec(text))) {
    const hour12 = Number(m[1]);
    if (hour12 < 1 || hour12 > 12) continue;
    // A bare "4p" or "4 a" is too easy to mistake; without minutes the "m" must be there.
    if (m[2] === undefined && !/[Mm]\.?$/.test(m[0])) continue;
    const pm = m[3].toLowerCase() === "p";
    push(m, (hour12 % 12) + (pm ? 12 : 0), m[2] ? Number(m[2]) : 0);
  }
  const noon = /\b(noon|midday)\b/gi;
  while ((m = noon.exec(text))) push(m, 12, 0);

  // 16:10 · 08:45 (24-hour), when it is not part of a 12-hour time already found
  const twentyFour = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
  while ((m = twentyFour.exec(text))) {
    const start = m.index;
    if (found.some((hit) => start >= hit.index && start < hit.end)) continue;
    push(m, Number(m[1]), Number(m[2]));
  }
  return found.sort((a, b) => a.index - b.index);
}

/** `date` moved on by the "+1" or "next day" an arrival time sometimes carries. */
export function withDayOffset(date: string, text: string): string {
  const plus = /\+\s?([12])(?:\s?days?)?(?![\d:])/.exec(text);
  if (plus) return addDays(date, Number(plus[1]));
  if (/\b(next day|following day)\b/i.test(text)) return addDays(date, 1);
  return date;
}
