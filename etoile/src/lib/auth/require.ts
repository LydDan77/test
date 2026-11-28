import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import type { Booking, Party, Person, Plan } from "@/db/schema";
import { isId } from "@/lib/ids";
import { getUser, type SessionUser } from "./session";

/**
 * For pages and actions that need a signed-in user. Sends everyone else to /sign-in.
 * redirect() throws, so this never returns null.
 *
 * Pass the path the person was on as `next` to bring them back after signing in:
 *   const user = await requireUser(`/plans/${planId}`);
 */
export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getUser();
  if (!user) {
    const target = next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in";
    redirect(target as Route);
  }
  return user;
}

/**
 * The plan with this id if, and only if, `userId` owns it. Otherwise null.
 * Ownership is part of the WHERE clause, so a plan id from the client can never reach
 * someone else's plan.
 */
export async function findOwnedPlan(userId: string, planId: string): Promise<Plan | null> {
  if (!isId(planId)) return null;
  const db = await getDb();
  const [plan] = await db
    .select()
    .from(schema.plans)
    .where(and(eq(schema.plans.id, planId), eq(schema.plans.ownerId, userId)))
    .limit(1);
  return plan ?? null;
}

/**
 * Loads a plan only if the user owns it. The second line of every plan page and plan action:
 *
 *   const user = await requireUser();
 *   const plan = await requirePlan(user, planId);
 *
 * A plan that does not exist and a plan that belongs to someone else are the same answer:
 * notFound(), which renders the not-found page (it throws, so this never returns null).
 */
export async function requirePlan(user: Pick<SessionUser, "id">, planId: string): Promise<Plan> {
  const plan = await findOwnedPlan(user.id, planId);
  if (!plan) notFound();
  return plan;
}

// --- ids inside a plan ------------------------------------------------------------------------------
//
// requirePlan() answers "is this plan theirs". These answer the next question, for every other
// id a browser sends: "is this party / person / booking part of THAT plan". An id is not a
// secret and proves nothing: without this check, an action that takes a partyId could attach a
// row to a household in someone else's plan.
//
// The database backs this up for the parent/child tree (a person's or an arrival's party, a
// hand-off's booking and a settlement's people must be in the same plan, or the write fails).
// It cannot for the single-column links between siblings (lodgingBookingId, driverPersonId,
// assigneePersonId, paidByPersonId …) or for ids inside jsonb (personIds, split parts, seats):
// those are only ever as good as the check made before writing them.

/** The party with this id if it belongs to `planId`, otherwise null. */
export async function findPartyInPlan(planId: string, partyId: unknown): Promise<Party | null> {
  if (!isId(partyId)) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.parties)
    .where(and(eq(schema.parties.id, partyId), eq(schema.parties.planId, planId)))
    .limit(1);
  return row ?? null;
}

/** The person with this id if they belong to `planId`, otherwise null. */
export async function findPersonInPlan(planId: string, personId: unknown): Promise<Person | null> {
  if (!isId(personId)) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.id, personId), eq(schema.people.planId, planId)))
    .limit(1);
  return row ?? null;
}

/** The booking with this id if it belongs to `planId`, otherwise null. */
export async function findBookingInPlan(planId: string, bookingId: unknown): Promise<Booking | null> {
  if (!isId(bookingId)) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.planId, planId)))
    .limit(1);
  return row ?? null;
}

/**
 * Of `personIds`, those that are people of `planId` (in the order given, each once). Use it for
 * a list that goes into jsonb, where the database cannot check anything:
 *
 *   const personIds = await peopleInPlan(plan.id, sent);
 *   if (personIds.length !== sent.length) return fail("One of those people is no longer part of this plan.");
 */
export async function peopleInPlan(planId: string, personIds: readonly unknown[]): Promise<string[]> {
  const wanted = [...new Set(personIds.filter(isId))];
  if (wanted.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(and(eq(schema.people.planId, planId), inArray(schema.people.id, wanted)));
  const found = new Set(rows.map((row) => row.id));
  return wanted.filter((id) => found.has(id));
}

/**
 * The third line of an action that takes a party from the browser:
 *
 *   const user = await requireUser();
 *   const plan = await requirePlan(user, planId);
 *   const party = await requireParty(plan, partyId);
 *
 * A party that does not exist and one that belongs to another plan are the same answer:
 * notFound(). When the person can cause it innocently (the household was removed in another
 * tab), use findPartyInPlan() and return fail("That household is no longer part of this plan.").
 */
export async function requireParty(plan: Pick<Plan, "id">, partyId: unknown): Promise<Party> {
  const party = await findPartyInPlan(plan.id, partyId);
  if (!party) notFound();
  return party;
}

/** The person if they are part of the plan, or the not-found page. See requireParty. */
export async function requirePerson(plan: Pick<Plan, "id">, personId: unknown): Promise<Person> {
  const person = await findPersonInPlan(plan.id, personId);
  if (!person) notFound();
  return person;
}

/** The booking if it is part of the plan, or the not-found page. See requireParty. */
export async function requireBooking(plan: Pick<Plan, "id">, bookingId: unknown): Promise<Booking> {
  const booking = await findBookingInPlan(plan.id, bookingId);
  if (!booking) notFound();
  return booking;
}
