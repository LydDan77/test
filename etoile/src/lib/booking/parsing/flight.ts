// Reading a flight confirmation: each flight's airline, number, airports and local times, the
// confirmation code and, where a label makes them clear, who is flying.

import { airlineMentions, airlineName, airlinesNamedIn, flightNumbersByShortName, isKnownAirlineCode } from "@/lib/airlines";
import { findDates, findTimes, withDayOffset, type DateHit } from "./dates";
import { titleCase, type Prepared } from "./text";

/** One flight as the confirmation printed it. Dates and times are LOCAL to each airport. */
export type ParsedFlightSegment = {
  /** Two-character airline code: "AS". */
  airlineIata?: string;
  /** "Alaska Airlines", when the code is a known airline. */
  airlineName?: string;
  /** The number without the airline code: "1054". */
  flightNumber?: string;
  originIata?: string;
  destinationIata?: string;
  /** Local date and time at the origin airport. */
  departDate?: string;
  departTime?: string;
  /** Local date and time at the destination airport. */
  arriveDate?: string;
  arriveTime?: string;
};

// Three capitals that are not airports when they stand alone.
const NOT_AIRPORTS = new Set([
  "THE", "AND", "FOR", "YOU", "ARE", "NOT", "ALL", "ANY", "NEW", "OUR", "VIA", "PER", "TAX", "FEE", "USD", "CAD", "EUR", "GBP",
  "GMT", "UTC", "EST", "EDT", "CST", "CDT", "MST", "MDT", "PST", "PDT", "HST", "BST", "CET", "TSA", "PNR", "ETA", "ETD", "FAA",
  "SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
]);
const CALENDAR_WORDS = new Set(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);

type Designator = { code?: string; number: string; index: number; end: number };

/** Flight numbers in the text: "AS 1054", "Flight 1054", "Flight # 1432", "DL1423", "Alaska 1054". */
function findDesignators(text: string, named: readonly string[]): Designator[] {
  const found: Designator[] = [];
  const overlaps = (index: number, end: number) => found.some((other) => index < other.end && other.index < end);
  let m: RegExpExecArray | null;

  // With the word "flight" in front, the code is optional and any airline code is believed.
  // (Written without the i flag so that "to" in "flight to 2 cities" is never read as a code.)
  const labelled = /\b(?:[Ff]light|FLIGHT|[Ff]lt|FLT)\.?(?:\s*(?:[Nn]umber|NUMBER|[Nn]o\.?|NO\.?|#))?\s*:?\s*#?\s*(?:([A-Z][A-Z0-9]|[0-9][A-Z])\s?)?(\d{1,4})(?![\d:/])\b/g;
  while ((m = labelled.exec(text))) {
    // "Flight 1 of 2" counts legs; it is not a flight number.
    if (!m[1] && m[2].length === 1 && /^\s*of\b/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 5))) continue;
    found.push({ code: m[1], number: m[2], index: m.index, end: m.index + m[0].length });
  }

  // "Alaska 1054", "Delta Air Lines flight 1423": the airline's name, then the number.
  for (const mention of airlineMentions(text)) {
    const after = /^\s+(?:[Ff]light\s+)?#?\s?(\d{1,4})(?![\d:/%A-Za-z])/.exec(text.slice(mention.end, mention.end + 24));
    if (!after) continue;
    const end = mention.end + after[0].length;
    const existing = found.find((other) => mention.index < other.end && other.index < end);
    if (existing) existing.code ??= mention.iata;
    else found.push({ code: mention.iata, number: after[1], index: mention.index, end });
  }

  // "Alaska 1054", "UNITED 437": a one-word airline name is believed when a number follows it.
  for (const hit of flightNumbersByShortName(text)) {
    const existing = found.find((other) => hit.index < other.end && other.index < hit.end);
    if (existing) existing.code ??= hit.iata;
    else found.push({ code: hit.iata, number: hit.number, index: hit.index, end: hit.end });
  }

  // On its own, a code is believed only when that airline is named somewhere in the text.
  const bare = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{2,4})(?![\d:/%A-Za-z])/g;
  while ((m = bare.exec(text))) {
    if (!named.includes(m[1]) || /^\s?[AP]M\b/i.test(text.slice(m.index + m[0].length))) continue;
    if (overlaps(m.index, m.index + m[0].length)) continue;
    found.push({ code: m[1], number: m[2], index: m.index, end: m.index + m[0].length });
  }
  return found.sort((a, b) => a.index - b.index);
}

function airportCodes(text: string, isAirportCode: ((code: string) => boolean) | undefined): Array<{ code: string; index: number }> {
  const found: Array<{ code: string; index: number }> = [];
  const ok = (code: string) => (isAirportCode ? isAirportCode(code) : true);
  const plainWord = (code: string) => NOT_AIRPORTS.has(code) && !CALENDAR_WORDS.has(code);
  let m: RegExpExecArray | null;
  // "Seattle (SEA)": the surest form, and one where SAT or MAY is taken as an airport.
  const bracketed = /\(([A-Z]{3})\)/g;
  while ((m = bracketed.exec(text))) if (!plainWord(m[1]) && ok(m[1])) found.push({ code: m[1], index: m.index + 1 });
  // "SEA to MCO", "SEA → MCO", "SEA-MCO"
  const route = /(?<![A-Za-z])([A-Z]{3})\s*(?:to|TO|→|->|–|—|-|>|➔|✈)\s*([A-Z]{3})(?![A-Za-z])/g;
  while ((m = route.exec(text))) {
    if (CALENDAR_WORDS.has(m[1]) && CALENDAR_WORDS.has(m[2])) continue; // "MON-FRI"
    if (plainWord(m[1]) || plainWord(m[2]) || !ok(m[1]) || !ok(m[2])) continue;
    found.push({ code: m[1], index: m.index }, { code: m[2], index: m.index + m[0].length - 3 });
  }
  // "DEPARTS DEN 06:05 AM": a lone code right after a depart or arrive word.
  const labelled = /\b(?:[Dd]epart(?:s|ure|ing)?|DEPART(?:S|URE|ING)?|[Aa]rriv(?:es?|al|ing)|ARRIV(?:ES?|AL|ING)|[Ff]rom|FROM|[Tt]o|TO)\b:?\s+([A-Z]{3})(?![A-Za-z])/g;
  while ((m = labelled.exec(text))) {
    if (NOT_AIRPORTS.has(m[1]) || !ok(m[1])) continue;
    found.push({ code: m[1], index: m.index + m[0].length - 3 });
  }
  found.sort((a, b) => a.index - b.index);
  // The same code found by two patterns at the same spot counts once.
  return found.filter((hit, i) => i === 0 || !(hit.code === found[i - 1].code && hit.index - found[i - 1].index < 4));
}

type Reader = {
  text: string;
  dates: DateHit[];
  isAirportCode?: (code: string) => boolean;
};

const DEPART_WORD = /\b(depart(?:s|ure|ing)?|leaves?|take[\s-]?off)\b/i;
const ARRIVE_WORD = /\b(arriv(?:es?|al|ing)|lands?)\b/i;

/** The index just past the end of the line that holds `index`. */
function lineEndAt(text: string, index: number): number {
  const end = text.indexOf("\n", index);
  return end === -1 ? text.length : end;
}

/** The end of the `count`-th line counting from the one that holds `index`. */
function linesAhead(text: string, index: number, count: number): number {
  let end = index;
  for (let i = 0; i < count; i++) {
    end = lineEndAt(text, end);
    if (end >= text.length) break;
    if (i < count - 1) end += 1;
  }
  return end;
}

/**
 * One end of a flight, read from the lines that follow a "Departs" or "Arrives" word: the
 * airport, the time, and a date when one is printed up to the end of the time's own line.
 */
function readEnd(reader: Reader, start: number, limit: number): { airport?: string; date?: string; time?: string } {
  const end = Math.min(limit, linesAhead(reader.text, start, 3));
  const part = reader.text.slice(start, end);
  const time = findTimes(part)[0];
  const dateLimit = time ? lineEndAt(reader.text, start + time.index) : end;
  return {
    airport: airportCodes(part, reader.isAirportCode)[0]?.code,
    time: time?.time,
    date: reader.dates.find((hit) => hit.index >= start && hit.index < dateLimit && hit.date)?.date ?? undefined,
  };
}

function readSegment(reader: Reader, designator: Designator, blockEnd: number): ParsedFlightSegment {
  const { text, dates } = reader;
  // The block is the flight's own lines: from the start of its line to the next flight.
  const lineStart = text.lastIndexOf("\n", designator.index) + 1;
  const ownLineEnd = lineEndAt(text, designator.index);
  const block = text.slice(lineStart, blockEnd);
  // "0911" and "911" are the same flight; the stored form has no leading zeros.
  const segment: ParsedFlightSegment = { airlineIata: designator.code, flightNumber: designator.number.replace(/^0+(?=\d)/, "") };
  if (designator.code) segment.airlineName = airlineName(designator.code) ?? undefined;

  const dateIn = (from: number, to: number) => dates.find((hit) => hit.index >= from && hit.index < to && hit.date)?.date ?? undefined;
  // A date printed above the flight ("DEPART Sat, 19DEC" over two connecting flights) applies
  // to it when the flight's own lines have none.
  const carried = [...dates].reverse().find((hit) => hit.index < lineStart && hit.date)?.date ?? undefined;

  const departAt = DEPART_WORD.exec(block);
  const arriveAt = ARRIVE_WORD.exec(block);
  const departStart = departAt ? lineStart + departAt.index : -1;
  const arriveStart = arriveAt ? lineStart + arriveAt.index : -1;
  const depart = departAt && arriveAt && departStart < arriveStart ? readEnd(reader, departStart, arriveStart) : undefined;
  const arrive = depart ? readEnd(reader, arriveStart, blockEnd) : undefined;
  // The words must each lead to something. "DEPART   ARRIVE" as column headings lead to
  // nothing, and then the flight is read in order instead.
  if (depart && arrive && (depart.airport || depart.time) && (arrive.airport || arrive.time)) {
    segment.originIata = depart.airport;
    segment.destinationIata = arrive.airport;
    // The date may sit on the flight's first lines, before the word "Departs".
    segment.departDate = depart.date ?? dateIn(lineStart, departStart) ?? carried;
    segment.departTime = depart.time;
    segment.arriveTime = arrive.time;
    if (arrive.date) segment.arriveDate = arrive.date;
    else if (segment.departDate && arrive.time) {
      segment.arriveDate = arrivalDate(segment.departDate, depart.time, arrive.time, text.slice(arriveStart, lineEndAt(text, arriveStart)));
    }
    return segment;
  }

  // No "departs" and "arrives" words: read in order. First airport and time are the departure.
  const airports = airportCodes(block, reader.isAirportCode);
  const times = findTimes(block);
  const firstTime = times[0] ? lineStart + times[0].index : undefined;
  const secondTime = times[1] ? lineStart + times[1].index : undefined;
  segment.originIata = airports[0]?.code;
  segment.destinationIata = airports.find((hit) => hit.code !== airports[0]?.code)?.code;
  segment.departTime = times[0]?.time;
  segment.arriveTime = times[1]?.time;
  // The flight's own date: on its line, or before its first time. A date further down belongs
  // to whatever comes next ("RETURN Sun, 27DEC"), so the date carried from above wins over it.
  segment.departDate = dateIn(lineStart, firstTime ?? ownLineEnd) ?? dateIn(lineStart, ownLineEnd) ?? carried;
  if (secondTime !== undefined && firstTime !== undefined) {
    // A second date belongs to the arrival when it comes after the departure time and no later
    // than the arrival time's own line.
    const arrivalOwn = dates.find((hit) => hit.index > firstTime && hit.index < lineEndAt(text, secondTime) && hit.date);
    if (arrivalOwn?.date) segment.arriveDate = arrivalOwn.date;
    else if (segment.departDate) {
      segment.arriveDate = arrivalDate(segment.departDate, times[0].time, times[1].time, text.slice(secondTime, lineEndAt(text, secondTime)));
    }
  }
  return segment;
}

/**
 * The arrival date when the text gives only one date. With a "+1" or "next day" beside the
 * arrival time it is the day after; when the arrival clock time is later than the departure it
 * is taken as the same day. An arrival time EARLIER than the departure with no marker could be
 * the next day or a time-zone effect, so no date is given and the person is asked.
 */
function arrivalDate(departDate: string, departTime: string | undefined, arriveTime: string, near: string): string | undefined {
  const shifted = withDayOffset(departDate, near);
  if (shifted !== departDate) return shifted;
  if (departTime && arriveTime < departTime) return undefined;
  return departDate;
}

function completeness(segment: ParsedFlightSegment): number {
  return [segment.originIata, segment.destinationIata, segment.departDate, segment.departTime, segment.arriveDate, segment.arriveTime].filter(Boolean).length;
}

export type FlightReading = {
  segments: ParsedFlightSegment[];
  airlineIata?: string;
  airlineName?: string;
  passengerNames: string[];
  yearAssumed: boolean;
  ambiguousDate?: string;
};

export function readFlight(prepared: Prepared, opts: { sentDate?: string; referenceDate?: string; isAirportCode?: (code: string) => boolean }): FlightReading {
  const { text } = prepared;
  const named = airlinesNamedIn(text);
  const dates = findDates(text, opts);
  const reader: Reader = { text, dates, isAirportCode: opts.isAirportCode };

  const designators = findDesignators(text, named).map((d) => ({
    ...d,
    // "Flight 1054" in an email from one airline takes that airline's code.
    code: d.code ?? (named.length === 1 ? named[0] : undefined),
  }));
  // A code nobody knows, with no "flight" word, was already left out; a labelled one is kept
  // only when it is a real airline or the single airline named.
  const believable = designators.filter((d) => !d.code || isKnownAirlineCode(d.code) || named.includes(d.code) || airlineName(d.code) !== null);

  // The same flight is often printed twice (a summary, then the details). Read every mention
  // and keep the fullest reading of each flight, in the order the flights first appear.
  const best = new Map<string, { segment: ParsedFlightSegment; order: number }>();
  believable.forEach((designator, i) => {
    const key = `${designator.code ?? "?"}${designator.number}`;
    const ownLineEnd = text.indexOf("\n", designator.index) === -1 ? text.length : text.indexOf("\n", designator.index);
    // Stop at the line of the next flight mentioned further down, and never read more than a few lines.
    const next = believable.slice(i + 1).find((other) => other.index > ownLineEnd);
    const nextLineStart = next ? text.lastIndexOf("\n", next.index) + 1 : text.length;
    const blockEnd = Math.min(nextLineStart, designator.index + 420, text.length);
    const segment = readSegment(reader, designator, blockEnd);
    const existing = best.get(key);
    if (!existing) best.set(key, { segment, order: i });
    else if (completeness(segment) > completeness(existing.segment)) best.set(key, { segment, order: existing.order });
  });
  const segments = [...best.values()].sort((a, b) => a.order - b.order).map((entry) => entry.segment);

  const first = segments.find((segment) => segment.airlineIata)?.airlineIata ?? named[0];
  return {
    segments,
    airlineIata: first,
    airlineName: first ? (airlineName(first) ?? undefined) : undefined,
    passengerNames: findPassengers(prepared.lines),
    yearAssumed: dates.some((hit) => hit.yearAssumed),
    ambiguousDate: dates.find((hit) => hit.ambiguous)?.raw,
  };
}

const PASSENGER_LABEL = /^(?:passengers?|travell?ers?|passenger names?|travell?er names?|names?)(?:\s*\(\d+\))?(?:\s+\d+)?\s*(?:[:\-–]\s*(.*))?$/i;
const NAME = /^[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*){1,3}$/;
const TITLES = /\s+(MR|MRS|MS|MISS|MSTR|DR|CHD|INF)\.?$/i;
// Headings and labels that sit where a name might: never a person.
const NOT_A_PERSON =
  /\b(your|flight|flights|details|itinerary|information|summary|trip|total|fare|fares|seat|seats|baggage|bags|contact|receipt|payment|ticket|number|confirmation|booking|date|class|cabin|economy|frequent|flyer|mileage|points|plan|status|check|airlines?|airways)\b/i;

function cleanName(raw: string, strict: boolean): string | null {
  let name = raw.replace(/\(.*?\)/g, "").replace(/\s{2,}/g, " ").trim().replace(TITLES, "");
  // Ticket style: "HARTLEY/LYDIA" is surname first.
  const slash = /^([A-Za-z'\- ]+)\/([A-Za-z'\- ]+)$/.exec(name);
  if (slash) name = `${slash[2].trim()} ${slash[1].trim()}`.replace(TITLES, "");
  if (!NAME.test(name) || name.length > 50 || NOT_A_PERSON.test(name)) return null;
  // Under a heading with no colon, only lines written like a name are taken: every word capitalised.
  if (strict && !slash && !name.split(/\s+/).every((word) => /^[A-Z]/.test(word))) return null;
  return titleCase(name);
}

/** Names that follow a "Passengers:" or "Traveler 1:" label. Nothing is taken from unlabelled text. */
function findPassengers(lines: readonly string[]): string[] {
  const names: string[] = [];
  const add = (raw: string, strict: boolean) => {
    const name = cleanName(raw, strict);
    if (name && !names.includes(name)) names.push(name);
  };
  for (let i = 0; i < lines.length; i++) {
    const match = PASSENGER_LABEL.exec(lines[i]);
    if (!match) continue;
    if (match[1]?.trim()) {
      match[1].split(/\s*(?:,|;|\band\b|&)\s*/).forEach((part) => add(part, false));
    } else {
      // A label on its own line: the names are the lines beneath, until one is not a name.
      for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
        const before = names.length;
        add(lines[j], true);
        if (names.length === before) break;
      }
    }
  }
  return names.slice(0, 20);
}
