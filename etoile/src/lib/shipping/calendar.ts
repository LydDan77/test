// Which days a carrier delivers, collects and moves parcels. Pure: a date in, a yes or no out.
//
// Ported from research/ship-ahead-code/shipby.mjs (isDeliveryDay, isShipDay, inPeak,
// federalHolidays, zoneFromMiles). The data is in ./config; the day arithmetic is @/lib/time.

import { addDays, compareDates, toLocalDate, weekday, type LocalDate } from "@/lib/time";
import {
  CALENDAR_COVERS_THROUGH,
  CALENDAR_PUBLISHED_THROUGH,
  CARRIER_CALENDAR,
  CARRIER_WEEK,
  PEAK_WINDOWS,
  SERVICES,
  ZONE_MAX_MILES,
  type CalendarDay,
  type ServiceCalendar,
  type ServiceKey,
} from "./config";

/** The days both UPS and FedEx close, for services that ride on their networks (see ServiceCalendar). */
const MAJOR_HOLIDAYS: Readonly<Record<LocalDate, CalendarDay>> = Object.fromEntries(
  Object.entries(CARRIER_CALENDAR.ups)
    .filter(([date, day]) => day.status === "closed" && CARRIER_CALENDAR.fedex[date]?.status === "closed")
    .map(([date, day]) => {
      const fedex = CARRIER_CALENDAR.fedex[date];
      const merged: CalendarDay = day.projected || fedex?.projected ? { ...day, projected: true } : day;
      return [date, merged];
    }),
);

function calendarOf(calendar: ServiceCalendar): Readonly<Record<LocalDate, CalendarDay>> {
  return calendar === "major_holidays" ? MAJOR_HOLIDAYS : CARRIER_CALENDAR[calendar];
}

function weekOf(calendar: ServiceCalendar): readonly number[] {
  return calendar === "major_holidays" ? CARRIER_WEEK.weekdays : CARRIER_WEEK[calendar];
}

/** True when `value` is a key of the transit table, so it can be passed to shipByPlan(). */
export function isServiceKey(value: unknown): value is ServiceKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SERVICES, value);
}

/**
 * The carrier's special entry for a day, or null on an ordinary day.
 * `{ status: "closed", name: "Christmas Day" }` for carrierDay("ups_ground", "2026-12-25").
 */
export function carrierDay(service: ServiceKey, date: LocalDate): CalendarDay | null {
  return calendarOf(SERVICES[service].calendar)[date] ?? null;
}

/** True on the days of the week this service's network runs at all (never Sunday). */
export function isWorkingWeekday(service: ServiceKey, date: LocalDate): boolean {
  return weekOf(SERVICES[service].calendar).includes(weekday(date));
}

/**
 * Can this service deliver on `date`? Monday to Friday for UPS, FedEx and DHL, Monday to
 * Saturday for USPS, less the carrier's closed days. A "no pickup" or "modified" day still
 * delivers; a UPS "air only" day delivers air and express services but not ground.
 */
export function isDeliveryDay(service: ServiceKey, date: LocalDate): boolean {
  if (!isWorkingWeekday(service, date)) return false;
  const status = carrierDay(service, date)?.status;
  if (status === "closed") return false;
  if (status === "air_only" && !SERVICES[service].air) return false;
  return true;
}

/**
 * Is `date` a safe day to hand a parcel over for this service? A delivery day that is also not a
 * "no pickup" day (UPS on Christmas Eve) and not a "modified" day (FedEx's early cutoffs).
 */
export function isShipDay(service: ServiceKey, date: LocalDate): boolean {
  if (!isWorkingWeekday(service, date)) return false;
  const status = carrierDay(service, date)?.status;
  if (status === "closed" || status === "no_pickup" || status === "modified") return false;
  if (status === "air_only" && !SERVICES[service].air) return false;
  return true;
}

/** A transit day is any day the network moves parcels for this service: the same as a delivery day. */
export const isTransitDay = isDeliveryDay;

/** `date` itself when the service delivers that day, otherwise the last delivery day before it. */
export function previousDeliveryDay(service: ServiceKey, date: LocalDate): LocalDate {
  let day = date;
  for (let guard = 0; !isDeliveryDay(service, day); guard++) {
    if (guard > 30) throw new RangeError(`No delivery day found before ${date}`);
    day = addDays(day, -1);
  }
  return day;
}

/** `date` itself when the service delivers that day, otherwise the first delivery day after it. */
export function nextDeliveryDay(service: ServiceKey, date: LocalDate): LocalDate {
  let day = date;
  for (let guard = 0; !isDeliveryDay(service, day); guard++) {
    if (guard > 30) throw new RangeError(`No delivery day found after ${date}`);
    day = addDays(day, 1);
  }
  return day;
}

/** `date` itself when it is a safe ship day, otherwise the last ship day before it. */
export function previousShipDay(service: ServiceKey, date: LocalDate): LocalDate {
  let day = date;
  for (let guard = 0; !isShipDay(service, day); guard++) {
    if (guard > 30) throw new RangeError(`No ship day found before ${date}`);
    day = addDays(day, -1);
  }
  return day;
}

/** `date` itself when it is a safe ship day, otherwise the first ship day after it. */
export function nextShipDay(service: ServiceKey, date: LocalDate): LocalDate {
  let day = date;
  for (let guard = 0; !isShipDay(service, day); guard++) {
    if (guard > 30) throw new RangeError(`No ship day found after ${date}`);
    day = addDays(day, 1);
  }
  return day;
}

/**
 * `date` moved back by `count` transit days for this service. Counting starts the day before
 * `date`; a count of 0 returns `date` unchanged.
 */
export function subtractTransitDays(service: ServiceKey, date: LocalDate, count: number): LocalDate {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a whole number, 0 or more: ${count}`);
  let day = date;
  for (let counted = 0, guard = 0; counted < count; guard++) {
    if (guard > 1000) throw new RangeError(`No transit days found before ${date}`);
    day = addDays(day, -1);
    if (isTransitDay(service, day)) counted++;
  }
  return day;
}

/** `date` moved forward by `count` transit days. Counting starts the day after `date`. */
export function addTransitDays(service: ServiceKey, date: LocalDate, count: number): LocalDate {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a whole number, 0 or more: ${count}`);
  let day = date;
  for (let counted = 0, guard = 0; counted < count; guard++) {
    if (guard > 1000) throw new RangeError(`No transit days found after ${date}`);
    day = addDays(day, 1);
    if (isTransitDay(service, day)) counted++;
  }
  return day;
}

/**
 * The carrier's closed days strictly between two dates that would otherwise have been working
 * days: what "counting back 7 business days" had to step over. Weekends are not listed.
 */
export function closedDaysBetween(
  service: ServiceKey,
  after: LocalDate,
  before: LocalDate,
): { date: LocalDate; name: string; status: CalendarDay["status"] }[] {
  const found: { date: LocalDate; name: string; status: CalendarDay["status"] }[] = [];
  for (let day = addDays(after, 1), guard = 0; compareDates(day, before) < 0 && guard < 400; day = addDays(day, 1), guard++) {
    if (isWorkingWeekday(service, day) && !isDeliveryDay(service, day)) {
      const special = carrierDay(service, day);
      found.push({ date: day, name: special?.name ?? "a holiday", status: special?.status ?? "closed" });
    }
  }
  return found;
}

/** True inside a peak window (mid-November to early January), when ground parcels run slow. */
export function inPeakSeason(date: LocalDate): boolean {
  return PEAK_WINDOWS.some((window) => compareDates(date, window.from) >= 0 && compareDates(date, window.to) <= 0);
}

/**
 * How far the calendar for this service can be trusted on `date`:
 *  - `published`: the carrier's own schedule covers it;
 *  - `projected`: the carrier has not published that far; last year's pattern is assumed;
 *  - `unknown`: past the end of every calendar here, so holidays are not counted at all.
 */
export function calendarConfidence(service: ServiceKey, date: LocalDate): "published" | "projected" | "unknown" {
  if (compareDates(date, CALENDAR_COVERS_THROUGH) > 0) return "unknown";
  const calendar = SERVICES[service].calendar;
  const through =
    calendar === "major_holidays"
      ? (compareDates(CALENDAR_PUBLISHED_THROUGH.ups, CALENDAR_PUBLISHED_THROUGH.fedex) < 0
          ? CALENDAR_PUBLISHED_THROUGH.ups
          : CALENDAR_PUBLISHED_THROUGH.fedex)
      : CALENDAR_PUBLISHED_THROUGH[calendar];
  return compareDates(date, through) > 0 ? "projected" : "published";
}

/** The carrier zone for a straight-line distance: 2 up to 150 miles, 8 beyond 1,800. */
export function zoneFromMiles(miles: number): number {
  for (const band of ZONE_MAX_MILES) {
    if (miles <= band.maxMiles) return band.zone;
  }
  return ZONE_MAX_MILES[ZONE_MAX_MILES.length - 1].zone;
}

/** The n-th `weekdayIndex` (0 = Sunday) of a month, or the last one when n is -1. */
function nthWeekday(year: number, month: number, weekdayIndex: number, n: number): LocalDate {
  if (n > 0) {
    const first = toLocalDate(year, month, 1);
    const offset = (weekdayIndex - weekday(first) + 7) % 7;
    return addDays(first, offset + 7 * (n - 1));
  }
  const firstOfNext = month === 12 ? toLocalDate(year + 1, 1, 1) : toLocalDate(year, month + 1, 1);
  const last = addDays(firstOfNext, -1);
  const offset = (weekday(last) - weekdayIndex + 7) % 7;
  return addDays(last, -offset);
}

/**
 * The eleven US federal (and postal) holidays of a year on their ACTUAL dates, not the observed
 * ones. Used to cross-check the hand-entered USPS calendar; the carriers' calendars in ./config
 * are what the arithmetic uses.
 */
export function federalHolidays(year: number): Record<
  | "newYear" | "mlk" | "presidents" | "memorial" | "juneteenth" | "independence"
  | "labor" | "columbus" | "veterans" | "thanksgiving" | "christmas",
  LocalDate
> {
  return {
    newYear: toLocalDate(year, 1, 1),
    mlk: nthWeekday(year, 1, 1, 3),
    presidents: nthWeekday(year, 2, 1, 3),
    memorial: nthWeekday(year, 5, 1, -1),
    juneteenth: toLocalDate(year, 6, 19),
    independence: toLocalDate(year, 7, 4),
    labor: nthWeekday(year, 9, 1, 1),
    columbus: nthWeekday(year, 10, 1, 2),
    veterans: toLocalDate(year, 11, 11),
    thanksgiving: nthWeekday(year, 11, 4, 4),
    christmas: toLocalDate(year, 12, 25),
  };
}
