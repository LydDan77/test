// suggestNextSteps: after a booking is saved or changed, what the app proposes next, already
// filled in (build spec 3.5). Each suggestion carries a stable `ruleKey`; one that is already a
// task, or that the caller says was seen before, is never suggested again.
//
// Pure: plan data and `now` in, suggestions out.

import type { Booking, BookingOf } from "@/db/schema";
import { clockText } from "@/lib/calendar";
import { flightDesignator, type BookingKind, type PlaceRef } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { addDays, compareDates, localDateOf, utcToZoned } from "@/lib/time";
import { actByFor, type ShipByLookup } from "./act-by";
import { airportRuns, bookingsOf, flightJourneys, isBooked, mainArrival, stayOf, type AirportRun } from "./context";
import { proposalForBooking } from "./links";
import { proposeSearch } from "./propose";
import { RIDE_RESERVATION_WINDOW_DAYS } from "./providers";
import type { BookingContext, Proposal, RideProposal } from "./types";
import { dateAtTimeText, dateText, placeLabel, whenAtText } from "./wording";

/** A task to create for a reminder, ready to insert with `source: "rule"` and the step's ruleKey. */
export type SuggestedTask = {
  title: string;
  /** Local date to do it by. */
  dueDate?: string;
  essential: boolean;
  /** The booking it belongs to (tasks.bookingId). */
  bookingId?: string;
};

export type NextStep = {
  /**
   * Stable for the fact it is about: "ride:arrival:<arrivalId>", "car:pickup:<flight>",
   * "flight:check-in:<bookingId>:<segment>". Store it (tasks.ruleKey, or with a dismissal) and
   * pass the stored keys back as `seenRuleKeys`: the step is then never suggested twice.
   */
  ruleKey: string;
  /** The tool it belongs to. */
  bookingKind: BookingKind;
  /** "book" opens a booking flow with `proposal`; "remind" offers `task`; "check" asks the person to look at a booking. */
  type: "book" | "remind" | "check";
  /** One plain sentence saying what and why. */
  sentence: string;
  /** The words on its button: "Plan the ride", "Remind me". */
  actionLabel: string;
  /** The search to open, already filled in. Present for "book" steps and for ride reminders. */
  proposal?: Proposal;
  /** An existing booking row this step is about (one to fill in, check or reserve). */
  bookingId?: string;
  /** The day to act, for reminders (local date at the plan's place). */
  dueDate?: string;
  /** For "remind" steps: the task to create when the person says yes. */
  task?: SuggestedTask;
};

export type NextStepOptions = {
  /** The signed-in person's home (users.home). Defaults to where the plan sets out from. */
  home?: PlaceRef;
  homeAirportIata?: string | null;
  /** Airport lookups, as in BookingContext. Optional. */
  airport?: BookingContext["airport"];
  nearestAirport?: BookingContext["nearestAirport"];
  /**
   * The send-ahead arithmetic from src/lib/shipping, as one function: given a shipment booking,
   * its ship-by date. Left out, the date stored on the booking is used.
   */
  shipBy?: ShipByLookup;
  /** Rule keys already suggested and acted on or dismissed. Tasks with a ruleKey are added automatically. */
  seenRuleKeys?: Iterable<string>;
};

const inUse = (data: PlanData, kind: BookingKind) => !data.plan.kindsNotNeeded.includes(kind);
/** A kind counts as wanted when the plan lists it, or a booking of it already exists. */
const wanted = (data: PlanData, kind: BookingKind) => inUse(data, kind) && (data.plan.kindsInUse.includes(kind) || data.bookings.some((booking) => booking.kind === kind));

function landingSentence(run: AirportRun, proposal: RideProposal, own: boolean): string {
  const airport = run.airportIata ?? run.airportPlace?.name ?? "the airport";
  const pickup = proposal.query.pickupTime ? clockText(proposal.query.pickupTime) : undefined;
  const household = !own && run.partyName ? run.partyName : undefined;
  if (run.direction === "arrival") {
    // "The Seattle Hartleys land", "Aunt Carol lands".
    const subject = household ? `${household} ${/s$/.test(household) ? "land" : "lands"}` : "You land";
    return `${subject} at ${airport} on ${whenAtText(run.at)}. Plan a ride for ${pickup ?? "then"}.`;
  }
  const subject = household ? `${household} fly home from` : "Your flight home leaves";
  return `${subject} ${airport} on ${whenAtText(run.at)}. Plan a ride to the airport for ${pickup ?? "that day"}.`;
}

function rideSteps(ctx: BookingContext, runs: AirportRun[]): NextStep[] {
  const { data } = ctx;
  if (!inUse(data, "ride") || runs.length === 0) return [];
  const organizer = data.people.find((person) => person.role === "organizer");
  const planned = bookingsOf(data, "ride");
  const steps: NextStep[] = [];
  for (const proposal of proposeSearch("ride", ctx)) {
    if (proposal.status !== "open") continue;
    const run = runs.find((candidate) => proposal.key === `ride:${candidate.direction}:${candidate.key}`);
    if (!run) continue;
    // A ride already planned for this landing has its own reminder (see reserveSteps).
    if (run.arrivalId && planned.some((ride) => ride.details.arrivalIds.includes(run.arrivalId as string))) continue;
    if (run.rideBookingId && planned.some((ride) => ride.id === run.rideBookingId)) continue;
    const own = !organizer || run.personIds.length === 0 || run.personIds.includes(organizer.id);
    steps.push({
      ruleKey: proposal.key,
      bookingKind: "ride",
      type: "book",
      sentence: landingSentence(run, proposal, own),
      actionLabel: "Plan the ride",
      proposal,
    });
  }
  return steps;
}

function carStep(ctx: BookingContext, runs: AirportRun[]): NextStep[] {
  const { data } = ctx;
  const landing = mainArrival(ctx, runs);
  if (!landing || !wanted(data, "car")) return [];
  const cars = bookingsOf(data, "car");
  if (cars.some(isBooked)) return [];
  const [proposal] = proposeSearch("car", ctx);
  const { pickupPlace, pickupDate, pickupTime } = proposal.query;
  if (!pickupPlace || !pickupDate || !pickupTime) return [];
  const where = pickupPlace.iata ?? placeLabel(pickupPlace);
  return [
    {
      ruleKey: `car:pickup:${landing.key}`,
      bookingKind: "car",
      type: "book",
      sentence: `Pick up the car at ${where} on ${dateAtTimeText(pickupDate, pickupTime)}, once you have your bags.`,
      actionLabel: "Find a car",
      proposal,
      bookingId: cars[0]?.id,
    },
  ];
}

function staySteps(ctx: BookingContext, runs: AirportRun[]): NextStep[] {
  const { data } = ctx;
  if (!inUse(data, "lodging")) return [];
  const landing = runs.find((run) => run.direction === "arrival");
  const leaving = [...runs].reverse().find((run) => run.direction === "departure");
  if (!landing && !leaving) return [];
  const stay = stayOf(data);
  const [proposal] = proposeSearch("lodging", ctx);
  const { checkInDate, checkOutDate } = proposal.query;

  if (!stay || !isBooked(stay)) {
    if (!checkInDate) return [];
    const span = checkOutDate ? `from ${dateText(checkInDate)} to ${dateText(checkOutDate)}` : `from ${dateText(checkInDate)}`;
    return [
      {
        ruleKey: `stay:dates:${checkInDate}:${checkOutDate ?? "open"}`,
        bookingKind: "lodging",
        type: "book",
        sentence: `Look for a place to stay ${span}, the same days as your flights.`,
        actionLabel: "Find a place to stay",
        proposal,
        bookingId: stay?.id,
      },
    ];
  }

  // A stay is booked: say so when its dates and the flights disagree.
  const name = stay.details.propertyName ?? stay.title;
  const steps: NextStep[] = [];
  if (landing && checkInDate && stay.details.checkInDate && stay.details.checkInDate !== checkInDate) {
    steps.push({
      ruleKey: `stay:check-in:${stay.id}:${stay.details.checkInDate}:${checkInDate}`,
      bookingKind: "lodging",
      type: "check",
      sentence: `You land on ${dateText(localDateOf(landing.at.at, landing.at.tz))}, but check-in at ${name} is ${dateText(stay.details.checkInDate)}. Check the stay dates.`,
      actionLabel: "Check the stay",
      bookingId: stay.id,
    });
  }
  const leavingDate = leaving ? localDateOf(leaving.at.at, leaving.at.tz) : undefined;
  if (leavingDate && stay.details.checkOutDate && stay.details.checkOutDate !== leavingDate) {
    steps.push({
      ruleKey: `stay:check-out:${stay.id}:${stay.details.checkOutDate}:${leavingDate}`,
      bookingKind: "lodging",
      type: "check",
      sentence: `You fly home on ${dateText(leavingDate)}, but check-out at ${name} is ${dateText(stay.details.checkOutDate)}. Check the stay dates.`,
      actionLabel: "Check the stay",
      bookingId: stay.id,
    });
  }
  return steps;
}

function foodStep(ctx: BookingContext, runs: AirportRun[]): NextStep[] {
  const { data } = ctx;
  if (!wanted(data, "meal")) return [];
  const landing = mainArrival(ctx, runs);
  const stay = stayOf(data);
  // Only once there is something to time it to: a landing, or a stay that is booked.
  if (!landing && !(stay && isBooked(stay))) return [];
  const proposals = proposeSearch("meal", ctx);
  const dinner = proposals.find((proposal) => proposal.query.mealType === "restaurant_delivery") ?? proposals[0];
  const { date, windowStart } = dinner.query;
  if (!date) return [];
  // Any food already planned or ordered for that evening (or the next morning) answers this.
  const tz = dinner.query.deliverToPlace?.tz ?? data.plan.tz;
  const planned = bookingsOf(data, "meal").some((meal) => {
    const start = meal.details.windowStart;
    if (!start) return false;
    const day = localDateOf(start.at, tz);
    return day === date || day === addDays(date, 1) || day === addDays(date, -1);
  });
  if (planned) return [];
  const when = windowStart ? `You should be in by about ${clockText(windowStart)}.` : "";
  return [
    {
      ruleKey: `food:arrival-evening:${date}`,
      bookingKind: "meal",
      type: "book",
      sentence: `Have dinner or groceries waiting on ${dateText(date)}. ${when}`.trim(),
      actionLabel: "Plan food for arrival night",
      proposal: dinner,
    },
  ];
}

function sendAheadSteps(ctx: BookingContext, shipBy: ShipByLookup | undefined, today: string): NextStep[] {
  const { data } = ctx;
  const steps: NextStep[] = [];
  for (const shipment of bookingsOf(data, "shipment")) {
    if (shipment.details.direction !== "outbound") continue;
    const sent = shipment.details.parcels.length > 0 && shipment.details.parcels.every((parcel) => ["shipped", "delivered", "picked_up"].includes(parcel.status));
    if (sent || shipment.status === "done") continue;
    const date = shipBy?.(shipment as Booking & BookingOf<"shipment">, data)?.shipByDate ?? shipment.details.shipByDate;
    if (!date) continue;
    const late = compareDates(today, date) > 0;
    steps.push({
      ruleKey: `send-ahead:ship-by:${shipment.id}:${date}`,
      bookingKind: "shipment",
      type: "remind",
      sentence: late
        ? `${shipment.title}: ${dateText(date)} was the last safe day to ship. Look at faster ways to send it.`
        : `${shipment.title}: ship by ${dateText(date)} so it is waiting when you arrive.`,
      actionLabel: late ? "See faster options" : "Remind me",
      bookingId: shipment.id,
      dueDate: date,
      task: { title: `Ship by ${dateText(date)}: ${shipment.title}`, dueDate: date, essential: true, bookingId: shipment.id },
    });
  }
  return steps;
}

function reserveSteps(ctx: BookingContext, today: string): NextStep[] {
  const { data } = ctx;
  const steps: NextStep[] = [];
  for (const ride of bookingsOf(data, "ride")) {
    if (isBooked(ride) || ride.details.rideType === "personal_pickup" || !ride.details.pickupAt) continue;
    const pickup = ride.details.pickupAt;
    if (Date.parse(pickup.at) <= ctx.now.getTime()) continue;
    const dates = actByFor("ride", data, ride, ctx.now);
    if (!dates.recommended || !dates.opensOn) continue;
    const pickupDay = localDateOf(pickup.at, pickup.tz);
    const notOpen = compareDates(today, dates.opensOn) < 0;
    // Remind on the recommended day; if that is before reservations open, on the day they open.
    const dueDate = compareDates(dates.recommended, dates.opensOn) < 0 ? dates.opensOn : dates.recommended;
    const proposal = proposalForBooking(ride, ctx) ?? undefined;
    steps.push({
      ruleKey: `ride:reserve:${ride.id}:${pickupDay}`,
      bookingKind: "ride",
      type: "remind",
      sentence: notOpen
        ? `Rides can't be reserved more than ${RIDE_RESERVATION_WINDOW_DAYS} days ahead. Reserve the ride for ${whenAtText(pickup)} from ${dateText(dates.opensOn)}.`
        : `Reserve the ride for ${whenAtText(pickup)} by ${dateText(dates.recommended)}. You set the pick-up time in the Uber or Lyft app.`,
      actionLabel: "Remind me",
      proposal,
      bookingId: ride.id,
      dueDate,
      task: { title: `Reserve the ride for ${whenAtText(pickup)}`, dueDate, essential: true, bookingId: ride.id },
    });
  }
  return steps;
}

function checkInSteps(ctx: BookingContext): NextStep[] {
  const steps: NextStep[] = [];
  for (const flight of bookingsOf(ctx.data, "flight")) {
    if (!isBooked(flight)) continue;
    const segments = flight.details.segments;
    for (const journey of flightJourneys(segments)) {
      const first = segments[journey.first];
      const departs = Date.parse(first.departsAt);
      if (departs <= ctx.now.getTime()) continue;
      // Online check-in opens 24 hours before the first flight of a journey and covers its connections.
      const opens = { at: new Date(departs - 24 * 3_600_000).toISOString(), tz: first.originTz };
      const dueDate = utcToZoned(opens.at, opens.tz).date;
      const designator = flightDesignator(first);
      steps.push({
        ruleKey: `flight:check-in:${flight.id}:${journey.first}`,
        bookingKind: "flight",
        type: "remind",
        sentence: `Check in for ${designator} from ${whenAtText(opens)}, 24 hours before it leaves.`,
        actionLabel: "Remind me",
        bookingId: flight.id,
        dueDate,
        task: { title: `Check in for ${designator}`, dueDate, essential: false, bookingId: flight.id },
      });
    }
  }
  return steps;
}

/**
 * What to do next, already filled in. Call it after a booking is saved or changed, and show
 * what comes back as offers the person can take or wave away.
 *
 * In order:
 *   an airport ride timed to each landing, and one to the airport for each flight home
 *   the car pick-up, after baggage claim
 *   a place to stay on the dates the flights give (or a note when a booked stay disagrees with them)
 *   dinner or groceries for arrival evening
 *   the ship-by day for anything being sent ahead
 *   a reminder to reserve each planned ride (they open 90 days ahead and the time is set in the app)
 *   online check-in, the day before each flight
 *
 * Each step has a `ruleKey`. A step whose key is on a task already (tasks.ruleKey), or in
 * `opts.seenRuleKeys`, is left out, so nothing is suggested twice. Kinds the person marked as
 * not needed are skipped.
 *
 *   const steps = suggestNextSteps(planData, now, { home: user.home, shipBy });
 */
export function suggestNextSteps(data: PlanData, now: Date, opts: NextStepOptions = {}): NextStep[] {
  const ctx: BookingContext = {
    data,
    now,
    home: opts.home ?? data.plan.origin,
    homeAirportIata: opts.homeAirportIata,
    airport: opts.airport,
    nearestAirport: opts.nearestAirport,
  };
  const today = localDateOf(now, data.plan.tz);
  const runs = airportRuns(ctx);
  const seen = new Set<string>(opts.seenRuleKeys ?? []);
  for (const task of data.tasks) if (task.ruleKey) seen.add(task.ruleKey);

  const steps = [
    ...rideSteps(ctx, runs),
    ...carStep(ctx, runs),
    ...staySteps(ctx, runs),
    ...foodStep(ctx, runs),
    ...sendAheadSteps(ctx, opts.shipBy, today),
    ...reserveSteps(ctx, today),
    ...checkInSteps(ctx),
  ];
  const unique = new Map<string, NextStep>();
  for (const step of steps) if (!seen.has(step.ruleKey) && !unique.has(step.ruleKey)) unique.set(step.ruleKey, step);
  return [...unique.values()];
}
