// What a plan costs: totals, by category, by person, by day, and what a work plan claims back.
//
// All amounts are whole minor units. Expenses in a currency other than the plan's are never
// mixed into the plan's totals (there is no conversion in this version); they are totalled
// separately under `otherCurrencies`.

import type { Expense } from "@/db/schema";
import { minorUnitDigits, type ExpenseCategory, type ExpenseStatus, type PaymentMethod } from "@/lib/domain";
import { compareDates, type LocalDate } from "@/lib/time";
import { computeBalances, isSpent, type MoneyInput } from "./split";

// --- words ----------------------------------------------------------------------------------------

/** The category names a work plan shows (product spec 13.1), in the app's own vocabulary. */
const WORK_LABELS: Record<ExpenseCategory, string> = {
  airfare: "Airfare",
  lodging: "Stay",
  car_rental: "Car",
  fuel: "Fuel",
  rideshare_taxi: "Rideshare and taxi",
  rail_transit: "Rail and transit",
  parking_tolls: "Parking and tolls",
  mileage: "Mileage",
  meals: "Meals",
  meals_with_others: "Meals with clients or team",
  conference: "Conference and registration",
  shipping: "Shipping",
  phone_internet: "Phone and internet",
  supplies: "Supplies",
  tips: "Tips",
  activities: "Activities",
  shopping: "Shopping",
  other: "Other",
};

/**
 * The fixed category names an expense export uses, so finance sees the same words every time.
 * These are the product spec's list verbatim ("Lodging", "Car rental"): a file for an expense
 * system, not a screen.
 */
export const EXPORT_CATEGORY_NAMES: Record<ExpenseCategory, string> = {
  ...WORK_LABELS,
  lodging: "Lodging",
  car_rental: "Car rental",
};

/** The shorter list family and trip plans see. Every category maps onto one of these. */
export const EVERYDAY_GROUPS = ["travel", "stay", "getting_around", "food", "activities", "shopping", "other"] as const;
export type EverydayGroup = (typeof EVERYDAY_GROUPS)[number];

const EVERYDAY_LABELS: Record<EverydayGroup, string> = {
  travel: "Travel",
  stay: "Stay",
  getting_around: "Getting around",
  food: "Food",
  activities: "Activities",
  shopping: "Shopping",
  other: "Other",
};

const EVERYDAY_OF: Record<ExpenseCategory, EverydayGroup> = {
  airfare: "travel",
  lodging: "stay",
  car_rental: "getting_around",
  fuel: "getting_around",
  rideshare_taxi: "getting_around",
  rail_transit: "getting_around",
  parking_tolls: "getting_around",
  mileage: "getting_around",
  meals: "food",
  meals_with_others: "food",
  tips: "food",
  conference: "activities",
  activities: "activities",
  shopping: "shopping",
  supplies: "shopping",
  shipping: "other",
  phone_internet: "other",
  other: "other",
};

/** Which everyday group a category belongs to: "fuel" gives "getting_around". */
export function everydayGroupOf(category: ExpenseCategory): EverydayGroup {
  return EVERYDAY_OF[category];
}

/**
 * The name to show for a category. "work" gives the full list ("Rideshare and taxi");
 * "everyday" gives the short one family and trip plans use ("Getting around").
 */
export function categoryLabel(category: ExpenseCategory, style: "work" | "everyday"): string {
  return style === "work" ? WORK_LABELS[category] : EVERYDAY_LABELS[EVERYDAY_OF[category]];
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  personal_card: "Personal card",
  company_card: "Company card",
  cash: "Cash",
  other: "Other",
};

export function paymentMethodLabel(method: PaymentMethod): string {
  return PAYMENT_LABELS[method];
}

const STATUS_LABELS: Record<ExpenseStatus, string> = {
  planned: "Planned",
  paid: "Paid",
  submitted: "Submitted",
  reimbursed: "Reimbursed",
};

export function expenseStatusLabel(status: ExpenseStatus): string {
  return STATUS_LABELS[status];
}

/**
 * Money for a tile or a headline: "$4,280" when there are no cents, "$4,280.50" when there are.
 * Formatting only; the arithmetic stays in minor units.
 */
export function formatMoneyShort(amount: number, currency: string, locale = "en-US"): string {
  const digits = minorUnitDigits(currency);
  const unit = 10 ** digits;
  const whole = amount % unit === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: whole ? 0 : digits,
  }).format(amount / unit);
}

/**
 * Minor units as a plain decimal for a file: 428000 gives "4280.00", -1250 gives "-12.50",
 * 1235 yen gives "1235". Built from the digits, with no floating-point arithmetic.
 */
export function decimalAmount(amount: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  const sign = amount < 0 ? "-" : "";
  const text = String(Math.abs(amount)).padStart(digits + 1, "0");
  return digits === 0 ? `${sign}${text}` : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

// --- totals ---------------------------------------------------------------------------------------

export type CategoryTotal = {
  /** A category key in "work" style, an everyday group in "everyday" style. */
  key: string;
  label: string;
  spent: number;
  planned: number;
  /** Spent plus planned. */
  total: number;
  /** This row's share of everything, in thousandths, for the width of a bar. */
  permille: number;
};

export type PersonTotal = {
  personId: string;
  name: string;
  /** Everything they paid, shared or not. */
  paid: number;
  /** Their part of the shared costs. */
  share: number;
  /** Positive: owed to them. Negative: they owe. */
  net: number;
};

export type WorkTotals = {
  /** To be claimed back: everything marked reimbursable that has been spent. */
  reimbursable: number;
  /** Paid on a company card (never claimed back). */
  companyPaid: number;
  billable: number;
  /** Reimbursable and not submitted yet. */
  toSubmit: number;
  submitted: number;
  reimbursed: number;
  byPaymentMethod: { method: PaymentMethod; label: string; amount: number }[];
  /** Reimbursable entries with no receipt on record ("none"; "not required" does not count). */
  missingReceipts: number;
};

export type MoneySummary = {
  currency: string;
  /** Paid already. */
  spent: number;
  /** Booked or expected, not paid yet. */
  planned: number;
  total: number;
  budget: number | null;
  /** Budget minus spent and planned. Negative when over. Null with no budget. */
  remaining: number | null;
  overBudget: boolean;
  /** Largest first. Categories with nothing in them are left out. */
  byCategory: CategoryTotal[];
  /** Everyone who paid something or shares something, largest payer first. */
  byPerson: PersonTotal[];
  byDay: { date: LocalDate; spent: number; planned: number }[];
  work: WorkTotals;
  /** Totals in other currencies, never mixed into the numbers above. */
  otherCurrencies: { currency: string; spent: number; planned: number }[];
  /** How many expense entries there are in all. */
  entries: number;
  /** "$4,280 so far", or "Nothing yet". What has been paid, in the plan's currency. */
  line: string;
  /** "$1,607.50 left of $6,500", "$120 over $6,500". Counts planned amounts too. Null with no budget. */
  budgetLine: string | null;
};

export type SummaryOptions = {
  /** Which category list to group by. Default: "work" for a work plan, "everyday" otherwise. */
  categories?: "work" | "everyday";
};

/**
 * Everything the Money screen totals.
 *
 *   const money = moneySummary(planData);
 *   money.line                 // "$4,280 so far"
 *   money.byCategory[0]        // { label: "Travel", total: 284300, permille: 664, … }
 *   money.work.reimbursable    // for a work plan
 */
export function moneySummary(input: MoneyInput, options: SummaryOptions = {}): MoneySummary {
  const { plan } = input;
  const currency = plan.currency;
  const style = options.categories ?? (plan.template === "work" ? "work" : "everyday");
  const mine = input.expenses.filter((expense) => expense.currency === currency);
  const sum = (list: readonly Expense[]) => list.reduce((total, expense) => total + expense.amount, 0);

  const spentList = mine.filter(isSpent);
  const plannedList = mine.filter((expense) => !isSpent(expense));
  const spent = sum(spentList);
  const planned = sum(plannedList);
  const total = spent + planned;

  const categories = new Map<string, CategoryTotal>();
  for (const expense of mine) {
    const key = style === "work" ? expense.category : EVERYDAY_OF[expense.category];
    const row = categories.get(key) ?? { key, label: categoryLabel(expense.category, style), spent: 0, planned: 0, total: 0, permille: 0 };
    if (isSpent(expense)) row.spent += expense.amount;
    else row.planned += expense.amount;
    row.total += expense.amount;
    categories.set(key, row);
  }
  const byCategory = [...categories.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  // A bar's width is a proportion, not money: whole thousandths of the total.
  for (const row of byCategory) row.permille = total > 0 ? Math.round((Math.max(0, row.total) * 1000) / total) : 0;

  const balances = computeBalances(input, currency);
  const paidBy = new Map<string, number>();
  for (const expense of spentList) {
    if (expense.paidByPersonId) paidBy.set(expense.paidByPersonId, (paidBy.get(expense.paidByPersonId) ?? 0) + expense.amount);
  }
  const byPerson: PersonTotal[] = balances.people
    .map((row) => ({ personId: row.personId, name: row.name, paid: paidBy.get(row.personId) ?? 0, share: row.share, net: row.net }))
    .filter((row) => row.paid !== 0 || row.share !== 0 || row.net !== 0)
    .sort((a, b) => b.paid - a.paid || a.name.localeCompare(b.name));

  const days = new Map<LocalDate, { date: LocalDate; spent: number; planned: number }>();
  for (const expense of mine) {
    const day = days.get(expense.date) ?? { date: expense.date, spent: 0, planned: 0 };
    if (isSpent(expense)) day.spent += expense.amount;
    else day.planned += expense.amount;
    days.set(expense.date, day);
  }

  const reimbursableList = spentList.filter((expense) => expense.reimbursable);
  const methods: PaymentMethod[] = ["personal_card", "company_card", "cash", "other"];
  const work: WorkTotals = {
    reimbursable: sum(reimbursableList),
    companyPaid: sum(spentList.filter((expense) => expense.paymentMethod === "company_card")),
    billable: sum(spentList.filter((expense) => expense.billable)),
    toSubmit: sum(reimbursableList.filter((expense) => expense.status === "paid")),
    submitted: sum(reimbursableList.filter((expense) => expense.status === "submitted")),
    reimbursed: sum(reimbursableList.filter((expense) => expense.status === "reimbursed")),
    byPaymentMethod: methods
      .map((method) => ({ method, label: PAYMENT_LABELS[method], amount: sum(spentList.filter((expense) => expense.paymentMethod === method)) }))
      .filter((row) => row.amount !== 0),
    missingReceipts: reimbursableList.filter((expense) => expense.receipt === "none").length,
  };

  const others = new Map<string, { currency: string; spent: number; planned: number }>();
  for (const expense of input.expenses) {
    if (expense.currency === currency) continue;
    const row = others.get(expense.currency) ?? { currency: expense.currency, spent: 0, planned: 0 };
    if (isSpent(expense)) row.spent += expense.amount;
    else row.planned += expense.amount;
    others.set(expense.currency, row);
  }

  const budget = plan.budgetTotal;
  const remaining = budget === null ? null : budget - total;
  const line = mine.length === 0 ? "Nothing yet" : `${formatMoneyShort(spent, currency)} so far`;
  const budgetLine =
    budget === null || remaining === null
      ? null
      : remaining < 0
        ? `${formatMoneyShort(-remaining, currency)} over ${formatMoneyShort(budget, currency)}`
        : `${formatMoneyShort(remaining, currency)} left of ${formatMoneyShort(budget, currency)}`;

  return {
    currency,
    spent,
    planned,
    total,
    budget,
    remaining,
    overBudget: remaining !== null && remaining < 0,
    byCategory,
    byPerson,
    byDay: [...days.values()].sort((a, b) => compareDates(a.date, b.date)),
    work,
    otherCurrencies: [...others.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    entries: input.expenses.length,
    line,
    budgetLine,
  };
}
