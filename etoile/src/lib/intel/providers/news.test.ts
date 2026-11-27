import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { DEFAULT_USER_AGENT, HTTP_DEFAULTS } from "../http";
import type { NewsItem } from "../signals";
import { NEWS_SOURCES } from "../sources";
import { getNews, isForbiddenFeed, MAX_ITEMS_PER_FEED, mergeNews } from "./news";
import { fixture, html, stubFetch, xml, type Scripted } from "./test-support";

// Fixtures: npr-top.xml, bbc-news.xml, skift.xml and cdc-notices.xml are real captures of
// 2026-11-27. npr-error-403.html is the real "Access Denied" page NPR's network served the same
// day to a request with a different User-Agent; google-news-blocked-503.html is Google's real
// block page.

let t: TestDb;
const original = { ...HTTP_DEFAULTS };
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.delete(schema.signalCache);
  HTTP_DEFAULTS.retryDelayMs = 0;
});
afterEach(() => {
  Object.assign(HTTP_DEFAULTS, original);
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-11-27T22:00:00Z");
const MINUTE = 60_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);

const REAL: Record<string, () => Scripted> = {
  "feeds.npr.org": () => xml(fixture("npr-top.xml"), "text/xml;charset=UTF-8"),
  "feeds.bbci.co.uk": () => xml(fixture("bbc-news.xml"), "text/xml; charset=utf-8"),
  "skift.com": () => xml(fixture("skift.xml"), "application/rss+xml; charset=UTF-8"),
  // The CDC really serves its RSS with this content type.
  "wwwnc.cdc.gov": () => ({ status: 200, contentType: "text/html; charset=utf-8", body: fixture("cdc-notices.xml") }),
};

/** Serves the real feeds, except for the hosts given, which get the override. */
function feeds(overrides: Record<string, () => Scripted> = {}) {
  return stubFetch((url) => (overrides[url.host] ?? REAL[url.host] ?? (() => html("<html>unknown host</html>", 404)))());
}

describe("getNews", () => {
  it("reads the sources that are on by default and returns their headlines newest first", async () => {
    const stub = feeds();
    const result = await getNews({ now: NOW });
    expect(stub.calls.map((call) => call.url.href).sort()).toEqual([
      "https://feeds.bbci.co.uk/news/rss.xml",
      "https://skift.com/feed/",
      "https://wwwnc.cdc.gov/travel/rss/notices.xml",
    ]);
    expect(stub.calls.every((call) => call.headers.get("user-agent") === DEFAULT_USER_AGENT)).toBe(true);
    expect(result).toMatchObject({ ok: true, stale: false, fetchedAt: NOW });
    if (!result.ok) return;

    expect(result.data.sources).toEqual([
      { id: "bbc-news", name: "BBC News", ok: true, fetchedAt: NOW, stale: false },
      { id: "skift", name: "Skift", ok: true, fetchedAt: NOW, stale: false },
      { id: "cdc-travel-notices", name: "CDC Travelers' Health", ok: true, fetchedAt: NOW, stale: false },
    ]);
    const { items } = result.data;
    // 20 of the BBC's 29, Skift's 10, 20 of the CDC's 25.
    expect(items).toHaveLength(50);
    const times = items.map((item) => Date.parse(item.publishedAt ?? ""));
    expect(times.every((time, index) => index === 0 || time <= times[index - 1])).toBe(true);
    expect(new Set(items.map((item) => item.publisher))).toEqual(new Set(["BBC News", "Skift", "CDC Travelers' Health"]));
  });

  it("keeps only the headline, the publisher, the link and the time", async () => {
    feeds();
    const result = await getNews({ now: NOW });
    if (!result.ok) throw new Error("expected news");
    for (const item of result.data.items) {
      expect(Object.keys(item).sort()).toEqual(["headline", "kind", "link", "publishedAt", "publisher", "sourceId"]);
    }
    expect(result.data.items.find((item) => item.sourceId === "skift")).toEqual({
      headline: "Leonardo’s UK Loss Shows the Cost of Renting Hotels",
      publisher: "Skift",
      link: "https://skift.com/2026/11/27/leonardos-uk-loss-shows-the-cost-of-renting-hotels/",
      publishedAt: "2026-11-27T15:50:11.000Z",
      sourceId: "skift",
      kind: "travel",
    });
    // Nothing from a story's summary or body is anywhere in the result or in the cache.
    const everything = JSON.stringify(result.data) + JSON.stringify(await t.db.select().from(schema.signalCache));
    expect(everything).not.toContain("lease-heavy model"); // from Skift's description of that story
    expect(everything).not.toContain("Department for Work and Pensions says"); // from a BBC description
    expect(everything).not.toMatch(/<p>|<img|content:encoded/);
  });

  it("reads NPR only when it is asked for by id, and ignores ids that are not in the table", async () => {
    const stub = feeds();
    const result = await getNews({ sourceIds: ["npr-top", "the-guardian", "https://evil.example/feed", "npr-top"], now: NOW });
    expect(stub.calls.map((call) => call.url.href)).toEqual(["https://feeds.npr.org/1001/rss.xml"]);
    expect(result).toMatchObject({ ok: true, data: { sources: [{ id: "npr-top", name: "NPR", ok: true }] } });
    if (result.ok) {
      expect(result.data.items).toHaveLength(10);
      expect(result.data.items[0]).toMatchObject({ publisher: "NPR", kind: "general", headline: "Thanksgiving storm batters East Coast. And, Black Friday sales to hit record levels" });
    }
  });

  it("returns an empty list, not a failure, when no source is chosen", async () => {
    const stub = feeds();
    expect(await getNews({ sourceIds: [], now: NOW })).toEqual({ ok: true, stale: false, fetchedAt: NOW, data: { items: [], sources: [] } });
    expect(await getNews({ sourceIds: ["nothing-real"], now: NOW })).toMatchObject({ ok: true, data: { items: [] } });
    expect(stub.calls).toHaveLength(0);
  });

  it("carries on with the sources that work when one serves a block page", async () => {
    feeds({ "feeds.bbci.co.uk": () => html(fixture("npr-error-403.html"), 403) });
    const result = await getNews({ now: NOW });
    expect(result).toMatchObject({ ok: true, stale: false });
    if (!result.ok) return;
    expect(result.data.sources).toEqual([
      { id: "bbc-news", name: "BBC News", ok: false, fetchedAt: null, stale: true },
      { id: "skift", name: "Skift", ok: true, fetchedAt: NOW, stale: false },
      { id: "cdc-travel-notices", name: "CDC Travelers' Health", ok: true, fetchedAt: NOW, stale: false },
    ]);
    expect(result.data.items).toHaveLength(30);
    expect(result.data.items.some((item) => item.sourceId === "bbc-news")).toBe(false);
  });

  it.each([
    ["Google's real block page with status 200", () => html(fixture("google-news-blocked-503.html"))],
    ["a block page labelled as XML", () => xml(fixture("npr-error-403.html"), "text/xml")],
    ["a feed cut off half-way", () => xml(fixture("bbc-news.xml").slice(0, 6000), "text/xml")],
    ["a JSON error", (): Scripted => ({ status: 200, contentType: "application/json", body: `{"error":"moved"}` })],
    ["a server error, twice", () => html("<html>502</html>", 502)],
    ["a dropped connection", (): Scripted => "network-error"],
  ])("fails when every source gives %s", async (_label, respond) => {
    stubFetch(respond);
    const result = await getNews({ now: NOW });
    expect(result).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: null });
    const rows = await t.db.select().from(schema.signalCache);
    expect(rows.every((row) => row.payload === null)).toBe(true);
  });

  it("fails when every source times out, without waiting long", async () => {
    HTTP_DEFAULTS.timeoutMs = 40;
    stubFetch(() => "hang");
    const started = Date.now();
    expect(await getNews({ now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000); // the three feeds are asked at the same time
  });

  it("treats a feed with no entries as a quiet source, not a broken one", async () => {
    feeds({ "skift.com": () => xml("<rss><channel><title>Skift</title></channel></rss>", "application/rss+xml") });
    const result = await getNews({ now: NOW });
    expect(result.ok && result.data.sources.find((source) => source.id === "skift")).toMatchObject({ ok: true });
    expect(result.ok && result.data.items.filter((item) => item.sourceId === "skift")).toEqual([]);
  });

  it("refreshes each source on its own schedule", async () => {
    const stub = feeds();
    await getNews({ now: NOW });
    stub.reset();
    await getNews({ now: later(29 * MINUTE) });
    expect(stub.calls).toHaveLength(0);
    await getNews({ now: later(31 * MINUTE) });
    expect(stub.calls.map((call) => call.url.host)).toEqual(["feeds.bbci.co.uk"]); // BBC: every 30 minutes
    stub.reset();
    await getNews({ now: later(61 * MINUTE) });
    expect(stub.calls.map((call) => call.url.host).sort()).toEqual(["feeds.bbci.co.uk", "skift.com"]); // Skift: every 60
    stub.reset();
    await getNews({ now: later(181 * MINUTE) });
    expect(stub.calls.map((call) => call.url.host)).toContain("wwwnc.cdc.gov"); // CDC: every 180
  });

  it("falls back to a source's last good copy, says so, and drops it after a day", async () => {
    let healthy = true;
    feeds({ "feeds.bbci.co.uk": () => (healthy ? REAL["feeds.bbci.co.uk"]() : html("<html>Access Denied</html>", 403)) });
    await getNews({ now: NOW });
    healthy = false;

    const twoHoursOn = later(120 * MINUTE);
    const stale = await getNews({ now: twoHoursOn });
    expect(stale).toMatchObject({ ok: true, stale: true, fetchedAt: NOW }); // the oldest copy in use
    if (!stale.ok) return;
    expect(stale.data.sources[0]).toEqual({ id: "bbc-news", name: "BBC News", ok: true, fetchedAt: NOW, stale: true });
    expect(stale.data.sources[1]).toMatchObject({ id: "skift", ok: true, stale: false, fetchedAt: twoHoursOn });
    expect(stale.data.items.filter((item) => item.sourceId === "bbc-news")).toHaveLength(MAX_ITEMS_PER_FEED);

    const nextDay = await getNews({ now: later(25 * 60 * MINUTE) });
    expect(nextDay).toMatchObject({ ok: true });
    if (!nextDay.ok) return;
    expect(nextDay.data.sources[0]).toEqual({ id: "bbc-news", name: "BBC News", ok: false, fetchedAt: NOW, stale: true });
    expect(nextDay.data.items.some((item) => item.sourceId === "bbc-news")).toBe(false);
  });

  it("does not ask a feed that refused it again for ten minutes", async () => {
    const stub = feeds({ "skift.com": () => html(fixture("npr-error-403.html"), 403) });
    await getNews({ now: NOW });
    stub.reset();
    await getNews({ now: later(9 * MINUTE) });
    expect(stub.calls).toHaveLength(0);
    await getNews({ now: later(11 * MINUTE) });
    expect(stub.calls.map((call) => call.url.host)).toEqual(["skift.com"]);
  });

  it("never reads a Guardian or Google News feed, even if one were put in the table", () => {
    for (const forbidden of [
      "https://www.theguardian.com/travel/rss",
      "https://theguardian.com/world/rss",
      "https://news.google.com/rss/search?q=flight+delays",
      "https://NEWS.GOOGLE.COM/rss",
      "https://www.guardian.co.uk/travel/rss",
      "not a url",
    ]) {
      expect(isForbiddenFeed(forbidden), forbidden).toBe(true);
    }
    for (const source of NEWS_SOURCES) expect(isForbiddenFeed(source.feedUrl), source.id).toBe(false);
    expect(isForbiddenFeed("https://example.org/feed?from=news.google.com")).toBe(false);
  });
});

describe("mergeNews", () => {
  const item = (headline: string, link: string, publishedAt: string | null, publisher = "A"): NewsItem => ({ headline, publisher, link, publishedAt, sourceId: publisher.toLowerCase(), kind: "general" });

  it("puts the newest first and undated headlines last", () => {
    const merged = mergeNews([
      [item("Old", "https://a.example/1", "2026-11-25T10:00:00.000Z"), item("Undated", "https://a.example/2", null)],
      [item("New", "https://b.example/1", "2026-11-27T10:00:00.000Z"), item("Middle", "https://b.example/2", "2026-11-26T10:00:00.000Z")],
    ]);
    expect(merged.map((entry) => entry.headline)).toEqual(["New", "Middle", "Old", "Undated"]);
  });

  it("shows a story once when its link differs only by tracking, a fragment or a trailing slash", () => {
    const merged = mergeNews([
      [
        item("Storm closes airport", "https://www.bbc.co.uk/news/articles/abc?at_medium=RSS&at_campaign=rss", "2026-11-27T10:00:00.000Z"),
        item("Storm closes airport (updated)", "https://www.bbc.co.uk/news/articles/abc?utm_source=feed#comments", "2026-11-27T09:00:00.000Z"),
        item("Another", "https://WWW.BBC.CO.UK/news/articles/abc/", "2026-11-27T08:00:00.000Z"),
        item("Different story, same path with a real query", "https://example.org/story?id=1", "2026-11-27T07:00:00.000Z"),
        item("Different story two", "https://example.org/story?id=2", "2026-11-27T06:00:00.000Z"),
      ],
    ]);
    expect(merged.map((entry) => entry.headline)).toEqual(["Storm closes airport", "Different story, same path with a real query", "Different story two"]);
  });

  it("shows a headline once when two sources carry it word for word, keeping the newer", () => {
    const merged = mergeNews([
      [item("Hurricane Mara: flights cancelled across Florida", "https://a.example/mara", "2026-11-27T08:00:00.000Z", "A")],
      [item("Hurricane Mara – Flights cancelled across Florida!", "https://b.example/weather/mara", "2026-11-27T09:00:00.000Z", "B")],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].publisher).toBe("B");
  });

  it("returns nothing for nothing", () => {
    expect(mergeNews([])).toEqual([]);
    expect(mergeNews([[], []])).toEqual([]);
  });
});
