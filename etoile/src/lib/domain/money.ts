// Money: an integer number of minor units (cents) plus an ISO 4217 currency. Never a float.

import { z } from "zod";
import { currencySchema } from "./common";

export const moneySchema = z.object({
  /** Minor units: 1234 is $12.34. Whole numbers only; negative means a refund or credit. */
  amount: z.number().int().min(-2_000_000_000).max(2_000_000_000),
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

/** "$1,234.50", "¥1,235", "€12.00". `locale` defaults to en-US so server and browser agree. */
export function formatMoney(money: Money, locale = "en-US"): string {
  const digits = minorUnitDigits(money.currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency }).format(
    money.amount / 10 ** digits,
  );
}

/**
 * What a person typed ("1,234.50", "$12", "12.5") to minor units, or null when it is not an
 * amount. Rounds to the currency's smallest unit.
 */
export function parseMoneyInput(input: string, currency: string): Money | null {
  const cleaned = input.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || !/\d/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const amount = Math.round(value * 10 ** minorUnitDigits(currency));
  const parsed = moneySchema.safeParse({ amount, currency });
  return parsed.success ? parsed.data : null;
}
