// The travel-day view: for one person or household on one day, the steps in order, starting
// with when to leave home. The leave-by time is worked backward from the flight, and the
// arithmetic comes back as plain steps so the screen can show it:
//
//   "Leave by about 3:40 AM: 6:10 AM flight, 2 hours at the airport, 25 minutes' drive."
//
// Leave-by = departure − airport time − (drive × road factor) − a few spare minutes, rounded
// down to five minutes (product spec 10.5). The drive time and the airport time are inputs:
// the person types the drive ("25 min to SEA"), and the caller picks the airport time (two hours
// for a domestic flight, three for an international one, more on a heavy flying day).

import type { ZonedInstant } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { resolveArrivals } from "@/lib/people/arrivals";
import { isExpected } from "@/lib/people/shared";
import { clockText, dayText, durationWords, firstNames, listOf, type Wording } from "@/lib/people/text";
import { compareDates, localDateOf, toEpochMs, type LocalDate } from "@/lib/time";
import { deriveItinerary, timelineForPeople, type DeriveOptions, type TimelineItem } from "./derive";

export type LeaveByInputs = {
  /** Minutes to drive to the airport, as the person entered them. */
  driveMinutes: number;
  /**
   * Minutes to be at the airport before the flight leaves. Default 120.
   * Use 180 for an international flight; add 30 on a heavy flying day and 60 on a severe one.
   */
  airportLeadMinutes?: number;
  /**
   * Stretches the drive on a busy road day: 1 normally; 1.25, 1.7 or 2.3 when the drive falls in
   * the hours to avoid on a moderate, heavy or severe holiday road day. Default 1.
   */
  roadFactor?: number;
  /** Minutes to spare. Default 5. */
  cushionMinutes?: number;
};

/** One line of the leave-by arithmetic, working backward from the flight. */
export type LeaveByStep = {
  /** "AS 1054 leaves", "2 hours at the airport", "25 minutes' drive", "5 minutes to spare". */
  label: string;
  /** Minutes this step takes off. Null for the first line, which is the flight itself. */
  minutes: number | null;
  /** The clock after this step is taken off. */
  at: ZonedInstant;
  /** "6:10 AM", "4:10 AM", "3:45 AM", "3:40 AM". */
  timeText: string;
};

export type LeaveBy = {
  /** When to leave, in the time of the place they leave from. Rounded down to five minutes. */
  at: ZonedInstant;
  /** "3:40 AM". */
  timeText: string;
  /** "Leave home by" on the way out; "Leave for the airport by" on the way back. */
  label: string;
  /** The arithmetic, top to bottom: the flight, the airport time, the drive, the spare minutes. */
  steps: LeaveByStep[];
  /** "Leave by about 3:40 AM: 6:10 AM flight, 2 hours at the airport, 25 minutes' drive." */
  sentence: string;
};

/**
 * When to leave for a flight, with its arithmetic.
 *
 *   leaveBy({ at: "2026-12-19T14:10:00Z", tz: "America/Los_Angeles" }, { driveMinutes: 25 }).sentence
 *   // "Leave by about 3:40 AM: 6:10 AM flight, 2 hours at the airport, 25 minutes' drive."
 *
 * `departs` is the flight's departure in the origin airport's zone; the result is in that zone.
 */
export function leaveBy(
  departs: ZonedInstant,
  inputs: LeaveByInputs,
  options: { wording?: Wording; flightLabel?: string; fromHome?: boolean } = {},
): LeaveBy {
  const wording = options.wording ?? {};
  const tz = departs.tz;
  const lead = Math.max(0, Math.round(inputs.airportLeadMinutes ?? 120));
  const factor = inputs.roadFactor && inputs.roadFactor > 0 ? inputs.roadFactor : 1;
  const plainDrive = Math.max(0, Math.round(inputs.driveMinutes));
  const drive = Math.ceil(plainDrive * factor);
  const cushion = Math.max(0, Math.round(inputs.cushionMinutes ?? 5));

  const step = (label: string, minutes: number | null, ms: number): LeaveByStep => {
    const at = { at: new Date(ms).toISOString(), tz };
    return { label, minutes, at, timeText: clockText(at.at, tz, wording) };
  };
  const flightMs = toEpochMs(departs.at);
  const atAirport = flightMs - lead * 60_000;
  const onTheRoad = atAirport - drive * 60_000;
  const exact = onTheRoad - cushion * 60_000;
  // Round down to five minutes: "about", and never later than the arithmetic says.
  const rounded = Math.floor(exact / 300_000) * 300_000;

  const driveLabel =
    drive === plainDrive ? `${possessive(durationWords(drive))} drive` : `${possessive(durationWords(drive))} drive (${durationWords(plainDrive)} on a normal day)`;
  const steps: LeaveByStep[] = [
    step(options.flightLabel ? `${options.flightLabel} leaves` : "The flight leaves", null, flightMs),
    step(`${durationWords(lead)} at the airport`, lead, atAirport),
    step(driveLabel, drive, onTheRoad),
  ];
  if (cushion > 0) steps.push(step(`${durationWords(cushion)} to spare`, cushion, exact));

  const at = { at: new Date(rounded).toISOString(), tz };
  const timeText = clockText(at.at, tz, wording);
  return {
    at,
    timeText,
    label: options.fromHome === false ? "Leave for the airport by" : "Leave home by",
    steps,
    sentence: `Leave by about ${timeText}: ${clockText(departs.at, tz, wording)} flight, ${durationWords(lead)} at the airport, ${driveLabel}.`,
  };
}

/** "25 minutes'", "1 hour's". */
function possessive(words: string): string {
  return words.endsWith("s") ? `${words}'` : `${words}'s`;
}

// --- the day ----------------------------------------------------------------------------------------

export type TravelDayStep = {
  key: string;
  kind: "leave" | "takeoff" | "landing" | "arrive" | "car_pickup" | "car_return" | "ride" | "check_in" | "check_out" | "meal" | "event";
  /** When, in the time of the place where the step happens. Null for a step with no time. */
  at: ZonedInstant | null;
  /** "3:40 AM". "About 3:00 PM" for someone arriving by road. */
  timeText: string | null;
  /** "Leave home", "AS 1054 leaves SEA", "Land at MCO", "Pick up the minivan at MCO". */
  title: string;
  detail: string | null;
  /** The timeline item behind the step, when there is one. */
  itemKey: string | null;
};

export type TravelDay = {
  date: LocalDate;
  /** "Sat, Dec 19". */
  label: string;
  /** "Ruth and Dale", "The Seattle Hartleys", "Everyone". */
  who: string;
  personIds: string[];
  /** In order. Empty when nothing involves these people that day. */
  steps: TravelDayStep[];
  /** The leave-by behind the first step, when the day starts with a flight and drive time was given. */
  leaveBy: LeaveBy | null;
};

/** Whose day: one person, one household, or a list of people. */
export type TravelDayWho = { personId: string } | { partyId: string } | { personIds: readonly string[] };

export type TravelDayOptions = DeriveOptions & { wording?: Wording };

/**
 * The ordered steps of one day for one person or household.
 *
 *   const day = travelDay(planData, { partyId }, "2026-12-19", { driveMinutes: 25 });
 *   day.steps[0]        // { kind: "leave", timeText: "3:40 AM", title: "Leave home", … }
 *   day.leaveBy?.steps  // the arithmetic, line by line
 *
 * Leave out `leaveInputs` when the drive time is not known: the steps still come back, without
 * the leave-by. Steps are in order of when they happen; a flight is two steps (leaving and
 * landing), each on its own local day, so a red-eye's landing shows on the next day's view.
 */
export function travelDay(
  input: Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings" | "items">,
  who: TravelDayWho,
  date: LocalDate,
  leaveInputs?: LeaveByInputs,
  options: TravelDayOptions = {},
): TravelDay {
  const wording = options.wording ?? {};
  const people =
    "personId" in who
      ? input.people.filter((person) => person.id === who.personId)
      : "partyId" in who
        ? input.people.filter((person) => person.partyId === who.partyId && isExpected(person))
        : input.people.filter((person) => who.personIds.includes(person.id));
  const ids = people.map((person) => person.id);
  const party = "partyId" in who ? input.parties.find((p) => p.id === who.partyId) : undefined;
  const whoText = party && people.length > 3 ? party.name : people.length ? listOf(firstNames(people)) : (party?.name ?? "Everyone");

  const timeline = deriveItinerary(input, options);
  const mine = (ids.length ? timelineForPeople(timeline, ids) : timeline).filter((item) => item.status !== "cancelled");
  const steps: TravelDayStep[] = [];
  const when = new Map<string, number | null>();
  const add = (step: TravelDayStep, ms: number | null) => {
    steps.push(step);
    when.set(step.key, ms);
  };
  let leave: LeaveBy | null = null;

  for (const item of mine) {
    if (item.type === "note" || item.type === "shipment_due") continue;
    if (item.type === "flight" && item.flight && item.start && item.end) {
      const landsOn = localDateOf(item.end.at, item.end.tz);
      if (item.localDate === date) {
        add(
          {
            key: `${item.key}:takeoff`,
            kind: "takeoff",
            at: item.start,
            timeText: clockText(item.start.at, item.start.tz, wording),
            title: `${item.flight.designator} leaves ${item.flight.originIata}`,
            detail: landsOn === date ? null : `Lands ${dayText(landsOn)} at ${clockText(item.end.at, item.end.tz, wording)}.`,
            itemKey: item.key,
          },
          toEpochMs(item.start.at),
        );
        // The day's first flight that is not a change of planes is the one to leave for.
        if (leaveInputs && !leave && !isConnectingFlight(item, mine)) {
          leave = leaveBy(item.start, leaveInputs, {
            wording,
            flightLabel: item.flight.designator,
            fromHome: startsFromHome(item, mine, input.plan.startDate),
          });
          add(
            {
              key: `${item.key}:leave`,
              kind: "leave",
              at: leave.at,
              timeText: leave.timeText,
              title: leave.label === "Leave home by" ? "Leave home" : "Leave for the airport",
              detail: leave.sentence,
              itemKey: item.key,
            },
            toEpochMs(leave.at.at),
          );
        }
      }
      if (landsOn === date) {
        const landing = item.flight.expectedArrival ?? item.end;
        add(
          {
            key: `${item.key}:landing`,
            kind: "landing",
            at: landing,
            timeText: clockText(landing.at, landing.tz, wording),
            title: `Land at ${item.flight.destinationIata}`,
            detail: item.flight.expectedArrival ? `Was ${clockText(item.end.at, item.end.tz, wording)}.` : null,
            itemKey: item.key,
          },
          toEpochMs(landing.at),
        );
      }
      continue;
    }
    if (item.localDate !== date) continue;
    const time = item.start ? clockText(item.start.at, item.start.tz, wording) : null;
    add(
      {
        key: item.key,
        kind: item.type === "session" ? "event" : (item.type as TravelDayStep["kind"]),
        at: item.start,
        // Check-in opens at a time and check-out closes at one: say so.
        timeText: item.allDay ? "All day" : time && item.type === "check_in" ? `From ${time}` : time && item.type === "check_out" ? `By ${time}` : time,
        title: item.title,
        detail: item.detail,
        itemKey: item.key,
      },
      item.start ? toEpochMs(item.start.at) : null,
    );
  }

  // People coming by road, rail or bus: their arrival is a step too.
  const board = resolveArrivals(input, 0, { wording });
  for (const row of board.arrivals.rows) {
    if (row.mode === "flight" || row.mode === "local" || row.status.value === "cancelled") continue;
    if (!row.at || row.localDate !== date) continue;
    if (ids.length && !row.personIds.some((id) => ids.includes(id))) continue;
    const how = row.mode === "drive" ? "by road" : row.mode === "train" ? "by train" : row.mode === "bus" ? "by bus" : "";
    add(
      {
        key: `${row.key}:arrive`,
        kind: "arrive",
        at: row.at,
        timeText: row.timeText,
        title: `Arrive ${how}`.trim(),
        detail: row.otherEnd ? `From ${row.otherEnd}.` : null,
        itemKey: null,
      },
      toEpochMs(row.at.at),
    );
  }

  // Nobody checks in before they get there: a check-in that opens earlier goes after the last arrival of the day.
  const arrivals = steps.filter((step) => step.kind === "landing" || step.kind === "arrive").map((step) => when.get(step.key) ?? 0);
  const lastArrival = arrivals.length ? Math.max(...arrivals) : null;
  for (const step of steps) {
    const ms = when.get(step.key);
    if (step.kind === "check_in" && lastArrival !== null && ms !== null && ms !== undefined && ms <= lastArrival) when.set(step.key, lastArrival + 1);
  }
  const msOf = (step: TravelDayStep) => when.get(step.key) ?? null;
  steps.sort((a, b) => {
    const [x, y] = [msOf(a), msOf(b)];
    if (x === null || y === null) return x === y ? a.key.localeCompare(b.key) : x === null ? 1 : -1;
    return x - y || a.key.localeCompare(b.key);
  });
  return {
    date,
    label: dayText(date),
    who: whoText,
    personIds: ids,
    steps,
    leaveBy: leave,
  };
}

/** True when these people land at this flight's airport on another flight less than a day before it. */
function isConnectingFlight(flight: TimelineItem, timeline: readonly TimelineItem[]): boolean {
  return timeline.some(
    (other) =>
      other !== flight &&
      other.type === "flight" &&
      other.flight !== null &&
      other.end !== null &&
      other.flight.destinationIata === flight.flight!.originIata &&
      other.flight.originIata !== flight.flight!.destinationIata &&
      toEpochMs(other.end.at) <= toEpochMs(flight.start!.at) &&
      toEpochMs(flight.start!.at) - toEpochMs(other.end.at) < 24 * 3_600_000,
  );
}

/** A flight starts from home unless these people flew into its airport earlier, or the plan is already under way. */
function startsFromHome(flight: TimelineItem, timeline: readonly TimelineItem[], planStart: LocalDate | null): boolean {
  const flewIn = timeline.some(
    (other) =>
      other !== flight &&
      other.type === "flight" &&
      other.flight !== null &&
      other.end !== null &&
      other.flight.destinationIata === flight.flight!.originIata &&
      toEpochMs(other.end.at) <= toEpochMs(flight.start!.at),
  );
  if (flewIn) return false;
  return !(planStart && compareDates(flight.localDate, planStart) > 0);
}
