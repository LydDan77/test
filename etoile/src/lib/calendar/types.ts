// What the calendar functions take. Deliberately small: there is no field here for a
// confirmation code, a price, a phone number or a private note, so none can leak into a calendar
// file or link by accident. Put only words that every reader of the calendar may see in
// `description`.

import type { PlaceRef, ZonedInstant } from "@/lib/domain";

/**
 * One thing to put in a calendar.
 *
 * Timed: give `start` (and `end` when it is known).
 * All day: set `allDay: true` and give `localDate` (and `endDate` for several days).
 * An item with neither `start` nor `localDate` has no place in a calendar and is left out.
 *
 * For a row of the schedule (a `TimelineItem`), `calendarItemFromTimeline(item)` builds one.
 * For a booking row, `calendarItemsForBooking(booking)` builds them all.
 */
export type CalendarItem = {
  /**
   * Stable id of the plan item. Becomes the calendar UID `{id}@etoile`, so downloading the file
   * again updates the entry instead of adding a second one. Never reuse an id for another item.
   */
  id: string;
  title: string;
  /** When it starts: a UTC instant and the zone of the place where it happens. */
  start?: ZonedInstant | null;
  /** When it ends. Left out, a timed entry has no length in the file and one hour in links. */
  end?: ZonedInstant | null;
  /** True for an all-day entry. An item with no `start` is treated as all-day as well. */
  allDay?: boolean;
  /** The local day it is on (`YYYY-MM-DD`). For an all-day entry, the first day. */
  localDate?: string | null;
  /** For an all-day entry of several days: the LAST day it covers, inclusive. */
  endDate?: string | null;
  /** Where. The name and street address are used; a place's phone and notes never are. */
  place?: PlaceRef | null;
  /** Where, as plain words, when there is no place ("SEA, Terminal N"). Wins over `place`. */
  location?: string | null;
  /** Words anyone holding the calendar may read. Never a code, price, phone or private note. */
  description?: string | null;
  /** A link back to the plan or the share page. */
  url?: string | null;
  /** True when the item was called off. Shown struck through by most calendars. */
  cancelled?: boolean;
};

export type CalendarProvider = "google" | "outlook_personal" | "outlook_work";

/** One "add to calendar" button. */
export type CalendarLink = {
  provider: CalendarProvider;
  /** "Google Calendar", "Outlook.com", "Outlook (work or school)". */
  name: string;
  /** The words for the button: "Add to Google Calendar". */
  actionLabel: string;
  url: string;
  /** Neither Google nor Microsoft documents these links; the format is community-documented. */
  grade: "observed";
  /** Nobody has clicked this link against the live site yet. */
  tested: false;
};

export type IcsOptions = {
  /** The current time (DTSTAMP). Pass it in: this code never reads the clock. */
  now: Date | number | string;
  /** Shown as the calendar's name by apps that import the whole file: "Hartley Family Christmas". */
  calendarName?: string;
  /**
   * Add a first line to each timed entry's notes giving the time where it happens
   * ("Sat, Dec 19, 8:10 AM PST"), because the file itself carries UTC and a calendar shows that
   * in the reader's own zone. Default true.
   */
  localTimeNote?: boolean;
};
