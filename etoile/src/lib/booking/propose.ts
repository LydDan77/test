// proposeSearch: what to look for, already filled in from everything the plan knows.
//
// Each proposal is a search (`query`), the same thing as editable lines (`fields`, each with a
// "because" where the app worked the value out), and a list of what is still missing in plain
// words. It never throws for a thin plan: with no flights, no address or no dates it proposes
// what it can and says what would let it do better.

import type { Party, Person } from "@/db/schema";
import { clockText } from "@/lib/calendar";
import type { LodgingType, MealType, PlaceRef } from "@/lib/domain";
import { addDays, compareDates, diffDays, formatDate, localDateOf, utcToZoned, zonedToUtc } from "@/lib/time";
import {
  airportRuns,
  bookingsOf,
  comingPeople,
  dietarySummary,
  groupText,
  headCount,
  isBooked,
  mainArrival,
  mainDeparture,
  organizerParty,
  stayOf,
  TIMINGS,
  type AirportRun,
} from "./context";
import { fieldsForQuery, summaryForQuery, type Reasons } from "./fields";
import { FOOD_ORDER_WINDOW_DAYS, PROVIDERS, RIDE_RESERVATION_WINDOW_DAYS } from "./providers";
import type {
  BookingContext,
  CarProposal,
  CarQuery,
  FlightProposal,
  FlightQuery,
  FoodProposal,
  FoodQuery,
  Proposal,
  ProposalOf,
  RideProposal,
  RideQuery,
  SearchKind,
  SearchQuery,
  StayProposal,
  StayQuery,
} from "./types";
import { clockAt, dateText, durationWords, listOf, placeLabel } from "./wording";

// --- small helpers --------------------------------------------------------------------------------

const MINUTE = 60_000;

function roundUp(ms: number, minutes: number): number {
  const step = minutes * MINUTE;
  return Math.ceil(ms / step) * step;
}

function roundDown(ms: number, minutes: number): number {
  const step = minutes * MINUTE;
  return Math.floor(ms / step) * step;
}

function localAt(ms: number, tz: string): { date: string; time: string } {
  const zoned = utcToZoned(ms, tz);
  return { date: zoned.date, time: zoned.time };
}

/** "the Seattle Hartleys" inside a sentence, for a household called "The Seattle Hartleys". */
function inSentence(name: string): string {
  return name.replace(/^The\s/, "the ");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

type Draft<Q extends SearchQuery> = {
  key: string;
  title: string;
  query: Q;
  reasons: Reasons;
  missing: string[];
  notes?: string[];
  personIds?: string[];
  partyIds?: string[];
  coveredBy?: string;
};

function build<Q extends SearchQuery>(draft: Draft<Q>): Extract<Proposal, { kind: Q["kind"] }> {
  const proposal = {
    key: draft.key,
    kind: draft.query.kind,
    title: draft.title,
    summary: summaryForQuery(draft.query),
    query: draft.query,
    fields: fieldsForQuery(draft.query, draft.reasons),
    missing: draft.missing,
    notes: draft.notes ?? [],
    personIds: draft.personIds ?? [],
    partyIds: draft.partyIds ?? [],
    status: draft.coveredBy ? "covered" : "open",
    ...(draft.coveredBy ? { coveredBy: draft.coveredBy } : {}),
  };
  return proposal as unknown as Extract<Proposal, { kind: Q["kind"] }>;
}

/** Open proposals first, covered ones after, each group in the order it was built. */
function openFirst<P extends Proposal>(proposals: P[]): P[] {
  return [...proposals.filter((p) => p.status === "open"), ...proposals.filter((p) => p.status === "covered")];
}

/** The airport to fly into: the destination's own, else where booked flights land, else the nearest one. */
function destinationAirport(ctx: BookingContext, runs: AirportRun[]): { iata?: string; place?: PlaceRef; because?: string } {
  const destination = ctx.data.plan.destination;
  const withPlace = (iata: string, because: string) => ({
    iata,
    place: ctx.airport?.(iata) ?? ({ kind: "airport", name: iata, iata, tz: destination?.tz ?? ctx.data.plan.tz } satisfies PlaceRef),
    because,
  });
  if (destination?.iata) return withPlace(destination.iata, `the airport for ${destination.name}`);
  const landed = runs.find((run) => run.direction === "arrival" && run.airportIata);
  if (landed?.airportIata) return { iata: landed.airportIata, place: landed.airportPlace, because: "where the flights already booked land" };
  const nearest = destination ? ctx.nearestAirport?.(destination) : undefined;
  if (nearest && destination) return withPlace(nearest, `the nearest airport to ${destination.name}`);
  return {};
}

function airportLabel(ctx: BookingContext, iata: string | undefined): string | undefined {
  if (!iata) return undefined;
  const place = ctx.airport?.(iata);
  return place ? placeLabel({ ...place, kind: "airport", iata }) : undefined;
}

// --- flights --------------------------------------------------------------------------------------

type FlightGroup = { key: string; originIata?: string; originName: string; because?: string; parties: Party[]; people: Person[] };

function flightGroups(ctx: BookingContext, destinationIata: string | undefined): FlightGroup[] {
  const { data } = ctx;
  const plan = data.plan;
  const coming = comingPeople(data);
  const parties = [...data.parties].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups = new Map<string, FlightGroup>();

  const originOf = (party: Party | undefined): { iata?: string; name: string; because?: string } => {
    const own = party?.origin ?? undefined;
    const place = own ?? plan.origin;
    if (place.iata) {
      return { iata: place.iata, name: place.name, because: own && party ? `where ${inSentence(party.name)} set out from` : "where you set out from" };
    }
    // The person's home airport stands in only when the plan really sets out from their home.
    const fromHome = !own && place.name === ctx.home.name && place.tz === ctx.home.tz;
    if (fromHome && ctx.homeAirportIata) return { iata: ctx.homeAirportIata, name: place.name, because: "your home airport" };
    const nearest = ctx.nearestAirport?.(place);
    if (nearest) return { iata: nearest, name: place.name, because: `the nearest airport to ${place.name}` };
    return { name: place.name };
  };

  const add = (party: Party | undefined, people: Person[]) => {
    const origin = originOf(party);
    if (origin.iata && origin.iata === destinationIata) return; // already there
    const key = `flight:from:${origin.iata ?? slug(origin.name)}`;
    const group = groups.get(key) ?? { key, originIata: origin.iata, originName: origin.name, because: origin.because, parties: [], people: [] };
    if (party) group.parties.push(party);
    group.people.push(...people);
    groups.set(key, group);
  };

  if (parties.length === 0 || data.people.length === 0) {
    add(undefined, []);
    return [...groups.values()];
  }
  for (const party of parties) {
    const people = coming.filter((person) => person.partyId === party.id);
    if (people.length === 0) continue;
    // A household that drives, takes the train or is already there needs no flight.
    const arrival = data.arrivals.find((row) => row.partyId === party.id && row.direction === "arrival");
    if (arrival && arrival.mode !== "flight") continue;
    // So does a household that lives where the plan is.
    const home = party.origin;
    if (home && plan.destination && home.name === plan.destination.name && home.tz === plan.destination.tz) continue;
    add(party, people);
  }
  return [...groups.values()];
}

function proposeFlights(ctx: BookingContext): FlightProposal[] {
  const { data } = ctx;
  const plan = data.plan;
  const runs = airportRuns(ctx);
  const destination = destinationAirport(ctx, runs);
  const stay = stayOf(data);
  const bookedStay = stay && isBooked(stay) ? stay : undefined;

  const departDate = bookedStay?.details.checkInDate ?? plan.startDate ?? undefined;
  const returnDate = bookedStay?.details.checkOutDate ?? plan.endDate ?? undefined;
  const departBecause = bookedStay?.details.checkInDate ? "the day you check in" : "the day the plan starts";
  const returnBecause = bookedStay?.details.checkOutDate ? "the day you check out" : "the day the plan ends";
  const roundTrip = Boolean(departDate && returnDate && compareDates(returnDate, departDate) > 0);

  const bookedFlights = bookingsOf(data, "flight").filter((flight) => isBooked(flight) && flight.details.segments.length > 0);
  const organizerPartyId = organizerParty(data)?.id;
  const coveredBy = (person: Person) =>
    bookedFlights.find((flight) =>
      flight.personIds.length > 0
        ? flight.personIds.includes(person.id)
        : // A recorded flight with nobody ticked covers everyone in a one-household plan, and the
          // organizer's household otherwise.
          data.parties.length <= 1 || person.partyId === organizerPartyId,
    );

  const groups = flightGroups(ctx, destination.iata);
  if (groups.length === 0) {
    // Everyone drives, takes the train or is already there. Still answer, so a screen has
    // something true to show.
    const count = headCount(comingPeople(data), plan.expectedPeople);
    return [
      build<FlightQuery>({
        key: "flight:nobody",
        title: "Flights",
        query: {
          kind: "flight",
          tripType: roundTrip ? "round_trip" : "one_way",
          cabin: "economy",
          destinationIata: destination.iata,
          destinationLabel: airportLabel(ctx, destination.iata),
          departDate,
          returnDate: roundTrip ? returnDate : undefined,
          adults: count.adults,
          children: count.children,
          infants: count.infants,
        },
        reasons: { to: destination.because, depart: departBecause, return: returnBecause },
        missing: [],
        notes: ["Nobody on this plan needs a flight: everyone is driving, taking the train or already there."],
        coveredBy: "Nobody needs to fly",
      }),
    ];
  }
  const several = groups.length > 1;
  const proposals = groups.map((group) => {
    const open = group.people.filter((person) => !coveredBy(person));
    const everyoneCovered = group.people.length > 0 && open.length === 0;
    const flying = everyoneCovered ? group.people : open;
    const count = headCount(flying, group.people.length === 0 ? plan.expectedPeople : 0);
    const names = listOf(group.parties.map((party) => inSentence(party.name)));

    const query: FlightQuery = {
      kind: "flight",
      tripType: roundTrip ? "round_trip" : "one_way",
      cabin: "economy",
      originIata: group.originIata,
      destinationIata: destination.iata,
      originLabel: airportLabel(ctx, group.originIata),
      destinationLabel: airportLabel(ctx, destination.iata),
      departDate,
      returnDate: roundTrip ? returnDate : undefined,
      adults: count.adults,
      children: count.children,
      infants: count.infants,
      childAges: count.agesKnown && count.childAges.length > 0 ? count.childAges : undefined,
    };

    const missing: string[] = [];
    if (!plan.destination) missing.push("Choose where you're going and we'll find the airport.");
    else if (!destination.iata) missing.push(`We don't know which airport is nearest to ${plan.destination.name}. Choose one below.`);
    if (!group.originIata) missing.push(`We don't know which airport ${several && names ? names : "you"} would fly from. Choose one below.`);
    if (!departDate) missing.push("Pick your dates and we'll fill in the days to fly.");
    if (count.total === 0) missing.push("Add who's coming so we can count the seats.");

    const notes: string[] = [];
    if (!count.agesKnown) notes.push("Airlines ask each child's age. Add the ages under Who's coming and we'll fill them in.");

    const whoBecause = flying.length === 0 ? "the number you gave when you made the plan" : several && names ? `everyone in ${names}` : open.length < group.people.length && !everyoneCovered ? "everyone who isn't booked yet" : "everyone who's coming";
    const covering = everyoneCovered ? [...new Set(group.people.map((person) => coveredBy(person)?.title).filter(Boolean))] : [];

    return build<FlightQuery>({
      key: group.key,
      title: several && names ? `Flights for ${names}` : "Flights",
      query,
      reasons: {
        from: group.because,
        to: destination.because,
        depart: departBecause,
        return: returnBecause,
        travelers: whoBecause,
      },
      missing,
      notes,
      personIds: flying.map((person) => person.id),
      partyIds: group.parties.map((party) => party.id),
      coveredBy: everyoneCovered ? `Booked: ${listOf(covering as string[])}` : undefined,
    });
  });
  return openFirst(proposals);
}

// --- stay -----------------------------------------------------------------------------------------

function roomsFor(ctx: BookingContext, type: LodgingType, people: Person[], fallbackAdults: number): { rooms: number; because?: string } {
  if (type === "rental" || type === "family_home") return { rooms: 1, because: "one place for everyone" };
  const adultsOf = (list: Person[]) => list.filter((person) => person.ageGroup === "adult").length;
  if (people.length === 0) return { rooms: Math.max(1, Math.ceil(fallbackAdults / 2)), because: "two adults to a room" };
  if (ctx.data.plan.template === "work") return { rooms: Math.max(1, adultsOf(people)), because: "a room each" };
  const byParty = new Map<string, Person[]>();
  for (const person of people) byParty.set(person.partyId, [...(byParty.get(person.partyId) ?? []), person]);
  const rooms = [...byParty.values()].reduce((sum, list) => sum + Math.max(1, Math.ceil(adultsOf(list) / 2)), 0);
  return { rooms, because: byParty.size > 1 ? "two adults to a room, household by household" : "two adults to a room" };
}

function proposeStay(ctx: BookingContext): StayProposal[] {
  const { data } = ctx;
  const plan = data.plan;
  const runs = airportRuns(ctx);
  const coming = comingPeople(data);
  const count = headCount(coming, plan.expectedPeople);
  const stay = stayOf(data);

  const firstLanding = runs.find((run) => run.direction === "arrival");
  const lastLeaving = [...runs].reverse().find((run) => run.direction === "departure");
  // A flight that lands in the small hours needs the room from the night before.
  const landsOvernight = firstLanding !== undefined && utcToZoned(firstLanding.at.at, firstLanding.at.tz).hour < 5;
  const landingDate = firstLanding ? localDateOf(firstLanding.at.at, firstLanding.at.tz) : undefined;
  const checkInDate = landingDate ? (landsOvernight ? addDays(landingDate, -1) : landingDate) : (plan.startDate ?? undefined);
  const checkOutDate = lastLeaving ? localDateOf(lastLeaving.at.at, lastLeaving.at.tz) : (plan.endDate ?? undefined);

  const type: LodgingType = stay?.details.lodgingType ?? (plan.template === "work" ? "hotel" : count.total >= 5 ? "rental" : "hotel");
  const typeBecause = stay?.details.lodgingType
    ? undefined
    : plan.template === "work"
      ? "work trips usually mean a hotel"
      : count.total >= 5
        ? `${count.total} of you fit best under one roof`
        : "a hotel suits a small group";
  const rooms = roomsFor(ctx, type, coming, count.adults);

  const query: StayQuery = {
    kind: "lodging",
    lodgingType: type,
    place: plan.destination ?? undefined,
    checkInDate,
    checkOutDate: checkInDate && checkOutDate && compareDates(checkOutDate, checkInDate) > 0 ? checkOutDate : undefined,
    adults: count.adults,
    children: count.children,
    infants: count.infants,
    childAges: count.agesKnown ? count.childAges : [],
    rooms: rooms.rooms,
  };

  const missing: string[] = [];
  if (!plan.destination) missing.push("Choose where you're going and we'll look for places there.");
  if (!checkInDate) missing.push("Pick your dates and we'll fill in check-in and check-out.");
  else if (!query.checkOutDate) missing.push("Add the day you leave and we'll fill in check-out.");
  if (count.total === 0) missing.push("Add who's coming so we can count beds.");

  const notes: string[] = [];
  if (!count.agesKnown) notes.push("Most sites ask each child's age. Add the ages under Who's coming and we'll fill them in.");

  const main = build<StayQuery>({
    key: "lodging:main",
    title: "A place to stay",
    query,
    reasons: {
      where: "where the plan is",
      checkIn: landsOvernight ? "you land in the small hours, so the room starts the night before" : firstLanding ? "the night you arrive" : "the day the plan starts",
      checkOut: lastLeaving ? "the day you fly home" : "the day the plan ends",
      guests: coming.length > 0 ? "everyone who's coming" : "the number you gave when you made the plan",
      type: typeBecause,
      rooms: rooms.because,
    },
    missing,
    notes,
    personIds: coming.map((person) => person.id),
    partyIds: data.parties.map((party) => party.id),
    coveredBy: stay && isBooked(stay) ? `Booked: ${stay.details.propertyName ?? stay.title}` : undefined,
  });

  // A trip with more stops gets one more search per stop, with that stop's own dates.
  const stops = plan.stops.map((stop, index) =>
    build<StayQuery>({
      key: `lodging:stop:${index}`,
      title: `A place to stay in ${stop.place.name}`,
      query: { ...query, place: stop.place, checkInDate: stop.arriveOn, checkOutDate: compareDates(stop.leaveOn, stop.arriveOn) > 0 ? stop.leaveOn : undefined },
      reasons: { where: "a stop on your trip", checkIn: "the day you reach this stop", checkOut: "the day you move on", guests: "everyone who's coming", type: typeBecause, rooms: rooms.because },
      missing: [],
      notes,
      personIds: coming.map((person) => person.id),
      partyIds: data.parties.map((party) => party.id),
    }),
  );
  return openFirst([main, ...stops]);
}

// --- car ------------------------------------------------------------------------------------------

function proposeCar(ctx: BookingContext): CarProposal[] {
  const { data } = ctx;
  const plan = data.plan;
  const runs = airportRuns(ctx);
  const landing = mainArrival(ctx, runs);
  const leaving = mainDeparture(ctx, runs);
  const airport = destinationAirport(ctx, runs);
  const coming = comingPeople(data);

  const pickupPlace = landing?.airportPlace ?? airport.place;
  const returnAirport = leaving?.airportPlace;
  const pickup = landing ? localAt(roundUp(Date.parse(landing.at.at) + TIMINGS.carAfterLandingMinutes * MINUTE, 30), landing.at.tz) : undefined;
  const back = leaving ? localAt(roundDown(Date.parse(leaving.at.at) - TIMINGS.carReturnBeforeFlightMinutes * MINUTE, 30), leaving.at.tz) : undefined;

  // Who rides in it: the people on the landing it meets, else the organizer's household when
  // households arrive separately, else everyone.
  const onLanding = landing ? coming.filter((person) => landing.personIds.includes(person.id)) : [];
  const household = data.parties.length > 1 ? coming.filter((person) => person.partyId === organizerParty(data)?.id) : [];
  const riders = onLanding.length > 0 ? onLanding : household.length > 0 ? household : coming;
  const count = headCount(riders, plan.expectedPeople);
  const ridersBecause = onLanding.length > 0 && onLanding.length < coming.length ? "everyone landing with you" : household.length > 0 && onLanding.length === 0 ? "your household" : coming.length > 0 ? "everyone who's coming" : "the number you gave when you made the plan";

  const query: CarQuery = {
    kind: "car",
    pickupPlace,
    pickupDate: pickup?.date ?? plan.startDate ?? undefined,
    pickupTime: pickup?.time,
    returnPlace: returnAirport && pickupPlace && returnAirport.iata !== pickupPlace.iata ? returnAirport : undefined,
    returnDate: back?.date ?? plan.endDate ?? undefined,
    returnTime: back?.time,
    seats: count.total,
    childSeats: count.needChildSeat,
  };

  const missing: string[] = [];
  if (!pickupPlace) missing.push(plan.destination ? `We don't know which airport you'll land at for ${plan.destination.name}. Choose where to pick the car up.` : "Choose where you're going and we'll suggest where to pick the car up.");
  if (!query.pickupDate) missing.push("Pick your dates and we'll fill in the pick-up and return days.");
  else if (!landing) missing.push("Add your flight and we'll time the pick-up to your landing.");
  if (query.pickupDate && landing && !leaving) missing.push("Add your flight home and we'll time the return.");
  if (count.total === 0) missing.push("Add who's coming so we can count seats.");

  const notes: string[] = [];
  if (!count.agesKnown) notes.push("Add the children's ages under Who's coming and we'll count the child seats.");
  if (count.total > 5) notes.push(`${count.total} people need a minivan or a large SUV, or two cars.`);

  const car = bookingsOf(data, "car").find(isBooked);
  return [
    build<CarQuery>({
      key: "car:main",
      title: "A car",
      query,
      reasons: {
        pickupPlace: landing ? "where you land" : airport.because,
        pickup: landing
          ? `about ${durationWords(TIMINGS.carAfterLandingMinutes)} after you land at ${clockAt(landing.at)}`
          : "the day the plan starts",
        returnPlace: leaving ? "where your flight home leaves from" : "the same place you pick it up",
        return: leaving
          ? `${durationWords(TIMINGS.carReturnBeforeFlightMinutes)} before your ${clockAt(leaving.at)} flight`
          : "the day the plan ends",
        // With children along, the count itself is the reason: "4 of you: 2 adults, 2 children".
        seats: count.children + count.infants > 0 ? groupText(count) : ridersBecause,
        childSeats: `children ${TIMINGS.childSeatMaxAge} and under`,
      },
      missing,
      notes,
      personIds: riders.map((person) => person.id),
      partyIds: [...new Set(riders.map((person) => person.partyId))],
      coveredBy: car ? `Booked: ${car.details.company ?? car.title}` : undefined,
    }),
  ];
}

// --- rides ----------------------------------------------------------------------------------------

/** A rough drive time between two places with coordinates, in minutes, rounded up to five. Undefined when either has none. */
export function estimateDriveMinutes(from: PlaceRef | undefined, to: PlaceRef | undefined): number | undefined {
  if (!from || !to || from.lat === undefined || from.lon === undefined || to.lat === undefined || to.lon === undefined) return undefined;
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  const km = 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  // Roads wander (about 1.3 times the straight line) and average about 50 km/h door to door,
  // plus ten minutes to load up and get out of the airport or the driveway.
  const minutes = ((km * 1.3) / 50) * 60 + 10;
  return Math.max(15, Math.ceil(minutes / 5) * 5);
}

function rideCover(ctx: BookingContext, run: AirportRun): string | undefined {
  const { data } = ctx;
  const rides = bookingsOf(data, "ride").filter(isBooked);
  const ride = rides.find((r) => r.id === run.rideBookingId || (run.arrivalId !== undefined && r.details.arrivalIds.includes(run.arrivalId)));
  if (ride) return `Booked: ${ride.title}`;
  switch (run.rideNeed) {
    case "driver_assigned": {
      const driver = data.people.find((person) => person.id === run.driverPersonId);
      return driver ? `${driver.name.split(/\s+/)[0]} is driving` : "Someone is driving";
    }
    case "rental_car":
      return "Covered by the rental car";
    case "own_car":
      return "They have their own car";
    case "not_needed":
      return "No ride needed";
    default:
      return undefined;
  }
}

function rideNotes(ctx: BookingContext, pickupDate: string | undefined, tz: string): string[] {
  const notes = ["Uber and Lyft can't take a time from a link. Choose Reserve or Schedule in the app and enter the pick-up time."];
  if (pickupDate) {
    const opens = addDays(pickupDate, -RIDE_RESERVATION_WINDOW_DAYS);
    const today = localDateOf(ctx.now, tz);
    notes.push(
      compareDates(opens, today) > 0
        ? `Both take reservations up to ${RIDE_RESERVATION_WINDOW_DAYS} days ahead. You can reserve this ride from ${dateText(opens)}.`
        : `Both take reservations up to ${RIDE_RESERVATION_WINDOW_DAYS} days ahead, so you can reserve this ride now.`,
    );
  }
  return notes;
}

function proposeRides(ctx: BookingContext): RideProposal[] {
  const { data } = ctx;
  const plan = data.plan;
  const runs = airportRuns(ctx);
  const stay = stayOf(data);
  const stayAt = stay?.details.place;
  const whereStaying: PlaceRef | undefined = stayAt ?? plan.destination ?? undefined;
  const stayBecause = stayAt ? "where you're staying" : "your destination, until you add where you're staying";
  const organizer = data.people.find((person) => person.role === "organizer");
  const coming = comingPeople(data);

  if (runs.length === 0) {
    const airport = destinationAirport(ctx, runs);
    const count = headCount(coming, plan.expectedPeople);
    const query: RideQuery = {
      kind: "ride",
      rideType: "rideshare",
      direction: "from_airport",
      fromPlace: airport.place,
      toPlace: whereStaying,
      pickupDate: plan.startDate ?? undefined,
      passengers: count.total,
      passengerIds: coming.map((person) => person.id),
      childSeatNeeded: count.needChildSeat > 0,
      arrivalIds: [],
    };
    const missing = ["Add your flights and we'll time the ride to your landing."];
    if (!stayAt) missing.push("Add where you're staying and we'll fill in the address.");
    if (!plan.startDate) missing.push("Pick your dates and we'll fill in the day.");
    return [
      build<RideQuery>({
        key: "ride:arrival:plan",
        title: "Ride from the airport",
        query,
        reasons: { from: airport.because, to: stayBecause, pickup: "the day the plan starts", riders: "everyone who's coming" },
        missing,
        notes: rideNotes(ctx, query.pickupDate, whereStaying?.tz ?? plan.tz),
        personIds: query.passengerIds,
        partyIds: data.parties.map((party) => party.id),
      }),
    ];
  }

  const proposals = runs.map((run) => {
    const landing = run.direction === "arrival";
    const people = coming.filter((person) => run.personIds.includes(person.id));
    const count = headCount(people, 0);
    const passengers = people.length > 0 ? people.length : run.personIds.length;
    const yours = !organizer || run.personIds.length === 0 || run.personIds.includes(organizer.id);
    const who = run.partyName ? inSentence(run.partyName) : undefined;
    const flight = run.flight ?? "the flight";

    let pickup: { date: string; time: string };
    let pickupBecause: string;
    if (landing) {
      pickup = localAt(roundUp(Date.parse(run.at.at) + TIMINGS.rideAfterLandingMinutes * MINUTE, 5), run.at.tz);
      pickupBecause = `${durationWords(TIMINGS.rideAfterLandingMinutes)} after ${yours ? "you land" : "they land"}`;
    } else {
      const airportMinutes = run.international ? TIMINGS.airportMinutesInternational : TIMINGS.airportMinutesDomestic;
      const estimate = estimateDriveMinutes(whereStaying, run.airportPlace);
      const drive = estimate ?? TIMINGS.defaultDriveMinutes;
      const leaveMs = roundDown(Date.parse(run.at.at) - (airportMinutes + drive) * MINUTE, 5);
      pickup = localAt(leaveMs, whereStaying?.tz ?? run.at.tz);
      pickupBecause = `to be at the airport ${durationWords(airportMinutes)} before the ${clockAt(run.at)} flight, with about ${durationWords(drive)} for the drive`;
    }

    const query: RideQuery = {
      kind: "ride",
      rideType: "rideshare",
      direction: landing ? "from_airport" : "to_airport",
      fromPlace: landing ? run.airportPlace : whereStaying,
      toPlace: landing ? whereStaying : run.airportPlace,
      pickupDate: pickup.date,
      pickupTime: pickup.time,
      passengers,
      passengerIds: people.map((person) => person.id),
      bags: run.bags,
      childSeatNeeded: count.needChildSeat > 0,
      arrivalIds: run.arrivalId ? [run.arrivalId] : [],
    };

    const missing: string[] = [];
    if (!stayAt) missing.push("Add where you're staying and we'll fill in the address.");
    if (!run.airportPlace) missing.push("We don't know which airport this flight uses. Choose it below.");
    if (passengers === 0) missing.push("Say who is on this flight so we can count riders.");

    const base = landing ? "Ride from the airport" : "Ride to the airport";
    return build<RideQuery>({
      key: `ride:${run.direction}:${run.key}`,
      title: who && data.parties.length > 1 ? `${base} for ${who}` : base,
      query,
      reasons: {
        from: landing ? `where ${flight} lands` : stayBecause,
        to: landing ? stayBecause : `where ${flight} leaves from`,
        pickup: pickupBecause,
        riders: who ? `${who}${run.flight ? ` on ${run.flight}` : ""}` : run.flight ? `everyone on ${run.flight}` : undefined,
        bags: "what they told you",
        childSeat: `a child ${TIMINGS.childSeatMaxAge} or under is riding`,
      },
      missing,
      notes: rideNotes(ctx, pickup.date, whereStaying?.tz ?? run.at.tz),
      personIds: query.passengerIds,
      partyIds: run.partyId ? [run.partyId] : [],
      coveredBy: rideCover(ctx, run),
    });
  });
  return openFirst(proposals);
}

// --- food -----------------------------------------------------------------------------------------

const FOOD_PROVIDERS_BY_TYPE: Readonly<Record<MealType, ReadonlyArray<keyof typeof FOOD_ORDER_WINDOW_DAYS>>> = {
  restaurant_delivery: ["uber_eats", "doordash", "grubhub"],
  groceries: ["instacart"],
  catering: ["ezcater"],
};

/**
 * One line on when a food provider starts taking an order for a delivery date:
 *   "DoorDash takes orders 4 days ahead. Ordering opens Tue, Dec 15."
 *   "DoorDash takes orders 4 days ahead, so you can order now."
 *   "ezCater takes orders any time. Give the caterer at least 2 days."
 * `today` is the local date at the delivery place.
 */
export function orderWindowNote(provider: keyof typeof FOOD_ORDER_WINDOW_DAYS, deliveryDate: string | undefined, today: string): string {
  const name = PROVIDERS[provider].name;
  const days = FOOD_ORDER_WINDOW_DAYS[provider];
  if (days === null) return `${name} takes orders any time. Give the caterer at least 2 days.`;
  const lead = `${name} takes orders ${days} days ahead`;
  if (!deliveryDate) return `${lead}.`;
  const opens = addDays(deliveryDate, -days);
  return compareDates(opens, today) > 0 ? `${lead}. Ordering opens ${dateText(opens)}.` : `${lead}, so you can order now.`;
}

/** The first day `provider` takes an order for `deliveryDate`, or null when it takes orders any time. */
export function orderOpensOn(provider: keyof typeof FOOD_ORDER_WINDOW_DAYS, deliveryDate: string): string | null {
  const days = FOOD_ORDER_WINDOW_DAYS[provider];
  return days === null ? null : addDays(deliveryDate, -days);
}

type DeliveryPlan = { date?: string; start?: string; end?: string; because?: string; late: boolean };

/** When to have food arrive on the first evening: after check-in, after the trip from the airport, and not before dinner time. */
function arrivalEveningWindow(ctx: BookingContext, landing: AirportRun | undefined): DeliveryPlan {
  const { data } = ctx;
  const stay = stayOf(data);
  const tz = stay?.details.place?.tz ?? data.plan.destination?.tz ?? data.plan.tz;
  const date = landing ? localDateOf(landing.at.at, tz) : (stay?.details.checkInDate ?? data.plan.startDate ?? undefined);
  if (!date) return { late: false };

  const at = (time: string) => zonedToUtc(`${date}T${time}`, tz).getTime();
  // Each rule gives an earliest time; the latest of them wins. On a tie the more specific
  // reason is the one given: the landing, then check-in, then plain dinner time.
  const rules: Array<{ ms: number; why: "landing" | "check_in" | "dinner" }> = [];
  if (landing) rules.push({ ms: Date.parse(landing.at.at) + TIMINGS.deliveryAfterLandingMinutes * MINUTE, why: "landing" });
  if (stay?.details.checkInDate === date) {
    rules.push({ ms: at(stay.details.checkInTime) + TIMINGS.deliveryAfterCheckInMinutes * MINUTE, why: "check_in" });
  }
  rules.push({ ms: at(TIMINGS.defaultDinnerTime), why: "dinner" });
  const rounded = rules.map((rule) => ({ ...rule, ms: roundUp(rule.ms, 30) }));
  const governing = rounded.reduce((best, rule) => (rule.ms > best.ms ? rule : best));
  const startMs = governing.ms;

  // Too late for most kitchens (or past midnight): plan for the next morning instead.
  if (startMs > at(TIMINGS.lastSensibleDeliveryTime)) {
    return { date: addDays(date, 1), start: "09:00", end: "10:00", because: "you get in late, so this is for the next morning", late: true };
  }
  const start = localAt(startMs, tz);
  const end = localAt(startMs + TIMINGS.deliveryWindowMinutes * MINUTE, tz);
  const because =
    governing.why === "landing" && landing
      ? `you land at ${clockAt(landing.at)}, so you should be in by about ${clockText(start.time)}`
      : governing.why === "check_in" && stay
        ? `an hour after check-in opens at ${clockText(stay.details.checkInTime)}`
        : "dinner time on the day you arrive";
  return { date: start.date, start: start.time, end: end.time, because, late: false };
}

function proposeFood(ctx: BookingContext): FoodProposal[] {
  const { data } = ctx;
  const plan = data.plan;
  const runs = airportRuns(ctx);
  const landing = mainArrival(ctx, runs);
  const stay = stayOf(data);
  const place = stay?.details.place;
  const coming = comingPeople(data);
  const count = headCount(coming, plan.expectedPeople);
  const window = arrivalEveningWindow(ctx, landing);
  const tz = place?.tz ?? plan.destination?.tz ?? plan.tz;
  const today = localDateOf(ctx.now, tz);
  const organizer = data.people.find((person) => person.role === "organizer");
  const atHotel = stay?.details.lodgingType === "hotel" || stay?.details.lodgingType === "room_block";
  const arrivalDate = landing ? localDateOf(landing.at.at, tz) : (stay?.details.checkInDate ?? plan.startDate ?? undefined);
  // For a hotel the driver cannot come to the room, so say who it is for (product spec 5.7).
  const deliveryNote = atHotel && organizer && arrivalDate ? `Guest ${organizer.name}, arriving ${formatDate(arrivalDate)}. Leave with the front desk.` : undefined;

  const types: MealType[] = plan.template === "work" && plan.workMode === "event" ? ["catering", "restaurant_delivery", "groceries"] : ["restaurant_delivery", "groceries"];
  const titles: Record<MealType, string> = {
    restaurant_delivery: "Dinner on arrival night",
    groceries: "Groceries for when you arrive",
    catering: "Catering for the group",
  };
  const keys: Record<MealType, string> = { restaurant_delivery: "dinner", groceries: "groceries", catering: "catering" };
  const booked = bookingsOf(data, "meal").filter(isBooked);

  const proposals = types.map((mealType) => {
    const query: FoodQuery = {
      kind: "meal",
      mealType,
      deliverToPlace: place,
      date: window.date,
      windowStart: window.start,
      windowEnd: window.end,
      headcount: count.total,
      dietarySummary: dietarySummary(coming),
      deliveryNote,
    };
    const missing: string[] = [];
    if (!place) missing.push("Add where you're staying and we'll fill in the delivery address.");
    if (!window.date) missing.push("Pick your dates and we'll plan this for the night you arrive.");
    else if (!landing && !stay?.details.checkInDate) missing.push("Add your flight or where you're staying and we'll time the delivery to when you get in.");
    if (count.total === 0) missing.push("Add who's coming so we know how many to feed.");

    const notes = FOOD_PROVIDERS_BY_TYPE[mealType].map((provider) => orderWindowNote(provider, window.date, today));
    if (window.late) notes.push("You get in late. Most places stop delivering around 10 PM, so this is planned for the next morning.");
    const unanswered = coming.filter((person) => person.rsvpStatus !== "yes").length;
    if (coming.length > 0 && unanswered > 0 && !query.dietarySummary) notes.push("Not everyone has replied yet, so dietary needs may still come in.");

    const cover = booked.find(
      (meal) => meal.details.mealType === mealType && meal.details.windowStart && window.date && Math.abs(diffDays(localDateOf(meal.details.windowStart.at, meal.details.windowStart.tz), window.date)) <= 1,
    );
    return build<FoodQuery>({
      key: `meal:arrival-evening:${keys[mealType]}`,
      title: titles[mealType],
      query,
      reasons: {
        deliverTo: "where you're staying",
        when: window.because,
        headcount: coming.length === 0 ? "the number you gave when you made the plan" : count.children + count.infants > 0 ? groupText(count) : "everyone who's coming",
        dietary: "from people's replies",
        note: "hotels hold deliveries at the front desk",
      },
      missing,
      notes,
      personIds: coming.map((person) => person.id),
      partyIds: data.parties.map((party) => party.id),
      coveredBy: cover ? `Ordered: ${cover.details.vendorName ?? cover.title}` : undefined,
    });
  });
  return openFirst(proposals);
}

// --- the one function -----------------------------------------------------------------------------

/**
 * What to look for, for one booking kind, already filled in from the plan.
 *
 * Returns one proposal per search to run, open ones first:
 *   "flight"   one per group of households that fly from the same airport
 *   "lodging"  one for the destination, plus one for each extra stop of the trip
 *   "car"      one, picked up after the organizer's landing and returned before the flight home
 *   "ride"     one for each landing (airport to the stay) and each departure (stay to airport)
 *   "meal"     dinner and groceries for arrival night (and catering first, for a work event)
 * The list is never empty. A proposal the plan already covers has `status: "covered"` and says
 * by what; a proposal the app could not complete lists what is `missing` in plain words.
 *
 * Show `proposal.fields` as editable lines. When the person changes one, call `reviseProposal`.
 * Pass the proposal to `handoffLinks` for the provider buttons.
 */
export function proposeSearch<K extends SearchKind>(kind: K, ctx: BookingContext): ProposalOf<K>[] {
  switch (kind) {
    case "flight":
      return proposeFlights(ctx) as ProposalOf<K>[];
    case "lodging":
      return proposeStay(ctx) as ProposalOf<K>[];
    case "car":
      return proposeCar(ctx) as ProposalOf<K>[];
    case "ride":
      return proposeRides(ctx) as ProposalOf<K>[];
    case "meal":
      return proposeFood(ctx) as ProposalOf<K>[];
    default:
      throw new RangeError(`There is nothing to search for a ${String(kind)}`);
  }
}
