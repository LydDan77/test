import "server-only";

import { z } from "zod";
import { httpUrlSchema, instantSchema } from "@/lib/domain";
import { fetchXml, HttpError } from "../http";
import type { NewsItem, NewsSignal, SourceFailure, SourceResult } from "../signals";
import { defaultNewsSources, newsSourceById, type NewsSource } from "../sources";
import { readFeed } from "./feed";
import { answer, DAY_MS, failure, MINUTE_MS, neverThrow, readThroughCache, type SourceOptions } from "./shared";

// News headlines from the feeds listed in ../sources.ts, and only those.
//
// From each feed the app keeps the headline, the publisher's name, the link and the time.
// No summaries, no article text, no pictures: the link takes the person to the publisher.
// Each feed has its own shared copy, refreshed on the schedule in the source table.

/** At most this many headlines are kept from one feed. */
export const MAX_ITEMS_PER_FEED = 20;

/** A feed that has been failing this long contributes nothing: yesterday's headlines are not news. */
const MAX_STALE_MS = DAY_MS;

/**
 * Feeds that must never be read, whatever the source table says. Both publishers limit their
 * feeds to personal feed readers, and Google also blocks servers.
 */
const FORBIDDEN_HOSTS = ["theguardian.com", "guardian.co.uk", "news.google.com"];

/** True for a feed address this app must not read. */
export function isForbiddenFeed(feedUrl: string): boolean {
  try {
    const host = new URL(feedUrl).hostname.toLowerCase();
    return FORBIDDEN_HOSTS.some((forbidden) => host === forbidden || host.endsWith(`.${forbidden}`));
  } catch {
    return true;
  }
}

const entriesSchema = z.array(
  z.object({
    title: z.string().min(1).max(300),
    link: httpUrlSchema,
    publishedAt: instantSchema.nullable(),
  }),
);

async function fetchSource(source: NewsSource): Promise<NewsItem[]> {
  if (isForbiddenFeed(source.feedUrl)) throw new HttpError("shape", `${source.id}: this feed must not be read`);
  const root = await fetchXml(source.feedUrl, { root: ["rss", "feed", "rdf:RDF"] });
  const checked = entriesSchema.safeParse(readFeed(root));
  if (!checked.success) throw new HttpError("shape", `${source.id}: the feed's entries are not in the expected form`);
  return checked.data.slice(0, MAX_ITEMS_PER_FEED).map((entry) => ({
    headline: entry.title,
    publisher: source.name,
    link: entry.link,
    publishedAt: entry.publishedAt,
    sourceId: source.id,
    kind: source.kind,
  }));
}

/** The same story under another address: tracking parameters, fragments and a trailing slash do not count. */
function linkKey(link: string): string {
  try {
    const url = new URL(link);
    for (const name of [...url.searchParams.keys()]) {
      if (/^(utm_|at_|ref$|cmp$|ocid$|ns_)/i.test(name)) url.searchParams.delete(name);
    }
    url.hash = "";
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return link;
  }
}

function headlineKey(headline: string): string {
  return headline.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Newest first, undated last, each story once (by address, then by headline). Exported for tests. */
export function mergeNews(lists: readonly NewsItem[][]): NewsItem[] {
  const time = (item: NewsItem) => (item.publishedAt ? Date.parse(item.publishedAt) : Number.NEGATIVE_INFINITY);
  const sorted = lists.flat().sort((a, b) => time(b) - time(a));
  const seenLinks = new Set<string>();
  const seenHeadlines = new Set<string>();
  const merged: NewsItem[] = [];
  for (const item of sorted) {
    const link = linkKey(item.link);
    const headline = headlineKey(item.headline);
    if (seenLinks.has(link) || seenHeadlines.has(headline)) continue;
    seenLinks.add(link);
    seenHeadlines.add(headline);
    merged.push(item);
  }
  return merged;
}

export type NewsOptions = SourceOptions & {
  /**
   * Ids from NEWS_SOURCES to read. Default: the sources that are on by default. Ids that are
   * not in the table are ignored: a feed address can never be passed in from outside.
   */
  sourceIds?: readonly string[];
};

/**
 * The current headlines from the chosen news sources: newest first, each story once.
 *
 *   const news = await getNews({ now });
 *   if (news.ok) pickRelevantNews(news.data.items, { places: ["Orlando"], airports: ["MCO"], limit: 3 });
 *
 * This is the raw list, a few dozen headlines about anything. Never show it as it is: pass it
 * through pickRelevantNews() (./news-relevance) to get the few that touch a plan.
 *
 * The result is ok when at least one source could be read; `data.sources` says how each one
 * did. `fetchedAt` is the oldest copy among the sources used and `stale` is true when any of
 * them is a last good copy. With every source down the result is a failure.
 */
export async function getNews(options: NewsOptions = {}): Promise<SourceResult<NewsSignal>> {
  return neverThrow("news", async () => {
    const now = options.now ?? new Date();
    const sources = options.sourceIds
      ? [...new Set(options.sourceIds)].map((id) => newsSourceById(id)).filter((source): source is NewsSource => source !== undefined)
      : defaultNewsSources();
    if (sources.length === 0) return answer({ items: [], sources: [] }, now);

    const results = await Promise.all(
      sources.map((source) =>
        readThroughCache(`v1:news:${source.id}`, source.refreshMinutes * MINUTE_MS, () => fetchSource(source), {
          now,
          maxStaleMs: MAX_STALE_MS,
          // A publisher that is refusing us is not asked again every minute.
          retryAfterMs: 10 * MINUTE_MS,
        }),
      ),
    );

    const lists: NewsItem[][] = [];
    const report: NewsSignal["sources"] = [];
    let oldest: Date | null = null;
    let stale = false;
    let firstFailure: SourceFailure | null = null;
    for (const [index, result] of results.entries()) {
      const source = sources[index];
      if (!result.ok) {
        firstFailure ??= result;
        report.push({ id: source.id, name: source.name, ok: false, fetchedAt: result.lastGoodAt, stale: true });
        continue;
      }
      lists.push(result.data);
      report.push({ id: source.id, name: source.name, ok: true, fetchedAt: result.fetchedAt, stale: result.stale });
      if (!oldest || result.fetchedAt.getTime() < oldest.getTime()) oldest = result.fetchedAt;
      stale = stale || result.stale;
    }

    if (!oldest) return failure(firstFailure?.reason ?? "unavailable", firstFailure?.detail ?? "No news source could be read");
    return { ok: true, data: { items: mergeNews(lists), sources: report }, fetchedAt: oldest, stale };
  });
}
