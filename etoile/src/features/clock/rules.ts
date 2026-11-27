// The rules of the world clock, as pure functions (no database, no clock of their own).
//
//  - Everyone has exactly one home clock. It cannot be removed; it follows the home place.
//  - A person adds and removes other clocks by hand ("manual").
//  - A plan with a destination the app could place on the map puts that destination's clock on
//    Home, tagged with the plan. It leaves a week after the plan ends, unless pinned.

import type { Clock, Plan } from "@/db/schema";
import type { PlaceRef } from "@/lib/domain";
import { addDays } from "@/lib/time/dates";

/** A plan's clock stays this many days after the plan's last day. */
export const PLAN_CLOCK_GRACE_DAYS = 7;

/** How many clocks a person can add by hand, besides home and the ones plans bring. */
export const MAX_MANUAL_CLOCKS = 12;

/**
 * `expiresOn` of a plan clock the person removed. The row is kept with this date (long past) so
 * that syncPlanClocks() knows not to bring the clock back while the plan is still on.
 */
export const CLOCK_DISMISSED_ON = "1970-01-01";

type PlanForClock = Pick<Plan, "destination" | "startDate" | "endDate" | "archivedAt">;

/** The local date a plan's clock leaves Home: its last day plus a week. Null while it has no dates. */
export function planClockExpiry(plan: Pick<Plan, "startDate" | "endDate">): string | null {
  const last = plan.endDate ?? plan.startDate;
  return last ? addDays(last, PLAN_CLOCK_GRACE_DAYS) : null;
}

/** A destination the place search matched has coordinates; one used as typed does not. */
export function isMatchedPlace(place: PlaceRef | null | undefined): place is PlaceRef & { lat: number; lon: number } {
  return Boolean(place && place.lat !== undefined && place.lon !== undefined);
}

/**
 * Whether a plan should have a clock on Home today: it is not archived, its destination is a
 * matched place, and it has not been over for more than a week. A plan without dates counts.
 */
export function planWantsClock(plan: PlanForClock, today: string): boolean {
  if (plan.archivedAt) return false;
  if (!isMatchedPlace(plan.destination)) return false;
  const expiry = planClockExpiry(plan);
  return expiry === null || today <= expiry;
}

export function isDismissed(clock: Pick<Clock, "source" | "expiresOn" | "pinned">): boolean {
  return clock.source === "plan" && !clock.pinned && clock.expiresOn === CLOCK_DISMISSED_ON;
}

/** Whether a clock shows on Home today. Home and hand-added clocks always do. */
export function isClockVisible(clock: Pick<Clock, "isHome" | "source" | "pinned" | "expiresOn">, today: string): boolean {
  if (clock.isHome || clock.source === "manual" || clock.pinned) return true;
  return clock.expiresOn === null || today <= clock.expiresOn;
}

/** Two clocks for one place are one too many: same zone and same name, whatever the capitals. */
export function isSameClockPlace(a: Pick<PlaceRef, "name" | "tz">, b: Pick<PlaceRef, "name" | "tz">): boolean {
  return a.tz === b.tz && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

/** The name a clock goes by: its label when it has one, otherwise its place. */
export function clockName(clock: Pick<Clock, "label" | "place">): string {
  return clock.label?.trim() || clock.place.name;
}
