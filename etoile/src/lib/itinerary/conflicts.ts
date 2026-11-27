// Gaps and conflicts in a schedule (product spec 5.5 and the conflict rules C1 to C8 of 10.5).
//
// detectConflicts(timeline, planData) reads the timeline and the plan and returns each problem
// as one plain sentence plus what to do about it. Nothing is changed and nothing is hidden:
// the screen decides where to show them (inline on the day, and on "Heads up").
//
// What it looks for
//   no_bed                a night with nowhere to sleep                              (C1)
//   overlap               two things at the same time for the same person            (C2)
//   tight_connection      too little time to change planes                           (C3)
//   car_return            the car is due back after the flight, or too close to it   (C4)
//   early_arrival         three hours or more between arriving and check-in          (C5)
//   seats                 more people than seats in a car or a pickup                (C6)
//   lands_another_day     an overnight flight or a date-line crossing                (C7)
//   clocks_change         the clocks change at the plan's place during the plan      (C8)
//   ride_before_landing   a ride timed before the flight it meets has landed
//   car_before_landing    a car pickup timed before the flight has landed
//   arrives_after_check_in  nobody reaches a stay on the day it starts
//   long_wait_after_check_out  six hours or more between check-out and the flight home

import type { Booking, Person } from "@/db/schema";
import type { ZonedInstant } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { resolveArrivals, type ArrivalRow, type ArrivalsBoard } from "@/lib/people/arrivals";
import { counts, detailsOf, isExpected, isUnderway, stayName } from "@/lib/people/shared";
import { sleepingPlan } from "@/lib/people/sleeping";
import { clockText, count, dayText, durationWords, firstNames, listOf, lowerFirst, type Wording } from "@/lib/people/text";
import {
  addDays,
  compareDates,
  daysUntil,
  formatDate,
  localDateOf,
  offsetMinutes,
  toEpochMs,
  zonedToUtc,
  type InstantInput,
  type LocalDate,
} from "@/lib/time";
import type { TimelineItem } from "./derive";

export type ConflictKind =
  | "no_bed"
  | "overlap"
  | "tight_connection"
  | "car_return"
  | "early_arrival"
  | "seats"
  | "lands_another_day"
  | "clocks_change"
  | "ride_before_landing"
  | "car_before_landing"
  | "arrives_after_check_in"
  | "long_wait_after_check_out";

/** Three levels, worded calmly. "info" is worth knowing; "caution" wants a decision; "alert" is close and serious. */
export type ConflictLevel = "info" | "caution" | "alert";

export type Conflict = {
  /** Stable for the same problem between reads, so a dismissed one can stay dismissed. */
  key: string;
  kind: ConflictKind;
  /** The rule of product spec 10.5 this is, when it is one of them. */
  rule: "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | null;
  level: ConflictLevel;
  /** What is wrong, in one plain sentence. */
  sentence: string;
  /** What to do about it. */
  action: string;
  /** The day to show it on, when it belongs to one. */
  date: LocalDate | null;
  /** Keys of the timeline items involved, to show it inline beside them. */
  itemKeys: string[];
  bookingIds: string[];
  /** Who it affects. Empty means everyone, or nobody in particular. */
  personIds: string[];
};

export type ConflictInput = Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings">;

export type ConflictOptions = {
  /** Lets a missing night become an "alert" inside 14 days. Left out, it stays a "caution". */
  now?: InstantInput;
  wording?: Wording;
  /**
   * The country (ISO code) of an airport. Decides whether a change of planes is international
   * (90 minutes wanted) or domestic (45). Left out, or when it does not know an airport, a
   * connection counts as international when the airports are in different parts of the world
   * by time zone name (America, Europe, Asia …), which treats a US to Canada change as domestic.
   */
  airportCountry?: (iata: string) => string | null | undefined;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LEVEL_RANK: Record<ConflictLevel, number> = { alert: 0, caution: 1, info: 2 };

/**
 * Finds gaps and conflicts.
 *
 *   const timeline = deriveItinerary(planData);
 *   for (const c of detectConflicts(timeline, planData, { now })) {
 *     c.sentence   // "Nowhere to stay on the night of Dec 22."
 *     c.action     // "Add a stay for that night, or check the dates on the one you have."
 *   }
 *
 * Most serious first, then by date.
 */
export function detectConflicts(timeline: readonly TimelineItem[], input: ConflictInput, options: ConflictOptions = {}): Conflict[] {
  const wording = options.wording ?? {};
  const ctx: Ctx = {
    input,
    wording,
    options,
    live: timeline.filter((item) => item.status !== "cancelled"),
    board: resolveArrivals(input, options.now ?? 0, { wording }),
    peopleById: new Map(input.people.map((person) => [person.id, person])),
    everyoneIds: input.people.filter(isExpected).map((person) => person.id),
  };
  const found: Conflict[] = [
    ...noBed(ctx),
    ...connections(ctx),
    ...overlaps(ctx),
    ...carReturn(ctx),
    ...aroundCheckIn(ctx),
    ...seats(ctx),
    ...landsAnotherDay(ctx),
    ...clocksChange(ctx),
    ...pickupsBeforeLanding(ctx),
  ];
  return found.sort(
    (a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.date && b.date ? compareDates(a.date, b.date) : a.date ? -1 : b.date ? 1 : 0),
  );
}

type Ctx = {
  input: ConflictInput;
  wording: Wording;
  options: ConflictOptions;
  live: TimelineItem[];
  board: ArrivalsBoard;
  peopleById: Map<string, Person>;
  everyoneIds: string[];
};

const clock = (ctx: Ctx, at: ZonedInstant) => clockText(at.at, at.tz, ctx.wording);
const ms = (at: ZonedInstant) => toEpochMs(at.at);

/** The people an item involves: its own list, or everyone. */
function peopleOf(ctx: Ctx, item: Pick<TimelineItem, "personIds" | "everyone">): string[] {
  return item.everyone ? ctx.everyoneIds : item.personIds;
}

function shared(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((id) => set.has(id));
}

/** "for Dana and Chris", "for 5 people", or "" when it is everyone. */
function forWhom(ctx: Ctx, ids: readonly string[]): string {
  if (ids.length === 0 || ids.length >= ctx.everyoneIds.length) return "";
  const people = ids.map((id) => ctx.peopleById.get(id)).filter((p): p is Person => p !== undefined);
  return people.length > 3 ? ` for ${count(people.length, "person", "people")}` : ` for ${listOf(firstNames(people))}`;
}

// --- C1: a night with nowhere to sleep ----------------------------------------------------------

function noBed(ctx: Ctx): Conflict[] {
  const plan = sleepingPlan(ctx.input, ctx.options.now ?? 0);
  // Before anything is booked this is a thing to do, not a gap in what was booked.
  if (!plan.anyBooked) return [];
  return plan.gaps.map((gap) => {
    const many = gap.nights.length > 1;
    const who = gap.everyone ? null : gap.names.length > 3 ? count(gap.names.length, "person", "people") : listOf(gap.names);
    const have = gap.personIds.length === 1 ? "has" : "have";
    const soon = ctx.options.now !== undefined && daysUntil(gap.from, ctx.input.plan.tz, ctx.options.now) <= 14;
    return {
      key: `no_bed:${gap.from}:${gap.to}:${[...gap.personIds].sort().join(",")}`,
      kind: "no_bed",
      rule: "C1",
      level: soon ? "alert" : "caution",
      sentence: who ? `${who} ${have} nowhere to stay on ${gap.when}.` : `Nowhere to stay on ${gap.when}.`,
      action: `Add a stay for ${many ? "those nights" : "that night"}, or check the dates on the one you have.`,
      date: gap.from,
      itemKeys: [],
      bookingIds: [],
      personIds: gap.everyone ? [] : gap.personIds,
    } satisfies Conflict;
  });
}

// --- C3: connections ------------------------------------------------------------------------------

function isInternational(ctx: Ctx, a: TimelineItem, b: TimelineItem): boolean {
  const lookup = ctx.options.airportCountry;
  const codes = [a.flight!.originIata, a.flight!.destinationIata, b.flight!.destinationIata];
  const countries = lookup ? codes.map((code) => lookup(code) ?? null) : [null, null, null];
  if (countries.every((country) => country !== null)) return new Set(countries).size > 1;
  const regions = [a.start!.tz, a.end!.tz, b.end!.tz].map((tz) => tz.split("/")[0]);
  return new Set(regions).size > 1;
}

/** Pairs of flights where the second leaves from where the first lands, within a day. */
function connectionPairs(ctx: Ctx): { first: TimelineItem; second: TimelineItem; gapMinutes: number; people: string[] }[] {
  const flights = ctx.live.filter((item) => item.type === "flight" && item.flight && item.start && item.end);
  const pairs: { first: TimelineItem; second: TimelineItem; gapMinutes: number; people: string[] }[] = [];
  for (const first of flights) {
    for (const second of flights) {
      if (first === second) continue;
      if (first.flight!.destinationIata !== second.flight!.originIata) continue;
      if (second.flight!.destinationIata === first.flight!.originIata) continue;
      const gap = ms(second.start!) - ms(first.end!);
      if (gap <= -24 * HOUR || gap >= 24 * HOUR) continue;
      // A negative gap only reads as a connection when the second flight still leaves after the first.
      if (ms(second.start!) <= ms(first.start!)) continue;
      const sameBooking = first.bookingId === second.bookingId;
      const people = sameBooking ? peopleOf(ctx, first) : shared(peopleOf(ctx, first), peopleOf(ctx, second));
      if (!sameBooking && (people.length === 0 || first.everyone || second.everyone)) continue;
      pairs.push({ first, second, gapMinutes: Math.round(gap / MINUTE), people });
    }
  }
  return pairs;
}

function connections(ctx: Ctx): Conflict[] {
  const found: Conflict[] = [];
  for (const { first, second, gapMinutes, people } of connectionPairs(ctx)) {
    const wanted = isInternational(ctx, first, second) ? 90 : 45;
    if (gapMinutes >= wanted) continue;
    const airport = second.flight!.originIata;
    const base = {
      key: `tight_connection:${first.key}:${second.key}`,
      kind: "tight_connection",
      rule: "C3",
      level: "caution",
      date: second.localDate,
      itemKeys: [first.key, second.key],
      bookingIds: bookingIds(first, second),
      personIds: first.everyone ? [] : people,
    } satisfies Partial<Conflict>;
    if (gapMinutes < 0) {
      found.push({
        ...base,
        sentence: `${second.flight!.designator} leaves ${airport} at ${clock(ctx, second.start!)}, before ${first.flight!.designator} lands there at ${clock(ctx, first.end!)}.`,
        action: "Check the times on both flights. One of them may have been typed in wrong.",
      });
    } else {
      found.push({
        ...base,
        sentence: `Only ${durationWords(gapMinutes)} to change planes at ${airport}.`,
        action: `Airlines want at least ${durationWords(wanted)} there. Ask the airline about a later flight out of ${airport}.`,
      });
    }
  }
  return found;
}

// --- C2: overlaps ---------------------------------------------------------------------------------

function overlaps(ctx: Ctx): Conflict[] {
  const candidates = ctx.live.filter(
    (item) => (item.type === "event" || item.type === "session" || item.type === "flight") && item.start && item.end && !item.allDay,
  );
  const connecting = new Set(connectionPairs(ctx).map((pair) => `${pair.first.key}|${pair.second.key}`));
  const found: Conflict[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!(ms(a.start!) < ms(b.end!) && ms(b.start!) < ms(a.end!))) continue;
      // Already reported as a connection that cannot be made.
      if (connecting.has(`${a.key}|${b.key}`) || connecting.has(`${b.key}|${a.key}`)) continue;
      // Parallel sessions on different tracks are how an agenda works.
      if (a.type === "session" && b.type === "session" && a.track && b.track && a.track !== b.track) continue;
      // Two bookings with nobody ticked on either: there is no telling whether anyone is on both.
      if (a.bookingId && b.bookingId && a.everyone && b.everyone) continue;
      const both = shared(peopleOf(ctx, a), peopleOf(ctx, b));
      const everyone = a.everyone && b.everyone;
      if (!everyone && both.length === 0) continue;
      // Lead with the thing a person named: "Welcome dinner and flight AS 772 …".
      const [lead, other] = a.type === "flight" && b.type !== "flight" ? [b, a] : [a, b];
      found.push({
        key: `overlap:${[a.key, b.key].sort().join(":")}`,
        kind: "overlap",
        rule: "C2",
        level: "caution",
        sentence: `${lead.title} and ${nameInSentence(other)} are at the same time${everyone ? "" : forWhom(ctx, both)}.`,
        action: "Move one of them, or change who is going.",
        date: compareDates(a.localDate, b.localDate) > 0 ? a.localDate : b.localDate,
        itemKeys: [a.key, b.key],
        bookingIds: bookingIds(a, b),
        personIds: everyone ? [] : both,
      });
    }
  }
  return found;
}

/** A title in the middle of a sentence: "flight AS 1054, SEA to MCO"; anything a person named stays as written. */
function nameInSentence(item: TimelineItem): string {
  return item.type === "flight" ? lowerFirst(item.title) : item.title;
}

function bookingIds(...items: TimelineItem[]): string[] {
  return [...new Set(items.map((item) => item.bookingId).filter((id): id is string => id !== null))];
}

// --- C4: the car and the flight home --------------------------------------------------------------

function carReturn(ctx: Ctx): Conflict[] {
  const found: Conflict[] = [];
  const flights = ctx.live.filter((item) => item.type === "flight" && item.start && item.flight);
  for (const booking of ctx.input.bookings) {
    const car = detailsOf(booking, "car");
    if (!car || !counts(booking) || !isUnderway(booking) || !car.returnAt) continue;
    const returnAt = car.returnAt;
    const carPeople = [...new Set([...car.driverPersonIds, ...booking.personIds])];
    const where = car.returnPlace ?? car.pickupPlace;
    const after = car.pickupAt ? ms(car.pickupAt) : ms(returnAt) - 24 * HOUR;
    const flight = flights
      .filter((item) => ms(item.start!) > after)
      .filter((item) => (where?.iata ? item.flight!.originIata === where.iata : item.start!.tz === returnAt.tz))
      .filter((item) => carPeople.length === 0 || item.everyone || shared(carPeople, item.personIds).length > 0)
      .sort((a, b) => ms(a.start!) - ms(b.start!))[0];
    if (!flight) continue;
    const gap = ms(flight.start!) - ms(returnAt);
    if (gap >= 2 * HOUR) continue;
    // The plan's own default: the car goes back two and a half hours before the flight.
    const better = clockText(new Date(ms(flight.start!) - 150 * MINUTE), flight.start!.tz, ctx.wording);
    found.push({
      key: `car_return:${booking.id}:${flight.key}`,
      kind: "car_return",
      rule: "C4",
      level: "caution",
      sentence:
        gap < 0
          ? `The car is due back at ${clock(ctx, returnAt)} on ${dayText(localDateOf(returnAt.at, returnAt.tz))}, after ${flight.flight!.designator} leaves at ${clock(ctx, flight.start!)}.`
          : `Only ${durationWords(gap / MINUTE)} between returning the car and ${flight.flight!.designator} leaving at ${clock(ctx, flight.start!)}.`,
      action: `Move the return to ${better} or earlier.`,
      date: flight.localDate,
      itemKeys: [`booking:${booking.id}:car_return`, flight.key],
      bookingIds: bookingIds(flight).concat(booking.id),
      personIds: carPeople,
    });
  }
  return found;
}

// --- C5 and the other check-in and check-out gaps -------------------------------------------------

function aroundCheckIn(ctx: Ctx): Conflict[] {
  const found: Conflict[] = [];
  for (const booking of ctx.input.bookings) {
    const stay = detailsOf(booking, "lodging");
    if (!stay || !counts(booking) || !isUnderway(booking)) continue;
    const name = stayName(booking);
    const tz = stay.place?.tz ?? ctx.input.plan.tz;
    const named = new Set([
      ...booking.personIds,
      ...stay.rooms.flatMap((room) => room.personIds),
      ...ctx.input.people.filter((person) => person.lodgingBookingId === booking.id).map((person) => person.id),
    ]);
    const onStay = (row: ArrivalRow) => named.size === 0 || row.personIds.some((id) => named.has(id));

    if (stay.checkInDate) {
      const checkIn = zonedToUtc(`${stay.checkInDate}T${stay.checkInTime}`, tz);
      const checkInAt: ZonedInstant = { at: checkIn.toISOString(), tz };
      const rows = ctx.board.arrivals.rows.filter((row) => row.at && row.status.value !== "cancelled" && row.mode !== "local" && onStay(row));
      for (const row of rows) {
        if (localDateOf(row.at!.at, tz) !== stay.checkInDate) continue;
        const wait = checkIn.getTime() - ms(row.at!);
        if (wait < 3 * HOUR) continue;
        const arriving = row.mode === "flight" ? "landing" : "arriving";
        found.push({
          key: `early_arrival:${booking.id}:${row.key}`,
          kind: "early_arrival",
          rule: "C5",
          level: "info",
          sentence: `${durationWords(wait / MINUTE)} between ${arriving} at ${clock(ctx, row.at!)} and check-in at ${name} at ${clock(ctx, checkInAt)}${forWhom(ctx, row.personIds)}.`,
          action: "Ask about an early check-in or a place to leave bags.",
          date: stay.checkInDate,
          itemKeys: [`booking:${booking.id}:check_in`],
          bookingIds: [booking.id],
          personIds: row.personIds,
        });
      }
      // Nobody reaches the stay on the day it starts: the property may give the room away.
      const dates = rows.map((row) => localDateOf(row.at!.at, tz)).sort(compareDates);
      if (dates.length > 0 && compareDates(dates[0], stay.checkInDate) > 0 && stay.lodgingType !== "family_home") {
        found.push({
          key: `arrives_after_check_in:${booking.id}`,
          kind: "arrives_after_check_in",
          rule: null,
          level: "caution",
          sentence: `${name} starts on ${dayText(stay.checkInDate)}, but nobody gets there until ${dayText(dates[0])}.`,
          action: "Tell them you are arriving late so the room is held, or move the first night.",
          date: stay.checkInDate,
          itemKeys: [`booking:${booking.id}:check_in`],
          bookingIds: [booking.id],
          personIds: [...named],
        });
      }
    }

    if (stay.checkOutDate) {
      const checkOut = zonedToUtc(`${stay.checkOutDate}T${stay.checkOutTime}`, tz);
      const checkOutAt: ZonedInstant = { at: checkOut.toISOString(), tz };
      for (const row of ctx.board.departures.rows) {
        if (!row.at || row.status.value === "cancelled" || row.mode !== "flight" || !onStay(row)) continue;
        if (localDateOf(row.at.at, tz) !== stay.checkOutDate) continue;
        const wait = ms(row.at) - checkOut.getTime();
        if (wait < 6 * HOUR) continue;
        found.push({
          key: `long_wait_after_check_out:${booking.id}:${row.key}`,
          kind: "long_wait_after_check_out",
          rule: null,
          level: "info",
          sentence: `${durationWords(wait / MINUTE)} between check-out at ${name} at ${clock(ctx, checkOutAt)} and the flight at ${clock(ctx, row.at)}${forWhom(ctx, row.personIds)}.`,
          action: "Ask about a late check-out or a place to leave bags.",
          date: stay.checkOutDate,
          itemKeys: [`booking:${booking.id}:check_out`],
          bookingIds: [booking.id],
          personIds: row.personIds,
        });
      }
    }
  }
  return found;
}

// --- C6: seats ------------------------------------------------------------------------------------

function seats(ctx: Ctx): Conflict[] {
  const found: Conflict[] = [];
  const expected = new Set(ctx.everyoneIds);
  for (const booking of ctx.input.bookings) {
    if (!counts(booking)) continue;
    const car = detailsOf(booking, "car");
    if (car?.seats) {
      const riders = new Set([...booking.personIds, ...car.driverPersonIds].filter((id) => expected.has(id)));
      if (riders.size > car.seats) {
        found.push({
          key: `seats:car:${booking.id}`,
          kind: "seats",
          rule: "C6",
          level: "caution",
          sentence: `The car seats ${car.seats}, and ${count(riders.size, "person", "people")} are on it.`,
          action: "Look for a bigger car, or plan a second way to get around.",
          date: car.pickupAt ? localDateOf(car.pickupAt.at, car.pickupAt.tz) : null,
          itemKeys: [`booking:${booking.id}:car_pickup`],
          bookingIds: [booking.id],
          personIds: [...riders],
        });
      }
    }
    const ride = detailsOf(booking, "ride");
    if (ride?.vehicleSeats) {
      const riders = ride.passengerIds.filter((id) => expected.has(id) && id !== ride.driverPersonId);
      if (riders.length > ride.vehicleSeats) {
        found.push({
          key: `seats:ride:${booking.id}`,
          kind: "seats",
          rule: "C6",
          level: "caution",
          sentence: `The ride has room for ${count(ride.vehicleSeats, "passenger")}, and ${count(riders.length, "person", "people")} are on it.`,
          action: "Plan a second ride, or ask for a bigger car.",
          date: ride.pickupAt ? localDateOf(ride.pickupAt.at, ride.pickupAt.tz) : null,
          itemKeys: [`booking:${booking.id}:ride`],
          bookingIds: [booking.id],
          personIds: riders,
        });
      }
    }
  }
  // A driver from the plan whose car is too small for the people they are meeting.
  const seen = new Set<string>();
  for (const row of [...ctx.board.arrivals.rows, ...ctx.board.departures.rows]) {
    const check = row.ride.seatCheck;
    if (!check || check.ok !== false) continue;
    const id = row.runId ?? row.key;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({
      key: `seats:pickup:${id}`,
      kind: "seats",
      rule: "C6",
      level: "caution",
      sentence: check.sentence,
      action: "Pick a second driver, or plan a ride for some of them.",
      date: row.localDate,
      itemKeys: [],
      bookingIds: row.ride.rideBookingId ? [row.ride.rideBookingId] : [],
      personIds: row.personIds,
    });
  }
  return found;
}

// --- C7: landing on another day -------------------------------------------------------------------

function landsAnotherDay(ctx: Ctx): Conflict[] {
  const found: Conflict[] = [];
  for (const item of ctx.live) {
    if (item.type !== "flight" || !item.flight || !item.end || item.flight.dayShift === 0) continue;
    const landsOn = localDateOf(item.end.at, item.end.tz);
    const shift = item.flight.dayShift;
    const relation =
      shift === 1 ? "the day after you leave" : shift > 1 ? `${shift} days after you leave` : shift === -1 ? "the calendar day before you leave" : `${-shift} calendar days before you leave`;
    found.push({
      key: `lands_another_day:${item.key}`,
      kind: "lands_another_day",
      rule: "C7",
      level: "info",
      sentence: `${item.flight.designator} lands on ${formatDate(landsOn, { weekday: true })}, ${relation}.`,
      action: `Check that your ride and your stay start on ${formatDate(landsOn)}.`,
      date: item.localDate,
      itemKeys: [item.key],
      bookingIds: bookingIds(item),
      personIds: item.everyone ? [] : item.personIds,
    });
  }
  return found;
}

// --- C8: the clocks change --------------------------------------------------------------------------

function clocksChange(ctx: Ctx): Conflict[] {
  const { plan } = ctx.input;
  if (!plan.startDate || !plan.endDate) return [];
  const found: Conflict[] = [];
  const noon = (date: LocalDate) => zonedToUtc(`${date}T12:00`, plan.tz).getTime();
  const place = plan.destination?.name ?? "the plan's place";
  // Bounded so a plan with far-apart dates typed by mistake cannot spin here.
  for (let date = plan.startDate, n = 0; compareDates(date, plan.endDate) < 0 && n < 400; date = addDays(date, 1), n++) {
    const next = addDays(date, 1);
    const before = offsetMinutes(noon(date), plan.tz);
    const after = offsetMinutes(noon(next), plan.tz);
    if (before === after) continue;
    // Find the minute the offset changes, to name the right day.
    let low = noon(date);
    let high = noon(next);
    while (high - low > MINUTE) {
      const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
      if (offsetMinutes(middle, plan.tz) === before) low = middle;
      else high = middle;
    }
    const on = localDateOf(high, plan.tz);
    const by = durationWords(Math.abs(after - before));
    found.push({
      key: `clocks_change:${on}`,
      kind: "clocks_change",
      rule: "C8",
      level: "info",
      sentence: `Clocks in ${place} go ${after > before ? "forward" : "back"} ${by} on ${dayText(on)}.`,
      action: "Times on your schedule already allow for it. Phones change by themselves; other clocks may not.",
      date: on,
      itemKeys: [],
      bookingIds: [],
      personIds: [],
    });
  }
  return found;
}

// --- rides and car pickups set before the plane lands ---------------------------------------------

function pickupsBeforeLanding(ctx: Ctx): Conflict[] {
  const found: Conflict[] = [];
  const landings = ctx.board.arrivals.rows.filter((row) => row.at && row.mode === "flight" && row.status.value !== "cancelled");

  const nearest = (candidates: ArrivalRow[], at: ZonedInstant): ArrivalRow | undefined =>
    candidates
      .filter((row) => Math.abs(ms(row.at!) - ms(at)) <= 6 * HOUR)
      .sort((a, b) => Math.abs(ms(a.at!) - ms(at)) - Math.abs(ms(b.at!) - ms(at)))[0];

  for (const booking of ctx.input.bookings) {
    if (!counts(booking) || !isUnderway(booking)) continue;

    const ride = detailsOf(booking, "ride");
    if (ride?.pickupAt) {
      const linked = landings.filter((row) => (row.arrivalId && ride.arrivalIds.includes(row.arrivalId)) || row.ride.rideBookingId === booking.id);
      const byPlace = landings.filter(
        (row) =>
          ride.fromPlace?.iata !== undefined &&
          row.place.iata === ride.fromPlace.iata &&
          (ride.passengerIds.length === 0 || shared(ride.passengerIds, row.personIds).length > 0),
      );
      const row = linked.length ? linked.sort((a, b) => ms(b.at!) - ms(a.at!))[0] : nearest(byPlace, ride.pickupAt);
      if (row && ms(ride.pickupAt) < ms(row.at!)) {
        const from = ride.fromPlace?.iata ?? ride.fromPlace?.name;
        const later = clockText(new Date(ms(row.at!) + 30 * MINUTE), row.at!.tz, ctx.wording);
        found.push(beforeLanding(ctx, "ride_before_landing", booking, row, `The ride${from ? ` from ${from}` : ""} is set for ${clock(ctx, ride.pickupAt)}`, later, "ride"));
      }
    }

    const car = detailsOf(booking, "car");
    if (car?.pickupAt && car.pickupPlace?.iata) {
      const carPeople = [...new Set([...car.driverPersonIds, ...booking.personIds])];
      const atAirport = landings.filter(
        (row) => row.place.iata === car.pickupPlace!.iata && (carPeople.length === 0 || shared(carPeople, row.personIds).length > 0),
      );
      const row = nearest(atAirport, car.pickupAt);
      if (row && ms(car.pickupAt) < ms(row.at!)) {
        const later = clockText(new Date(ms(row.at!) + 45 * MINUTE), row.at!.tz, ctx.wording);
        found.push(beforeLanding(ctx, "car_before_landing", booking, row, `The car pickup is set for ${clock(ctx, car.pickupAt)}`, later, "car_pickup"));
      }
    }
  }
  return found;
}

function beforeLanding(
  ctx: Ctx,
  kind: "ride_before_landing" | "car_before_landing",
  booking: Booking,
  row: ArrivalRow,
  lead: string,
  later: string,
  part: string,
): Conflict {
  const flight = row.flight?.designator ?? "the flight";
  const changed = row.expected ? "is now due at" : "lands at";
  return {
    key: `${kind}:${booking.id}:${row.key}`,
    kind,
    rule: null,
    level: "caution",
    sentence: `${lead}, but ${flight} ${changed} ${clock(ctx, row.at!)}.`,
    action: `Move it to about ${later}, once they are off the plane with their bags.`,
    date: row.localDate,
    itemKeys: [`booking:${booking.id}:${part}`],
    bookingIds: [booking.id],
    personIds: row.personIds,
  };
}
