// The live-data sources. Server only. Import from "@/lib/intel/providers".
//
// Every function here:
//  - returns a SourceResult (see ../signals): `{ ok: true, data, fetchedAt, stale }` or
//    `{ ok: false, reason, detail, lastGoodAt }`, and never throws;
//  - reads through the shared signal cache, so one copy of each feed serves everyone and a
//    source that is down falls back to its last good answer, marked `stale`;
//  - takes `now` in its options (pass the request's time; tests pass a fixed date).
//
// What each answers:
//   getForecast(place, { units })                 daily weather, today and 15 days on
//   getCurrentConditions(place, { units })        the sky right now, for a clock
//   getTypicalWeather(place, range, { units })    usual weather for dates beyond the forecast
//   getAirportStatus(airports)                    FAA delays and closures, US airports
//   getWeatherAlerts(place)                       official warnings, US places
//   getPublicHolidays(country, year)              holidays and long weekends
//   getPublicHolidaysBetween(country, from, to)   the same for a date range
//   getTravelAdvisory(country)                    State Department level and summary
//   getNews()                                     headlines; then pickRelevantNews(items, query)
//
// Credits and the list of news sources are in ../sources.

export { FORECAST_DAYS, forecastCoverage, forecastHorizon, getCurrentConditions, getForecast, type WeatherOptions } from "./forecast";
export { getTypicalWeather, TYPICAL_MAX_DAYS, TYPICAL_MIN_YEARS, TYPICAL_YEARS, type TypicalWeatherOptions } from "./typical-weather";
export { getAirportStatus, type AirportQuery } from "./airport-status";
export { getWeatherAlerts, isCoveredByNws } from "./weather-alerts";
export { getPublicHolidays, getPublicHolidaysBetween, type HolidayOptions } from "./holidays";
export { computeLongWeekends, observedDate } from "./long-weekends";
export { getTravelAdvisory } from "./advisories";
export { getNews, type NewsOptions } from "./news";
export { DEFAULT_NEWS_TOPICS, pickRelevantNews, type NewsQuery, type RelevantNewsItem } from "./news-relevance";
export type { SourceOptions } from "./shared";
