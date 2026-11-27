// Reading a rental car confirmation.

import type { VehicleClass } from "@/lib/domain";
import { compareDates } from "@/lib/time";
import { findAddresses, findName } from "./common";
import { findDates, findTimes, type DateHit, type TimeHit } from "./dates";
import { valueAfterLabel, type Prepared } from "./text";

export type CarReading = {
  company?: string;
  /** Where the car is picked up, as the confirmation words it. */
  pickupPlace?: string;
  pickupDate?: string;
  pickupTime?: string;
  returnPlace?: string;
  returnDate?: string;
  returnTime?: string;
  vehicleClass?: VehicleClass;
  /** The car as the confirmation describes it: "Toyota RAV4 or similar (Intermediate SUV)". */
  vehicleDescription?: string;
  yearAssumed: boolean;
  ambiguousDate?: string;
};

const COMPANIES = [
  [/\bhertz\b/i, "Hertz"],
  [/\bavis\b/i, "Avis"],
  [/\bbudget\b(?=\s+(?:rent|car|truck)|\.com)/i, "Budget"],
  [/\benterprise\b/i, "Enterprise"],
  [/\bnational car\b|\bnationalcar\b/i, "National"],
  [/\balamo\b/i, "Alamo"],
  [/\bdollar\b(?=\s+(?:rent|car))/i, "Dollar"],
  [/\bthrifty\b/i, "Thrifty"],
  [/\bsixt\b/i, "Sixt"],
  [/\bpayless car\b/i, "Payless"],
  [/\bfox rent\b/i, "Fox Rent A Car"],
  [/\beuropcar\b/i, "Europcar"],
  [/\bturo\b/i, "Turo"],
  [/\bzipcar\b/i, "Zipcar"],
] as const;

// Checked in this order: "Midsize SUV" is an SUV, "Full-size" is not "standard".
const CLASS_WORDS: ReadonlyArray<readonly [RegExp, VehicleClass]> = [
  [/\bminivan\b|\bmini-van\b/i, "minivan"],
  [/\b(passenger van|\d+[\s-]passenger)\b/i, "van"],
  [/\b(pickup truck|pick-up truck|truck)\b/i, "pickup"],
  [/\bsuv\b|\bsport utility\b/i, "suv"],
  [/\b(luxury|premium)\b/i, "luxury"],
  [/\bfull[\s-]?size\b/i, "full_size"],
  [/\bstandard\b/i, "standard"],
  [/\b(mid[\s-]?size|intermediate)\b/i, "midsize"],
  [/\bcompact\b/i, "compact"],
  [/\beconomy\b/i, "economy"],
];

const PICK = /^(?:\W{0,3})pick[\s-]?up\b/i;
const RETURN = /^(?:\W{0,3})(?:return|drop[\s-]?off)\b/i;

type End = { place?: string; date?: string; time?: string };

function offsets(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return starts;
}

function withoutDateTime(line: string, lineStart: number, dates: DateHit[], times: TimeHit[]): string {
  let out = line;
  const cuts = [...dates, ...times].filter((hit) => hit.index >= lineStart && hit.end <= lineStart + line.length).sort((a, b) => b.index - a.index);
  for (const cut of cuts) out = out.slice(0, cut.index - lineStart) + out.slice(cut.end - lineStart);
  // Take off what is left of the date ("Saturday,", "at", "@") from either end, and nothing from the middle.
  const edge = "(?:\\s|[:;,|@·•\\-–—]|\\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\\b\\.?|\\b(?:at|on|date|time|and)\\b)+";
  return out.replace(new RegExp(`^${edge}`, "i"), "").replace(new RegExp(`${edge}$`, "i"), "").replace(/\s+/g, " ").trim();
}

function readEnd(prepared: Prepared, label: RegExp, other: RegExp, dates: DateHit[], times: TimeHit[]): End {
  const { lines } = prepared;
  const starts = offsets(lines);
  const end: End = {};
  for (let i = 0; i < lines.length; i++) {
    const match = label.exec(lines[i]);
    if (!match) continue;
    // The label's own lines: up to four, stopping at the next pick-up or return label.
    let last = i;
    while (last + 1 < lines.length && last - i < 3 && !PICK.test(lines[last + 1]) && !RETURN.test(lines[last + 1]) && !other.test(lines[last + 1])) last++;
    const from = starts[i] + match[0].length;
    const to = starts[last] + lines[last].length;
    const rest = lines[i].slice(match[0].length);
    const sub = /^\s*(location|place|address|branch|date|time|on|at)?/i.exec(rest)?.[1]?.toLowerCase();

    end.date ??= dates.find((hit) => hit.index >= from && hit.index < to && hit.date)?.date ?? undefined;
    end.time ??= times.find((hit) => hit.index >= from && hit.index < to)?.time;

    if (!end.place && sub !== "date" && sub !== "time") {
      // The place is the first of these lines that still says something once the date and time are taken out.
      for (let j = i; j <= last; j++) {
        const body = j === i ? rest.replace(/^\s*(location|place|address|branch)\b/i, "") : lines[j];
        const bodyStart = j === i ? starts[i] + lines[i].length - body.length : starts[j];
        const words = withoutDateTime(body, bodyStart, dates, times);
        if (/[A-Za-z]{3}/.test(words) && words.length <= 90) {
          end.place = words;
          break;
        }
      }
    }
    if (end.place && end.date && end.time) break;
  }
  return end;
}

export function readCar(prepared: Prepared, opts: { sentDate?: string; referenceDate?: string }): CarReading {
  const { text, lines } = prepared;
  const dates = findDates(text, opts);
  const times = findTimes(text);
  const pickup = readEnd(prepared, PICK, RETURN, dates, times);
  const back = readEnd(prepared, RETURN, PICK, dates, times);

  // "Same as pick-up" and its cousins.
  if (back.place && /\bsame\b/i.test(back.place)) back.place = pickup.place;
  // A street address for the pick-up is better than nothing when no place line was found.
  if (!pickup.place) pickup.place = findAddresses(text)[0]?.text;

  const described =
    valueAfterLabel(lines, /^(?:car class|vehicle class|car type|vehicle type|vehicle|your vehicle|your car|car)\s*[:\-–]/i)?.value ??
    lines.find((line) => /\bor similar\b/i.test(line) && line.length <= 90);
  const vehicleClass = described ? CLASS_WORDS.find(([pattern]) => pattern.test(described))?.[1] : undefined;

  const reading: CarReading = {
    company: findName(text, COMPANIES),
    pickupPlace: pickup.place,
    pickupDate: pickup.date,
    pickupTime: pickup.time,
    returnPlace: back.place,
    returnDate: back.date,
    returnTime: back.time,
    vehicleClass,
    vehicleDescription: described?.replace(/\s+/g, " ").trim(),
    yearAssumed: dates.some((hit) => hit.yearAssumed),
    ambiguousDate: dates.find((hit) => hit.ambiguous)?.raw,
  };
  // A return before the pick-up was misread: better empty than wrong.
  if (reading.pickupDate && reading.returnDate && compareDates(reading.returnDate, reading.pickupDate) < 0) {
    delete reading.returnDate;
    delete reading.returnTime;
  }
  return reading;
}
