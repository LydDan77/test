// Signals: the typed answers the live-data sources give.
//
// Every function in ./providers returns a SourceResult<…> of one of the types below. The
// heads-up rules are written against these shapes, so they hold facts and numbers, not wording
// for a particular screen. Pure: no network, no database, safe to import anywhere.
//
// Conventions:
//  - An instant is an ISO 8601 UTC string ("2026-11-26T18:00:00.000Z"). Show it in the zone of
//    the place it belongs to: formatClock(instant, place.tz).
//  - A local date is "YYYY-MM-DD" in the zone of the place the signal is about.
//  - `null` always means "the source did not say", never zero.

import type { UnitSystem } from "@/lib/domain/enums";
import type { LocalDate } from "@/lib/time/dates";
import { EN_DASH } from "@/lib/time/symbols";

// --- the result every source returns ---------------------------------------------------------

/**
 * Why a source has no answer.
 *  - "unavailable": the source failed and there is no recent good answer to fall back on.
 *  - "rate_limited": the source says it has been asked too often. Nothing is wrong; try later.
 *  - "invalid_input": the question cannot be asked (a place without coordinates, a date range
 *    that runs backwards, a country code that is not two letters).
 */
export type SourceFailureReason = "unavailable" | "rate_limited" | "invalid_input";

/**
 * What every source function returns. It never throws.
 *
 *   const forecast = await getForecast(plan.destination, { units: user.units, now });
 *   if (!forecast.ok) return;            // say nothing, or "weather is not available right now"
 *   forecast.data.days                   // the answer
 *   forecast.fetchedAt                   // show as "as of 2:05 PM"
 *   forecast.stale                       // true: the source is down and this is the last good answer
 *
 * `ok: false` means "we do not know", never "nothing to report": do not show "no delays" or
 * "no alerts" for a failed result.
 */
export type SourceResult<T> =
  | {
      ok: true;
      data: T;
      /** When `data` came from the source. */
      fetchedAt: Date;
      /** True when the latest refresh failed and `data` is the last good answer. */
      stale: boolean;
    }
  | {
      ok: false;
      reason: SourceFailureReason;
      /** For logs. Not wording for people. */
      detail: string;
      /** When the source last gave a good answer that has since become too old to show, if ever. */
      lastGoodAt: Date | null;
    };

/** The failed half of a SourceResult. */
export type SourceFailure = Extract<SourceResult<never>, { ok: false }>;

// --- weather ---------------------------------------------------------------------------------

/** A place the weather sources can be asked about: coordinates and the place's zone. A PlaceRef fits. */
export type WeatherPlace = { lat?: number; lon?: number; tz: string };

/** Broad kinds of sky, for choosing a picture or an icon. */
export type SkyKind =
  | "clear"
  | "partly_cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "freezing_rain"
  | "snow"
  | "thunderstorm"
  | "unknown";

export type WeatherCondition = {
  /** The WMO weather code the source reported. */
  code: number;
  /** Plain words for it: "Partly cloudy", "Light rain". "Unknown" for a code not in the table. */
  label: string;
  /** "unknown" for a code not in the table: leave the words out rather than print "Unknown". */
  sky: SkyKind;
};

const WEATHER_CODES: Record<number, { label: string; sky: SkyKind }> = {
  0: { label: "Clear", sky: "clear" },
  1: { label: "Mostly clear", sky: "clear" },
  2: { label: "Partly cloudy", sky: "partly_cloudy" },
  3: { label: "Cloudy", sky: "cloudy" },
  45: { label: "Fog", sky: "fog" },
  48: { label: "Freezing fog", sky: "fog" },
  51: { label: "Light drizzle", sky: "drizzle" },
  53: { label: "Drizzle", sky: "drizzle" },
  55: { label: "Heavy drizzle", sky: "drizzle" },
  56: { label: "Light freezing drizzle", sky: "freezing_rain" },
  57: { label: "Freezing drizzle", sky: "freezing_rain" },
  61: { label: "Light rain", sky: "rain" },
  63: { label: "Rain", sky: "rain" },
  65: { label: "Heavy rain", sky: "rain" },
  66: { label: "Light freezing rain", sky: "freezing_rain" },
  67: { label: "Freezing rain", sky: "freezing_rain" },
  71: { label: "Light snow", sky: "snow" },
  73: { label: "Snow", sky: "snow" },
  75: { label: "Heavy snow", sky: "snow" },
  77: { label: "Fine snow", sky: "snow" },
  80: { label: "Light showers", sky: "rain" },
  81: { label: "Showers", sky: "rain" },
  82: { label: "Heavy showers", sky: "rain" },
  85: { label: "Light snow showers", sky: "snow" },
  86: { label: "Heavy snow showers", sky: "snow" },
  95: { label: "Thunderstorm", sky: "thunderstorm" },
  96: { label: "Thunderstorm with hail", sky: "thunderstorm" },
  97: { label: "Heavy thunderstorm", sky: "thunderstorm" },
  99: { label: "Thunderstorm with heavy hail", sky: "thunderstorm" },
};

/** Every WMO weather code the forecast source documents, in ascending order. */
export const KNOWN_WEATHER_CODES: readonly number[] = Object.keys(WEATHER_CODES).map(Number).sort((a, b) => a - b);

/**
 * Plain words and a sky kind for a WMO weather code. A code that is not in the table (the
 * source adds one now and then) gives `{ label: "Unknown", sky: "unknown" }` instead of throwing.
 */
export function describeWeatherCode(code: number): WeatherCondition {
  const known = WEATHER_CODES[code];
  return known ? { code, ...known } : { code, label: "Unknown", sky: "unknown" };
}

/** The units a weather signal's numbers are in, and how to write them. */
export const UNIT_LABELS: Record<UnitSystem, { temperature: string; rain: string; snow: string; wind: string }> = {
  imperial: { temperature: "°F", rain: "in", snow: "in", wind: "mph" },
  metric: { temperature: "°C", rain: "mm", snow: "cm", wind: "km/h" },
};

/** One local day of the forecast. Numbers are in the signal's `units` (see UNIT_LABELS). */
export type DailyForecast = {
  /** The local calendar day at the place. */
  date: LocalDate;
  condition: WeatherCondition;
  /** Highest temperature of the day. */
  high: number | null;
  /** Lowest temperature of the day. */
  low: number | null;
  /** Chance of any rain or snow that day, 0 to 100. */
  precipitationChance: number | null;
  /** Rain and melted snow together: inches (imperial) or millimetres (metric). */
  precipitation: number | null;
  /** Fresh snow: inches (imperial) or centimetres (metric). */
  snowfall: number | null;
  /** Strongest gust: mph (imperial) or km/h (metric). */
  windGust: number | null;
};

/** The daily forecast for a place: local today and up to 15 days after it. */
export type ForecastSignal = {
  /** The zone the days are counted in (the place's own). */
  tz: string;
  units: UnitSystem;
  /** Oldest first. Starts at local today; days that have already passed are left out. */
  days: DailyForecast[];
};

/** What the sky is doing right now somewhere: enough to draw it behind a clock. */
export type CurrentConditionsSignal = {
  tz: string;
  units: UnitSystem;
  /** When the source measured or modelled this (an instant). Usually within the last 15 minutes. */
  observedAt: string;
  condition: WeatherCondition;
  /** True between sunrise and sunset at the place. */
  isDay: boolean;
  temperature: number;
  /** "Feels like", when the source gives it. */
  feelsLike: number | null;
  /** Share of the sky covered by cloud, 0 to 100. */
  cloudCover: number | null;
  /** Rain or melted snow in the last hour: inches or millimetres. */
  precipitation: number | null;
  /** Wind speed: mph or km/h. */
  windSpeed: number | null;
};

/**
 * What the weather usually does at a place on these dates, from the same days in recent past
 * years. For dates the forecast cannot reach yet. Say "typically", never "will".
 */
export type TypicalWeatherSignal = {
  /** The range that was asked about (shortened to 31 days if it was longer). */
  startDate: LocalDate;
  endDate: LocalDate;
  /** How many days that range covers. */
  days: number;
  units: UnitSystem;
  /** The usual daytime high and overnight low. */
  high: number;
  low: number;
  /** The warmest high and coldest low seen on these dates in the years used. */
  warmestHigh: number;
  coldestLow: number;
  /** Share of days with measurable rain or snow (1 mm or more), 0 to 1. */
  wetDayShare: number;
  /** `wetDayShare` as whole days of this stay: "rain on about 2 days in 9". */
  typicalWetDays: number;
  /** The past years the figures come from, newest first. Never fewer than three. */
  years: number[];
};

/**
 * The same day with every number in imperial units (°F, inches, mph), whatever `units` it came
 * in. Rule thresholds are written in imperial; show the person the original.
 */
export function dailyForecastInImperial(day: DailyForecast, units: UnitSystem): DailyForecast {
  if (units === "imperial") return day;
  const convert = (value: number | null, fn: (v: number) => number) => (value === null ? null : round1(fn(value)));
  return {
    ...day,
    high: convert(day.high, celsiusToFahrenheit),
    low: convert(day.low, celsiusToFahrenheit),
    precipitation: day.precipitation === null ? null : Math.round((day.precipitation / 25.4) * 1000) / 1000,
    snowfall: day.snowfall === null ? null : Math.round((day.snowfall / 2.54) * 1000) / 1000,
    windGust: convert(day.windGust, (kmh) => kmh / 1.609344),
  };
}

export const celsiusToFahrenheit = (celsius: number): number => (celsius * 9) / 5 + 32;
export const fahrenheitToCelsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;
const round1 = (value: number): number => Math.round(value * 10) / 10;

// --- airport status (FAA, United States only) ------------------------------------------------

export type AirportEventKind =
  | "closure"
  | "ground_stop"
  | "ground_delay"
  | "arrival_delay"
  | "departure_delay"
  | "deicing";

/** One thing the FAA reports at an airport right now. */
export type AirportEvent = {
  kind: AirportEventKind;
  /** A plain sentence about what is happening, without the airport's name or any clock time. */
  description: string;
  /** Why, in plain words ("weather", "low clouds", "heavy traffic"), when the FAA's reason can be put plainly. */
  reason: string | null;
  /** When it began (an instant), if the FAA says. */
  startsAt: string | null;
  /** When it is due to end (an instant), if the FAA says. A closure or ground stop can be extended. */
  endsAt: string | null;
  /** Only when the back-up feed is in use: the end as the airport's own clock text ("7:45 pm EST"). */
  endsAtLocalText: string | null;
  /** How late flights are running, for delays and ground delays. Null for the other kinds. */
  delay: {
    minMinutes: number | null;
    maxMinutes: number | null;
    averageMinutes: number | null;
    trend: "increasing" | "decreasing" | null;
  } | null;
  /** Ground stops only: how likely the FAA thinks it is to be extended. */
  extensionLikelihood: "low" | "medium" | "high" | null;
  /** When the FAA last updated this entry (an instant). */
  updatedAt: string | null;
};

/**
 * The status of one airport. Exactly three states:
 *  - "no_delays": the FAA feed is healthy and lists nothing for this airport.
 *    Say "No FAA delays reported", never "on time": the FAA does not see individual flights.
 *  - "events": the FAA lists one or more things, most serious first.
 *  - "unavailable": we do not know. Either the feed could not be read, or the airport is outside
 *    the United States (`why: "not_covered"`), where the FAA reports nothing.
 *
 * A notice that only restricts private or military aircraft is never reported as a closure:
 * such an airport is "no_delays" (or shows its other events).
 */
export type AirportStatus =
  | { state: "no_delays"; airport: string }
  | { state: "events"; airport: string; name: string | null; events: AirportEvent[] }
  | { state: "unavailable"; airport: string; why: "source_down" | "not_covered" };

export type AirportStatusSignal = {
  /** One entry per airport asked about, in the order asked, without repeats. */
  airports: AirportStatus[];
  /** When the FAA last rebuilt its feed (an instant), when it says. */
  feedUpdatedAt: string | null;
};

/**
 * The status of one airport from a getAirportStatus() result, whatever happened:
 *
 *   const status = airportStatusOf(result, "MCO");
 *   switch (status.state) { case "no_delays": … case "events": … case "unavailable": … }
 *
 * A failed result, and an airport that was not asked about, both give "unavailable".
 */
export function airportStatusOf(result: SourceResult<AirportStatusSignal>, airport: string): AirportStatus {
  const code = airport.trim().toUpperCase();
  if (!result.ok) return { state: "unavailable", airport: code, why: "source_down" };
  return result.data.airports.find((status) => status.airport === code) ?? { state: "unavailable", airport: code, why: "source_down" };
}

// --- official weather alerts (National Weather Service, United States only) ------------------

export type AlertSeverity = "extreme" | "severe" | "moderate" | "minor" | "unknown";
export type AlertUrgency = "immediate" | "expected" | "future" | "past" | "unknown";
export type AlertCertainty = "observed" | "likely" | "possible" | "unlikely" | "unknown";

/** A place the alert source can be asked about. A PlaceRef fits. */
export type AlertPlace = WeatherPlace & { countryCode?: string };

export type WeatherAlert = {
  /** Stable for one alert message: use it to avoid showing the same alert twice. */
  id: string;
  /** The official name: "High Wind Warning", "Flood Watch". */
  event: string;
  severity: AlertSeverity;
  urgency: AlertUrgency;
  certainty: AlertCertainty;
  /** The service's own one-line summary, when it gives one. */
  headline: string | null;
  /** The counties or zones covered, as the service lists them ("Surry; Chesapeake; Suffolk"). */
  area: string;
  /** When the hazard begins, or when the alert took effect if no beginning is given (an instant). */
  startsAt: string;
  /** When the hazard ends: the event's end when given, otherwise when the message expires (an instant). */
  endsAt: string | null;
  /** What is expected, as paragraphs separated by blank lines. */
  description: string | null;
  /** What to do, when the service says. */
  instruction: string | null;
  /** The issuing office: "NWS Wakefield VA". */
  sender: string | null;
  /** True when this message updates an earlier alert for the same event. */
  isUpdate: boolean;
};

export type WeatherAlertsSignal = {
  /**
   * "not_covered": the place is outside the United States, where this source has nothing.
   * Show nothing at all for it, never "no alerts".
   */
  coverage: "covered" | "not_covered";
  /** Alerts in force at the place, most severe first. Empty with "covered" means none are in force. */
  alerts: WeatherAlert[];
};

// --- public holidays -------------------------------------------------------------------------

export type HolidayKind = "public" | "bank" | "school" | "authorities" | "optional" | "observance";

export type PublicHoliday = {
  /** The day itself. */
  date: LocalDate;
  /** The weekday most people get off instead, when the day falls on a weekend and the country moves it. Otherwise the same as `date`. */
  observedOn: LocalDate;
  /** In English: "Thanksgiving Day". */
  name: string;
  /** True when the whole country has the day; false when only some regions do. */
  nationwide: boolean;
  /** The regions that have it (ISO 3166-2, "US-TX"), when not nationwide. */
  regions: string[];
  kinds: HolidayKind[];
};

/** A run of three or more days off around a public holiday. */
export type LongWeekend = {
  startDate: LocalDate;
  endDate: LocalDate;
  /** Days from start to end, both included. */
  days: number;
  /** Working days a person would need to take off to get the whole run. Empty when none are needed. */
  bridgeDays: LocalDate[];
  /** The holidays inside the run. */
  holidays: string[];
};

export type HolidaysSignal =
  | {
      /** The source has data for this country. */
      coverage: "covered";
      countryCode: string;
      /** Public holidays that apply to the place asked about, oldest first, one entry per day and name. */
      holidays: PublicHoliday[];
      /** Long weekends around those holidays, oldest first. */
      longWeekends: LongWeekend[];
    }
  | {
      /**
       * The source has no data for this country (India, Thailand and the UAE are among them).
       * This is "we do not know", not "there are no holidays": say nothing.
       */
      coverage: "unknown";
      countryCode: string;
    };

// --- travel advisories (US Department of State) ----------------------------------------------

export type AdvisoryLevel = 1 | 2 | 3 | 4;

/** The Department's own wording for each level, in sentence case. */
export const ADVISORY_LEVEL_TEXT: Record<AdvisoryLevel, string> = {
  1: "Exercise normal precautions",
  2: "Exercise increased caution",
  3: "Reconsider travel",
  4: "Do not travel",
};

export type TravelAdvisory = {
  /** The country or area the advisory names: "Mexico", "The West Bank". */
  area: string;
  level: AdvisoryLevel;
  /** ADVISORY_LEVEL_TEXT[level]. */
  levelText: string;
  /** The advisory's opening sentence as plain text: "Exercise increased caution in Costa Rica due to crime." */
  summary: string | null;
  /** The day the Department last issued it. */
  publishedOn: LocalDate | null;
  /** The Department's page. Always link to it: one level can hide stricter advice for some regions. */
  url: string;
};

export type TravelAdvisorySignal =
  | {
      status: "published";
      countryCode: string;
      /** The advisory for the country. Where the Department splits a country into areas, the strictest one. */
      advisory: TravelAdvisory;
      /** The other areas under the same country code (Gaza and the West Bank; Bonaire, Saba and Sint Eustatius). */
      otherAreas: TravelAdvisory[];
    }
  | {
      /**
       * The Department publishes no advisory for this country (the United States itself, its
       * territories, and a few dozen small places). Say "No advisory published", never "Level 1".
       */
      status: "none";
      countryCode: string;
      /** Where a person can look for themselves. */
      url: string;
    };

// --- news ------------------------------------------------------------------------------------

/** "general": a news publisher. "travel": a travel-trade publisher. "official": a government notice feed. */
export type NewsSourceKind = "general" | "travel" | "official";

/** One headline. Nothing else from the story is kept or shown: the link goes to the publisher. */
export type NewsItem = {
  headline: string;
  /** Who published it: "BBC News". Always show it beside the headline. */
  publisher: string;
  /** The story on the publisher's own site. */
  link: string;
  /** When it was published (an instant), when the feed says. */
  publishedAt: string | null;
  /** Which entry of NEWS_SOURCES it came from. */
  sourceId: string;
  kind: NewsSourceKind;
};

export type NewsSignal = {
  /** Newest first, without repeats. Headlines with no date come last. */
  items: NewsItem[];
  /** How each source that was asked did. `items` only holds headlines from the ones that are ok. */
  sources: { id: string; name: string; ok: boolean; fetchedAt: Date | null; stale: boolean }[];
};

// --- small shared wording --------------------------------------------------------------------

/** "45 minutes", "1 hour", "1 hour 38 minutes". */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  const hourText = hours === 0 ? "" : hours === 1 ? "1 hour" : `${hours} hours`;
  const minuteText = rest === 0 ? "" : rest === 1 ? "1 minute" : `${rest} minutes`;
  if (hours === 0) return rest === 1 ? "1 minute" : `${rest} minutes`;
  return minuteText ? `${hourText} ${minuteText}` : hourText;
}

/** "16–30 minutes", "1 hour 1 minute – 1 hour 15 minutes", or one figure when both ends match. */
export function formatMinuteRange(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  const low = min ?? max ?? 0;
  const high = max ?? min ?? 0;
  if (low === high) return formatMinutes(low);
  if (low < 60 && high < 60) return `${Math.round(low)}${EN_DASH}${Math.round(high)} minutes`;
  return `${formatMinutes(low)} ${EN_DASH} ${formatMinutes(high)}`;
}
