import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { HTTP_DEFAULTS } from "../http";
import type { TravelAdvisorySignal } from "../signals";
import { advisoriesFromFeed, getTravelAdvisory } from "./advisories";
import { ALPHA3_BY_ALPHA2 } from "./countries";
import { fixture, html, stubFetch, xml } from "./test-support";
import { parseXml } from "./xml";

// Fixtures:
//  real      state-advisories.trimmed.xml: 20 items copied whole from the feed of
//            2026-11-26T00:07Z (the full feed has 218 and is 0.6 MB), chosen to include the
//            awkward ones: Israel, Gaza and the West Bank; Kosovo; Bonaire, Saba and Sint
//            Eustatius; "Mexico Travel Advisory"; two Tongas; French West Indies.
//  derived   state-advisories.index.derived.json: every one of the 218 real items reduced to
//            name, level, the code in its link, and the link. Used to rebuild a full-size feed.

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

const NOW = new Date("2026-11-26T00:10:00Z");
const HOUR = 3_600_000;
const realFeed = () => xml(fixture("state-advisories.trimmed.xml"), "text/xml");
const STATE_PAGE = "https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html";

async function advisoryFor(countryCode: string, now = NOW): Promise<TravelAdvisorySignal> {
  const result = await getTravelAdvisory(countryCode, { now });
  if (!result.ok) throw new Error(`No answer for ${countryCode}: ${result.detail}`);
  return result.data;
}

describe("getTravelAdvisory", () => {
  it("returns the level and opening sentence for a country, from the real feed", async () => {
    const stub = stubFetch(realFeed);
    const result = await getTravelAdvisory("PT", { now: NOW });
    expect(stub.calls.map((call) => call.url.href)).toEqual(["https://travel.state.gov/_res/rss/TAsTWs.xml"]);
    expect(result).toEqual({
      ok: true,
      stale: false,
      fetchedAt: NOW,
      data: {
        status: "published",
        countryCode: "PT",
        advisory: {
          area: "Portugal",
          level: 1,
          levelText: "Exercise normal precautions",
          summary: expect.stringMatching(/^Exercise normal precaution.* in Portugal\.$/),
          publishedOn: expect.stringMatching(/^20\d\d-\d\d-\d\d$/),
          url: "https://travel.state.gov/content/tsg_aem/us/en/home/international-travel/travel-advisories/destination.prt.html",
        },
        otherAreas: [],
      },
    });
  });

  it("reads every level and a plain summary", async () => {
    stubFetch(realFeed);
    expect(await advisoryFor("FI")).toMatchObject({ advisory: { area: "Finland", level: 1, summary: "Exercise normal precaution in Finland.", publishedOn: "2026-03-13" } });
    expect(await advisoryFor("CR")).toMatchObject({ advisory: { level: 2, levelText: "Exercise increased caution", summary: "Exercise increased caution in Costa Rica due to crime.", publishedOn: "2026-04-02" } });
    expect(await advisoryFor("GY")).toMatchObject({ advisory: { level: 3, levelText: "Reconsider travel", summary: "Reconsider travel to Guyana due to crime.", publishedOn: "2026-08-26" } });
    expect(await advisoryFor("KP")).toMatchObject({ advisory: { area: "North Korea", level: 4, levelText: "Do not travel" } });
    for (const code of ["FI", "CR", "GY", "KP", "QA", "JP", "BW", "BG"]) {
      const signal = await advisoryFor(code);
      if (signal.status !== "published") throw new Error(code);
      expect(signal.advisory.summary ?? "", code).not.toMatch(/[<>]|&nbsp;|\s{2,}|\s[.,]/);
      expect((signal.advisory.summary ?? "").length, code).toBeLessThanOrEqual(301);
    }
  });

  it("cleans up the feed's untidy names", async () => {
    stubFetch(realFeed);
    // The title reads "Mexico Travel Advisory - Level 2: …".
    expect(await advisoryFor("MX")).toMatchObject({ advisory: { area: "Mexico", level: 2 } });
    expect(await advisoryFor("gb")).toMatchObject({ countryCode: "GB", advisory: { area: "United Kingdom", level: 2 } });
  });

  it("matches by the ISO code in the link, never by the feed's look-alike Country-Tag", async () => {
    stubFetch(realFeed);
    // The feed tags Israel, Gaza and the West Bank all "IS". ISO "IS" is Iceland, which this
    // trimmed feed does not contain.
    expect(await advisoryFor("IS")).toEqual({ status: "none", countryCode: "IS", url: STATE_PAGE });
    expect(await advisoryFor("IL")).toMatchObject({ advisory: { area: "Israel", level: 3 }, otherAreas: [] });
    // The feed tags the United Kingdom "UK", Bulgaria "BU", Botswana "BC", Japan "JA".
    expect(await advisoryFor("BG")).toMatchObject({ advisory: { area: "Bulgaria" } });
    expect(await advisoryFor("BW")).toMatchObject({ advisory: { area: "Botswana" } });
    expect(await advisoryFor("JP")).toMatchObject({ advisory: { area: "Japan" } });
    for (const lookAlike of ["UK", "BU", "BC", "JA"]) expect((await advisoryFor(lookAlike)).status, lookAlike).toBe("none");
  });

  it("handles the places with codes of the Department's own", async () => {
    stubFetch(realFeed);
    expect(await advisoryFor("XK")).toMatchObject({ advisory: { area: "Kosovo", level: 2 } });
    // Two areas under one country code: the stricter one leads.
    expect(await advisoryFor("PS")).toMatchObject({
      status: "published",
      advisory: { area: "Gaza", level: 4 },
      otherAreas: [{ area: "The West Bank", level: 3 }],
    });
    const caribbeanNetherlands = await advisoryFor("BQ");
    expect(caribbeanNetherlands).toMatchObject({ advisory: { area: "Bonaire", level: 1 }, otherAreas: [{ area: "Saba and Sint Eustatius", level: 1 }] });
  });

  it("uses the coded item when a country appears twice, and ignores items that cannot be matched", async () => {
    stubFetch(realFeed);
    const tonga = await advisoryFor("TO");
    expect(tonga).toMatchObject({ advisory: { area: "Tonga", url: expect.stringContaining("destination.ton.html") }, otherAreas: [] });
    const table = advisoriesFromFeed(parseXml(fixture("state-advisories.trimmed.xml")));
    // 20 items: the second Tonga and "French West Indies" have old-style links with no code.
    expect(Object.keys(table.byLinkCode)).toHaveLength(18);
    expect(table.feedPublishedAt).toBe("2026-11-26T00:06:02.000Z");
  });

  it("says 'none', with a link, for the United States, its territories and anywhere not in the feed", async () => {
    const stub = stubFetch(realFeed);
    for (const home of ["US", "us", "PR", "GU", "VI"]) {
      expect(await getTravelAdvisory(home, { now: NOW })).toEqual({ ok: true, stale: false, fetchedAt: NOW, data: { status: "none", countryCode: home.toUpperCase(), url: STATE_PAGE } });
    }
    expect(stub.calls).toHaveLength(0); // nothing to look up for home
    expect(await advisoryFor("MC")).toEqual({ status: "none", countryCode: "MC", url: STATE_PAGE });
    expect(await advisoryFor("ZZ")).toEqual({ status: "none", countryCode: "ZZ", url: STATE_PAGE });
  });

  it("reads the feed once for any number of countries, and again after six hours", async () => {
    const stub = stubFetch(realFeed);
    for (const code of ["PT", "JP", "MX", "GB", "FI", "IL", "PS"]) await advisoryFor(code);
    expect(stub.calls).toHaveLength(1);
    await advisoryFor("PT", new Date(NOW.getTime() + 5.9 * HOUR));
    expect(stub.calls).toHaveLength(1);
    await advisoryFor("PT", new Date(NOW.getTime() + 6.1 * HOUR));
    expect(stub.calls).toHaveLength(2);
  });

  describe("when the feed cannot be read", () => {
    it.each([
      ["a 403 HTML page", () => html("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>", 403)],
      ["an HTML page with status 200", () => html("<!DOCTYPE html><html><body>Access denied</body></html>")],
      ["an HTML page labelled as XML", () => xml(fixture("npr-error-403.html"), "text/xml")],
      ["a feed cut off half-way", () => xml(fixture("state-advisories.trimmed.xml").slice(0, 9000), "text/xml")],
      ["a different XML document", () => xml(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`, "text/xml")],
      ["a feed with no channel", () => xml("<rss></rss>", "text/xml")],
      ["a feed with no advisories in it", () => xml("<rss><channel><title>travel.state.gov: Travel Advisories</title></channel></rss>", "text/xml")],
      ["an empty answer", () => xml("", "text/xml")],
      ["a server error, twice", () => html("<html>502</html>", 502)],
    ])("fails on %s rather than reporting 'no advisory' for every country", async (_label, respond) => {
      stubFetch(respond);
      expect(await getTravelAdvisory("PT", { now: NOW })).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: null });
      const rows = await t.db.select().from(schema.signalCache);
      expect(rows.every((row) => row.payload === null)).toBe(true);
    });

    it("fails on a timeout", async () => {
      HTTP_DEFAULTS.timeoutMs = 40;
      // This feed is given 15 seconds in production; the stub ignores the figure and waits for the abort.
      const started = Date.now();
      vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), 30, init)));
      expect(await getTravelAdvisory("PT", { now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("goes on using the last table, marked stale, with the time it was read", async () => {
      let healthy = true;
      stubFetch(() => (healthy ? realFeed() : html("<html>Access denied</html>", 403)));
      await advisoryFor("MX");
      healthy = false;
      const threeDaysOn = new Date(NOW.getTime() + 72 * HOUR);
      const result = await getTravelAdvisory("MX", { now: threeDaysOn });
      expect(result).toMatchObject({ ok: true, stale: true, fetchedAt: NOW, data: { status: "published", advisory: { area: "Mexico", level: 2 } } });
    });
  });

  it("refuses a code that is not two letters, without a request", async () => {
    const stub = stubFetch(realFeed);
    for (const bad of ["USA", "", "P", "P1", "Portugal"]) expect(await getTravelAdvisory(bad, { now: NOW }), bad).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("a full-size feed (rebuilt from the index of all 218 real items)", () => {
  type IndexRow = { name: string; level: 1 | 2 | 3 | 4; iso3FromLink: string | null; link: string };
  const index = JSON.parse(fixture("state-advisories.index.derived.json")) as { items: IndexRow[] };
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const LEVEL_TEXT = { 1: "Exercise Normal Precautions", 2: "Exercise Increased Caution", 3: "Reconsider Travel", 4: "Do Not Travel" };
  const rebuilt =
    `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>travel.state.gov: Travel Advisories</title><dc:date>2026-11-26T00:06:02Z</dc:date>` +
    index.items
      .map(
        (row) =>
          `<item><title>${escape(row.name)} - Level ${row.level}: ${LEVEL_TEXT[row.level]}</title><link>${escape(row.link)}</link><pubDate>Tue, 24 Nov 2026</pubDate>` +
          `<description><![CDATA[${LEVEL_TEXT[row.level]}<p>in <b>${row.name}</b>.</p>]]></description><category domain="Threat-Level">Level ${row.level}: ${LEVEL_TEXT[row.level]}</category></item>`,
      )
      .join("") +
    `</channel></rss>`;

  it("finds every ISO country in the feed by its two-letter code, at the right level", async () => {
    stubFetch(() => xml(rebuilt, "text/xml"));
    const alpha2ByAlpha3 = new Map(Object.entries(ALPHA3_BY_ALPHA2).map(([alpha2, alpha3]) => [alpha3, alpha2]));
    let checked = 0;
    for (const row of index.items) {
      const alpha2 = row.iso3FromLink ? alpha2ByAlpha3.get(row.iso3FromLink) : undefined;
      if (!alpha2 || alpha2 === "BQ") continue; // the four x-codes, the two uncoded items, and Bonaire (shared code)
      const signal = await advisoryFor(alpha2);
      expect(signal, `${alpha2} ${row.name}`).toMatchObject({ status: "published", advisory: { level: row.level, url: row.link } });
      checked++;
    }
    expect(checked).toBe(211);
    expect(index.items).toHaveLength(218);
  });

  it("trims the non-breaking space the real feed leaves after 'Switzerland', and keeps accents", async () => {
    stubFetch(() => xml(rebuilt, "text/xml"));
    expect(index.items.some((row) => row.name === "Switzerland\u00a0")).toBe(true);
    expect(await advisoryFor("CH")).toMatchObject({ advisory: { area: "Switzerland" } }); // "CH" is not China here
    expect(await advisoryFor("CN")).toMatchObject({ advisory: { area: expect.stringContaining("China") } });
    expect(await advisoryFor("CW")).toMatchObject({ advisory: { area: "Curaçao" } });
    expect(await advisoryFor("AU")).toMatchObject({ advisory: { area: "Australia" } }); // the feed's "AU" tag is Austria
    expect(await advisoryFor("AT")).toMatchObject({ advisory: { area: "Austria" } });
  });
});
