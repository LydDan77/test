// Airlines: names for people, and the codes flight trackers want. Import from "@/lib/airlines".
//
// Names come from the installed `aviation-names` package (Wikidata, current), behind the one
// function below, with a small override map for the names it gets wrong or writes stiffly.
// ICAO codes come from the reviewed table in ./icao.ts. Pure: no network, no clock.

import { airline as lookUpAirlineName } from "aviation-names/airline";
import { IATA_TO_ICAO } from "./icao";

export { IATA_TO_ICAO, type AirlineCodeRow } from "./icao";

/**
 * Names that replace what the package returns. `null` hides a code completely.
 * Keep this short: add a row only when a real booking showed the wrong name.
 */
export const AIRLINE_NAME_OVERRIDES: Readonly<Record<string, string | null>> = {
  // The package returns the code's previous holder.
  OH: "PSA Airlines",
  // The package returns the legal name; these are what the airline calls itself.
  LY: "El Al",
  G7: "GoJet Airlines",
  ME: "Middle East Airlines",
  DE: "Condor",
  G3: "GOL",
  AD: "Azul",
  LX: "Swiss",
  QF: "Qantas",
  JQ: "Jetstar",
  BT: "airBaltic",
};

const IATA_AIRLINE_CODE = /^[A-Z0-9]{2}$/;

function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const cleaned = code.trim().toUpperCase();
  return IATA_AIRLINE_CODE.test(cleaned) ? cleaned : null;
}

/**
 * The airline's name for a two-character IATA code: `airlineName("AS")` is "Alaska Airlines".
 * Case and surrounding spaces do not matter. Returns null for a code nobody holds or anything
 * that is not a two-character code, so write `airlineName(code) ?? code` where a label is needed.
 */
export function airlineName(iata: string | null | undefined): string | null {
  const code = normalizeCode(iata);
  if (!code) return null;
  if (code in AIRLINE_NAME_OVERRIDES) return AIRLINE_NAME_OVERRIDES[code];
  try {
    return lookUpAirlineName(code);
  } catch {
    return null;
  }
}

/**
 * The three-letter ICAO code for an IATA airline code, when the reviewed table has it:
 * `airlineIcao("AS")` is "ASA". Null when unknown; callers fall back to the IATA code.
 */
export function airlineIcao(iata: string | null | undefined): string | null {
  const code = normalizeCode(iata);
  if (!code) return null;
  return IATA_TO_ICAO[code]?.icao ?? null;
}

// Other names people and emails use, beyond the full name. Only names that cannot be mistaken
// for something else: "American", "United", "Delta" and "Southwest" alone are left out on
// purpose ("American Express", "United States", "Delta Hotels", "Southwest Florida").
const EXTRA_NAMES: Readonly<Record<string, readonly string[]>> = {
  AA: ["American Airlines", "aa.com"],
  AS: ["Alaska Airlines", "Alaska Air", "alaskaair.com"],
  B6: ["JetBlue"],
  DL: ["Delta Air Lines", "Delta Airlines", "delta.com"],
  F9: ["Frontier Airlines", "flyfrontier.com"],
  G4: ["Allegiant"],
  HA: ["Hawaiian Airlines"],
  NK: ["Spirit Airlines"],
  SY: ["Sun Country"],
  UA: ["United Airlines", "united.com"],
  WN: ["Southwest Airlines", "southwest.com"],
  XP: ["Avelo"],
  MX: ["Breeze Airways"],
  AC: ["Air Canada"],
  WS: ["WestJet"],
  BA: ["British Airways"],
  VS: ["Virgin Atlantic"],
  LH: ["Lufthansa"],
  AF: ["Air France"],
  KL: ["KLM"],
  EI: ["Aer Lingus"],
  AM: ["Aeromexico", "Aeroméxico"],
  EK: ["Emirates"],
  QR: ["Qatar Airways"],
  TK: ["Turkish Airlines"],
  QF: ["Qantas"],
  NH: ["All Nippon Airways"],
  JL: ["Japan Airlines"],
  SQ: ["Singapore Airlines"],
  CX: ["Cathay Pacific"],
  LX: ["Swiss International Air Lines"],
  IB: ["Iberia"],
  Y4: ["Volaris"],
  VY: ["Vueling"],
};

// A bare brand word such as "Peach", "Swiss", "Viva" or "Condor" also turns up in grocery orders
// and hotel names, so a name from the package is only searched for when it reads like an airline.
const READS_LIKE_AN_AIRLINE = /air|jet|fly|aero|avia|wings/i;

type NameEntry = { iata: string; name: string; pattern: RegExp };

let nameIndex: NameEntry[] | null = null;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildNameIndex(): NameEntry[] {
  const entries: NameEntry[] = [];
  const seen = new Set<string>();
  const add = (iata: string, name: string) => {
    const key = `${iata}|${name.toLowerCase()}`;
    if (seen.has(key) || name.length < 3) return;
    seen.add(key);
    // Whole words only, so "Delta" does not match "Deltaville".
    entries.push({ iata, name, pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, "i") });
  };
  for (const iata of Object.keys(IATA_TO_ICAO)) {
    const name = airlineName(iata);
    if (name && READS_LIKE_AN_AIRLINE.test(name)) add(iata, name);
    for (const extra of EXTRA_NAMES[iata] ?? []) add(iata, extra);
  }
  // Longest names first, so "Delta Air Lines" is found before "Delta".
  return entries.sort((a, b) => b.name.length - a.name.length);
}

/**
 * One-word names people and airlines use in front of a flight number ("Alaska 1054",
 * "United 437"). On their own these words mean other things (a state, an adjective), so they
 * are NOT used to decide whether a text mentions an airline: only to read a flight number that
 * directly follows one. See flightNumbersByShortName.
 */
export const AIRLINE_SHORT_NAMES: Readonly<Record<string, string>> = {
  Alaska: "AS",
  American: "AA",
  United: "UA",
  Delta: "DL",
  Southwest: "WN",
  JetBlue: "B6",
  Frontier: "F9",
  Spirit: "NK",
  Hawaiian: "HA",
  Allegiant: "G4",
  Breeze: "MX",
  Avelo: "XP",
  "Sun Country": "SY",
};

/**
 * Flight numbers written as a short airline name and a number: "Alaska 1054", "UNITED 437",
 * "Delta flight 1423". Each hit gives the airline's IATA code, the number as printed, and where
 * it sits in the text.
 */
export function flightNumbersByShortName(text: string): Array<{ iata: string; number: string; index: number; end: number }> {
  const names = Object.keys(AIRLINE_SHORT_NAMES).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9])(${names.map(escapeRegExp).join("|")})\\s+(?:flight\\s+)?#?\\s?(\\d{1,4})(?![\\d:/%A-Za-z])`, "gi");
  const found: Array<{ iata: string; number: string; index: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const name = names.find((candidate) => candidate.toLowerCase() === match?.[1].toLowerCase());
    if (name) found.push({ iata: AIRLINE_SHORT_NAMES[name], number: match[2], index: match.index, end: match.index + match[0].length });
  }
  return found;
}

/** One place where an airline is named in a piece of text. */
export type AirlineMention = { iata: string; index: number; end: number };

/**
 * Every place the text names an airline from the reviewed table, in reading order. Where two
 * names overlap ("Delta Air Lines" contains "Delta") the longer one is kept.
 */
export function airlineMentions(text: string): AirlineMention[] {
  nameIndex ??= buildNameIndex();
  const found: AirlineMention[] = [];
  for (const entry of nameIndex) {
    const pattern = new RegExp(entry.pattern.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const hit = { iata: entry.iata, index: match.index, end: match.index + match[0].length };
      // The index is longest-first, so anything already found at this spot is at least as long.
      if (!found.some((other) => hit.index < other.end && other.index < hit.end)) found.push(hit);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * The airlines named in a piece of text (a confirmation email), as IATA codes in the order they
 * first appear. Only the carriers in the reviewed table are recognised, by full name or a common
 * short name. `airlinesNamedIn("Thanks for flying Alaska Airlines")` is `["AS"]`.
 */
export function airlinesNamedIn(text: string): string[] {
  nameIndex ??= buildNameIndex();
  const found = new Map<string, number>();
  for (const entry of nameIndex) {
    const match = entry.pattern.exec(text);
    if (!match) continue;
    const previous = found.get(entry.iata);
    if (previous === undefined || match.index < previous) found.set(entry.iata, match.index);
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([iata]) => iata);
}

/** True when the code is one of the carriers in the reviewed table. */
export function isKnownAirlineCode(iata: string | null | undefined): boolean {
  const code = normalizeCode(iata);
  return code !== null && code in IATA_TO_ICAO;
}
