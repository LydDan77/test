import { describe, expect, it } from "vitest";
import { calendarLinks } from "./links";
import { clockText, localTimeLine, placeLine } from "./text";
import type { CalendarItem } from "./types";

// The worked example of research/booking-links.md section 8.
const flight: CalendarItem = {
  id: "evt",
  title: "UA 123 JFK to LHR",
  start: { at: "2026-12-18T23:00:00Z", tz: "America/New_York" },
  end: { at: "2026-12-19T06:00:00Z", tz: "Europe/London" },
  location: "JFK Terminal 7",
  description: "Confirmation ABC123",
};

const byProvider = (item: CalendarItem, opts?: { localTimeNote?: boolean }) => Object.fromEntries(calendarLinks(item, opts).map((link) => [link.provider, link]));

describe("calendarLinks", () => {
  it("builds the Google Calendar link exactly as in the research report", () => {
    expect(byProvider(flight, { localTimeNote: false }).google.url).toBe(
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=UA%20123%20JFK%20to%20LHR&dates=20261218T230000Z/20261219T060000Z&details=Confirmation%20ABC123&location=JFK%20Terminal%207",
    );
  });

  it("builds the Outlook.com link exactly as in the research report", () => {
    expect(byProvider(flight, { localTimeNote: false }).outlook_personal.url).toBe(
      "https://outlook.live.com/calendar/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=UA%20123%20JFK%20to%20LHR&startdt=2026-12-18T23:00:00Z&enddt=2026-12-19T06:00:00Z&location=JFK%20Terminal%207&body=Confirmation%20ABC123",
    );
  });

  it("builds the work Outlook link on the office.com host with the same parameters", () => {
    const links = byProvider(flight, { localTimeNote: false });
    expect(links.outlook_work.url).toBe(links.outlook_personal.url.replace("outlook.live.com", "outlook.office.com"));
  });

  it("offers Google, personal Outlook and work Outlook, in that order, with labels that say where they go", () => {
    expect(calendarLinks(flight).map((link) => [link.provider, link.actionLabel])).toEqual([
      ["google", "Add to Google Calendar"],
      ["outlook_personal", "Add to Outlook.com"],
      ["outlook_work", "Add to Outlook (work or school)"],
    ]);
    expect(calendarLinks(flight).every((link) => link.tested === false && link.grade === "observed")).toBe(true);
  });

  it("starts the notes with the local time by default, since the link carries UTC", () => {
    const details = new URL(byProvider(flight).google.url).searchParams.get("details");
    expect(details).toBe("Local time: Fri, Dec 18, 6:00 PM EST – Sat, Dec 19, 6:00 AM GMT\nConfirmation ABC123");
  });

  it("writes an all-day stay with the end on the day after the last day", () => {
    const stay: CalendarItem = { id: "s", title: "Stay: Lakeside House", allDay: true, localDate: "2026-12-18", endDate: "2026-12-21" };
    const links = byProvider(stay);
    expect(links.google.url).toBe("https://calendar.google.com/calendar/render?action=TEMPLATE&text=Stay%3A%20Lakeside%20House&dates=20261218/20261222");
    expect(links.outlook_personal.url).toBe(
      "https://outlook.live.com/calendar/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=Stay%3A%20Lakeside%20House&startdt=2026-12-18&enddt=2026-12-22&allday=true",
    );
  });

  it("gives a timed item with no end one hour", () => {
    const links = byProvider({ ...flight, end: null }, { localTimeNote: false });
    expect(links.google.url).toContain("dates=20261218T230000Z/20261219T000000Z");
    expect(links.outlook_personal.url).toContain("startdt=2026-12-18T23:00:00Z&enddt=2026-12-19T00:00:00Z");
  });

  it("returns nothing for an item with no date", () => {
    expect(calendarLinks({ id: "x", title: "Sometime" })).toEqual([]);
  });

  it("encodes text safely", () => {
    const url = byProvider({ ...flight, title: "Dinner & drinks: 50% off?", description: "a=b&c=d #tag" }, { localTimeNote: false }).google.url;
    const params = new URL(url).searchParams;
    expect(params.get("text")).toBe("Dinner & drinks: 50% off?");
    expect(params.get("details")).toBe("a=b&c=d #tag");
    expect(params.get("action")).toBe("TEMPLATE");
  });

  it("keeps every link under 2,000 characters by shortening the notes", () => {
    const long = { ...flight, description: "Bring the café menu, the piñata and Étoile's list. ".repeat(200) };
    for (const link of calendarLinks(long)) {
      expect(link.url.length).toBeLessThanOrEqual(1900);
      expect(link.url).toContain("UA%20123");
      expect(() => new URL(link.url)).not.toThrow();
    }
    const details = new URL(byProvider(long).google.url).searchParams.get("details") ?? "";
    expect(details.endsWith("…")).toBe(true);
  });
});

describe("words", () => {
  it("writes a local time of day the way the rest of the app does", () => {
    expect(clockText("16:00")).toBe("4:00 PM");
    expect(clockText("00:05")).toBe("12:05 AM");
    expect(clockText("12:00")).toBe("12:00 PM");
    expect(clockText("not a time")).toBe("not a time");
  });

  it("says the local time of an item in the place's own zone", () => {
    const at = (iso: string, tz: string) => ({ at: iso, tz });
    expect(localTimeLine({ id: "a", title: "t", start: at("2026-12-19T15:35:00Z", "America/Los_Angeles") })).toBe("Sat, Dec 19, 7:35 AM PST");
    expect(localTimeLine({ id: "a", title: "t", start: at("2026-12-19T23:30:00Z", "America/New_York"), end: at("2026-12-20T00:30:00Z", "America/New_York") })).toBe("Sat, Dec 19, 6:30 PM – 7:30 PM EST");
    expect(localTimeLine({ id: "a", title: "t", allDay: true, localDate: "2026-12-19" })).toBeNull();
  });

  it("writes a place on one line without repeating itself", () => {
    expect(placeLine({ kind: "address", name: "1420 Lake Shore Dr", addressLines: ["1420 Lake Shore Dr"], locality: "Orlando", region: "FL", postalCode: "32803", tz: "America/New_York" })).toBe("1420 Lake Shore Dr, Orlando, FL 32803");
    expect(placeLine({ kind: "city", name: "Orlando", tz: "America/New_York" })).toBe("Orlando");
  });
});
