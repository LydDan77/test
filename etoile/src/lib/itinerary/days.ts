// The schedule grouped by day, with zone changes announced ("Orlando time from here").
//
// A time is always shown in the local time of the place where it happens, so a trip that
// crosses zones changes clocks partway down the list. groupByDay() marks the first row read on
// new clocks so the screen can put a rule line above it, and says how far those clocks are from
// home. The app never asks anyone to pick a time zone; the zone comes from each item's place.

import type { Plan } from "@/db/schema";
import {
  addDays,
  compareDates,
  diffDays,
  EN_DASH,
  localDateOf,
  offsetMinutes,
  toEpochMs,
  zoneCityName,
  type LocalDate,
} from "@/lib/time";
import { clockText, dayText, durationWords, type Wording } from "@/lib/people/text";
import type { TimelineItem } from "./derive";

/** The clocks change from this row on. */
export type ZoneChange = {
  tz: string;
  /** The place those clocks belong to: "Orlando". */
  placeName: string;
  /** "Orlando time from here". */
  text: string;
  /** "3 hours ahead of Seattle". Null when the clocks match home again. */
  detail: string | null;
  /** Minutes ahead of home (negative when behind). */
  minutesFromHome: number;
};

export type TimelineEntry = {
  /** Unique within the grouped schedule. */
  key: string;
  item: TimelineItem;
  /**
   * "item" is the item on the day it starts. "landing" is a second row for a flight that lands
   * on a different calendar day than it leaves: it sits on the landing day, at the landing time.
   */
  part: "item" | "landing";
  title: string;
  /** "all_day" rows lead the day, "timed" rows follow in order, "unscheduled" rows have a day and no time. */
  section: "all_day" | "timed" | "unscheduled";
  /** "4:10 PM", "6:30 PM – 8:00 PM", "All day". Null for an unscheduled row. */
  timeText: string | null;
  /** For a row whose end is on other clocks or another day: "Orlando time", "the next day", "Orlando time, the next day". */
  endNote: string | null;
  /** Set on the first row read on new clocks. Show it as a line above the row. */
  zoneChange: ZoneChange | null;
};

export type TimelineDay = {
  date: LocalDate;
  /** "Sat, Dec 19". */
  label: string;
  /** 1 for the plan's first day; null for travel days outside the plan's dates, or when the plan has no dates. */
  dayNumber: number | null;
  entries: TimelineEntry[];
};

export type GroupOptions = {
  wording?: Wording;
  /**
   * Also return the days of the plan that have nothing on them yet (and any empty day between
   * two days that do), so a day strip has no holes. Default false.
   */
  includeEmptyDays?: boolean;
};

type PlanForDays = Pick<Plan, "tz" | "origin" | "destination" | "stops" | "startDate" | "endDate">;

/**
 * Groups a timeline by day.
 *
 *   for (const day of groupByDay(deriveItinerary(planData), planData.plan)) {
 *     day.label                      // "Sat, Dec 19"
 *     for (const entry of day.entries) {
 *       entry.zoneChange?.text       // "Orlando time from here", above the first Orlando row
 *       entry.timeText, entry.title
 *     }
 *   }
 *
 * The clocks start on home time (the plan's origin). The first timed row somewhere whose clocks
 * read differently carries a `zoneChange`; so does the first row back on home time.
 */
export function groupByDay(timeline: readonly TimelineItem[], plan: PlanForDays, options: GroupOptions = {}): TimelineDay[] {
  const wording = options.wording ?? {};
  type Placement = { item: TimelineItem; part: "item" | "landing"; date: LocalDate; rank: number; ms: number | null };
  const placements: Placement[] = [];
  timeline.forEach((item) => {
    placements.push({ item, part: "item", date: item.localDate, rank: item.allDay ? 0 : item.start ? 1 : 2, ms: item.start ? toEpochMs(item.start.at) : null });
    if (item.type === "flight" && item.end) {
      const landsOn = localDateOf(item.end.at, item.end.tz);
      if (landsOn !== item.localDate) placements.push({ item, part: "landing", date: landsOn, rank: 1, ms: toEpochMs(item.end.at) });
    }
  });
  // The timeline is already in order; the sort only has to slot the landing rows in.
  const order = new Map(timeline.map((item, index) => [item.key, index]));
  placements.sort(
    (a, b) =>
      compareDates(a.date, b.date) ||
      a.rank - b.rank ||
      (a.ms !== null && b.ms !== null ? a.ms - b.ms : 0) ||
      (order.get(a.item.key) ?? 0) - (order.get(b.item.key) ?? 0),
  );

  const days = new Map<LocalDate, TimelineDay>();
  const dayFor = (date: LocalDate): TimelineDay => {
    let day = days.get(date);
    if (!day) {
      day = { date, label: dayText(date), dayNumber: dayNumberOf(date, plan), entries: [] };
      days.set(date, day);
    }
    return day;
  };

  let clocks = plan.origin.tz;
  for (const placement of placements) {
    const { item, part } = placement;
    let zoneChange: ZoneChange | null = null;
    const at = part === "landing" ? item.end : item.start;
    if (at && item.status !== "cancelled" && !item.allDay) {
      if (offsetMinutes(at.at, at.tz) !== offsetMinutes(at.at, clocks)) zoneChange = describeZone(at.tz, at.at, plan, item);
      clocks = at.tz;
    }
    dayFor(placement.date).entries.push({
      key: part === "landing" ? `${item.key}:landing` : item.key,
      item,
      part,
      title: part === "landing" && item.flight ? `${item.flight.designator} lands at ${item.flight.destinationIata}` : item.title,
      section: placement.rank === 0 ? "all_day" : placement.rank === 1 ? "timed" : "unscheduled",
      timeText: timeText(item, part, wording),
      endNote: part === "item" ? endNote(item, plan) : null,
      zoneChange,
    });
  }

  if (options.includeEmptyDays) {
    const dates = [...days.keys()];
    if (plan.startDate) dates.push(plan.startDate);
    if (plan.endDate) dates.push(plan.endDate);
    dates.sort(compareDates);
    if (dates.length > 0) {
      const last = dates[dates.length - 1];
      // A guard against a runaway loop if a stray item sits years away from the plan.
      for (let date = dates[0], n = 0; compareDates(date, last) <= 0 && n < 400; date = addDays(date, 1), n++) dayFor(date);
    }
  }

  return [...days.values()].sort((a, b) => compareDates(a.date, b.date));
}

function dayNumberOf(date: LocalDate, plan: PlanForDays): number | null {
  if (!plan.startDate || !plan.endDate) return null;
  if (compareDates(date, plan.startDate) < 0 || compareDates(date, plan.endDate) > 0) return null;
  return diffDays(plan.startDate, date) + 1;
}

function timeText(item: TimelineItem, part: "item" | "landing", wording: Wording): string | null {
  if (part === "landing") return item.end ? clockText(item.end.at, item.end.tz, wording) : null;
  if (item.allDay) return "All day";
  if (!item.start) return null;
  const start = clockText(item.start.at, item.start.tz, wording);
  return item.end ? `${start} ${EN_DASH} ${clockText(item.end.at, item.end.tz, wording)}` : start;
}

function endNote(item: TimelineItem, plan: PlanForDays): string | null {
  if (!item.start || !item.end) return null;
  const notes: string[] = [];
  if (offsetMinutes(item.end.at, item.end.tz) !== offsetMinutes(item.end.at, item.start.tz)) {
    notes.push(`${zonePlaceName(item.end.tz, plan, townOf(item.endPlace, item.end.tz))} time`);
  }
  const days = diffDays(localDateOf(item.start.at, item.start.tz), localDateOf(item.end.at, item.end.tz));
  if (days === 1) notes.push("the next day");
  else if (days > 1) notes.push(`${days} days later`);
  else if (days === -1) notes.push("the day before on the calendar");
  else if (days < -1) notes.push(`${-days} days earlier on the calendar`);
  return notes.length ? notes.join(", ") : null;
}

/**
 * The name people use for the place a zone belongs to in this plan: the destination, a stop,
 * home, the town of the item itself, or failing all of those the city the zone is named after
 * ("America/Chicago" reads "Chicago").
 */
function zonePlaceName(tz: string, plan: PlanForDays, fallback: string | null): string {
  if (plan.destination && plan.destination.tz === tz) return plan.destination.name;
  const stop = plan.stops.find((s) => s.place.tz === tz);
  if (stop) return stop.place.name;
  if (plan.origin.tz === tz) return plan.origin.name;
  return fallback ?? zoneCityName(tz);
}

/** The town a place is in, when the place says: a city or a home by its name, anything else by its locality. */
function townOf(place: TimelineItem["place"], tz: string): string | null {
  if (!place || place.tz !== tz) return null;
  if (place.kind === "city" || place.kind === "home") return place.name;
  return place.locality ?? null;
}

function describeZone(tz: string, at: string, plan: PlanForDays, item: TimelineItem): ZoneChange {
  const placeName = zonePlaceName(tz, plan, townOf(item.place, tz) ?? townOf(item.endPlace, tz));
  const minutes = offsetMinutes(at, tz) - offsetMinutes(at, plan.origin.tz);
  const detail =
    minutes === 0 ? null : `${durationWords(Math.abs(minutes))} ${minutes > 0 ? "ahead of" : "behind"} ${plan.origin.name}`;
  return { tz, placeName, text: `${placeName} time from here`, detail, minutesFromHome: minutes };
}
