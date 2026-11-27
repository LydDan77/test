// One reader for RSS 2.0, RSS 1.0 and Atom news feeds. Pure: it takes a parsed document and
// returns headline, link and time for each entry. Nothing else in a feed (summaries, article
// text, images, authors) is read, so nothing else can be stored or shown.

import { zonedToUtc } from "@/lib/time";
import { childText, childrenNamed, firstChild, plainText, type XmlElement } from "./xml";

export type FeedEntry = {
  /** The headline as plain text. */
  title: string;
  /** The story's address on the publisher's site. */
  link: string;
  /** When it was published, as an ISO instant; null when the feed gives no usable time. */
  publishedAt: string | null;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The few zone names RFC 822 allows, as minutes east of UTC. */
const ZONE_MINUTES: Record<string, number> = {
  GMT: 0, UT: 0, UTC: 0, Z: 0,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
};

/**
 * A feed timestamp as an ISO instant. Understands RFC 822 ("Fri, 27 Nov 2026 06:59:02 -0500",
 * "… GMT") and ISO 8601 with a zone ("2026-11-27T11:59:02Z", "…+01:00"). A time with no zone
 * is read as UTC. A date with no time, or anything else, gives null.
 */
export function parseFeedDate(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (text === "") return null;

  const rfc = /^(?:[A-Za-z]{3,9},\s*)?(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([A-Za-z]{1,5}|[+-]\d{4})?$/.exec(text);
  if (rfc) {
    const month = MONTHS.indexOf(rfc[2].toLowerCase());
    if (month === -1) return null;
    const zone = rfc[7] ?? "UTC";
    let offsetMinutes: number;
    if (/^[+-]\d{4}$/.test(zone)) {
      offsetMinutes = (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
    } else {
      const named = ZONE_MINUTES[zone.toUpperCase()];
      if (named === undefined) return null;
      offsetMinutes = named;
    }
    const local = `${rfc[3]}-${String(month + 1).padStart(2, "0")}-${rfc[1].padStart(2, "0")}T${rfc[4].padStart(2, "0")}:${rfc[5]}:${rfc[6] ?? "00"}`;
    try {
      // The reading as if it were UTC, then moved by the offset the feed itself states.
      return new Date(zonedToUtc(local, "UTC").getTime() - offsetMinutes * 60_000).toISOString();
    } catch {
      return null;
    }
  }

  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (iso) {
    const zone = iso[3] ? iso[3].toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z";
    const ms = Date.parse(`${iso[1]}T${iso[2].length === 5 ? `${iso[2]}:00` : iso[2]}${zone}`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function isWebAddress(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function entry(title: string | null, link: string | null | undefined, date: string | null): FeedEntry | null {
  const headline = plainText(title ?? "");
  const address = link?.trim();
  if (headline === "" || !isWebAddress(address)) return null;
  return { title: headline.length > 300 ? `${headline.slice(0, 299)}…` : headline, link: address, publishedAt: parseFeedDate(date) };
}

/**
 * The entries of a feed, in the feed's own order. Entries without a headline or a web link are
 * left out. Accepts a root of <rss> (2.0), <rdf:RDF> (1.0) or <feed> (Atom); anything else
 * gives an empty list.
 */
export function readFeed(root: XmlElement): FeedEntry[] {
  const entries: (FeedEntry | null)[] = [];

  if (root.name === "feed") {
    for (const item of childrenNamed(root, "entry")) {
      const links = childrenNamed(item, "link");
      const link = (links.find((candidate) => (candidate.attributes.rel ?? "alternate") === "alternate") ?? links[0])?.attributes.href;
      entries.push(entry(childText(item, "title"), link, childText(item, "published") ?? childText(item, "updated")));
    }
  } else if (root.name === "rss" || root.name === "rdf:RDF") {
    const channel = firstChild(root, "channel");
    const items = [...(channel ? childrenNamed(channel, "item") : []), ...childrenNamed(root, "item")];
    for (const item of items) {
      // A guid is the story's address unless the feed says it is not a permalink.
      const guid = firstChild(item, "guid");
      const guidLink = guid && guid.attributes.isPermaLink !== "false" ? guid.text.trim() : null;
      entries.push(entry(childText(item, "title"), childText(item, "link") ?? guidLink, childText(item, "pubDate") ?? childText(item, "dc:date")));
    }
  }
  return entries.filter((item): item is FeedEntry => item !== null);
}
