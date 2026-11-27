// Where live data comes from: the news feeds the app may read, and how to credit every source.
// Pure data: safe to import anywhere, including a settings screen.

import type { NewsSourceKind } from "./signals";

export type NewsSource = {
  /** Stable id: stored with a person's choices, used in cache keys. Never rename one. */
  id: string;
  /** The publisher as people see it beside a headline: "BBC News". */
  name: string;
  /** The RSS or Atom feed the server reads. */
  feedUrl: string;
  kind: NewsSourceKind;
  /** Whether the source is read unless someone turns it off. */
  onByDefault: boolean;
  /** The publisher's own site, for a "from …" link. */
  homepage: string;
  /** How often the feed is read again, in minutes. */
  refreshMinutes: number;
  /** What the publisher says about reuse, for whoever decides which sources are on. Not shown to people. */
  termsNote: string;
};

/**
 * The news sources. Only headline, publisher, link and time are ever taken from a feed, and the
 * link always goes to the publisher.
 *
 * The Guardian and Google News are deliberately absent and must not be added: both limit their
 * feeds to personal feed readers, and Google blocks servers outright.
 */
export const NEWS_SOURCES: readonly NewsSource[] = [
  {
    id: "npr-top",
    name: "NPR",
    feedUrl: "https://feeds.npr.org/1001/rss.xml",
    kind: "general",
    // Off until someone has read NPR's terms: the feed's own copyright line reads
    // "Copyright 2024 NPR - For Personal Use Only" (seen in the capture of 2026-11-27).
    onByDefault: false,
    homepage: "https://www.npr.org/",
    refreshMinutes: 30,
    termsNote: "The feed's copyright line says \"For Personal Use Only\". Confirm NPR's terms allow a hosted app to show its headlines before turning this on.",
  },
  {
    id: "bbc-news",
    name: "BBC News",
    feedUrl: "https://feeds.bbci.co.uk/news/rss.xml",
    kind: "general",
    onByDefault: true,
    homepage: "https://www.bbc.co.uk/news",
    refreshMinutes: 30,
    termsNote: "The feed points to https://www.bbc.co.uk/usingthebbc/terms-of-use/#15metadataandrssfeeds for the conditions of reuse. Headline and link only, credited to BBC News.",
  },
  {
    id: "skift",
    name: "Skift",
    feedUrl: "https://skift.com/feed/",
    kind: "travel",
    onByDefault: true,
    homepage: "https://skift.com/",
    refreshMinutes: 60,
    termsNote: "Standard WordPress feed with no reuse notice in it. Headline and link only, credited to Skift.",
  },
  {
    id: "cdc-travel-notices",
    name: "CDC Travelers' Health",
    feedUrl: "https://wwwnc.cdc.gov/travel/rss/notices.xml",
    kind: "official",
    onByDefault: true,
    homepage: "https://wwwnc.cdc.gov/travel/notices",
    refreshMinutes: 180,
    termsNote: "US government work. Credit the CDC.",
  },
];

/** The sources that are read when a person has not chosen otherwise. */
export function defaultNewsSources(): NewsSource[] {
  return NEWS_SOURCES.filter((source) => source.onByDefault);
}

/** The source with this id, or undefined. */
export function newsSourceById(id: string): NewsSource | undefined {
  return NEWS_SOURCES.find((source) => source.id === id);
}

export type DataSourceCredit = {
  /** Short name to put in parentheses after a fact: "(FAA)". */
  name: string;
  /** The source's full name. */
  fullName: string;
  /** Where a person can see the source for themselves. */
  url: string;
  /**
   * A line that must appear, as a link to `url`, wherever this source's data is shown.
   * Null when the source asks for no particular wording (a credit by name is still polite).
   */
  requiredCredit: string | null;
  /** What the source covers, in a few plain words. */
  covers: string;
};

/** How to credit each live-data source. Keyed by the provider it belongs to. */
export const DATA_SOURCES = {
  forecast: {
    name: "Open-Meteo",
    fullName: "Open-Meteo",
    url: "https://open-meteo.com/",
    // CC BY 4.0: "You must include a link next to any location Open-Meteo data are displayed."
    requiredCredit: "Weather data by Open-Meteo.com",
    covers: "Forecasts up to 16 days ahead, worldwide",
  },
  typicalWeather: {
    name: "Open-Meteo",
    fullName: "Open-Meteo historical weather",
    url: "https://open-meteo.com/",
    requiredCredit: "Weather data by Open-Meteo.com",
    covers: "Typical weather for a date, from recent past years, worldwide",
  },
  airportStatus: {
    name: "FAA",
    fullName: "Federal Aviation Administration",
    url: "https://nasstatus.faa.gov/",
    requiredCredit: null,
    covers: "Delays, ground stops and closures at US airports. Not individual flights",
  },
  weatherAlerts: {
    name: "NWS",
    fullName: "National Weather Service",
    url: "https://www.weather.gov/",
    requiredCredit: null,
    covers: "Official weather warnings, watches and advisories in the United States",
  },
  holidays: {
    name: "Nager.Date",
    fullName: "Nager.Date public holidays",
    url: "https://nagerholidays.com/",
    requiredCredit: null,
    covers: "Public holidays in about 200 countries",
  },
  advisories: {
    name: "State Department",
    fullName: "US Department of State",
    url: "https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html",
    requiredCredit: null,
    covers: "Travel advisories for countries other than the United States",
  },
} as const satisfies Record<string, DataSourceCredit>;

export type DataSourceId = keyof typeof DATA_SOURCES;
