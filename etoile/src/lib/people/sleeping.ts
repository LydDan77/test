// Where each person is sleeping each night.
//
// sleepingPlan(planData, now) answers three questions from the stays on record:
//  - per person: which nights they need a bed for, and where they are each night;
//  - per night: who is where, and who has nowhere yet;
//  - overall: person-nights covered out of person-nights needed (the Stay share of "things left").
//
// The rules, in one place
//  - A "night" is named by the date it starts on: the night of Dec 19 runs into the morning of Dec 20.
//  - Who needs a bed: everyone who has not said no. Someone who lives there ("already there")
//    needs none.
//  - Which nights: from the day they arrive to the day they leave, read from their own arrival
//    and departure when those are on record, otherwise the plan's dates. Landing before 5 AM
//    still needs the night before; leaving before 5 AM does not need the night before that.
//  - Which stay covers a person: one they are named on (the booking's people, one of its rooms,
//    or the stay chosen on the person). A stay that names nobody at all covers everyone,
//    except a room block, which is only an offer until someone is put in it.
//  - A stay with no dates recorded is taken to cover the plan's dates.

import type { Booking, Person } from "@/db/schema";
import type { PlanData } from "@/lib/plan-data";
import { addDays, compareDates, diffDays, formatDateRange, utcToZoned, type InstantInput, type LocalDate } from "@/lib/time";
import { resolveArrivals, travelByPerson, type ArrivalRow } from "./arrivals";
import { counts, detailsOf, isExpected, isSettled, isUnderway, statusCredit, stayName } from "./shared";
import { count, dayText, firstNames, listOf } from "./text";

export type SleepingInput = Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings">;

/** "booked": a confirmed stay. "planned": a stay being arranged, not confirmed. "none": nowhere yet. */
export type NightState = "booked" | "planned" | "none";

export type PersonNight = {
  /** The date the night starts on. */
  date: LocalDate;
  state: NightState;
  bookingId: string | null;
  /** "Lakeside house". Null when there is nowhere yet. */
  placeName: string | null;
  room: string | null;
  /** 1 booked, 0.5 still looking, 0.25 planned, 0 nowhere (product spec 11.2). */
  credit: number;
};

export type PersonStay = {
  personId: string;
  name: string;
  partyId: string;
  /**
   * Why the nights are what they are: "nights" (listed below), "lives_here" (already there, needs
   * no bed), or "no_dates" (the plan has no dates and neither do they).
   */
  need: "nights" | "lives_here" | "no_dates";
  /** One entry per night they need a bed, in order. */
  nights: PersonNight[];
  /** Nights with nowhere to sleep. */
  uncovered: LocalDate[];
  /** True when the stay was entered by the guest about themselves: "Own arrangement". */
  ownArrangement: boolean;
  /**
   * One line for a person's page or a table: "Lakeside house, 8 nights", "Lives nearby",
   * "Lakeside house, 3 nights. Nowhere yet for Dec 22–23.", "Nowhere to stay yet".
   */
  line: string;
};

export type NightRow = {
  date: LocalDate;
  /** "Sat, Dec 19". */
  label: string;
  stays: { bookingId: string; placeName: string; state: NightState; personIds: string[]; names: string[] }[];
  /** People who need a bed this night and have none. */
  nowhere: { personIds: string[]; names: string[] };
};

/** A run of nights on which the same people have nowhere to sleep. */
export type SleepingGap = {
  /** First and last uncovered night. */
  from: LocalDate;
  to: LocalDate;
  nights: LocalDate[];
  personIds: string[];
  names: string[];
  /** True when it is the whole group: nobody who needs a bed at all has one on those nights. */
  everyone: boolean;
  /** "the night of Dec 22", "the nights of Dec 22–23". */
  when: string;
};

export type SleepingPlan = {
  /** Every night anyone needs a bed, in order. */
  nights: LocalDate[];
  people: PersonStay[];
  byNight: NightRow[];
  gaps: SleepingGap[];
  /** Person-nights needed, and how many of them have a confirmed stay. */
  needed: number;
  booked: number;
  /**
   * Covered share with partial credit for stays still being arranged, 0 to 1.
   * Null when nobody needs a bed (a one-day plan, or everyone lives there).
   */
  credit: number | null;
  /** True when at least one stay is confirmed. Gaps only matter once something is booked. */
  anyBooked: boolean;
};

type Stay = {
  booking: Booking;
  name: string;
  from: LocalDate | null;
  to: LocalDate | null;
  named: Set<string>;
  open: boolean;
  rooms: { label: string; personIds: string[] }[];
};

/**
 * Where everyone is sleeping, night by night.
 *
 *   const plan = sleepingPlan(planData, now);
 *   plan.people.find((p) => p.personId === id)?.line   // "Lakeside house, 8 nights"
 *   plan.gaps[0]?.when                                  // "the night of Dec 22"
 *   plan.byNight                                        // who is where on each night
 */
export function sleepingPlan(input: SleepingInput, now: InstantInput): SleepingPlan {
  const { plan } = input;
  const travel = travelByPerson(resolveArrivals(input, now));
  const stays = input.bookings.filter((b) => b.kind === "lodging" && counts(b) && isUnderway(b)).map((b) => readStay(b, input.people));
  const expected = input.people.filter(isExpected);

  const people: PersonStay[] = expected.map((person) => {
    const mine = travel.get(person.id);
    if (mine?.arrival?.mode === "local") {
      return { personId: person.id, name: person.name, partyId: person.partyId, need: "lives_here", nights: [], uncovered: [], ownArrangement: false, line: "Lives nearby" };
    }
    const first = firstNight(mine?.arrival ?? null) ?? plan.startDate;
    const end = morningAfterLastNight(mine?.departure ?? null) ?? plan.endDate;
    if (!first || !end) {
      return { personId: person.id, name: person.name, partyId: person.partyId, need: "no_dates", nights: [], uncovered: [], ownArrangement: false, line: "No dates yet" };
    }
    const nights: PersonNight[] = [];
    for (let date = first; compareDates(date, end) < 0; date = addDays(date, 1)) {
      nights.push(nightFor(person, date, stays));
    }
    const uncovered = nights.filter((night) => night.state === "none").map((night) => night.date);
    const ownArrangement = nights.some((night) => night.bookingId !== null && stays.find((s) => s.booking.id === night.bookingId)?.booking.guestProvided === true);
    return { personId: person.id, name: person.name, partyId: person.partyId, need: "nights", nights, uncovered, ownArrangement, line: stayLine(nights) };
  });

  const allNights = [...new Set(people.flatMap((p) => p.nights.map((night) => night.date)))].sort(compareDates);
  const nameOf = new Map(expected.map((person) => [person.id, person]));
  const namesFor = (ids: string[]) => firstNames(ids.map((id) => nameOf.get(id)).filter((p): p is Person => p !== undefined));

  const byNight: NightRow[] = allNights.map((date) => {
    const staysTonight = new Map<string, NightRow["stays"][number]>();
    const nowhere: string[] = [];
    for (const person of people) {
      const night = person.nights.find((n) => n.date === date);
      if (!night) continue;
      if (night.bookingId === null) {
        nowhere.push(person.personId);
        continue;
      }
      const entry = staysTonight.get(night.bookingId) ?? { bookingId: night.bookingId, placeName: night.placeName ?? "", state: night.state, personIds: [], names: [] };
      entry.personIds.push(person.personId);
      staysTonight.set(night.bookingId, entry);
    }
    const rows = [...staysTonight.values()].map((entry) => ({ ...entry, names: namesFor(entry.personIds) }));
    return { date, label: dayText(date), stays: rows, nowhere: { personIds: nowhere, names: namesFor(nowhere) } };
  });

  const needed = people.reduce((sum, p) => sum + p.nights.length, 0);
  const booked = people.reduce((sum, p) => sum + p.nights.filter((night) => night.state === "booked").length, 0);
  const creditSum = people.reduce((sum, p) => sum + p.nights.reduce((s, night) => s + night.credit, 0), 0);

  return {
    nights: allNights,
    people,
    byNight,
    gaps: findGaps(byNight, namesFor, people.filter((p) => p.nights.length > 0).length),
    needed,
    booked,
    credit: needed === 0 ? null : creditSum / needed,
    anyBooked: stays.some((stay) => isSettled(stay.booking)),
  };
}

function readStay(booking: Booking, people: readonly Person[]): Stay {
  const details = detailsOf(booking, "lodging");
  const rooms = (details?.rooms ?? []).map((room) => ({ label: room.label, personIds: room.personIds }));
  const named = new Set<string>([
    ...booking.personIds,
    ...rooms.flatMap((room) => room.personIds),
    ...people.filter((person) => person.lodgingBookingId === booking.id).map((person) => person.id),
  ]);
  return {
    booking,
    name: stayName(booking),
    from: details?.checkInDate ?? null,
    to: details?.checkOutDate ?? null,
    named,
    // A stay that names nobody is for everyone; a room block is only an offer until someone is in it.
    open: named.size === 0 && details?.lodgingType !== "room_block",
    rooms,
  };
}

function nightFor(person: Person, date: LocalDate, stays: Stay[]): PersonNight {
  let best: { stay: Stay; credit: number } | null = null;
  for (const stay of stays) {
    if (!(stay.open || stay.named.has(person.id))) continue;
    if (stay.from && compareDates(date, stay.from) < 0) continue;
    if (stay.to && compareDates(date, stay.to) >= 0) continue;
    const credit = statusCredit(stay.booking.status) ?? 0;
    const preferred = person.lodgingBookingId === stay.booking.id;
    if (!best || credit > best.credit || (credit === best.credit && preferred)) best = { stay, credit };
  }
  if (!best) return { date, state: "none", bookingId: null, placeName: null, room: null, credit: 0 };
  const room =
    best.stay.rooms.find((r) => r.personIds.includes(person.id))?.label ??
    (person.lodgingBookingId === best.stay.booking.id || person.lodgingBookingId === null ? person.room : null);
  return {
    date,
    state: isSettled(best.stay.booking) ? "booked" : "planned",
    bookingId: best.stay.booking.id,
    placeName: best.stay.name,
    room: room ?? null,
    credit: best.credit,
  };
}

/** The first night a person needs: the day they arrive, or the night before when they land before 5 AM. */
function firstNight(arrival: ArrivalRow | null): LocalDate | null {
  if (!arrival?.at) return null;
  const local = utcToZoned(arrival.at.at, arrival.at.tz);
  return local.hour < 5 ? addDays(local.date, -1) : local.date;
}

/** The morning after the last night a person needs: the day they leave (a day earlier when they leave before 5 AM). */
function morningAfterLastNight(departure: ArrivalRow | null): LocalDate | null {
  if (!departure?.at) return null;
  const local = utcToZoned(departure.at.at, departure.at.tz);
  return local.hour < 5 ? addDays(local.date, -1) : local.date;
}

function stayLine(nights: PersonNight[]): string {
  if (nights.length === 0) return "No nights needed";
  const places: { name: string; n: number }[] = [];
  for (const night of nights) {
    if (!night.placeName) continue;
    const entry = places.find((p) => p.name === night.placeName);
    if (entry) entry.n += 1;
    else places.push({ name: night.placeName, n: 1 });
  }
  const uncovered = nights.filter((night) => night.state === "none").map((night) => night.date);
  if (places.length === 0) return "Nowhere to stay yet";
  const where = places.map((p) => `${p.name}, ${count(p.n, "night")}`).join("; ");
  if (uncovered.length === 0) return where;
  return `${where}. Nowhere yet for ${dateRuns(uncovered).join(", ")}.`;
}

/** Consecutive dates as ranges: ["Dec 22–23", "Dec 26"]. */
function dateRuns(dates: LocalDate[]): string[] {
  const runs: string[] = [];
  let start = dates[0];
  let previous = dates[0];
  for (const date of dates.slice(1)) {
    if (diffDays(previous, date) !== 1) {
      runs.push(formatDateRange(start, previous));
      start = date;
    }
    previous = date;
  }
  if (start !== undefined) runs.push(formatDateRange(start, previous));
  return runs;
}

function findGaps(byNight: NightRow[], namesFor: (ids: string[]) => string[], sleepers: number): SleepingGap[] {
  type OpenGap = { key: string; everyone: boolean; nights: LocalDate[]; personIds: string[] };
  const found: OpenGap[] = [];
  let open: OpenGap | null = null;
  for (const night of byNight) {
    const key = [...night.nowhere.personIds].sort().join("|");
    // "Everyone" means the whole group has no bed, not just the one person staying an extra night.
    const everyone = night.stays.length === 0 && night.nowhere.personIds.length === sleepers;
    const last = open ? open.nights[open.nights.length - 1] : null;
    if (open && last && key === open.key && everyone === open.everyone && diffDays(last, night.date) === 1) {
      open.nights.push(night.date);
      continue;
    }
    open = key ? { key, everyone, nights: [night.date], personIds: night.nowhere.personIds } : null;
    if (open) found.push(open);
  }
  return found.map((gap) => {
    const from = gap.nights[0];
    const to = gap.nights[gap.nights.length - 1];
    return {
      from,
      to,
      nights: gap.nights,
      personIds: gap.personIds,
      names: namesFor(gap.personIds),
      everyone: gap.everyone,
      when: gap.nights.length === 1 ? `the night of ${formatDateRange(from)}` : `the nights of ${formatDateRange(from, to)}`,
    };
  });
}

/** "Dana and Chris" or "anyone": who a gap is about, for a sentence. */
export function gapPeople(gap: SleepingGap): string {
  return gap.everyone ? "anyone" : listOf(gap.names);
}
