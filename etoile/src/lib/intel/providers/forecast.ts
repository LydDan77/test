import "server-only";

import { z } from "zod";
import type { UnitSystem } from "@/lib/domain";
import { addDays, compareDates, isLocalDate, isValidTimeZone, localDateOf, zonedToUtc, type LocalDate } from "@/lib/time";
import { HttpError } from "../http";
import {
  describeWeatherCode,
  type CurrentConditionsSignal,
  type DailyForecast,
  type ForecastSignal,
  type SourceResult,
  type WeatherPlace,
} from "../signals";
import { ECHOED_TEMPERATURE_UNIT, fetchOpenMeteo, openMeteoUrl, unitParams, withPauseAsReason } from "./open-meteo";
import { failure, HOUR_MS, MINUTE_MS, neverThrow, readThroughCache, usablePoint, type SourceOptions } from "./shared";

// The weather forecast, from Open-Meteo (https://open-meteo.com/, CC BY 4.0, free for
// non-commercial use). Credit it wherever its numbers are shown: DATA_SOURCES.forecast.
//
// Two questions, two light requests, each counted by Open-Meteo as one call:
//  - getForecast: seven daily figures for 16 days, refreshed hourly;
//  - getCurrentConditions: the sky right now, refreshed every 15 minutes.
// Sunrise and sunset are not asked for: sunTimes() in @/lib/time works them out.

/** The forecast reaches local today and the 15 days after it. */
export const FORECAST_DAYS = 16;

/** The last local date the forecast can cover for a place right now. */
export function forecastHorizon(now: Date, tz: string): LocalDate {
  return addDays(localDateOf(now, tz), FORECAST_DAYS - 1);
}

/**
 * How much of a date range the forecast can cover right now:
 * "all" (every day), "some" (it starts inside the horizon and runs past it), or "none"
 * (it starts beyond the horizon, or has already ended). For "some" and "none" in the future,
 * getTypicalWeather() answers for the days the forecast cannot reach.
 */
export function forecastCoverage(startDate: LocalDate, endDate: LocalDate, tz: string, now: Date): "all" | "some" | "none" {
  const today = localDateOf(now, tz);
  const horizon = forecastHorizon(now, tz);
  if (compareDates(endDate, today) < 0 || compareDates(startDate, horizon) > 0) return "none";
  return compareDates(startDate, today) >= 0 && compareDates(endDate, horizon) <= 0 ? "all" : "some";
}

export type WeatherOptions = SourceOptions & {
  /** The person's units (user.units): "imperial" gives °F, inches and mph; "metric" gives °C, mm, cm and km/h. */
  units: UnitSystem;
};

const DAILY_VARIABLES = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "precipitation_sum",
  "snowfall_sum",
  "wind_gusts_10m_max",
] as const;

const column = z.array(z.number().nullable());

const dailySchema = z
  .object({
    daily_units: z.record(z.string(), z.string()),
    daily: z.object({
      time: z.array(z.string().refine(isLocalDate, "not a date")),
      weather_code: column,
      temperature_2m_max: column,
      temperature_2m_min: column,
      precipitation_probability_max: column,
      precipitation_sum: column,
      snowfall_sum: column,
      wind_gusts_10m_max: column,
    }),
  })
  .refine((body) => DAILY_VARIABLES.every((name) => body.daily[name].length === body.daily.time.length), {
    message: "the daily columns have different lengths",
    path: ["daily"],
  });

function checkUnits(echoed: Record<string, string>, variable: string, units: UnitSystem): void {
  const unit = echoed[variable];
  if (unit !== undefined && unit !== ECHOED_TEMPERATURE_UNIT[units]) {
    throw new HttpError("shape", `Open-Meteo answered in ${unit}, not the ${units} units that were asked for`);
  }
}

async function fetchDaily(point: { lat: number; lon: number; tz: string }, units: UnitSystem, now: Date): Promise<ForecastSignal> {
  const url = openMeteoUrl("forecast", {
    latitude: point.lat,
    longitude: point.lon,
    daily: DAILY_VARIABLES.join(","),
    timezone: point.tz,
    forecast_days: FORECAST_DAYS,
    ...unitParams(units),
  });
  const body = await fetchOpenMeteo("forecast", url, dailySchema, now);
  checkUnits(body.daily_units, "temperature_2m_max", units);

  const { daily } = body;
  const days: DailyForecast[] = daily.time.map((date, index) => ({
    date,
    condition: describeWeatherCode(daily.weather_code[index] ?? -1),
    high: daily.temperature_2m_max[index],
    low: daily.temperature_2m_min[index],
    precipitationChance: daily.precipitation_probability_max[index],
    precipitation: daily.precipitation_sum[index],
    snowfall: daily.snowfall_sum[index],
    windGust: daily.wind_gusts_10m_max[index],
  }));
  if (days.length === 0) throw new HttpError("shape", "Open-Meteo returned a forecast with no days");
  return { tz: point.tz, units, days };
}

/**
 * The daily forecast for a place: local today and the 15 days after it, in the person's units.
 *
 *   const forecast = await getForecast(plan.destination, { units: user.units, now });
 *   if (forecast.ok) forecast.data.days.find((day) => day.date === plan.startDate);
 *
 * One shared copy per place (to about a kilometre), zone and unit system, refreshed hourly.
 * When Open-Meteo is down the last good forecast comes back with `stale: true` for up to
 * 12 hours; after that the result is a failure. Dates beyond the last day returned are simply
 * absent: use forecastCoverage() to tell, and getTypicalWeather() for those dates.
 * A place without coordinates gives `reason: "invalid_input"`.
 */
export async function getForecast(place: WeatherPlace, options: WeatherOptions): Promise<SourceResult<ForecastSignal>> {
  return neverThrow("forecast", async () => {
    const now = options.now ?? new Date();
    const point = usablePoint(place);
    if (!point) return failure("invalid_input", "The place has no coordinates or no valid time zone");

    const key = `v1:forecast:daily:${point.text}:${point.tz}:${options.units}`;
    const result = await readThroughCache(key, HOUR_MS, () => fetchDaily(point, options.units, now), {
      now,
      maxStaleMs: 12 * HOUR_MS,
      retryAfterMs: 5 * MINUTE_MS,
    });
    if (!result.ok) return withPauseAsReason(result, "forecast", now);

    // A copy fetched before midnight still starts on yesterday: the first day is always local today.
    const today = localDateOf(now, point.tz);
    return { ...result, data: { ...result.data, days: result.data.days.filter((day) => compareDates(day.date, today) >= 0) } };
  });
}

const CURRENT_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "weather_code",
  "cloud_cover",
  "precipitation",
  "wind_speed_10m",
  "is_day",
] as const;

const currentSchema = z.object({
  timezone: z.string().optional(),
  current_units: z.record(z.string(), z.string()),
  current: z.object({
    // Seconds since 1970 when asked with timeformat=unixtime (as this module does); a local
    // "2026-11-25T18:00" otherwise.
    time: z.union([z.number(), z.string()]),
    temperature_2m: z.number(),
    weather_code: z.number(),
    is_day: z.number(),
    apparent_temperature: z.number().nullish(),
    cloud_cover: z.number().nullish(),
    precipitation: z.number().nullish(),
    wind_speed_10m: z.number().nullish(),
  }),
});

async function fetchCurrent(point: { lat: number; lon: number; tz: string }, units: UnitSystem, now: Date): Promise<CurrentConditionsSignal> {
  const url = openMeteoUrl("forecast", {
    latitude: point.lat,
    longitude: point.lon,
    current: CURRENT_VARIABLES.join(","),
    timezone: point.tz,
    timeformat: "unixtime",
    forecast_days: 1,
    ...unitParams(units),
  });
  const body = await fetchOpenMeteo("forecast", url, currentSchema, now);
  checkUnits(body.current_units, "temperature_2m", units);

  const { current } = body;
  let observedAt: Date;
  if (typeof current.time === "number") {
    observedAt = new Date(current.time * 1000);
  } else {
    // A wall-clock reading with no offset, in the zone the answer names.
    const zone = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : point.tz;
    try {
      observedAt = zonedToUtc(current.time, zone);
    } catch {
      throw new HttpError("shape", "Open-Meteo returned a current time that cannot be read");
    }
  }
  if (!Number.isFinite(observedAt.getTime())) throw new HttpError("shape", "Open-Meteo returned a current time that cannot be read");

  return {
    tz: point.tz,
    units,
    observedAt: observedAt.toISOString(),
    condition: describeWeatherCode(current.weather_code),
    isDay: current.is_day === 1,
    temperature: current.temperature_2m,
    feelsLike: current.apparent_temperature ?? null,
    cloudCover: current.cloud_cover ?? null,
    precipitation: current.precipitation ?? null,
    windSpeed: current.wind_speed_10m ?? null,
  };
}

/**
 * The weather right now at a place, in the person's units: what is needed to draw the sky
 * behind a clock (condition, cloud cover, rain, day or night) and the temperature.
 *
 *   const sky = await getCurrentConditions(clock.place, { units: user.units, now });
 *   if (sky.ok) sky.data.condition.sky; sky.data.isDay; sky.data.temperature;
 *
 * One shared copy per place, zone and unit system, refreshed every 15 minutes. When Open-Meteo
 * is down the last good reading comes back with `stale: true` for up to two hours; after that
 * the result is a failure, because old weather is not "now". Draw the plain clock then.
 */
export async function getCurrentConditions(place: WeatherPlace, options: WeatherOptions): Promise<SourceResult<CurrentConditionsSignal>> {
  return neverThrow("current conditions", async () => {
    const now = options.now ?? new Date();
    const point = usablePoint(place);
    if (!point) return failure("invalid_input", "The place has no coordinates or no valid time zone");

    const key = `v1:forecast:current:${point.text}:${point.tz}:${options.units}`;
    const result = await readThroughCache(key, 15 * MINUTE_MS, () => fetchCurrent(point, options.units, now), {
      now,
      maxStaleMs: 2 * HOUR_MS,
      retryAfterMs: 5 * MINUTE_MS,
    });
    return withPauseAsReason(result, "forecast", now);
  });
}
