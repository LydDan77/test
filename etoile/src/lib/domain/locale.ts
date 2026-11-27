// Sensible defaults for a new account from the browser's locale: units and currency.
// A starting point only; both are settings the person can change.

import type { UnitSystem } from "./enums";

const IMPERIAL_REGIONS = new Set(["US", "LR", "MM"]);

const EURO_REGIONS = [
  "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK",
];

const REGION_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", GB: "GBP", AU: "AUD", NZ: "NZD", JP: "JPY", CN: "CNY", IN: "INR",
  KR: "KRW", SG: "SGD", HK: "HKD", TW: "TWD", TH: "THB", PH: "PHP", ID: "IDR", MY: "MYR", VN: "VND",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", IS: "ISK",
  TR: "TRY", IL: "ILS", AE: "AED", SA: "SAR", ZA: "ZAR", EG: "EGP", NG: "NGN", KE: "KES",
  BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN",
  ...Object.fromEntries(EURO_REGIONS.map((region) => [region, "EUR"])),
};

/** The region of a BCP 47 locale ("en-US" gives "US"; "en" is guessed as "US"), or null. */
export function regionOfLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  try {
    return new Intl.Locale(locale).maximize().region ?? null;
  } catch {
    return null;
  }
}

/** Units and currency to start a new account with. Unknown locales get imperial and USD. */
export function localeDefaults(locale: string | null | undefined): { units: UnitSystem; currency: string } {
  const region = regionOfLocale(locale);
  if (!region) return { units: "imperial", currency: "USD" };
  return {
    units: IMPERIAL_REGIONS.has(region) ? "imperial" : "metric",
    currency: REGION_CURRENCY[region] ?? "USD",
  };
}
