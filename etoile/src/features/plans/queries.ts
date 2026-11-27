import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { notFound } from "next/navigation";
import { getDb, schema } from "@/db";
import type { Plan } from "@/db/schema";
import type { SessionUser } from "@/lib/auth";
import type { PlaceRef, PlanStatus, PlanTemplate, SiteStatus, WorkMode } from "@/lib/domain";
import { isId } from "@/lib/ids";
import type { PlanData } from "@/lib/plan-data";
import { PLAN_STATUS_ORDER, daysToGo, headcount, planStatus } from "./status";

type Owner = Pick<SessionUser, "id">;

/**
 * Everything that belongs to one plan, in ONE query, and only if `user` owns the plan.
 * Null when the plan does not exist or belongs to someone else (the two are the same answer).
 *
 * Ownership is part of the WHERE clause, so a plan id from the browser can never reach another
 * person's plan. Lists come back in a stable order: households and tasks by their sort order,
 * people by name, bookings and schedule items by time, expenses by date.
 */
export async function findPlanData(user: Owner, planId: string): Promise<PlanData | null> {
  if (!isId(planId)) return null;
  const db = await getDb();
  const row = await db.query.plans.findFirst({
    where: and(eq(schema.plans.id, planId), eq(schema.plans.ownerId, user.id)),
    with: {
      parties: { orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt), asc(t.id)] },
      people: { orderBy: (t, { asc }) => [asc(t.name), asc(t.id)] },
      arrivals: { orderBy: (t, { asc }) => [asc(t.createdAt), asc(t.id)] },
      bookings: { orderBy: (t, { asc, sql }) => [sql`${t.startsAt} asc nulls last`, asc(t.createdAt), asc(t.id)] },
      handoffs: { orderBy: (t, { asc }) => [asc(t.openedAt), asc(t.id)] },
      itineraryItems: {
        orderBy: (t, { asc, sql }) => [asc(t.localDate), sql`${t.startsAt} asc nulls first`, asc(t.createdAt), asc(t.id)],
      },
      tasks: { orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt), asc(t.id)] },
      expenses: { orderBy: (t, { asc }) => [asc(t.date), asc(t.createdAt), asc(t.id)] },
      settlements: { orderBy: (t, { asc }) => [asc(t.settledAt), asc(t.id)] },
      site: true,
    },
  });
  if (!row) return null;
  const { parties, people, arrivals, bookings, handoffs, itineraryItems, tasks, expenses, settlements, site, ...plan } = row;
  return { plan, parties, people, arrivals, bookings, handoffs, items: itineraryItems, tasks, expenses, settlements, site: site ?? null };
}

/**
 * The PlanData for a plan page or a plan action: one call checks ownership and loads the lot.
 *
 *   const user = await requireUser(`/plans/${planId}`);
 *   const data = await loadPlanData(user, planId);     // not theirs, or not there: not-found page
 *
 * Like requirePlan(), it ends in notFound() rather than returning null. Use findPlanData()
 * where null is the answer you want (a route handler, an export).
 */
export async function loadPlanData(user: Owner, planId: string): Promise<PlanData> {
  const data = await findPlanData(user, planId);
  if (!data) notFound();
  return data;
}

// --- the list -------------------------------------------------------------------------------------

export type PlanListItem = {
  id: string;
  title: string;
  template: PlanTemplate;
  workMode: WorkMode | null;
  /** The main place, or null while the person has not decided. */
  destination: PlaceRef | null;
  /** Local dates at the destination. Both null for a draft. */
  startDate: string | null;
  endDate: string | null;
  tz: string;
  /** Derived from the dates and `archivedAt` at `now`. */
  status: PlanStatus;
  /** Days until the first day at the plan's place: 23, 0 on the day, negative after. Null for a draft. */
  daysToGo: number | null;
  /** How many people the plan is for: the larger of the count given at creation and the people added. */
  people: number;
  /** People actually added so far. */
  peopleAdded: number;
  isExample: boolean;
  archivedAt: Date | null;
  /** The share page, for the "copy link" control. Null only for a plan made before pages existed. */
  site: { slug: string; status: SiteStatus } | null;
  updatedAt: Date;
};

/**
 * Every plan the user owns with what a list row needs, in one query. Ordered the way lists
 * show them: happening now, then coming up (soonest first), drafts (latest change first),
 * finished (latest first), archived.
 */
export async function listPlans(user: Owner, options: { now?: Date } = {}): Promise<PlanListItem[]> {
  const db = await getDb();
  const now = options.now ?? new Date();
  const rows = await db
    .select({
      plan: schema.plans,
      peopleAdded: sql<number>`(select count(*)::int from ${schema.people} where ${schema.people.planId} = ${schema.plans.id})`,
      siteSlug: schema.sites.slug,
      siteStatus: schema.sites.status,
    })
    .from(schema.plans)
    .leftJoin(schema.sites, eq(schema.sites.planId, schema.plans.id))
    .where(eq(schema.plans.ownerId, user.id));

  const items = rows.map(({ plan, peopleAdded, siteSlug, siteStatus }): PlanListItem => ({
    id: plan.id,
    title: plan.title,
    template: plan.template,
    workMode: plan.workMode,
    destination: plan.destination,
    startDate: plan.startDate,
    endDate: plan.endDate,
    tz: plan.tz,
    status: planStatus(plan, now),
    daysToGo: daysToGo(plan, now),
    people: headcount(plan, peopleAdded),
    peopleAdded,
    isExample: plan.isExample,
    archivedAt: plan.archivedAt,
    site: siteSlug && siteStatus ? { slug: siteSlug, status: siteStatus } : null,
    updatedAt: plan.updatedAt,
  }));

  return items.sort((a, b) => {
    const byStatus = PLAN_STATUS_ORDER[a.status] - PLAN_STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "in_progress" || a.status === "upcoming") {
      return (a.startDate ?? "").localeCompare(b.startDate ?? "") || a.title.localeCompare(b.title);
    }
    if (a.status === "past") return (b.endDate ?? b.startDate ?? "").localeCompare(a.endDate ?? a.startDate ?? "");
    return b.updatedAt.getTime() - a.updatedAt.getTime() || a.title.localeCompare(b.title);
  });
}

// --- search ---------------------------------------------------------------------------------------

export const FIND_MIN_LENGTH = 2;
const FIND_LIMIT = 30;

export type PlanSearchHit = {
  /** What matched: the plan itself, a person in it, or a booking's confirmation code. */
  type: "plan" | "person" | "booking";
  planId: string;
  planTitle: string;
  /** The id of the plan, person or booking that matched. */
  id: string;
  /** The matching name, or the booking's title. */
  label: string;
  /** For a person their household, for a booking its confirmation code, for a plan its place. */
  detail: string | null;
};

/** Escapes what a person typed for use inside LIKE: their % and _ are ordinary characters. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Searches the user's own plans: plan names and places, people's names (and their email
 * addresses), and confirmation codes. One query. Fewer than 2 characters finds nothing.
 * Confirmation codes match with or without the spaces and dashes people type in them.
 */
export async function findInPlans(user: Owner, text: string): Promise<PlanSearchHit[]> {
  const query = text.normalize("NFC").trim().replace(/\s+/g, " ").slice(0, 100);
  if (query.length < FIND_MIN_LENGTH) return [];
  const pattern = likePattern(query);
  const code = query.replace(/[\s-]/g, "");
  const codePattern = likePattern(code);
  const db = await getDb();

  const owned = eq(schema.plans.ownerId, user.id);
  const destinationName = sql<string | null>`${schema.plans.destination}->>'name'`;

  const planHits = db
    .select({
      type: sql<string>`'plan'`.as("type"),
      planId: schema.plans.id,
      planTitle: schema.plans.title,
      id: sql<string>`${schema.plans.id}`.as("hit_id"),
      label: sql<string>`${schema.plans.title}`.as("label"),
      detail: sql<string | null>`${destinationName}`.as("detail"),
    })
    .from(schema.plans)
    .where(and(owned, sql`(${schema.plans.title} ilike ${pattern} or ${destinationName} ilike ${pattern})`));

  const personHits = db
    .select({
      type: sql<string>`'person'`.as("type"),
      planId: schema.plans.id,
      planTitle: schema.plans.title,
      id: sql<string>`${schema.people.id}`.as("hit_id"),
      label: sql<string>`${schema.people.name}`.as("label"),
      detail: sql<string | null>`${schema.parties.name}`.as("detail"),
    })
    .from(schema.people)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.people.planId))
    .innerJoin(schema.parties, eq(schema.parties.id, schema.people.partyId))
    .where(and(owned, sql`(${schema.people.name} ilike ${pattern} or ${schema.people.email} ilike ${pattern})`));

  const bookingHits = db
    .select({
      type: sql<string>`'booking'`.as("type"),
      planId: schema.plans.id,
      planTitle: schema.plans.title,
      id: sql<string>`${schema.bookings.id}`.as("hit_id"),
      label: sql<string>`${schema.bookings.title}`.as("label"),
      detail: sql<string | null>`${schema.bookings.confirmationCode}`.as("detail"),
    })
    .from(schema.bookings)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.bookings.planId))
    .where(
      and(
        owned,
        // A code is at least 3 characters once the spaces and dashes are out.
        code.length >= 3
          ? sql`replace(replace(${schema.bookings.confirmationCode}, ' ', ''), '-', '') ilike ${codePattern}`
          : sql`false`,
      ),
    );

  const rows = await unionAll(planHits, personHits, bookingHits).limit(FIND_LIMIT * 3);

  const rank: Record<PlanSearchHit["type"], number> = { plan: 0, person: 1, booking: 2 };
  const lower = query.toLowerCase();
  const startsWith = (hit: PlanSearchHit) => (hit.label.toLowerCase().startsWith(lower) ? 0 : 1);
  return (rows as PlanSearchHit[])
    .sort(
      (a, b) =>
        rank[a.type] - rank[b.type] ||
        startsWith(a) - startsWith(b) ||
        a.label.localeCompare(b.label) ||
        a.planTitle.localeCompare(b.planTitle) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, FIND_LIMIT);
}

/** The user's example plan, if they still have it. */
export async function findExamplePlan(user: Owner): Promise<Plan | null> {
  const db = await getDb();
  const [plan] = await db
    .select()
    .from(schema.plans)
    .where(and(eq(schema.plans.ownerId, user.id), eq(schema.plans.isExample, true)))
    .orderBy(asc(schema.plans.createdAt))
    .limit(1);
  return plan ?? null;
}
