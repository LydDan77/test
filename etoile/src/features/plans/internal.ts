import "server-only";

// Shared by the plan actions and the example seed: the pieces of making a plan. Not actions
// (nothing here checks who is asking); the callers do that.

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import type { NewBooking, NewParty, NewPerson, NewSite, NewTask, Plan } from "@/db/schema";
import type { SessionUser } from "@/lib/auth";
import { emptyBookingDetails, placeRefSchema, type BookingKind, type PlaceRef } from "@/lib/domain";
import { newId } from "@/lib/ids";
import { findFreeSlug } from "@/lib/slugs";
import { defaultReplyDeadline, seededTasksFor, templateConfig } from "@/lib/templates";
import { addDays } from "@/lib/time";
import type { NamedPerson } from "./new-plan";

/** A transaction handle or the database itself: both run queries the same way. */
export type DbOrTx = Pick<Db, "select" | "insert" | "update" | "delete">;

// --- places from a form ---------------------------------------------------------------------------

/**
 * Reads a place a form sent: the JSON of a PlaceRef, as the place and airport typeaheads hand
 * it over. Null when the field is empty; "invalid" when it holds something else.
 */
export function readPlaceField(value: string): PlaceRef | null | "invalid" {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return "invalid";
  }
  const parsed = placeRefSchema.safeParse(raw);
  return parsed.success ? parsed.data : "invalid";
}

/**
 * A place used exactly as typed ("Grandma's lake house") because the search did not know it.
 * It has no coordinates, which is how the rest of the app knows it is unmatched: weather and
 * the clock wait until it is matched. Its zone is borrowed from where the plan sets out.
 */
export function typedPlace(name: string, tz: string): PlaceRef {
  return { kind: "venue", name: name.slice(0, 200), tz };
}

// --- the share page's address ---------------------------------------------------------------------

/** A free address for a share page, starting from the plan's name. */
export async function freeSiteSlug(db: DbOrTx, text: string): Promise<string> {
  return findFreeSlug(text, async (slug) => {
    const taken = await db.select({ id: schema.sites.id }).from(schema.sites).where(eq(schema.sites.slug, slug)).limit(1);
    return taken.length > 0;
  });
}

/**
 * Runs `work` with a free slug, and again with another one if somebody took that slug in the
 * meantime (the unique index on sites.slug has the last word). `work` should be one
 * transaction, so a lost race leaves nothing behind.
 */
export async function withFreeSlug<T>(db: DbOrTx, text: string, work: (slug: string) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    // After a lost race, a random tail makes the next try all but certain to be free.
    const slug = await freeSiteSlug(db, attempt === 0 ? text : `${text} ${newId().slice(0, 5)}`);
    try {
      return await work(slug);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// --- rows a new plan starts with ------------------------------------------------------------------

const NEEDED_TITLES: Record<BookingKind, (place: string | null) => string> = {
  flight: (place) => (place ? `Flights to ${place}` : "Flights"),
  lodging: (place) => (place ? `A place to stay in ${place}` : "A place to stay"),
  car: (place) => (place ? `A car in ${place}` : "A car"),
  ride: () => "Rides",
  meal: () => "Food",
  shipment: () => "Send ahead",
};

/**
 * The "Needs you" booking a plan starts with for one of its tools: no details yet, so the tool
 * works them out from the plan when the person opens it, and nothing here can go stale.
 */
export function neededBooking(plan: Pick<Plan, "id" | "destination">, kind: BookingKind): NewBooking {
  const destination = plan.destination;
  const place = destination ? (destination.kind === "airport" && destination.locality ? destination.locality : destination.name) : null;
  return {
    id: newId(),
    planId: plan.id,
    kind,
    status: "needed",
    title: NEEDED_TITLES[kind](place),
    details: emptyBookingDetails(kind),
  };
}

/** The tasks the plan's template seeds, as rows. */
export function seededTaskRows(plan: Pick<Plan, "id" | "template" | "workMode" | "startDate" | "endDate" | "destination" | "origin">): NewTask[] {
  return seededTasksFor(plan).map((task, index) => ({
    id: newId(),
    planId: plan.id,
    kind: "todo" as const,
    title: task.title,
    essential: task.essential,
    dueDate: task.dueDate,
    source: "template" as const,
    ruleKey: task.ruleKey,
    sortOrder: index,
  }));
}

/** The draft share page a plan starts with, from its template. */
export function draftSite(
  plan: Pick<Plan, "id" | "template" | "workMode" | "title" | "expectedPeople" | "startDate" | "endDate" | "destination" | "origin">,
  slug: string,
  hostName: string | null,
): NewSite {
  const { site, key } = templateConfig(plan);
  return {
    id: newId(),
    planId: plan.id,
    slug,
    status: "draft",
    access: site.access,
    theme: site.theme,
    accent: site.accent,
    title: plan.title,
    hostLine: hostName && (key === "family_event" || key === "work_event") ? `Hosted by ${hostName}` : null,
    repliesOpen: site.repliesOpen,
    replyDeadline: defaultReplyDeadline(plan),
    replyByParty: site.replyByParty,
    allowMaybe: site.allowMaybe,
    whoIsComing: site.whoIsComing,
    unpublishOn: defaultUnpublishOn(plan),
    sections: site.sections,
    rsvpQuestions: site.rsvpQuestions.map((question) => ({ ...question, id: newId() })),
  };
}

/** A page takes itself down 30 days after the plan ends (product spec 9.3). Null without dates. */
export function defaultUnpublishOn(plan: Pick<Plan, "startDate" | "endDate">): string | null {
  const last = plan.endDate ?? plan.startDate;
  return last ? addDays(last, 30) : null;
}

// --- people ---------------------------------------------------------------------------------------

const lastWord = (name: string) => name.trim().split(/\s+/).pop() ?? name;

/**
 * The households (or groups, or teams) and people a new plan starts with: the organizer, who is
 * coming, and everyone named in the flow. For a family get-together, people who share a last
 * name start in one household ("Hartley household"); otherwise everyone starts as a party of
 * one, named after them. The Who's coming tool regroups freely.
 */
export function startingPeople(
  plan: Pick<Plan, "id" | "template" | "origin">,
  organizer: Pick<SessionUser, "name" | "email">,
  named: NamedPerson[],
  now: Date,
): { parties: NewParty[]; people: NewPerson[] } {
  const parties: NewParty[] = [];
  const people: NewPerson[] = [];
  const byKey = new Map<string, NewParty>();
  const groupBySurname = plan.template === "family_event";

  const partyFor = (name: string, isOrganizer: boolean): NewParty => {
    const words = name.trim().split(/\s+/);
    const shared = groupBySurname && words.length >= 2;
    const key = shared ? `surname:${lastWord(name).toLowerCase()}` : `person:${name.toLowerCase()}`;
    let party = byKey.get(key);
    if (!party) {
      party = {
        id: newId(),
        planId: plan.id,
        name: shared ? `${lastWord(name)} household` : name,
        // The organizer's household sets out from where the plan does.
        origin: isOrganizer ? plan.origin : null,
        sortOrder: parties.length,
      };
      byKey.set(key, party);
      parties.push(party);
    }
    return party;
  };

  const organizerName = organizer.name.trim() || "Me";
  people.push({
    id: newId(),
    planId: plan.id,
    partyId: partyFor(organizerName, true).id!,
    name: organizerName,
    email: organizer.email,
    role: "organizer",
    canDrive: true,
    // The person making the plan is coming.
    rsvpStatus: "yes",
    rsvpAt: now,
    rsvpVia: "organizer",
  });

  for (const person of named) {
    // Typing your own name in the box does not make two of you.
    if (person.name.toLowerCase() === organizerName.toLowerCase()) continue;
    people.push({
      id: newId(),
      planId: plan.id,
      partyId: partyFor(person.name, false).id!,
      name: person.name,
      email: person.email,
      role: "guest",
    });
  }
  return { parties, people };
}
