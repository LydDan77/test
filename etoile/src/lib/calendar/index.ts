// Calendars: a correct .ics file and "add to calendar" links. Import from "@/lib/calendar".
//
//   icsForItems(items, { now })          the file, for Apple Calendar, Outlook and Google import
//   calendarLinks(item)                  Google Calendar and Outlook (personal, work) buttons
//   calendarItemsForBooking(booking)     a booking row as calendar items, public fields only
//   calendarItemFromTimeline(row)        one row of the schedule as a calendar item
//
// Pure, no React, no clock: `now` is always an argument.

export * from "./types";
export { icsForItems, foldIcsLine, escapeIcsText, icsUid, icsUtcStamp, icsDate } from "./ics";
export { calendarLinks } from "./links";
export { calendarItemsForBooking, calendarItemFromTimeline } from "./from-booking";
export type { TimelineLike } from "./from-booking";
export { placeLine, localTimeLine, clockText } from "./text";
