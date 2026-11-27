// Splitting costs, balances and settling up.
//
// Money is an integer number of minor units (cents) from end to end. Nothing here divides money
// into a floating-point number: a cost is shared out by whole cents, and the cents left over
// after dividing go one each to the people with the largest remainders, so the parts always add
// up to the total exactly and nothing drifts however many expenses there are.
//
//   splitExpense()     who owes what part of one expense
//   computeBalances()  each person's and each household's net position, settlements applied
//   settleUp()         the smallest set of payments that clears a set of balances
//   settleUpPlan()     the same for a plan, by person or by household, with names

import type { Expense, Person } from "@/db/schema";
import type { ExpenseSplit } from "@/lib/domain";
import { formatMoney } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";

// --- sharing out an amount ------------------------------------------------------------------------

/**
 * Shares `amount` (minor units) out in proportion to whole-number `weights`, exactly.
 *
 *   allocate(1000, [1, 1, 1])  // [334, 333, 333]
 *   allocate(-100, [1, 2])     // [-33, -67]
 *
 * Each part is rounded down and the cents left over go to the largest remainders, earlier
 * entries first on a tie. The parts always add up to `amount`. Weights must be whole numbers,
 * zero or more, with at least one above zero; otherwise every part is 0 except that the whole
 * amount goes to the first entry (so the total is still exact).
 */
export function allocate(amount: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`Money must be a whole number of minor units: ${amount}`);
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new RangeError("Weights must be whole numbers, zero or more");
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) return weights.map((_, i) => (i === 0 ? amount : 0));

  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount);
  const parts: number[] = [];
  const remainders: { index: number; remainder: number }[] = [];
  let given = 0;
  weights.forEach((weight, index) => {
    const product = magnitude * weight;
    if (!Number.isSafeInteger(product)) throw new RangeError("Amount too large to share out exactly");
    const part = Math.floor(product / total);
    parts.push(part);
    given += part;
    remainders.push({ index, remainder: product % total });
  });
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < magnitude - given; i++) parts[remainders[i].index] += 1;
  return parts.map((part) => (part === 0 ? 0 : sign * part));
}

export type ExpenseShare = { personId: string; amount: number };

export type SplitResult = {
  /** Each person's part, in the order of the split. Adds up to the expense exactly, or is empty for an unshared expense. */
  shares: ExpenseShare[];
  /**
   * Set when the split could not be applied as written and was repaired:
   * "exact_mismatch" (the exact amounts did not add up, so the cost was shared in their proportion),
   * "people_missing" (someone in the split is no longer in the plan; the rest share it).
   */
  problem: "exact_mismatch" | "people_missing" | null;
};

/**
 * Who owes what part of one expense.
 *
 *  - "none": nobody shares it. No shares.
 *  - "equal": equally among the people in the split.
 *  - "by_party": equally among their households (each household pays one share, shared equally
 *    among its members in the split).
 *  - "shares": in proportion to each person's share (2 means twice a 1; halves are fine).
 *  - "exact": each person's own amount.
 *
 * `people` supplies each person's household and says who still exists.
 */
export function splitExpense(
  expense: { amount: number; split: ExpenseSplit },
  people: readonly Pick<Person, "id" | "partyId">[],
): SplitResult {
  const { amount, split } = expense;
  if (split.method === "none") return { shares: [], problem: null };

  const byId = new Map(people.map((person) => [person.id, person]));
  const parts = split.parts.filter((part) => byId.has(part.personId));
  let problem: SplitResult["problem"] = parts.length < split.parts.length ? "people_missing" : null;
  if (parts.length === 0) return { shares: [], problem };

  const give = (weights: number[]): ExpenseShare[] =>
    allocate(amount, weights).map((part, i) => ({ personId: parts[i].personId, amount: part }));

  switch (split.method) {
    case "equal":
      return { shares: give(parts.map(() => 1)), problem };

    case "by_party": {
      const partyIds: string[] = [];
      for (const part of parts) {
        const partyId = byId.get(part.personId)!.partyId;
        if (!partyIds.includes(partyId)) partyIds.push(partyId);
      }
      const perParty = allocate(amount, partyIds.map(() => 1));
      const shares: ExpenseShare[] = parts.map((part) => ({ personId: part.personId, amount: 0 }));
      partyIds.forEach((partyId, p) => {
        const members = parts.map((part, i) => ({ part, i })).filter(({ part }) => byId.get(part.personId)!.partyId === partyId);
        allocate(perParty[p], members.map(() => 1)).forEach((value, m) => {
          shares[members[m].i].amount = value;
        });
      });
      return { shares, problem };
    }

    case "shares": {
      // Shares may be fractions ("1.5"). Thousandths as whole numbers keep the arithmetic exact.
      const weights = parts.map((part) => Math.max(1, Math.round((part.share ?? 1) * 1000)));
      return { shares: give(weights), problem };
    }

    case "exact": {
      const amounts = parts.map((part) => part.amount ?? 0);
      const sum = amounts.reduce((a, b) => a + b, 0);
      if (sum === amount && !problem) return { shares: parts.map((part, i) => ({ personId: part.personId, amount: amounts[i] })), problem: null };
      // The amounts do not add up to the expense. Keep their proportions so the total stays exact.
      problem ??= "exact_mismatch";
      return { shares: give(sum > 0 ? amounts : parts.map(() => 1)), problem };
    }
  }
}

// --- balances -------------------------------------------------------------------------------------

export type MoneyInput = Pick<PlanData, "plan" | "parties" | "people" | "expenses" | "settlements">;

export type PersonBalance = {
  personId: string;
  name: string;
  partyId: string;
  /** What they paid toward shared costs. */
  paid: number;
  /** Their own part of the shared costs. */
  share: number;
  /** Payments they have made to others to settle up. */
  settledOut: number;
  /** Payments they have received. */
  settledIn: number;
  /** Positive: they are owed this much. Negative: they owe it. Zero: square. */
  net: number;
};

export type PartyBalance = {
  partyId: string;
  name: string;
  paid: number;
  share: number;
  net: number;
  /** "is owed $182.50", "owes $182.50", "all square". */
  line: string;
};

export type Balances = {
  currency: string;
  people: PersonBalance[];
  parties: PartyBalance[];
  /** Shared expenses left out because nobody is recorded as having paid them. */
  unassigned: { expenseId: string; merchant: string; amount: number }[];
  /** Expenses whose split had to be repaired (see SplitResult.problem). */
  problems: { expenseId: string; merchant: string; problem: NonNullable<SplitResult["problem"]> }[];
  /** True when nobody owes anybody anything. */
  settled: boolean;
};

/** An expense that counts as spent: anything except a planned amount. */
export function isSpent(expense: Pick<Expense, "status">): boolean {
  return expense.status !== "planned";
}

/**
 * Everyone's net position in one currency (the plan's unless another is named).
 *
 * Counted: expenses that are paid (not "planned"), in that currency, shared (any split but
 * "none"), with a payer on record. Settlements already recorded are applied. The nets always
 * add up to zero.
 */
export function computeBalances(input: MoneyInput, currency: string = input.plan.currency): Balances {
  const rows = new Map<string, PersonBalance>(
    input.people.map((person) => [
      person.id,
      { personId: person.id, name: person.name, partyId: person.partyId, paid: 0, share: 0, settledOut: 0, settledIn: 0, net: 0 },
    ]),
  );
  const unassigned: Balances["unassigned"] = [];
  const problems: Balances["problems"] = [];

  for (const expense of input.expenses) {
    if (expense.currency !== currency || !isSpent(expense) || expense.split.method === "none") continue;
    const payer = expense.paidByPersonId ? rows.get(expense.paidByPersonId) : undefined;
    if (!payer) {
      unassigned.push({ expenseId: expense.id, merchant: expense.merchant, amount: expense.amount });
      continue;
    }
    const { shares, problem } = splitExpense(expense, input.people);
    if (problem) problems.push({ expenseId: expense.id, merchant: expense.merchant, problem });
    if (shares.length === 0) continue;
    payer.paid += expense.amount;
    for (const share of shares) rows.get(share.personId)!.share += share.amount;
  }

  for (const settlement of input.settlements) {
    if (settlement.currency !== currency) continue;
    const from = rows.get(settlement.fromPersonId);
    const to = rows.get(settlement.toPersonId);
    if (!from || !to) continue;
    from.settledOut += settlement.amount;
    to.settledIn += settlement.amount;
  }

  const people = [...rows.values()];
  for (const row of people) row.net = row.paid - row.share + row.settledOut - row.settledIn;

  const parties: PartyBalance[] = [...input.parties]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((party) => {
      const members = people.filter((row) => row.partyId === party.id);
      const net = members.reduce((sum, row) => sum + row.net, 0);
      return {
        partyId: party.id,
        name: party.name,
        paid: members.reduce((sum, row) => sum + row.paid, 0),
        share: members.reduce((sum, row) => sum + row.share, 0),
        net,
        line: net > 0 ? `is owed ${formatMoney({ amount: net, currency })}` : net < 0 ? `owes ${formatMoney({ amount: -net, currency })}` : "all square",
      };
    });

  return { currency, people, parties, unassigned, problems, settled: people.every((row) => row.net === 0) };
}

/** Every currency the plan's shared expenses or settlements use, the plan's own first. */
export function balanceCurrencies(input: MoneyInput): string[] {
  const used = new Set<string>([input.plan.currency]);
  for (const expense of input.expenses) if (isSpent(expense) && expense.split.method !== "none") used.add(expense.currency);
  for (const settlement of input.settlements) used.add(settlement.currency);
  return [...used];
}

// --- settling up ----------------------------------------------------------------------------------

export type Payment = { from: string; to: string; amount: number };

type Open = { id: string; net: number };

/**
 * Up to this many people with a balance (after exact opposites are paired off), the answer is
 * proven smallest. Above it, it is a good one.
 */
export const EXACT_SETTLE_LIMIT = 18;

/**
 * The fewest payments that clear a set of balances.
 *
 *   settleUp([{ id: "a", net: -3000 }, { id: "b", net: 1000 }, { id: "c", net: 2000 }])
 *   // [{ from: "a", to: "c", amount: 2000 }, { from: "a", to: "b", amount: 1000 }]
 *
 * `net` is in minor units: positive is owed money, negative owes it. Every payment is a whole
 * number of minor units and after them every balance is exactly zero (given balances that add
 * up to zero, as computeBalances() always produces).
 *
 * With up to EXACT_SETTLE_LIMIT non-zero balances the count is the true minimum: the people
 * are divided into as many groups that settle among themselves as possible, and a group of k
 * people needs k − 1 payments. Finding that division is expensive, so for larger sets the result
 * is the standard largest-owes-pays-largest-owed matching: never more than (people − 1) payments,
 * and usually the minimum, but not proven to be.
 */
export function settleUp(balances: readonly { id: string; net: number }[]): Payment[] {
  const open = balances.filter((b) => b.net !== 0).map((b) => ({ id: b.id, net: b.net }));
  if (open.some((b) => !Number.isSafeInteger(b.net))) throw new RangeError("Balances must be whole numbers of minor units");
  open.sort((a, b) => a.id.localeCompare(b.id));
  if (open.length === 0) return [];

  // Two people whose balances are exact opposites settle with one payment between them. Taking
  // those pairs out first never costs a payment, and it shrinks the search below.
  const payments: Payment[] = [];
  const waiting = new Map<number, Open[]>();
  const rest: Open[] = [];
  for (const balance of open) {
    const opposite = waiting.get(-balance.net);
    const match = opposite?.shift();
    if (match) {
      const [debtor, creditor] = balance.net < 0 ? [balance, match] : [match, balance];
      payments.push({ from: debtor.id, to: creditor.id, amount: creditor.net });
      rest.splice(rest.indexOf(match), 1);
      continue;
    }
    const same = waiting.get(balance.net) ?? [];
    same.push(balance);
    waiting.set(balance.net, same);
    rest.push(balance);
  }
  if (rest.length === 0) return payments;

  const groups = rest.length <= EXACT_SETTLE_LIMIT ? zeroSumGroups(rest) : [rest];
  return payments.concat(groups.flatMap(settleGroup));
}

/** Largest debtor pays largest creditor until the group is clear. At most (size − 1) payments for a group that sums to zero. */
function settleGroup(group: Open[]): Payment[] {
  const debtors = group.filter((b) => b.net < 0).map((b) => ({ id: b.id, left: -b.net }));
  const creditors = group.filter((b) => b.net > 0).map((b) => ({ id: b.id, left: b.net }));
  const bySize = (a: { id: string; left: number }, b: { id: string; left: number }) => b.left - a.left || a.id.localeCompare(b.id);
  const payments: Payment[] = [];
  for (;;) {
    debtors.sort(bySize);
    creditors.sort(bySize);
    const debtor = debtors[0];
    const creditor = creditors[0];
    if (!debtor || !creditor || debtor.left === 0 || creditor.left === 0) break;
    const amount = Math.min(debtor.left, creditor.left);
    payments.push({ from: debtor.id, to: creditor.id, amount });
    debtor.left -= amount;
    creditor.left -= amount;
  }
  return payments;
}

/**
 * Divides balances that add up to zero into the largest possible number of groups that each
 * add up to zero. Dynamic programming over subsets: 2^n states, so only for small n.
 */
function zeroSumGroups(open: Open[]): Open[][] {
  const n = open.length;
  const size = 1 << n;
  const sum = new Float64Array(size); // whole numbers below 2^53: exact
  const best = new Int8Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    const index = 31 - Math.clz32(low);
    sum[mask] = sum[mask ^ low] + open[index].net;
    let most = 0;
    for (let rest = mask; rest !== 0; rest &= rest - 1) {
      const bit = rest & -rest;
      const candidate = best[mask ^ bit];
      if (candidate > most) most = candidate;
    }
    best[mask] = most + (sum[mask] === 0 ? 1 : 0);
  }

  // Walk back from everyone to nobody, one person at a time, along a best path. Each time the
  // people left add up to zero, the people removed since the last such point form a group.
  const groups: Open[][] = [];
  let group: Open[] = [];
  let mask = size - 1;
  while (mask !== 0) {
    const target = best[mask] - (sum[mask] === 0 ? 1 : 0);
    let chosen = mask & -mask;
    for (let rest = mask; rest !== 0; rest &= rest - 1) {
      const bit = rest & -rest;
      if (best[mask ^ bit] === target) {
        chosen = bit;
        break;
      }
    }
    group.push(open[31 - Math.clz32(chosen)]);
    mask ^= chosen;
    if (sum[mask] === 0) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

export type SuggestedPayment = {
  /** Person ids, or household ids when settling by household. */
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  amount: number;
  currency: string;
  /**
   * The people to record the payment between (settlements are stored person to person). When
   * settling by household these are the member who owes the most and the member owed the most.
   */
  fromPersonId: string;
  toPersonId: string;
  /** "Dana to Lydia: $182.50". */
  text: string;
};

export type SettleUpPlan = {
  currency: string;
  by: "person" | "party";
  payments: SuggestedPayment[];
  /** True when there is nothing to pay. */
  settled: boolean;
  /** "All square.", "1 payment settles everything.", "3 payments settle everything." */
  line: string;
};

/**
 * The payments that settle a plan, by person or by household.
 *
 *   settleUpPlan(planData, { by: "party" }).payments[0].text
 *   // "The Portland Hartleys to The Seattle Hartleys: $182.50"
 *
 * Family plans settle by household by default in the product; pass `by` to say which.
 */
export function settleUpPlan(input: MoneyInput, options: { by?: "person" | "party"; currency?: string } = {}): SettleUpPlan {
  const by = options.by ?? "person";
  const balances = computeBalances(input, options.currency ?? input.plan.currency);
  const currency = balances.currency;
  const personName = new Map(balances.people.map((row) => [row.personId, row.name]));
  const partyName = new Map(balances.parties.map((row) => [row.partyId, row.name]));

  const raw =
    by === "party"
      ? settleUp(balances.parties.map((row) => ({ id: row.partyId, net: row.net })))
      : settleUp(balances.people.map((row) => ({ id: row.personId, net: row.net })));

  const extreme = (partyId: string, wantOwed: boolean): string => {
    const members = balances.people.filter((row) => row.partyId === partyId);
    members.sort((a, b) => (wantOwed ? b.net - a.net : a.net - b.net) || a.personId.localeCompare(b.personId));
    return members[0]?.personId ?? partyId;
  };

  const payments: SuggestedPayment[] = raw.map((payment) => {
    const names = by === "party" ? partyName : personName;
    const fromName = names.get(payment.from) ?? "Someone";
    const toName = names.get(payment.to) ?? "Someone";
    return {
      fromId: payment.from,
      toId: payment.to,
      fromName,
      toName,
      amount: payment.amount,
      currency,
      fromPersonId: by === "party" ? extreme(payment.from, false) : payment.from,
      toPersonId: by === "party" ? extreme(payment.to, true) : payment.to,
      text: `${fromName} to ${toName}: ${formatMoney({ amount: payment.amount, currency })}`,
    };
  });

  return {
    currency,
    by,
    payments,
    settled: payments.length === 0,
    line: payments.length === 0 ? "All square." : payments.length === 1 ? "1 payment settles everything." : `${payments.length} payments settle everything.`,
  };
}
