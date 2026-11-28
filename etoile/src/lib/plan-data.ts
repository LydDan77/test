/**
 * Everything that belongs to one plan, loaded together.
 *
 * This is the one shape that pure plan logic takes as input (timeline, conflicts, arrivals,
 * "things left", money, heads-up). `loadPlanData(user, planId)` in `src/features/plans/queries.ts`
 * returns it (only for a plan that user owns); tests build it by hand. Keep it a plain bag of
 * database rows: no derived fields.
 *
 * It is the ORGANIZER's view: it holds guest tokens, the share page's passcode hash, emails,
 * phone numbers, private notes, confirmation codes and prices. A share page never holds a
 * PlanData: it holds `toPublicPlanData(data, viewer)` from `@/lib/guest`.
 *
 * The ids inside its jsonb fields (personIds, split parts, seats, attendeeIds …) are not
 * foreign keys and can name a person or booking that is gone. Every pure function that takes
 * a PlanData must skip an id it cannot find, never throw on it.
 */
import type {
  Arrival,
  Booking,
  Expense,
  Handoff,
  ItineraryItem,
  Party,
  Person,
  Plan,
  Settlement,
  Site,
  Task,
} from "@/db/schema";

export type PlanData = {
  plan: Plan;
  parties: Party[];
  people: Person[];
  arrivals: Arrival[];
  bookings: Booking[];
  handoffs: Handoff[];
  /** Hand-made schedule items only. Booked things are derived from `bookings`. */
  items: ItineraryItem[];
  tasks: Task[];
  expenses: Expense[];
  settlements: Settlement[];
  site: Site | null;
};
