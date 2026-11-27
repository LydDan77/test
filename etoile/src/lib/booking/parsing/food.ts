// Reading a food order: a restaurant delivery, a grocery order, catering.

import type { MealType } from "@/lib/domain";
import { findAddresses, findName } from "./common";
import { findDates, findTimes } from "./dates";
import { valueAfterLabel, type Prepared } from "./text";

export type FoodReading = {
  /** "DoorDash", "Instacart" … */
  provider?: string;
  /** The restaurant, store or caterer. */
  vendorName?: string;
  mealType?: MealType;
  deliveryDate?: string;
  /** The delivery window's start and end, local time. One time gives only the start. */
  windowStart?: string;
  windowEnd?: string;
  deliveryAddress?: string;
  yearAssumed: boolean;
  ambiguousDate?: string;
};

const FOOD_COMPANIES = [
  [/\bdoordash\b/i, "DoorDash"],
  [/\buber\s*eats\b/i, "Uber Eats"],
  [/\bgrubhub\b/i, "Grubhub"],
  [/\binstacart\b/i, "Instacart"],
  [/\bezcater\b/i, "ezCater"],
  [/\bpostmates\b/i, "Postmates"],
] as const;

const DELIVERY_LINE = /\b(deliver(?:y|ed|ing)?|arriv(?:es?|ing|al)|drop[\s-]?off|scheduled for|event (?:date|time)|ready (?:by|at))\b/i;
const ADDRESS_LABEL = /^(?:deliver(?:y|ed|ing)? (?:to|address)|delivery location|address|drop[\s-]?off (?:at|address))\s*[:\-–]?/i;
const VENDOR_LABEL = /^(?:restaurant|store|caterer|merchant|from)\s*[:\-–]/i;

function findVendor(prepared: Prepared, provider: string | undefined): string | undefined {
  const { text, lines } = prepared;
  const clean = (raw: string) => {
    const name = raw.replace(/\s+/g, " ").replace(/[.!,;:]+$/, "").trim();
    return name.length >= 2 && name.length <= 70 && name.toLowerCase() !== provider?.toLowerCase() ? name : undefined;
  };
  const labelled = valueAfterLabel(lines, VENDOR_LABEL);
  if (labelled) {
    const name = clean(labelled.value);
    if (name) return name;
  }
  // "Your order from Luigi's Trattoria is confirmed", "Your Publix order is scheduled"
  const from = /\border(?:ed)? from\s+([A-Z0-9][^\n.!]{1,70}?)(?=\s+(?:is|has|was|will|on|for|at)\b|[.!\n]|$)/.exec(text);
  if (from) {
    const name = clean(from[1]);
    if (name) return name;
  }
  const yours = /\b[Yy]our\s+([A-Z][A-Za-z0-9'&.\- ]{1,40}?)\s+(?:order|delivery)\b/.exec(text);
  return yours ? clean(yours[1]) : undefined;
}

export function readFood(prepared: Prepared, opts: { sentDate?: string; referenceDate?: string }): FoodReading {
  const { text, lines } = prepared;
  const dates = findDates(text, opts);
  const provider = findName(text, FOOD_COMPANIES);
  const mealType: MealType =
    provider === "ezCater" || /\b(catering|caterer)\b/i.test(text) ? "catering" : provider === "Instacart" || /\b(grocer(?:y|ies)|shopper)\b/i.test(text) ? "groceries" : "restaurant_delivery";

  const reading: FoodReading = {
    provider,
    vendorName: findVendor(prepared, provider),
    mealType,
    yearAssumed: dates.some((hit) => hit.yearAssumed),
    ambiguousDate: dates.find((hit) => hit.ambiguous)?.raw,
  };

  // The delivery lines: lines about delivery that carry a date or a time, or stand as a label
  // over a line that does. The first date and the first times found on them are the delivery's.
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  for (let i = 0; i < lines.length && !(reading.deliveryDate && reading.windowStart); i++) {
    if (!DELIVERY_LINE.test(lines[i]) || ADDRESS_LABEL.test(lines[i])) continue;
    const has = (index: number) => findTimes(lines[index]).length > 0 || dates.some((hit) => hit.index >= starts[index] && hit.index < starts[index] + lines[index].length);
    // A label standing alone ("Scheduled for delivery") points at the line beneath it.
    const at = has(i) ? i : i + 1 < lines.length && has(i + 1) ? i + 1 : -1;
    if (at === -1) continue;
    const times = findTimes(lines[at]);
    reading.deliveryDate ??= dates.find((hit) => hit.index >= starts[at] && hit.index < starts[at] + lines[at].length && hit.date)?.date ?? undefined;
    if (!reading.windowStart && times[0]) {
      reading.windowStart = times[0].time;
      // A second time later than the first is the end of the window.
      if (times[1] && times[1].time > times[0].time) reading.windowEnd = times[1].time;
    }
  }
  // A delivery time with no date beside it takes the order's one date, when there is exactly one.
  if (!reading.deliveryDate) {
    const distinct = [...new Set(dates.map((hit) => hit.date).filter((date): date is string => Boolean(date)))];
    if (distinct.length === 1) reading.deliveryDate = distinct[0];
  }

  const labelled = valueAfterLabel(lines, ADDRESS_LABEL);
  const labelledBlock = labelled ? [lines[labelled.line], lines[labelled.line + 1] ?? ""].join(", ") : "";
  reading.deliveryAddress = findAddresses(labelledBlock)[0]?.text ?? findAddresses(text)[0]?.text ?? (labelled && /\d/.test(labelled.value) ? labelled.value : undefined);
  return reading;
}
