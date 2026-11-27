import "server-only";

import { and, eq } from "drizzle-orm";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import type { Plan } from "@/db/schema";
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
