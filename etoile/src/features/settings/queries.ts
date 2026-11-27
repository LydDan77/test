import "server-only";

import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BRAND } from "@/lib/brand";

// "Export everything as a file": all of one person's data, as plain JSON.

export const EXPORT_FORMAT = `${BRAND.ascii}-export`;
export const EXPORT_VERSION = 1;

export type UserDataExport = {
  format: string;
  version: number;
  /** ISO instant the export was made. */
  exportedAt: string;
  account: Record<string, unknown>;
  clocks: Record<string, unknown>[];
  plans: {
    plan: Record<string, unknown>;
    households: Record<string, unknown>[];
    people: Record<string, unknown>[];
    arrivals: Record<string, unknown>[];
    bookings: Record<string, unknown>[];
    handoffs: Record<string, unknown>[];
    schedule: Record<string, unknown>[];
    tasks: Record<string, unknown>[];
    expenses: Record<string, unknown>[];
    settlements: Record<string, unknown>[];
    sharePage: Record<string, unknown> | null;
  }[];
  /** What the person did with heads-up items (done, dismissed). */
  headsUp: Record<string, unknown>[];
};

/** A row without the columns that work as keys: they open things, they are not the person's data. */
function without<T extends Record<string, unknown>>(row: T, ...secrets: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  for (const name of secrets) delete copy[name];
  return copy;
}

/**
 * Everything the app holds for one account: the account itself, its clocks, every plan with its
 * households, people, replies, arrivals, bookings (confirmation codes and prices included: they
 * are the person's own), schedule, tasks, money and share page, and what was done with heads-up
 * items. Null when the account does not exist.
 *
 * Left out on purpose, because a file that gets passed around should not open anything: the
 * password hash, sign-in sessions, guests' personal-link tokens and the share page's passcode
 * hash. Shared caches (weather and the like) are not personal data and are not included.
 */
export async function exportUserData(userId: string, now?: Date): Promise<UserDataExport | null> {
  const db = await getDb();
  const exportedAt = now ?? new Date();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return null;

  const [clocks, plans, headsUp] = await Promise.all([
    db.select().from(schema.clocks).where(eq(schema.clocks.userId, userId)).orderBy(asc(schema.clocks.sortOrder), asc(schema.clocks.createdAt)),
    db.query.plans.findMany({
      where: eq(schema.plans.ownerId, userId),
      orderBy: (t, { asc: up }) => [up(t.createdAt), up(t.id)],
      with: {
        parties: { orderBy: (t, { asc: up }) => [up(t.sortOrder), up(t.createdAt), up(t.id)] },
        people: { orderBy: (t, { asc: up }) => [up(t.name), up(t.id)] },
        arrivals: { orderBy: (t, { asc: up }) => [up(t.createdAt), up(t.id)] },
        bookings: { orderBy: (t, { asc: up }) => [up(t.createdAt), up(t.id)] },
        handoffs: { orderBy: (t, { asc: up }) => [up(t.openedAt), up(t.id)] },
        itineraryItems: { orderBy: (t, { asc: up }) => [up(t.localDate), up(t.createdAt), up(t.id)] },
        tasks: { orderBy: (t, { asc: up }) => [up(t.sortOrder), up(t.createdAt), up(t.id)] },
        expenses: { orderBy: (t, { asc: up }) => [up(t.date), up(t.createdAt), up(t.id)] },
        settlements: { orderBy: (t, { asc: up }) => [up(t.settledAt), up(t.id)] },
        site: true,
      },
    }),
    db.select().from(schema.briefingStates).where(eq(schema.briefingStates.userId, userId)).orderBy(asc(schema.briefingStates.createdAt)),
  ]);

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    account: without(user, "passwordHash"),
    clocks,
    plans: plans.map(({ parties, people, arrivals, bookings, handoffs, itineraryItems, tasks, expenses, settlements, site, ...plan }) => ({
      plan,
      households: parties.map((party) => without(party, "guestToken")),
      people: people.map((person) => without(person, "guestToken")),
      arrivals,
      bookings,
      handoffs,
      schedule: itineraryItems,
      tasks,
      expenses,
      settlements,
      sharePage: site ? without(site, "passcodeHash") : null,
    })),
    headsUp,
  };
}
