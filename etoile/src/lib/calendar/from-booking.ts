// Booking rows to calendar items. This is the one place that decides what a calendar may say
// about a booking, and it only ever reads public fields: the title, the times and the place.
//
// NEVER read here: confirmationCode, priceAmount, notes, a stay's accessNotes or contactPhone, a
// meal's orderNumber, total or tip, a place's phone or notes. A calendar entry gets forwarded,
// synced to a work account and shown on lock screens.

import type { Booking } from "@/db/schema";
import { flightDesignator, flightSegmentTimes, type ZonedInstant } from "@/lib/domain";
import { addDays, compareDates } from "@/lib/time";
import { clockText } from "./text";
import type { CalendarItem } from "./types";

function timed(
  id: string,
  title: string,
  start: ZonedInstant,
  extra: Partial<CalendarItem> = {},
): CalendarItem {
  return { id, title, start, ...extra };
}

/**
 * The calendar entries for one booking, with stable ids derived from the booking's id:
 *   flight    one entry per flight ("AS 1054 SEA to MCO"), take-off to landing
 *   stay      one all-day entry from check-in to the last night, with the times in the notes
 *   car       one entry for the pick-up and one for the return
 *   ride      one entry at the pick-up time
 *   food      one entry for the delivery window
 *   send ahead one all-day entry on the last safe day to ship
 * A booking with no dates yet gives an empty list. A cancelled booking's entries are marked
 * cancelled, so downloading again strikes them out instead of leaving stale ones behind.
 *
 * Pass the result to `icsForItems` (a file, for Apple Calendar and Outlook) or each item to
 * `calendarLinks` (Google and Outlook buttons).
 */
export function calendarItemsForBooking(booking: Booking): CalendarItem[] {
  if (booking.status === "not_needed") return [];
  const cancelled = booking.status === "cancelled";
  const details = booking.details;
  const items: CalendarItem[] = [];

  switch (details.kind) {
    case "flight": {
      details.segments.forEach((segment, index) => {
        const { departs, arrives } = flightSegmentTimes(segment);
        const terminal = segment.terminal ? `, ${/terminal/i.test(segment.terminal) ? segment.terminal : `Terminal ${segment.terminal}`}` : "";
        items.push(
          timed(`${booking.id}-flight-${index}`, `${flightDesignator(segment)} ${segment.originIata} to ${segment.destinationIata}`, departs, {
            end: arrives,
            location: `${segment.originIata}${terminal}`,
            description: segment.airlineName
              ? `${segment.airlineName} flight ${segment.flightNumber} from ${segment.originIata} to ${segment.destinationIata}.`
              : null,
          }),
        );
      });
      break;
    }
    case "lodging": {
      if (!details.checkInDate) break;
      const name = details.propertyName ?? details.place?.name ?? booking.title;
      const checkOut = details.checkOutDate;
      // The last night is the day before check-out; the file's end date is exclusive, so the
      // entry runs up to, and not including, check-out day.
      const lastNight = checkOut && compareDates(checkOut, details.checkInDate) > 0 ? addDays(checkOut, -1) : details.checkInDate;
      const times = [`Check-in from ${clockText(details.checkInTime)}.`];
      if (checkOut) times.push(`Check-out by ${clockText(details.checkOutTime)}.`);
      items.push({
        id: `${booking.id}-stay`,
        title: `Stay: ${name}`,
        allDay: true,
        localDate: details.checkInDate,
        endDate: lastNight,
        place: details.place ?? null,
        description: times.join(" "),
      });
      break;
    }
    case "car": {
      const company = details.company ? `: ${details.company}` : "";
      if (details.pickupAt) {
        items.push(timed(`${booking.id}-car-pickup`, `Pick up the car${company}`, details.pickupAt, { place: details.pickupPlace ?? null }));
      }
      if (details.returnAt) {
        items.push(
          timed(`${booking.id}-car-return`, `Return the car${company}`, details.returnAt, {
            place: details.returnPlace ?? details.pickupPlace ?? null,
          }),
        );
      }
      break;
    }
    case "ride": {
      if (!details.pickupAt) break;
      const title = details.toPlace ? `Ride to ${details.toPlace.name}` : booking.title;
      items.push(
        timed(`${booking.id}-ride`, title, details.pickupAt, {
          place: details.fromPlace ?? null,
          description: details.fromPlace ? `Pick-up at ${details.fromPlace.name}.` : null,
        }),
      );
      break;
    }
    case "meal": {
      if (!details.windowStart) break;
      const what =
        details.mealType === "groceries" ? "Groceries delivered" : details.mealType === "catering" ? "Catering delivered" : "Food delivered";
      items.push(
        timed(`${booking.id}-food`, details.vendorName ? `${what}: ${details.vendorName}` : what, details.windowStart, {
          end: details.windowEnd ?? null,
          place: details.deliverToPlace ?? null,
        }),
      );
      break;
    }
    case "shipment": {
      if (!details.shipByDate) break;
      items.push({
        id: `${booking.id}-ship-by`,
        title: `Last safe day to send: ${booking.title}`,
        allDay: true,
        localDate: details.shipByDate,
      });
      break;
    }
  }

  return cancelled ? items.map((item) => ({ ...item, cancelled: true })) : items;
}

/**
 * The parts of a schedule row (`TimelineItem` from src/lib/itinerary) that a calendar needs.
 * Written out here, rather than imported, so the calendar code does not depend on the schedule
 * code: any object with these fields will do.
 */
export type TimelineLike = {
  /** Stable and unique in the timeline: "item:<id>" or "booking:<id>:<part>". */
  key: string;
  title: string;
  start: ZonedInstant | null;
  end: ZonedInstant | null;
  localDate: string;
  allDay: boolean;
  place: CalendarItem["place"];
  /** Words the person wrote on a hand-made item. */
  description?: string | null;
  link?: string | null;
  status?: string | null;
};

/**
 * One row of the schedule as a calendar entry. Its `key` becomes the calendar id, so the entry
 * is stable for as long as the row is. Only the title, the times, the place's name and address,
 * the person's own description and link are carried over.
 *
 * Decide what a reader may see BEFORE calling this: pass only rows whose `visibility` suits the
 * audience (rows that come from a booking are private to the organizer).
 */
export function calendarItemFromTimeline(item: TimelineLike): CalendarItem {
  return {
    id: item.key,
    title: item.title,
    start: item.start,
    end: item.end,
    allDay: item.allDay || !item.start,
    localDate: item.localDate,
    place: item.place ?? null,
    description: item.description ?? null,
    url: item.link ?? null,
    cancelled: item.status === "cancelled",
  };
}
