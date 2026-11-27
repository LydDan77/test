// Reading a stay confirmation: a hotel, or a home rental.

import type { LodgingType } from "@/lib/domain";
import { compareDates } from "@/lib/time";
import { findAddresses, findName } from "./common";
import { findDates, findTimes, type DateHit } from "./dates";
import { valueAfterLabel, type Prepared } from "./text";

export type StayReading = {
  /** Where it was booked, when the text says: "Airbnb", "Booking.com". */
  provider?: string;
  lodgingType?: LodgingType;
  propertyName?: string;
  address?: string;
  checkInDate?: string;
  checkInTime?: string;
  checkOutDate?: string;
  checkOutTime?: string;
  yearAssumed: boolean;
  ambiguousDate?: string;
};

const BOOKING_SITES = [
  [/\bairbnb\b/i, "Airbnb"],
  [/\bvrbo\b/i, "Vrbo"],
  [/\bbooking\.com\b/i, "Booking.com"],
  [/\bhotels\.com\b/i, "Hotels.com"],
  [/\bexpedia\b/i, "Expedia"],
] as const;

const HOTEL_BRANDS =
  /\b(Marriott|Hilton|Hyatt|Hampton Inn|Holiday Inn|Courtyard|Residence Inn|Westin|Sheraton|Fairfield|Embassy Suites|DoubleTree|Best Western|La Quinta|Homewood Suites|SpringHill Suites|Ritz-Carlton|Four Seasons|Wyndham|Radisson|Comfort Inn|Quality Inn|Days Inn|Motel 6|Kimpton|Loews|Omni|Drury|Hotel|Resort|Lodge|Inn|Suites)\b/;
const NOT_A_NAME = /\b(thank|thanks|confirm|confirmed|confirmation|reservation|rewards|member|bonvoy|honors|dear|hello|your|we |you |please|\.com|©|check[\s-]?in|check[\s-]?out|night|total|rate|guest)\b/i;

const NAME_LABEL = /^(?:hotel name|property name|hotel|property|listing|accommodation|resort|where you(?:'|’)re staying)\s*[:\-–]/i;

function cleanName(raw: string): string | undefined {
  const name = raw.replace(/\s+/g, " ").replace(/[.!,;:]+$/, "").trim();
  return name.length >= 3 && name.length <= 90 ? name : undefined;
}

function findPropertyName(prepared: Prepared): string | undefined {
  const { lines, text } = prepared;
  // 1. A label: "Hotel: Hampton Inn & Suites Orlando Airport".
  const labelled = valueAfterLabel(lines, NAME_LABEL);
  if (labelled) return cleanName(labelled.value);
  // 2. A home rental: the listing title sits just above "Entire home hosted by …".
  const hosted = lines.findIndex((line) => /^(entire (home|place|house|cabin|villa|condo|cottage|apartment|rental unit)|private room|room in)\b.*\bhosted by\b/i.test(line));
  if (hosted > 0 && !NOT_A_NAME.test(lines[hosted - 1])) return cleanName(lines[hosted - 1]);
  // 3. "Your stay at The Westin Seattle is confirmed", "Thank you for choosing Hyatt Regency Orlando".
  // (No i flag: the name must start with a capital, or "booking with us" would be a hotel.)
  const sentence =
    /\b(?:[Rr]eservation|[Bb]ooking|[Ss]tay|[Rr]oom)\s+(?:at|with)\s+(?:the\s+)?([A-Z][^\n.!]{2,80}?)(?=\s+(?:is|has been|was|from|for|on)\b|[.!\n]|$)/.exec(text) ??
    /\b(?:[Tt]hank you for (?:choosing|booking|staying (?:at|with))|[Ww]elcome to)\s+(?:the\s+)?([A-Z][^\n.!]{2,80}?)(?=[.!\n]|$)/.exec(text);
  if (sentence) return cleanName(sentence[1]);
  // 4. A short line that reads like a hotel's name, near the top.
  const titled = lines.slice(0, 25).find((line) => line.length <= 70 && HOTEL_BRANDS.test(line) && !NOT_A_NAME.test(line) && !/\d{3,}/.test(line));
  return titled ? cleanName(titled) : undefined;
}

const CHECK_IN = /\bcheck[\s-]?in\b|\barrival(?: date)?\b|\barriv(?:e|ing)\b/gi;
const CHECK_OUT = /\bcheck[\s-]?out\b|\bcheckout\b|\bdeparture(?: date)?\b|\bdepart(?:ing)?\b/gi;

type LabelHit = { index: number; end: number; strict: boolean };

function labelHits(text: string, pattern: RegExp): LabelHit[] {
  const hits: LabelHit[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) hits.push({ index: m.index, end: m.index + m[0].length, strict: /check/i.test(m[0]) });
  return hits;
}

function readDates(text: string, dates: DateHit[]): Pick<StayReading, "checkInDate" | "checkInTime" | "checkOutDate" | "checkOutTime"> {
  const ins = labelHits(text, CHECK_IN);
  const outs = labelHits(text, CHECK_OUT);
  const times = findTimes(text);
  const result: Pick<StayReading, "checkInDate" | "checkInTime" | "checkOutDate" | "checkOutTime"> = {};

  // Two columns pasted as lines: "Check-in  Checkout" / "Sat, Dec 19  Sun, Dec 27" / "4:00 PM  11:00 AM".
  for (const start of ins) {
    const lineEnd = text.indexOf("\n", start.index) === -1 ? text.length : text.indexOf("\n", start.index);
    const sameLineOut = outs.find((out) => out.index > start.end && out.index < lineEnd);
    if (!sameLineOut) continue;
    const between = dates.some((hit) => hit.index > start.end && hit.index < sameLineOut.index) || times.some((hit) => hit.index > start.end && hit.index < sameLineOut.index);
    if (between) continue;
    // Two headings side by side: what follows is read as pairs, check-in first. A date the text
    // gives no year for stays empty, and nothing else is guessed from this layout.
    const after = dates.filter((hit) => hit.index > sameLineOut.end && hit.index < sameLineOut.end + 160);
    if (after.length >= 2) {
      result.checkInDate = after[0].date ?? undefined;
      result.checkOutDate = after[1].date ?? undefined;
    }
    const timesFrom = after.length >= 2 ? after[1].end : sameLineOut.end;
    const afterTimes = times.filter((hit) => hit.index > timesFrom && hit.index < timesFrom + 80);
    if (afterTimes.length >= 2) {
      result.checkInTime = afterTimes[0].time;
      result.checkOutTime = afterTimes[1].time;
    }
    return result;
  }

  // Otherwise each label is followed by its own date, and sometimes its own time. The window
  // after a label ends where the next label of either sort begins.
  const all = [...ins.map((hit) => ({ ...hit, side: "in" as const })), ...outs.map((hit) => ({ ...hit, side: "out" as const }))].sort((a, b) => a.index - b.index);
  all.forEach((label, i) => {
    const next = all.slice(i + 1).find((other) => other.index >= label.end);
    const windowEnd = Math.min(next ? next.index : text.length, label.end + 90);
    const date = dates.find((hit) => hit.index >= label.end && hit.index < windowEnd && hit.date)?.date ?? undefined;
    // Only "check-in" and "check-out" themselves are trusted for a time: "Arrival" might be a flight.
    const time = label.strict ? times.find((hit) => hit.index >= label.end && hit.index < windowEnd)?.time : undefined;
    if (label.side === "in") {
      result.checkInDate ??= date;
      result.checkInTime ??= time;
    } else {
      result.checkOutDate ??= date;
      result.checkOutTime ??= time;
    }
  });
  return result;
}

export function readStay(prepared: Prepared, opts: { sentDate?: string; referenceDate?: string }): StayReading {
  const { text } = prepared;
  const dates = findDates(text, opts);
  const provider = findName(text, BOOKING_SITES);
  const rental = provider === "Airbnb" || provider === "Vrbo" || /\b(hosted by|your host|entire (home|place|house|cabin)|vacation rental|house rules)\b/i.test(text);
  const reading: StayReading = {
    provider,
    lodgingType: rental ? "rental" : "hotel",
    propertyName: findPropertyName(prepared),
    address: findAddresses(text)[0]?.text,
    ...readDates(text, dates),
    yearAssumed: dates.some((hit) => hit.yearAssumed),
    ambiguousDate: dates.find((hit) => hit.ambiguous)?.raw,
  };
  // A check-out that is not after check-in was misread: better empty than wrong.
  if (reading.checkInDate && reading.checkOutDate && compareDates(reading.checkOutDate, reading.checkInDate) <= 0) {
    delete reading.checkOutDate;
    delete reading.checkOutTime;
  }
  return reading;
}
