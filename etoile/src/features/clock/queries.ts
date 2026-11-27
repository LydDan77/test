import "server-only";

import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth";
import type { ClockSource, PlaceRef } from "@/lib/domain";
import { localDateOf } from "@/lib/time";
import { clockName, isClockVisible } from "./rules";

export type ClockListItem = {
  id: string;
  /** Name, zone, and latitude and longitude for sunrise and sunset. */
  place: PlaceRef;
  /** What the person renamed it to, or null. */
  label: string | null;
  /** What to call it: the label when there is one, otherwise the place's name. */
  name: string;
  tz: string;
  isHome: boolean;
  source: ClockSource;
  /** The plan this clock came from, to show as a tag. Null for home and hand-added clocks. */
  plan: { id: string; title: string } | null;
  pinned: boolean;
  /** Local date a plan's clock leaves Home (the plan's last day plus a week), unless pinned. */
  expiresOn: string | null;
  sortOrder: number;
};

/**
 * The user's clocks as Home shows them: the home clock first, then the rest in the person's
 * order. Plan clocks that have run out (a week after the plan ended) or that the person removed
 * are left out. One query.
 *
 * Pass `now` from `await requestNow()` in a page; "today" is today at the user's home.
 */
export async function listClocks(
  user: Pick<SessionUser, "id" | "home">,
  options: { now?: Date } = {},
): Promise<ClockListItem[]> {
  const db = await getDb();
  const today = localDateOf(options.now ?? new Date(), user.home.tz);
  const rows = await db
    .select({ clock: schema.clocks, planTitle: schema.plans.title })
    .from(schema.clocks)
    .leftJoin(schema.plans, eq(schema.plans.id, schema.clocks.planId))
    .where(eq(schema.clocks.userId, user.id))
    .orderBy(asc(schema.clocks.sortOrder), asc(schema.clocks.createdAt), asc(schema.clocks.id));

  return rows
    .filter(({ clock }) => isClockVisible(clock, today))
    .map(({ clock, planTitle }): ClockListItem => ({
      id: clock.id,
      place: clock.place,
      label: clock.label,
      name: clockName(clock),
      tz: clock.place.tz,
      isHome: clock.isHome,
      source: clock.source,
      plan: clock.source === "plan" && clock.planId && planTitle !== null ? { id: clock.planId, title: planTitle } : null,
      pinned: clock.pinned,
      expiresOn: clock.expiresOn,
      sortOrder: clock.sortOrder,
    }))
    // Home leads, whatever its number; the sort is stable, so the rest keep the query's order.
    .sort((a, b) => Number(b.isHome) - Number(a.isHome));
}
