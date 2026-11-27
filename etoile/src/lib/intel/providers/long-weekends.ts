// Long weekends, worked out from a list of public holidays. Pure.
//
// The holiday source's own long-weekend endpoint belongs to an API version that ends on
// 2027-01-31 and has no successor, so the app computes them: about forty lines, checked in the
// tests against that endpoint's real answers for the United States in 2026 and 2027.

import { addDays, compareDates, diffDays, isWeekend, weekday, type LocalDate } from "@/lib/time";
import type { LongWeekend, PublicHoliday } from "../signals";

/**
 * The day people actually get off. In the United States a holiday on a Saturday is observed on
 * the Friday before and one on a Sunday on the Monday after; the holiday source reports the
 * calendar date, so the shift is applied here. Other countries have their own rules (or none),
 * so for them the date is returned unchanged rather than guessed.
 */
export function observedDate(date: LocalDate, countryCode: string): LocalDate {
  if (countryCode.toUpperCase() !== "US") return date;
  const day = weekday(date);
  if (day === 6) return addDays(date, -1);
  if (day === 0) return addDays(date, 1);
  return date;
}

/**
 * Runs of three or more days off around the given holidays, oldest first.
 *
 * A holiday next to a weekend makes a three-day weekend. A holiday one working day away from a
 * weekend (a Thursday or a Tuesday) makes a four-day one if that day is taken off: it is listed
 * in `bridgeDays`. At most one bridge day is ever suggested. Pass only the holidays that give
 * people the day off (getPublicHolidays() already does).
 */
export function computeLongWeekends(holidays: readonly Pick<PublicHoliday, "observedOn" | "name">[]): LongWeekend[] {
  const namesByDay = new Map<LocalDate, string[]>();
  for (const holiday of holidays) {
    const names = namesByDay.get(holiday.observedOn) ?? [];
    if (!names.includes(holiday.name)) names.push(holiday.name);
    namesByDay.set(holiday.observedOn, names);
  }
  const isOff = (date: LocalDate) => isWeekend(date) || namesByDay.has(date);
  const runStart = (date: LocalDate) => {
    let start = date;
    while (isOff(addDays(start, -1))) start = addDays(start, -1);
    return start;
  };
  const runEnd = (date: LocalDate) => {
    let end = date;
    while (isOff(addDays(end, 1))) end = addDays(end, 1);
    return end;
  };

  const found = new Map<string, LongWeekend>();
  const record = (startDate: LocalDate, endDate: LocalDate, bridgeDays: LocalDate[]) => {
    const inside = [...namesByDay.entries()]
      .filter(([day]) => compareDates(day, startDate) >= 0 && compareDates(day, endDate) <= 0)
      .sort(([a], [b]) => compareDates(a, b))
      .flatMap(([, names]) => names);
    found.set(`${startDate}/${endDate}`, {
      startDate,
      endDate,
      days: diffDays(startDate, endDate) + 1,
      bridgeDays,
      holidays: [...new Set(inside)],
    });
  };

  for (const day of [...namesByDay.keys()].sort(compareDates)) {
    const start = runStart(day);
    const end = runEnd(day);
    if (diffDays(start, end) + 1 >= 3) {
      record(start, end, []);
      continue;
    }
    // Not long on its own. Would one day off join it to the days off next to it?
    const after = addDays(end, 1);
    const before = addDays(start, -1);
    const forward = isOff(addDays(after, 1)) ? { start, end: runEnd(addDays(after, 1)), bridge: after } : null;
    const backward = isOff(addDays(before, -1)) ? { start: runStart(addDays(before, -1)), end, bridge: before } : null;
    const length = (run: { start: LocalDate; end: LocalDate } | null) => (run ? diffDays(run.start, run.end) + 1 : 0);
    const best = length(backward) > length(forward) ? backward : forward;
    if (best && length(best) >= 4) record(best.start, best.end, [best.bridge]);
  }

  return [...found.values()].sort((a, b) => compareDates(a.startDate, b.startDate) || compareDates(a.endDate, b.endDate));
}
