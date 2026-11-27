// The shapes the booking logic passes around. Start here: everything a screen needs is one of
// BookingContext (what you give), Proposal (what to look for), HandoffLink (a provider button),
// ParsedConfirmation (a pasted email, read), NextStep (what to do next) and ActByDates.
//
// Nothing in this folder reads the database, the network or the clock: data and `now` come in
// as arguments.

import type { Booking } from "@/db/schema";
import type {
  BookingKind,
  Cabin,
  FlightSearch,
  FlightTripType,
  LinkGrade,
  LodgingType,
  MealType,
  PlaceRef,
  RideType,
  UnfilledField,
} from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import type { ProviderId } from "./providers";

/** The five booking kinds a provider can be opened for. Send ahead has no hand-off. */
export type SearchKind = Exclude<BookingKind, "shipment">;
export const SEARCH_KINDS = ["flight", "lodging", "car", "ride", "meal"] as const satisfies readonly SearchKind[];

/** Free identifiers some providers accept. They are not secrets, and every one is optional. */
export type PartnerIds = {
  /** Uber developer `client_id`. */
  uberClientId?: string;
  /** Lyft `partner` client id. */
  lyftPartnerId?: string;
  /** Skyscanner (Impact) `mediaPartnerId`. With it, the documented Skyscanner link is used. */
  skyscannerMediaPartnerId?: string;
  /** Booking.com affiliate `aid`. */
  bookingAid?: string;
  /** Expedia marketing code (`mdpcid`). */
  expediaMarketingCode?: string;
};

/**
 * What the booking logic knows when it proposes a search or builds links.
 *
 *   const ctx: BookingContext = { data: await loadPlanData(user, planId), home: user.home,
 *                                 homeAirportIata: user.homeAirportIata, now: await requestNow() };
 */
export type BookingContext = {
  /** Everything about the plan, as loaded by loadPlanData. */
  data: PlanData;
  /** The signed-in person's home (users.home). */
  home: PlaceRef;
  /** Their home airport (users.homeAirportIata), when they have set one. */
  homeAirportIata?: string | null;
  /** The current time. Never read from the clock in here. */
  now: Date;
  /**
   * Optional: looks an airport up by its code and returns it as a place (name, coordinates,
   * zone). Without it an airport is shown by its code alone and ride links cannot carry its
   * coordinates. Wire this to the airport table when it exists.
   */
  airport?: (iata: string) => PlaceRef | null | undefined;
  /**
   * Optional: the airport code nearest to a place, for a city or a home that has no `iata` of
   * its own. Without it the person is asked which airport.
   */
  nearestAirport?: (place: PlaceRef) => string | null | undefined;
  /** Optional free partner identifiers. */
  partnerIds?: PartnerIds;
  /**
   * Providers whose prefilled link is switched off right now (their site changed and the link
   * broke). They still appear, pointing at their home page, with everything listed to copy.
   * Adds to the `disabled` switch in the provider registry.
   */
  disabledProviders?: readonly ProviderId[];
  /**
   * Where the links will be tapped. Apple Maps is only offered on "apple" (iPhone, iPad, Mac).
   * Left out, both map apps are offered.
   */
  platform?: "apple" | "other";
};

// --- what is being looked for ---------------------------------------------------------------------
// Dates are local calendar dates (`YYYY-MM-DD`) and times are local times of day (`HH:mm`) at the
// place they belong to. Links are built from these strings as they are.

/** A flight search: the domain's FlightSearch plus the trip type and cabin. */
export type FlightQuery = FlightSearch & {
  kind: "flight";
  tripType: FlightTripType;
  cabin: Cabin;
  /** The airports for people, when their names are known: "Seattle-Tacoma International Airport (SEA)". */
  originLabel?: string;
  destinationLabel?: string;
};

export type StayQuery = {
  kind: "lodging";
  lodgingType: LodgingType;
  /** Where to look: usually the plan's destination. */
  place?: PlaceRef;
  checkInDate?: string;
  checkOutDate?: string;
  /** Adults, or anyone whose age is not known to be under 18. */
  adults: number;
  children: number;
  infants: number;
  /** Ages of the children and infants, when every one of them is known. Otherwise empty. */
  childAges: number[];
  rooms: number;
};

export type CarQuery = {
  kind: "car";
  pickupPlace?: PlaceRef;
  /** Local date and time at the pick-up place. */
  pickupDate?: string;
  pickupTime?: string;
  /** Left out when the car goes back where it came from. */
  returnPlace?: PlaceRef;
  /** Local date and time at the return place. */
  returnDate?: string;
  returnTime?: string;
  seats: number;
  childSeats: number;
};

export type RideQuery = {
  kind: "ride";
  rideType: RideType;
  /** "from_airport" meets a landing; "to_airport" catches a flight. */
  direction: "from_airport" | "to_airport" | "other";
  fromPlace?: PlaceRef;
  toPlace?: PlaceRef;
  /** Local date and time at the pick-up place. */
  pickupDate?: string;
  pickupTime?: string;
  passengers: number;
  passengerIds: string[];
  bags?: number;
  childSeatNeeded: boolean;
  /** The arrivals (arrivals.id) this ride meets. */
  arrivalIds: string[];
};

export type FoodQuery = {
  kind: "meal";
  mealType: MealType;
  deliverToPlace?: PlaceRef;
  /** Local date at the delivery place. */
  date?: string;
  /** The delivery window, local times at the delivery place. */
  windowStart?: string;
  windowEnd?: string;
  headcount: number;
  /** "1 vegetarian, 1 nut allergy", from people's replies. */
  dietarySummary?: string;
  /** What to search the provider for: a cuisine, a restaurant or a store. Empty until the person says. */
  searchText?: string;
  deliveryNote?: string;
};

export type SearchQuery = FlightQuery | StayQuery | CarQuery | RideQuery | FoodQuery;
export type SearchQueryOf<K extends SearchKind> = Extract<SearchQuery, { kind: K }>;

// --- proposals ------------------------------------------------------------------------------------

/** One editable line of a proposal. */
export type ProposalField = {
  /** Stable within the kind: "from", "to", "depart", "pickup" … Use it as the form field name. */
  key: string;
  /** Plain words for the line: "Pick up at". */
  label: string;
  /** The value itself (an airport code, a date, a time, a count), or null when it is not known yet. */
  value: string | number | null;
  /** The value for people: "Orlando International Airport (MCO)", "Sat, Dec 19, 4:40 PM", or "Not set yet". */
  display: string;
  /** Why the app chose it, when it worked it out: "30 minutes after you land". Never set for a value the person typed. */
  because?: string;
};

type ProposalCommon = {
  /**
   * Stable for this plan and this search: "flight:party:<partyId>", "ride:arrival:<arrivalId>",
   * "meal:arrival-evening:groceries". Safe to use as a React key and to remember a choice by.
   */
  key: string;
  /** "Flights for the Seattle Hartleys", "Ride from the airport". */
  title: string;
  /** One line of what will be searched: "SEA to MCO · Sat, Dec 19 – Sun, Dec 27 · 2 adults, 2 children · Economy". */
  summary: string;
  /** The lines to show, in order. Each is editable: see reviseProposal. */
  fields: ProposalField[];
  /** What the app could not work out, in plain words, each saying what to do. Empty when complete. */
  missing: string[];
  /** Things worth knowing before opening a provider: ordering windows, "you set the time in the app". */
  notes: string[];
  /** Who it covers (people.id). */
  personIds: string[];
  /** The households it covers (parties.id). */
  partyIds: string[];
  /** "covered" when a booking already takes care of it; the proposal is still returned, last. */
  status: "open" | "covered";
  /** For a covered proposal: what covers it, in plain words ("Booked: AS 1054 SEA to MCO"). */
  coveredBy?: string;
};

export type FlightProposal = ProposalCommon & { kind: "flight"; query: FlightQuery };
export type StayProposal = ProposalCommon & { kind: "lodging"; query: StayQuery };
export type CarProposal = ProposalCommon & { kind: "car"; query: CarQuery };
export type RideProposal = ProposalCommon & { kind: "ride"; query: RideQuery };
export type FoodProposal = ProposalCommon & { kind: "meal"; query: FoodQuery };

/**
 * What the app proposes to look for: the search itself (`query`), the same thing as lines to show
 * (`fields`), and what is still missing. Pass it to `handoffLinks` to get the provider buttons.
 */
export type Proposal = FlightProposal | StayProposal | CarProposal | RideProposal | FoodProposal;
export type ProposalOf<K extends SearchKind> = Extract<Proposal, { kind: K }>;

// --- provider buttons -----------------------------------------------------------------------------

/** One provider button on the hand-off step. */
export type HandoffLink = {
  /** Registry id: goes in handoffs.provider. */
  provider: ProviderId;
  /** "Google Flights". */
  name: string;
  /** The words on the button: "See flights on Google Flights". */
  actionLabel: string;
  /** The same words as `actionLabel`, under the name the build spec's contract uses. */
  label: string;
  /** One plain line on why you might pick this one. */
  blurb: string;
  /** Open with `<a href target="_blank" rel="noopener noreferrer">`: a real link, so phones can open the app. */
  url: string;
  /** "documented" when the provider publishes the format; "observed" when it is a pattern that can change. Show "Check the dates on their page" for observed links. */
  grade: LinkGrade;
  /** What this link could not carry, each with the value to copy. Goes in handoffs.unfilled. */
  unfilled: UnfilledField[];
  /** False when the link is only the provider's home page (nothing could be prefilled). */
  prefilled: boolean;
  /** A line to show under the button when there is something to know first ("DoorDash takes orders 4 days ahead. Ordering opens Tue, Dec 15."). */
  note?: string;
  /** No link here has been clicked against the live provider yet. Always false until someone has. */
  tested: false;
};

/** A link that is not a booking: a flight tracker or directions. */
export type OutboundLink = {
  provider: ProviderId | "flightaware" | "flightradar24" | "google_search";
  name: string;
  actionLabel: string;
  url: string;
  grade: LinkGrade;
  tested: false;
};

/** How to get somewhere, for mapsLinks. */
export type TravelMode = "driving" | "walking" | "transit" | "cycling";

/** A booking row, or a proposal: what handoffLinks accepts. */
export type HandoffTarget = Booking | Proposal;
