import "server-only";

import { z } from "zod";
import { peekCached } from "@/lib/cache";
import type { UnitSystem } from "@/lib/domain";
import { addDays, compareDates, diffDays, isLocalDate, localDateOf, parseLocalDate, type LocalDate } from "@/lib/time";
import { HttpError } from "../http";
import { celsiusToFahrenheit, fahrenheitToCelsius, type SourceFailure, type SourceResult, type TypicalWeatherSignal, type WeatherPlace } from "../signals";
import type { WeatherOptions } from "./forecast";
import { fetchOpenMeteo, isOpenMeteoPaused, openMeteoUrl, unitParams } from "./open-meteo";
import { DAY_MS, failure, MINUTE_MS, neverThrow, readThroughCache, usablePoint } from "./shared";

// Typical weather for dates the forecast cannot reach yet, from Open-Meteo's historical
// weather API (ERA5 reanalysis; same licence and credit as the forecast: DATA_SOURCES.typicalWeather).
//
// The method: take the same calendar window in each of the last ten years, one small request
// per year, and average. Past weather never changes, so each year's answer is kept for good.
//
// This host counts requests per internet address and often answers 429 ("Daily API request
// limit exceeded") on shared hosting. So the module is deliberately frugal:
//  - years already in the cache are never asked for again;
//  - missing years are asked for one at a time, and the first failure of any kind ends the
//    attempt (the years already fetched are kept; the rest are tried on a later call);
//  - after a 429 nothing more is sent to the host until the pause recorded in open-meteo.ts
//    runs out, and a 429 is never retried;
//  - a failure is never stored as data.

/** How many past years the figures are drawn from when all of them are available. */
export const TYPICAL_YEARS = 10;
/** With fewer years than this there is no answer: one or two years are an anecdote, not "typical". */
export const TYPICAL_MIN_YEARS = 3;
/** A longer range is shortened to this many days, which keeps each request at the lowest cost. */
export const TYPICAL_MAX_DAYS = 31;

/** Kept "for good": the cache needs a date, so this is fifty years. */
const FOREVER_MS = 50 * 365 * DAY_MS;
/** The reanalysis runs about five days behind; a window must have ended this long ago to be asked for. */
const ARCHIVE_LAG_DAYS = 7;
/** A day with at least this much rain or melted snow counts as wet (the usual 1 mm rule). */
const WET_DAY_MM = 1;

type YearOfWeather = {
  year: number;
  /** Daily highs and lows in °C and daily precipitation in mm, one entry per day of the window. */
  highs: (number | null)[];
  lows: (number | null)[];
  precipitation: (number | null)[];
};

const column = z.array(z.number().nullable());

const archiveSchema = z
  .object({
    daily_units: z.record(z.string(), z.string()),
    daily: z.object({
      time: z.array(z.string().refine(isLocalDate, "not a date")),
      temperature_2m_max: column,
      temperature_2m_min: column,
      precipitation_sum: column,
    }),
  })
  .refine(
    (body) =>
      body.daily.temperature_2m_max.length === body.daily.time.length &&
      body.daily.temperature_2m_min.length === body.daily.time.length &&
      body.daily.precipitation_sum.length === body.daily.time.length,
    { message: "the daily columns have different lengths", path: ["daily"] },
  );

/** The same month and day in another year. Feb 29 becomes Feb 28 when that year has none. */
function sameDayInYear(date: LocalDate, year: number): LocalDate {
  const { month, day } = parseLocalDate(date);
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isLocalDate(text) ? text : addDays(`${String(year).padStart(4, "0")}-03-01`, -1);
}

/**
 * The windows to average over: the same dates in the most recent past years whose window has
 * fully ended, newest first.
 */
export function pastWindows(startDate: LocalDate, spanDays: number, now: Date, count = TYPICAL_YEARS): { year: number; start: LocalDate; end: LocalDate }[] {
  const latestComplete = addDays(localDateOf(now, "UTC"), -ARCHIVE_LAG_DAYS);
  const windows: { year: number; start: LocalDate; end: LocalDate }[] = [];
  for (let year = parseLocalDate(latestComplete).year; windows.length < count && year >= 1950; year--) {
    const start = sameDayInYear(startDate, year);
    const end = addDays(start, spanDays);
    if (compareDates(end, latestComplete) <= 0) windows.push({ year, start, end });
  }
  return windows;
}

async function fetchYear(point: { lat: number; lon: number; tz: string }, window: { year: number; start: LocalDate; end: LocalDate }, now: Date): Promise<YearOfWeather> {
  const url = openMeteoUrl("archive", {
    latitude: point.lat,
    longitude: point.lon,
    start_date: window.start,
    end_date: window.end,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
    timezone: point.tz,
    // Always metric: one stored copy serves everyone, and the averages are converted on the way out.
    ...unitParams("metric"),
  });
  const body = await fetchOpenMeteo("archive", url, archiveSchema, now);

  // Trust the units the answer names over the ones asked for.
  const inFahrenheit = body.daily_units.temperature_2m_max === "°F";
  const inInches = body.daily_units.precipitation_sum === "inch";
  const celsius = (value: number | null) => (value === null ? null : inFahrenheit ? fahrenheitToCelsius(value) : value);
  const millimetres = (value: number | null) => (value === null ? null : inInches ? value * 25.4 : value);

  const year: YearOfWeather = {
    year: window.year,
    highs: body.daily.temperature_2m_max.map(celsius),
    lows: body.daily.temperature_2m_min.map(celsius),
    precipitation: body.daily.precipitation_sum.map(millimetres),
  };
  // An answer with no numbers in it must not be kept for fifty years.
  if (!year.highs.some((value) => value !== null) || !year.lows.some((value) => value !== null)) {
    throw new HttpError("shape", "Open-Meteo returned no temperatures for the dates asked");
  }
  return year;
}

const present = (values: (number | null)[]): number[] => values.filter((value): value is number => value !== null);
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const round1 = (value: number): number => Math.round(value * 10) / 10 + 0;

/** Averages the years into the figures people see. Exported for tests; use getTypicalWeather(). */
export function summariseYears(years: YearOfWeather[], range: { startDate: LocalDate; endDate: LocalDate }, units: UnitSystem): TypicalWeatherSignal | null {
  const highs = years.flatMap((year) => present(year.highs));
  const lows = years.flatMap((year) => present(year.lows));
  const precipitation = years.flatMap((year) => present(year.precipitation));
  if (highs.length === 0 || lows.length === 0) return null;

  const temperature = (celsius: number) => round1(units === "imperial" ? celsiusToFahrenheit(celsius) : celsius);
  const wetDayShare = precipitation.length === 0 ? 0 : precipitation.filter((mm) => mm >= WET_DAY_MM).length / precipitation.length;
  const days = diffDays(range.startDate, range.endDate) + 1;
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    days,
    units,
    high: temperature(mean(highs)),
    low: temperature(mean(lows)),
    warmestHigh: temperature(Math.max(...highs)),
    coldestLow: temperature(Math.min(...lows)),
    wetDayShare: Math.round(wetDayShare * 100) / 100,
    typicalWetDays: Math.round(wetDayShare * days),
    years: years.map((year) => year.year).sort((a, b) => b - a),
  };
}

export type TypicalWeatherOptions = WeatherOptions & {
  /**
   * How many past years to draw on: 3 to 10, default 10. Fewer years means fewer requests the
   * first time a place and dates are asked about, and a rougher answer.
   */
  years?: number;
};

/**
 * What the weather usually does at a place between two local dates, from the same dates in
 * recent past years. For dates beyond the forecast (see forecastCoverage()).
 *
 *   const typical = await getTypicalWeather(plan.destination, { startDate: plan.startDate, endDate: plan.endDate }, { units: user.units, now });
 *   if (typical.ok) `${Math.round(typical.data.high)}° / ${Math.round(typical.data.low)}°, rain on about ${typical.data.typicalWetDays} days in ${typical.data.days}`
 *
 * The temperatures come with one decimal; round them for display, and say "typically".
 * A range longer than 31 days is shortened to its first 31; the result says which dates it used.
 *
 * Failures are ordinary for this source. `reason: "rate_limited"` means the service's daily
 * allowance is used up: nothing is wrong and nothing should be shown; the next call after the
 * pause picks up where this one stopped. Once enough years are in, the answer is kept for good
 * and no further request is ever made for that place and those dates. `stale` is always false.
 */
export async function getTypicalWeather(
  place: WeatherPlace,
  range: { startDate: LocalDate; endDate: LocalDate },
  options: TypicalWeatherOptions,
): Promise<SourceResult<TypicalWeatherSignal>> {
  return neverThrow("typical weather", async () => {
    const now = options.now ?? new Date();
    const point = usablePoint(place);
    if (!point) return failure("invalid_input", "The place has no coordinates or no valid time zone");
    if (!isLocalDate(range.startDate) || !isLocalDate(range.endDate) || compareDates(range.endDate, range.startDate) < 0) {
      return failure("invalid_input", "The dates are not a valid range");
    }

    const spanDays = Math.min(diffDays(range.startDate, range.endDate), TYPICAL_MAX_DAYS - 1);
    const used = { startDate: range.startDate, endDate: addDays(range.startDate, spanDays) };
    const wanted = Number.isFinite(options.years) ? Math.round(options.years as number) : TYPICAL_YEARS;
    const windows = pastWindows(used.startDate, spanDays, now, Math.min(Math.max(wanted, TYPICAL_MIN_YEARS), TYPICAL_YEARS));
    const keyFor = (window: { start: LocalDate }) => `v1:typical:${point.text}:${window.start}:${spanDays}`;

    // What is already stored, read together.
    const stored = await Promise.all(
      windows.map(async (window) => {
        try {
          const row = await peekCached<YearOfWeather>(keyFor(window));
          return row && row.data ? { year: row.data, fetchedAt: row.fetchedAt } : null;
        } catch {
          return null;
        }
      }),
    );

    const years: YearOfWeather[] = [];
    let newest: Date | null = null;
    let stopped: SourceFailure | null = null;
    for (const [index, window] of windows.entries()) {
      const have = stored[index];
      if (have) {
        years.push(have.year);
        if (!newest || have.fetchedAt.getTime() > newest.getTime()) newest = have.fetchedAt;
        continue;
      }
      // One failure ends the asking: the rest wait for a later call.
      if (stopped) continue;
      const fetched = await readThroughCache(keyFor(window), FOREVER_MS, () => fetchYear(point, window, now), {
        now,
        retryAfterMs: 10 * MINUTE_MS,
      });
      if (!fetched.ok) {
        stopped = fetched;
        continue;
      }
      years.push(fetched.data);
      if (!newest || fetched.fetchedAt.getTime() > newest.getTime()) newest = fetched.fetchedAt;
    }

    const summary = years.length >= TYPICAL_MIN_YEARS ? summariseYears(years, used, options.units) : null;
    if (!summary || !newest) {
      const paused = await isOpenMeteoPaused("archive", now);
      const reason = paused ? "rate_limited" : (stopped?.reason ?? "unavailable");
      const detail = stopped?.detail ?? "Too few past years are available for these dates";
      return failure(reason, `${detail} (${years.length} of ${windows.length} years in hand)`);
    }
    return { ok: true, data: summary, fetchedAt: newest, stale: false };
  });
}
