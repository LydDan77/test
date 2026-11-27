// A hand-built plan for the booking tests: "Hartley Family Christmas", nine people in four
// households going to Orlando, Dec 19 to 27, 2026. Plus small factories for every row type, so a
// test can change one thing and keep the rest. Not used by the app.

import type { Arrival, Booking, Handoff, Party, Person, Plan, Task } from "@/db/schema";
import { emptyBookingDetails, type BookingDetailsOf, type BookingKind, type PlaceRef } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import type { BookingContext } from "../types";

const CREATED = new Date("2026-11-01T12:00:00Z");
const stamps = { createdAt: CREATED, updatedAt: CREATED };

/** Fri, Nov 27, 2026, 10:00 AM in Seattle: 22 days before the plan starts. */
export const NOW = new Date("2026-11-27T18:00:00Z");

export const SEATTLE: PlaceRef = { kind: "home", name: "Seattle", region: "WA", countryCode: "US", lat: 47.6062, lon: -122.3321, tz: "America/Los_Angeles" };
export const ORLANDO: PlaceRef = { kind: "city", name: "Orlando", region: "FL", countryCode: "US", lat: 28.5384, lon: -81.3789, tz: "America/New_York" };
export const LAKESIDE_HOUSE: PlaceRef = {
  kind: "lodging",
  name: "Lakeside House",
  addressLines: ["1420 Lake Shore Dr"],
  locality: "Orlando",
  region: "FL",
  postalCode: "32803",
  countryCode: "US",
  lat: 28.5632,
  lon: -81.3601,
  tz: "America/New_York",
  phone: "+1 407-555-0100",
  notes: "Door code 4417",
};

export const AIRPORTS: Record<string, PlaceRef> = {
  SEA: { kind: "airport", name: "Seattle-Tacoma International Airport", iata: "SEA", locality: "Seattle", region: "WA", countryCode: "US", lat: 47.4502, lon: -122.3088, tz: "America/Los_Angeles" },
  MCO: { kind: "airport", name: "Orlando International Airport", iata: "MCO", locality: "Orlando", region: "FL", countryCode: "US", lat: 28.4312, lon: -81.3081, tz: "America/New_York" },
  PDX: { kind: "airport", name: "Portland International Airport", iata: "PDX", locality: "Portland", region: "OR", countryCode: "US", lat: 45.5898, lon: -122.5951, tz: "America/Los_Angeles" },
  ORD: { kind: "airport", name: "O'Hare International Airport", iata: "ORD", locality: "Chicago", region: "IL", countryCode: "US", lat: 41.9742, lon: -87.9073, tz: "America/Chicago" },
  LHR: { kind: "airport", name: "Heathrow Airport", iata: "LHR", locality: "London", countryCode: "GB", lat: 51.47, lon: -0.4543, tz: "Europe/London" },
};

export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan1",
    ownerId: "user1",
    template: "family_event",
    workMode: null,
    title: "Hartley Family Christmas",
    destination: ORLANDO,
    origin: SEATTLE,
    stops: [],
    startDate: "2026-12-19",
    endDate: "2026-12-27",
    dateStatus: "fixed",
    tz: "America/New_York",
    expectedPeople: 9,
    archivedAt: null,
    currency: "USD",
    budgetTotal: null,
    replyDeadline: null,
    projectCode: null,
    purpose: null,
    kindsInUse: ["flight", "lodging", "car", "ride", "meal", "shipment"],
    kindsNotNeeded: [],
    isExample: false,
    ...stamps,
    ...overrides,
  };
}

export function makeParty(overrides: Partial<Party> & Pick<Party, "id" | "name">): Party {
  return { planId: "plan1", origin: null, guestToken: `token-${overrides.id}`, notes: null, sortOrder: 0, ...stamps, ...overrides };
}

export function makePerson(overrides: Partial<Person> & Pick<Person, "id" | "name" | "partyId">): Person {
  return {
    planId: "plan1",
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
    ...overrides,
  };
}

export function makeBooking<K extends BookingKind>(
  kind: K,
  overrides: Partial<Omit<Booking, "kind" | "details">> & { id: string; details?: Partial<BookingDetailsOf<K>> },
): Booking {
  const { details, ...rest } = overrides;
  return {
    planId: "plan1",
    kind,
    status: "needed",
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
    ...stamps,
    ...rest,
    details: { ...emptyBookingDetails(kind), ...details },
  } as Booking;
}

export function makeArrival(overrides: Partial<Arrival> & Pick<Arrival, "id" | "partyId" | "direction" | "mode">): Arrival {
  return {
    planId: "plan1",
    personIds: [],
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
    status: "scheduled",
    statusAt: null,
    statusBy: null,
    ...stamps,
    ...overrides,
  };
}

export function makeHandoff(overrides: Partial<Handoff> & Pick<Handoff, "id" | "bookingId" | "provider">): Handoff {
  return {
    planId: "plan1",
    url: "https://example.com/",
    linkGrade: "observed",
    unfilled: [],
    openedAt: new Date("2026-11-20T18:00:00Z"),
    outcome: null,
    resolvedAt: null,
    ...stamps,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    planId: "plan1",
    kind: "todo",
    notes: null,
    essential: false,
    dueDate: null,
    assigneePersonId: null,
    claimedByPersonId: null,
    claimedByName: null,
    quantity: null,
    done: false,
    doneAt: null,
    source: "rule",
    ruleKey: null,
    bookingId: null,
    sortOrder: 0,
    ...stamps,
    ...overrides,
  };
}

export function planData(parts: Partial<PlanData> = {}): PlanData {
  return {
    plan: makePlan(),
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

// --- the Hartleys -----------------------------------------------------------------------------------

export const PARTIES = {
  seattle: makeParty({ id: "party-sea", name: "The Seattle Hartleys", sortOrder: 0 }),
  portland: makeParty({ id: "party-pdx", name: "The Portland Hartleys", sortOrder: 1, origin: { kind: "city", name: "Portland", region: "OR", countryCode: "US", iata: "PDX", tz: "America/Los_Angeles" } }),
  chicago: makeParty({ id: "party-ord", name: "Aunt Carol", sortOrder: 2, origin: { kind: "city", name: "Chicago", region: "IL", countryCode: "US", iata: "ORD", tz: "America/Chicago" } }),
  orlando: makeParty({ id: "party-orl", name: "Grandma and Grandpa", sortOrder: 3, origin: ORLANDO }),
};

export const PEOPLE = {
  lydia: makePerson({ id: "p-lydia", name: "Lydia Hartley", partyId: "party-sea", role: "organizer", dietaryTags: ["vegetarian"] }),
  mark: makePerson({ id: "p-mark", name: "Mark Hartley", partyId: "party-sea" }),
  theo: makePerson({ id: "p-theo", name: "Theo Hartley", partyId: "party-sea", ageGroup: "child", childAge: 9, dietaryTags: ["nut_allergy"] }),
  mae: makePerson({ id: "p-mae", name: "Mae Hartley", partyId: "party-sea", ageGroup: "child", childAge: 5 }),
  dana: makePerson({ id: "p-dana", name: "Dana Hartley", partyId: "party-pdx" }),
  chris: makePerson({ id: "p-chris", name: "Chris Hartley", partyId: "party-pdx" }),
  carol: makePerson({ id: "p-carol", name: "Carol Hartley", partyId: "party-ord", rsvpStatus: "invited" }),
  rob: makePerson({ id: "p-rob", name: "Rob Hartley", partyId: "party-orl", canDrive: true, vehicleSeats: 4 }),
  june: makePerson({ id: "p-june", name: "June Hartley", partyId: "party-orl" }),
};

const SEATTLE_FOUR = ["p-lydia", "p-mark", "p-theo", "p-mae"];

/** AS 1054 SEA to MCO on Dec 19 (lands 4:10 PM Eastern) and AS 1055 back on Dec 27 (leaves 10:30 AM Eastern). */
export const SEATTLE_FLIGHTS = makeBooking("flight", {
  id: "b-flight-sea",
  status: "booked",
  title: "AS 1054 SEA to MCO",
  personIds: SEATTLE_FOUR,
  confirmationCode: "KXWQPL",
  priceAmount: 179944,
  priceCurrency: "USD",
  details: {
    tripType: "round_trip",
    cabin: "economy",
    segments: [
      { airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO", departsAt: "2026-12-19T15:35:00Z", originTz: "America/Los_Angeles", arrivesAt: "2026-12-19T21:10:00Z", destinationTz: "America/New_York" },
      { airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "1055", originIata: "MCO", destinationIata: "SEA", departsAt: "2026-12-27T15:30:00Z", originTz: "America/New_York", arrivesAt: "2026-12-27T21:45:00Z", destinationTz: "America/Los_Angeles" },
    ],
  },
});

export const LAKESIDE_STAY = makeBooking("lodging", {
  id: "b-stay",
  status: "booked",
  title: "Lakeside House",
  confirmationCode: "HMXQ4T9RPA",
  priceAmount: 456413,
  priceCurrency: "USD",
  notes: "Ask Marisol about the kayak",
  details: {
    lodgingType: "rental",
    propertyName: "Lakeside House",
    place: LAKESIDE_HOUSE,
    checkInDate: "2026-12-19",
    checkInTime: "16:00",
    checkOutDate: "2026-12-27",
    checkOutTime: "11:00",
    accessNotes: "Door code 4417. Wi-Fi: lakehouse / heron2218",
    contactPhone: "+1 407-555-0100",
  },
});

export const CAR_NEEDED = makeBooking("car", { id: "b-car", status: "needed", title: "Car" });

export const ARRIVALS = {
  seattleIn: makeArrival({ id: "a-sea-in", partyId: "party-sea", direction: "arrival", mode: "flight", personIds: SEATTLE_FOUR, bookingId: "b-flight-sea", segmentIndex: 0, source: "booking", bags: 4 }),
  seattleOut: makeArrival({ id: "a-sea-out", partyId: "party-sea", direction: "departure", mode: "flight", personIds: SEATTLE_FOUR, bookingId: "b-flight-sea", segmentIndex: 1, source: "booking" }),
  // Typed in by the Portland household on their own page: DL 2210, landing 3:55 PM Eastern.
  portlandIn: makeArrival({
    id: "a-pdx-in",
    partyId: "party-pdx",
    direction: "arrival",
    mode: "flight",
    personIds: ["p-dana", "p-chris"],
    carrier: "DL",
    number: "2210",
    fromLabel: "Portland",
    toPlace: AIRPORTS.MCO,
    scheduledAt: new Date("2026-12-19T20:55:00Z"),
    tz: "America/New_York",
    source: "guest",
    rideNeed: "needs_ride",
    bags: 3,
  }),
  orlandoIn: makeArrival({ id: "a-orl-in", partyId: "party-orl", direction: "arrival", mode: "local", personIds: ["p-rob", "p-june"], rideNeed: "not_needed" }),
};

/** The whole example: nine people, the Seattle flights and the lake house booked, a car still needed. */
export function hartley(parts: Partial<PlanData> = {}): PlanData {
  return planData({
    parties: Object.values(PARTIES),
    people: Object.values(PEOPLE),
    arrivals: Object.values(ARRIVALS),
    bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, CAR_NEEDED],
    ...parts,
  });
}

/** A context for the plan given: Lydia at home in Seattle, the airport table wired in. */
export function contextFor(data: PlanData, overrides: Partial<BookingContext> = {}): BookingContext {
  return {
    data,
    home: SEATTLE,
    homeAirportIata: "SEA",
    now: NOW,
    airport: (iata) => AIRPORTS[iata],
    ...overrides,
  };
}
