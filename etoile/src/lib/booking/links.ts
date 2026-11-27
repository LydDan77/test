// handoffLinks: the provider buttons for a booking or a proposal, in a sensible order, each with
// its prefilled link, what it could not carry, and an honest grade.
//
// Also flightStatusLinks (trackers for one flight) and mapsLinks (directions).
//
// The promise to the person (build spec 3.5): one tap opens the provider with everything it
// accepts prefilled, and the sheet lists what could not be prefilled with a copy button each.
// A link that cannot be built never breaks the sheet: the button opens the provider's home page
// and every detail is on the copy list.

import type { Booking, Person } from "@/db/schema";
import { flightDesignator, type FlightSegment, type LinkGrade, type PlaceRef, type UnfilledField } from "@/lib/domain";
import { addDays, compareDates, localDateOf } from "@/lib/time";
import { flightJourneys, headCount } from "./context";
import { reviseProposal } from "./fields";
import { orderWindowNote, proposeSearch } from "./propose";
import { FOOD_ORDER_WINDOW_DAYS, PROVIDERS, providerHomeUrl, type ProviderId } from "./providers";
import { expediaCarsLink, kayakCarsLink, turoLink } from "./providers/car";
import { flightAwareUrl, flightradar24Url, googleFlightStatusUrl } from "./providers/flight-status";
import { expediaFlightsLink, googleFlightsLink, kayakFlightsLink, skyscannerFlightsLink } from "./providers/flights";
import { doordashLink, ezcaterLink, grubhubLink, instacartLink, uberEatsLink } from "./providers/food";
import {
  appleMapsDirectionsUrl,
  appleMapsRideLink,
  googleMapsDirectionsUrl,
  googleMapsRideLink,
  lyftLink,
  uberLink,
} from "./providers/rides";
import { airbnbLink, bookingComLink, expediaStayLink, hotelsComLink, vrboLink } from "./providers/stay";
import { compact, mapsQueryText, unfilledField, type BuiltLink, type LinkEnv } from "./providers/shared";
import type {
  BookingContext,
  CarQuery,
  FlightQuery,
  FoodQuery,
  HandoffLink,
  HandoffTarget,
  OutboundLink,
  Proposal,
  RideQuery,
  SearchKind,
  SearchQuery,
  StayQuery,
  TravelMode,
} from "./types";
import { addressText, localParts } from "./wording";

type Builder<Q> = (query: Q, env: LinkEnv) => BuiltLink;

// One small pure builder per provider and kind. To add a provider: a row in the registry
// (providers.ts), a builder next to its siblings, and a line here.
const BUILDERS: {
  flight: Partial<Record<ProviderId, Builder<FlightQuery>>>;
  lodging: Partial<Record<ProviderId, Builder<StayQuery>>>;
  car: Partial<Record<ProviderId, Builder<CarQuery>>>;
  ride: Partial<Record<ProviderId, Builder<RideQuery>>>;
  meal: Partial<Record<ProviderId, Builder<FoodQuery>>>;
} = {
  flight: { google_flights: googleFlightsLink, kayak: kayakFlightsLink, skyscanner: skyscannerFlightsLink, expedia: expediaFlightsLink },
  lodging: { booking: bookingComLink, airbnb: airbnbLink, vrbo: vrboLink, hotels: hotelsComLink, expedia: expediaStayLink },
  car: { kayak: kayakCarsLink, expedia: expediaCarsLink, turo: turoLink },
  ride: { uber: uberLink, lyft: lyftLink, google_maps: googleMapsRideLink, apple_maps: appleMapsRideLink },
  meal: { doordash: doordashLink, uber_eats: uberEatsLink, grubhub: grubhubLink, instacart: instacartLink, ezcater: ezcaterLink },
};

function isProposal(target: HandoffTarget): target is Proposal {
  return "query" in target && "fields" in target;
}

// --- a booking row as a search ----------------------------------------------------------------------

function defined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null)) as Partial<T>;
}

function overlap(a: readonly string[], b: readonly string[]): number {
  return a.filter((id) => b.includes(id)).length;
}

function peopleOf(ctx: BookingContext, ids: readonly string[]): Person[] {
  return ctx.data.people.filter((person) => ids.includes(person.id));
}

/**
 * The search a booking row stands for: what the plan would propose, with everything the row
 * already says laid over it. Null for a kind with no hand-off (send ahead).
 */
export function proposalForBooking(booking: Booking, ctx: BookingContext): Proposal | null {
  const details = booking.details;
  switch (details.kind) {
    case "flight": {
      const proposals = proposeSearch("flight", ctx);
      const base = [...proposals].sort((a, b) => overlap(b.personIds, booking.personIds) - overlap(a.personIds, booking.personIds))[0];
      const covered = peopleOf(ctx, booking.personIds);
      const count = covered.length > 0 ? headCount(covered) : null;
      const changes: Partial<FlightQuery> = defined({ tripType: details.tripType, cabin: details.cabin });
      // A saved search always carries counts (one adult by default). Only counts that say more
      // than that default are taken as the person's own choice.
      const search = details.search;
      const ownCounts = search !== undefined && !(search.adults === 1 && search.children === 0 && search.infants === 0);
      if (search) {
        Object.assign(
          changes,
          defined({
            originIata: search.originIata,
            destinationIata: search.destinationIata,
            departDate: search.departDate,
            returnDate: search.returnDate,
            legs: search.legs,
          }),
        );
        if (ownCounts) Object.assign(changes, { adults: search.adults, children: search.children, infants: search.infants, childAges: search.childAges });
      } else if (details.segments.length > 0) {
        const journeys = flightJourneys(details.segments);
        const out = journeys[0];
        const back = journeys.length > 1 ? journeys[journeys.length - 1] : undefined;
        const first = details.segments[out.first];
        Object.assign(changes, {
          originIata: first.originIata,
          destinationIata: details.segments[out.last].destinationIata,
          departDate: localDateOf(first.departsAt, first.originTz),
          returnDate: back ? localDateOf(details.segments[back.first].departsAt, details.segments[back.first].originTz) : undefined,
          tripType: details.tripType ?? (back ? "round_trip" : "one_way"),
        } satisfies Partial<FlightQuery>);
      }
      if (count && !ownCounts) {
        Object.assign(changes, { adults: count.adults, children: count.children, infants: count.infants, childAges: count.agesKnown && count.childAges.length > 0 ? count.childAges : undefined });
      }
      return reviseProposal(base, changes);
    }
    case "lodging": {
      const base = proposeSearch("lodging", ctx)[0];
      const covered = peopleOf(ctx, booking.personIds);
      const count = covered.length > 0 ? headCount(covered) : null;
      const changes: Partial<StayQuery> = defined({
        lodgingType: details.lodgingType,
        place: details.place,
        checkInDate: details.checkInDate,
        checkOutDate: details.checkOutDate,
        ...(count ? { adults: count.adults, children: count.children, infants: count.infants, childAges: count.agesKnown ? count.childAges : [] } : {}),
        ...(details.rooms.length > 0 ? { rooms: details.rooms.length } : {}),
      });
      return reviseProposal(base, changes);
    }
    case "car": {
      const base = proposeSearch("car", ctx)[0];
      const pickup = details.pickupAt ? localParts(details.pickupAt) : undefined;
      const back = details.returnAt ? localParts(details.returnAt) : undefined;
      const changes: Partial<CarQuery> = defined({
        pickupPlace: details.pickupPlace,
        pickupDate: pickup?.date,
        pickupTime: pickup?.time,
        returnPlace: details.returnPlace,
        returnDate: back?.date,
        returnTime: back?.time,
        seats: details.seats,
        childSeats: details.childSeats,
      });
      return reviseProposal(base, changes);
    }
    case "ride": {
      const proposals = proposeSearch("ride", ctx);
      const base =
        proposals.find((p) => overlap(p.query.arrivalIds, details.arrivalIds) > 0) ??
        proposals.find((p) => details.passengerIds.length > 0 && overlap(p.personIds, details.passengerIds) > 0) ??
        proposals[0];
      const pickup = details.pickupAt ? localParts(details.pickupAt) : undefined;
      const changes: Partial<RideQuery> = defined({
        rideType: details.rideType,
        fromPlace: details.fromPlace,
        toPlace: details.toPlace,
        pickupDate: pickup?.date,
        pickupTime: pickup?.time,
        bags: details.bags,
        childSeatNeeded: details.childSeatNeeded,
        ...(details.passengerIds.length > 0 ? { passengerIds: details.passengerIds, passengers: details.passengerIds.length } : {}),
        ...(details.arrivalIds.length > 0 ? { arrivalIds: details.arrivalIds } : {}),
      });
      return reviseProposal(base, changes);
    }
    case "meal": {
      const proposals = proposeSearch("meal", ctx);
      const base = proposals.find((p) => p.query.mealType === details.mealType) ?? proposals[0];
      const start = details.windowStart ? localParts(details.windowStart) : undefined;
      const end = details.windowEnd ? localParts(details.windowEnd) : undefined;
      const changes: Partial<FoodQuery> = defined({
        mealType: details.mealType,
        deliverToPlace: details.deliverToPlace,
        date: start?.date,
        windowStart: start?.time,
        windowEnd: end?.time,
        headcount: details.headcount,
        dietarySummary: details.dietarySummary,
        deliveryNote: details.deliveryNote,
        searchText: details.vendorName,
      });
      return reviseProposal(base, changes);
    }
    case "shipment":
      return null;
  }
}

// --- order ------------------------------------------------------------------------------------------

function foodOrder(query: FoodQuery, ctx: BookingContext): ProviderId[] {
  const work = ctx.data.plan.template === "work";
  const base: ProviderId[] =
    query.mealType === "groceries"
      ? ["instacart"]
      : query.mealType === "catering"
        ? ["ezcater", "grubhub", "doordash", "uber_eats"]
        : // Catering is worth showing for a work plan even when it starts as a restaurant order.
          work
          ? ["doordash", "uber_eats", "grubhub", "ezcater"]
          : ["doordash", "uber_eats", "grubhub"];
  if (!query.date || query.mealType !== "restaurant_delivery") return base;
  // Providers that will take the order today come before those whose window is not open yet.
  const today = localDateOf(ctx.now, query.deliverToPlace?.tz ?? ctx.data.plan.tz);
  const open = (id: ProviderId) => {
    const days = FOOD_ORDER_WINDOW_DAYS[id as keyof typeof FOOD_ORDER_WINDOW_DAYS];
    return days === null || days === undefined || compareDates(addDays(query.date as string, -days), today) <= 0;
  };
  return [...base.filter(open), ...base.filter((id) => !open(id))];
}

/**
 * The providers that fit a search, in the order to show them. No provider pays for its place:
 *   flights   Google Flights, Kayak, Skyscanner, Expedia (Kayak first for several stops, the only one that takes them)
 *   stay      whole homes first for a home rental (Vrbo, Airbnb, …); hotels first otherwise (Booking.com, Hotels.com, …);
 *             none when staying with family
 *   car       Kayak, Expedia, Turo
 *   rides     Uber, Lyft, then directions; directions only when someone in the plan is driving
 *   food      by kind of order; catering (ezCater) joins for a work plan; providers already taking orders first
 * The provider used last time for this kind of booking moves to the front.
 */
export function providerOrder(query: SearchQuery, ctx: BookingContext): ProviderId[] {
  let order: ProviderId[];
  switch (query.kind) {
    case "flight":
      order = query.tripType === "multi_city" ? ["kayak", "google_flights", "skyscanner", "expedia"] : ["google_flights", "kayak", "skyscanner", "expedia"];
      break;
    case "lodging":
      order =
        query.lodgingType === "family_home"
          ? []
          : query.lodgingType === "rental"
            ? ["vrbo", "airbnb", "booking", "hotels", "expedia"]
            : ["booking", "hotels", "expedia", "airbnb", "vrbo"];
      break;
    case "car":
      order = ["kayak", "expedia", "turo"];
      break;
    case "ride":
      order =
        query.rideType === "personal_pickup"
          ? ["google_maps", "apple_maps"]
          : query.rideType === "rideshare"
            ? ["uber", "lyft", "google_maps", "apple_maps"]
            : ["google_maps", "apple_maps", "uber", "lyft"];
      if (ctx.platform === "other") order = order.filter((id) => id !== "apple_maps");
      break;
    case "meal":
      order = foodOrder(query, ctx);
      break;
  }

  const lastUsed = [...ctx.data.handoffs]
    .filter((handoff) => handoff.outcome !== "not_this_one")
    .filter((handoff) => ctx.data.bookings.find((booking) => booking.id === handoff.bookingId)?.kind === query.kind)
    .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
    .map((handoff) => handoff.provider)
    .find((provider): provider is ProviderId => order.includes(provider as ProviderId));
  return lastUsed ? [lastUsed, ...order.filter((id) => id !== lastUsed)] : order;
}

// --- the buttons ------------------------------------------------------------------------------------

/**
 * Everything the proposal knows, as a copy list: used when a link could not be prefilled at all.
 * A place is given as the address to type, not as its nickname.
 */
function everythingToCopy(proposal: Proposal): UnfilledField[] {
  const places: Record<string, PlaceRef | undefined> =
    proposal.kind === "ride"
      ? { from: proposal.query.fromPlace, to: proposal.query.toPlace }
      : proposal.kind === "meal"
        ? { deliverTo: proposal.query.deliverToPlace }
        : {};
  return compact(
    proposal.fields
      // "What: Dinner delivered" is the kind of order, not something to type in.
      .filter((field) => field.value !== null && !(proposal.kind === "meal" && field.key === "what"))
      .map((field) => {
        const place = places[field.key];
        return unfilledField(field.label, place ? addressText(place) : field.display);
      }),
  ).slice(0, 30);
}

function noteFor(provider: ProviderId, proposal: Proposal, ctx: BookingContext): string | undefined {
  if (proposal.kind === "meal" && provider in FOOD_ORDER_WINDOW_DAYS) {
    const tz = proposal.query.deliverToPlace?.tz ?? ctx.data.plan.tz;
    return orderWindowNote(provider as keyof typeof FOOD_ORDER_WINDOW_DAYS, proposal.query.date, localDateOf(ctx.now, tz));
  }
  if (proposal.kind === "ride" && proposal.query.pickupTime) {
    if (provider === "uber") return "Uber can't take a time from a link. Choose Reserve in the app and enter the pick-up time.";
    if (provider === "lyft") return "Lyft can't take a time from a link. Choose Schedule in the app and enter the pick-up time.";
  }
  return undefined;
}

function buildOne(provider: ProviderId, proposal: Proposal, ctx: BookingContext, env: LinkEnv): HandoffLink | null {
  const info = PROVIDERS[provider];
  const words = info.kinds[proposal.kind];
  const builder = (BUILDERS[proposal.kind] as Partial<Record<ProviderId, Builder<SearchQuery>>>)[provider];
  if (!words || !builder) return null;

  const switchedOff = info.disabled || (ctx.disabledProviders ?? []).includes(provider);
  let built: BuiltLink | null = null;
  if (!switchedOff) {
    try {
      built = builder(proposal.query, env);
      // A builder that returns something that is not a web address is treated as having failed.
      if (!/^https:\/\/\S+$/.test(built.url)) built = null;
    } catch {
      built = null;
    }
  }
  const grade: LinkGrade = built?.grade ?? "observed";
  const note = noteFor(provider, proposal, ctx);
  return {
    provider,
    name: info.name,
    actionLabel: words.actionLabel,
    label: words.actionLabel,
    blurb: words.blurb,
    url: built?.url ?? providerHomeUrl(provider, proposal.kind),
    grade,
    unfilled: built ? built.unfilled.slice(0, 30) : everythingToCopy(proposal),
    prefilled: built !== null,
    ...(note ? { note } : {}),
    tested: false,
  };
}

/**
 * The provider buttons for a booking or a proposal: every provider that fits, in the order to
 * show them (see providerOrder). Show the first three; put the rest behind "More".
 *
 * Give it a proposal from `proposeSearch` (after any `reviseProposal`), or a booking row: a row
 * is turned into its search first, using what it already says and the plan for the rest.
 *
 * For each link: open `url` with a real `<a target="_blank" rel="noopener noreferrer">`, list
 * `unfilled` under "You'll need to enter" with a copy button each, show `note` when present,
 * and for a prefilled link whose `grade` is "observed" add "Check the dates on their page."
 * When `prefilled` is false the button only opens the provider's home page.
 *
 * Returns an empty list for send ahead, and for a stay with family (nothing to book).
 * Record a click as a handoffs row: `{ provider, url, linkGrade: grade, unfilled }`.
 */
export function handoffLinks(target: HandoffTarget, ctx: BookingContext): HandoffLink[] {
  const proposal = isProposal(target) ? target : proposalForBooking(target, ctx);
  if (!proposal) return [];
  const env: LinkEnv = { partnerIds: ctx.partnerIds, currency: ctx.data.plan.currency };
  return providerOrder(proposal.query, ctx)
    .map((provider) => buildOne(provider, proposal, ctx, env))
    .filter((link): link is HandoffLink => link !== null);
}

/** The kinds handoffLinks can build buttons for. */
export function hasHandoff(kind: Booking["kind"]): kind is SearchKind {
  return kind !== "shipment";
}

// --- trackers and directions ------------------------------------------------------------------------

/**
 * Live trackers for one flight: FlightAware, Flightradar24 and a Google search, in that order.
 * None of them can be opened on a particular date reliably, so each opens the flight's live
 * page; the Google search adds the date in words when the departure time is known.
 *
 *   flightStatusLinks(booking.details.segments[0])
 */
export function flightStatusLinks(
  segment: Pick<FlightSegment, "airlineIata" | "flightNumber"> & Partial<Pick<FlightSegment, "departsAt" | "originTz">>,
): OutboundLink[] {
  const designator = flightDesignator(segment);
  const date = segment.departsAt && segment.originTz ? localDateOf(segment.departsAt, segment.originTz) : undefined;
  const link = (provider: OutboundLink["provider"], name: string, actionLabel: string, url: string): OutboundLink => ({
    provider,
    name,
    actionLabel,
    url,
    grade: "observed",
    tested: false,
  });
  return [
    link("flightaware", "FlightAware", `Track ${designator} on FlightAware`, flightAwareUrl(segment.airlineIata, segment.flightNumber)),
    link("flightradar24", "Flightradar24", `Track ${designator} on Flightradar24`, flightradar24Url(segment.airlineIata, segment.flightNumber)),
    link("google_search", "Google", `Search Google for ${designator}`, googleFlightStatusUrl(segment.airlineIata, segment.flightNumber, date)),
  ];
}

/**
 * Directions from one place to another: Google Maps, then Apple Maps. Both are documented by
 * their makers and need no key.
 *
 * `from` may be left out (null) to start from wherever the person is. A place may be a PlaceRef
 * or plain words ("JFK Airport"). `mode` defaults to driving. Pass `platform: "other"` to leave
 * Apple Maps out on devices that are not Apple's. Empty when `to` says nothing usable.
 */
export function mapsLinks(
  from: PlaceRef | string | null | undefined,
  to: PlaceRef | string,
  mode: TravelMode = "driving",
  opts: { platform?: "apple" | "other" } = {},
): OutboundLink[] {
  if (!mapsQueryText(to)) return [];
  const links: OutboundLink[] = [
    { provider: "google_maps", name: "Google Maps", actionLabel: "Directions in Google Maps", url: googleMapsDirectionsUrl(from, to, mode), grade: "documented", tested: false },
  ];
  if (opts.platform !== "other") {
    links.push({ provider: "apple_maps", name: "Apple Maps", actionLabel: "Directions in Apple Maps", url: appleMapsDirectionsUrl(from, to, mode), grade: "documented", tested: false });
  }
  return links;
}
