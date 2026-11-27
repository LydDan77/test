import { describe, expect, it } from "vitest";
import { fixture } from "./providers/test-support";
import {
  ADVISORY_LEVEL_TEXT,
  airportStatusOf,
  celsiusToFahrenheit,
  dailyForecastInImperial,
  describeWeatherCode,
  fahrenheitToCelsius,
  formatMinuteRange,
  formatMinutes,
  KNOWN_WEATHER_CODES,
  UNIT_LABELS,
  type AirportStatusSignal,
  type DailyForecast,
  type SourceResult,
} from "./signals";

describe("describeWeatherCode", () => {
  it("has plain words for every code the forecast service documents", () => {
    // Open-Meteo's own table, as given in the research notes (and saved from its docs source).
    const official = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];
    expect([...KNOWN_WEATHER_CODES]).toEqual(official);
    for (const code of official) {
      const condition = describeWeatherCode(code);
      expect(condition.code).toBe(code);
      expect(condition.sky, String(code)).not.toBe("unknown");
      expect(condition.label, String(code)).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/); // sentence case, plain words
      expect(condition.label.length).toBeLessThanOrEqual(30);
    }
  });

  it("covers every code in the real forecast capture", () => {
    const capture = JSON.parse(fixture("open-meteo-forecast.json")) as { daily: { weather_code: number[] }; hourly: { weather_code: number[] }; current: { weather_code: number } };
    const seen = new Set([...capture.daily.weather_code, ...capture.hourly.weather_code, capture.current.weather_code]);
    for (const code of seen) expect(describeWeatherCode(code).sky, String(code)).not.toBe("unknown");
  });

  it("uses everyday words, not the service's technical ones", () => {
    expect(describeWeatherCode(0)).toEqual({ code: 0, label: "Clear", sky: "clear" });
    expect(describeWeatherCode(3).label).toBe("Cloudy");
    expect(describeWeatherCode(48).label).toBe("Freezing fog"); // officially "Depositing rime fog"
    expect(describeWeatherCode(61).label).toBe("Light rain"); // officially "Slight rain"
    expect(describeWeatherCode(82).label).toBe("Heavy showers"); // officially "Violent rain showers"
    expect(describeWeatherCode(77).label).toBe("Fine snow"); // officially "Snow grains"
    const labels = KNOWN_WEATHER_CODES.map((code) => describeWeatherCode(code).label).join(" ");
    expect(labels).not.toMatch(/rime|depositing|slight|violent|grains|overcast|!/i);
  });

  it("groups the codes by sky", () => {
    expect([95, 96, 97, 99].map((code) => describeWeatherCode(code).sky)).toEqual(["thunderstorm", "thunderstorm", "thunderstorm", "thunderstorm"]);
    expect([71, 73, 75, 77, 85, 86].every((code) => describeWeatherCode(code).sky === "snow")).toBe(true);
    expect([56, 57, 66, 67].every((code) => describeWeatherCode(code).sky === "freezing_rain")).toBe(true);
    expect(describeWeatherCode(2).sky).toBe("partly_cloudy");
    expect(describeWeatherCode(45).sky).toBe("fog");
  });

  it("gives a neutral answer for a code it does not know, instead of throwing", () => {
    for (const code of [4, 42, 100, -1, 1.5, Number.NaN]) {
      expect(describeWeatherCode(code)).toEqual({ code, label: "Unknown", sky: "unknown" });
    }
  });
});

describe("units", () => {
  it("labels both systems", () => {
    expect(UNIT_LABELS.imperial).toEqual({ temperature: "°F", rain: "in", snow: "in", wind: "mph" });
    expect(UNIT_LABELS.metric).toEqual({ temperature: "°C", rain: "mm", snow: "cm", wind: "km/h" });
  });

  it("converts temperatures both ways", () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
    expect(fahrenheitToCelsius(32)).toBe(0);
    expect(fahrenheitToCelsius(95)).toBe(35);
  });

  const day: DailyForecast = {
    date: "2026-12-19",
    condition: describeWeatherCode(73),
    high: 35,
    low: -5,
    precipitationChance: 80,
    precipitation: 25.4,
    snowfall: 10.16,
    windGust: 80.4672,
  };

  it("puts a metric day into imperial for the rule thresholds", () => {
    expect(dailyForecastInImperial(day, "metric")).toEqual({
      date: "2026-12-19",
      condition: day.condition,
      high: 95,
      low: 23,
      precipitationChance: 80,
      precipitation: 1,
      snowfall: 4,
      windGust: 50,
    });
  });

  it("leaves an imperial day untouched and keeps gaps as gaps", () => {
    expect(dailyForecastInImperial(day, "imperial")).toBe(day);
    const gaps = dailyForecastInImperial({ ...day, high: null, low: null, precipitation: null, snowfall: null, windGust: null }, "metric");
    expect(gaps).toMatchObject({ high: null, low: null, precipitation: null, snowfall: null, windGust: null });
  });
});

describe("airportStatusOf", () => {
  const good: SourceResult<AirportStatusSignal> = {
    ok: true,
    fetchedAt: new Date("2026-11-26T00:08:00Z"),
    stale: false,
    data: { feedUpdatedAt: null, airports: [{ state: "no_delays", airport: "ORD" }, { state: "unavailable", airport: "CDG", why: "not_covered" }] },
  };

  it("returns the airport's own status", () => {
    expect(airportStatusOf(good, "ORD")).toEqual({ state: "no_delays", airport: "ORD" });
    expect(airportStatusOf(good, " ord ")).toEqual({ state: "no_delays", airport: "ORD" });
    expect(airportStatusOf(good, "CDG")).toEqual({ state: "unavailable", airport: "CDG", why: "not_covered" });
  });

  it("is 'unavailable' for a failed result or an airport that was not asked about, never 'no delays'", () => {
    const failed: SourceResult<AirportStatusSignal> = { ok: false, reason: "unavailable", detail: "down", lastGoodAt: null };
    expect(airportStatusOf(failed, "ORD")).toEqual({ state: "unavailable", airport: "ORD", why: "source_down" });
    expect(airportStatusOf(good, "MCO")).toEqual({ state: "unavailable", airport: "MCO", why: "source_down" });
  });
});

describe("wording helpers", () => {
  it("writes minutes the way people say them", () => {
    expect(formatMinutes(0)).toBe("0 minutes");
    expect(formatMinutes(1)).toBe("1 minute");
    expect(formatMinutes(45)).toBe("45 minutes");
    expect(formatMinutes(60)).toBe("1 hour");
    expect(formatMinutes(61)).toBe("1 hour 1 minute");
    expect(formatMinutes(98)).toBe("1 hour 38 minutes");
    expect(formatMinutes(120)).toBe("2 hours");
    expect(formatMinutes(324)).toBe("5 hours 24 minutes");
    expect(formatMinutes(29.6)).toBe("30 minutes");
    expect(formatMinutes(-5)).toBe("0 minutes");
  });

  it("writes ranges with an en dash, never a hyphen", () => {
    expect(formatMinuteRange(16, 30)).toBe("16–30 minutes");
    expect(formatMinuteRange(61, 75)).toBe("1 hour 1 minute – 1 hour 15 minutes");
    expect(formatMinuteRange(45, 75)).toBe("45 minutes – 1 hour 15 minutes");
    expect(formatMinuteRange(30, 30)).toBe("30 minutes");
    expect(formatMinuteRange(null, 45)).toBe("45 minutes");
    expect(formatMinuteRange(20, null)).toBe("20 minutes");
    expect(formatMinuteRange(null, null)).toBeNull();
    expect(formatMinuteRange(16, 30)).not.toContain("-");
  });

  it("has the State Department's four levels in sentence case", () => {
    expect(ADVISORY_LEVEL_TEXT).toEqual({ 1: "Exercise normal precautions", 2: "Exercise increased caution", 3: "Reconsider travel", 4: "Do not travel" });
  });
});
