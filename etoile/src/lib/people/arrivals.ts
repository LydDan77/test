// The arrivals board (product spec section 12): who lands when, where, and who needs a ride.
//
// resolveArrivals(planData, now) turns the stored arrival rows, the recorded flights and the
// people into the rows the board shows, for both directions. Pure: no database, no clock.
//
// Where rows come from
//  - Every stored arrival is one row: a household, in one direction. When it is linked to a
//    recorded flight, the time, the flight number and the airports are read from the booking,
//    never from the arrival's own columns.
//  - The database keeps one arrival per household per direction. A household split across two
//    flights therefore has people on a recorded flight with no arrival row of their own. Those
//    people get a row read straight from the flight (`arrivalId` is null), so nobody on a booked
//    flight is ever missing from the board.
//  - People who are expected and have neither are listed in `missing` ("No arrival yet: …").
//
// Nothing private is put in a row or in the text version: no phone numbers, no confirmation
// codes, no prices. Rows carry person ids, so an organizer's screen can look those up itself.

import type { Arrival, Booking, Party, Person } from "@/db/schema";
import type { ArrivalDirection, ArrivalMode, ArrivalSource, ArrivalStatus, FlightSegment, ZonedInstant } from "@/lib/domain";
import { flightDesignator } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { compareDates, localDateOf, toEpochMs, type InstantInput, type LocalDate } from "@/lib/time";
import {
  counts,
  detailsOf,
  flightEnds,
  flightPassengerIds,
  isExpected,
  isSettled,
  journeyEnd,
  journeyStart,
  statusCredit,
} from "./shared";
import {
  clockText,
  count,
  dayText,
  firstNames,
  firstNameOf,
  listOf,
  lowerFirst,
  upperFirst,
  weekdayName,
  type Wording,
} from "./text";

/** The parts of a plan the board reads. A whole PlanData works. */
export type ArrivalsInput = Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings">;

export type ArrivalsOptions = {
  /** How times are written in sentences and the text version. */
  wording?: Wording;
  /** Arrivals into one airport this many minutes apart or less share a pickup run. Default 45. */
  runWindowMinutes?: number;
};

/**
 * How a row's ride is covered.
 *  - "needs_ride": they asked for one and nothing is arranged. The one state that needs the organizer.
 *  - "unknown": nobody has said yet. Counts as not sorted.
 *  - "driver": a person in the plan is collecting them.
 *  - "rideshare": a ride is planned or booked, or they said they will get one themselves.
 *  - "rental_car", "own_car", "not_needed": covered.
 *  - "driving": they are arriving by road in their own car.
 *  - "already_here": they live there.
 */
export type RideState =
  | "needs_ride"
  | "unknown"
  | "driver"
  | "rideshare"
  | "rental_car"
  | "own_car"
  | "not_needed"
  | "driving"
  | "already_here";

/** Does the driver's car fit the people it is meeting? */
export type SeatCheck = {
  /** True when everyone fits, false when they do not, null when the seat count is not known. */
  ok: boolean | null;
  /** Seats for passengers, not counting the driver. Null when not known. */
  seats: number | null;
  /** People to collect: the whole pickup run when the row is part of one. */
  passengers: number;
  /** Bags, when anyone said how many. */
  bags: number | null;
  /** "Rob's car seats 4 passengers. This run is 5 people and 6 bags." */
  sentence: string;
};

export type BoardRide = {
  state: RideState;
  /** False for "needs_ride" and "unknown": the row still needs the organizer. */
  resolved: boolean;
  /** For the Ride column: "Needs a ride", "Rob is driving", "Renting a car", "Uber planned", "Own car". */
  label: string;
  /** The same words for the middle of a line of text: "needs a ride", "Rob is driving". */
  inline: string;
  driver: { personId: string; name: string } | null;
  rideBookingId: string | null;
  /**
   * How settled this ride is, for "things left": 1 sorted, 0.25 planned, 0.5 still looking,
   * 0 not sorted. Null when the row needs no ride at all (own car, rental car, already here).
   */
  credit: number | null;
  seatCheck: SeatCheck | null;
};

export type BoardFlight = {
  /** "AS 1054". */
  designator: string;
  /** The recorded booking it was read from; null when a guest typed the flight themselves. */
  bookingId: string | null;
  segmentIndex: number | null;
  originIata: string | null;
  destinationIata: string | null;
  /** Airports where they change planes on this journey, in order: ["DEN"]. */
  connections: string[];
};

/** Where a row meets the plan's place: the airport or station, or the road. */
export type BoardPlace = {
  /** Groups rows on the board: an airport code, a station name, "road", "here" or "unknown". */
  key: string;
  /** "MCO", "Union Station", "By road", "Already here". */
  label: string;
  iata: string | null;
  terminal: string | null;
};

export type BoardStatus = {
  value: ArrivalStatus;
  /** "Scheduled", "On the way", "Landed 4:02 PM", "Picked up", "Arrived", "Not booked", "Canceled". */
  label: string;
  /** When the status was set, in the row's zone. */
  at: ZonedInstant | null;
};

export type ArrivalRow = {
  /** Stable for a list key: "arrival:<id>", or "flight:<bookingId>:<segment>:<partyId>". */
  key: string;
  /** The stored arrival behind the row. Null when the row was read straight from a recorded flight. */
  arrivalId: string | null;
  direction: ArrivalDirection;
  partyId: string;
  partyName: string;
  /** Who is on it: expected people only (anyone who said no is left out). */
  personIds: string[];
  firstNames: string[];
  headCount: number;
  /** Children and infants among them: child seats to think about. */
  childCount: number;
  /** "The Seattle Hartleys (4)", "Dana and Chris (2)", "Rob". */
  who: string;
  mode: ArrivalMode;
  /** The booked time. For a linked flight this is always the booking's time. */
  scheduled: ZonedInstant | null;
  /** A later time someone entered by hand ("now 5:05 PM"). Null when nothing changed. */
  expected: ZonedInstant | null;
  /** The time to go by: `expected` when there is one, else `scheduled`. */
  at: ZonedInstant | null;
  /** "4:10 PM"; "About 3:00 PM" for someone coming by road. Null when no time is known. */
  timeText: string | null;
  /** The day the row sits on, local to its place. */
  localDate: LocalDate | null;
  flight: BoardFlight | null;
  /** Arrivals: where they are coming from. Departures: where they are headed. A city or an airport code. */
  otherEnd: string | null;
  place: BoardPlace;
  ride: BoardRide;
  bags: number | null;
  status: BoardStatus;
  /** True once they are at the plan's place: marked arrived, or they live there. */
  here: boolean;
  /** True when the row's time is before `now`. */
  past: boolean;
  /** The pickup run this row belongs to, when it shares one. */
  runId: string | null;
  source: ArrivalSource;
};

/** Arrivals close enough together at one airport for one trip to meet them all. */
export type PickupRun = {
  id: string;
  date: LocalDate;
  place: BoardPlace;
  rowKeys: string[];
  headCount: number;
  childCount: number;
  bags: number | null;
  first: ZonedInstant;
  last: ZonedInstant;
  /** Minutes between the first and the last landing. */
  waitMinutes: number;
  driver: { personId: string; name: string } | null;
  seatCheck: SeatCheck | null;
  /** "One trip can meet both: 6 people, first lands 3:55 PM, last 4:30 PM." */
  sentence: string;
};

/** People who are expected and have nothing on record for one direction. */
export type MissingTravel = {
  partyId: string;
  partyName: string;
  personIds: string[];
  names: string[];
  /** Where the household comes from, when known: "Portland". */
  from: string | null;
  /** "Dana and Chris (Portland)". */
  label: string;
};

export type RideCounts = {
  /** People travelling (those who live there are not counted). */
  people: number;
  haveRides: number;
  needRide: number;
  /** People whose household has not said whether it needs a ride. */
  notKnown: number;
};

export type BoardGroup = { place: BoardPlace; rows: ArrivalRow[]; runs: PickupRun[] };

export type BoardDay = {
  date: LocalDate;
  /** "Sat, Dec 19". */
  label: string;
  isToday: boolean;
  /** "9 arriving Saturday · 6 have rides · 3 need a ride". */
  summary: string;
  counts: RideCounts;
  /** By airport (or "By road"), each sorted by time. */
  groups: BoardGroup[];
  /** People on this day's rows who are already at the plan's place: "Arrived (4)". */
  hereCount: number;
};

export type BoardSide = {
  direction: ArrivalDirection;
  /** Every row, sorted by time; rows with no time last. */
  rows: ArrivalRow[];
  days: BoardDay[];
  /** Rows with no time yet, and people who are already there. */
  undated: ArrivalRow[];
  runs: PickupRun[];
  missing: MissingTravel[];
  /** "No arrival yet: Dana and Chris (Portland)". Null when nobody is missing. */
  missingLine: string | null;
  counts: RideCounts;
  /** One line for the top of the board. Empty when there are no rows. */
  summary: string;
  /** A plain list to paste into a group text. Empty when there is nothing to say. */
  text: string;
};

export type ArrivalsBoard = {
  arrivals: BoardSide;
  departures: BoardSide;
  /** True when no row exists in either direction: show the empty state. */
  isEmpty: boolean;
};

const DOT = " · ";

type Context = {
  input: ArrivalsInput;
  nowMs: number;
  today: LocalDate;
  wording: Wording;
  runWindowMs: number;
  peopleById: Map<string, Person>;
  partiesById: Map<string, Party>;
  bookingsById: Map<string, Booking>;
  membersByParty: Map<string, Person[]>;
};

/**
 * The arrivals board for a plan, both directions.
 *
 *   const board = resolveArrivals(planData, now);
 *   board.arrivals.summary          // "9 arriving Saturday · 6 have rides · 3 need a ride"
 *   board.arrivals.days[0].groups   // by airport, rows sorted by time, pickup runs bracketed
 *   board.arrivals.missingLine      // "No arrival yet: Dana and Chris (Portland)"
 *   board.arrivals.text             // the plain list for a group text
 *
 * `now` only decides which day is "today", which rows are past, and nothing else: the board
 * never moves a time by itself.
 */
export function resolveArrivals(input: ArrivalsInput, now: InstantInput, options: ArrivalsOptions = {}): ArrivalsBoard {
  const nowMs = toEpochMs(now);
  const membersByParty = new Map<string, Person[]>();
  for (const person of input.people) {
    const list = membersByParty.get(person.partyId) ?? [];
    list.push(person);
    membersByParty.set(person.partyId, list);
  }
  const ctx: Context = {
    input,
    nowMs,
    today: localDateOf(nowMs, input.plan.tz),
    wording: options.wording ?? {},
    runWindowMs: (options.runWindowMinutes ?? 45) * 60_000,
    peopleById: new Map(input.people.map((person) => [person.id, person])),
    partiesById: new Map(input.parties.map((party) => [party.id, party])),
    bookingsById: new Map(input.bookings.map((booking) => [booking.id, booking])),
    membersByParty,
  };
  const arrivals = buildSide(ctx, "arrival");
  const departures = buildSide(ctx, "departure");
  return { arrivals, departures, isEmpty: arrivals.rows.length === 0 && departures.rows.length === 0 };
}

/**
 * Each person's own arrival and departure rows: the lookup behind "where is each person
 * sleeping", the travel status table and the readiness score. A person with no row for a
 * direction has nothing on record for it.
 */
export function travelByPerson(board: ArrivalsBoard): Map<string, { arrival: ArrivalRow | null; departure: ArrivalRow | null }> {
  const byPerson = new Map<string, { arrival: ArrivalRow | null; departure: ArrivalRow | null }>();
  const note = (row: ArrivalRow, direction: "arrival" | "departure") => {
    if (row.status.value === "cancelled") return;
    for (const personId of row.personIds) {
      const entry = byPerson.get(personId) ?? { arrival: null, departure: null };
      entry[direction] ??= row;
      byPerson.set(personId, entry);
    }
  };
  for (const row of board.arrivals.rows) note(row, "arrival");
  for (const row of board.departures.rows) note(row, "departure");
  return byPerson;
}

/**
 * True when a row says how the people on it are travelling: a flight with a number or a time,
 * or any other way of getting there ("driving", "already there"). A row that only says "flying"
 * with no flight and no time is not on record yet, and neither is a cancelled one.
 */
export function isOnRecord(row: ArrivalRow | null | undefined): row is ArrivalRow {
  if (!row || row.status.value === "cancelled") return false;
  return row.mode !== "flight" || row.flight !== null || row.at !== null;
}

// --- building one side ----------------------------------------------------------------------------

function buildSide(ctx: Context, direction: ArrivalDirection): BoardSide {
  const rows: ArrivalRow[] = [];
  const covered = new Set<string>();

  for (const arrival of ctx.input.arrivals) {
    if (arrival.direction !== direction) continue;
    const row = rowFromArrival(ctx, arrival);
    if (!row) continue;
    rows.push(row);
    if (row.status.value !== "cancelled") for (const id of row.personIds) covered.add(id);
  }

  // People on a recorded flight with no arrival row of their own (a household split across flights).
  for (const booking of ctx.input.bookings) {
    const details = detailsOf(booking, "flight");
    if (!details || !isSettled(booking) || details.segments.length === 0) continue;
    const index = flightEnds(details, ctx.input.plan)[direction];
    if (index === null) continue;
    const byParty = new Map<string, Person[]>();
    for (const personId of flightPassengerIds(booking, ctx.input)) {
      const person = ctx.peopleById.get(personId);
      if (!person || !isExpected(person) || covered.has(personId)) continue;
      const list = byParty.get(person.partyId) ?? [];
      list.push(person);
      byParty.set(person.partyId, list);
    }
    for (const [partyId, people] of byParty) {
      const party = ctx.partiesById.get(partyId);
      rows.push(
        makeRow(ctx, {
          key: `flight:${booking.id}:${index}:${partyId}`,
          arrival: null,
          direction,
          partyId,
          partyName: party?.name ?? listOf(firstNames(people)),
          people,
          mode: "flight",
          linked: { booking, segments: details.segments, index },
          source: booking.guestProvided ? "guest" : "booking",
        }),
      );
      for (const person of people) covered.add(person.id);
    }
  }

  rows.sort(compareRows(ctx));
  const runs = direction === "arrival" ? bracketRuns(ctx, rows) : [];
  attachSeatChecks(ctx, rows, runs);

  const missing = findMissing(ctx, covered);
  const noun = direction === "arrival" ? "arrival" : "trip home";
  const missingLine = missing.length ? `No ${noun} yet: ${missing.map((m) => m.label).join(", ")}` : null;

  const dated = rows.filter((row) => row.localDate !== null && row.mode !== "local");
  const undated = rows.filter((row) => row.localDate === null || row.mode === "local");
  const days = groupDays(ctx, direction, dated, runs);
  const total = rideCounts(rows);
  const oneDay = days.length === 1 && undated.every((row) => row.mode === "local") ? days[0].date : null;
  const side: BoardSide = {
    direction,
    rows,
    days,
    undated,
    runs,
    missing,
    missingLine,
    counts: total,
    summary: rows.length ? summaryLine(direction, total, oneDay) : "",
    text: "",
  };
  side.text = textVersion(side);
  return side;
}

type LinkedFlight = { booking: Booking; segments: FlightSegment[]; index: number };

function rowFromArrival(ctx: Context, arrival: Arrival): ArrivalRow | null {
  const party = ctx.partiesById.get(arrival.partyId);
  const members = ctx.membersByParty.get(arrival.partyId) ?? [];
  const listed = arrival.personIds.map((id) => ctx.peopleById.get(id)).filter((p): p is Person => p !== undefined);
  // No names on the arrival means the whole household.
  const people = (listed.length > 0 ? listed : members).filter(isExpected);
  // A household where everyone has said no is not arriving. A household nobody has named yet still is.
  if (people.length === 0 && (listed.length > 0 || members.length > 0)) return null;

  return makeRow(ctx, {
    key: `arrival:${arrival.id}`,
    arrival,
    direction: arrival.direction,
    partyId: arrival.partyId,
    partyName: party?.name ?? (people.length ? listOf(firstNames(people)) : "Guests"),
    people,
    mode: arrival.mode,
    linked: linkedFlight(ctx, arrival),
    source: arrival.source,
  });
}

/** The recorded flight segment an arrival points at, when it still exists. */
function linkedFlight(ctx: Context, arrival: Arrival): LinkedFlight | null {
  if (!arrival.bookingId) return null;
  const booking = ctx.bookingsById.get(arrival.bookingId);
  if (!booking || !counts(booking)) return null;
  const details = detailsOf(booking, "flight");
  if (!details || details.segments.length === 0) return null;
  const index = arrival.segmentIndex ?? flightEnds(details, ctx.input.plan)[arrival.direction];
  if (index === null || index < 0 || index >= details.segments.length) return null;
  return { booking, segments: details.segments, index };
}

type RowSeed = {
  key: string;
  arrival: Arrival | null;
  direction: ArrivalDirection;
  partyId: string;
  partyName: string;
  people: Person[];
  mode: ArrivalMode;
  linked: LinkedFlight | null;
  source: ArrivalSource;
};

function makeRow(ctx: Context, seed: RowSeed): ArrivalRow {
  const { arrival, direction, people, linked } = seed;
  const segment = linked ? linked.segments[linked.index] : null;
  // A row that points at a recorded flight is a flight, whatever was typed before the flight was recorded.
  const mode: ArrivalMode = linked ? "flight" : seed.mode;

  let scheduled: ZonedInstant | null = null;
  let expectedAt: string | null = arrival?.expectedAt ? arrival.expectedAt.toISOString() : null;
  let flight: BoardFlight | null = null;
  let otherEnd: string | null = null;
  let place: BoardPlace;

  if (linked && segment) {
    const first = journeyStart(linked.segments, linked.index);
    const last = journeyEnd(linked.segments, linked.index);
    const connections: string[] = [];
    if (direction === "arrival") {
      scheduled = { at: segment.arrivesAt, tz: segment.destinationTz };
      expectedAt = segment.expectedArrivalAt ?? expectedAt;
      for (let i = first; i < linked.index; i++) connections.push(linked.segments[i].destinationIata);
      otherEnd = linked.segments[first].originIata;
      place = airportPlace(segment.destinationIata, segment.arrivalTerminal ?? null);
    } else {
      scheduled = { at: segment.departsAt, tz: segment.originTz };
      for (let i = linked.index; i < last; i++) connections.push(linked.segments[i].destinationIata);
      otherEnd = linked.segments[last].destinationIata;
      place = airportPlace(segment.originIata, segment.terminal ?? null);
    }
    flight = {
      designator: flightDesignator(segment),
      bookingId: linked.booking.id,
      segmentIndex: linked.index,
      originIata: segment.originIata,
      destinationIata: segment.destinationIata,
      connections,
    };
  } else {
    const tz = arrival?.tz ?? arrival?.toPlace?.tz ?? ctx.input.plan.tz;
    if (arrival?.scheduledAt) scheduled = { at: arrival.scheduledAt.toISOString(), tz };
    const typed = [arrival?.carrier, arrival?.number].filter(Boolean).join(" ");
    if (mode === "flight" && typed) {
      flight = { designator: typed, bookingId: null, segmentIndex: null, originIata: null, destinationIata: null, connections: [] };
    }
    otherEnd = arrival?.fromLabel ?? ctx.partiesById.get(seed.partyId)?.origin?.name ?? null;
    place = unlinkedPlace(mode, arrival);
  }

  const expected: ZonedInstant | null =
    scheduled && expectedAt && toEpochMs(expectedAt) !== toEpochMs(scheduled.at)
      ? { at: expectedAt, tz: scheduled.tz }
      : !scheduled && expectedAt
        ? { at: expectedAt, tz: arrival?.tz ?? ctx.input.plan.tz }
        : null;
  const at = expected ?? scheduled;
  const approximate = mode === "drive" || mode === "other";
  const clock = at ? clockText(at.at, at.tz, ctx.wording) : null;

  const names = firstNames(people);
  const members = (ctx.membersByParty.get(seed.partyId) ?? []).filter(isExpected);
  const wholeParty = people.length === members.length && people.length > 1;
  const whoName = wholeParty || people.length === 0 ? seed.partyName : listOf(names);
  const tz = at?.tz ?? arrival?.tz ?? ctx.input.plan.tz;
  const statusValue = arrival?.status ?? "unknown";

  return {
    key: seed.key,
    arrivalId: arrival?.id ?? null,
    direction,
    partyId: seed.partyId,
    partyName: seed.partyName,
    personIds: people.map((person) => person.id),
    firstNames: names,
    headCount: people.length,
    childCount: people.filter((person) => person.ageGroup !== "adult").length,
    who: people.length > 1 ? `${whoName} (${people.length})` : whoName,
    mode,
    scheduled,
    expected,
    at,
    timeText: clock ? (approximate ? `About ${clock}` : clock) : null,
    localDate: at ? localDateOf(at.at, at.tz) : null,
    flight,
    otherEnd,
    place,
    ride: resolveRide(ctx, { arrival, mode, direction, personIds: people.map((person) => person.id), iata: place.iata, at }),
    bags: arrival?.bags ?? null,
    status: statusOf(ctx, statusValue, arrival?.statusAt ?? null, tz, mode, at !== null, direction),
    here: mode === "local" || (direction === "arrival" && statusValue === "arrived"),
    past: at !== null && toEpochMs(at.at) < ctx.nowMs,
    runId: null,
    source: seed.source,
  };
}

function airportPlace(iata: string, terminal: string | null): BoardPlace {
  return { key: iata, label: iata, iata, terminal };
}

function unlinkedPlace(mode: ArrivalMode, arrival: Arrival | null): BoardPlace {
  const to = arrival?.toPlace ?? null;
  switch (mode) {
    case "local":
      return { key: "here", label: "Already here", iata: null, terminal: null };
    case "drive":
      return { key: "road", label: "By road", iata: null, terminal: null };
    case "flight":
    case "train":
    case "bus":
    case "other": {
      const label = to?.iata ?? to?.name ?? null;
      if (label) return { key: label, label, iata: to?.iata ?? null, terminal: null };
      const fallback = { flight: "Airport not known yet", train: "By train", bus: "By bus", other: "Another way" }[mode];
      return { key: mode === "flight" ? "unknown" : mode, label: fallback, iata: null, terminal: null };
    }
  }
}

function statusOf(
  ctx: Context,
  value: ArrivalStatus,
  statusAt: Date | null,
  tz: string,
  mode: ArrivalMode,
  hasTime: boolean,
  direction: ArrivalDirection,
): BoardStatus {
  const at: ZonedInstant | null = statusAt ? { at: statusAt.toISOString(), tz } : null;
  const when = at ? ` ${clockText(at.at, at.tz, ctx.wording)}` : "";
  let label: string;
  switch (value) {
    case "cancelled":
      label = "Canceled";
      break;
    case "arrived":
      label = direction === "arrival" ? "Arrived" : "Home safe";
      break;
    case "picked_up":
      label = "Picked up";
      break;
    case "landed":
      label = `Landed${when}`;
      break;
    case "en_route":
      label = "On the way";
      break;
    case "scheduled":
      label = "Scheduled";
      break;
    case "unknown":
      label = mode === "local" ? "Already here" : hasTime ? "Scheduled" : mode === "flight" ? "Not booked" : "No time yet";
      break;
  }
  return { value, label, at };
}

// --- rides ------------------------------------------------------------------------------------

/** What is known about a row when its ride is worked out. */
type RideQuery = {
  arrival: Arrival | null;
  mode: ArrivalMode;
  direction: ArrivalDirection;
  personIds: string[];
  /** The airport the row lands at or leaves from. */
  iata: string | null;
  at: ZonedInstant | null;
};

function resolveRide(ctx: Context, query: RideQuery): BoardRide {
  const { arrival, mode } = query;
  /** `label` starts with a name ("Rob is driving", "Uber planned") when `startsWithName` is set. */
  const ride = (
    state: RideState,
    label: string,
    credit: number | null,
    extra: Partial<BoardRide> = {},
    startsWithName = false,
  ): BoardRide => ({
    state,
    resolved: state !== "needs_ride" && state !== "unknown",
    label,
    inline: startsWithName ? label : lowerFirst(label),
    driver: null,
    rideBookingId: null,
    credit,
    seatCheck: null,
    ...extra,
  });

  if (mode === "local") return ride("already_here", "Already here", null);
  const need = arrival?.rideNeed ?? "unknown";
  if (need === "rental_car") return ride("rental_car", "Renting a car", null);
  if (need === "own_car") return ride("own_car", "Own car", null);
  if (need === "not_needed") return ride("not_needed", "No ride needed", null);

  const rideBooking = findRideBooking(ctx, query);
  const rideDetails = rideBooking ? detailsOf(rideBooking, "ride") : null;
  const driverId = arrival?.driverPersonId ?? rideDetails?.driverPersonId ?? null;
  const driverPerson = driverId ? ctx.peopleById.get(driverId) : undefined;

  if (driverPerson) {
    const first = firstNameOf(driverPerson.name);
    return ride(
      "driver",
      `${first} is driving`,
      1,
      { driver: { personId: driverPerson.id, name: first }, rideBookingId: rideBooking?.id ?? null },
      true,
    );
  }
  if (rideBooking && rideDetails) {
    const provider = rideBooking.provider ?? rideBooking.vendorName;
    const generic =
      rideDetails.rideType === "shuttle"
        ? "Shuttle"
        : rideDetails.rideType === "taxi"
          ? "Taxi"
          : rideDetails.rideType === "personal_pickup"
            ? "Pickup"
            : "Ride";
    const what = provider ? upperFirst(provider) : generic;
    return ride(
      "rideshare",
      `${what} ${isSettled(rideBooking) ? "booked" : "planned"}`,
      statusCredit(rideBooking.status) ?? 0,
      { rideBookingId: rideBooking.id },
      provider !== null,
    );
  }
  if (need === "rideshare") return ride("rideshare", "Rideshare", 1);
  if (need === "driver_assigned") return ride("needs_ride", "Needs a driver", 0);
  if (need === "needs_ride") return ride("needs_ride", "Needs a ride", 0);
  if (mode === "drive") return ride("driving", "Own car", null);
  // Nobody has said. For someone arriving that is an open question (product spec 12.4); for the
  // trip home it is not counted as a ride to arrange until someone asks for one.
  return ride("unknown", "Ride not known yet", query.direction === "arrival" ? 0 : null);
}

const HOUR_MS = 3_600_000;

/**
 * The ride booking that meets a row: the one its arrival points at, one that lists the arrival,
 * or failing both a ride for the same people at the same airport around the same time (a ride
 * from the airport up to an hour before landing or six after; a ride to the airport in the
 * eight hours before the flight).
 */
function findRideBooking(ctx: Context, query: RideQuery): Booking | null {
  const { arrival } = query;
  if (arrival?.rideBookingId) {
    const linked = ctx.bookingsById.get(arrival.rideBookingId);
    if (linked && linked.kind === "ride" && counts(linked)) return linked;
  }
  const rides = ctx.input.bookings.filter((booking) => booking.kind === "ride" && counts(booking));
  if (arrival) {
    const listing = rides.find((booking) => detailsOf(booking, "ride")?.arrivalIds.includes(arrival.id));
    if (listing) return listing;
  }
  if (!query.at) return null;
  const atMs = toEpochMs(query.at.at);
  for (const booking of rides) {
    const details = detailsOf(booking, "ride");
    // A ride that names the arrivals it meets is not guessed onto any other.
    if (!details?.pickupAt || details.arrivalIds.length > 0) continue;
    const end = query.direction === "arrival" ? details.fromPlace : details.toPlace;
    if (!end || end.kind !== "airport" || (end.iata && query.iata && end.iata !== query.iata)) continue;
    const riders = [...details.passengerIds, ...booking.personIds];
    const theirs = riders.length ? riders.some((id) => query.personIds.includes(id)) : ctx.input.parties.length <= 1;
    if (!theirs) continue;
    const gap = toEpochMs(details.pickupAt.at) - atMs;
    const fits = query.direction === "arrival" ? gap >= -HOUR_MS && gap <= 6 * HOUR_MS : gap <= 0 && gap >= -8 * HOUR_MS;
    if (fits) return booking;
  }
  return null;
}

/** Rows that still need someone to come and get them: the ones a pickup run is for. */
function needsCollecting(row: ArrivalRow): boolean {
  return (
    row.at !== null &&
    row.localDate !== null &&
    row.mode !== "drive" &&
    row.mode !== "local" &&
    row.status.value !== "cancelled" &&
    row.status.value !== "arrived" &&
    row.status.value !== "picked_up" &&
    (row.ride.state === "needs_ride" || row.ride.state === "unknown" || row.ride.state === "driver")
  );
}

function bracketRuns(ctx: Context, rows: ArrivalRow[]): PickupRun[] {
  const runs: PickupRun[] = [];
  const byPlace = new Map<string, ArrivalRow[]>();
  for (const row of rows) {
    if (!needsCollecting(row)) continue;
    const key = `${row.localDate}|${row.place.key}`;
    const list = byPlace.get(key) ?? [];
    list.push(row);
    byPlace.set(key, list);
  }
  for (const list of byPlace.values()) {
    let i = 0;
    while (i < list.length) {
      const members = [list[i]];
      const startMs = toEpochMs(list[i].at!.at);
      let driverId = list[i].ride.driver?.personId ?? null;
      let j = i + 1;
      while (j < list.length && toEpochMs(list[j].at!.at) - startMs <= ctx.runWindowMs) {
        const theirs = list[j].ride.driver?.personId ?? null;
        // Two different drivers are two trips, however close the landings are.
        if (driverId && theirs && theirs !== driverId) break;
        driverId ??= theirs;
        members.push(list[j]);
        j++;
      }
      if (members.length >= 2) runs.push(makeRun(ctx, members, runs.length + 1));
      i += members.length;
    }
  }
  return runs;
}

function makeRun(ctx: Context, members: ArrivalRow[], n: number): PickupRun {
  const first = members[0].at!;
  const last = members[members.length - 1].at!;
  const headCount = members.reduce((sum, row) => sum + row.headCount, 0);
  const bagCounts = members.map((row) => row.bags).filter((bags): bags is number => bags !== null);
  const id = `run:${members[0].localDate}:${members[0].place.key}:${n}`;
  for (const row of members) row.runId = id;
  const both = members.length === 2 ? "both" : `all ${members.length}`;
  return {
    id,
    date: members[0].localDate!,
    place: members[0].place,
    rowKeys: members.map((row) => row.key),
    headCount,
    childCount: members.reduce((sum, row) => sum + row.childCount, 0),
    bags: bagCounts.length ? bagCounts.reduce((a, b) => a + b, 0) : null,
    first,
    last,
    waitMinutes: Math.round((toEpochMs(last.at) - toEpochMs(first.at)) / 60_000),
    driver: members.find((row) => row.ride.driver)?.ride.driver ?? null,
    seatCheck: null,
    sentence:
      `One trip can meet ${both}: ${count(headCount, "person", "people")}, ` +
      `first lands ${clockText(first.at, first.tz, ctx.wording)}, last ${clockText(last.at, last.tz, ctx.wording)}.`,
  };
}

/** Checks each assigned driver's seats against the people they are meeting. */
function attachSeatChecks(ctx: Context, rows: ArrivalRow[], runs: PickupRun[]): void {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  for (const row of rows) {
    const driver = row.ride.driver;
    if (!driver) continue;
    const run = row.runId ? runsById.get(row.runId) : undefined;
    if (run?.seatCheck) {
      row.ride.seatCheck = run.seatCheck;
      continue;
    }
    const rideBooking = row.ride.rideBookingId ? ctx.bookingsById.get(row.ride.rideBookingId) : undefined;
    const seats =
      (rideBooking ? detailsOf(rideBooking, "ride")?.vehicleSeats : undefined) ??
      ctx.peopleById.get(driver.personId)?.vehicleSeats ??
      null;
    const passengers = run ? run.headCount : row.headCount;
    const bags = run ? run.bags : row.bags;
    const load = `${count(passengers, "person", "people")}${bags ? ` and ${count(bags, "bag")}` : ""}`;
    const trip = run ? "run" : "pickup";
    const check: SeatCheck = {
      ok: seats === null ? null : passengers <= seats,
      seats,
      passengers,
      bags,
      sentence:
        seats === null
          ? `No seat count for ${driver.name}'s car yet. This ${trip} is ${load}.`
          : `${driver.name}'s car seats ${count(seats, "passenger")}. This ${trip} is ${load}.`,
    };
    row.ride.seatCheck = check;
    if (run) run.seatCheck = check;
  }
}

// --- grouping, counting, wording ----------------------------------------------------------------

function compareRows(ctx: Context) {
  return (a: ArrivalRow, b: ArrivalRow): number => {
    if (a.at && b.at) {
      const diff = toEpochMs(a.at.at) - toEpochMs(b.at.at);
      if (diff !== 0) return diff;
    } else if (a.at || b.at) {
      return a.at ? -1 : 1;
    }
    const order = (row: ArrivalRow) => ctx.partiesById.get(row.partyId)?.sortOrder ?? 0;
    return order(a) - order(b) || a.partyName.localeCompare(b.partyName) || a.key.localeCompare(b.key);
  };
}

function findMissing(ctx: Context, covered: Set<string>): MissingTravel[] {
  const missing: MissingTravel[] = [];
  const parties = [...ctx.input.parties].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const party of parties) {
    const members = (ctx.membersByParty.get(party.id) ?? []).filter(isExpected);
    const without = members.filter((person) => !covered.has(person.id));
    if (without.length === 0) continue;
    const names = firstNames(without);
    const from = party.origin?.name ?? null;
    const who = without.length === members.length && without.length > 3 ? party.name : listOf(names);
    missing.push({
      partyId: party.id,
      partyName: party.name,
      personIds: without.map((person) => person.id),
      names,
      from,
      label: from ? `${who} (${from})` : who,
    });
  }
  return missing;
}

function rideCounts(rows: ArrivalRow[]): RideCounts {
  const result: RideCounts = { people: 0, haveRides: 0, needRide: 0, notKnown: 0 };
  for (const row of rows) {
    if (row.mode === "local" || row.status.value === "cancelled") continue;
    result.people += row.headCount;
    if (row.ride.state === "needs_ride") result.needRide += row.headCount;
    else if (row.ride.state === "unknown") result.notKnown += row.headCount;
    else result.haveRides += row.headCount;
  }
  return result;
}

function summaryLine(direction: ArrivalDirection, c: RideCounts, date: LocalDate | null): string {
  const verb = direction === "arrival" ? "arriving" : "leaving";
  const parts = [
    `${c.people} ${verb}${date ? ` ${weekdayName(date)}` : ""}`,
    `${c.haveRides} ${c.haveRides === 1 ? "has a ride" : "have rides"}`,
    `${c.needRide} ${c.needRide === 1 ? "needs a ride" : "need a ride"}`,
  ];
  if (c.notKnown > 0) parts.push(`${c.notKnown} not known yet`);
  return parts.join(DOT);
}

function groupDays(ctx: Context, direction: ArrivalDirection, rows: ArrivalRow[], runs: PickupRun[]): BoardDay[] {
  const byDate = new Map<LocalDate, ArrivalRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.localDate!) ?? [];
    list.push(row);
    byDate.set(row.localDate!, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => compareDates(a, b))
    .map(([date, dayRows]) => {
      const groups: BoardGroup[] = [];
      for (const row of dayRows) {
        let group = groups.find((g) => g.place.key === row.place.key);
        if (!group) {
          group = { place: row.place, rows: [], runs: [] };
          groups.push(group);
        }
        group.rows.push(row);
      }
      for (const group of groups) {
        group.runs = runs.filter((run) => run.date === date && run.place.key === group.place.key);
      }
      const dayCounts = rideCounts(dayRows);
      return {
        date,
        label: dayText(date),
        isToday: date === ctx.today,
        summary: summaryLine(direction, dayCounts, date),
        counts: dayCounts,
        groups,
        hereCount: dayRows.filter((row) => row.here).reduce((sum, row) => sum + row.headCount, 0),
      };
    });
}

/**
 * The board as plain text for a group chat. First names, times, flights and rides only:
 * nothing private.
 */
function textVersion(side: BoardSide): string {
  const lines: string[] = [];
  const verb = side.direction === "arrival" ? "Arriving" : "Leaving";
  for (const day of side.days) {
    for (const group of day.groups) {
      lines.push(`${verb} ${day.label}${placeWords(group.place, side.direction)}`);
      for (const row of group.rows) lines.push(textLine(row));
    }
  }
  const here = side.undated.filter((row) => row.mode === "local");
  const noTime = side.undated.filter((row) => row.mode !== "local");
  if (noTime.length) {
    lines.push("No time yet");
    for (const row of noTime) lines.push(textLine(row));
  }
  if (here.length && side.direction === "arrival") lines.push(`Already here: ${here.map((row) => row.who).join(", ")}`);
  if (side.missingLine) lines.push(side.missingLine);
  return lines.join("\n");
}

/** " at MCO", " from MCO", " by road", " by train"; nothing when the place is not known. */
function placeWords(place: BoardPlace, direction: ArrivalDirection): string {
  if (place.key === "road") return " by road";
  if (place.key === "train") return " by train";
  if (place.key === "bus") return " by bus";
  if (place.key === "unknown" || place.key === "other" || place.key === "here") return "";
  return ` ${direction === "arrival" ? "at" : "from"} ${place.label}`;
}

function textLine(row: ArrivalRow): string {
  const parts: string[] = [row.who];
  const toOrFrom = row.direction === "arrival" ? "from" : "to";
  if (row.flight) parts.push(row.otherEnd ? `${row.flight.designator} ${toOrFrom} ${row.otherEnd}` : row.flight.designator);
  else if (row.mode === "drive") parts.push(row.otherEnd ? `driving ${toOrFrom} ${row.otherEnd}` : "driving");
  else if (row.otherEnd) parts.push(`${toOrFrom} ${row.otherEnd}`);
  if (row.ride.state !== "driving") parts.push(row.ride.inline);
  if (row.status.value === "cancelled") parts.push("canceled");
  const line = parts.join(", ");
  return row.timeText ? `${row.timeText}  ${line}` : line;
}
