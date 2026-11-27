// Reading a plan: who is coming, where they are staying, and when each household lands and
// leaves. Proposals, links, next steps and act-by dates all start from these.

import type { Booking, BookingOf, Party, Person } from "@/db/schema";
import { flightDesignator, type DietaryTag, type FlightSegment, type PlaceRef, type RideNeed, type ZonedInstant } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { diffDays, localDateOf } from "@/lib/time";
import type { BookingContext } from "./types";
import { countOf, listOf } from "./wording";

// --- timings --------------------------------------------------------------------------------------
// Design defaults, all in one place. Product spec 5.7 and 10.5.

export const TIMINGS = {
  /** A ride meets a landing this long after it: time to walk off and reach the curb. */
  rideAfterLandingMinutes: 30,
  /** The car is picked up this long after landing: bags, then the rental counter. */
  carAfterLandingMinutes: 45,
  /** The car goes back this long before the flight home. */
  carReturnBeforeFlightMinutes: 150,
  /** Be at the airport this long before a flight within one country. */
  airportMinutesDomestic: 120,
  /** And this long before a flight to another country. */
  airportMinutesInternational: 180,
  /** The drive to the airport when nothing better is known. */
  defaultDriveMinutes: 45,
  /** A delivery is never planned for earlier than this after check-in. */
  deliveryAfterCheckInMinutes: 60,
  /** Nor earlier than this after landing: bags, the drive, the front door. */
  deliveryAfterLandingMinutes: 120,
  /** The usual time for dinner on arrival night when the day is otherwise open. */
  defaultDinnerTime: "18:30",
  /** How long a delivery window is. */
  deliveryWindowMinutes: 60,
  /** Later than this, most kitchens and shoppers have stopped for the night. */
  lastSensibleDeliveryTime: "21:30",
  /** A child this age or younger needs a child seat in a car. */
  childSeatMaxAge: 7,
} as const;

// --- people ---------------------------------------------------------------------------------------

/** Everyone who has not said no. Until someone replies, they count as coming. */
export function comingPeople(data: PlanData): Person[] {
  return data.people.filter((person) => person.rsvpStatus !== "no");
}

export type HeadCount = {
  total: number;
  adults: number;
  children: number;
  infants: number;
  /** Ages of the children and infants, youngest last, only when every one of them is known. */
  childAges: number[];
  /** True when every child and infant has an age on record (or there are none). */
  agesKnown: boolean;
  /** Children and infants known to need a child seat in a car. */
  needChildSeat: number;
};

/**
 * Counts by traveler type. With no people on the plan yet, `fallbackTotal` (the number given
 * when the plan was made) are all counted as adults.
 */
export function headCount(people: readonly Person[], fallbackTotal = 0): HeadCount {
  if (people.length === 0) {
    const total = Math.max(0, fallbackTotal);
    return { total, adults: total, children: 0, infants: 0, childAges: [], agesKnown: true, needChildSeat: 0 };
  }
  const adults = people.filter((p) => p.ageGroup === "adult").length;
  const kids = people.filter((p) => p.ageGroup !== "adult");
  const children = kids.filter((p) => p.ageGroup === "child").length;
  const infants = kids.length - children;
  const agesKnown = kids.every((p) => typeof p.childAge === "number" || p.ageGroup === "infant");
  // An infant with no age on record is counted as under one.
  const ages = kids.map((p) => (typeof p.childAge === "number" ? p.childAge : p.ageGroup === "infant" ? 0 : null));
  const childAges = agesKnown ? (ages as number[]).slice().sort((a, b) => b - a) : [];
  const needChildSeat = kids.filter(
    (p) => p.ageGroup === "infant" || (typeof p.childAge === "number" && p.childAge <= TIMINGS.childSeatMaxAge),
  ).length;
  return { total: people.length, adults, children, infants, childAges, agesKnown, needChildSeat };
}

/** "7 adults, 2 children", "1 adult", "2 adults, 1 child, 1 infant". */
export function headCountText(count: Pick<HeadCount, "adults" | "children" | "infants">): string {
  const parts: string[] = [];
  if (count.adults) parts.push(countOf(count.adults, "adult", "adults"));
  if (count.children) parts.push(countOf(count.children, "child", "children"));
  if (count.infants) parts.push(countOf(count.infants, "infant", "infants"));
  return parts.length > 0 ? parts.join(", ") : "Nobody yet";
}

/** "9 of you: 7 adults, 2 children". For one adult, or all adults, just "4 adults". */
export function groupText(count: HeadCount): string {
  if (count.total === 0) return "Nobody yet";
  if (count.children + count.infants === 0) return headCountText(count);
  return `${count.total} of you: ${headCountText(count)}`;
}

const DIETARY_WORDS: Readonly<Record<DietaryTag, string>> = {
  vegetarian: "vegetarian",
  vegan: "vegan",
  gluten_free: "gluten-free",
  nut_allergy: "nut allergy",
  shellfish_allergy: "shellfish allergy",
  kosher: "kosher",
  halal: "halal",
  other: "other need",
};

/** "1 vegetarian, 1 nut allergy" from people's replies, or undefined when nobody has any. */
export function dietarySummary(people: readonly Person[]): string | undefined {
  const counts = new Map<DietaryTag, number>();
  for (const person of people) {
    for (const tag of person.dietaryTags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const order = Object.keys(DIETARY_WORDS) as DietaryTag[];
  const parts = order.filter((tag) => counts.has(tag)).map((tag) => `${counts.get(tag)} ${DIETARY_WORDS[tag]}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** The household the organizer is in, else the first household. */
export function organizerParty(data: PlanData): Party | undefined {
  const organizer = data.people.find((person) => person.role === "organizer");
  const sorted = [...data.parties].sort((a, b) => a.sortOrder - b.sortOrder);
  return (organizer && sorted.find((party) => party.id === organizer.partyId)) ?? sorted[0];
}

/** "Lydia, Theo and Mae" for a list of ids, first names only. */
export function firstNames(data: PlanData, personIds: readonly string[]): string {
  const names = personIds
    .map((id) => data.people.find((person) => person.id === id)?.name.trim().split(/\s+/)[0])
    .filter((name): name is string => Boolean(name));
  return listOf(names);
}

// --- bookings -------------------------------------------------------------------------------------

const LIVE_STATUSES = new Set(["booked", "done"]);
const DEAD_STATUSES = new Set(["cancelled", "not_needed"]);

/** True once a confirmation has been recorded. */
export function isBooked(booking: Pick<Booking, "status">): boolean {
  return LIVE_STATUSES.has(booking.status);
}

/** True when the booking was called off or is not needed. */
export function isDead(booking: Pick<Booking, "status">): boolean {
  return DEAD_STATUSES.has(booking.status);
}

export function bookingsOf<K extends Booking["kind"]>(data: PlanData, kind: K): Array<Booking & BookingOf<K>> {
  return data.bookings.filter((booking): booking is Booking & BookingOf<K> => booking.kind === kind && !isDead(booking));
}

/** The stay to plan around: a booked one first, else any that already has dates or a place. */
export function stayOf(data: PlanData): (Booking & BookingOf<"lodging">) | undefined {
  const stays = bookingsOf(data, "lodging");
  return (
    stays.find((stay) => isBooked(stay) && stay.details.place) ??
    stays.find(isBooked) ??
    stays.find((stay) => stay.details.place || stay.details.checkInDate)
  );
}

/** Where people are staying, when a stay with an address is on record. */
export function stayPlace(data: PlanData): PlaceRef | undefined {
  return stayOf(data)?.details.place;
}

// --- landings and departures ----------------------------------------------------------------------

/** One household landing, or leaving: the thing an airport ride, the car and dinner are timed to. */
export type AirportRun = {
  /** Stable: the arrivals row id, or "<bookingId>:<segmentIndex>" when it comes straight from a flight. */
  key: string;
  /** The arrivals row, when there is one. */
  arrivalId?: string;
  direction: "arrival" | "departure";
  /** The landing time (arrival) or take-off time (departure), in the airport's zone. */
  at: ZonedInstant;
  airportIata?: string;
  /** The airport as a place: from the arrivals row, or looked up through ctx.airport. */
  airportPlace?: PlaceRef;
  /** "AS 1054". */
  flight?: string;
  personIds: string[];
  partyId?: string;
  partyName?: string;
  rideNeed: RideNeed;
  rideBookingId?: string;
  driverPersonId?: string;
  bags?: number;
  /** The flight booking it comes from. */
  bookingId?: string;
  /** True when the flight is known to cross a border. */
  international: boolean;
};

const CONNECTION_MAX_MS = 24 * 3_600_000;

/**
 * A flight booking's segments grouped into journeys: a new journey starts when a flight does
 * not leave from where the last one landed, or leaves more than a day later.
 */
export function flightJourneys(segments: readonly FlightSegment[]): Array<{ first: number; last: number }> {
  const journeys: Array<{ first: number; last: number }> = [];
  segments.forEach((segment, index) => {
    const previous = index > 0 ? segments[index - 1] : undefined;
    const gap = previous ? Date.parse(segment.departsAt) - Date.parse(previous.arrivesAt) : Number.NaN;
    const connects = previous && segment.originIata === previous.destinationIata && gap >= 0 && gap <= CONNECTION_MAX_MS;
    if (connects) journeys[journeys.length - 1].last = index;
    else journeys.push({ first: index, last: index });
  });
  return journeys;
}

function airportPlaceFor(ctx: BookingContext, iata: string | undefined, tz: string, given?: PlaceRef | null): PlaceRef | undefined {
  if (given) return given;
  if (!iata) return undefined;
  const found = ctx.airport?.(iata);
  return found ?? { kind: "airport", name: iata, iata, tz };
}

function partyOfPeople(data: PlanData, personIds: readonly string[]): Party | undefined {
  const partyIds = new Set(personIds.map((id) => data.people.find((person) => person.id === id)?.partyId).filter(Boolean));
  if (partyIds.size !== 1) return undefined;
  const [only] = [...partyIds];
  return data.parties.find((party) => party.id === only);
}

function isInternational(ctx: BookingContext, a: string, b: string): boolean {
  const from = ctx.airport?.(a)?.countryCode;
  const to = ctx.airport?.(b)?.countryCode;
  return Boolean(from && to && from !== to);
}

/**
 * Every landing and departure the plan knows about, earliest first: the arrivals board's
 * flights, plus recorded flights that have no row on the board yet. Only flights: people who
 * drive or are already there need no airport ride.
 */
export function airportRuns(ctx: BookingContext): AirportRun[] {
  const { data } = ctx;
  const runs: AirportRun[] = [];
  const flights = bookingsOf(data, "flight");
  const covered = new Set<string>();

  for (const arrival of data.arrivals) {
    if (arrival.mode !== "flight" || arrival.status === "cancelled") continue;
    const booking = arrival.bookingId ? flights.find((flight) => flight.id === arrival.bookingId) : undefined;
    const segment = booking && arrival.segmentIndex != null ? booking.details.segments[arrival.segmentIndex] : undefined;
    const party = data.parties.find((p) => p.id === arrival.partyId);
    const common = {
      key: arrival.id,
      arrivalId: arrival.id,
      direction: arrival.direction,
      personIds: arrival.personIds,
      partyId: arrival.partyId,
      partyName: party?.name,
      rideNeed: arrival.rideNeed,
      rideBookingId: arrival.rideBookingId ?? undefined,
      driverPersonId: arrival.driverPersonId ?? undefined,
      bags: arrival.bags ?? undefined,
    };
    if (booking && segment) {
      covered.add(`${booking.id}:${arrival.direction}`);
      const landing = arrival.direction === "arrival";
      const iata = landing ? segment.destinationIata : segment.originIata;
      const tz = landing ? segment.destinationTz : segment.originTz;
      runs.push({
        ...common,
        at: { at: landing ? segment.arrivesAt : segment.departsAt, tz },
        airportIata: iata,
        airportPlace: airportPlaceFor(ctx, iata, tz, arrival.toPlace),
        flight: flightDesignator(segment),
        bookingId: booking.id,
        international: isInternational(ctx, segment.originIata, segment.destinationIata),
      });
    } else if (arrival.scheduledAt && arrival.tz) {
      const iata = arrival.toPlace?.iata;
      runs.push({
        ...common,
        at: { at: arrival.scheduledAt.toISOString(), tz: arrival.tz },
        airportIata: iata,
        airportPlace: airportPlaceFor(ctx, iata, arrival.tz, arrival.toPlace),
        flight: [arrival.carrier, arrival.number].filter(Boolean).join(" ") || undefined,
        international: false,
      });
    }
  }

  for (const booking of flights) {
    const segments = booking.details.segments;
    if (segments.length === 0) continue;
    const journeys = flightJourneys(segments);
    const picks: Array<{ direction: "arrival" | "departure"; index: number }> = [];
    if (journeys.length >= 2) {
      picks.push({ direction: "arrival", index: journeys[0].last });
      picks.push({ direction: "departure", index: journeys[journeys.length - 1].first });
    } else {
      picks.push(singleJourneyDirection(data, segments, journeys[0]));
    }
    const party = partyOfPeople(data, booking.personIds);
    for (const pick of picks) {
      if (covered.has(`${booking.id}:${pick.direction}`)) continue;
      const segment = segments[pick.index];
      const landing = pick.direction === "arrival";
      const iata = landing ? segment.destinationIata : segment.originIata;
      const tz = landing ? segment.destinationTz : segment.originTz;
      runs.push({
        key: `${booking.id}:${pick.index}`,
        direction: pick.direction,
        at: { at: landing ? segment.arrivesAt : segment.departsAt, tz },
        airportIata: iata,
        airportPlace: airportPlaceFor(ctx, iata, tz),
        flight: flightDesignator(segment),
        personIds: booking.personIds,
        partyId: party?.id,
        partyName: party?.name,
        rideNeed: "unknown",
        bookingId: booking.id,
        international: isInternational(ctx, segment.originIata, segment.destinationIata),
      });
    }
  }

  return runs.sort((a, b) => Date.parse(a.at.at) - Date.parse(b.at.at));
}

/** A one-way booking is the trip home when it leaves nearer the plan's end than its start. */
function singleJourneyDirection(
  data: PlanData,
  segments: readonly FlightSegment[],
  journey: { first: number; last: number },
): { direction: "arrival" | "departure"; index: number } {
  const { startDate, endDate } = data.plan;
  if (startDate && endDate && startDate !== endDate) {
    const leaves = localDateOf(segments[journey.first].departsAt, segments[journey.first].originTz);
    if (Math.abs(diffDays(leaves, endDate)) < Math.abs(diffDays(leaves, startDate))) {
      return { direction: "departure", index: journey.first };
    }
  }
  return { direction: "arrival", index: journey.last };
}

/** The landing to plan the car, the stay and dinner around: the organizer's, else the first. */
export function mainArrival(ctx: BookingContext, runs = airportRuns(ctx)): AirportRun | undefined {
  const arrivals = runs.filter((run) => run.direction === "arrival");
  const organizer = ctx.data.people.find((person) => person.role === "organizer");
  return (organizer && arrivals.find((run) => run.personIds.includes(organizer.id))) ?? arrivals[0];
}

/** The flight home to plan the car return around: the organizer's, else the last. */
export function mainDeparture(ctx: BookingContext, runs = airportRuns(ctx)): AirportRun | undefined {
  const departures = runs.filter((run) => run.direction === "departure");
  const organizer = ctx.data.people.find((person) => person.role === "organizer");
  return (organizer && departures.find((run) => run.personIds.includes(organizer.id))) ?? departures[departures.length - 1];
}

/** The plan's destination zone: where dates such as "the day you arrive" are read. */
export function planZone(data: PlanData): string {
  return data.plan.destination?.tz ?? data.plan.tz;
}
