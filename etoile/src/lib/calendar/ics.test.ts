import { describe, expect, it } from "vitest";
import { escapeIcsText, foldIcsLine, icsDate, icsForItems, icsUid, icsUtcStamp } from "./ics";
import type { CalendarItem } from "./types";

const NOW = new Date("2026-11-26T15:00:00Z");

const flight: CalendarItem = {
  id: "bk_9f2c1a-flight-0",
  title: "AS 1054 SEA to MCO",
  start: { at: "2026-12-19T15:35:00Z", tz: "America/Los_Angeles" },
  end: { at: "2026-12-19T21:10:00Z", tz: "America/New_York" },
  location: "SEA, Terminal N",
  description: "Alaska Airlines flight 1054 from SEA to MCO.",
};

const stay: CalendarItem = {
  id: "bk_stay",
  title: "Stay: Lakeside House",
  allDay: true,
  localDate: "2026-12-18",
  endDate: "2026-12-21",
};

/** Unfolds a file back into logical lines, the way a calendar app reads it. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n");
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("icsForItems: structure", () => {
  const ics = icsForItems([flight], { now: NOW });
  const lines = unfold(ics);

  it("is a calendar with the required properties, in order", () => {
    expect(lines.slice(0, 5)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//etoile//Plans//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]);
    expect(lines.at(-2)).toBe("END:VCALENDAR");
    expect(lines.at(-1)).toBe("");
  });

  it("ends every line with CRLF and has no bare line feeds", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes timed entries in UTC with a stable UID and a UTC stamp", () => {
    expect(lines).toContain("UID:bk_9f2c1a-flight-0@etoile");
    expect(lines).toContain("DTSTAMP:20261126T150000Z");
    expect(lines).toContain("DTSTART:20261219T153500Z");
    expect(lines).toContain("DTEND:20261219T211000Z");
    expect(ics).not.toContain("TZID");
  });

  it("gives the same UID every time, so a second download updates the entry", () => {
    const again = icsForItems([flight], { now: new Date("2026-12-01T00:00:00Z") });
    expect(unfold(again)).toContain("UID:bk_9f2c1a-flight-0@etoile");
  });

  it("says in the notes what the clocks show where it happens", () => {
    const description = lines.find((line) => line.startsWith("DESCRIPTION:"));
    expect(description).toBe("DESCRIPTION:Local time: Sat\\, Dec 19\\, 7:35 AM PST – 4:10 PM EST\\nAlaska Airlines flight 1054 from SEA to MCO.");
  });

  it("can leave the local-time line out", () => {
    const plain = unfold(icsForItems([flight], { now: NOW, localTimeNote: false }));
    expect(plain).toContain("DESCRIPTION:Alaska Airlines flight 1054 from SEA to MCO.");
  });

  it("names the calendar when asked", () => {
    expect(unfold(icsForItems([flight], { now: NOW, calendarName: "Hartley Family Christmas; 2026" }))).toContain("X-WR-CALNAME:Hartley Family Christmas\\; 2026");
  });
});

describe("icsForItems: all-day entries", () => {
  it("uses VALUE=DATE with an exclusive end: a stay through the night of the 21st ends on the 22nd", () => {
    const lines = unfold(icsForItems([stay], { now: NOW }));
    expect(lines).toContain("DTSTART;VALUE=DATE:20261218");
    expect(lines).toContain("DTEND;VALUE=DATE:20261222");
  });

  it("ends a one-day entry on the next day", () => {
    const lines = unfold(icsForItems([{ id: "ship", title: "Last safe day to send: gifts", allDay: true, localDate: "2026-12-10" }], { now: NOW }));
    expect(lines).toContain("DTSTART;VALUE=DATE:20261210");
    expect(lines).toContain("DTEND;VALUE=DATE:20261211");
  });

  it("crosses a month and a year end correctly", () => {
    const lines = unfold(icsForItems([{ id: "ny", title: "New Year", allDay: true, localDate: "2026-12-30", endDate: "2026-12-31" }], { now: NOW }));
    expect(lines).toContain("DTEND;VALUE=DATE:20270101");
  });

  it("treats an item with a date and no start time as all-day", () => {
    const lines = unfold(icsForItems([{ id: "note", title: "Pack the car", localDate: "2026-12-18" }], { now: NOW }));
    expect(lines).toContain("DTSTART;VALUE=DATE:20261218");
  });

  it("takes an all-day item's day from its start, in the place's own zone", () => {
    // 03:00Z on the 20th is still the 19th in Los Angeles.
    const lines = unfold(icsForItems([{ id: "x", title: "Arrive", allDay: true, start: { at: "2026-12-20T03:00:00Z", tz: "America/Los_Angeles" } }], { now: NOW }));
    expect(lines).toContain("DTSTART;VALUE=DATE:20261219");
  });

  it("ignores an end date that is before the first day", () => {
    const lines = unfold(icsForItems([{ id: "x", title: "Oops", allDay: true, localDate: "2026-12-19", endDate: "2026-12-01" }], { now: NOW }));
    expect(lines).toContain("DTEND;VALUE=DATE:20261220");
  });
});

describe("icsForItems: what goes in and what stays out", () => {
  it("leaves out items with no date at all", () => {
    const ics = icsForItems([{ id: "nodate", title: "Sometime" }, flight], { now: NOW });
    expect(ics).not.toContain("nodate");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("writes an empty but valid calendar for no items", () => {
    const lines = unfold(icsForItems([], { now: NOW }));
    expect(lines).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//etoile//Plans//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "END:VCALENDAR", ""]);
  });

  it("never writes two entries with one UID", () => {
    const ics = icsForItems([flight, { ...flight, title: "Duplicate" }], { now: NOW });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).not.toContain("Duplicate");
  });

  it("writes no DTEND when the end is missing or not after the start", () => {
    const noEnd = icsForItems([{ ...flight, end: null }], { now: NOW });
    expect(noEnd).not.toContain("DTEND");
    const backwards = icsForItems([{ ...flight, end: { at: "2026-12-19T10:00:00Z", tz: "UTC" } }], { now: NOW });
    expect(backwards).not.toContain("DTEND");
  });

  it("marks a cancelled item", () => {
    expect(unfold(icsForItems([{ ...flight, cancelled: true }], { now: NOW }))).toContain("STATUS:CANCELLED");
  });

  it("uses a place's name and address for the location, and never its phone or notes", () => {
    const ics = icsForItems(
      [
        {
          id: "stay",
          title: "Stay",
          allDay: true,
          localDate: "2026-12-19",
          place: {
            kind: "lodging",
            name: "Lakeside House",
            addressLines: ["1420 Lake Shore Dr"],
            locality: "Orlando",
            region: "FL",
            postalCode: "32803",
            tz: "America/New_York",
            phone: "+1 407-555-0100",
            notes: "Door code 4417",
          },
        },
      ],
      { now: NOW },
    );
    expect(unfold(ics)).toContain("LOCATION:Lakeside House\\, 1420 Lake Shore Dr\\, Orlando\\, FL 32803");
    expect(ics).not.toContain("4417");
    expect(ics).not.toContain("555-0100");
  });

  it("adds a link only when it is a web address", () => {
    expect(unfold(icsForItems([{ ...flight, url: "https://etoile.app/hartley-christmas" }], { now: NOW }))).toContain("URL:https://etoile.app/hartley-christmas");
    expect(icsForItems([{ ...flight, url: "javascript:alert(1)" }], { now: NOW })).not.toContain("URL:");
  });

  it("gives an untitled item a title rather than an empty SUMMARY", () => {
    expect(unfold(icsForItems([{ ...flight, title: "  " }], { now: NOW }))).toContain("SUMMARY:Untitled");
  });
});

describe("escaping", () => {
  it("escapes backslash, semicolon, comma and newline, and nothing else", () => {
    expect(escapeIcsText("JFK Terminal 7, Queens, NY")).toBe("JFK Terminal 7\\, Queens\\, NY");
    expect(escapeIcsText("a;b")).toBe("a\\;b");
    expect(escapeIcsText("C:\\path")).toBe("C:\\\\path");
    expect(escapeIcsText("line one\nline two")).toBe("line one\\nline two");
    expect(escapeIcsText("Departs 6:00 PM")).toBe("Departs 6:00 PM");
  });

  it("turns CRLF and bare CR into one escaped newline and drops other control characters", () => {
    expect(escapeIcsText("a\r\nb\rc")).toBe("a\\nb\\nc");
    expect(escapeIcsText("a\u0000b\u0007c\td")).toBe("abcd");
  });

  it("cannot be used to inject a second property", () => {
    const ics = icsForItems([{ ...flight, title: "Dinner\r\nATTENDEE:mailto:x@example.com" }], { now: NOW });
    expect(unfold(ics).some((line) => line.startsWith("ATTENDEE"))).toBe(false);
    expect(unfold(ics)).toContain("SUMMARY:Dinner\\nATTENDEE:mailto:x@example.com");
  });
});

describe("folding at 75 octets", () => {
  it("leaves a short line alone", () => {
    expect(foldIcsLine("SUMMARY:Short")).toBe("SUMMARY:Short");
  });

  it("leaves a line of exactly 75 octets alone and folds one of 76", () => {
    const exact = `SUMMARY:${"a".repeat(67)}`;
    expect(bytes(exact)).toBe(75);
    expect(foldIcsLine(exact)).toBe(exact);
    const over = `${exact}b`;
    expect(foldIcsLine(over)).toBe(`${exact}\r\n b`);
  });

  it("keeps every physical line within 75 octets, counting the leading space", () => {
    const folded = foldIcsLine(`DESCRIPTION:${"word ".repeat(80)}`);
    for (const line of folded.split("\r\n")) expect(bytes(line)).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").slice(1).every((line) => line.startsWith(" "))).toBe(true);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 40 accented letters are 40 characters but 80 bytes.
    const line = `SUMMARY:${"é".repeat(40)}`;
    expect(line.length).toBeLessThan(75);
    const parts = foldIcsLine(line).split("\r\n");
    expect(parts.length).toBe(2);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(75);
  });

  it("never splits a multi-byte character, even an emoji", () => {
    const text = `SUMMARY:${"🎄".repeat(30)} Étoile ${"日本語".repeat(20)}`;
    const folded = foldIcsLine(text);
    for (const part of folded.split("\r\n")) {
      expect(bytes(part)).toBeLessThanOrEqual(75);
      // A split surrogate pair or UTF-8 sequence would not survive a round trip.
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(part))).toBe(part);
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(text);
  });

  it("folds long lines inside a whole file and unfolds back to the same text", () => {
    const long = "A very long description with accents: café, Étoile, naïve. ".repeat(6).trim();
    const ics = icsForItems([{ ...flight, description: long }], { now: NOW, localTimeNote: false });
    for (const line of ics.split("\r\n")) expect(bytes(line)).toBeLessThanOrEqual(75);
    expect(unfold(ics)).toContain(`DESCRIPTION:${escapeIcsText(long)}`);
  });
});

describe("small pieces", () => {
  it("formats a UTC stamp from any instant form", () => {
    expect(icsUtcStamp("2026-12-18T23:00:00Z")).toBe("20261218T230000Z");
    expect(icsUtcStamp(new Date("2026-12-18T23:00:00Z"))).toBe("20261218T230000Z");
    expect(icsUtcStamp(Date.UTC(2026, 0, 1, 0, 0, 5))).toBe("20260101T000005Z");
    expect(icsUtcStamp("2026-12-18T18:00:00-05:00")).toBe("20261218T230000Z");
  });

  it("formats a date from the stored string and refuses anything else", () => {
    expect(icsDate("2026-12-18")).toBe("20261218");
    expect(() => icsDate("2026-02-30")).toThrow(RangeError);
    expect(() => icsDate("12/18/2026")).toThrow(RangeError);
  });

  it("builds the UID {id}@etoile and cleans characters a UID should not carry", () => {
    expect(icsUid("abc123")).toBe("abc123@etoile");
    expect(icsUid("bk 1/seg@2")).toBe("bk-1-seg-2@etoile");
    expect(() => icsUid("  ")).toThrow(RangeError);
  });
});
