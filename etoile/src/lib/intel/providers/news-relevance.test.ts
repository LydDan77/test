import { describe, expect, it } from "vitest";
import type { NewsItem, NewsSourceKind } from "../signals";
import { readFeed } from "./feed";
import { DEFAULT_NEWS_TOPICS, mentions, pickRelevantNews } from "./news-relevance";
import { fixture } from "./test-support";
import { parseXml } from "./xml";

// The real headlines of 2026-11-27 from the four captured feeds, as getNews() would return them.
function realItems(name: string, publisher: string, kind: NewsSourceKind): NewsItem[] {
  return readFeed(parseXml(fixture(name))).map((entry) => ({ headline: entry.title, publisher, link: entry.link, publishedAt: entry.publishedAt, sourceId: name.replace(".xml", ""), kind }));
}
const REAL: NewsItem[] = [
  ...realItems("npr-top.xml", "NPR", "general"),
  ...realItems("bbc-news.xml", "BBC News", "general"),
  ...realItems("skift.xml", "Skift", "travel"),
  ...realItems("cdc-notices.xml", "CDC Travelers' Health", "official"),
];
const NOW = new Date("2026-11-27T22:00:00Z");

const item = (headline: string, publishedAt: string | null = "2026-11-27T12:00:00.000Z", kind: NewsSourceKind = "general"): NewsItem => ({
  headline, publisher: "Example", link: `https://example.org/${encodeURIComponent(headline)}`, publishedAt, sourceId: "example", kind,
});
const headlines = (items: NewsItem[]) => items.map((entry) => entry.headline);

describe("pickRelevantNews, on the real headlines", () => {
  it("finds the airline story for a traveller booked on that airline", () => {
    const picked = pickRelevantNews(REAL, { airlines: ["Norse Atlantic Airways"], limit: 5 });
    expect(headlines(picked)).toEqual([
      "Norse Atlantic Suspends Flights as Bankruptcy Looms",
      "Norse Atlantic Collapses as Norwegian Arm Files for Bankruptcy",
    ]);
    expect(picked[0]).toMatchObject({ publisher: "Skift", matchedPlaces: ["Norse Atlantic Airways"], matchedTopics: ["flight", "suspend", "bankrupt"] });
    expect(picked[1].matchedTopics).toEqual(["bankrupt", "collapse"]);
  });

  it("finds the storm for someone heading to the East Coast", () => {
    const picked = pickRelevantNews(REAL, { places: ["East Coast", "Boston"], limit: 3 });
    expect(headlines(picked)).toEqual(["Thanksgiving storm batters East Coast. And, Black Friday sales to hit record levels"]);
    expect(picked[0]).toMatchObject({ matchedPlaces: ["East Coast"], matchedTopics: ["storm"] });
  });

  it("finds an official health notice from the country code alone", () => {
    const picked = pickRelevantNews(REAL, { countryCodes: ["HN"], limit: 3 });
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ headline: "Level 2 - Chikungunya in Honduras", kind: "official", matchedPlaces: ["Honduras"], matchedTopics: [] });
    // Costa Rica has two notices; both are found, by name or by code.
    expect(headlines(pickRelevantNews(REAL, { places: ["Costa Rica"], limit: 5 })).sort()).toEqual(["Level 1 - Hepatitis A in Costa Rica", "Level 2 - Chikungunya in Costa Rica"]);
    expect(pickRelevantNews(REAL, { countryCodes: ["cr"], limit: 5 })).toHaveLength(2);
  });

  it("leaves out a story that names the place but is not about travel going wrong", () => {
    // "Heathrow’s Third Runway Has a $25 Billion Problem Before It Gets to Emissions": a feature.
    expect(pickRelevantNews(REAL, { airports: ["Heathrow", "LHR"], limit: 5 })).toEqual([]);
    const either = pickRelevantNews(REAL, { airports: ["Heathrow", "LHR"], limit: 50, match: "place_or_topic" });
    expect(headlines(either)[0]).toBe("Heathrow’s Third Runway Has a $25 Billion Problem Before It Gets to Emissions");
    expect(either.length).toBeGreaterThan(1); // plus every headline with a topic word
  });

  it("finds a destination story that is about airlines", () => {
    expect(headlines(pickRelevantNews(REAL, { places: ["Dubai"], limit: 3 }))).toEqual(["Dubai Gets Some Airlines Back as Riyadh Waits on Houthis"]);
  });

  it("returns nothing for a plan none of today's headlines touch", () => {
    expect(pickRelevantNews(REAL, { places: ["Orlando", "Lake Geneva"], airports: ["MCO", "ORD"], airlines: ["Delta Air Lines"], countryCodes: ["US"], limit: 5 })).toEqual([]);
  });

  it("never returns more than asked for", () => {
    const everything = { places: ["Costa Rica", "Honduras", "Panama", "Mexico", "Canada", "Kenya", "Colombia"], match: "place_or_topic" as const };
    const all = pickRelevantNews(REAL, { ...everything, limit: 1000 });
    expect(all.length).toBeGreaterThan(8);
    for (const limit of [1, 2, 3, 5]) expect(pickRelevantNews(REAL, { ...everything, limit })).toEqual(all.slice(0, limit));
    for (const limit of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) expect(pickRelevantNews(REAL, { ...everything, limit })).toEqual([]);
    expect(pickRelevantNews(REAL, { ...everything, limit: 2.9 })).toHaveLength(2);
    expect(pickRelevantNews(REAL, { ...everything, limit: Number.POSITIVE_INFINITY })).toEqual([]);
  });

  it("can leave out old headlines", () => {
    const anyAge = pickRelevantNews(REAL, { places: ["Costa Rica", "Mexico", "Canada"], limit: 10 });
    expect(anyAge.length).toBeGreaterThanOrEqual(4);
    const lastWeek = pickRelevantNews(REAL, { places: ["Costa Rica", "Mexico", "Canada", "Honduras"], limit: 10, maxAgeHours: 24 * 7, now: NOW });
    expect(headlines(lastWeek)).toEqual(["Level 2 - Chikungunya in Honduras"]); // published two days before
    expect(pickRelevantNews(REAL, { places: ["Honduras"], limit: 10, maxAgeHours: 24, now: NOW })).toEqual([]);
  });
});

describe("pickRelevantNews, matching rules", () => {
  it("needs both the place and a topic for a publisher's story, and only the place for an official notice", () => {
    const items = [
      item("Lisbon airport strike grounds hundreds of flights"),
      item("Ten things to eat in Lisbon"),
      item("Rail strike spreads across the north"),
      item("Health notice for travellers to Lisbon", "2026-11-27T12:00:00.000Z", "official"),
    ];
    expect(headlines(pickRelevantNews(items, { places: ["Lisbon"], limit: 10 }))).toEqual([
      "Lisbon airport strike grounds hundreds of flights",
      "Health notice for travellers to Lisbon",
    ]);
    expect(pickRelevantNews(items, { places: ["Lisbon"], limit: 10, match: "place_or_topic" })).toHaveLength(4);
  });

  it("matches topic words by their beginning", () => {
    const hit = (headline: string) => pickRelevantNews([item(headline)], { places: ["Denver"], limit: 1 })[0]?.matchedTopics ?? null;
    expect(hit("Denver flights cancelled as blizzard closes runways")).toEqual(["flight", "blizzard", "cancel"]);
    expect(hit("Flooding shuts Denver station")).toEqual(["flood", "shut"]);
    expect(hit("Denver airport evacuated after outage")).toEqual(["airport", "outage", "evacuat"]);
    expect(hit("Travellers face delays in Denver")).toEqual(["travel", "delay"]);
    expect(hit("Denver restaurant wins award")).toBeNull();
    expect(hit("Denver unveils airportless future")).toEqual(["airport"]);
    expect(hit("Why Denver is misunderstood")).toBeNull(); // "storm" inside a word does not count: nothing here starts with a topic
  });

  it("uses the caller's topics when given", () => {
    const items = [item("Vail lifts open early"), item("Vail road closure tonight")];
    expect(headlines(pickRelevantNews(items, { places: ["Vail"], topics: ["lift", "open"], limit: 5 }))).toEqual(["Vail lifts open early"]);
    expect(pickRelevantNews(items, { places: ["Vail"], topics: [], limit: 5 })).toEqual([]);
  });

  it("does not mistake an ordinary word for a place or an airport code", () => {
    expect(mentions("A nice surprise for rail travellers", "Nice")).toBe(false);
    expect(mentions("Storm closes Nice airport", "Nice")).toBe(true);
    expect(mentions("Storm warning for San Diego", "SAN")).toBe(false);
    expect(mentions("Delays at SAN after runway closure", "SAN")).toBe(true);
    expect(mentions("The Seattle strike is over", "SEA")).toBe(false);
    expect(mentions("Parisian cafes reopen", "Paris")).toBe(false);
    expect(mentions("Paris: metro strike enters day three", "Paris")).toBe(true);
    expect(mentions("PARIS AIRPORTS CLOSED", "Paris")).toBe(false); // single words are matched as written
    expect(mentions("Flights to New York cancelled", "new york")).toBe(true); // phrases ignore case
    expect(mentions("Anything", "")).toBe(false);
    expect(mentions("A B C", "A")).toBe(false); // too short to be meaningful
  });

  it("ignores accents and curly quotes on both sides", () => {
    expect(mentions("Level 2 - Yellow Fever in Burkina Faso, Côte d’Ivoire, and Ghana", "Cote d'Ivoire")).toBe(true);
    expect(mentions("Strike at Sao Paulo airport", "São Paulo")).toBe(true);
    expect(mentions("Heathrow’s third runway", "Heathrow")).toBe(true);
    expect(mentions("Chaos at O’Hare as storm hits", "O'Hare")).toBe(true);
    expect(mentions("Zürich flights delayed", "Zurich")).toBe(true);
  });

  it("matches an airline by its full name, or by its everyday name beside a word about flying", () => {
    const pick = (headline: string, airline: string) => pickRelevantNews([item(headline)], { airlines: [airline], limit: 1 }).length === 1;
    expect(pick("Delta Air Lines cancels 300 flights", "Delta Air Lines")).toBe(true);
    expect(pick("Delta cancels 300 flights after outage", "Delta Air Lines")).toBe(true);
    expect(pick("United pilots vote to strike", "United Airlines")).toBe(true);
    expect(pick("Manchester United strike late to win", "United Airlines")).toBe(false);
    expect(pick("Flooding closes roads across the delta", "Delta Air Lines")).toBe(false);
    expect(pick("JetBlue grounded by outage, flights delayed", "JetBlue")).toBe(true);
    expect(pick("British Airways strike dates announced", "British Airways")).toBe(true);
    expect(pick("British rail strike dates announced", "British Airways")).toBe(false);
    expect(pick("Air France suspends Paris flights", "Air France")).toBe(true);
  });

  it("puts headlines that name more of the plan first, then more topics, then the newest", () => {
    const items = [
      item("Storm delays flights", "2026-11-27T20:00:00.000Z"),
      item("Orlando storm warning", "2026-11-27T08:00:00.000Z"),
      item("Orlando storm delays flights at MCO", "2026-11-26T08:00:00.000Z"),
      item("Orlando flights delayed by storm", "2026-11-27T09:00:00.000Z"),
      item("Orlando storm warning extended", "2026-11-27T10:00:00.000Z"),
      item("Undated Orlando storm story", null),
    ];
    const picked = pickRelevantNews(items, { places: ["Orlando"], airports: ["MCO"], limit: 10 });
    expect(headlines(picked)).toEqual([
      "Orlando storm delays flights at MCO", // two plan words
      "Orlando flights delayed by storm", // one plan word, three topics
      "Orlando storm warning extended", // one topic, newest
      "Orlando storm warning",
      "Undated Orlando storm story",
    ]);
    expect(picked[0].matchedPlaces).toEqual(["Orlando", "MCO"]);
  });

  it("reports each matched word once and leaves the input alone", () => {
    const items = [item("Orlando, Orlando: storm after storm")];
    const frozen = JSON.stringify(items);
    const [picked] = pickRelevantNews(items, { places: ["Orlando", "Orlando"], limit: 1 });
    expect(picked.matchedPlaces).toEqual(["Orlando"]);
    expect(picked.matchedTopics).toEqual(["storm"]);
    expect(JSON.stringify(items)).toBe(frozen);
  });

  it("drops undated headlines when an age limit is set, and ignores the limit without a time to measure from", () => {
    const items = [item("Orlando storm", null), item("Orlando flood", "2026-11-20T00:00:00.000Z")];
    expect(pickRelevantNews(items, { places: ["Orlando"], limit: 5, maxAgeHours: 48, now: NOW })).toEqual([]);
    expect(pickRelevantNews(items, { places: ["Orlando"], limit: 5, maxAgeHours: 48 })).toHaveLength(2);
  });

  it("handles an empty list, an empty query and odd country codes", () => {
    expect(pickRelevantNews([], { places: ["Orlando"], limit: 5 })).toEqual([]);
    expect(pickRelevantNews(REAL, { limit: 5 })).toEqual([]);
    expect(pickRelevantNews(REAL, { countryCodes: ["", "ZZZ", "12", "QQ"], limit: 5 })).toEqual([]);
  });

  it("has a sensible default topic list", () => {
    for (const word of ["travel", "flight", "storm", "strike", "closure", "outage", "evacuat", "wildfire", "hurricane", "typhoon", "flood", "earthquake", "eruption", "grounded", "cancel"]) {
      expect(DEFAULT_NEWS_TOPICS, word).toContain(word);
    }
    expect(new Set(DEFAULT_NEWS_TOPICS).size).toBe(DEFAULT_NEWS_TOPICS.length);
  });
});
