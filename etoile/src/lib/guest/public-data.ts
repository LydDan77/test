// What a share page may hold. Pure: no database, no request.
//
// PlanData (src/lib/plan-data.ts) is everything about a plan, for its organizer: guest tokens,
// the passcode hash, emails, phone numbers, private notes, confirmation codes, prices, door
// codes. A share page must never hold that object, not even to pass it to a function that only
// reads the title: whatever a component holds can end up in the HTML or in the data sent to the
// browser.
//
// toPublicPlanData() makes the copy a share page works with instead. It is built the safe way
// round: every table and every booking kind has a short list of fields that MAY appear, and
// anything not on a list is left out. A column added later is therefore private until someone
// decides otherwise, here, in one place. public-data.test.ts plants a secret in every private
// field and checks that none of them comes out.
//
// The lists implement the rules that do not bend (product spec 9.3): never on any page are
// confirmation codes, prices paid, expenses, door codes and Wi-Fi passwords, private notes,
// and guests' email addresses and phone numbers. Which sections a page shows, and names
// following `whoIsComing`, are the share page's own business on top of this.

import type { Arrival, Booking, ItineraryItem, Party, Person, Plan, Site, Task } from "@/db/schema";
import { sectionIsVisibleTo, type BookingDetails, type PlaceRef, type SiteSection } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";

/** "guest": opened a personal link or entered the passcode. "everyone": has only the address. */
export type Viewer = "everyone" | "guest";

function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (row[key] !== undefined) out[key] = row[key];
  return out;
}

// --- the lists ------------------------------------------------------------------------------------

const PLAN = ["id", "template", "workMode", "title", "destination", "stops", "startDate", "endDate", "dateStatus", "tz", "replyDeadline", "isExample"] as const satisfies readonly (keyof Plan)[];
const PARTY = ["id", "name", "sortOrder"] as const satisfies readonly (keyof Party)[];
const PERSON = ["id", "partyId", "name", "role", "ageGroup", "team", "jobTitle", "room", "lodgingBookingId", "rsvpStatus"] as const satisfies readonly (keyof Person)[];
const ARRIVAL = [
  "id", "partyId", "personIds", "direction", "mode", "bookingId", "segmentIndex", "carrier", "number", "fromLabel", "toPlace",
  "scheduledAt", "tz", "expectedAt", "rideNeed", "driverPersonId", "rideBookingId", "status", "statusAt",
] as const satisfies readonly (keyof Arrival)[];
const BOOKING = ["id", "kind", "status", "title", "personIds", "vendorName", "startsAt", "startTz", "endsAt", "endTz"] as const satisfies readonly (keyof Booking)[];
const ITEM = [
  "id", "type", "title", "startsAt", "startTz", "endsAt", "endTz", "localDate", "allDay", "place", "personIds", "visibility",
  "isKeyMoment", "description", "link", "owner", "room", "track", "status", "changedAt",
] as const satisfies readonly (keyof ItineraryItem)[];
const TASK = ["id", "kind", "title", "quantity", "claimedByPersonId", "claimedByName", "done", "sortOrder"] as const satisfies readonly (keyof Task)[];
const SITE = [
  "id", "slug", "status", "access", "theme", "accent", "colorScheme", "title", "subtitle", "hostLine", "announcement", "repliesOpen",
  "replyDeadline", "replyByParty", "allowMaybe", "whoIsComing", "publishedAt", "unpublishOn", "rsvpQuestions",
] as const satisfies readonly (keyof Site)[];

export type PublicPlan = Pick<Plan, (typeof PLAN)[number]>;
export type PublicParty = Pick<Party, (typeof PARTY)[number]>;
export type PublicPerson = Pick<Person, (typeof PERSON)[number]>;
export type PublicArrival = Pick<Arrival, (typeof ARRIVAL)[number]>;
export type PublicItem = Pick<ItineraryItem, (typeof ITEM)[number]>;
export type PublicTask = Pick<Task, (typeof TASK)[number]>;
export type PublicSite = Pick<Site, (typeof SITE)[number]> & { sections: SiteSection[] };
/** A booking as a page may show it: no code, no price, no payer, no notes, and public details only. */
export type PublicBooking = Pick<Booking, (typeof BOOKING)[number]> & { details: BookingDetails };

/** A place without what the organizer typed for themselves: a home or a stay loses its notes and phone. */
export function toPublicPlace(place: PlaceRef): PlaceRef;
export function toPublicPlace(place: PlaceRef | null | undefined): PlaceRef | null;
export function toPublicPlace(place: PlaceRef | null | undefined): PlaceRef | null {
  if (!place) return null;
  if (place.kind !== "home" && place.kind !== "lodging" && place.kind !== "address") return place;
  const { notes: _notes, phone: _phone, ...rest } = place;
  void _notes;
  void _phone;
  return rest;
}

/** The part of a booking's details a page may show, or null for a kind that never appears (shipments). */
export function toPublicBookingDetails(details: BookingDetails): BookingDetails | null {
  switch (details.kind) {
    case "flight":
      return {
        kind: "flight",
        // Flight number, airports, times and terminals. Not who sits where, not the search.
        segments: details.segments.map((segment) =>
          pick(segment, ["airlineIata", "airlineName", "flightNumber", "originIata", "destinationIata", "departsAt", "originTz", "arrivesAt", "destinationTz", "terminal", "arrivalTerminal", "statusNote", "expectedArrivalAt"]),
        ),
      };
    case "lodging":
      return {
        ...pick(details, ["kind", "lodgingType", "propertyName", "checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "rooms", "roomBlock"]),
        // Not accessNotes (door code, Wi-Fi), contactName, contactPhone or the package policy.
        ...(details.place ? { place: toPublicPlace(details.place) } : {}),
      };
    case "car":
      return {
        ...pick(details, ["kind", "company", "vehicleClass", "seats", "pickupAt", "returnAt", "driverPersonIds"]),
        ...(details.pickupPlace ? { pickupPlace: toPublicPlace(details.pickupPlace) } : {}),
        ...(details.returnPlace ? { returnPlace: toPublicPlace(details.returnPlace) } : {}),
      };
    case "ride":
      return {
        ...pick(details, ["kind", "rideType", "pickupAt", "passengerIds", "driverPersonId", "vehicleSeats", "arrivalIds"]),
        ...(details.fromPlace ? { fromPlace: toPublicPlace(details.fromPlace) } : {}),
        ...(details.toPlace ? { toPlace: toPublicPlace(details.toPlace) } : {}),
      };
    case "meal":
      return {
        // When and where the food arrives. Not the order number, the total, the tip or the list.
        ...pick(details, ["kind", "mealType", "vendorName", "windowStart", "windowEnd", "headcount"]),
        list: [],
        ...(details.deliverToPlace ? { deliverToPlace: toPublicPlace(details.deliverToPlace) } : {}),
      };
    case "shipment":
      return null;
  }
}

export type PublicPlanData = {
  viewer: Viewer;
  plan: PublicPlan;
  site: PublicSite;
  /** Empty for "everyone": who is coming is for guests. `counts` is always filled. */
  parties: PublicParty[];
  people: PublicPerson[];
  /** How many people the plan has and how many have said yes, for "12 coming". */
  counts: { people: number; yes: number; maybe: number; no: number };
  /** Empty for "everyone": arrivals are guests-only and cannot be made public. */
  arrivals: PublicArrival[];
  /** Bookings a page can show something of. Shipments never; cancelled and not-needed ones left out. */
  bookings: PublicBooking[];
  /** Hand-made schedule items: never the private ones, and the guests-only ones only for a guest. */
  items: PublicItem[];
  /** "Things to bring" and the packing list. Never to-dos. */
  tasks: PublicTask[];
};

/**
 * The copy of a plan that a share page works with. Give it the PlanData of a plan whose page
 * exists (`data.site` is not null), and who is looking; from then on, hold only what it returns.
 *
 * Left out entirely: hand-offs, expenses, settlements, shipments, to-dos, and every field not on
 * the lists at the top of this file (guest tokens, the passcode hash, emails, phones, private
 * notes, dietary and access notes, replies' answers and messages to the host, confirmation
 * codes, prices, payers, booking notes, lodging access notes, order numbers and totals).
 */
export function toPublicPlanData(data: PlanData, viewer: Viewer): PublicPlanData {
  if (!data.site) throw new Error("toPublicPlanData: this plan has no share page");
  const guest = viewer === "guest";

  const plan: PublicPlan = {
    ...pick(data.plan, PLAN),
    destination: toPublicPlace(data.plan.destination),
    stops: data.plan.stops.map((stop) => ({ ...stop, place: toPublicPlace(stop.place) })),
  };
  const site: PublicSite = {
    ...pick(data.site, SITE),
    // Only the sections this visitor may see are handed over at all.
    sections: data.site.sections.filter((section) => sectionIsVisibleTo(section, viewer)),
  };

  const bookings: PublicBooking[] = [];
  for (const booking of data.bookings) {
    if (booking.status === "cancelled" || booking.status === "not_needed") continue;
    const details = toPublicBookingDetails(booking.details);
    if (details) bookings.push({ ...pick(booking, BOOKING), details });
  }

  const reply = (status: Person["rsvpStatus"]) => data.people.filter((person) => person.rsvpStatus === status).length;
  return {
    viewer,
    plan,
    site,
    parties: guest ? data.parties.map((party) => pick(party, PARTY)) : [],
    people: guest ? data.people.map((person) => pick(person, PERSON)) : [],
    counts: { people: data.people.length, yes: reply("yes"), maybe: reply("maybe"), no: reply("no") },
    arrivals: guest ? data.arrivals.map((arrival) => ({ ...pick(arrival, ARRIVAL), toPlace: toPublicPlace(arrival.toPlace) })) : [],
    bookings,
    items: data.items
      .filter((item) => item.visibility === "public" || (guest && item.visibility === "guests"))
      .map((item) => ({ ...pick(item, ITEM), place: toPublicPlace(item.place) })),
    tasks: data.tasks.filter((task) => task.kind === "bring" || task.kind === "packing").map((task) => pick(task, TASK)),
  };
}
