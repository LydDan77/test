// Pieces every kind of confirmation shares: the code, the total, a street address, and telling
// which kind of booking the text is about.

import { airlinesNamedIn } from "@/lib/airlines";
import { parseMoneyInput, type Money } from "@/lib/domain";
import type { Prepared } from "./text";

export type ParsedKind = "flight" | "lodging" | "car" | "ride" | "meal";

// --- which kind -------------------------------------------------------------------------------------

type Clue = [pattern: RegExp, points: number];

const CLUES: Record<ParsedKind, Clue[]> = {
  flight: [
    [/\bflights?\b/i, 2],
    [/\b(boarding|e-?ticket|record locator|passengers?|nonstop|layover|seat\s?\d|departs?\b|arrives?\b)/i, 2],
    [/\b(terminal|gate|cabin|fare class|checked bag|carry-on)\b/i, 1],
    [/\b(airlines?|airways)\b/i, 2],
  ],
  lodging: [
    [/\bcheck[\s-]?out\b|\bcheckout\b/i, 3],
    [/\bcheck[\s-]?in\b/i, 1],
    [/\b\d+\s+nights?\b|\bnights?\b/i, 2],
    [/\b(hotel|resort|inn|suites?|lodge|villa|cabin|listing|hosted by|your host|front desk)\b/i, 2],
    [/\b(room type|king bed|queen beds?|guests?)\b/i, 1],
    [/\b(airbnb|vrbo|booking\.com|hotels\.com)\b/i, 3],
  ],
  car: [
    [/\b(car rental|rental car|rent a car|rental agreement|your rental)\b/i, 3],
    [/\bor similar\b/i, 3],
    [/\b(hertz|avis|budget rent|enterprise rent|enterprise car|national car|alamo|thrifty|sixt|turo|zipcar|europcar|dollar rent|dollar car)\b/i, 3],
    [/\b(vehicle|car class|mileage|fuel)\b/i, 1],
    [/\bpick[\s-]?up\b[\s\S]{0,400}\breturn\b/i, 1],
  ],
  ride: [
    [/\b(lyft)\b/i, 3],
    [/\buber\b(?!\s*eats)/i, 3],
    [/\b(thanks for riding|your ride|your trip with|trip fare|ride receipt|scheduled ride|ride details)\b/i, 3],
    [/\b(driver|fare|rideshare|shuttle|taxi)\b/i, 1],
    [/\bdrop[\s-]?off\b/i, 1],
  ],
  meal: [
    [/\b(doordash|grubhub|instacart|uber\s*eats|ezcater|postmates)\b/i, 4],
    [/\b(your order|order from|order details|order summary)\b/i, 2],
    [/\b(delivery (?:window|time|fee|address|instructions)|deliver(?:y|ed)? to|estimated delivery)\b/i, 2],
    [/\b(shopper|dasher|groceries|grocery|restaurant|catering|caterer|items?|subtotal|tip)\b/i, 1],
  ],
};

export function scoreKinds(text: string): Record<ParsedKind, number> {
  const scores: Record<ParsedKind, number> = { flight: 0, lodging: 0, car: 0, ride: 0, meal: 0 };
  for (const kind of Object.keys(CLUES) as ParsedKind[]) {
    for (const [pattern, points] of CLUES[kind]) if (pattern.test(text)) scores[kind] += points;
  }
  if (airlinesNamedIn(text).length > 0) scores.flight += 3;
  return scores;
}

/** The kind the text is most likely about, how far ahead of the runner-up it is, or null when nothing stands out. */
export function detectKind(text: string): { kind: ParsedKind | null; margin: number } {
  const ranked = (Object.entries(scoreKinds(text)) as Array<[ParsedKind, number]>).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 3) return { kind: null, margin: 0 };
  return { kind: best[0], margin: best[1] - second[1] };
}

// --- the code ---------------------------------------------------------------------------------------

const STRONG_CODE_LABELS = [
  /confirmation\s*(?:code|number|no\.?|num\.?|#)/i,
  /record locator/i,
  /booking\s*(?:reference|ref\.?|code|number|no\.?|id|#)/i,
  /reservation\s*(?:number|code|no\.?|id|#)/i,
  /\bPNR\b/,
  /\bconf(?:irmation)?\.?\s*(?:#|no\.?)/i,
  /confirmation/i,
];
const WEAK_CODE_LABELS = [/itinerary\s*(?:number|no\.?|#)/i, /rental agreement\s*(?:number|no\.?|#)?/i, /reference\s*(?:number|code|no\.?|#)/i, /trip id/i];
const ORDER_LABELS = [/order\s*(?:number|no\.?|id|#)/i, /\border\b\s*#/i];

const NOT_A_CODE = new Set(["NUMBER", "DETAIL", "STATUS", "PLEASE", "THANKS", "FLIGHT", "TRAVEL", "TICKET", "RETURN", "PICKUP", "CODE", "EMAIL", "BELOW", "ABOVE", "YOUR"]);

function codeIn(text: string, lettersOnlyAllowed: boolean): string | undefined {
  for (const token of text.match(/(?<![A-Za-z0-9])[A-Z0-9][A-Z0-9-]{3,19}(?![A-Za-z0-9])/g) ?? []) {
    // A phone number after "confirmation" ("questions? call 1-800-555-0199") is not a code.
    if (/^(\d-)?\d{3}-\d{3}-\d{4}$/.test(token)) continue;
    const hasDigit = /\d/.test(token);
    const hasLetter = /[A-Z]/.test(token);
    if (NOT_A_CODE.has(token)) continue;
    if (hasDigit && (hasLetter || token.replace(/-/g, "").length >= 5)) return token;
    // Airline record locators are often six letters with no digit.
    if (!hasDigit && lettersOnlyAllowed && /^[A-Z]{6}$/.test(token)) return token;
  }
  return undefined;
}

function findLabelled(lines: readonly string[], labels: readonly RegExp[], lettersOnlyAllowed: boolean): string | undefined {
  for (const label of labels) {
    for (let i = 0; i < lines.length; i++) {
      const match = label.exec(lines[i]);
      if (!match) continue;
      const rest = lines[i].slice(match.index + match[0].length);
      // "Confirmation code: KXWQPL", "Confirmation # 83124477", "Your confirmation number is 4471-22"
      const sameLine = codeIn(rest.slice(0, 60), lettersOnlyAllowed);
      if (sameLine) return sameLine;
      // A label on its own line with the code beneath it.
      if (rest.replace(/[\s:#\-–—]/g, "") === "" && i + 1 < lines.length && lines[i + 1].length <= 24) {
        const below = codeIn(lines[i + 1], lettersOnlyAllowed);
        if (below) return below;
      }
    }
  }
  return undefined;
}

/** The confirmation code, when a label clearly points at it. Never guessed from an unlabelled string. */
export function findConfirmationCode(prepared: Prepared): string | undefined {
  return findLabelled(prepared.lines, STRONG_CODE_LABELS, true) ?? findLabelled(prepared.lines, WEAK_CODE_LABELS, false);
}

/** An order number ("Order #4471-2290"), then any confirmation code. */
export function findOrderNumber(prepared: Prepared): string | undefined {
  return findLabelled(prepared.lines, ORDER_LABELS, false) ?? findConfirmationCode(prepared);
}

// --- the total --------------------------------------------------------------------------------------

const TOTAL_LABELS = [
  /\bgrand total\b/i,
  /\btotal\s+(?:charged|paid|price|cost|due|amount|fare|for (?:your )?stay|\(\w{3}\))/i,
  /\b(?:trip|order|estimated|reservation|rental)\s+total\b/i,
  /\bamount\s+(?:paid|charged|due)\b/i,
  /\btotal\b/i,
];
const CURRENCY = "US\\$|CA\\$|C\\$|USD|CAD|EUR|GBP|[$€£]";
const AMOUNT = new RegExp(`(${CURRENCY})?\\s?(?<![\\d.,])(\\d[\\d.,]*\\d|\\d)(?![\\d]|[.,]\\d)\\s?(USD|CAD|EUR|GBP)?`, "g");

function currencyOf(before: string | undefined, after: string | undefined, fallback: string): string | null {
  const mark = after ?? before;
  switch (mark) {
    case "USD":
    case "US$":
      return "USD";
    case "CAD":
    case "CA$":
    case "C$":
      return "CAD";
    case "EUR":
    case "€":
      return "EUR";
    case "GBP":
    case "£":
      return "GBP";
    case "$":
      return fallback;
    default:
      return null;
  }
}

/** "1,284.40" and "1.482,60" both to "1284.40"; anything that is not clearly an amount to null. */
function normaliseAmount(raw: string): string | null {
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{2})?$/.test(raw) || /^\d+(?:\.\d{2})?$/.test(raw)) return raw.replace(/,/g, "");
  // Continental style: dots for thousands, a comma before the cents.
  if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(raw) || /^\d+,\d{2}$/.test(raw)) return raw.replace(/\./g, "").replace(",", ".");
  return null;
}

/**
 * The total paid, from a line that says so ("Total: $1,284.40", "Amount paid 412.18 USD",
 * "Total price: EUR 1.482,60"). A subtotal is never taken for the total, and a number with no
 * currency beside it is never taken for money. A bare "$" is read as `dollarCurrency` (USD unless
 * the caller says otherwise). Returns nothing when no line clearly gives a total.
 */
export function findTotal(prepared: Prepared, dollarCurrency = "USD"): Money | undefined {
  for (const label of TOTAL_LABELS) {
    // Totals come last on a receipt, so read from the bottom.
    for (let i = prepared.lines.length - 1; i >= 0; i--) {
      const line = prepared.lines[i];
      const match = label.exec(line);
      if (!match || /\bsub[\s-]?total\b/i.test(line)) continue;
      const candidates = [line.slice(match.index + match[0].length)];
      // "Total" on one line and the amount on the next.
      if (!/\d/.test(candidates[0]) && i + 1 < prepared.lines.length && prepared.lines[i + 1].length <= 20) candidates.push(prepared.lines[i + 1]);
      for (const candidate of candidates) {
        // A range ("$52 - $61") is an estimate, not a total.
        if (/\d\s*[-–—]\s*[$€£]?\s?\d/.test(candidate)) continue;
        for (const amount of candidate.matchAll(AMOUNT)) {
          const currency = currencyOf(amount[1], amount[3], dollarCurrency);
          const value = normaliseAmount(amount[2]);
          if (!currency || !value) continue;
          const money = parseMoneyInput(value, currency);
          if (money && money.amount > 0) return money;
        }
      }
    }
  }
  return undefined;
}

// --- a street address ---------------------------------------------------------------------------------

const STREET_WORD = "(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Way|Parkway|Pkwy|Court|Ct|Place|Pl|Highway|Hwy|Trail|Trl|Circle|Cir|Terrace|Ter|Square|Sq|Loop|Plaza|Pike|Run)";
const US_ADDRESS = new RegExp(
  `(\\d{1,6}\\s+[A-Za-z0-9 .'#-]{2,50}?\\b${STREET_WORD}\\b\\.?(?:[ ,]+(?:Suite|Ste|Apt|Unit|#)\\.?\\s?[A-Za-z0-9-]+)?)[,\\s]+([A-Za-z .'-]{2,40}?),\\s*([A-Z]{2})\\s+(\\d{5}(?:-\\d{4})?)`,
  "g",
);

export type FoundAddress = { text: string; index: number; end: number };

/** Every US street address in the text ("1420 Lake Shore Dr, Orlando, FL 32801"), in reading order. */
export function findAddresses(text: string): FoundAddress[] {
  const found: FoundAddress[] = [];
  let m: RegExpExecArray | null;
  US_ADDRESS.lastIndex = 0;
  while ((m = US_ADDRESS.exec(text))) {
    const street = m[1].replace(/\s+/g, " ").trim();
    const city = m[2].replace(/\s+/g, " ").trim();
    found.push({ text: `${street}, ${city}, ${m[3]} ${m[4]}`, index: m.index, end: m.index + m[0].length });
  }
  return found;
}

/** A provider named in the text, by its usual spelling. */
export function findName(text: string, names: ReadonlyArray<readonly [pattern: RegExp, name: string]>): string | undefined {
  let best: { index: number; name: string } | undefined;
  for (const [pattern, name] of names) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.index)) best = { index: match.index, name };
  }
  return best?.name;
}
