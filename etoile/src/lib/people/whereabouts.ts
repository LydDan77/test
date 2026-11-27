// "Where is everybody": the day-of-travel summary. For each household, how far they are from
// the door, worked out from the booked times and the current time, plus one sentence for the
// top of the screen: "4 of 9 are here. Ruth and Dale are next, about 12 minutes away."
//
// The app cannot see a plane or a car. Everything here is arithmetic on times people booked or
// tapped ("I've landed", "Picked up", "Arrived"), and the words say "about".

import type { Person } from "@/db/schema";
import type { ZonedInstant } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { localDateOf, toEpochMs, type InstantInput } from "@/lib/time";
import { resolveArrivals, type ArrivalRow } from "./arrivals";
import { isExpected } from "./shared";
import { clockText, count, dayText, durationWords, firstNames, listOf, upperFirst, type Wording } from "./text";

export type WhereaboutsOptions = {
  wording?: Wording;
  /**
   * Minutes from a flight landing (or a train or bus pulling in) to walking through the door:
   * bags, the pickup and the drive. Default 60. Pass the real drive when you know it.
   */
  landingToDoorMinutes?: number;
  /** Minutes from "Picked up" to the door. Default 30. */
  pickupToDoorMinutes?: number;
};

/**
 *  - "here": marked arrived, or they live there.
 *  - "on_the_way": a time is known and it is still ahead.
 *  - "due": the time has passed and nobody has marked them arrived.
 *  - "no_time": travelling, with no time on record.
 *  - "no_travel": expected, with nothing on record at all.
 */
export type WhereaboutsState = "here" | "on_the_way" | "due" | "no_time" | "no_travel";

export type HouseholdWhereabouts = {
  /** The board row this came from; null for people with nothing on record. */
  rowKey: string | null;
  partyId: string;
  partyName: string;
  personIds: string[];
  /** "Ruth and Dale", or the household's name when it is more than three people. */
  who: string;
  headCount: number;
  state: WhereaboutsState;
  /** When they should be at the door. Null when it cannot be worked out. */
  doorAt: ZonedInstant | null;
  /** Whole minutes until then; 0 when due or here; null when unknown. */
  minutesAway: number | null;
  /** "Here", "About 12 minutes away", "Lands 4:10 PM, here about 5:10 PM", "Should be here by now", "No time yet". */
  line: string;
};

export type Whereabouts = {
  /** Everyone expected. */
  total: number;
  /** People who are at the plan's place. */
  here: number;
  /** One entry per household on the way in (two when a household is split across flights), soonest first. */
  households: HouseholdWhereabouts[];
  /** Whoever is due next and not here yet. */
  next: HouseholdWhereabouts | null;
  /** "4 of 9 are here. Ruth and Dale are next, about 12 minutes away." */
  sentence: string;
};

/**
 * Where everybody is right now, on the way in.
 *
 *   whereIsEverybody(planData, now).sentence
 *   // "4 of 9 are here. Ruth and Dale are next, about 12 minutes away."
 */
export function whereIsEverybody(
  input: Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings">,
  now: InstantInput,
  options: WhereaboutsOptions = {},
): Whereabouts {
  const nowMs = toEpochMs(now);
  const wording = options.wording ?? {};
  const landingToDoor = (options.landingToDoorMinutes ?? 60) * 60_000;
  const pickupToDoor = (options.pickupToDoorMinutes ?? 30) * 60_000;
  const board = resolveArrivals(input, now, { wording });
  const peopleById = new Map(input.people.map((person) => [person.id, person]));

  const households: HouseholdWhereabouts[] = [];
  for (const row of board.arrivals.rows) {
    if (row.status.value === "cancelled") continue;
    households.push(fromRow(row, nowMs, landingToDoor, pickupToDoor, wording, peopleById));
  }
  for (const missing of board.arrivals.missing) {
    households.push({
      rowKey: null,
      partyId: missing.partyId,
      partyName: missing.partyName,
      personIds: missing.personIds,
      who: missing.personIds.length > 3 ? missing.partyName : listOf(missing.names),
      headCount: missing.personIds.length,
      state: "no_travel",
      doorAt: null,
      minutesAway: null,
      line: "No arrival on record",
    });
  }

  const rank: Record<WhereaboutsState, number> = { due: 0, on_the_way: 1, no_time: 2, no_travel: 3, here: 4 };
  households.sort(
    (a, b) => rank[a.state] - rank[b.state] || (a.minutesAway ?? Number.MAX_SAFE_INTEGER) - (b.minutesAway ?? Number.MAX_SAFE_INTEGER),
  );

  const total = input.people.filter(isExpected).length;
  const here = households.filter((h) => h.state === "here").reduce((sum, h) => sum + h.headCount, 0);
  const due = households.find((h) => h.state === "due") ?? null;
  const onTheWay = households.find((h) => h.state === "on_the_way") ?? null;
  const next = due ?? onTheWay;

  return { total, here, households, next, sentence: sentence(total, here, next, households, wording) };
}

function fromRow(
  row: ArrivalRow,
  nowMs: number,
  landingToDoor: number,
  pickupToDoor: number,
  wording: Wording,
  peopleById: Map<string, Person>,
): HouseholdWhereabouts {
  const people = row.personIds.map((id) => peopleById.get(id)).filter((p): p is Person => p !== undefined);
  const base = {
    rowKey: row.key,
    partyId: row.partyId,
    partyName: row.partyName,
    personIds: row.personIds,
    who: people.length === 0 || people.length > 3 ? row.partyName : listOf(firstNames(people)),
    headCount: row.headCount,
  };
  if (row.here) return { ...base, state: "here", doorAt: null, minutesAway: 0, line: "Here" };

  const tz = row.at?.tz ?? row.status.at?.tz ?? null;
  // Timetabled travel ends at an airport or a station; a drive ends at the door.
  const lastLeg = row.mode === "flight" || row.mode === "train" || row.mode === "bus" ? landingToDoor : 0;
  let doorMs: number | null = null;
  if (row.status.value === "picked_up" && row.status.at) doorMs = toEpochMs(row.status.at.at) + pickupToDoor;
  else if (row.status.value === "landed" && row.status.at) doorMs = toEpochMs(row.status.at.at) + lastLeg;
  else if (row.at) doorMs = toEpochMs(row.at.at) + lastLeg;

  if (doorMs === null || tz === null) return { ...base, state: "no_time", doorAt: null, minutesAway: null, line: "No time yet" };

  const doorAt: ZonedInstant = { at: new Date(doorMs).toISOString(), tz };
  const minutes = Math.ceil((doorMs - nowMs) / 60_000);
  if (minutes <= 0) return { ...base, state: "due", doorAt, minutesAway: 0, line: "Should be here by now" };

  const door = clockText(doorAt.at, tz, wording);
  let line: string;
  if (row.status.value === "picked_up") line = `Picked up, ${awayWords(minutes)}`;
  else if (row.status.value === "landed") line = `Landed, ${awayWords(minutes)}`;
  else if (lastLeg > 0 && row.at && toEpochMs(row.at.at) > nowMs) {
    const verb = row.mode === "flight" ? "Lands" : "Gets in";
    line = `${verb} ${clockText(row.at.at, row.at.tz, wording)}, here about ${door}`;
  } else line = upperFirst(awayWords(minutes));
  return { ...base, state: "on_the_way", doorAt, minutesAway: minutes, line };
}

/** "about 12 minutes away", "about 2 hours away", "about 1 hour 30 minutes away". */
function awayWords(minutes: number): string {
  if (minutes <= 1) return "about a minute away";
  // Round to five minutes past the first quarter hour: nobody plans around "37 minutes".
  const rounded = minutes > 15 ? Math.round(minutes / 5) * 5 : minutes;
  return `about ${durationWords(rounded)} away`;
}

function sentence(
  total: number,
  here: number,
  next: HouseholdWhereabouts | null,
  households: HouseholdWhereabouts[],
  wording: Wording,
): string {
  if (total === 0 && households.length === 0) return "Nobody is on the list yet.";
  const allHere = here >= total && total > 0 && households.every((h) => h.state === "here");
  if (allHere) return total === 1 ? "You are here." : `All ${total} are here.`;
  // One traveler: "0 of 1" would be a silly thing to read.
  if (total === 1) {
    if (!next) return "No arrival time yet.";
    if (next.state === "due") return "You should be there by now.";
    const minutes = next.minutesAway ?? 0;
    if (minutes >= 24 * 60 && next.doorAt) {
      return `You arrive on ${dayText(localDateOf(next.doorAt.at, next.doorAt.tz))} at about ${clockText(next.doorAt.at, next.doorAt.tz, wording)}.`;
    }
    return `You are ${awayWords(minutes)}.`;
  }

  const lead = total > 0 ? `${here} of ${total} ${here === 1 ? "is" : "are"} here.` : `${count(here, "person", "people")} here.`;
  if (!next) {
    const unknown = households.filter((h) => h.state === "no_time" || h.state === "no_travel");
    return unknown.length ? `${lead} No arrival time yet for ${listOf(unknown.map((h) => h.who))}.` : lead;
  }
  const be = next.headCount === 1 ? "is" : "are";
  if (next.state === "due") return `${lead} ${next.who} should be here by now.`;
  const minutes = next.minutesAway ?? 0;
  if (minutes >= 24 * 60 && next.doorAt) {
    const date = dayText(localDateOf(next.doorAt.at, next.doorAt.tz));
    return `${lead} ${next.who} ${be} next, on ${date} at about ${clockText(next.doorAt.at, next.doorAt.tz, wording)}.`;
  }
  return `${lead} ${next.who} ${be} next, ${awayWords(minutes)}.`;
}
