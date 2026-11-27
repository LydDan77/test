import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { syncPlanClocks } from "@/features/clock/sync";
import type { SessionUser } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { EXAMPLE_SLUG, buildExamplePlan } from "./example-plan";
import type { DbOrTx } from "./internal";

// The example plan a new account starts with. Sign-up calls seedExamplePlan(user) right after
// the account and its home clock exist, and carries on if it throws.
//
// What it writes is in example-plan.ts: "Hartley Family Christmas", 23 days out, in exactly the
// state product spec 11.5 describes (68 points out of 100).

export type SeedResult = {
  /** The example plan's id, or null when the person removed the example and it was left removed. */
  planId: string | null;
  /** False when the plan was already there (or was left removed). */
  created: boolean;
};

export type SeedOptions = {
  /** When the account was made. Defaults to now. */
  now?: Date;
  /** Bring the example back for someone who removed it (the "show me the example" link). */
  restore?: boolean;
};

async function slugTaken(db: DbOrTx, slug: string): Promise<boolean> {
  const rows = await db.select({ id: schema.sites.id }).from(schema.sites).where(eq(schema.sites.slug, slug)).limit(1);
  return rows.length > 0;
}

/** The first account gets etoile.app/hartley-christmas; everyone after gets it with a short tail. */
async function exampleSlug(db: DbOrTx, forceTail: boolean): Promise<string> {
  if (!forceTail && !(await slugTaken(db, EXAMPLE_SLUG))) return EXAMPLE_SLUG;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${EXAMPLE_SLUG}-${newId().slice(0, 6)}`;
    if (!(await slugTaken(db, candidate))) return candidate;
  }
  throw new Error("Could not find a free address for the example page");
}

/**
 * Creates the example plan for an account, once.
 *
 *  - Seeding again does nothing: an account never has two examples.
 *  - Someone who removed the example does not get it back, unless `restore` is set.
 *  - All of it is written in one transaction, so a failure leaves nothing half-made.
 *
 * Its dates hang off `now`: the plan starts 23 days after today at its own place (Orlando).
 */
export async function seedExamplePlan(user: Pick<SessionUser, "id" | "home">, options: SeedOptions = {}): Promise<SeedResult> {
  const db = await getDb();
  const now = options.now ?? new Date();

  let result: SeedResult | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4 && !result; attempt++) {
    const slug = await exampleSlug(db, attempt > 0);
    try {
      result = await db.transaction(async (tx): Promise<SeedResult> => {
        // Lock the account row, so two sign-up requests arriving together cannot both seed.
        const [account] = await tx
          .select({ exampleState: schema.users.exampleState })
          .from(schema.users)
          .where(eq(schema.users.id, user.id))
          .for("update");
        if (!account) return { planId: null, created: false };

        const [existing] = await tx
          .select({ id: schema.plans.id })
          .from(schema.plans)
          .where(and(eq(schema.plans.ownerId, user.id), eq(schema.plans.isExample, true)))
          .limit(1);
        if (existing) return { planId: existing.id, created: false };
        if (account.exampleState === "removed" && !options.restore) return { planId: null, created: false };

        const rows = buildExamplePlan({ ownerId: user.id, slug, now });
        await tx.insert(schema.plans).values(rows.plan);
        await tx.insert(schema.parties).values(rows.parties);
        await tx.insert(schema.people).values(rows.people);
        await tx.insert(schema.bookings).values(rows.bookings);
        for (const { personId, lodgingBookingId, room } of rows.rooms) {
          await tx.update(schema.people).set({ lodgingBookingId, room }).where(eq(schema.people.id, personId));
        }
        await tx.insert(schema.arrivals).values(rows.arrivals);
        await tx.insert(schema.itineraryItems).values(rows.items);
        await tx.insert(schema.tasks).values(rows.tasks);
        await tx.insert(schema.expenses).values(rows.expenses);
        for (const { bookingId, expenseId } of rows.bookingExpenses) {
          await tx.update(schema.bookings).set({ expenseId }).where(eq(schema.bookings.id, bookingId));
        }
        await tx.insert(schema.sites).values(rows.site);
        if (account.exampleState !== "seeded") {
          await tx.update(schema.users).set({ exampleState: "seeded" }).where(eq(schema.users.id, user.id));
        }
        return { planId: rows.plan.id, created: true };
      });
    } catch (error) {
      // Somebody took the address between the check and the insert: try another.
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  if (!result) throw lastError;

  // The destination's clock goes on Home, tagged with the plan.
  if (result.created) await syncPlanClocks(user, { now });
  return result;
}
