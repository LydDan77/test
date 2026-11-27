import "server-only";

import { isLocalDate, type LocalDate } from "@/lib/time";
import { fetchXml, HttpError } from "../http";
import { ADVISORY_LEVEL_TEXT, type AdvisoryLevel, type SourceResult, type TravelAdvisory, type TravelAdvisorySignal } from "../signals";
import { DATA_SOURCES } from "../sources";
import { alpha3Of } from "./countries";
import { answer, failure, HOUR_MS, isCountryCode, MINUTE_MS, neverThrow, readThroughCache, type SourceOptions } from "./shared";
import { childText, childrenNamed, firstChild, plainText, type XmlElement } from "./xml";

// Travel advisories from the US Department of State (US government work: DATA_SOURCES.advisories).
//
// One feed lists every country (about 220 items, 0.6 MB). It is read at most every six hours,
// parsed once into a small table keyed by country, and every question after that is answered
// from the table.
//
// How an item is matched to a country: by the three-letter ISO code inside its link
// (…/travel-advisories/destination.prt.html). NOT by the feed's own "Country-Tag", which looks
// like a country code but is a different, older scheme: its "CH" is China, "AU" is Austria and
// "SP" is Spain.

const FEED_URL = "https://travel.state.gov/_res/rss/TAsTWs.xml";

/** Places the Department treats as home: there is never an advisory, and nothing is fetched. */
const HOME_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP", "UM"]);

/**
 * Country codes whose advisory items use link codes of the Department's own. Kosovo has no ISO
 * code; the Palestinian territories and the Caribbean Netherlands are each split into two areas.
 */
const LINK_CODES_BY_COUNTRY: Record<string, string[]> = {
  XK: ["xks"],
  PS: ["xgz", "xwb"],
  BQ: ["bes", "xqx"],
};

type StoredAdvisories = {
  /** When the Department built the feed (an instant), when it says. */
  feedPublishedAt: string | null;
  /** By the lower-case code in the item's link: "prt", "xgz". */
  byLinkCode: Record<string, TravelAdvisory>;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The feed's item dates are a date with no time ("Fri, 13 Mar 2026"). Read the parts
 * explicitly: handing such a string to the runtime's date parser gives a time in whatever zone
 * the server happens to be in.
 */
function dateOnly(value: string | null): LocalDate | null {
  const match = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(value ?? "");
  if (!match) return null;
  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month === -1) return null;
  const date = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return isLocalDate(date) ? date : null;
}

/**
 * The advisory's opening sentence as plain text. The description is HTML: the level phrase,
 * then a first paragraph naming the country and the reasons, then pages of detail that stay on
 * the Department's site.
 */
function summaryOf(description: string | null): string | null {
  if (!description) return null;
  const end = description.search(/<\/p\s*>/i);
  const lead = plainText(end === -1 ? description : description.slice(0, end)).replace(/\s+([.,;:])/g, "$1");
  if (lead === "" || /^summary not available$/i.test(lead)) return null;
  const capped = lead.length > 300 ? `${lead.slice(0, lead.lastIndexOf(" ", 297))}…` : lead;
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

/** The feed as a table of advisories. Exported for tests; use getTravelAdvisory(). */
export function advisoriesFromFeed(rss: XmlElement): StoredAdvisories {
  const channel = firstChild(rss, "channel");
  if (!channel) throw new HttpError("shape", "The advisory feed has no channel");

  const feedDate = Date.parse(childText(channel, "dc:date") ?? "");
  const byLinkCode: Record<string, TravelAdvisory> = {};
  for (const item of childrenNamed(channel, "item")) {
    const link = childText(item, "link");
    // Two leftover items with old-style links (a second Tonga, "French West Indies") repeat
    // countries that have a coded item of their own: without a code they cannot be matched.
    const code = /\/destination\.([a-z]{3})\.html/i.exec(link ?? "")?.[1]?.toLowerCase();
    if (!link || !code || byLinkCode[code]) continue;

    // "Mexico Travel Advisory - Level 2: Exercise Increased Caution"; some names end in a
    // non-breaking space.
    const title = (childText(item, "title") ?? "").replace(/[\s\u00a0]+/g, " ").trim();
    const fromTitle = /^(.*?)(?: Travel Advisory)? - Level ([1-4]): /.exec(title);
    const threat = childrenNamed(item, "category").find((category) => category.attributes.domain === "Threat-Level")?.text ?? "";
    const level = Number(fromTitle?.[2] ?? /Level ([1-4])/.exec(threat)?.[1]);
    if (level !== 1 && level !== 2 && level !== 3 && level !== 4) continue;
    const area = (fromTitle?.[1] ?? title.split(" - ")[0]).trim();
    if (!area) continue;

    byLinkCode[code] = {
      area,
      level: level as AdvisoryLevel,
      levelText: ADVISORY_LEVEL_TEXT[level as AdvisoryLevel],
      summary: summaryOf(childText(item, "description")),
      publishedOn: dateOnly(childText(item, "pubDate")),
      url: link,
    };
  }
  // An empty table would read as "no advisory for anywhere": treat it as a broken feed.
  if (Object.keys(byLinkCode).length === 0) throw new HttpError("shape", "The advisory feed has no advisories in it");
  return { feedPublishedAt: Number.isFinite(feedDate) ? new Date(feedDate).toISOString() : null, byLinkCode };
}

async function fetchAdvisories(): Promise<StoredAdvisories> {
  return advisoriesFromFeed(await fetchXml(FEED_URL, { root: "rss", timeoutMs: 15_000 }));
}

/**
 * The State Department's travel advisory for a country.
 *
 *   const result = await getTravelAdvisory(plan.destination.countryCode, { now });
 *   if (result.ok && result.data.status === "published") result.data.advisory.level;   // 1 to 4
 *
 * `countryCode` is ISO 3166-1 alpha-2 (PlaceRef.countryCode). `status: "none"` means the
 * Department publishes nothing for that country (the United States and its territories, and
 * about forty small places): say "No advisory published" with the link, never "Level 1".
 * Always link to `advisory.url`: a country-wide level can hide stricter advice for one region.
 *
 * The feed is read at most every six hours. If it cannot be read, the last table is still used
 * (`stale: true`, with `fetchedAt` to show): advisories change rarely.
 */
export async function getTravelAdvisory(countryCode: string, options: SourceOptions = {}): Promise<SourceResult<TravelAdvisorySignal>> {
  return neverThrow("travel advisories", async () => {
    const now = options.now ?? new Date();
    if (!isCountryCode(countryCode)) return failure("invalid_input", "The country code is not two letters");
    const country = countryCode.trim().toUpperCase();
    const none: TravelAdvisorySignal = { status: "none", countryCode: country, url: DATA_SOURCES.advisories.url };
    if (HOME_COUNTRIES.has(country)) return answer(none, now);

    const table = await readThroughCache("v1:state:advisories", 6 * HOUR_MS, fetchAdvisories, { now, retryAfterMs: 10 * MINUTE_MS });
    if (!table.ok) return table;

    const alpha3 = alpha3Of(country);
    const linkCodes = LINK_CODES_BY_COUNTRY[country] ?? (alpha3 ? [alpha3.toLowerCase()] : []);
    const found = linkCodes
      .map((code) => table.data.byLinkCode[code])
      .filter((advisory): advisory is TravelAdvisory => advisory !== undefined)
      .sort((a, b) => b.level - a.level);
    const data: TravelAdvisorySignal = found.length === 0 ? none : { status: "published", countryCode: country, advisory: found[0], otherAreas: found.slice(1) };
    return { ok: true, data, fetchedAt: table.fetchedAt, stale: table.stale };
  });
}
