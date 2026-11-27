import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { localDateOf } from "@/lib/time";
import { isClockVisible, isDismissed, isSameClockPlace, planClockExpiry, planWantsClock } from "./rules";

export type ClockSyncResult = { added: number; updated: number; removed: number };

/**
 * Makes the user's plan clocks match their plans. Call it after anything that changes a plan's
 * place, dates or archived state (the plan actions and the example seed already do).
 *
 *  - A plan that should have a clock (see planWantsClock) and has none gets one, tagged with
 *    the plan, unless a clock for that same place is already showing.
 *  - A plan's clock follows the plan: a new destination or new dates update it.
 *  - A clock whose plan no longer wants one (archived, over for more than a week, destination
 *    gone, or the destination is now the person's home) is removed, unless the person pinned it.
 *  - A clock the person removed stays removed while the plan lasts.
 *
 * "Today" is today at the user's home, where Home is read. Safe to call any number of times.
 */
export async function syncPlanClocks(
  user: Pick<SessionUser, "id" | "home">,
  options: { now?: Date } = {},
): Promise<ClockSyncResult> {
  const db = await getDb();
  const today = localDateOf(options.now ?? new Date(), user.home.tz);

  const plans = await db
    .select({
      id: schema.plans.id,
      destination: schema.plans.destination,
      startDate: schema.plans.startDate,
      endDate: schema.plans.endDate,
      archivedAt: schema.plans.archivedAt,
    })
    .from(schema.plans)
    .where(eq(schema.plans.ownerId, user.id))
    .orderBy(schema.plans.startDate, schema.plans.createdAt);
  const clocks = await db.select().from(schema.clocks).where(eq(schema.clocks.userId, user.id));

  const result: ClockSyncResult = { added: 0, updated: 0, removed: 0 };
  const byPlan = new Map(clocks.filter((clock) => clock.source === "plan" && clock.planId).map((clock) => [clock.planId!, clock]));
  const wanted = new Map(plans.map((plan) => [plan.id, planWantsClock(plan, today)]));

  // 1. Clocks whose plan no longer wants one go first, so that another plan for the same place
  //    can take over in this same pass.
  const toRemove = new Set<string>();
  const homeClock = clocks.find((clock) => clock.isHome);
  for (const plan of plans) {
    const clock = byPlan.get(plan.id);
    if (!clock || clock.pinned) continue;
    // Also when home has moved to the plan's place: the home clock already says it.
    const atHome = homeClock !== undefined && plan.destination !== null && isSameClockPlace(homeClock.place, plan.destination);
    if (!wanted.get(plan.id) || atHome) toRemove.add(clock.id);
  }
  if (toRemove.size > 0) {
    await db.delete(schema.clocks).where(and(eq(schema.clocks.userId, user.id), inArray(schema.clocks.id, [...toRemove])));
    result.removed = toRemove.size;
  }

  // Places on show, so two plans for Orlando (or a plan at home) do not double a clock.
  const showing = new Map(
    clocks.filter((clock) => !toRemove.has(clock.id) && isClockVisible(clock, today)).map((clock) => [clock.id, clock.place]),
  );

  // 2. Clocks that stay follow their plan: a new destination or new dates.
  for (const plan of plans) {
    const clock = byPlan.get(plan.id);
    if (!clock || toRemove.has(clock.id) || !wanted.get(plan.id) || !plan.destination || isDismissed(clock)) continue;
    const expiresOn = planClockExpiry(plan);
    const placeChanged = JSON.stringify(clock.place) !== JSON.stringify(plan.destination);
    if (!placeChanged && clock.expiresOn === expiresOn) continue;
    await db
      .update(schema.clocks)
      // A label was written for the old place; it does not carry over to a new one.
      .set({ place: plan.destination, expiresOn, ...(placeChanged ? { label: null } : {}) })
      .where(and(eq(schema.clocks.id, clock.id), eq(schema.clocks.userId, user.id)));
    showing.set(clock.id, plan.destination);
    result.updated++;
  }

  // 3. Plans that want a clock and have none get one, soonest plan first.
  let nextSort = clocks.reduce((max, clock) => Math.max(max, clock.sortOrder), 0) + 1;
  for (const plan of plans) {
    const destination = plan.destination;
    if (byPlan.has(plan.id) || !wanted.get(plan.id) || !destination) continue;
    if ([...showing.values()].some((place) => isSameClockPlace(place, destination))) continue;
    const id = newId();
    await db.insert(schema.clocks).values({
      id,
      userId: user.id,
      place: destination,
      source: "plan",
      planId: plan.id,
      expiresOn: planClockExpiry(plan),
      sortOrder: nextSort++,
    });
    showing.set(id, destination);
    result.added++;
  }
  return result;
}
