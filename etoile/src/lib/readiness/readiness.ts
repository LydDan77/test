// "Things left": how prepared a plan is, what is missing, and what to do next
// (product spec section 11; wording per BUILD-SPEC section 3).
//
//   const r = computeReadiness(planData, templateConfig(plan), now);
//   r.headline            // "3 things left"
//   r.thingsLeft          // plain sentences, each with a button label and where it goes
//   r.nextAction          // the one to put first
//   r.score, r.pace       // for a quiet progress ring; never the headline
//
//   toolStates(planData, templateConfig(plan), now)   // one line for each of the ten tool tiles
//
// How the number is made (product spec 11.2): ten components, each with a weight from the
// template and a credit from 0 to 1. A component that does not apply to this plan is left out
// and the rest are scaled to 100. The score shows 100 only when every counted component is
// complete; otherwise it stops at 99.
//
// Money is not part of it: a plan can be ready and over budget.

import type { Booking, Person } from "@/db/schema";
import type { ActBy, BookingKind, MealDetails, RideDetails, ShipmentDetails } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { moneySummary } from "@/lib/money/totals";
import { isOnRecord, resolveArrivals, travelByPerson, type ArrivalRow, type ArrivalsBoard } from "@/lib/people/arrivals";
import { counts, detailsOf, flightPassengerIds, hasReplied, isExpected, isSettled, statusCredit, stayName } from "@/lib/people/shared";
import { sleepingPlan } from "@/lib/people/sleeping";
import { DEFAULT_PEOPLE_WORDS, type PeopleWords } from "@/lib/people/summary";
import { asSentence, clockText, count, dayText, firstNames, listOf, upperFirst, type Wording } from "@/lib/people/text";
import { addDays, compareDates, diffDays, formatDate, localDateOf, type InstantInput, type LocalDate } from "@/lib/time";
import {
  READINESS_COMPONENTS,
  TOOLS,
  type BreakdownRow,
  type Pace,
  type Readiness,
  type ReadinessComponent,
  type ReadinessConfig,
  type ThingLeft,
  type ThingTarget,
  type ToolKey,
  type ToolState,
  type ToolTone,
  type Urgency,
} from "./types";

export type ReadinessOptions = { wording?: Wording };

// --- deadlines ------------------------------------------------------------------------------------

type Deadline = { recommended?: LocalDate; hard?: LocalDate };
type Pressure = { urgency: Urgency; level: "none" | "soon" | "past_recommended" | "past_hard"; dueBy: LocalDate | null };

/** Product spec 11.4: 3 at or past "hard by", 2 past "recommended by", 1.5 within 7 days of it, otherwise 1. */
function pressureOf(deadline: Deadline | null, today: LocalDate): Pressure {
  if (!deadline) return { urgency: 1, level: "none", dueBy: null };
  const { recommended, hard } = deadline;
  if (hard && compareDates(today, hard) >= 0) return { urgency: 3, level: "past_hard", dueBy: hard };
  if (recommended && compareDates(today, recommended) > 0) return { urgency: 2, level: "past_recommended", dueBy: hard ?? recommended };
  const next = recommended ?? hard ?? null;
  if (next && diffDays(today, next) <= 7) return { urgency: 1.5, level: "soon", dueBy: next };
  return { urgency: 1, level: "none", dueBy: next };
}

function deadlineOf(...sources: (ActBy | Deadline | null | undefined)[]): Deadline | null {
  const merged: Deadline = {};
  for (const source of sources) {
    merged.recommended ??= source?.recommended;
    merged.hard ??= source?.hard;
  }
  return merged.recommended || merged.hard ? merged : null;
}

/** "Book by Dec 5.", "Book today.", "This was due Dec 5." Null when there is no date. */
function byWords(verb: string, deadline: Deadline | null, today: LocalDate): string | null {
  const p = pressureOf(deadline, today);
  if (!p.dueBy) return null;
  if (p.level === "past_hard") return p.dueBy === today ? `${verb} today.` : `This was due ${formatDate(p.dueBy)}.`;
  if (p.level === "past_recommended" && !deadline?.hard) return `Best done by ${formatDate(p.dueBy)}, which has passed.`;
  return `${verb} by ${formatDate(p.dueBy)}.`;
}

const join = (...parts: (string | null | undefined | false)[]): string | null => {
  const text = parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
  return text.length ? text : null;
};

// --- the working shapes ---------------------------------------------------------------------------

type Draft = {
  key: string;
  kind: ThingLeft["kind"];
  sentence: string;
  detail: string | null;
  actionLabel: string;
  target: Omit<ThingTarget, "href">;
  deadline: Deadline | null;
  /** Shown as the date that matters when it differs from what the deadline says (a to-do's own due date). */
  dueBy?: LocalDate | null;
  waiting: boolean;
  /** Its share of the component's missing points, relative to the component's other things. */
  weight: number;
  /** False for dates that order the list without making the plan "needs attention" (publishing the page). */
  affectsPace: boolean;
};

type Tile = { state: string; note: string | null; tone: ToolTone };

type Evaluation = {
  component: ReadinessComponent;
  applies: boolean;
  credit: number;
  state: string;
  things: Draft[];
  tile: Tile;
};

type Ctx = {
  input: PlanData;
  config: ReadinessConfig;
  today: LocalDate;
  wording: Wording;
  words: PeopleWords & { timeline: string };
  board: ArrivalsBoard;
  expected: Person[];
  peopleById: Map<string, Person>;
};

const KIND_OF: Partial<Record<ReadinessComponent, BookingKind>> = {
  gettingThere: "flight",
  lodging: "lodging",
  car: "car",
  rides: "ride",
  meals: "meal",
  shipAhead: "shipment",
};

const LABELS: Record<ReadinessComponent, string> = {
  gettingThere: "Getting there",
  lodging: "Stay",
  car: "Car",
  rides: "Rides",
  meals: "Food",
  shipAhead: "Send ahead",
  people: "Who's coming",
  schedule: "Schedule",
  site: "Share page",
  tasks: "To-dos",
};

const TOOL_OF: Record<ReadinessComponent, ToolKey | "hub"> = {
  gettingThere: "flights",
  lodging: "stay",
  car: "car",
  rides: "rides",
  meals: "food",
  shipAhead: "send-ahead",
  people: "people",
  schedule: "schedule",
  site: "page",
  tasks: "hub",
};

function bookingsOf(ctx: Ctx, kind: BookingKind): Booking[] {
  return ctx.input.bookings.filter((booking) => booking.kind === kind && counts(booking));
}

/** A kind counts when the plan uses it or something of that kind exists, unless the person said it is not needed. */
function kindApplies(ctx: Ctx, kind: BookingKind): boolean {
  const { plan } = ctx.input;
  if (plan.kindsNotNeeded.includes(kind)) return false;
  const all = ctx.input.bookings.filter((booking) => booking.kind === kind);
  if (all.some(counts)) return true;
  // Every booking of the kind was marked "not needed": the person has said so.
  if (all.some((booking) => booking.status === "not_needed")) return false;
  return plan.kindsInUse.includes(kind);
}

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function names(ctx: Ctx, ids: readonly string[], limit = 3): string | null {
  const people = ids.map((id) => ctx.peopleById.get(id)).filter((p): p is Person => p !== undefined);
  if (people.length === 0) return null;
  return people.length > limit ? count(people.length, ctx.words.person, ctx.words.people) : listOf(firstNames(people));
}

const off = (ctx: Ctx, kind: BookingKind): Tile => ({
  state: ctx.input.plan.kindsNotNeeded.includes(kind) ? "Not needed" : "Not planned",
  note: null,
  tone: "off",
});

function statusTile(bookings: Booking[], bookedWords: string): Tile {
  if (bookings.length === 0) return { state: "Needs you", note: null, tone: "needs_you" };
  if (bookings.every(isSettled)) return { state: bookedWords, note: null, tone: "done" };
  if (bookings.some((b) => b.status === "looking")) return { state: "Still looking", note: null, tone: "needs_you" };
  if (bookings.some((b) => b.status === "planned")) return { state: "Planned", note: null, tone: "underway" };
  return { state: "Needs you", note: null, tone: "needs_you" };
}

// --- getting there --------------------------------------------------------------------------------

function gettingThere(ctx: Ctx): Evaluation {
  const component = "gettingThere" as const;
  const { input, today } = ctx;
  const holiday = ctx.config.holidayPeriod ? "Holiday flights fill early." : null;
  const flights = bookingsOf(ctx, "flight");
  const open = flights.filter((booking) => !isSettled(booking));
  const applies = !input.plan.kindsNotNeeded.includes("flight") && (kindApplies(ctx, "flight") || input.arrivals.length > 0);
  const things: Draft[] = [];
  const fallback = ctx.config.actBy?.flight;

  for (const booking of open) {
    const deadline = deadlineOf(booking.actBy, fallback);
    const who = open.length > 1 ? names(ctx, booking.personIds) : null;
    const forWho = who ? ` for ${who}` : "";
    const looking = booking.status === "looking";
    const by = byWords("Book", deadline, today);
    things.push({
      key: `flights:${booking.id}`,
      kind: "flights",
      sentence: looking ? `Did you book the flights${forWho}?` : `Book the flights${forWho}.`,
      detail: join(looking && (booking.provider ? `You were looking on ${upperFirst(booking.provider)}.` : "You went looking and have not said how it went."), by, by && holiday),
      actionLabel: looking ? "Record the booking" : "Find flights",
      target: { tool: "flights", bookingId: booking.id },
      deadline,
      waiting: false,
      weight: Math.max(1, booking.personIds.length) * (1 - (statusCredit(booking.status) ?? 0)),
      affectsPace: true,
    });
  }

  const n = ctx.expected.length;
  if (n === 0) {
    const credit = average(flights.map((booking) => statusCredit(booking.status) ?? 0));
    if (flights.length === 0) {
      const deadline = deadlineOf(fallback);
      const by = byWords("Book", deadline, today);
      things.push({
        key: "flights:none",
        kind: "flights",
        sentence: "Add your flights.",
        detail: join("Search with your dates filled in, or record what you already booked.", by, by && holiday),
        actionLabel: "Add flights",
        target: { tool: "flights" },
        deadline,
        waiting: false,
        weight: 1,
        affectsPace: true,
      });
    }
    return { component, applies, credit, state: flights.length ? (credit === 1 ? "Booked" : "Not booked yet") : "No flights yet", things, tile: statusTile(flights, "Booked") };
  }

  const travel = travelByPerson(ctx.board);
  /** Credit from a flight that is being arranged but not recorded yet: it has no segments, so it counts for both ways. */
  const arranging = (personId: string): number =>
    Math.max(0, ...open.filter((booking) => flightPassengerIds(booking, input).includes(personId)).map((booking) => statusCredit(booking.status) ?? 0));

  let sum = 0;
  const missingThere: string[] = [];
  const missingHome: string[] = [];
  let complete = 0;
  let flying = true;
  for (const person of ctx.expected) {
    const mine = travel.get(person.id);
    const there = isOnRecord(mine?.arrival);
    const home = isOnRecord(mine?.departure);
    const partial = arranging(person.id);
    sum += 0.6 * (there ? 1 : partial) + 0.4 * (home ? 1 : partial);
    if (there && home) complete += 1;
    if (!there && partial === 0) missingThere.push(person.id);
    if (!home && partial === 0) missingHome.push(person.id);
    if ((there && mine!.arrival!.mode !== "flight") || (home && mine!.departure!.mode !== "flight")) flying = false;
  }
  const credit = sum / n;

  const unlisted = flights.some((booking) => isSettled(booking) && flightPassengerIds(booking, input).length === 0);
  const hint = unlisted ? "If they are on a flight you already added, tick their names on it." : null;
  const deadline = deadlineOf(fallback);
  const missing = (key: string, ids: string[], solo: string, group: (who: string, have: string) => string, share: number) => {
    if (ids.length === 0) return;
    const who = names(ctx, ids) ?? "";
    things.push({
      key: `flights:${key}`,
      kind: "flights",
      sentence: n === 1 ? solo : group(upperFirst(who), ids.length === 1 ? "has" : "have"),
      detail: join(n === 1 ? "Add your flight, or say you are driving." : "Add their flight, or say they are driving.", n === 1 ? null : hint, byWords("Book", deadline, today)),
      actionLabel: n === 1 ? "Add your travel" : "Add their travel",
      target: { tool: n === 1 ? "flights" : "people" },
      deadline,
      waiting: false,
      weight: ids.length * share,
      affectsPace: true,
    });
  };
  const same = missingThere.length > 0 && missingThere.length === missingHome.length && missingThere.every((id) => missingHome.includes(id));
  if (same) {
    missing("missing", missingThere, "Add how you are getting there and back.", (who, have) => `${who} ${have} no travel on record yet.`, 1);
  } else {
    missing("missing-there", missingThere, "Add how you are getting there.", (who, have) => `${who} ${have} no way there yet.`, 0.6);
    missing("missing-home", missingHome, "Add how you are getting home.", (who, have) => `${who} ${have} no way home yet.`, 0.4);
  }

  const thereCount = n - ctx.expected.filter((person) => !isOnRecord(travel.get(person.id)?.arrival)).length;
  const homeCount = n - ctx.expected.filter((person) => !isOnRecord(travel.get(person.id)?.departure)).length;
  const state =
    complete === n
      ? flying
        ? `${n} of ${n} seats booked, both ways`
        : n === 1
          ? "There and back, sorted"
          : `All ${n} have a way there and back`
      : `${thereCount} of ${n} have a way there, ${homeCount} of ${n} a way home`;

  let tile: Tile;
  if (complete === n) tile = { state: n === 1 ? (flying ? "Booked" : "Sorted") : flying ? `All ${n} booked` : `All ${n} sorted`, note: null, tone: "done" };
  else if (thereCount > 0 || homeCount > 0) {
    // The way there is the headline; trips home still missing go in the note.
    const note = homeCount < n ? `${count(n - homeCount, "trip")} home to add` : null;
    tile = { state: `${thereCount} of ${n} ${flying ? "booked" : "sorted"}`, note, tone: "needs_you" };
  } else tile = statusTile(open, "Booked");

  return { component, applies, credit, state, things, tile };
}

// --- stay -----------------------------------------------------------------------------------------

function lodging(ctx: Ctx, now: InstantInput): Evaluation {
  const component = "lodging" as const;
  const { input, today } = ctx;
  const holiday = ctx.config.holidayPeriod ? "Holiday stays go early." : null;
  const stays = bookingsOf(ctx, "lodging");
  const open = stays.filter((booking) => !isSettled(booking));
  const sleeping = sleepingPlan(input, now);
  const fallback = ctx.config.actBy?.lodging;
  const things: Draft[] = [];

  for (const booking of open) {
    const deadline = deadlineOf(booking.actBy, fallback);
    const named = detailsOf(booking, "lodging")?.propertyName ?? detailsOf(booking, "lodging")?.place?.name ?? null;
    const looking = booking.status === "looking";
    const by = byWords("Book", deadline, today);
    things.push({
      key: `stay:${booking.id}`,
      kind: "stay",
      sentence: looking ? (named ? `Did you book ${named}?` : "Did you book a place to stay?") : named ? `Book ${named}.` : "Find a place to stay.",
      detail: join(looking && (booking.provider ? `You were looking on ${upperFirst(booking.provider)}.` : null), by, by && holiday),
      actionLabel: looking ? "Record the booking" : named ? "Book the stay" : "Find a stay",
      target: { tool: "stay", bookingId: booking.id },
      deadline,
      waiting: false,
      weight: 1 - (statusCredit(booking.status) ?? 0),
      affectsPace: true,
    });
  }

  let credit: number;
  let applies = kindApplies(ctx, "lodging");
  if (sleeping.credit !== null) {
    credit = sleeping.credit;
    if (stays.length === 0) {
      const deadline = deadlineOf(fallback);
      const by = byWords("Book", deadline, today);
      const nights = sleeping.nights.length;
      things.push({
        key: "stay:none",
        kind: "stay",
        sentence: "Find a place to stay.",
        detail: join(`${count(nights, "night")} for ${count(ctx.expected.length, "person", "people")}.`, by, by && holiday),
        actionLabel: "Find a stay",
        target: { tool: "stay" },
        deadline,
        waiting: false,
        weight: 1,
        affectsPace: true,
      });
    } else {
      // Nights nobody has arranged anything for. Nights on a stay that is only planned are covered by its own line above.
      for (const gap of sleeping.gaps.slice(0, 3)) {
        const who = gap.everyone ? null : names(ctx, gap.personIds);
        const have = gap.personIds.length === 1 ? "has" : "have";
        const deadline = deadlineOf(fallback);
        things.push({
          key: `stay:gap:${gap.from}:${[...gap.personIds].sort().join(",")}`,
          kind: "stay",
          sentence: who ? `${upperFirst(who)} ${have} nowhere to stay on ${gap.when}.` : `Nowhere to stay on ${gap.when} yet.`,
          detail: join("Add a stay, or check the dates on the one you have.", byWords("Book", deadline, today)),
          actionLabel: "Sort out the stay",
          target: { tool: "stay" },
          deadline,
          waiting: false,
          weight: gap.nights.length * gap.personIds.length,
          affectsPace: true,
        });
      }
    }
  } else {
    // Nobody needs a bed that can be counted (no dates, no people, a one-day plan, or everyone lives there).
    credit = average(stays.map((booking) => statusCredit(booking.status) ?? 0));
    const countable = ctx.expected.length > 0 && input.plan.startDate !== null && input.plan.endDate !== null;
    if (stays.length === 0) {
      if (countable) applies = false;
      else {
        things.push({
          key: "stay:none",
          kind: "stay",
          sentence: "Find a place to stay.",
          detail: byWords("Book", deadlineOf(fallback), today),
          actionLabel: "Find a stay",
          target: { tool: "stay" },
          deadline: deadlineOf(fallback),
          waiting: false,
          weight: 1,
          affectsPace: true,
        });
      }
    }
  }

  const stayNames = [...new Set(stays.filter(isSettled).map(stayName))];
  const complete = credit === 1;
  const state =
    sleeping.credit !== null
      ? complete
        ? `${listOf(stayNames)}, ${count(sleeping.nights.length, "night")}, ${ctx.expected.length === 1 ? "sorted" : `all ${ctx.expected.length}`}`
        : `${sleeping.booked} of ${sleeping.needed} nights booked`
      : complete
        ? `Booked: ${listOf(stayNames)}`
        : stays.length
          ? "Not booked yet"
          : "Nowhere to stay yet";

  let tile: Tile;
  if (complete && stayNames.length === 1) tile = { state: `Booked: ${stayNames[0]}`, note: null, tone: "done" };
  else if (complete) tile = { state: `${count(stayNames.length, "stay")} booked`, note: null, tone: "done" };
  else if (stayNames.length > 0 && sleeping.credit !== null) {
    tile = { state: `${sleeping.booked} of ${sleeping.needed} nights booked`, note: stayNames.length === 1 ? stayNames[0] : null, tone: "needs_you" };
  } else if (open.length === 1 && open[0].status === "planned") {
    const named = detailsOf(open[0], "lodging")?.propertyName;
    tile = { state: named ? `Planned: ${named}` : "Planned", note: null, tone: "underway" };
  } else tile = statusTile(stays, "Booked");

  return { component, applies, credit, state, things, tile };
}

// --- car ------------------------------------------------------------------------------------------

function carWord(booking: Booking | undefined): string {
  switch (booking ? detailsOf(booking, "car")?.vehicleClass : undefined) {
    case "minivan":
      return "minivan";
    case "van":
      return "van";
    case "suv":
      return "SUV";
    case "pickup":
      return "truck";
    default:
      return "car";
  }
}

const aOrAn = (word: string) => (/^(SUV|[aeiou])/i.test(word) ? `an ${word}` : `a ${word}`);

function car(ctx: Ctx): Evaluation {
  const component = "car" as const;
  const { today } = ctx;
  const cars = bookingsOf(ctx, "car");
  const open = cars.filter((booking) => !isSettled(booking));
  const holiday = ctx.config.holidayPeriod ? "Holiday rentals sell out." : null;
  const fallback = ctx.config.actBy?.car;
  const things: Draft[] = [];

  const draft = (booking: Booking | undefined): Draft => {
    const word = carWord(booking);
    const deadline = deadlineOf(booking?.actBy, fallback);
    const looking = booking?.status === "looking";
    const by = byWords("Book", deadline, today);
    return {
      key: booking ? `car:${booking.id}` : "car:none",
      kind: "car",
      sentence: looking ? `Did you book the ${word}?` : `Find the ${word}.`,
      detail: join(looking && booking?.provider ? `You were looking on ${upperFirst(booking.provider)}.` : null, by, by && holiday),
      actionLabel: looking ? "Record the booking" : `Find ${aOrAn(word)}`,
      target: booking ? { tool: "car", bookingId: booking.id } : { tool: "car" },
      deadline,
      waiting: false,
      weight: 1 - (booking ? (statusCredit(booking.status) ?? 0) : 0),
      affectsPace: true,
    };
  };
  if (cars.length === 0) things.push(draft(undefined));
  for (const booking of open) things.push(draft(booking));

  const credit = average(cars.map((booking) => statusCredit(booking.status) ?? 0));
  const company = cars.length === 1 ? (detailsOf(cars[0], "car")?.company ?? cars[0].vendorName) : null;
  const tile = statusTile(cars, company ? `Booked: ${company}` : "Booked");
  return { component, applies: kindApplies(ctx, "car"), credit, state: tile.state, things, tile };
}

// --- rides ----------------------------------------------------------------------------------------

function rideName(details: RideDetails | null): string {
  if (details?.fromPlace?.kind === "airport") return "airport pickup";
  if (details?.toPlace?.kind === "airport") return "ride to the airport";
  return "ride";
}

function rides(ctx: Ctx): Evaluation {
  const component = "rides" as const;
  const { today } = ctx;
  const rows = [...ctx.board.arrivals.rows, ...ctx.board.departures.rows].filter((row) => row.status.value !== "cancelled");
  const needing = rows.filter((row) => row.ride.credit !== null);
  const linked = new Set(rows.map((row) => row.ride.rideBookingId).filter((id): id is string => id !== null));
  const bookings = bookingsOf(ctx, "ride");
  const loose = bookings.filter((booking) => !linked.has(booking.id));
  const fallback = ctx.config.actBy?.ride;
  const things: Draft[] = [];

  const credits = [...needing.map((row) => row.ride.credit ?? 0), ...loose.map((booking) => statusCredit(booking.status) ?? 0)];
  const total = credits.length;
  const credit = average(credits);

  // People who asked for a ride and have none, a day at a time.
  const byDay = new Map<string, ArrivalRow[]>();
  for (const row of needing) {
    if (row.ride.state !== "needs_ride") continue;
    const key = `${row.direction}:${row.localDate ?? "undated"}`;
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  for (const [key, dayRows] of byDay) {
    const ids = dayRows.flatMap((row) => row.personIds);
    const date = dayRows[0].localDate;
    const arriving = dayRows[0].direction === "arrival";
    const who = names(ctx, ids) ?? dayRows.map((row) => row.partyName).join(", ");
    const one = ids.length === 1;
    // Product spec D4: worth a look a week out, urgent two days out.
    const deadline = date ? { recommended: addDays(date, -7), hard: addDays(date, -2) } : null;
    things.push({
      key: `rides:needs:${key}`,
      kind: "rides",
      sentence: arriving
        ? date
          ? `${upperFirst(who)} ${one ? "lands" : "land"} ${dayText(date)} with no ride.`
          : `${upperFirst(who)} ${one ? "needs" : "need"} a ride from the airport.`
        : `${upperFirst(who)} ${one ? "needs" : "need"} a ride to the airport${date ? ` on ${dayText(date)}` : ""}.`,
      detail: "Pick someone to drive, or plan a ride.",
      actionLabel: "Sort out the ride",
      target: { tool: "rides" },
      deadline,
      waiting: false,
      weight: dayRows.length,
      affectsPace: true,
    });
  }

  // Arrivals where nobody has said whether a ride is needed. The organizer's own household is
  // theirs to decide; everyone else has to be asked.
  const unknown = needing.filter((row) => row.ride.state === "unknown");
  const isOwn = (row: ArrivalRow) => row.personIds.some((id) => ctx.peopleById.get(id)?.role === "organizer") || ctx.expected.length === 1;
  const askAbout = (key: string, rows: ArrivalRow[], sentence: string, detail: string, actionLabel: string, tool: "rides" | "people") => {
    if (rows.length === 0) return;
    const dates = rows.map((row) => row.localDate).filter((d): d is LocalDate => d !== null).sort(compareDates);
    things.push({
      key,
      kind: "rides",
      sentence,
      detail,
      actionLabel,
      target: { tool },
      deadline: dates.length ? { recommended: addDays(dates[0], -7), hard: addDays(dates[0], -2) } : null,
      waiting: false,
      weight: rows.length,
      affectsPace: true,
    });
  };
  const own = unknown.filter(isOwn);
  const others = unknown.filter((row) => !isOwn(row));
  const otherParties = [...new Set(others.map((row) => row.partyName))];
  askAbout("rides:own", own, "Decide how you are getting from the airport.", "A ride, a car you rent, or someone picking you up.", "Plan the ride", "rides");
  askAbout(
    "rides:unknown",
    others,
    otherParties.length <= 2 ? `Ask ${listOf(otherParties)} about a ride.` : `Ask ${count(otherParties.length, ctx.words.party, ctx.words.parties)} about a ride.`,
    "Nobody has said whether they need one from the airport.",
    "See arrivals",
    "people",
  );

  for (const booking of bookings) {
    if (isSettled(booking)) continue;
    const details = detailsOf(booking, "ride");
    const name = rideName(details);
    const date = details?.pickupAt ? localDateOf(details.pickupAt.at, details.pickupAt.tz) : null;
    // Product spec 10.4: reserve two days ahead; the day itself is the last moment.
    const deadline = deadlineOf(booking.actBy, date ? { recommended: addDays(date, -2), hard: date } : null, fallback);
    const looking = booking.status === "looking";
    const when = details?.pickupAt ? `${dayText(date!)} at ${clockText(details.pickupAt.at, details.pickupAt.tz, ctx.wording)}` : null;
    const personal = details?.rideType === "personal_pickup";
    things.push({
      key: `rides:${booking.id}`,
      kind: "rides",
      sentence: looking
        ? `Did you reserve the ${name}?`
        : booking.status === "needed"
          ? `Plan the ${name}.`
          : personal
            ? `Find a driver for the ${name}.`
            : `Reserve the ${name}.`,
      detail: join(when && `Planned for ${when}.`, byWords(personal ? "Settle it" : "Reserve", deadline, today)),
      actionLabel: looking ? "Record the booking" : personal ? "Pick a driver" : booking.status === "needed" ? "Plan the ride" : "Reserve the ride",
      target: { tool: "rides", bookingId: booking.id },
      deadline,
      waiting: false,
      weight: 1 - (statusCredit(booking.status) ?? 0),
      affectsPace: true,
    });
  }

  const kind = kindApplies(ctx, "ride");
  let applies = kind || needing.length > 0;
  let waiting = false;
  if (total === 0) {
    if (rows.length > 0) applies = false; // Everyone on the board is covered: own car, rental car, already there.
    else if (applies) {
      waiting = true;
      things.push({
        key: "rides:none",
        kind: "rides",
        sentence: "Rides come after arrivals.",
        detail: "Once flights are in, you will see who needs picking up.",
        actionLabel: "See arrivals",
        target: { tool: "people" },
        deadline: null,
        waiting: true,
        weight: 1,
        affectsPace: false,
      });
    }
  }

  const sorted = credits.filter((c) => c === 1).length;
  const state = total === 0 ? (waiting ? "Waiting for arrivals" : "Nothing to arrange") : `${sorted} of ${count(total, "ride")} sorted`;

  const needCount = needing.filter((row) => row.ride.state === "needs_ride").reduce((sum, row) => sum + row.headCount, 0);
  const openBookings = bookings.filter((booking) => !isSettled(booking));
  let tile: Tile;
  if (total === 0) tile = waiting ? { state: "Nothing to plan yet", note: null, tone: "waiting" } : { state: "Everyone is covered", note: null, tone: "done" };
  else if (needCount > 0) tile = { state: `${needCount} ${needCount === 1 ? "needs" : "need"} a ride`, note: null, tone: "needs_you" };
  else if (unknown.length > 0) tile = { state: `${count(unknown.length, ctx.words.party, ctx.words.parties)} to ask`, note: null, tone: "needs_you" };
  else if (openBookings.length === 1 && total === 1) {
    const b = openBookings[0];
    const word = b.status === "looking" ? "still open" : b.status === "needed" ? "to plan" : "planned";
    tile = { state: `${upperFirst(rideName(detailsOf(b, "ride")))} ${word}`, note: null, tone: b.status === "planned" ? "underway" : "needs_you" };
  } else if (openBookings.length > 0) tile = { state: `${sorted} of ${count(total, "ride")} set`, note: `${openBookings.length} still to reserve`, tone: "underway" };
  else if (total === 1 && bookings.length === 1) tile = { state: `${upperFirst(rideName(detailsOf(bookings[0], "ride")))} set`, note: null, tone: "done" };
  else tile = { state: `${count(total, "ride")} set`, note: null, tone: "done" };

  return { component, applies, credit, state, things, tile };
}

// --- food -----------------------------------------------------------------------------------------

function mealName(booking: Booking, details: MealDetails | null): string {
  if (details?.mealType === "groceries") return "the groceries";
  if (details?.mealType === "catering") return "the catering";
  const vendor = details?.vendorName ?? booking.vendorName;
  return vendor ? `the food from ${vendor}` : "the food delivery";
}

function meals(ctx: Ctx): Evaluation {
  const component = "meals" as const;
  const { today } = ctx;
  const orders = bookingsOf(ctx, "meal");
  const fallback = ctx.config.actBy?.meal;
  const things: Draft[] = [];
  const credits: number[] = [];
  let waitingCount = 0;

  for (const booking of orders) {
    const details = detailsOf(booking, "meal");
    const opensOn = details?.orderOpensOn ?? booking.actBy.opensOn ?? null;
    const windowClosed = booking.status === "planned" && opensOn !== null && compareDates(today, opensOn) < 0;
    // Product spec 11.2: planned and waiting for the provider's window to open counts as half done.
    credits.push(windowClosed ? 0.5 : (statusCredit(booking.status) ?? 0));
    if (isSettled(booking)) continue;

    const name = mealName(booking, details);
    const date = details?.windowStart ? localDateOf(details.windowStart.at, details.windowStart.tz) : null;
    const forDay = date ? ` for ${dayText(date)}` : "";
    const deadline = deadlineOf(booking.actBy, { recommended: opensOn ?? undefined, hard: date ? addDays(date, -1) : undefined }, fallback);
    if (windowClosed) {
      waitingCount += 1;
      things.push({
        key: `food:${booking.id}`,
        kind: "food",
        sentence: `${upperFirst(name)} can be ordered from ${formatDate(opensOn!)}.`,
        detail: join(date && `Planned for ${dayText(date)}.`, "The order window is not open yet."),
        actionLabel: "See the plan",
        target: { tool: "food", bookingId: booking.id },
        deadline,
        waiting: true,
        weight: 0.5,
        affectsPace: false,
      });
      continue;
    }
    const looking = booking.status === "looking";
    // "Best done by" for food is the day the window opens, so the date worth showing is the last day.
    const lastDay = deadline?.hard ?? null;
    things.push({
      key: `food:${booking.id}`,
      kind: "food",
      sentence: looking ? `Did you order ${name}${forDay}?` : booking.status === "needed" ? `Plan ${name}${forDay}.` : `Order ${name}${forDay}.`,
      detail: join(booking.status === "planned" && opensOn && "The order window is open.", byWords("Order", lastDay ? { hard: lastDay } : null, today)),
      actionLabel: looking ? "Record the order" : booking.status === "needed" ? "Plan it" : "Place the order",
      target: { tool: "food", bookingId: booking.id },
      deadline,
      dueBy: lastDay,
      waiting: false,
      weight: 1 - (statusCredit(booking.status) ?? 0),
      affectsPace: true,
    });
  }

  if (orders.length === 0) {
    things.push({
      key: "food:none",
      kind: "food",
      sentence: "Plan the food.",
      detail: "Dinner on the first night, or groceries waiting at the door.",
      actionLabel: "Plan food",
      target: { tool: "food" },
      deadline: deadlineOf(fallback),
      waiting: false,
      weight: 1,
      affectsPace: true,
    });
  }

  const placed = orders.filter(isSettled).length;
  const open = orders.length - placed;
  const state = orders.length === 0 ? "Nothing planned yet" : `${placed} of ${count(orders.length, "order")} placed`;
  let tile: Tile;
  if (orders.length === 0) tile = { state: "Needs you", note: null, tone: "needs_you" };
  else if (placed > 0) tile = { state: `${count(placed, "delivery", "deliveries")} set`, note: open ? `${open} more planned` : null, tone: open > waitingCount ? "needs_you" : open ? "waiting" : "done" };
  else if (orders.some((booking) => booking.status === "looking")) tile = { state: "Still looking", note: null, tone: "needs_you" };
  else if (orders.some((booking) => booking.status === "planned")) tile = { state: `${count(open, "delivery", "deliveries")} planned`, note: null, tone: open > waitingCount ? "needs_you" : "waiting" };
  else tile = { state: "Needs you", note: null, tone: "needs_you" };

  return { component, applies: kindApplies(ctx, "meal"), credit: average(credits), state, things, tile };
}

// --- send ahead -----------------------------------------------------------------------------------

function parcelNoun(details: ShipmentDetails | null): [string, string] {
  switch (details?.shipmentKind) {
    case "luggage":
      return ["bag", "bags"];
    case "mail":
      return ["package", "packages"];
    case "retail_order":
      return ["order", "orders"];
    default:
      return ["box", "boxes"];
  }
}

type ShipmentStage = "planning" | "ready" | "on_its_way" | "arrived";

function shipmentStage(booking: Booking, details: ShipmentDetails | null): { stage: ShipmentStage; credit: number } {
  const parcels = details?.parcels ?? [];
  const arrived = (status: string) => status === "delivered" || status === "picked_up";
  if (booking.status === "done" || (parcels.length > 0 && parcels.every((parcel) => arrived(parcel.status)))) return { stage: "arrived", credit: 1 };
  if (parcels.length > 0 && parcels.every((parcel) => parcel.status === "shipped" || arrived(parcel.status))) return { stage: "on_its_way", credit: 0.75 };
  // Product spec 11.2: planned 0.25, booked 0.5, shipped 0.75, delivered 1.
  if (booking.status === "booked") return { stage: "ready", credit: 0.5 };
  return { stage: "planning", credit: statusCredit(booking.status) ?? 0 };
}

function shipAhead(ctx: Ctx): Evaluation {
  const component = "shipAhead" as const;
  const { today } = ctx;
  const shipments = bookingsOf(ctx, "shipment");
  const things: Draft[] = [];
  const credits: number[] = [];
  let onTheWay = 0;
  let arrivedCount = 0;
  let nextArrival: LocalDate | null = null;
  let nextShipBy: LocalDate | null = null;
  let noun: [string, string] = ["box", "boxes"];
  let late = false;

  for (const booking of shipments) {
    const details = detailsOf(booking, "shipment");
    const { stage, credit } = shipmentStage(booking, details);
    credits.push(credit);
    const n = Math.max(1, details?.parcels.length ?? 1);
    const [one, many] = parcelNoun(details);
    noun = [one, many];
    const what = n === 1 ? `the ${one}` : `the ${n} ${many}`;
    const target = details?.targetDeliveryDate ?? null;
    const shipBy = details?.shipByDate ?? null;
    if (stage === "arrived") {
      arrivedCount += n;
      continue;
    }
    if (stage === "on_its_way") {
      onTheWay += n;
      if (target && (!nextArrival || compareDates(target, nextArrival) < 0)) nextArrival = target;
      const overdue = target !== null && compareDates(today, target) > 0;
      if (overdue) late = true;
      things.push({
        key: `send-ahead:${booking.id}`,
        kind: "send-ahead",
        sentence: overdue ? `Check that ${what} arrived.` : `${upperFirst(count(n, one, many))} ${n === 1 ? "is on its" : "are on their"} way.`,
        detail: overdue ? `${n === 1 ? "It was" : "They were"} due ${formatDate(target!)}.` : target ? `${n === 1 ? "It" : "They"} should arrive ${formatDate(target)}.` : null,
        actionLabel: overdue ? "Mark it delivered" : "Track it",
        target: { tool: "send-ahead", bookingId: booking.id },
        // Product spec D10: a day past the target with no word is worth attention.
        deadline: target ? { recommended: target } : null,
        waiting: !overdue,
        weight: 0.25,
        affectsPace: overdue,
      });
      continue;
    }
    if (shipBy && (!nextShipBy || compareDates(shipBy, nextShipBy) < 0)) nextShipBy = shipBy;
    const deadline = deadlineOf(booking.actBy, shipBy ? { recommended: addDays(shipBy, -5), hard: shipBy } : null);
    const past = shipBy !== null && compareDates(today, shipBy) > 0;
    things.push({
      key: `send-ahead:${booking.id}`,
      kind: "send-ahead",
      sentence: !shipBy ? `Finish planning ${what}.` : past ? `Send ${what} as soon as you can.` : shipBy === today ? `Send ${what} today.` : `Send ${what} by ${formatDate(shipBy)}.`,
      detail: !shipBy
        ? "Pick where it is going and the last safe day to send it."
        : past
          ? `The last safe day was ${formatDate(shipBy)}. A faster service may still get it there.`
          : target
            ? `That gets it there by ${formatDate(target)}.`
            : null,
      actionLabel: stage === "ready" ? "Record the tracking" : "Get it ready",
      target: { tool: "send-ahead", bookingId: booking.id },
      deadline,
      dueBy: shipBy,
      waiting: false,
      weight: 1 - credit,
      affectsPace: true,
    });
  }

  if (shipments.length === 0) {
    things.push({
      key: "send-ahead:none",
      kind: "send-ahead",
      sentence: "Decide what to send ahead.",
      detail: "Luggage, gifts or gear can be waiting when you arrive.",
      actionLabel: "Plan what to send",
      target: { tool: "send-ahead" },
      deadline: null,
      waiting: false,
      weight: 1,
      affectsPace: false,
    });
  }

  const pending = shipments.length - credits.filter((c) => c >= 0.75).length;
  const state =
    shipments.length === 0
      ? "Nothing planned yet"
      : onTheWay > 0
        ? `${count(onTheWay, noun[0], noun[1])} in transit`
        : pending === 0
          ? `${count(arrivedCount, noun[0], noun[1])} arrived`
          : `${count(pending, noun[0], noun[1])} to send`;

  let tile: Tile;
  if (shipments.length === 0) tile = { state: "Needs you", note: null, tone: "needs_you" };
  else if (pending > 0) tile = { state: nextShipBy ? `Send by ${formatDate(nextShipBy)}` : "Needs you", note: onTheWay ? `${count(onTheWay, noun[0], noun[1])} on the way` : null, tone: "needs_you" };
  else if (onTheWay > 0) {
    tile = {
      state: `${count(onTheWay, noun[0], noun[1])} on ${onTheWay === 1 ? "its" : "their"} way${nextArrival ? `, ${late ? "was due" : "arrives"} ${formatDate(nextArrival)}` : ""}`,
      note: null,
      tone: late ? "needs_you" : "waiting",
    };
  } else tile = { state: `${count(arrivedCount, noun[0], noun[1])} arrived`, note: null, tone: "done" };

  return { component, applies: kindApplies(ctx, "shipment"), credit: average(credits), state, things, tile };
}

// --- who's coming ---------------------------------------------------------------------------------

function people(ctx: Ctx): Evaluation {
  const component = "people" as const;
  const { input, today } = ctx;
  const everyone = input.people;
  const total = everyone.length;
  const solo = total <= 1 && input.plan.expectedPeople <= 1;
  const things: Draft[] = [];
  const replied = everyone.filter(hasReplied).length;
  const coming = everyone.filter((person) => person.rsvpStatus === "yes").length;
  const waitingOn = everyone.filter((person) => !hasReplied(person));
  const replyBy = input.site?.replyDeadline ?? input.plan.replyDeadline;
  const deadline: Deadline | null = replyBy ? { recommended: replyBy } : null;

  if (!solo && total === 0) {
    things.push({
      key: "people:add",
      kind: "people",
      sentence: `Add the ${ctx.words.people} coming.`,
      detail: `Names are enough. Each ${ctx.words.party} gets its own link to reply.`,
      actionLabel: "Add people",
      target: { tool: "people" },
      deadline: null,
      waiting: false,
      weight: 1,
      affectsPace: false,
    });
  } else if (!solo && waitingOn.length > 0) {
    const nobodyAsked = everyone.every((person) => person.rsvpStatus === "not_invited");
    const due = replyBy ? (compareDates(today, replyBy) > 0 ? `Replies were due ${formatDate(replyBy)}.` : `Replies are due ${formatDate(replyBy)}.`) : null;
    const who = names(ctx, waitingOn.map((person) => person.id)) ?? "";
    things.push({
      key: "people:replies",
      kind: "people",
      sentence: nobodyAsked ? `Invite your ${ctx.words.people}.` : `${upperFirst(who)} ${waitingOn.length === 1 ? "has" : "have"} not replied.`,
      detail: nobodyAsked ? join(`${count(total, ctx.words.person, ctx.words.people)} on the list, and nobody has been asked yet.`, due) : due,
      actionLabel: nobodyAsked ? "Copy the invite" : "Send a nudge",
      target: { tool: "people" },
      deadline,
      waiting: false,
      weight: 1,
      affectsPace: true,
    });
  }

  const tile: Tile = solo
    ? { state: "Just you", note: null, tone: "done" }
    : total === 0
      ? { state: "Add people", note: null, tone: "needs_you" }
      : {
          state: `${coming} of ${total}`,
          note: waitingOn.length ? `${waitingOn.length} ${waitingOn.length === 1 ? "has" : "have"} not replied` : null,
          tone: waitingOn.length ? "underway" : "done",
        };

  return {
    component,
    applies: !solo,
    credit: total === 0 ? 0 : replied / total,
    state: total === 0 ? "Nobody added yet" : `${replied} of ${total} replied`,
    things,
    tile,
  };
}

// --- schedule -------------------------------------------------------------------------------------

function schedule(ctx: Ctx): Evaluation {
  const component = "schedule" as const;
  const live = ctx.input.items.filter((item) => item.status !== "cancelled");
  const key = live.filter((item) => item.isKeyMoment);
  const hasTime = (item: (typeof key)[number]) => item.startsAt !== null || item.allDay;
  const unfinished = key.filter((item) => !(hasTime(item) && item.place !== null));
  const done = key.length - unfinished.length;
  const things: Draft[] = [];
  const timeline = ctx.words.timeline.toLowerCase();

  if (key.length === 0) {
    things.push({
      key: "schedule:none",
      kind: "schedule",
      sentence: `Add the main moments to the ${timeline}.`,
      detail: "The big dinner, the day itself, the goodbye. Give each a time and a place.",
      actionLabel: `Open the ${timeline}`,
      target: { tool: "schedule" },
      deadline: null,
      waiting: false,
      weight: 1,
      affectsPace: false,
    });
  } else if (unfinished.length === 1) {
    const item = unfinished[0];
    const needs = !hasTime(item) && item.place === null ? "a time and a place" : !hasTime(item) ? "a time" : "a place";
    things.push({
      key: "schedule:unfinished",
      kind: "schedule",
      sentence: `${item.title} needs ${needs}.`,
      detail: `It is on ${dayText(item.localDate)}.`,
      actionLabel: `Finish the ${timeline}`,
      target: { tool: "schedule", itemId: item.id },
      deadline: null,
      waiting: false,
      weight: 1,
      affectsPace: false,
    });
  } else if (unfinished.length > 1) {
    const titles = unfinished.map((item) => item.title);
    things.push({
      key: "schedule:unfinished",
      kind: "schedule",
      sentence: `${unfinished.length} key moments need a time and a place.`,
      detail: titles.length <= 4 ? `${listOf(titles)}.` : `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more.`,
      actionLabel: `Finish the ${timeline}`,
      target: { tool: "schedule" },
      deadline: null,
      waiting: false,
      weight: 1,
      affectsPace: false,
    });
  }

  const tile: Tile =
    live.length === 0
      ? { state: "Nothing yet", note: null, tone: "needs_you" }
      : {
          state: `${count(live.length, "thing")} planned`,
          note: unfinished.length ? `${unfinished.length} ${unfinished.length === 1 ? "needs" : "need"} a time or place` : null,
          tone: key.length > 0 && unfinished.length === 0 ? "done" : "underway",
        };

  return {
    component,
    applies: true,
    credit: key.length === 0 ? 0 : done / key.length,
    state: key.length === 0 ? "No key moments yet" : `${done} of ${key.length} key moments have a time and place`,
    things,
    tile,
  };
}

// --- share page -----------------------------------------------------------------------------------

function site(ctx: Ctx): Evaluation {
  const component = "site" as const;
  const page = ctx.input.site;
  const published = page?.status === "published";
  const start = ctx.input.plan.startDate;
  const things: Draft[] = [];
  if (!published) {
    things.push({
      key: "page:publish",
      kind: "page",
      sentence: page?.status === "unpublished" ? "Put your page back up." : "Publish your page.",
      detail: page ? "The draft is ready. One link gives everyone the details." : "One link gives everyone the details.",
      actionLabel: "Review and publish",
      target: { tool: "page" },
      // Product spec 10.4: published a month out. It orders the list; it never makes the plan "needs attention".
      deadline: start ? { recommended: addDays(start, -30) } : null,
      waiting: false,
      weight: 1,
      affectsPace: false,
    });
  }
  const state = published ? "Live" : page?.status === "unpublished" ? "Taken down" : page ? "Draft" : "Not started";
  return {
    component,
    applies: true,
    credit: published ? 1 : 0,
    state,
    things,
    tile: { state, note: null, tone: published ? "done" : "needs_you" },
  };
}

// --- to-dos ---------------------------------------------------------------------------------------

function tasks(ctx: Ctx): Evaluation {
  const component = "tasks" as const;
  const { today } = ctx;
  const essential = ctx.input.tasks.filter((task) => task.essential);
  const open = essential
    .filter((task) => !task.done)
    .sort((a, b) => (a.dueDate && b.dueDate ? compareDates(a.dueDate, b.dueDate) : a.dueDate ? -1 : b.dueDate ? 1 : 0) || a.sortOrder - b.sortOrder);
  const things: Draft[] = open.map((task) => {
    const due = task.dueDate;
    return {
      key: `task:${task.id}`,
      kind: "task",
      sentence: asSentence(task.title),
      detail: !due ? null : compareDates(today, due) > 0 ? `This was due ${formatDate(due)}.` : due === today ? "Due today." : `Due ${formatDate(due)}.`,
      actionLabel: "Mark done",
      target: { tool: "hub", taskId: task.id, ...(task.bookingId ? { bookingId: task.bookingId } : {}) },
      // Overdue is the day after the due date: that is what makes a plan "at risk" (product spec 11.3).
      deadline: due ? { recommended: due, hard: addDays(due, 1) } : null,
      dueBy: due,
      waiting: false,
      weight: 1,
      affectsPace: true,
    };
  });
  const done = essential.length - open.length;
  return {
    component,
    applies: essential.length > 0,
    credit: essential.length === 0 ? 0 : done / essential.length,
    state: `${done} of ${essential.length} essential to-dos done`,
    things,
    tile: { state: "", note: null, tone: "off" },
  };
}

// --- putting it together --------------------------------------------------------------------------

type Evaluated = { ctx: Ctx; evaluations: Record<ReadinessComponent, Evaluation> };

function evaluate(input: PlanData, config: ReadinessConfig, now: InstantInput, options: ReadinessOptions): Evaluated {
  const wording = options.wording ?? {};
  const words = { ...DEFAULT_PEOPLE_WORDS, timeline: "Schedule", ...config.words };
  const ctx: Ctx = {
    input,
    config,
    today: localDateOf(now, input.plan.tz),
    wording,
    words,
    board: resolveArrivals(input, now, { wording }),
    expected: input.people.filter(isExpected),
    peopleById: new Map(input.people.map((person) => [person.id, person])),
  };
  const evaluations: Record<ReadinessComponent, Evaluation> = {
    gettingThere: gettingThere(ctx),
    lodging: lodging(ctx, now),
    car: car(ctx),
    rides: rides(ctx),
    meals: meals(ctx),
    shipAhead: shipAhead(ctx),
    people: people(ctx),
    schedule: schedule(ctx),
    site: site(ctx),
    tasks: tasks(ctx),
  };
  for (const component of READINESS_COMPONENTS) {
    const weight = config.weights[component];
    if (!(weight > 0)) evaluations[component].applies = false;
    const kind = KIND_OF[component];
    if (kind && input.plan.kindsNotNeeded.includes(kind)) evaluations[component].applies = false;
  }
  return { ctx, evaluations };
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const PACE_LABELS: Record<Pace, string> = { on_track: "On track", needs_attention: "Needs attention", at_risk: "At risk", ready: "Ready" };

/**
 * How prepared a plan is and what is left to do.
 *
 * @param input  Everything about the plan (`loadPlanData`).
 * @param config The template's weights and words: pass `templateConfig(plan)` (see ReadinessConfig).
 * @param now    The current instant. "Today" is read in the plan's own zone.
 *
 * `thingsLeft` is ordered the way the product spec ranks the next action: the component with
 * the most to gain comes first, where gain is its missing points times how pressing its dates
 * are (3 at or past the last day, 2 past "best done by", 1.5 within a week of it, otherwise 1),
 * and ties go to the fixed order Flights, Stay, Car, Rides, Food, Send ahead, Who's coming,
 * Schedule, Share page, To-dos. Things that are only waiting come last.
 */
export function computeReadiness(input: PlanData, config: ReadinessConfig, now: InstantInput, options: ReadinessOptions = {}): Readiness {
  const { ctx, evaluations } = evaluate(input, config, now, options);
  const counted = READINESS_COMPONENTS.filter((component) => evaluations[component].applies);
  const leftOut = READINESS_COMPONENTS.filter((component) => !evaluations[component].applies);
  const totalWeight = counted.reduce((sum, component) => sum + config.weights[component], 0);
  const planHref = `/plans/${input.plan.id}`;

  let exact = 0;
  let allComplete = true;
  type Ranked = { row: BreakdownRow; things: ThingLeft[]; rank: number; paceLevels: Pressure["level"][]; order: number };
  const ranked: Ranked[] = counted.map((component, order) => {
    const evaluation = evaluations[component];
    const weight = (config.weights[component] * 100) / totalWeight;
    const credit = Math.min(1, Math.max(0, evaluation.credit));
    // Guard against 0.9999999 from averaging thirds: complete means every part is complete.
    const complete = credit > 1 - 1e-9;
    if (!complete) allComplete = false;
    exact += weight * credit;
    const available = complete ? 0 : weight * (1 - credit);

    const drafts = complete ? [] : evaluation.things;
    const weights = drafts.reduce((sum, draft) => sum + Math.max(0, draft.weight), 0);
    const paceLevels: Pressure["level"][] = [];
    const things: ThingLeft[] = drafts.map((draft) => {
      const pressure = pressureOf(draft.deadline, ctx.today);
      if (draft.affectsPace && !draft.waiting) paceLevels.push(pressure.level);
      const tool = draft.target.tool;
      return {
        key: draft.key,
        kind: draft.kind,
        component,
        sentence: draft.sentence,
        detail: draft.detail,
        actionLabel: draft.actionLabel,
        target: { ...draft.target, href: tool === "hub" ? planHref : `${planHref}/${tool}` },
        dueBy: draft.dueBy !== undefined ? draft.dueBy : pressure.dueBy,
        urgency: pressure.urgency,
        waiting: draft.waiting,
        gain: round2(weights > 0 ? (available * Math.max(0, draft.weight)) / weights : available / Math.max(1, drafts.length)),
      };
    });
    // Within a component: what needs the person first, then the most pressing, then the most to gain.
    things.sort((a, b) => Number(a.waiting) - Number(b.waiting) || b.urgency - a.urgency || b.gain - a.gain);
    const urgency = things.filter((thing) => !thing.waiting).reduce<Urgency>((max, thing) => (thing.urgency > max ? thing.urgency : max), 1);
    return {
      row: {
        component,
        label: component === "schedule" ? ctx.words.timeline : LABELS[component],
        weight: round2(weight),
        credit: round2(credit),
        points: round2(weight * credit),
        pointsAvailable: round2(available),
        state: evaluation.state,
        urgency,
      },
      things,
      rank: available * urgency,
      paceLevels,
      order,
    };
  });

  const byRank = [...ranked].sort((a, b) => b.rank - a.rank || a.order - b.order);
  const all = byRank.flatMap((entry) => entry.things);
  const thingsLeft = [...all.filter((thing) => !thing.waiting), ...all.filter((thing) => thing.waiting)];
  const needsYou = thingsLeft.filter((thing) => !thing.waiting);

  // Thirds and ninths leave a float a hair off (67.49999999): settle that before rounding to a whole percent.
  const score = totalWeight === 0 ? 100 : allComplete ? 100 : Math.min(99, Math.round(Math.round(exact * 1e6) / 1e6));
  const levels = ranked.flatMap((entry) => entry.paceLevels);
  const pace: Pace =
    score === 100 ? "ready" : levels.includes("past_hard") ? "at_risk" : levels.includes("past_recommended") ? "needs_attention" : "on_track";
  const paceUrgency = pace === "at_risk" ? 3 : pace === "needs_attention" ? 2 : null;
  const paceReason = paceUrgency ? (needsYou.find((thing) => thing.urgency === paceUrgency)?.sentence ?? null) : null;

  return {
    score,
    pace,
    paceLabel: PACE_LABELS[pace],
    paceReason,
    breakdown: [...ranked].sort((a, b) => b.row.pointsAvailable - a.row.pointsAvailable || a.order - b.order).map((entry) => entry.row),
    leftOut,
    nextAction: needsYou[0] ?? null,
    thingsLeft,
    thingsLeftCount: needsYou.length,
    headline:
      needsYou.length === 0 ? (thingsLeft.length > 0 ? "Nothing needs you right now" : "All set") : needsYou.length === 1 ? "1 thing left" : `${needsYou.length} things left`,
  };
}

const TOOL_LABELS: Record<ToolKey, string> = {
  flights: "Flights",
  stay: "Stay",
  car: "Car",
  rides: "Rides",
  food: "Food",
  "send-ahead": "Send ahead",
  people: "Who's coming",
  schedule: "Schedule",
  money: "Money",
  page: "Share page",
};

/**
 * One line of plain words for each of a plan's ten tools, in display order: Flights, Stay, Car,
 * Rides, Food, Send ahead, Who's coming, Schedule, Money, Share page.
 *
 *   toolStates(planData, templateConfig(plan), now).map((t) => `${t.label}: ${t.state}`)
 *   // ["Flights: All 9 booked", "Stay: Booked: Lakeside house", "Car: Needs you",
 *   //  "Rides: Airport pickup planned", "Food: 2 deliveries set",
 *   //  "Send ahead: 1 box on its way, arrives Dec 21", "Who's coming: 7 of 9",
 *   //  "Schedule: 5 things planned", "Money: $4,280 so far", "Share page: Live"]
 *
 * A booking kind the plan does not use reads "Not planned", or "Not needed" when the person
 * said so; its tone is "off".
 */
export function toolStates(input: PlanData, config: ReadinessConfig, now: InstantInput, options: ReadinessOptions = {}): ToolState[] {
  const { ctx, evaluations } = evaluate(input, config, now, options);
  const planHref = `/plans/${input.plan.id}`;
  const componentOf = (tool: ToolKey): ReadinessComponent | null =>
    READINESS_COMPONENTS.find((component) => TOOL_OF[component] === tool) ?? null;

  return TOOLS.map((tool): ToolState => {
    const base = { tool, label: tool === "schedule" ? ctx.words.timeline : TOOL_LABELS[tool], href: `${planHref}/${tool}` };
    if (tool === "money") {
      const money = moneySummary(input);
      return { ...base, state: money.line, note: money.budgetLine, tone: money.overBudget ? "needs_you" : money.entries ? "underway" : "off" };
    }
    const component = componentOf(tool)!;
    const kind = KIND_OF[component];
    // A booking kind this plan does not use. The other tools always have something to say.
    if (kind && !kindUsed(ctx, component, kind, evaluations[component])) return { ...base, ...off(ctx, kind) };
    return { ...base, ...evaluations[component].tile };
  });
}

function kindUsed(ctx: Ctx, component: ReadinessComponent, kind: BookingKind, evaluation: Evaluation): boolean {
  if (ctx.input.plan.kindsNotNeeded.includes(kind)) return false;
  if (component === "gettingThere") return kindApplies(ctx, kind) || ctx.input.arrivals.length > 0;
  if (component === "rides") return kindApplies(ctx, kind) || evaluation.applies || ctx.board.arrivals.rows.length + ctx.board.departures.rows.length > 0;
  if (component === "lodging") return kindApplies(ctx, kind);
  return kindApplies(ctx, kind);
}
