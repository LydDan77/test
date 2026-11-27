// The shapes of "things left" (product spec section 11, BUILD-SPEC section 3).
//
// People never see a "readiness score" as a headline. They see "3 things left", each a plain
// sentence with its own button. The percentage exists to drive a quiet progress ring and to
// order the list.

import type { ActBy, BookingKind } from "@/lib/domain";
import type { PeopleWords } from "@/lib/people/summary";
import type { LocalDate } from "@/lib/time";

/** The ten things that count, in their fixed order (product spec 11.2). Internal names; never shown. */
export const READINESS_COMPONENTS = [
  "gettingThere",
  "lodging",
  "car",
  "rides",
  "meals",
  "shipAhead",
  "people",
  "schedule",
  "site",
  "tasks",
] as const;
export type ReadinessComponent = (typeof READINESS_COMPONENTS)[number];

/** Points per component for one template. They need not add up to 100: whatever applies is scaled to 100. */
export type ReadinessWeights = Record<ReadinessComponent, number>;

/**
 * What computeReadiness() needs from the plan's template. `templateConfig(plan)` supplies it;
 * this file only names the part that is used, so the two do not depend on each other.
 */
export type ReadinessConfig = {
  /**
   * The template's weights (product spec 11.2). For a family event:
   * `{ gettingThere: 15, lodging: 15, car: 10, rides: 5, meals: 10, shipAhead: 5, people: 15, schedule: 10, site: 5, tasks: 10 }`.
   * A weight of 0 leaves that component out.
   */
  weights: ReadinessWeights;
  /**
   * What the template calls people and households, lower case ("guests", "households"), and its
   * name for the schedule ("Schedule", "Agenda"). Anything left out falls back to plain words.
   */
  words?: Partial<PeopleWords> & { timeline?: string };
  /**
   * The act-by dates for each booking kind on this plan, from `actByFor(kind, plan)`. Used when
   * a kind has no booking yet (a booking's own dates win once it exists). Left out, a kind
   * with no booking has no deadline, so it cannot make the plan "needs attention".
   */
  actBy?: Partial<Record<BookingKind, ActBy>>;
  /** True when the plan's dates touch a holiday period. Adds the reason to a deadline: "Holiday rentals sell out." */
  holidayPeriod?: boolean;
};

/** The ten tools of a plan, named as their addresses are: `/plans/[planId]/<tool>`. */
export const TOOLS = ["flights", "stay", "car", "rides", "food", "send-ahead", "people", "schedule", "money", "page"] as const;
export type ToolKey = (typeof TOOLS)[number];

/** Where a button goes: one of the plan's tools, or the plan's own hub (for to-dos). */
export type ThingTarget = {
  tool: ToolKey | "hub";
  /** The address of that screen: "/plans/<planId>/car". */
  href: string;
  /** The booking, to-do or schedule item the button is about, when it is about one. */
  bookingId?: string;
  taskId?: string;
  itemId?: string;
};

/** How pressing a date is: 1 nothing pressing, 1.5 within a week of "best done by", 2 past it, 3 at or past the last day. */
export type Urgency = 1 | 1.5 | 2 | 3;

/** One incomplete thing, in plain words. */
export type ThingLeft = {
  /** Stable between reads: "car:<bookingId>", "people:replies", "task:<id>". */
  key: string;
  /** Which tool it belongs to; "task" for a to-do. */
  kind: ToolKey | "task";
  component: ReadinessComponent;
  /** "Find the minivan." */
  sentence: string;
  /** "Book by Dec 5. Holiday rentals sell out." Null when there is nothing to add. */
  detail: string | null;
  /** The words on its button: "Find a minivan". */
  actionLabel: string;
  target: ThingTarget;
  /** The date that matters next, when there is one. */
  dueBy: LocalDate | null;
  urgency: Urgency;
  /**
   * True when there is nothing to do yet: a box on its way, an order window that has not opened.
   * These are listed last and are not counted in "3 things left".
   */
  waiting: boolean;
  /** Points of the progress ring this would add when done (out of 100). */
  gain: number;
};

export type Pace = "on_track" | "needs_attention" | "at_risk" | "ready";

export type BreakdownRow = {
  component: ReadinessComponent;
  /** "Car", "Who's coming", "Share page". */
  label: string;
  /** Its share of 100 on this plan (after components that do not apply are left out). */
  weight: number;
  /** 0 to 1. */
  credit: number;
  /** weight × credit. */
  points: number;
  /** What finishing it would add. */
  pointsAvailable: number;
  /** "9 of 9 seats booked, both ways", "Needs you", "7 of 9 replied". */
  state: string;
  urgency: Urgency;
};

export type Readiness = {
  /** 0 to 100, a whole number. 100 only when everything that counts is complete. For a progress ring, never a headline. */
  score: number;
  pace: Pace;
  /** "On track", "Needs attention", "At risk", "Ready". */
  paceLabel: string;
  /** The sentence of whatever set the pace, when it is not on track: "Find the minivan." */
  paceReason: string | null;
  /** Every component that counts on this plan, the most to gain first. */
  breakdown: BreakdownRow[];
  /** Components left out because they do not apply to this plan. */
  leftOut: ReadinessComponent[];
  /** The one thing to do next. Null when nothing needs the person. */
  nextAction: ThingLeft | null;
  /** Every incomplete thing: most worth doing first, then the ones that are only waiting. */
  thingsLeft: ThingLeft[];
  /** How many of them need the person now (waiting ones not counted). */
  thingsLeftCount: number;
  /** "3 things left", "1 thing left", "All set", "Nothing needs you right now". */
  headline: string;
};

/** How a tool's tile should feel. The words carry the meaning; this only picks a mark. */
export type ToolTone = "done" | "needs_you" | "underway" | "waiting" | "off";

export type ToolState = {
  tool: ToolKey;
  /** "Flights", "Stay", "Car", "Rides", "Food", "Send ahead", "Who's coming", "Schedule", "Money", "Share page". */
  label: string;
  /** "All 9 booked", "Booked: Lakeside house", "Needs you", "Airport pickup planned", "$4,280 so far", "Live". */
  state: string;
  /** A second, quieter fragment when there is more to say: "1 more planned", "2 have not replied". */
  note: string | null;
  tone: ToolTone;
  /** "/plans/<planId>/flights". */
  href: string;
};
