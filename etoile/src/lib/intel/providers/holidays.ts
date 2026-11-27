import "server-only";

import { z } from "zod";
import { addDays, compareDates, isLocalDate, parseLocalDate, type LocalDate } from "@/lib/time";
import { fetchJson, HttpError } from "../http";
import type { HolidayKind, HolidaysSignal, PublicHoliday, SourceResult } from "../signals";
import { computeLongWeekends, observedDate } from "./long-weekends";
import { DAY_MS, failure, isCountryCode, MINUTE_MS, neverThrow, readThroughCache, type SourceOptions } from "./shared";

// Public holidays from Nager.Date, API version 4 (DATA_SOURCES.holidays). No key, no stated limit.
//
// Version 3 of this API ends on 2027-01-31, so nothing here uses it: the long weekends that
// version offered are computed in ./long-weekends.ts instead.
//
// The service's host is configuration. HOLIDAYS_API_BASE_URL defaults to https://date.nager.at,
// which serves version 4 today; the project now documents https://nagerholidays.com as its
// home, so expect to change the variable there one day, without a code change.

const DEFAULT_BASE_URL = "https://date.nager.at";

/** The base URL of the holiday service: HOLIDAYS_API_BASE_URL when it is a usable web address. */
export function holidaysBaseUrl(): string {
  const configured = process.env.HOLIDAYS_API_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return configured.replace(/\/+$/, "");
    } catch {
      // Not a URL: fall through to the default.
    }
  }
  return DEFAULT_BASE_URL;
}

const KINDS: Record<string, HolidayKind> = {
  public: "public",
  bank: "bank",
  school: "school",
  authorities: "authorities",
  optional: "optional",
  observance: "observance",
};

const holidaysSchema = z.array(
  z.object({
    date: z.string().refine(isLocalDate, "not a date"),
    name: z.string().min(1),
    nationalHoliday: z.boolean(),
    subdivisionCodes: z.array(z.string()).nullish(),
    holidayTypes: z.array(z.string()),
  }),
);

/** Every row the service lists for a country and year, tidied but not yet filtered. */
type StoredYear = { coverage: "covered"; rows: PublicHoliday[] } | { coverage: "unknown" };

async function fetchYear(countryCode: string, year: number): Promise<StoredYear> {
  const url = `${holidaysBaseUrl()}/api/v4/Holidays/${countryCode}/${year}`;
  let body: z.infer<typeof holidaysSchema> | null;
  try {
    // A real country the service has no data for is answered 204 with no body at all.
    body = await fetchJson(url, holidaysSchema, { allowEmpty: true });
  } catch (error) {
    // A code the service does not know is a 404 that says so. Any other 404 is a wrong address.
    if (error instanceof HttpError && error.status === 404 && /unknown country/i.test(error.body ?? "")) return { coverage: "unknown" };
    throw error;
  }
  if (body === null) return { coverage: "unknown" };
  return {
    coverage: "covered",
    rows: body.map((row) => ({
      date: row.date,
      observedOn: observedDate(row.date, countryCode),
      name: row.name.trim(),
      nationwide: row.nationalHoliday,
      regions: row.nationalHoliday ? [] : (row.subdivisionCodes ?? []).map((code) => code.toUpperCase()),
      kinds: row.holidayTypes.map((type) => KINDS[type.toLowerCase()]).filter((kind): kind is HolidayKind => kind !== undefined),
    })),
  };
}

/** "TX", "us-tx" or "US-TX" as "US-TX"; null when it does not look like a region code. */
function regionCode(countryCode: string, region: string | undefined): string | null {
  if (!region) return null;
  const upper = region.trim().toUpperCase();
  const suffix = upper.startsWith(`${countryCode}-`) ? upper.slice(countryCode.length + 1) : upper;
  return /^[A-Z0-9]{1,3}$/.test(suffix) ? `${countryCode}-${suffix}` : null;
}

/**
 * The days people at a place actually have off: public holidays for the whole country, plus
 * those for the place's own region when one is given. Bank-only days, observances and optional
 * days are left out, and a day the service lists twice appears once.
 */
function holidaysThatApply(rows: PublicHoliday[], region: string | null): PublicHoliday[] {
  const byDayAndName = new Map<string, PublicHoliday>();
  for (const row of rows) {
    if (!row.kinds.includes("public")) continue;
    if (!row.nationwide && !(region && row.regions.includes(region))) continue;
    const key = `${row.date}|${row.name}`;
    const seen = byDayAndName.get(key);
    if (!seen) byDayAndName.set(key, row);
    else if (row.nationwide && !seen.nationwide) byDayAndName.set(key, row);
  }
  return [...byDayAndName.values()].sort((a, b) => compareDates(a.date, b.date) || a.name.localeCompare(b.name));
}

export type HolidayOptions = SourceOptions & {
  /**
   * The place's region, to include holidays only that region has: an ISO 3166-2 code
   * ("US-TX") or its second half ("TX"). A region name ("Texas") is not understood and is ignored.
   */
  region?: string;
};

async function readYear(countryCode: string, year: number, now: Date): Promise<SourceResult<StoredYear>> {
  // Holidays for a year hardly ever change: keep a week, and an old copy is still right.
  return readThroughCache(`v1:holidays:${countryCode}:${year}`, 7 * DAY_MS, () => fetchYear(countryCode, year), { now, retryAfterMs: 10 * MINUTE_MS });
}

/**
 * Public holidays and long weekends in a country for one calendar year.
 *
 *   const result = await getPublicHolidays("US", 2026, { region: "TX", now });
 *   if (result.ok && result.data.coverage === "covered") result.data.holidays; result.data.longWeekends;
 *
 * `coverage: "unknown"` means the service has no data for the country (46 countries, India,
 * Thailand and the UAE among them; holidays set by moon sighting are also missing everywhere).
 * That is "we do not know": say nothing, never "no holidays".
 *
 * `countryCode` is ISO 3166-1 alpha-2 (PlaceRef.countryCode). One shared copy per country and
 * year, kept a week; when the service is down an older copy is still returned (`stale: true`),
 * because the dates do not change.
 */
export async function getPublicHolidays(countryCode: string, year: number, options: HolidayOptions = {}): Promise<SourceResult<HolidaysSignal>> {
  return neverThrow<HolidaysSignal>("holidays", async () => {
    const now = options.now ?? new Date();
    if (!isCountryCode(countryCode)) return failure("invalid_input", "The country code is not two letters");
    if (!Number.isInteger(year) || year < 1970 || year > 2100) return failure("invalid_input", "The year is out of range");
    const country = countryCode.trim().toUpperCase();

    const result = await readYear(country, year, now);
    if (!result.ok) return result;
    if (result.data.coverage === "unknown") return { ...result, data: { coverage: "unknown", countryCode: country } };

    const holidays = holidaysThatApply(result.data.rows, regionCode(country, options.region));
    return { ...result, data: { coverage: "covered", countryCode: country, holidays, longWeekends: computeLongWeekends(holidays) } };
  });
}

/**
 * Public holidays and long weekends that fall inside a range of local dates, across a year
 * boundary when the range crosses one (a Christmas-to-New-Year stay).
 *
 *   const result = await getPublicHolidaysBetween("US", plan.startDate, plan.endDate, { region: "FL", now });
 *
 * A holiday is included when its date or the day it is observed on is inside the range; a long
 * weekend when any of its days is. Ranges longer than about two years are refused.
 * Everything else is as for getPublicHolidays().
 */
export async function getPublicHolidaysBetween(
  countryCode: string,
  startDate: LocalDate,
  endDate: LocalDate,
  options: HolidayOptions = {},
): Promise<SourceResult<HolidaysSignal>> {
  return neverThrow<HolidaysSignal>("holidays", async () => {
    const now = options.now ?? new Date();
    if (!isCountryCode(countryCode)) return failure("invalid_input", "The country code is not two letters");
    if (!isLocalDate(startDate) || !isLocalDate(endDate) || compareDates(endDate, startDate) < 0) {
      return failure("invalid_input", "The dates are not a valid range");
    }
    const country = countryCode.trim().toUpperCase();

    // Two days of margin either side: a holiday just outside the range can be observed inside it.
    const firstYear = parseLocalDate(addDays(startDate, -2)).year;
    const lastYear = parseLocalDate(addDays(endDate, 2)).year;
    if (firstYear < 1970 || lastYear > 2100 || lastYear - firstYear > 2) return failure("invalid_input", "The date range is too long or out of range");

    const rows: PublicHoliday[] = [];
    let fetchedAt: Date | null = null;
    let stale = false;
    for (let year = firstYear; year <= lastYear; year++) {
      const result = await readYear(country, year, now);
      if (!result.ok) return result;
      if (result.data.coverage === "unknown") return { ...result, data: { coverage: "unknown", countryCode: country } };
      rows.push(...result.data.rows);
      if (!fetchedAt || result.fetchedAt.getTime() < fetchedAt.getTime()) fetchedAt = result.fetchedAt;
      stale = stale || result.stale;
    }

    const inRange = (date: LocalDate) => compareDates(date, startDate) >= 0 && compareDates(date, endDate) <= 0;
    const all = holidaysThatApply(rows, regionCode(country, options.region));
    const holidays = all.filter((holiday) => inRange(holiday.date) || inRange(holiday.observedOn));
    const longWeekends = computeLongWeekends(all).filter((run) => compareDates(run.startDate, endDate) <= 0 && compareDates(run.endDate, startDate) >= 0);
    return { ok: true, data: { coverage: "covered", countryCode: country, holidays, longWeekends }, fetchedAt: fetchedAt ?? now, stale };
  });
}
