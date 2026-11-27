// Reading a ride confirmation or receipt: Uber, Lyft, a shuttle.

import { findAddresses, findName } from "./common";
import { findDates, findTimes } from "./dates";
import type { Prepared } from "./text";

export type RideReading = {
  /** "Uber", "Lyft". */
  provider?: string;
  pickupDate?: string;
  pickupTime?: string;
  pickupAddress?: string;
  dropoffAddress?: string;
  yearAssumed: boolean;
  ambiguousDate?: string;
};

const RIDE_COMPANIES = [
  [/\buber\b/i, "Uber"],
  [/\blyft\b/i, "Lyft"],
  [/\bsupershuttle\b/i, "SuperShuttle"],
  [/\bblacklane\b/i, "Blacklane"],
] as const;

const PICKUP = /\bpick(?:ed)?[\s-]?up\b/i;
const DROPOFF = /\bdrop(?:ped)?[\s-]?off\b|\bdestination\b/i;

/** What a line says once a leading label and time are taken off: "Pickup: 4:42 PM · 1 Jeff Fuqua Blvd" gives the address. */
function lineBody(line: string): string {
  return line
    .replace(/^\W*(pick(?:ed)?[\s-]?up|drop(?:ped)?[\s-]?off|destination)\b(\s+(location|address|time|at))?/i, "")
    .replace(/\b\d{1,2}:\d{2}\s?(?:[AaPp]\.?[Mm]\.?)?/g, "")
    .replace(/^[\s:|·•\-–—,]+|[\s:|·•\-–—,]+$/g, "")
    .trim();
}

const looksLikePlace = (text: string) => text.length >= 6 && text.length <= 120 && /[A-Za-z]{3}/.test(text) && !/^(time|date|location|address)$/i.test(text);

export function readRide(prepared: Prepared, opts: { sentDate?: string; referenceDate?: string }): RideReading {
  const { text, lines } = prepared;
  const dates = findDates(text, opts);
  const addresses = findAddresses(text);
  const reading: RideReading = {
    provider: findName(text, RIDE_COMPANIES),
    pickupDate: dates.find((hit) => hit.date)?.date ?? undefined,
    yearAssumed: dates.some((hit) => hit.yearAssumed),
    ambiguousDate: dates.find((hit) => hit.ambiguous)?.raw,
  };

  // Labelled: "Pickup" and "Drop-off", each with a time and a place on its line or the next.
  const end = (label: RegExp, stop: RegExp): { address?: string; time?: string } => {
    const at = lines.findIndex((line) => label.test(line) && (line.search(label) <= 3 || /:\s*\S/.test(line)));
    if (at === -1) return {};
    const own = [lines[at]];
    for (let j = at + 1; j < Math.min(lines.length, at + 3) && !stop.test(lines[j]) && !label.test(lines[j]); j++) own.push(lines[j]);
    const joined = own.join("\n");
    const time = findTimes(joined)[0]?.time;
    const address = findAddresses(joined)[0]?.text ?? own.map(lineBody).find(looksLikePlace);
    return { address, time };
  };
  const pickup = end(PICKUP, DROPOFF);
  const dropoff = end(DROPOFF, PICKUP);
  reading.pickupTime = pickup.time;
  reading.pickupAddress = pickup.address;
  reading.dropoffAddress = dropoff.address;

  // A receipt with no labels: two "time, then address" rows, the first being the pick-up.
  if (!reading.pickupTime || !reading.pickupAddress || !reading.dropoffAddress) {
    const rows: Array<{ time: string | undefined; place: string }> = [];
    lines.forEach((line, i) => {
      const time = /^\W{0,2}(\d{1,2}:\d{2}\s?(?:[AaPp]\.?[Mm]\.?)?)/.exec(line);
      if (!time) return;
      const body = lineBody(line);
      const below = lines[i + 1];
      const place = looksLikePlace(body) ? body : below && looksLikePlace(below) && findTimes(below).length === 0 ? below : undefined;
      if (place) rows.push({ time: findTimes(time[1])[0]?.time, place: findAddresses(place)[0]?.text ?? place });
    });
    if (rows.length >= 2) {
      reading.pickupTime ??= rows[0].time;
      reading.pickupAddress ??= rows[0].place;
      reading.dropoffAddress ??= rows[1].place;
    }
  }
  // Exactly two street addresses and nothing better: the first is the pick-up.
  if (!reading.pickupAddress && !reading.dropoffAddress && addresses.length === 2) {
    reading.pickupAddress = addresses[0].text;
    reading.dropoffAddress = addresses[1].text;
  }
  return reading;
}
