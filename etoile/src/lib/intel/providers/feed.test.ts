import { describe, expect, it } from "vitest";
import { parseFeedDate, readFeed } from "./feed";
import { fixture } from "./test-support";
import { parseXml } from "./xml";

// The four feed fixtures are real captures of 2026-11-27 (NPR top stories, BBC News front page,
// Skift, CDC travel notices). The Atom and RSS 1.0 documents below are written by hand.

const read = (name: string) => readFeed(parseXml(fixture(name)));

describe("readFeed, on the real feeds", () => {
  it("reads NPR: plain titles and times with a -0500 offset", () => {
    const entries = read("npr-top.xml");
    expect(entries).toHaveLength(10);
    expect(entries[0]).toEqual({
      title: "Thanksgiving storm batters East Coast. And, Black Friday sales to hit record levels",
      link: "https://www.npr.org/2026/11/27/g-s1-156004/up-first-newsletter-thanksgiving-storm-black-friday-shopping-asylum-supreme-court",
      publishedAt: "2026-11-27T11:59:02.000Z", // 06:59:02 -0500
    });
    expect(entries[1].title).toBe("French cinema star Gérard Depardieu ordered to stand trial for rape and sexual assault");
  });

  it("reads the BBC: titles in CDATA, links with their query string, GMT times", () => {
    const entries = read("bbc-news.xml");
    expect(entries).toHaveLength(29);
    expect(entries[0].title).toBe("Millions lose access to benefits and pensions services after 'cyber incident'");
    expect(entries[0].link).toMatch(/^https:\/\/www\.bbc\.co\.uk\/news\/articles\/[a-z0-9]+\?at_medium=RSS&at_campaign=rss$/);
    expect(entries.every((entry) => entry.publishedAt?.endsWith("Z"))).toBe(true);
  });

  it("reads Skift: numeric entities in titles become real characters", () => {
    const entries = read("skift.xml");
    expect(entries).toHaveLength(10);
    expect(entries[0]).toEqual({
      title: "Leonardo’s UK Loss Shows the Cost of Renting Hotels",
      link: "https://skift.com/2026/11/27/leonardos-uk-loss-shows-the-cost-of-renting-hotels/",
      publishedAt: "2026-11-27T15:50:11.000Z",
    });
    expect(entries.map((entry) => entry.title)).toContain("Norse Atlantic Suspends Flights as Bankruptcy Looms");
  });

  it("reads the CDC notices: accents from entities, trailing spaces trimmed", () => {
    const entries = read("cdc-notices.xml");
    expect(entries).toHaveLength(25);
    expect(entries[0]).toEqual({
      title: "Level 2 - Chikungunya in Honduras",
      link: "https://wwwnc.cdc.gov/travel/notices/level2/chikungunya-honduras",
      publishedAt: "2026-11-25T05:00:00.000Z",
    });
    expect(entries.map((entry) => entry.title)).toContain("Level 2 - Yellow Fever in Burkina Faso, Côte d’Ivoire, and Ghana");
    expect(entries.map((entry) => entry.title)).toContain("Level 1 - Rocky Mountain Spotted Fever in Mexico");
  });

  it("returns nothing but a headline, a link and a time, with no markup left in the headline", () => {
    for (const name of ["npr-top.xml", "bbc-news.xml", "skift.xml", "cdc-notices.xml"]) {
      for (const entry of read(name)) {
        expect(Object.keys(entry).sort(), name).toEqual(["link", "publishedAt", "title"]);
        expect(entry.title, name).not.toMatch(/[<>]|&#?\w+;|\s{2,}|^\s|\s$/);
        expect(entry.link, name).toMatch(/^https:\/\//);
        expect(entry.publishedAt, name).toMatch(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
      }
    }
  });

  it("reads the advisory feed's entries too, though its dates have no time", () => {
    const entries = read("state-advisories.trimmed.xml");
    expect(entries).toHaveLength(20);
    expect(entries[0]).toMatchObject({ title: "Finland - Level 1: Exercise Normal Precautions", publishedAt: null });
  });
});

describe("readFeed, on other feed formats", () => {
  it("reads Atom", () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Example</title>
        <entry>
          <title type="html">Storm &amp;amp; flood warnings for &lt;b&gt;Lisbon&lt;/b&gt;</title>
          <link rel="self" href="https://example.org/api/1"/>
          <link rel="alternate" type="text/html" href="https://example.org/stories/1"/>
          <id>urn:uuid:1</id>
          <updated>2026-11-27T12:00:00Z</updated>
          <published>2026-11-27T10:30:00+01:00</published>
          <summary>Never read.</summary>
        </entry>
        <entry>
          <title>Second story</title>
          <link href="https://example.org/stories/2"/>
          <updated>2026-11-26T08:00:00Z</updated>
        </entry>
      </feed>`;
    expect(readFeed(parseXml(atom))).toEqual([
      { title: "Storm & flood warnings for Lisbon", link: "https://example.org/stories/1", publishedAt: "2026-11-27T09:30:00.000Z" },
      { title: "Second story", link: "https://example.org/stories/2", publishedAt: "2026-11-26T08:00:00.000Z" },
    ]);
  });

  it("reads RSS 1.0, where items sit beside the channel and dates are dc:date", () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>Example</title></channel>
      <item><title>Ferry strike on Friday</title><link>https://example.org/a</link><dc:date>2026-11-27T06:00:00Z</dc:date></item>
    </rdf:RDF>`;
    expect(readFeed(parseXml(rdf))).toEqual([{ title: "Ferry strike on Friday", link: "https://example.org/a", publishedAt: "2026-11-27T06:00:00.000Z" }]);
  });

  it("uses a permalink guid when there is no link, and skips entries it cannot use", () => {
    const rss = `<rss><channel>
      <item><title>From the guid</title><guid>https://example.org/guid-story</guid></item>
      <item><title>Guid is not a link</title><guid isPermaLink="false">abc123</guid></item>
      <item><title>Guid is not a web address</title><guid>tag:example.org,2026:1</guid></item>
      <item><title>   </title><link>https://example.org/untitled</link></item>
      <item><link>https://example.org/no-title</link></item>
      <item><title>Unsafe link</title><link>javascript:alert(1)</link></item>
      <item><title>Relative link</title><link>/stories/1</link></item>
      <item><title>Good</title><link> https://example.org/good </link><pubDate>not a date</pubDate></item>
    </channel></rss>`;
    expect(readFeed(parseXml(rss))).toEqual([
      { title: "From the guid", link: "https://example.org/guid-story", publishedAt: null },
      { title: "Good", link: "https://example.org/good", publishedAt: null },
    ]);
  });

  it("shortens an absurdly long headline, and returns nothing for an empty feed or another document", () => {
    const long = readFeed(parseXml(`<rss><channel><item><title>${"word ".repeat(200)}</title><link>https://example.org/x</link></item></channel></rss>`));
    expect(long[0].title).toHaveLength(300);
    expect(long[0].title.endsWith("…")).toBe(true);
    expect(readFeed(parseXml("<rss><channel><title>Quiet day</title></channel></rss>"))).toEqual([]);
    expect(readFeed(parseXml("<rss/>"))).toEqual([]);
    expect(readFeed(parseXml("<html><body><item><title>x</title><link>https://example.org</link></item></body></html>"))).toEqual([]);
  });
});

describe("parseFeedDate", () => {
  it("reads RFC 822 dates with every kind of zone", () => {
    expect(parseFeedDate("Fri, 27 Nov 2026 06:59:02 -0500")).toBe("2026-11-27T11:59:02.000Z");
    expect(parseFeedDate("Fri, 27 Nov 2026 15:50:11 +0000")).toBe("2026-11-27T15:50:11.000Z");
    expect(parseFeedDate("Fri, 27 Nov 2026 21:08:20 GMT")).toBe("2026-11-27T21:08:20.000Z");
    expect(parseFeedDate("Sat, 28 Nov 2026 01:30:00 +0530")).toBe("2026-11-27T20:00:00.000Z");
    expect(parseFeedDate("Fri, 27 Nov 2026 23:30 EST")).toBe("2026-11-28T04:30:00.000Z");
    expect(parseFeedDate("27 Nov 2026 12:00:00 PDT")).toBe("2026-11-27T19:00:00.000Z");
    expect(parseFeedDate("Friday, 27 November 2026 12:00:00 UT")).toBe("2026-11-27T12:00:00.000Z");
    expect(parseFeedDate("  Fri, 27 Nov 2026 12:00:00  ")).toBe("2026-11-27T12:00:00.000Z"); // no zone: UTC
  });

  it("reads ISO 8601 dates", () => {
    expect(parseFeedDate("2026-11-27T11:59:02Z")).toBe("2026-11-27T11:59:02.000Z");
    expect(parseFeedDate("2026-11-27T11:59:02.123Z")).toBe("2026-11-27T11:59:02.000Z");
    expect(parseFeedDate("2026-11-27T10:30:00+01:00")).toBe("2026-11-27T09:30:00.000Z");
    expect(parseFeedDate("2026-11-27T10:30:00-0800")).toBe("2026-11-27T18:30:00.000Z");
    expect(parseFeedDate("2026-11-27T10:30")).toBe("2026-11-27T10:30:00.000Z"); // no zone: UTC
    expect(parseFeedDate("2026-11-27 10:30:00")).toBe("2026-11-27T10:30:00.000Z");
  });

  it("gives null for a date with no time, an impossible date, or anything else", () => {
    for (const value of [null, undefined, "", "   ", "Fri, 13 Mar 2026", "2026-11-27", "yesterday", "Fri, 30 Feb 2026 10:00:00 GMT", "Fri, 27 Nov 2026 25:00:00 GMT", "Fri, 27 Foo 2026 10:00:00 GMT", "Fri, 27 Nov 2026 10:00:00 XYZ", "2026-13-01T00:00:00Z", "1795819761"]) {
      expect(parseFeedDate(value), String(value)).toBeNull();
    }
  });
});
