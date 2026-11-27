import { describe, expect, it } from "vitest";
import { isForbiddenFeed } from "./providers/news";
import { DATA_SOURCES, defaultNewsSources, NEWS_SOURCES, newsSourceById } from "./sources";

describe("the news source table", () => {
  it("lists exactly the four agreed sources", () => {
    expect(NEWS_SOURCES.map((source) => [source.id, source.name, source.feedUrl, source.kind])).toEqual([
      ["npr-top", "NPR", "https://feeds.npr.org/1001/rss.xml", "general"],
      ["bbc-news", "BBC News", "https://feeds.bbci.co.uk/news/rss.xml", "general"],
      ["skift", "Skift", "https://skift.com/feed/", "travel"],
      ["cdc-travel-notices", "CDC Travelers' Health", "https://wwwnc.cdc.gov/travel/rss/notices.xml", "official"],
    ]);
  });

  it("has unique ids, secure addresses and a sane refresh time for each", () => {
    expect(new Set(NEWS_SOURCES.map((source) => source.id)).size).toBe(NEWS_SOURCES.length);
    for (const source of NEWS_SOURCES) {
      expect(source.id).toMatch(/^[a-z0-9-]+$/);
      expect(new URL(source.feedUrl).protocol).toBe("https:");
      expect(new URL(source.homepage).protocol).toBe("https:");
      expect(source.refreshMinutes).toBeGreaterThanOrEqual(30);
      expect(source.refreshMinutes).toBeLessThanOrEqual(360);
      expect(source.name.trim()).toBe(source.name);
      expect(source.termsNote.length).toBeGreaterThan(10);
    }
  });

  it("does not contain the Guardian or Google News", () => {
    for (const source of NEWS_SOURCES) {
      expect(isForbiddenFeed(source.feedUrl), source.id).toBe(false);
      expect(`${source.name} ${source.feedUrl} ${source.homepage}`.toLowerCase()).not.toMatch(/guardian|google/);
    }
  });

  it("turns on everything except NPR, whose feed says it is for personal use only", () => {
    expect(defaultNewsSources().map((source) => source.id)).toEqual(["bbc-news", "skift", "cdc-travel-notices"]);
    expect(newsSourceById("npr-top")).toMatchObject({ onByDefault: false });
    expect(newsSourceById("npr-top")?.termsNote).toContain("For Personal Use Only");
  });

  it("finds a source by id, and nothing for an unknown id", () => {
    expect(newsSourceById("skift")?.name).toBe("Skift");
    expect(newsSourceById("the-guardian")).toBeUndefined();
    expect(newsSourceById("")).toBeUndefined();
  });
});

describe("credits for the data sources", () => {
  it("names every provider, with a link", () => {
    expect(Object.keys(DATA_SOURCES).sort()).toEqual(["advisories", "airportStatus", "forecast", "holidays", "typicalWeather", "weatherAlerts"]);
    for (const source of Object.values(DATA_SOURCES)) {
      expect(source.name.length).toBeGreaterThan(1);
      expect(new URL(source.url).protocol).toBe("https:");
      expect(source.covers).not.toMatch(/!/);
    }
  });

  it("carries the one credit line a licence requires", () => {
    expect(DATA_SOURCES.forecast).toMatchObject({ requiredCredit: "Weather data by Open-Meteo.com", url: "https://open-meteo.com/" });
    expect(DATA_SOURCES.typicalWeather.requiredCredit).toBe("Weather data by Open-Meteo.com");
    expect(DATA_SOURCES.airportStatus.requiredCredit).toBeNull();
    expect(DATA_SOURCES.airportStatus.name).toBe("FAA");
  });
});
