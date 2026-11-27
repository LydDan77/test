// Builders for plan rows, for tests and hand-built example plans.
//
// Each builder returns a complete database row (every column, with the schema's defaults) from
// the few fields a test cares about, so pure plan logic can be driven without a database:
//
//   const data = makePlanData({ plan: makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" }) });
//
// Booking details are run through the real Zod schemas, so a fixture that could not be stored
// fails loudly here instead of quietly testing a shape the app never sees.

import type {
  Arrival,
  Booking,
  Expense,
  ItineraryItem,
  Party,
  Person,
  Plan,
  Settlement,
  Site,
  Task,
} from "@/db/schema";
import {
  parseBookingDetails,
  type BookingDetailsOf,
  type BookingKind,
  type FlightSegment,
  type PlaceRef,
  type ZonedInstant,
} from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { zonedToUtc } from "@/lib/time";

const CREATED = new Date("2026-01-01T00:00:00Z");
const stamps = { createdAt: CREATED, updatedAt: CREATED };

let sequence = 0;
/** A short readable id, unique within the process: "person_12". */
export function testId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

// --- places -------------------------------------------------------------------------------------

/** Zones of the airports the fixtures use. */
export const AIRPORT_ZONES: Record<string, string> = {
  SEA: "America/Los_Angeles",
  PDX: "America/Los_Angeles",
  LAX: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  DEN: "America/Denver",
  MSP: "America/Chicago",
  ORD: "America/Chicago",
  AUS: "America/Chicago",
  DFW: "America/Chicago",
  MCO: "America/New_York",
  TPA: "America/New_York",
  JFK: "America/New_York",
  ATL: "America/New_York",
  YYZ: "America/Toronto",
  HNL: "Pacific/Honolulu",
  LHR: "Europe/London",
  CDG: "Europe/Paris",
  NRT: "Asia/Tokyo",
  SYD: "Australia/Sydney",
  AKL: "Pacific/Auckland",
};

export function airport(iata: string, name = iata): PlaceRef {
  const tz = AIRPORT_ZONES[iata];
  if (!tz) throw new Error(`testing.ts does not know the airport ${iata}`);
  return { kind: "airport", name, iata, tz };
}

export const SEATTLE: PlaceRef = { kind: "home", name: "Seattle", tz: "America/Los_Angeles", countryCode: "US" };
export const ORLANDO: PlaceRef = { kind: "city", name: "Orlando", tz: "America/New_York", countryCode: "US" };

/** A wall-clock reading somewhere, as the ZonedInstant the app stores: at("2026-12-19T16:10", "America/New_York"). */
export function at(local: string, tz: string): ZonedInstant {
  return { at: zonedToUtc(local, tz).toISOString(), tz };
}

// --- rows ---------------------------------------------------------------------------------------

export function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: testId("plan"),
    ownerId: "user_1",
    template: "family_event",
    workMode: null,
    title: "Test plan",
    destination: ORLANDO,
    origin: SEATTLE,
    stops: [],
    startDate: null,
    endDate: null,
    dateStatus: "fixed",
    tz: over.destination?.tz ?? ORLANDO.tz,
    expectedPeople: 1,
    archivedAt: null,
    currency: "USD",
    budgetTotal: null,
    replyDeadline: null,
    projectCode: null,
    purpose: null,
    kindsInUse: [],
    kindsNotNeeded: [],
    isExample: false,
    ...stamps,
    ...over,
  };
}

export function makeParty(planId: string, name: string, over: Partial<Party> = {}): Party {
  const id = over.id ?? testId("party");
  return { id, planId, name, origin: null, guestToken: `token-${id}`, notes: null, sortOrder: 0, ...stamps, ...over };
}

export function makePerson(party: Pick<Party, "id" | "planId">, name: string, over: Partial<Person> = {}): Person {
  return {
    id: testId("person"),
    planId: party.planId,
    partyId: party.id,
    name,
    email: null,
    phone: null,
    role: "guest",
    ageGroup: "adult",
    childAge: null,
    dietaryTags: [],
    dietaryNote: null,
    accessNote: null,
    canDrive: false,
    vehicleSeats: null,
    lodgingBookingId: null,
    room: null,
    team: null,
    jobTitle: null,
    guestToken: null,
    privateNotes: null,
    rsvpStatus: "yes",
    rsvpAt: null,
    rsvpVia: null,
    rsvpAnswers: {},
    messageToHost: null,
    needsHostConfirmation: false,
    ...stamps,
    ...over,
  };
}

export function makeArrival(
  party: Pick<Party, "id" | "planId">,
  direction: Arrival["direction"],
  over: Partial<Arrival> = {},
): Arrival {
  return {
    id: testId("arrival"),
    planId: party.planId,
    partyId: party.id,
    personIds: [],
    direction,
    mode: "flight",
    bookingId: null,
    segmentIndex: null,
    carrier: null,
    number: null,
    fromLabel: null,
    toPlace: null,
    scheduledAt: null,
    tz: null,
    expectedAt: null,
    source: "organizer",
    rideNeed: "unknown",
    driverPersonId: null,
    rideBookingId: null,
    bags: null,
    status: "unknown",
    statusAt: null,
    statusBy: null,
    ...stamps,
    ...over,
  };
}

/** Input to the details of a booking of one kind: anything its Zod schema accepts, `kind` left out. */
export type DetailsInput<K extends BookingKind> = Partial<Omit<BookingDetailsOf<K>, "kind">>;

/**
 * A booking of `kind` whose details went through the kind's real schema (defaults filled in).
 * Throws when the details could not be stored.
 */
export function makeBooking<K extends BookingKind>(
  planId: string,
  kind: K,
  details: DetailsInput<K> = {},
  over: Partial<Omit<Booking, "kind" | "details">> = {},
): Booking {
  const parsed = parseBookingDetails(kind, details);
  if (!parsed.ok) throw new Error(`Bad ${kind} details in a fixture: ${parsed.error}`);
  return {
    id: testId(kind),
    planId,
    kind,
    status: "booked",
    title: kind,
    personIds: [],
    provider: null,
    vendorName: null,
    confirmationCode: null,
    priceAmount: null,
    priceCurrency: null,
    paidByPersonId: null,
    expenseId: null,
    startsAt: null,
    startTz: null,
    endsAt: null,
    endTz: null,
    actBy: {},
    cancelBy: null,
    guestProvided: false,
    notes: null,
    details: parsed.details,
    ...stamps,
    ...over,
  };
}

/**
 * One flight segment from what a ticket prints: seg("AS 1054", "SEA", "2026-12-19T08:10", "MCO", "2026-12-19T16:41").
 * Times are local to each airport.
 */
export function seg(
  flight: string,
  from: string,
  departsLocal: string,
  to: string,
  arrivesLocal: string,
  over: Partial<FlightSegment> = {},
): FlightSegment {
  const [airlineIata, flightNumber] = flight.split(" ");
  const originTz = airport(from).tz;
  const destinationTz = airport(to).tz;
  return {
    airlineIata,
    flightNumber,
    originIata: from,
    destinationIata: to,
    departsAt: zonedToUtc(departsLocal, originTz).toISOString(),
    originTz,
    arrivesAt: zonedToUtc(arrivesLocal, destinationTz).toISOString(),
    destinationTz,
    ...over,
  };
}

export function makeItem(planId: string, title: string, over: Partial<ItineraryItem> = {}): ItineraryItem {
  return {
    id: testId("item"),
    planId,
    type: "event",
    title,
    startsAt: null,
    startTz: ORLANDO.tz,
    endsAt: null,
    endTz: null,
    localDate: "2026-12-19",
    allDay: false,
    place: null,
    personIds: [],
    visibility: "public",
    isKeyMoment: false,
    description: null,
    link: null,
    owner: null,
    room: null,
    track: null,
    status: "confirmed",
    changedAt: null,
    ...stamps,
    ...over,
  };
}

/**
 * A timed schedule item from local times at its place:
 * timedItem(planId, "Welcome dinner", "2026-12-19T18:30", "2026-12-19T20:00", { place }).
 */
export function timedItem(
  planId: string,
  title: string,
  startLocal: string,
  endLocal: string | null,
  over: Partial<ItineraryItem> = {},
): ItineraryItem {
  const tz = over.startTz ?? over.place?.tz ?? ORLANDO.tz;
  return makeItem(planId, title, {
    startsAt: zonedToUtc(startLocal, tz),
    startTz: tz,
    endsAt: endLocal ? zonedToUtc(endLocal, over.endTz ?? tz) : null,
    endTz: endLocal ? (over.endTz ?? tz) : null,
    localDate: startLocal.slice(0, 10),
    ...over,
  });
}

export function makeTask(planId: string, title: string, over: Partial<Task> = {}): Task {
  return {
    id: testId("task"),
    planId,
    kind: "todo",
    title,
    notes: null,
    essential: false,
    dueDate: null,
    assigneePersonId: null,
    claimedByPersonId: null,
    claimedByName: null,
    quantity: null,
    done: false,
    doneAt: null,
    source: "user",
    ruleKey: null,
    bookingId: null,
    sortOrder: 0,
    ...stamps,
    ...over,
  };
}

/** An expense in minor units: makeExpense(planId, "Publix", 18_420, { paidByPersonId }). */
export function makeExpense(planId: string, merchant: string, amount: number, over: Partial<Expense> = {}): Expense {
  return {
    id: testId("expense"),
    planId,
    date: "2026-12-19",
    merchant,
    description: null,
    category: "other",
    amount,
    currency: "USD",
    paidByPersonId: null,
    paymentMethod: "personal_card",
    split: { method: "none", parts: [] },
    reimbursable: false,
    billable: false,
    projectCode: null,
    attendeeIds: [],
    bookingId: null,
    receipt: "none",
    status: "paid",
    ...stamps,
    ...over,
  };
}

export function makeSettlement(
  planId: string,
  fromPersonId: string,
  toPersonId: string,
  amount: number,
  over: Partial<Settlement> = {},
): Settlement {
  return {
    id: testId("settlement"),
    planId,
    fromPersonId,
    toPersonId,
    amount,
    currency: "USD",
    method: null,
    settledAt: CREATED,
    ...stamps,
    ...over,
  };
}

export function makeSite(planId: string, over: Partial<Site> = {}): Site {
  return {
    id: testId("site"),
    planId,
    slug: `plan-${planId}`,
    status: "draft",
    access: "link",
    passcodeHash: null,
    theme: "invitation",
    accent: "evergreen",
    colorScheme: "auto",
    title: "Test plan",
    subtitle: null,
    hostLine: null,
    announcement: null,
    repliesOpen: true,
    replyDeadline: null,
    replyByParty: true,
    allowMaybe: true,
    whoIsComing: "first_names",
    publishedAt: null,
    unpublishOn: null,
    viewCount: 0,
    sections: [],
    rsvpQuestions: [],
    ...stamps,
    ...over,
  };
}

/** A whole plan from the parts a test sets; everything else is empty. */
export function makePlanData(parts: Partial<PlanData> = {}): PlanData {
  return {
    plan: parts.plan ?? makePlan(),
    parties: [],
    people: [],
    arrivals: [],
    bookings: [],
    handoffs: [],
    items: [],
    tasks: [],
    expenses: [],
    settlements: [],
    site: null,
    ...parts,
  };
}
