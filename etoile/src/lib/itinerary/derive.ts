// The schedule: one sorted timeline for a plan.
//
// Only hand-made items (events, sessions, notes) are stored. Everything that comes from a
// booking is worked out here on every read and never stored: each flight segment, check-in
// and check-out, car pickup and return, rides, food deliveries and send-ahead due dates.
// Change the booking and the schedule follows.
//
// Every time is an instant with the zone of the place where it happens (a flight leaves in the
// origin airport's time and lands in the destination's). The day an item sits on is the local
// date at its own place.
//
// Nothing private is copied onto a timeline item: no confirmation codes, prices, door codes or
// notes. Items that come from bookings are "private" (the organizer's eyes only); use
// timelineFor() to get what guests or the public may see.

import type { Booking, ItineraryItem } from "@/db/schema";
import {
  flightDesignator,
  type BookingStatus,
  type ItemVisibility,
  type ItineraryItemType,
  type ItineraryStatus,
  type PlaceRef,
  type ZonedInstant,
} from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { isSettled, isUnderway, stayName } from "@/lib/people/shared";
import { count, durationWords, firstNameOf, upperFirst } from "@/lib/people/text";
import {
  calendarDayDifference,
  compareDates,
  formatDate,
  localDateOf,
  nightsBetween,
  toEpochMs,
  zonedToUtc,
  type InstantInput,
  type LocalDate,
} from "@/lib/time";

/** What an item is. The first three are hand-made; the rest come from bookings. */
export type TimelineItemType =
  | ItineraryItemType
  | "flight"
  | "check_in"
  | "check_out"
  | "car_pickup"
  | "car_return"
  | "ride"
  | "meal"
  | "shipment_due";

export type TimelineFlight = {
  /** "AS 1054". */
  designator: string;
  originIata: string;
  destinationIata: string;
  /** Minutes in the air (gate to gate). */
  durationMinutes: number;
  /** Calendar days between the departure date and the landing date: 1 for a red-eye, -1 eastbound over the date line. */
  dayShift: number;
  /** A later landing time someone entered by hand. Null when nothing changed. */
  expectedArrival: ZonedInstant | null;
};

export type TimelineItem = {
  /** Stable, unique in the timeline: "item:<id>", or "booking:<id>:<part>". */
  key: string;
  type: TimelineItemType;
  /** Plain words: "Flight AS 1054, SEA to MCO", "Check in at Lakeside house", "Welcome dinner". */
  title: string;
  /** A short second line, when there is one: "5 hours 31 minutes. Lands the next day." */
  detail: string | null;
  /** When it starts, in the time of the place where it happens. Null for an item with a day and no time. */
  start: ZonedInstant | null;
  /** When it ends. For a flight this is the landing, in the destination's time. */
  end: ZonedInstant | null;
  /** The day it sits on, local to where it starts. */
  localDate: LocalDate;
  /** The zone `localDate` is in. */
  tz: string;
  allDay: boolean;
  place: PlaceRef | null;
  /** Where it ends, when that is somewhere else (a flight's destination, a ride's drop-off). */
  endPlace: PlaceRef | null;
  /** The booking it came from; null for a hand-made item. Such items are edited through the booking. */
  bookingId: string | null;
  /** The stored item it is; null for an item that came from a booking. */
  itemId: string | null;
  /** For a flight: which segment of the booking. */
  segmentIndex: number | null;
  /** Who it involves. Empty together with `everyone: true` means everybody in the plan. */
  personIds: string[];
  everyone: boolean;
  /** "private" items are for the organizer only. Everything that comes from a booking is private. */
  visibility: ItemVisibility;
  isKeyMoment: boolean;
  /** For an item from a booking: "confirmed" once booked, "tentative" while it is only planned. */
  status: ItineraryStatus;
  /** The booking's own state, for the word beside the row ("Planned", "Booked"). */
  bookingStatus: BookingStatus | null;
  flight: TimelineFlight | null;
  // Hand-made items only.
  description: string | null;
  link: string | null;
  owner: string | null;
  room: string | null;
  track: string | null;
  changedAt: Date | null;
};

export type ItineraryInput = Pick<PlanData, "plan" | "bookings" | "items" | "people">;

export type DeriveOptions = {
  /**
   * The city an airport serves ("SEA" gives "Seattle"), for flight titles in plain words.
   * Left out, titles use the airport codes.
   */
  airportCity?: (iata: string) => string | null | undefined;
};

/**
 * The whole schedule: hand-made items plus everything the bookings imply, sorted.
 *
 *   const timeline = deriveItinerary(planData);
 *   const days = groupByDay(timeline, planData.plan);          // for the Schedule screen
 *   const shared = timelineFor(timeline, "guests");            // what a share page may show
 *
 * Order: by the local day an item sits on; within a day, all-day items, then timed items by
 * instant, then items with no time.
 *
 * Bookings appear once they have details: planned, still looking, booked or done. A planned
 * item is "tentative". Cancelled and not-needed bookings never appear; a cancelled hand-made
 * item stays in the list with status "cancelled" so a screen can show it struck through.
 */
export function deriveItinerary(input: ItineraryInput, options: DeriveOptions = {}): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  for (const item of input.items) timeline.push(fromStoredItem(item));
  for (const booking of input.bookings) {
    if (!isUnderway(booking)) continue;
    timeline.push(...fromBooking(booking, input, options));
  }
  return timeline.sort(compareTimeline);
}

/**
 * The timeline as someone other than the organizer may see it.
 *  - "organizer": everything.
 *  - "guests": people who opened a personal link or entered the passcode: "guests" and "public" items.
 *  - "public": anyone with the page address: "public" items only.
 * Private items (which include every booking) are never in the "guests" or "public" result.
 */
export function timelineFor(timeline: readonly TimelineItem[], audience: "organizer" | "guests" | "public"): TimelineItem[] {
  if (audience === "organizer") return [...timeline];
  return timeline.filter((item) => item.visibility === "public" || (audience === "guests" && item.visibility === "guests"));
}

/** The items that involve any of these people (items for everyone always do). */
export function timelineForPeople(timeline: readonly TimelineItem[], personIds: readonly string[]): TimelineItem[] {
  const ids = new Set(personIds);
  return timeline.filter((item) => item.everyone || item.personIds.some((id) => ids.has(id)));
}

/** The next timed items that have not started yet, soonest first: for "what's next" on Home. */
export function upcomingItems(timeline: readonly TimelineItem[], now: InstantInput, limit = 3): TimelineItem[] {
  const nowMs = toEpochMs(now);
  return timeline
    .filter((item) => item.start !== null && item.status !== "cancelled" && toEpochMs(item.start.at) >= nowMs)
    .sort((a, b) => toEpochMs(a.start!.at) - toEpochMs(b.start!.at))
    .slice(0, limit);
}

// --- sorting ------------------------------------------------------------------------------------

const TYPE_ORDER: TimelineItemType[] = [
  "shipment_due", "note", "flight", "car_pickup", "ride", "check_in", "check_out", "car_return", "meal", "event", "session",
];

function sectionRank(item: TimelineItem): number {
  if (item.allDay) return 0;
  return item.start ? 1 : 2;
}

/** The order of the timeline: day, then all-day, timed (by instant), untimed. */
export function compareTimeline(a: TimelineItem, b: TimelineItem): number {
  return (
    compareDates(a.localDate, b.localDate) ||
    sectionRank(a) - sectionRank(b) ||
    (a.start && b.start ? toEpochMs(a.start.at) - toEpochMs(b.start.at) : 0) ||
    TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
    a.title.localeCompare(b.title) ||
    a.key.localeCompare(b.key)
  );
}

// --- hand-made items ------------------------------------------------------------------------------

function fromStoredItem(item: ItineraryItem): TimelineItem {
  const start: ZonedInstant | null = item.startsAt ? { at: item.startsAt.toISOString(), tz: item.startTz } : null;
  const end: ZonedInstant | null = item.endsAt ? { at: item.endsAt.toISOString(), tz: item.endTz ?? item.startTz } : null;
  return {
    key: `item:${item.id}`,
    type: item.type,
    title: item.title,
    detail: null,
    start,
    end,
    localDate: item.localDate,
    tz: item.startTz,
    allDay: item.allDay,
    place: item.place,
    endPlace: null,
    bookingId: null,
    itemId: item.id,
    segmentIndex: null,
    personIds: [...item.personIds],
    everyone: item.personIds.length === 0,
    visibility: item.visibility,
    isKeyMoment: item.isKeyMoment,
    status: item.status,
    bookingStatus: null,
    flight: null,
    description: item.description,
    link: item.link,
    owner: item.owner,
    room: item.room,
    track: item.track,
    changedAt: item.changedAt,
  };
}

// --- items from bookings ------------------------------------------------------------------------

type Derived = Pick<TimelineItem, "key" | "type" | "title" | "localDate" | "tz"> & Partial<TimelineItem>;

function derived(booking: Booking, personIds: string[], fields: Derived): TimelineItem {
  return {
    detail: null,
    start: null,
    end: null,
    allDay: false,
    place: null,
    endPlace: null,
    bookingId: booking.id,
    itemId: null,
    segmentIndex: null,
    personIds,
    everyone: personIds.length === 0,
    // Bookings carry private details and are never shown on a share page through the timeline.
    visibility: "private",
    isKeyMoment: false,
    status: isSettled(booking) ? "confirmed" : "tentative",
    bookingStatus: booking.status,
    flight: null,
    description: null,
    link: null,
    owner: null,
    room: null,
    track: null,
    changedAt: null,
    ...fields,
  };
}

function unique(ids: (string | null | undefined)[], known: Set<string>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && known.has(id)))];
}

function fromBooking(booking: Booking, input: ItineraryInput, options: DeriveOptions): TimelineItem[] {
  const known = new Set(input.people.map((person) => person.id));
  const nameOf = (id: string | undefined) => {
    const person = id ? input.people.find((p) => p.id === id) : undefined;
    return person ? firstNameOf(person.name) : null;
  };
  const planTz = input.plan.tz;

  switch (booking.details.kind) {
    case "flight": {
      const people = unique(booking.personIds, known);
      return booking.details.segments.map((segment, index) => {
        const start: ZonedInstant = { at: segment.departsAt, tz: segment.originTz };
        const end: ZonedInstant = { at: segment.arrivesAt, tz: segment.destinationTz };
        const minutes = Math.round((toEpochMs(end.at) - toEpochMs(start.at)) / 60_000);
        const dayShift = calendarDayDifference(start.at, start.tz, end.at, end.tz);
        const from = options.airportCity?.(segment.originIata) ?? segment.originIata;
        const to = options.airportCity?.(segment.destinationIata) ?? segment.destinationIata;
        const expected =
          segment.expectedArrivalAt && toEpochMs(segment.expectedArrivalAt) !== toEpochMs(segment.arrivesAt)
            ? { at: segment.expectedArrivalAt, tz: segment.destinationTz }
            : null;
        const lands =
          dayShift === 0
            ? ""
            : dayShift === 1
              ? " Lands the next day."
              : dayShift === -1
                ? " Lands the day before on the calendar."
                : dayShift > 1
                  ? ` Lands ${dayShift} days later.`
                  : ` Lands ${-dayShift} days earlier on the calendar.`;
        return derived(booking, people, {
          key: `booking:${booking.id}:segment:${index}`,
          type: "flight",
          title: `Flight ${flightDesignator(segment)}, ${from} to ${to}`,
          detail: `${upperFirst(durationWords(minutes))} in the air.${lands}`,
          start,
          end,
          localDate: localDateOf(start.at, start.tz),
          tz: start.tz,
          place: airportPlace(segment.originIata, segment.originTz, options),
          endPlace: airportPlace(segment.destinationIata, segment.destinationTz, options),
          segmentIndex: index,
          flight: {
            designator: flightDesignator(segment),
            originIata: segment.originIata,
            destinationIata: segment.destinationIata,
            durationMinutes: minutes,
            dayShift,
            expectedArrival: expected,
          },
        });
      });
    }

    case "lodging": {
      const d = booking.details;
      const tz = d.place?.tz ?? planTz;
      const roomPeople = d.rooms.flatMap((room) => room.personIds);
      const chosen = input.people.filter((person) => person.lodgingBookingId === booking.id).map((person) => person.id);
      const people = unique([...booking.personIds, ...roomPeople, ...chosen], known);
      const name = stayName(booking);
      const withFamily = d.lodgingType === "family_home";
      const items: TimelineItem[] = [];
      if (d.checkInDate) {
        const at = zonedToUtc(`${d.checkInDate}T${d.checkInTime}`, tz).toISOString();
        items.push(
          derived(booking, people, {
            key: `booking:${booking.id}:check_in`,
            type: "check_in",
            title: withFamily ? `Arrive at ${name}` : `Check in at ${name}`,
            detail: d.checkOutDate ? `${count(nightsBetween(d.checkInDate, d.checkOutDate), "night")}.` : null,
            start: { at, tz },
            localDate: d.checkInDate,
            tz,
            place: d.place ?? null,
          }),
        );
      }
      if (d.checkOutDate) {
        const at = zonedToUtc(`${d.checkOutDate}T${d.checkOutTime}`, tz).toISOString();
        items.push(
          derived(booking, people, {
            key: `booking:${booking.id}:check_out`,
            type: "check_out",
            title: withFamily ? `Leave ${name}` : `Check out of ${name}`,
            start: { at, tz },
            localDate: d.checkOutDate,
            tz,
            place: d.place ?? null,
          }),
        );
      }
      return items;
    }

    case "car": {
      const d = booking.details;
      const people = unique([...d.driverPersonIds, ...booking.personIds], known);
      const company = d.company ?? booking.vendorName;
      const car = d.vehicleClass && d.vehicleClass !== "other" ? vehicleWords(d.vehicleClass) : "car";
      const items: TimelineItem[] = [];
      if (d.pickupAt) {
        items.push(
          derived(booking, people, {
            key: `booking:${booking.id}:car_pickup`,
            type: "car_pickup",
            title: d.pickupPlace ? `Pick up the ${car} at ${placeWords(d.pickupPlace)}` : `Pick up the ${car}`,
            detail: company ? `${company}.` : null,
            start: d.pickupAt,
            localDate: localDateOf(d.pickupAt.at, d.pickupAt.tz),
            tz: d.pickupAt.tz,
            place: d.pickupPlace ?? null,
          }),
        );
      }
      if (d.returnAt) {
        const where = d.returnPlace ?? d.pickupPlace;
        items.push(
          derived(booking, people, {
            key: `booking:${booking.id}:car_return`,
            type: "car_return",
            title: where ? `Return the ${car} at ${placeWords(where)}` : `Return the ${car}`,
            detail: company ? `${company}.` : null,
            start: d.returnAt,
            localDate: localDateOf(d.returnAt.at, d.returnAt.tz),
            tz: d.returnAt.tz,
            place: where ?? null,
          }),
        );
      }
      return items;
    }

    case "ride": {
      const d = booking.details;
      if (!d.pickupAt) return [];
      const people = unique([...d.passengerIds, d.driverPersonId, ...booking.personIds], known);
      const driver = nameOf(d.driverPersonId);
      const from = d.fromPlace ? placeWords(d.fromPlace) : null;
      const to = d.toPlace ? placeWords(d.toPlace) : null;
      const route = from && to ? ` from ${from} to ${to}` : from ? ` from ${from}` : to ? ` to ${to}` : "";
      const what =
        d.rideType === "shuttle" ? "Shuttle" : d.rideType === "taxi" ? "Taxi" : driver ? `${driver} drives` : d.rideType === "personal_pickup" ? "Pickup" : "Ride";
      const provider = booking.provider ?? booking.vendorName;
      return [
        derived(booking, people, {
          key: `booking:${booking.id}:ride`,
          type: "ride",
          title: `${what}${route}`,
          detail: provider && !driver ? `${upperFirst(provider)}.` : null,
          start: d.pickupAt,
          localDate: localDateOf(d.pickupAt.at, d.pickupAt.tz),
          tz: d.pickupAt.tz,
          place: d.fromPlace ?? null,
          endPlace: d.toPlace ?? null,
        }),
      ];
    }

    case "meal": {
      const d = booking.details;
      if (!d.windowStart) return [];
      const people = unique(booking.personIds, known);
      const vendor = d.vendorName ?? booking.vendorName;
      const title =
        d.mealType === "groceries"
          ? vendor ? `Groceries from ${vendor}` : "Groceries delivered"
          : d.mealType === "catering"
            ? vendor ? `Catering from ${vendor}` : "Catering arrives"
            : vendor ? `Food from ${vendor}` : "Food delivery";
      return [
        derived(booking, people, {
          key: `booking:${booking.id}:meal`,
          type: "meal",
          title,
          detail: d.headcount ? `For ${count(d.headcount, "person", "people")}.` : null,
          start: d.windowStart,
          end: d.windowEnd ?? null,
          localDate: localDateOf(d.windowStart.at, d.windowStart.tz),
          tz: d.windowStart.tz,
          place: d.deliverToPlace ?? null,
        }),
      ];
    }

    case "shipment": {
      const d = booking.details;
      if (!d.shipByDate) return [];
      const sent = d.parcels.length > 0 && d.parcels.every((p) => p.status === "shipped" || p.status === "delivered" || p.status === "picked_up");
      if (sent || booking.status === "done") return [];
      const what = shipmentWords(d.shipmentKind, d.parcels.length);
      const home = d.direction === "return";
      return [
        derived(booking, unique(booking.personIds, known), {
          key: `booking:${booking.id}:ship_by`,
          type: "shipment_due",
          title: home ? `Send ${what} home by today` : `Send ${what} by today`,
          detail: d.targetDeliveryDate ? `So it arrives by ${formatDate(d.targetDeliveryDate, { weekday: true })}.` : null,
          localDate: d.shipByDate,
          // Sent from home on the way out, from the plan's place on the way back.
          tz: home ? planTz : input.plan.origin.tz,
          allDay: true,
        }),
      ];
    }
  }
}

function airportPlace(iata: string, tz: string, options: DeriveOptions): PlaceRef {
  const city = options.airportCity?.(iata);
  return city ? { kind: "airport", name: `${city} (${iata})`, locality: city, iata, tz } : { kind: "airport", name: iata, iata, tz };
}

/** An airport reads as its code, anything else as its name. */
function placeWords(place: PlaceRef): string {
  return place.kind === "airport" && place.iata ? place.iata : place.name;
}

function vehicleWords(vehicleClass: string): string {
  switch (vehicleClass) {
    case "minivan":
      return "minivan";
    case "van":
      return "van";
    case "suv":
      return "SUV";
    case "pickup":
      return "pickup truck";
    default:
      return "car";
  }
}

/** "the box", "2 boxes", "the luggage": what is being sent, for a sentence. */
export function shipmentWords(kind: string | undefined, parcels: number): string {
  const [one, many] =
    kind === "luggage"
      ? ["the luggage", "bags"]
      : kind === "gift"
        ? ["the gifts", "boxes of gifts"]
        : kind === "gear"
          ? ["the gear", "boxes of gear"]
          : kind === "mail"
            ? ["the mail", "pieces of mail"]
            : kind === "retail_order"
              ? ["the order", "orders"]
              : ["the box", "boxes"];
  return parcels > 1 ? `${parcels} ${many}` : one;
}

// The conflict rules live next door. They are re-exported here because the build spec names
// this file as the home of both functions.
export { detectConflicts, type Conflict, type ConflictKind, type ConflictLevel, type ConflictOptions } from "./conflicts";
