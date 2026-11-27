/**
 * Everything that belongs to one plan, loaded together.
 *
 * This is the one shape that pure plan logic takes as input (timeline, conflicts, arrivals,
 * "things left", money, heads-up). `loadPlanData(planId)` in `src/features/plans/queries.ts`
 * returns it; tests build it by hand. Keep it a plain bag of database rows: no derived fields.
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
