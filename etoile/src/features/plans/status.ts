// What a plan's dates say about it. Pure: no database, no clock of its own (pass `now`).
// Safe to import anywhere, client components included.

import type { Plan } from "@/db/schema";
import type { PlanStatus } from "@/lib/domain";
import { diffDays, localDateOf, type InstantInput } from "@/lib/time";

type Dated = Pick<Plan, "startDate" | "endDate" | "archivedAt" | "tz">;

/**
 * A plan's status, which is never stored:
 *  - "archived"     put away by the person, whatever its dates;
 *  - "draft"        no dates yet;
 *  - "upcoming"     the first day is still ahead;
 *  - "in_progress"  today is one of its days;
 *  - "past"         the last day is behind.
 * "Today" is today at the plan's place (plan.tz), so a plan in Tokyo starts when it is that
 * morning in Tokyo.
 */
export function planStatus(plan: Dated, now: InstantInput): PlanStatus {
  if (plan.archivedAt) return "archived";
  if (!plan.startDate) return "draft";
  const today = localDateOf(now, plan.tz);
  if (today < plan.startDate) return "upcoming";
  return today <= (plan.endDate ?? plan.startDate) ? "in_progress" : "past";
}

/**
 * Whole days from today, at the plan's place, until its first day: 23 for "23 days to go",
 * 0 on the day, negative once it has begun. Null for a plan without dates.
 */
export function daysToGo(plan: Pick<Plan, "startDate" | "tz">, now: InstantInput): number | null {
  return plan.startDate ? diffDays(localDateOf(now, plan.tz), plan.startDate) : null;
}

/**
 * How many people a plan is for. The new-plan flow asks for a count before any names, so until
 * more people have been added than that, the count the person gave is the better number.
 */
export function headcount(plan: Pick<Plan, "expectedPeople">, peopleAdded: number): number {
  return Math.max(plan.expectedPeople, peopleAdded);
}

/** Lists show plans in this order: happening now, coming up, drafts, finished, put away. */
export const PLAN_STATUS_ORDER: Record<PlanStatus, number> = {
  in_progress: 0,
  upcoming: 1,
  draft: 2,
  past: 3,
  archived: 4,
};

/** What each status is called on a plan row. */
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Draft",
  upcoming: "Coming up",
  in_progress: "Happening now",
  past: "Finished",
  archived: "Archived",
};
