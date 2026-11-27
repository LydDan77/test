// Recognising a tracking number she pastes, and linking to the carrier's tracking page.
//
// Ported from research/ship-ahead-code/tracking.mjs, which follows jkeen/tracking_number_data
// (as bundled in npm ts-tracking-number@1.0.17) plus the formats UPS, USPS, Canada Post and
// Royal Mail publish themselves. The reference passes that project's 97 valid and invalid test
// numbers; so does this port (tracking.test.ts runs the same vectors).
//
// The app cannot read where a parcel is: carrier tracking APIs all need keys. A tracking number
// becomes a link, and she sets "shipped" and "arrived" herself.

import { TRACKING_CARRIERS, TRACKING_LINKS, type TrackingCarrier } from "./config";
import { carrierName } from "./words";


/** Upper case, with everything that is not a digit or a letter removed. What to store. */
export function normalizeTrackingNumber(raw: unknown): string {
  return String(raw ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** True for one of the eight carriers the app can link to. */
export function isTrackingCarrier(value: unknown): value is TrackingCarrier {
  return typeof value === "string" && (TRACKING_CARRIERS as readonly string[]).includes(value);
}

// --- check digits (report 4.3) -------------------------------------------------------------------

/** A character's value in the mod-10 schemes: digits as they are; letters by (code - 3) mod 10, so A=2 … H=9, I=0, J=1. */
function charValue(ch: string): number {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57 ? code - 48 : (code - 3) % 10;
}

/** Positions are 0-based: even positions times `evens`, odd times `odds`; check = (10 - sum mod 10) mod 10. */
function mod10(serial: string, evens: number, odds: number): number {
  let sum = 0;
  for (let i = 0; i < serial.length; i++) sum += charValue(serial[i]) * (i % 2 === 0 ? evens : odds);
  return (10 - (sum % 10)) % 10;
}

function weighted(serial: string, weights: readonly number[], firstModulus: number, secondModulus: number): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += (serial.charCodeAt(i) - 48) * weights[i];
  return (sum % firstModulus) % secondModulus;
}

/** The whole number modulo 7, by long division so no big-number type is needed. */
function mod7(serial: string): number {
  let remainder = 0;
  for (let i = 0; i < serial.length; i++) remainder = (remainder * 10 + (serial.charCodeAt(i) - 48)) % 7;
  return remainder;
}

/** The UPU S10 check digit of an eight-digit serial. */
function s10Check(eightDigits: string): number {
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += (eightDigits.charCodeAt(i) - 48) * weights[i];
  const remainder = sum % 11;
  return remainder === 1 ? 0 : remainder === 0 ? 5 : 11 - remainder;
}

/** The Luhn test that payment card numbers pass. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let value = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  }
  return sum % 10 === 0;
}

const lastDigit = (s: string) => s.charCodeAt(s.length - 1) - 48;
const FEDEX_12_WEIGHTS = [3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1];
const FEDEX_34_WEIGHTS = [1, 7, 3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1];

// ISO 3166-1 alpha-2: a UPU S10 number must end in one of these.
const ISO2 = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
    "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

/** The S10 country suffixes the app can link to. Every other post has no universal tracking link. */
const S10_CARRIER: Record<string, TrackingCarrier> = { US: "usps", GB: "royalmail", CA: "canadapost" };

/** Names of the national posts people most often get parcels from. Others read "the post in XX". */
const POST_NAMES: Record<string, string> = {
  AU: "Australia Post", CN: "China Post", DE: "Deutsche Post", ES: "Correos", FR: "La Poste", HK: "Hongkong Post",
  IE: "An Post", IN: "India Post", IT: "Poste Italiane", JP: "Japan Post", KR: "Korea Post", MX: "Correos de México",
  NL: "PostNL", NZ: "NZ Post", SG: "SingPost", CH: "Swiss Post",
};

// --- detection -------------------------------------------------------------------------------------

export type TrackingConfidence = "high" | "medium" | "low";

export type TrackingCandidate = {
  /** One of the eight carriers the app links to, or "other" for another country's post. */
  carrier: TrackingCarrier | "other";
  /** For people: "UPS", "Royal Mail", "Japan Post". */
  carrierName: string;
  /** How sure the format makes us. Show "high" as fact, "medium" as "looks like", "low" as a guess. */
  confidence: TrackingConfidence;
  /** `pass`: the check digit agrees. `fail`: it does not, so suspect a typo. `none`: the format has none. */
  checkDigit: "pass" | "fail" | "none";
  /** The format matched, for logs and tests. Not for people. */
  format: string;
  /** The normalized number. */
  number: string;
  /** The carrier's tracking page for this number, or null for a post the app cannot link to. */
  url: string | null;
  /** For carrier "other": the ISO country code of the post that issued the number. */
  postCountryCode?: string;
};

export type TrackingDetection = {
  /** The normalized number: what to store in parcel.trackingNumber. */
  number: string;
  /** Possible carriers, best first. Empty when the number is not recognised. */
  candidates: TrackingCandidate[];
  /** The first candidate, or null. Store best.carrier in parcel.carrierDetected. */
  best: TrackingCandidate | null;
  /**
   * True when she should confirm the carrier before it is trusted: the number has one of the
   * shapes several carriers share (9, 10, 11, 12 or 16 digits), the match is only a guess, or
   * the check digit failed. Show `message` and let her pick from `candidates`.
   */
  needsConfirmation: boolean;
  /** One plain sentence to show beside the number, or null when there is nothing to say. */
  message: string | null;
  /** For a UPS number whose check digit fails: nearby numbers that do pass (O/0, I/1, S/5, B/8 swaps). */
  suggestions: string[];
  /** True for 16 digits that pass the card-number test. Never store it without asking. */
  looksLikeCardNumber: boolean;
};

export type DetectCarrierOptions = {
  /**
   * Where the parcel is going (ISO country code). An international postal number is tracked by
   * the sender's post first and by the destination's post after it lands; when this is "US"
   * (the default) USPS is offered as a second link.
   */
  destinationCountryCode?: string;
  /** The carrier she already chose. If the number could be theirs, it goes first and needs no confirming. */
  preferCarrier?: TrackingCarrier | null;
};

/** All-digit lengths that several carriers share (report 4.5): always confirm. */
const SHARED_LENGTHS = new Set([9, 10, 11, 12, 16]);

function candidatesFor(n: string, destinationCountryCode: string): TrackingCandidate[] {
  const out: TrackingCandidate[] = [];
  const add = (
    carrier: TrackingCarrier,
    format: string,
    confidence: TrackingConfidence,
    checkDigit: TrackingCandidate["checkDigit"],
    number = n,
  ) => {
    out.push({ carrier, carrierName: carrierName(carrier), confidence, checkDigit, format, number, url: trackingUrl(carrier, number) });
  };

  // ---- formats a prefix makes unmistakable ----
  if (/^1Z[0-9A-Z]{16}$/.test(n)) {
    const ok = /[0-9]/.test(n[17]) && mod10(n.slice(2, 17), 1, 2) === charValue(n[17]);
    if (ok) add("ups", "UPS 1Z", "high", "pass");
    else add("ups", "UPS 1Z (check digit failed)", "low", "fail");
    return out;
  }
  if (/^TB[ACM]\d{12}$/.test(n)) {
    add("amazon", "Amazon Logistics", "high", "none");
    return out;
  }
  if (/^C\d{14}$/.test(n)) {
    const ok = mod10("4" + n.slice(1, 14), 1, 2) === lastDigit(n);
    add("ontrac", "OnTrac C+14", ok ? "high" : "medium", ok ? "pass" : "fail");
    return out;
  }
  if (/^D\d{14}$/.test(n)) {
    add("ontrac", "OnTrac D+14", "medium", "none");
    return out;
  }
  if (/^1LS[0-9A-Z]{9,20}$/.test(n)) {
    add("ontrac", "OnTrac (LaserShip 1LS)", "high", "none");
    return out;
  }
  if (/^DT\d{12}$/.test(n)) {
    add("fedex", "FedEx door tag", "high", "none");
    return out;
  }
  if (/^T\d{10}$/.test(n)) {
    add("ups", "UPS T+10", "medium", "none");
    return out;
  }
  if (/^JJD\d{10,}$/.test(n) || /^JD\d{18}$/.test(n)) {
    add("dhl", "DHL piece ID", "medium", "none");
    return out;
  }
  const s10 = /^([A-Z]{2})(\d{8})(\d)([A-Z]{2})$/.exec(n);
  if (s10) {
    const country = s10[4];
    const ok = s10Check(s10[2]) === Number(s10[3]) && ISO2.has(country);
    const confidence: TrackingConfidence = ok ? "high" : "low";
    const checkDigit = ok ? "pass" : "fail";
    const format = `UPU S10 (${s10[1]}...${country})`;
    const linked = S10_CARRIER[country];
    if (linked) {
      add(linked, format, confidence, checkDigit);
    } else {
      out.push({
        carrier: "other",
        carrierName: POST_NAMES[country] ?? `The post in ${country}`,
        confidence, checkDigit, format, number: n, url: null, postCountryCode: country,
      });
    }
    // Once it lands, the destination's post tracks it under the same number.
    if (ok && linked !== "usps" && destinationCountryCode === "US") {
      add("usps", "UPU S10, after it reaches the US", "medium", "pass");
    }
    return out;
  }

  if (!/^\d+$/.test(n)) return out; // letters and digits in no known shape
  // 000…0 style placeholders pass mod-10 trivially.
  if (/^(\d)\1+$/.test(n) || (n.match(/0/g) ?? []).length >= n.length - 3) return out;

  // ---- all digits: decide by length, then prefix, then check digit ----
  switch (n.length) {
    case 34:
      if (n.startsWith("420")) {
        // 420 + ZIP5 + route4 + the 22-digit number
        const ok = mod10(n.slice(12, 33), 3, 1) === lastDigit(n);
        add("usps", "USPS IMpb 34 (420+ZIP+4)", ok ? "high" : "medium", ok ? "pass" : "fail");
      } else if (weighted(n.slice(20, 33), FEDEX_34_WEIGHTS, 11, 10) === lastDigit(n)) {
        add("fedex", n.startsWith("96") ? "FedEx Ground GSN 34" : "FedEx Express 34", "high", "pass");
      }
      break;
    case 30:
      if (n.startsWith("420")) {
        // 420 + ZIP5 + the 22-digit number
        const ok = mod10(n.slice(8, 29), 3, 1) === lastDigit(n);
        add("usps", "USPS IMpb 30 (420+ZIP5)", ok ? "high" : "medium", ok ? "pass" : "fail");
      }
      break;
    case 26:
      if (/^9[1-5]/.test(n)) {
        const ok = mod10(n.slice(0, 25), 3, 1) === lastDigit(n);
        add("usps", "USPS IMpb 26", ok ? "high" : "medium", ok ? "pass" : "fail");
      }
      break;
    case 22:
      if (n.startsWith("96")) {
        const ok = mod10(n.slice(7, 21), 1, 3) === lastDigit(n);
        add("fedex", "FedEx Ground 96 (22)", ok ? "high" : "medium", ok ? "pass" : "fail");
      } else if (/^9[1-5]/.test(n)) {
        const ok = mod10(n.slice(0, 21), 3, 1) === lastDigit(n);
        add("usps", "USPS IMpb 22", ok ? "high" : "medium", ok ? "pass" : "fail");
        // The same shape is used when USPS carries the last mile for FedEx Ground Economy.
        if (n.startsWith("92")) add("fedex", "FedEx Ground Economy (USPS final mile)", "low", ok ? "pass" : "fail");
      }
      break;
    case 20: {
      const body = n.slice(0, 19);
      const check = lastDigit(n);
      if (mod10(body, 3, 1) === check) add("usps", "USPS 20", "high", "pass");
      else if (mod10("91" + body, 3, 1) === check) add("usps", "USPS 20 (implied 91)", "high", "pass");
      else if (mod10("92" + body, 3, 1) === check) {
        add("fedex", "FedEx Ground Economy 20", "high", "pass");
        // USPS tracks the same parcel as 92 + the number.
        add("usps", "USPS (92 + number)", "medium", "pass", "92" + n);
      } else add("usps", "USPS 20 (check digit failed)", "low", "fail");
      break;
    }
    case 18:
      if (mod10(n.slice(2, 17), 3, 1) === lastDigit(n) && /^0[0-4]/.test(n)) add("fedex", "FedEx Ground SSCC-18", "medium", "pass");
      break;
    case 16:
      add("canadapost", "Canada Post 16-digit", "medium", "none");
      break;
    case 15:
      if (mod10(n.slice(0, 14), 1, 3) === lastDigit(n)) add("fedex", "FedEx Ground 15", "high", "pass");
      else add("fedex", "FedEx Ground 15 (check digit failed)", "low", "fail");
      break;
    case 12:
      if (weighted(n.slice(0, 11), FEDEX_12_WEIGHTS, 11, 10) === lastDigit(n)) add("fedex", "FedEx 12", "high", "pass");
      add("ups", "UPS 12-digit", "low", "none");
      add("canadapost", "Canada Post Priority Worldwide 12", "low", "none");
      break;
    case 11:
      if (mod7(n.slice(0, 10)) === lastDigit(n)) add("dhl", "DHL Express 11", "medium", "pass");
      break;
    case 10:
      if (mod7(n.slice(0, 9)) === lastDigit(n)) add("dhl", "DHL Express waybill", "high", "pass");
      else add("dhl", "DHL Express waybill (check failed)", "low", "fail");
      break;
    case 9:
      add("ups", "UPS 9-digit", "low", "none");
      add("dhl", "DHL 9-digit", "low", "none");
      break;
  }
  return out;
}

/** Characters people mistype in a UPS number, each way round. */
const LOOKALIKES: Record<string, string> = { O: "0", "0": "O", I: "1", "1": "I", S: "5", "5": "S", B: "8", "8": "B" };

/** For a UPS 1Z number that fails its check digit: the single-character fixes that make it pass. */
function upsSuggestions(n: string): string[] {
  const found = new Set<string>();
  for (let i = 2; i < n.length; i++) {
    const swap = LOOKALIKES[n[i]];
    if (!swap) continue;
    const tried = n.slice(0, i) + swap + n.slice(i + 1);
    if (/[0-9]/.test(tried[17]) && mod10(tried.slice(2, 17), 1, 2) === charValue(tried[17])) found.add(tried);
  }
  return [...found];
}

function messageFor(n: string, candidates: TrackingCandidate[], needsConfirmation: boolean, card: boolean, suggestions: string[]): string | null {
  if (n.length === 0) return null;
  if (card) return "This looks like a card number, not a tracking number. Check what you pasted.";
  const best = candidates[0];
  if (!best) return "No carrier uses a number shaped like this. Check it, or save it and pick the carrier yourself.";
  if (!needsConfirmation) return null;
  if (best.checkDigit === "fail") {
    if (suggestions.length > 0) {
      return `This looks like a ${best.carrierName} number with a typo. Did you mean ${suggestions[0]}?`;
    }
    return `This looks like a ${best.carrierName} number, but one character seems off. Check it against your receipt.`;
  }
  if (best.confidence === "high") return `This looks like a ${best.carrierName} number. Is that right?`;
  const names = [...new Set(candidates.map((candidate) => candidate.carrierName))];
  if (names.length === 1) return `This could be a ${names[0]} number. Is ${names[0]} carrying it?`;
  return `The number alone doesn't say who is carrying this. Is it ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?`;
}

/**
 * Works out which carrier a tracking number belongs to, checking its check digit where the
 * format has one. Spaces, dashes and lower case are fine: "1z 999 aa1 01 2345 678 4" works.
 *
 *   const found = detectCarrier(pasted);
 *   found.best?.carrier       // "ups": store in parcel.carrierDetected
 *   found.best?.url           // the carrier's tracking page
 *   found.needsConfirmation   // true: show found.message and let her choose from found.candidates
 *
 * Never throws. An empty or unknown number gives no candidates.
 */
export function detectCarrier(trackingNumber: unknown, options: DetectCarrierOptions = {}): TrackingDetection {
  const number = normalizeTrackingNumber(trackingNumber);
  let candidates = number ? candidatesFor(number, options.destinationCountryCode ?? "US") : [];

  const looksLikeCardNumber = /^\d{16}$/.test(number) && passesLuhn(number);
  const suggestions = candidates[0]?.carrier === "ups" && candidates[0].checkDigit === "fail" ? upsSuggestions(number) : [];

  let confirmedByChoice = false;
  if (options.preferCarrier && candidates.some((candidate) => candidate.carrier === options.preferCarrier)) {
    const chosen = candidates.filter((candidate) => candidate.carrier === options.preferCarrier);
    candidates = [...chosen, ...candidates.filter((candidate) => candidate.carrier !== options.preferCarrier)];
    confirmedByChoice = chosen[0].checkDigit !== "fail";
  }

  const best = candidates[0] ?? null;
  const sharedShape = /^\d+$/.test(number) && SHARED_LENGTHS.has(number.length);
  const needsConfirmation =
    looksLikeCardNumber ||
    (best !== null && !confirmedByChoice && (best.confidence !== "high" || best.checkDigit === "fail" || sharedShape));

  return {
    number,
    candidates,
    best,
    needsConfirmation,
    message: messageFor(number, candidates, needsConfirmation, looksLikeCardNumber, suggestions),
    suggestions,
    looksLikeCardNumber,
  };
}

/**
 * The carrier's tracking page for a number, or null when the carrier is not one the app links to
 * (a luggage service, "other", an empty number). The number is normalized and URL-encoded.
 *
 *   trackingUrl("ups", "1z 999 aa1 01 2345 678 4")
 *     -> "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784"
 *
 * Takes any string for `carrier`, because parcel.carrierDetected and bookings.provider are stored
 * as text. Always show the number as copyable text beside the link: none of these links was
 * click-tested (see TRACKING_LINKS in ./config).
 */
export function trackingUrl(carrier: string | null | undefined, trackingNumber: unknown): string | null {
  if (!isTrackingCarrier(carrier)) return null;
  const number = normalizeTrackingNumber(trackingNumber);
  if (!number) return null;
  return TRACKING_LINKS[carrier].template.replace("{n}", encodeURIComponent(number));
}

/**
 * The link to show for a parcel: where it goes and what the button says ("Track on UPS").
 * Null when there is no number or the carrier has no tracking page the app knows.
 */
export function trackingLink(
  carrier: string | null | undefined,
  trackingNumber: unknown,
): { url: string; label: string; fallbackUrl: string } | null {
  const url = trackingUrl(carrier, trackingNumber);
  if (!url || !isTrackingCarrier(carrier)) return null;
  return { url, label: `Track on ${carrierName(carrier)}`, fallbackUrl: TRACKING_LINKS[carrier].fallback };
}

// --- finding a number inside pasted text -----------------------------------------------------------

const CARRIER_KEYWORDS: readonly { pattern: RegExp; carrier: TrackingCarrier }[] = [
  { pattern: /\bUPS\b/i, carrier: "ups" },
  { pattern: /\bFED\s?EX\b/i, carrier: "fedex" },
  { pattern: /\bUSPS\b|\bPOSTAL SERVICE\b/i, carrier: "usps" },
  { pattern: /\bDHL\b/i, carrier: "dhl" },
  { pattern: /\bAMAZON\b/i, carrier: "amazon" },
  { pattern: /\bONTRAC\b|\bLASERSHIP\b/i, carrier: "ontrac" },
  { pattern: /\bCANADA POST\b/i, carrier: "canadapost" },
  { pattern: /\bROYAL MAIL\b/i, carrier: "royalmail" },
];

/** How far around a number to look for a carrier's name (report 4.5). */
const KEYWORD_REACH = 80;

/**
 * Finds tracking numbers inside pasted text, such as a shipping confirmation email. A number
 * written in groups ("9400 1112 0108 0805 4830 16") is read as one. A carrier's name within 80
 * characters settles which carrier it is.
 *
 * Careful by design: a bare 10- or 12-digit number with no carrier named nearby is ignored,
 * because phone numbers and order numbers look the same. Returns the detections in the order
 * they appear, without repeats.
 */
export function findTrackingNumbers(text: string, options: DetectCarrierOptions = {}): TrackingDetection[] {
  // Tokens made only of capitals, digits and dashes, with punctuation trimmed off the ends.
  const tokens: { value: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    tokens.push({ value: match[0].replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, ""), start, end: start + match[0].length });
  }
  const isPiece = (value: string) => value.length > 0 && /^[0-9A-Z-]+$/.test(value);
  const allDigits = (value: string) => /^[0-9-]+$/.test(value);

  const hits: { at: number; detection: TrackingDetection }[] = [];
  for (let first = 0; first < tokens.length; first++) {
    if (!isPiece(tokens[first].value)) continue;
    // A run of neighbouring pieces: one number written in groups, or a number among capitals.
    let last = first;
    while (last + 1 < tokens.length && last - first < 15 && isPiece(tokens[last + 1].value)) last++;

    const used = new Set<number>();
    // Longest stretch first, so a whole number wins over a piece of it.
    for (let length = last - first + 1; length >= 1; length--) {
      for (let a = first; a + length - 1 <= last; a++) {
        const b = a + length - 1;
        const stretch = tokens.slice(a, b + 1);
        if (stretch.some((_, offset) => used.has(a + offset))) continue;
        const joined = stretch.map((token) => token.value).join("");
        if (joined.length < 9 || joined.length > 40 || !/\d/.test(joined)) continue;
        // A run of digit groups is one number: never read part of it as a number of its own.
        if (allDigits(joined)) {
          const before = a > first ? tokens[a - 1].value : "";
          const after = b < last ? tokens[b + 1].value : "";
          if ((before && allDigits(before)) || (after && allDigits(after))) continue;
        }
        const nearby = text.slice(Math.max(0, tokens[a].start - KEYWORD_REACH), tokens[b].end + KEYWORD_REACH);
        const named = CARRIER_KEYWORDS.filter((keyword) => keyword.pattern.test(nearby)).map((keyword) => keyword.carrier);
        let detection = detectCarrier(joined, options);
        const namedMatch = named.find((carrier) => detection.candidates.some((candidate) => candidate.carrier === carrier));
        if (namedMatch) detection = detectCarrier(joined, { ...options, preferCarrier: namedMatch });
        if (detection.best === null || detection.needsConfirmation || detection.looksLikeCardNumber) continue;
        for (let index = a; index <= b; index++) used.add(index);
        hits.push({ at: tokens[a].start, detection });
      }
    }
    first = last;
  }

  const seen = new Set<string>();
  return hits
    .sort((x, y) => x.at - y.at)
    .map((hit) => hit.detection)
    .filter((detection) => (seen.has(detection.number) ? false : (seen.add(detection.number), true)));
}
