// Money: an integer number of minor units (cents) plus an ISO 4217 currency. Never a float.

import { z } from "zod";
import { currencySchema } from "./common";

/**
 * The largest amount the app stores, in minor units: a million million. The money columns are
 * 64-bit, so this is a limit of sense, not of storage: it keeps sums of many amounts inside the
 * whole numbers JavaScript can hold exactly, and still fits a budget in a currency with no
 * decimals (1,000,000,000,000 VND is about 40 million US dollars).
 */
export const MAX_MONEY_MINOR_UNITS = 1_000_000_000_000;

export const moneySchema = z.object({
  /** Minor units: 1234 is $12.34. Whole numbers only; negative means a refund or credit. */
  amount: z.number().int().min(-MAX_MONEY_MINOR_UNITS).max(MAX_MONEY_MINOR_UNITS),
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;

const fractionDigitsCache = new Map<string, number>();

/** How many decimal places a currency uses: 2 for USD, 0 for JPY, 3 for KWD. */
export function minorUnitDigits(currency: string): number {
  let digits = fractionDigitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    fractionDigitsCache.set(currency, digits);
  }
  return digits;
}

/**
 * "$1,234.50", "¥1,235", "€12.00". `locale` defaults to en-US so server and browser agree.
 *
 * Never throws. The currency columns are plain text, so a stored value that is not a currency
 * code ("dollars", "") is shown as a plain number followed by whatever was stored ("12.34 dollars")
 * instead of taking down every page that formats it.
 */
export function formatMoney(money: Money, locale = "en-US"): string {
  const digits = minorUnitDigits(money.currency);
  const value = money.amount / 10 ** digits;
  for (const tryLocale of [locale, "en-US"]) {
    try {
      return new Intl.NumberFormat(tryLocale, { style: "currency", currency: money.currency }).format(value);
    } catch {
      // An unknown locale: try en-US. An unusable currency: fall through to the plain number.
    }
  }
  const plain = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const code = String(money.currency ?? "").trim();
  return code ? `${plain} ${code}` : plain;
}

// --- reading an amount a person typed -------------------------------------------------------------

const markerCache = new Map<string, RegExp[]>();

/** What may stand before or after the number: a currency sign, or this currency's own code or symbol. */
function currencyMarkers(currency: string): RegExp[] {
  let markers = markerCache.get(currency);
  if (!markers) {
    const words = new Set<string>([currency]);
    for (const currencyDisplay of ["symbol", "narrowSymbol"] as const) {
      try {
        const part = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay })
          .formatToParts(0)
          .find((p) => p.type === "currency");
        if (part) words.add(part.value);
      } catch {
        // Not a currency Intl knows: only the generic signs below apply.
      }
    }
    const escaped = [...words].filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Any currency sign, alone or after a short country prefix: "$", "US$", "CA$", "R$".
    const alternatives = [...escaped, "[A-Za-z]{0,3}\\p{Sc}"].join("|");
    markers = [new RegExp(`^(?:${alternatives})\\s*`, "iu"), new RegExp(`\\s*(?:${alternatives})$`, "iu")];
    markerCache.set(currency, markers);
  }
  return markers;
}

const GROUPS_OF_THREE = /^[1-9]\d{0,2}(?:\d{3})*$/;

/** "1,234,567" (or the Indian "12,34,567") split on its separator: are these valid digit groups? */
function validGroups(groups: string[]): boolean {
  if (groups.length < 2) return false;
  const [first, ...rest] = groups;
  if (!/^[1-9]\d{0,2}$/.test(first)) return false;
  if (rest.every((group) => /^\d{3}$/.test(group))) return true;
  // Lakh and crore grouping: two digits per group, three in the last.
  const last = rest[rest.length - 1];
  return first.length <= 2 && /^\d{3}$/.test(last) && rest.slice(0, -1).every((group) => /^\d{2}$/.test(group));
}

/**
 * Splits the digits a person typed into the whole part and the decimal part, deciding from the
 * text itself which separator is which. Null when the text is not one unambiguous number.
 */
function splitNumber(body: string, digits: number): { whole: string; fraction: string } | null {
  // Spaces and apostrophes only ever group thousands ("1 234,50", "1'234.50").
  let text = body;
  let spaced = false;
  if (/[\s'’]/.test(text)) {
    const match = /^(\d{1,3}(?:[\s'’]\d{3})+)([.,]\d+)?$/.exec(text);
    if (!match || !GROUPS_OF_THREE.test(match[1].replace(/[\s'’]/g, ""))) return null;
    text = match[1].replace(/[\s'’]/g, "") + (match[2] ?? "");
    spaced = true;
  }
  if (!/^[\d.,]+$/.test(text)) return null;

  const dots = text.split(".").length - 1;
  const commas = text.split(",").length - 1;

  if (dots === 0 && commas === 0) return { whole: text, fraction: "" };

  if (dots > 0 && commas > 0) {
    // Both appear: the one that comes last is the decimal separator, and it appears once.
    const decimal = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    if (spaced || (decimal === "." ? dots : commas) !== 1) return null;
    const [head, fraction] = text.split(decimal);
    if (fraction === "" || fraction.includes(grouping) || !validGroups(head.split(grouping))) return null;
    return { whole: head.split(grouping).join(""), fraction };
  }

  const separator = dots > 0 ? "." : ",";
  const parts = text.split(separator);
  if (parts.length > 2) {
    // The same separator more than once can only be grouping: "1.234.567", "1,234,567".
    if (spaced || !validGroups(parts)) return null;
    return { whole: parts.join(""), fraction: "" };
  }

  const [head, tail] = parts;
  if (tail === "") return null; // "12." or "12,": half-typed
  if (spaced) return { whole: head, fraction: tail }; // the spaces were the grouping
  if (tail.length === 3 && /^[1-9]\d{0,2}$/.test(head)) {
    // "1,234" or "1.234": thousands, unless the currency itself has three decimals. Then a dot
    // is its decimal point ("1.234" dinars) and a comma could be either, so it is refused.
    if (digits !== 3) return { whole: head + tail, fraction: "" };
    return separator === "." ? { whole: head, fraction: tail } : null;
  }
  // One or two digits after it (or a shape that cannot be grouping): the decimal separator.
  return { whole: head, fraction: tail };
}

/**
 * What a person typed to minor units, or null when it is not one unambiguous amount.
 *
 *   "1,234.50"  "1.234,50"  "1 234,50"  "$12"  "12,50 €"  "12.5"  "-5"   are amounts
 *   "12 for 2"  "1e3"  "1.2.3"  "(5.00)"  "12."  ""                      are not (null)
 *
 * The decimal separator is worked out from the text, so both "1,234.50" and "1.234,50" are
 * 1234.50. A single separator followed by exactly three digits is thousands ("1,234" and
 * "1.234" are both 1234); followed by one or two digits it is the decimal point ("1,5" is 1.50,
 * "12,50" is 12.50). More decimal places than the currency has ("0.125" dollars, "12.5" yen) is
 * not an amount: nothing is rounded away. One currency sign, or the currency's own code or
 * symbol, may come before or after the number; any other letters make the text something else.
 */
export function parseMoneyInput(input: string, currency: string): Money | null {
  if (typeof input !== "string") return null;
  let text = input.normalize("NFKC").trim();
  if (text.length === 0 || text.length > 60) return null;

  // An optional sign (the minus may be ASCII or the typographic one), before or after the currency.
  let negative = false;
  let signSeen = false;
  const takeSign = (): boolean => {
    const sign = /^([-\u2212+])\s*/.exec(text);
    if (!sign) return true;
    if (signSeen) return false; // "--5", "-$-5"
    signSeen = true;
    negative = sign[1] !== "+";
    text = text.slice(sign[0].length);
    return true;
  };
  const [before, after] = currencyMarkers(currency);
  if (!takeSign()) return null;
  text = text.replace(before, "");
  if (!takeSign()) return null;
  text = text.replace(after, "").trim();

  const digits = minorUnitDigits(currency);
  const split = splitNumber(text, digits);
  if (!split) return null;
  let { whole, fraction } = split;
  if (whole === "" && fraction === "") return null;
  if (whole !== "" && !/^\d+$/.test(whole)) return null;
  if (fraction !== "" && !/^\d+$/.test(fraction)) return null;

  // More precision than the currency has is only fine when it is zeros ("12.00" yen).
  if (fraction.length > digits) {
    if (/[1-9]/.test(fraction.slice(digits))) return null;
    fraction = fraction.slice(0, digits);
  }
  whole = whole.replace(/^0+(?=\d)/, "");
  if (whole.length > 15) return null;

  const minor = Number(whole || "0") * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) return null;
  const amount = negative && minor !== 0 ? -minor : minor;
  const parsed = moneySchema.safeParse({ amount, currency });
  return parsed.success ? parsed.data : null;
}
