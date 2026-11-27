// Choosing the few headlines that matter to a plan. Pure: plain data in, plain data out.
//
// The rule of thumb (product spec, news rules): a headline is worth showing when it names
// something in the plan (the destination, one of its airports, an airline with a booked flight)
// AND is about travel going wrong or changing. A story that only mentions the destination is a
// news feed, not a heads-up. Official notices are the exception: they are about travel by
// definition, so naming the place is enough.

import type { NewsItem } from "../signals";

/**
 * Words that mark a headline as being about travel or a disruption to it. Each is matched as
 * the start of a word, so "cancel" also finds "cancels" and "cancellations", and "flood" finds
 * "flooding".
 */
export const DEFAULT_NEWS_TOPICS: readonly string[] = [
  "travel", "flight", "airline", "airport", "airspace", "passenger", "tourist", "border", "visa", "passport",
  "storm", "thunderstorm", "hurricane", "typhoon", "cyclone", "tornado", "blizzard", "snow", "heatwave", "flood",
  "wildfire", "earthquake", "eruption", "volcan", "tsunami", "landslide",
  "strike", "walkout", "closure", "closed", "shut", "outage", "evacuat", "grounded", "cancel", "delay",
  "disrupt", "suspend", "suspension", "bankrupt", "collapse", "outbreak", "curfew", "unrest", "protest",
];

/** Words that say a headline is about flying, needed before a one-word airline name counts. */
const AVIATION_WORDS = ["flight", "airline", "airport", "plane", "jet", "pilot", "crew", "passenger", "grounded", "runway", "airways", "aviation"];

export type NewsQuery = {
  /** Destination and stop names as written for people: "Orlando", "Costa Rica", "Lake Geneva". */
  places?: readonly string[];
  /** Airport codes and names: "MCO", "O'Hare", "Heathrow". */
  airports?: readonly string[];
  /** Airline names: "Delta Air Lines", "JetBlue". The everyday short form ("Delta") is matched too. */
  airlines?: readonly string[];
  /** ISO 3166-1 alpha-2 codes of the countries in the plan; their English names are matched ("HN" finds "Honduras"). */
  countryCodes?: readonly string[];
  /** Topic words to use instead of DEFAULT_NEWS_TOPICS. */
  topics?: readonly string[];
  /** The most items to return. The result is never longer; zero or less gives none. */
  limit: number;
  /**
   * "place_and_topic" (default): a headline must name something in the plan and carry a topic
   * word, except official notices, which only need to name the place.
   * "place_or_topic": either is enough; headlines with both come first.
   */
  match?: "place_and_topic" | "place_or_topic";
  /** Leave out headlines older than this many hours (and undated ones). Needs `now`. */
  maxAgeHours?: number;
  now?: Date;
};

/** A headline that was picked, with what it matched (as given in the query). */
export type RelevantNewsItem = NewsItem & { matchedPlaces: string[]; matchedTopics: string[] };

/** Lower-level text for matching: accents removed, curly quotes straightened. Case is kept. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `headline` contains `term` as a whole word or phrase. A single word is matched with
 * its capital letters as given, so the city "Nice" is not found in "a nice surprise" and the
 * airport code "SAN" is not found in "San Diego"; a phrase of several words ignores case.
 */
export function mentions(headline: string, term: string): boolean {
  const needle = fold(term);
  if (needle.length < 2) return false;
  const flags = needle.includes(" ") ? "iu" : "u";
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, flags).test(fold(headline));
}

/** Whether `headline` has a word that starts with `stem`, ignoring case. */
function hasWordStarting(headline: string, stem: string): boolean {
  const needle = fold(stem);
  if (needle.length < 3) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}`, "iu").test(fold(headline));
}

/** "Delta Air Lines" gives "Delta"; "Norse Atlantic Airways" gives "Norse Atlantic". */
function airlineShortName(name: string): string {
  return name.replace(/\s+(air\s?lines?|airways|air)\s*$/i, "").trim();
}

/**
 * Whether `headline` is about an airline. The full name counts on its own ("British Airways").
 * The everyday short name counts too, but a one-word name ("Delta", "United", "Frontier") is an
 * ordinary word as well, so it only counts beside a word about flying.
 */
function mentionsAirline(headline: string, airline: string): boolean {
  const full = airline.trim();
  if (full.includes(" ") && mentions(headline, full)) return true;
  const short = airlineShortName(full) || full;
  if (!mentions(headline, short)) return false;
  return short.includes(" ") || AVIATION_WORDS.some((word) => hasWordStarting(headline, word));
}

function countryNames(codes: readonly string[]): { code: string; name: string }[] {
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return [];
  }
  const names: { code: string; name: string }[] = [];
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    try {
      const name = display.of(code);
      if (name && name !== code) names.push({ code, name });
    } catch {
      // Not a region the runtime knows.
    }
  }
  return names;
}

/**
 * The headlines that matter to a plan, best match first, and never more than `limit`.
 *
 *   const items = pickRelevantNews(news.data.items, {
 *     places: ["Orlando"], airports: ["MCO"], airlines: ["Delta Air Lines"], countryCodes: ["US"],
 *     limit: 3, maxAgeHours: 48, now,
 *   });
 *
 * Order: headlines naming more of the plan first, then those with more topic words, then the
 * newest. Each result says what it matched, so a rule can say why it is showing.
 */
export function pickRelevantNews(items: readonly NewsItem[], query: NewsQuery): RelevantNewsItem[] {
  const limit = Number.isFinite(query.limit) ? Math.floor(query.limit) : 0;
  if (limit <= 0) return [];

  const topics = query.topics ?? DEFAULT_NEWS_TOPICS;
  const mode = query.match ?? "place_and_topic";
  const countries = countryNames(query.countryCodes ?? []);
  const oldest = query.maxAgeHours !== undefined && query.now ? query.now.getTime() - query.maxAgeHours * 3_600_000 : null;

  const picked: { item: RelevantNewsItem; time: number }[] = [];
  for (const item of items) {
    const time = item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN;
    if (oldest !== null && !(time >= oldest)) continue;

    const matchedPlaces = [
      ...(query.places ?? []).filter((place) => mentions(item.headline, place)),
      ...(query.airports ?? []).filter((airport) => mentions(item.headline, airport)),
      ...(query.airlines ?? []).filter((airline) => mentionsAirline(item.headline, airline)),
      ...countries.filter((country) => mentions(item.headline, country.name)).map((country) => country.name),
    ];
    const matchedTopics = topics.filter((topic) => hasWordStarting(item.headline, topic));

    const namesPlan = matchedPlaces.length > 0;
    const onTopic = matchedTopics.length > 0 || item.kind === "official";
    const relevant = mode === "place_or_topic" ? namesPlan || matchedTopics.length > 0 : namesPlan && onTopic;
    if (!relevant) continue;
    picked.push({
      item: { ...item, matchedPlaces: [...new Set(matchedPlaces)], matchedTopics: [...matchedTopics] },
      time: Number.isFinite(time) ? time : 0,
    });
  }

  return picked
    .sort((a, b) => b.item.matchedPlaces.length - a.item.matchedPlaces.length || b.item.matchedTopics.length - a.item.matchedTopics.length || b.time - a.time)
    .slice(0, limit)
    .map((entry) => entry.item);
}
