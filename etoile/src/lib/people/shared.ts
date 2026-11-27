// Small readers over plan rows that several pieces of the plan logic need: who is expected,
// which bookings still count, and how to read a flight booking's two ends. Pure.
//
// Only `import type` from the database schema here, so these modules stay free of the
// database driver and can run anywhere (server, browser, tests).

import type { Booking, Person, Plan } from "@/db/schema";
import type { BookingDetailsOf, BookingKind, BookingStatus, FlightDetails, FlightSegment } from "@/lib/domain";
import { addDays, zonedToUtc } from "@/lib/time";

// --- people -----------------------------------------------------------------------------------

/**
 * True for everyone the plan still expects: anyone who has not said no. People who have not
 * replied yet (or have not been asked) are planned for until they decline.
 */
export function isExpected(person: Pick<Person, "rsvpStatus">): boolean {
  return person.rsvpStatus !== "no";
}

/** True once a person has answered: yes, no or maybe. */
export function hasReplied(person: Pick<Person, "rsvpStatus">): boolean {
  return person.rsvpStatus === "yes" || person.rsvpStatus === "no" || person.rsvpStatus === "maybe";
}

// --- bookings ---------------------------------------------------------------------------------

/** A booking that is part of the plan: anything except cancelled and "not needed". */
export function counts(booking: Pick<Booking, "status">): boolean {
  return booking.status !== "cancelled" && booking.status !== "not_needed";
}

/** A booking with a confirmation on record: "Booked", or its time has passed. */
export function isSettled(booking: Pick<Booking, "status">): boolean {
  return booking.status === "booked" || booking.status === "done";
}

/**
 * A booking far enough along to have a place on the schedule: planned, still looking, booked or
 * done. "Needs you" bookings have no details yet.
 */
export function isUnderway(booking: Pick<Booking, "status">): boolean {
  return booking.status === "planned" || booking.status === "looking" || isSettled(booking);
}

/**
 * Partial credit for a booking's state (product spec 11.2): needed 0, planned 0.25, looking 0.5,
 * booked or done 1. Null for a booking that no longer counts (cancelled, not needed).
 */
export function statusCredit(status: BookingStatus): number | null {
  switch (status) {
    case "needed":
      return 0;
    case "planned":
      return 0.25;
    case "looking":
      return 0.5;
    case "booked":
    case "done":
      return 1;
    case "cancelled":
    case "not_needed":
      return null;
  }
}

/** The booking's details when it is of `kind`, otherwise null. */
export function detailsOf<K extends BookingKind>(booking: Pick<Booking, "details">, kind: K): BookingDetailsOf<K> | null {
  return booking.details.kind === kind ? (booking.details as BookingDetailsOf<K>) : null;
}

/** What to call a place to stay: the property's name, else the place, the vendor or the booking's title. */
export function stayName(booking: Pick<Booking, "details" | "vendorName" | "title">): string {
  const details = detailsOf(booking, "lodging");
  return details?.propertyName ?? details?.place?.name ?? booking.vendorName ?? booking.title;
}

// --- flights ----------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * True when landing on `a` and taking off on `b` is a change of planes: same airport, less than
 * a day apart, and not simply flying straight back to where `a` started (an out-and-back day
 * trip is two journeys, not a connection).
 */
export function isConnection(a: FlightSegment, b: FlightSegment): boolean {
  if (a.destinationIata !== b.originIata) return false;
  if (b.destinationIata === a.originIata) return false;
  const gap = Date.parse(b.departsAt) - Date.parse(a.arrivesAt);
  return gap > -DAY_MS && gap < DAY_MS;
}

/** The index where the journey containing segment `index` begins (walking back through connections). */
export function journeyStart(segments: readonly FlightSegment[], index: number): number {
  let i = index;
  while (i > 0 && isConnection(segments[i - 1], segments[i])) i--;
  return i;
}

/** The index where the journey containing segment `index` ends (walking on through connections). */
export function journeyEnd(segments: readonly FlightSegment[], index: number): number {
  let i = index;
  while (i < segments.length - 1 && isConnection(segments[i], segments[i + 1])) i++;
  return i;
}

/** Which segment of a flight booking lands at the plan's place, and which one leaves it. */
export type FlightEnds = {
  /** Index of the segment that lands at the plan's place, or null when the booking only goes home. */
  arrival: number | null;
  /** Index of the first segment of the trip home, or null when the booking only goes out. */
  departure: number | null;
};

/**
 * Reads a recorded flight booking and says which segment is the arrival and which the departure.
 *
 *  - When the plan's destination names an airport, the first segment into it and the first one
 *    out of it afterwards.
 *  - Otherwise the booking is cut into journeys (runs of connecting segments). With two or more
 *    journeys the first one ends at the plan's place and the last one leaves it.
 *  - A single journey (a one-way ticket, or each direction booked separately) is the way there
 *    when it lands in the first half of the plan's dates and the way home when it lands later.
 *    With no dates it is taken as the way there.
 */
export function flightEnds(
  details: Pick<FlightDetails, "segments" | "tripType">,
  plan: Pick<Plan, "destination" | "startDate" | "endDate" | "tz">,
): FlightEnds {
  const segments = details.segments;
  const n = segments.length;
  if (n === 0) return { arrival: null, departure: null };

  const destination = plan.destination?.iata;
  if (destination) {
    const arrival = segments.findIndex((segment) => segment.destinationIata === destination);
    const departure = segments.findIndex((segment, i) => i > arrival && segment.originIata === destination);
    if (arrival !== -1 || departure !== -1) {
      return { arrival: arrival === -1 ? null : arrival, departure: departure === -1 ? null : departure };
    }
  }

  if (details.tripType !== "one_way") {
    const firstJourneyEnd = journeyEnd(segments, 0);
    const lastJourneyStart = journeyStart(segments, n - 1);
    if (firstJourneyEnd < lastJourneyStart) return { arrival: firstJourneyEnd, departure: lastJourneyStart };
  }

  const lands = Date.parse(segments[n - 1].arrivesAt);
  return landsOnTheWayThere(lands, plan) ? { arrival: n - 1, departure: null } : { arrival: null, departure: 0 };
}

function landsOnTheWayThere(landsMs: number, plan: Pick<Plan, "startDate" | "endDate" | "tz">): boolean {
  if (!plan.startDate || !plan.endDate) return true;
  const start = zonedToUtc(`${plan.startDate}T00:00`, plan.tz).getTime();
  const end = zonedToUtc(`${addDays(plan.endDate, 1)}T00:00`, plan.tz).getTime();
  return landsMs <= (start + end) / 2;
}

/**
 * Who is on a flight booking. The people ticked on it; when nobody is ticked and the plan has a
 * single household (or none), everyone. With several households and nobody ticked the answer is
 * unknown, and the list is empty.
 */
export function flightPassengerIds(
  booking: Pick<Booking, "personIds">,
  data: { people: readonly Pick<Person, "id">[]; parties: readonly unknown[] },
): string[] {
  const known = new Set(data.people.map((person) => person.id));
  const listed = booking.personIds.filter((id) => known.has(id));
  if (listed.length > 0) return listed;
  return data.parties.length <= 1 ? data.people.map((person) => person.id) : [];
}
