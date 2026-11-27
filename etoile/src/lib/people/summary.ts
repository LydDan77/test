// Who's coming, and what they need: counts by reply and by household, and the dietary and
// access-needs roll-up that food planning uses. Pure.

import type { Party, Person } from "@/db/schema";
import type { DietaryTag, RsvpStatus } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import type { InstantInput } from "@/lib/time";
import { resolveArrivals } from "./arrivals";
import { hasReplied, isExpected } from "./shared";
import { count, firstNames, listOf } from "./text";

/**
 * What this plan calls its people, from the template (product spec 3.2): guests and households
 * for a family event, travelers and groups for a trip, attendees and teams for a work event.
 * Lower case; the code capitalises where a sentence starts with one.
 */
export type PeopleWords = {
  person: string;
  people: string;
  party: string;
  parties: string;
};

/** Used when no template words are passed. */
export const DEFAULT_PEOPLE_WORDS: PeopleWords = { person: "person", people: "people", party: "household", parties: "households" };

const DOT = " · ";

export type ReplyCounts = {
  /** Everyone on the list. */
  total: number;
  /** Said yes. */
  coming: number;
  notComing: number;
  maybe: number;
  /** Asked, or added and not asked yet: no answer either way. */
  noReply: number;
  /** Of those, the ones who have not been asked yet. */
  notInvited: number;
  /** Answered yes, no or maybe. */
  replied: number;
  /** Everyone who has not said no: the number to plan beds, seats and food for. */
  expected: number;
};

export type HouseholdSummary = ReplyCounts & {
  partyId: string;
  name: string;
  /** Where they come from, when known. */
  from: string | null;
  /** "4 of 4 coming", "2 coming, 1 no reply", "Not coming", "No reply yet". */
  line: string;
  people: { personId: string; name: string; reply: RsvpStatus; isChild: boolean }[];
};

export type WhosComing = ReplyCounts & {
  /** Among everyone expected. */
  adults: number;
  children: number;
  infants: number;
  /** People arriving who asked for a ride and have none. */
  needRide: number;
  households: HouseholdSummary[];
  /** People whose reply the host still has to confirm (a name typed on the public form that matched nobody). */
  toConfirm: { personId: string; name: string }[];
  /** "9 guests · 7 coming · 2 no reply · 3 need a ride". Parts with nothing to say are left out. */
  line: string;
};

function tally(people: readonly Person[]): ReplyCounts {
  const result: ReplyCounts = { total: people.length, coming: 0, notComing: 0, maybe: 0, noReply: 0, notInvited: 0, replied: 0, expected: 0 };
  for (const person of people) {
    if (person.rsvpStatus === "yes") result.coming += 1;
    else if (person.rsvpStatus === "no") result.notComing += 1;
    else if (person.rsvpStatus === "maybe") result.maybe += 1;
    else result.noReply += 1;
    if (person.rsvpStatus === "not_invited") result.notInvited += 1;
    if (hasReplied(person)) result.replied += 1;
    if (isExpected(person)) result.expected += 1;
  }
  return result;
}

function householdLine(c: ReplyCounts): string {
  if (c.total === 0) return "Nobody added yet";
  if (c.coming === c.total) return c.total === 1 ? "Coming" : `${c.coming} of ${c.total} coming`;
  if (c.notComing === c.total) return "Not coming";
  if (c.noReply === c.total) return "No reply yet";
  const parts: string[] = [];
  if (c.coming) parts.push(`${c.coming} coming`);
  if (c.maybe) parts.push(`${c.maybe} maybe`);
  if (c.notComing) parts.push(`${c.notComing} not coming`);
  if (c.noReply) parts.push(`${c.noReply} no reply`);
  return parts.join(", ");
}

/**
 * Counts by reply and by household.
 *
 *   whosComing(planData, now, words).line   // "9 guests · 7 coming · 2 no reply · 3 need a ride"
 *
 * `now` is only passed on to the arrivals board, which supplies the "need a ride" count.
 */
export function whosComing(
  input: Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings">,
  now: InstantInput,
  words: PeopleWords = DEFAULT_PEOPLE_WORDS,
): WhosComing {
  const totals = tally(input.people);
  const expected = input.people.filter(isExpected);
  const parties: Party[] = [...input.parties].sort((a, b) => a.sortOrder - b.sortOrder);
  const households: HouseholdSummary[] = parties.map((party) => {
    const members = input.people.filter((person) => person.partyId === party.id);
    const c = tally(members);
    return {
      ...c,
      partyId: party.id,
      name: party.name,
      from: party.origin?.name ?? null,
      line: householdLine(c),
      people: members.map((person) => ({
        personId: person.id,
        name: person.name,
        reply: person.rsvpStatus,
        isChild: person.ageGroup !== "adult",
      })),
    };
  });

  const needRide = resolveArrivals(input, now).arrivals.counts.needRide;
  const parts = [count(totals.total, words.person, words.people)];
  if (totals.total > 0) {
    parts.push(`${totals.coming} coming`);
    if (totals.maybe) parts.push(`${totals.maybe} maybe`);
    if (totals.notComing) parts.push(`${totals.notComing} not coming`);
    if (totals.noReply) parts.push(`${totals.noReply} no reply`);
    if (needRide) parts.push(`${needRide} ${needRide === 1 ? "needs" : "need"} a ride`);
  }

  return {
    ...totals,
    adults: expected.filter((person) => person.ageGroup === "adult").length,
    children: expected.filter((person) => person.ageGroup === "child").length,
    infants: expected.filter((person) => person.ageGroup === "infant").length,
    needRide,
    households,
    toConfirm: input.people.filter((person) => person.needsHostConfirmation).map((person) => ({ personId: person.id, name: person.name })),
    line: parts.join(DOT),
  };
}

// --- dietary and access needs ---------------------------------------------------------------------

const DIETARY_WORDS: Record<DietaryTag, string> = {
  vegetarian: "vegetarian",
  vegan: "vegan",
  gluten_free: "gluten-free",
  nut_allergy: "nut allergy",
  shellfish_allergy: "shellfish allergy",
  kosher: "kosher",
  halal: "halal",
  other: "other needs",
};

/** Allergies first (they matter most when ordering), then the rest in a fixed order. */
const DIETARY_ORDER: DietaryTag[] = ["nut_allergy", "shellfish_allergy", "gluten_free", "vegetarian", "vegan", "kosher", "halal", "other"];

/** The words for one dietary tag: "gluten-free", "nut allergy". */
export function dietaryWord(tag: DietaryTag): string {
  return DIETARY_WORDS[tag];
}

export type DietaryRollup = {
  /** Everyone to feed: people who have not said no. */
  headcount: number;
  adults: number;
  children: number;
  infants: number;
  /** One entry per need that anyone has, allergies first. */
  tags: { tag: DietaryTag; label: string; count: number; personIds: string[]; names: string[] }[];
  /** What people wrote in their own words. */
  dietaryNotes: { personId: string; name: string; note: string }[];
  accessNotes: { personId: string; name: string; note: string }[];
  /** People with no dietary need on record. */
  noNeeds: number;
  /** "1 nut allergy, 2 vegetarian". Empty when nobody has a need. The form a meal's dietary summary takes. */
  summary: string;
  /** "9 people: 1 nut allergy, 2 vegetarian." or "9 people, no dietary needs on record." */
  sentence: string;
};

/**
 * Everyone's dietary and access needs, rolled up for ordering food.
 *
 * Pass `personIds` to roll up only the people a meal is for; left out, it is everyone expected.
 */
export function dietaryRollup(input: Pick<PlanData, "people">, personIds?: readonly string[]): DietaryRollup {
  const only = personIds ? new Set(personIds) : null;
  const eaters = input.people.filter((person) => isExpected(person) && (!only || only.has(person.id)));

  const tags = DIETARY_ORDER.map((tag) => {
    const who = eaters.filter((person) => person.dietaryTags.includes(tag));
    return { tag, label: DIETARY_WORDS[tag], count: who.length, personIds: who.map((p) => p.id), names: firstNames(who) };
  }).filter((entry) => entry.count > 0);

  const notes = (pick: (person: Person) => string | null) =>
    eaters
      .map((person) => ({ personId: person.id, name: person.name, note: (pick(person) ?? "").trim() }))
      .filter((entry) => entry.note.length > 0);

  const summary = tags.map((entry) => `${entry.count} ${entry.label}`).join(", ");
  const people = count(eaters.length, "person", "people");
  return {
    headcount: eaters.length,
    adults: eaters.filter((person) => person.ageGroup === "adult").length,
    children: eaters.filter((person) => person.ageGroup === "child").length,
    infants: eaters.filter((person) => person.ageGroup === "infant").length,
    tags,
    dietaryNotes: notes((person) => person.dietaryNote),
    accessNotes: notes((person) => person.accessNote),
    noNeeds: eaters.filter((person) => person.dietaryTags.length === 0 && !person.dietaryNote?.trim()).length,
    summary,
    sentence: summary ? `${people}: ${summary}.` : `${people}, no dietary needs on record.`,
  };
}

/** "Dana and Chris": the first names behind a list of ids, in the order given. */
export function namesOf(personIds: readonly string[], people: readonly Pick<Person, "id" | "name">[]): string {
  const byId = new Map(people.map((person) => [person.id, person]));
  return listOf(firstNames(personIds.map((id) => byId.get(id)).filter((p): p is Pick<Person, "id" | "name"> => p !== undefined)));
}
