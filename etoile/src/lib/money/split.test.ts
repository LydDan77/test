import { describe, expect, it } from "vitest";
import type { Expense, Party, Person } from "@/db/schema";
import type { ExpenseSplit } from "@/lib/domain";
import { makeExpense, makeParty, makePerson, makePlan, makePlanData, makeSettlement } from "@/lib/people/testing";
import {
  allocate,
  balanceCurrencies,
  computeBalances,
  EXACT_SETTLE_LIMIT,
  settleUp,
  settleUpPlan,
  splitExpense,
  type Payment,
} from "./split";

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** A small deterministic random generator, so the property tests are the same on every run. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("sharing out an amount", () => {
  it("gives the leftover cents to the largest remainders, earlier people first on a tie", () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(100, [1, 1, 1, 1, 1, 1, 1])).toEqual([15, 15, 14, 14, 14, 14, 14]);
    expect(allocate(100, [1, 2])).toEqual([33, 67]);
    expect(allocate(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocate(0, [1, 1])).toEqual([0, 0]);
    expect(allocate(500, [1])).toEqual([500]);
    expect(allocate(500, [])).toEqual([]);
  });

  it("shares a refund the same way, with the sign kept", () => {
    expect(allocate(-100, [1, 2])).toEqual([-33, -67]);
    expect(allocate(-1000, [1, 1, 1])).toEqual([-334, -333, -333]);
  });

  it("gives someone with no weight nothing, and keeps the total when every weight is zero", () => {
    expect(allocate(999, [0, 1, 0, 2])).toEqual([0, 333, 0, 666]);
    expect(allocate(999, [0, 0])).toEqual([999, 0]);
  });

  it("always adds up exactly, for thousands of random amounts and weights", () => {
    const next = rng(20261219);
    for (let i = 0; i < 3000; i++) {
      const amount = Math.floor(next() * 2_000_000_00) - 50_000_00;
      const weights = Array.from({ length: 1 + Math.floor(next() * 12) }, () => Math.floor(next() * 5000));
      const parts = allocate(amount, weights);
      expect(sum(parts)).toBe(amount);
      expect(parts.every(Number.isInteger)).toBe(true);
      // No part is more than a cent away from its exact proportion.
      const total = sum(weights);
      if (total > 0) parts.forEach((part, j) => expect(Math.abs(part - (amount * weights[j]) / total)).toBeLessThan(1));
    }
  });

  it("refuses anything that is not a whole number of minor units", () => {
    expect(() => allocate(10.5, [1, 1])).toThrow(RangeError);
    expect(() => allocate(100, [1.5, 1])).toThrow(RangeError);
    expect(() => allocate(100, [-1, 1])).toThrow(RangeError);
    expect(() => allocate(Number.MAX_SAFE_INTEGER, [3, 7])).toThrow(RangeError);
  });
});

function nine() {
  const plan = makePlan();
  const seattle = makeParty(plan.id, "The Seattle Hartleys", { sortOrder: 0 });
  const portland = makeParty(plan.id, "The Portland Hartleys", { sortOrder: 1 });
  const minneapolis = makeParty(plan.id, "The Minneapolis Hartleys", { sortOrder: 2 });
  const [lydia, mark, theo, june] = ["Lydia", "Mark", "Theo", "June"].map((name) => makePerson(seattle, `${name} Hartley`));
  const [dana, chris] = ["Dana", "Chris"].map((name) => makePerson(portland, `${name} Hartley`));
  const [ruth, dale, rob] = ["Ruth", "Dale", "Rob"].map((name) => makePerson(minneapolis, `${name} Hartley`));
  const people: Person[] = [lydia, mark, theo, june, dana, chris, ruth, dale, rob];
  const parties: Party[] = [seattle, portland, minneapolis];
  const all = (ids: Person[] = people): ExpenseSplit["parts"] => ids.map((person) => ({ personId: person.id }));
  return { plan, parties, people, seattle, portland, minneapolis, lydia, mark, theo, june, dana, chris, ruth, dale, rob, all };
}

describe("splitting one expense", () => {
  const f = nine();
  const amounts = (expense: { amount: number; split: ExpenseSplit }) => splitExpense(expense, f.people).shares.map((share) => share.amount);

  it("shares equally", () => {
    expect(amounts({ amount: 10_000, split: { method: "equal", parts: f.all([f.lydia, f.dana, f.ruth]) } })).toEqual([3334, 3333, 3333]);
    expect(sum(amounts({ amount: 123_457, split: { method: "equal", parts: f.all() } }))).toBe(123_457);
  });

  it("shares by household: each household pays one share, split among its own people", () => {
    const shares = splitExpense({ amount: 128_000, split: { method: "by_party", parts: f.all() } }, f.people).shares;
    const of = (person: Person) => shares.find((share) => share.personId === person.id)!.amount;
    const household = (members: Person[]) => sum(members.map(of));
    expect([household([f.lydia, f.mark, f.theo, f.june]), household([f.dana, f.chris]), household([f.ruth, f.dale, f.rob])]).toEqual([42_667, 42_667, 42_666]);
    expect([of(f.lydia), of(f.mark), of(f.theo), of(f.june)]).toEqual([10_667, 10_667, 10_667, 10_666]);
    expect([of(f.dana), of(f.chris)]).toEqual([21_334, 21_333]);
    expect(sum(shares.map((share) => share.amount))).toBe(128_000);
    // Only the people named share it: two households here, not three.
    expect(amounts({ amount: 9_000, split: { method: "by_party", parts: f.all([f.lydia, f.mark, f.dana]) } })).toEqual([2250, 2250, 4500]);
  });

  it("shares in proportion to shares, fractions included", () => {
    const parts = [{ personId: f.lydia.id, share: 2 }, { personId: f.dana.id, share: 1 }, { personId: f.ruth.id, share: 1.5 }];
    expect(amounts({ amount: 9_000, split: { method: "shares", parts } })).toEqual([4000, 2000, 3000]);
    // 4444.44, 2222.22 and 3333.33: the spare cent goes to the largest remainder.
    expect(amounts({ amount: 10_000, split: { method: "shares", parts } })).toEqual([4445, 2222, 3333]);
    // One third and two thirds, written as awkward decimals.
    expect(amounts({ amount: 100, split: { method: "shares", parts: [{ personId: f.lydia.id, share: 0.333 }, { personId: f.dana.id, share: 0.667 }] } })).toEqual([33, 67]);
  });

  it("uses exact amounts as given", () => {
    const parts = [{ personId: f.lydia.id, amount: 7_000 }, { personId: f.dana.id, amount: 2_500 }, { personId: f.ruth.id, amount: 500 }];
    expect(splitExpense({ amount: 10_000, split: { method: "exact", parts } }, f.people)).toEqual({
      shares: [{ personId: f.lydia.id, amount: 7_000 }, { personId: f.dana.id, amount: 2_500 }, { personId: f.ruth.id, amount: 500 }],
      problem: null,
    });
  });

  it("repairs exact amounts that do not add up, keeping their proportions and the total", () => {
    const parts = [{ personId: f.lydia.id, amount: 6_000 }, { personId: f.dana.id, amount: 2_000 }];
    const result = splitExpense({ amount: 10_000, split: { method: "exact", parts } }, f.people);
    expect(result.problem).toBe("exact_mismatch");
    expect(result.shares.map((share) => share.amount)).toEqual([7_500, 2_500]);
    const zeros = splitExpense({ amount: 900, split: { method: "exact", parts: [{ personId: f.lydia.id, amount: 0 }, { personId: f.dana.id, amount: 0 }] } }, f.people);
    expect(zeros.shares.map((share) => share.amount)).toEqual([450, 450]);
  });

  it("shares nothing for an expense nobody shares", () => {
    expect(splitExpense({ amount: 10_000, split: { method: "none", parts: [] } }, f.people)).toEqual({ shares: [], problem: null });
  });

  it("leaves out someone who is no longer in the plan, and says so", () => {
    const parts = [...f.all([f.lydia, f.dana]), { personId: "gone" }];
    const result = splitExpense({ amount: 1_000, split: { method: "equal", parts } }, f.people);
    expect(result).toEqual({ shares: [{ personId: f.lydia.id, amount: 500 }, { personId: f.dana.id, amount: 500 }], problem: "people_missing" });
    expect(splitExpense({ amount: 1_000, split: { method: "equal", parts: [{ personId: "gone" }] } }, f.people)).toEqual({ shares: [], problem: "people_missing" });
  });

  it("adds up exactly for every method, on random expenses", () => {
    const next = rng(7);
    const methods = ["equal", "by_party", "shares"] as const;
    for (let i = 0; i < 1500; i++) {
      const sharers = f.people.filter(() => next() < 0.6);
      if (sharers.length === 0) continue;
      const amount = Math.floor(next() * 900_000) + 1;
      const method = methods[i % 3];
      const parts = sharers.map((person) => ({ personId: person.id, share: Math.round(next() * 40) / 10 + 0.1 }));
      const shares = splitExpense({ amount, split: { method, parts } }, f.people).shares;
      expect(sum(shares.map((share) => share.amount))).toBe(amount);
      expect(shares.every((share) => Number.isInteger(share.amount) && share.amount >= 0)).toBe(true);
    }
  });
});

describe("balances", () => {
  const f = nine();
  const house = makeExpense(f.plan.id, "Lakeside house", 128_000, { paidByPersonId: f.lydia.id, category: "lodging", split: { method: "by_party", parts: f.all() } });
  const catering = makeExpense(f.plan.id, "Winter Park Catering", 10_000, { paidByPersonId: f.ruth.id, category: "meals", split: { method: "by_party", parts: f.all() } });
  const flights = makeExpense(f.plan.id, "Alaska Airlines", 148_640, { paidByPersonId: f.lydia.id, category: "airfare" }); // not shared
  const planned = makeExpense(f.plan.id, "Lakeside house", 256_000, { status: "planned", category: "lodging", split: { method: "by_party", parts: f.all() } });
  const data = makePlanData({ plan: f.plan, parties: f.parties, people: f.people, expenses: [house, catering, flights, planned] });

  it("nets what each person paid against their share, and always sums to zero", () => {
    const balances = computeBalances(data);
    expect(sum(balances.people.map((row) => row.net))).toBe(0);
    const lydia = balances.people.find((row) => row.personId === f.lydia.id)!;
    // Paid the house; her part is a quarter of the Seattle share of the house and of the catering.
    expect(lydia).toMatchObject({ paid: 128_000, share: 10_667 + 834, net: 128_000 - 11_501 });
    expect(balances.settled).toBe(false);
  });

  it("totals by household, with a line of plain words", () => {
    const balances = computeBalances(data);
    expect(balances.parties.map((row) => [row.name, row.net, row.line])).toEqual([
      ["The Seattle Hartleys", 81_999, "is owed $819.99"],
      ["The Portland Hartleys", -46_000, "owes $460.00"],
      ["The Minneapolis Hartleys", -35_999, "owes $359.99"],
    ]);
    expect(sum(balances.parties.map((row) => row.net))).toBe(0);
  });

  it("leaves out unshared costs, planned amounts and other currencies", () => {
    const euros = makeExpense(f.plan.id, "Café", 4_000, { currency: "EUR", paidByPersonId: f.dana.id, split: { method: "equal", parts: f.all([f.dana, f.lydia]) } });
    const withEuros = { ...data, expenses: [...data.expenses, euros] };
    expect(computeBalances(withEuros).parties.map((row) => row.net)).toEqual([81_999, -46_000, -35_999]);
    const inEuros = computeBalances(withEuros, "EUR");
    expect(inEuros.currency).toBe("EUR");
    expect(inEuros.people.filter((row) => row.net !== 0).map((row) => [row.name, row.net])).toEqual([["Lydia Hartley", -2_000], ["Dana Hartley", 2_000]]);
    expect(balanceCurrencies(withEuros)).toEqual(["USD", "EUR"]);
    expect(balanceCurrencies(data)).toEqual(["USD"]);
  });

  it("applies settlements that were recorded", () => {
    const paid = makeSettlement(f.plan.id, f.dana.id, f.lydia.id, 46_000, { method: "Venmo" });
    const balances = computeBalances({ ...data, settlements: [paid] });
    expect(balances.parties.map((row) => [row.name, row.net, row.line])).toEqual([
      ["The Seattle Hartleys", 35_999, "is owed $359.99"],
      ["The Portland Hartleys", 0, "all square"],
      ["The Minneapolis Hartleys", -35_999, "owes $359.99"],
    ]);
    const dana = balances.people.find((row) => row.personId === f.dana.id)!;
    expect(dana).toMatchObject({ settledOut: 46_000, settledIn: 0 });
    expect(sum(balances.people.map((row) => row.net))).toBe(0);
  });

  it("is settled when everything has been paid back", () => {
    const one = makeExpense(f.plan.id, "Pizza", 3_000, { paidByPersonId: f.lydia.id, split: { method: "equal", parts: f.all([f.lydia, f.dana, f.ruth]) } });
    const back = [makeSettlement(f.plan.id, f.dana.id, f.lydia.id, 1_000), makeSettlement(f.plan.id, f.ruth.id, f.lydia.id, 1_000)];
    const balances = computeBalances({ ...data, expenses: [one], settlements: back });
    expect(balances.settled).toBe(true);
    expect(settleUpPlan({ ...data, expenses: [one], settlements: back })).toMatchObject({ settled: true, payments: [], line: "All square." });
  });

  it("reports a shared expense with no payer, and a split that had to be repaired, without losing a cent", () => {
    const noPayer = makeExpense(f.plan.id, "Groceries", 9_000, { split: { method: "equal", parts: f.all() } });
    const broken = makeExpense(f.plan.id, "Boat", 10_000, { paidByPersonId: f.rob.id, split: { method: "exact", parts: [{ personId: f.lydia.id, amount: 1 }, { personId: f.dana.id, amount: 1 }] } });
    const balances = computeBalances({ ...data, expenses: [noPayer, broken] });
    expect(balances.unassigned).toEqual([{ expenseId: noPayer.id, merchant: "Groceries", amount: 9_000 }]);
    expect(balances.problems).toEqual([{ expenseId: broken.id, merchant: "Boat", problem: "exact_mismatch" }]);
    expect(sum(balances.people.map((row) => row.net))).toBe(0);
    expect(balances.people.find((row) => row.personId === f.rob.id)?.net).toBe(10_000);
  });

  it("handles a refund", () => {
    const paid = makeExpense(f.plan.id, "Theme park", 30_000, { paidByPersonId: f.lydia.id, split: { method: "equal", parts: f.all([f.lydia, f.dana, f.ruth]) } });
    const refund = makeExpense(f.plan.id, "Theme park", -3_001, { paidByPersonId: f.lydia.id, split: { method: "equal", parts: f.all([f.lydia, f.dana, f.ruth]) } });
    const balances = computeBalances({ ...data, expenses: [paid, refund] });
    // The refund comes back as -1001, -1000, -1000: Lydia, who paid, takes the odd cent of her own refund.
    expect(balances.people.filter((row) => row.net !== 0).map((row) => [row.name, row.net])).toEqual([["Lydia Hartley", 18_000], ["Dana Hartley", -9_000], ["Ruth Hartley", -9_000]]);
    expect(balances.people.find((row) => row.personId === f.lydia.id)).toMatchObject({ paid: 26_999, share: 8_999 });
  });
});

/** Applies payments and returns what is left of each balance. */
function after(balances: { id: string; net: number }[], payments: Payment[]): number[] {
  const left = new Map(balances.map((b) => [b.id, b.net]));
  for (const payment of payments) {
    left.set(payment.from, left.get(payment.from)! + payment.amount);
    left.set(payment.to, left.get(payment.to)! - payment.amount);
  }
  return [...left.values()];
}

/** The true minimum number of payments, by trying every way to divide people into groups that sum to zero. */
function bruteForceMinimum(nets: number[]): number {
  const open = nets.filter((n) => n !== 0);
  let mostGroups = 0;
  const assign = (index: number, sums: number[]) => {
    if (index === open.length) {
      if (sums.every((s) => s === 0)) mostGroups = Math.max(mostGroups, sums.length);
      return;
    }
    for (let g = 0; g < sums.length; g++) {
      sums[g] += open[index];
      assign(index + 1, sums);
      sums[g] -= open[index];
    }
    sums.push(open[index]);
    assign(index + 1, sums);
    sums.pop();
  };
  assign(0, []);
  return open.length - mostGroups;
}

describe("settling up", () => {
  const ids = "abcdefghijklmnopqrstuvwxyz".split("");
  const named = (nets: number[]) => nets.map((net, i) => ({ id: ids[i] ?? `p${i}`, net }));

  it("needs nothing when everyone is square", () => {
    expect(settleUp([])).toEqual([]);
    expect(settleUp(named([0, 0, 0]))).toEqual([]);
  });

  it("settles two people with one payment, and one debtor with one payment each", () => {
    expect(settleUp(named([-2_500, 2_500]))).toEqual([{ from: "a", to: "b", amount: 2_500 }]);
    expect(settleUp(named([-3_000, 1_000, 2_000]))).toEqual([
      { from: "a", to: "c", amount: 2_000 },
      { from: "a", to: "b", amount: 1_000 },
    ]);
  });

  it("finds the groups that can settle among themselves, where matching big with big would not", () => {
    // Two closed circles of three: 9 = 4 + 5 and 8 = 1 + 7. Four payments is the minimum;
    // paying the largest debt to the largest credit first takes five.
    const balances = named([9_00, -4_00, -5_00, 8_00, -1_00, -7_00]);
    const payments = settleUp(balances);
    expect(payments).toHaveLength(4);
    expect(after(balances, payments).every((left) => left === 0)).toBe(true);
    expect(bruteForceMinimum(balances.map((b) => b.net))).toBe(4);
  });

  it("pairs off people who owe each other exactly, first", () => {
    const balances = named([5_000, -5_000, 1_234, -1_234, 300, -100, -200]);
    const payments = settleUp(balances);
    expect(payments).toHaveLength(4);
    expect(payments.slice(0, 2)).toEqual([
      { from: "b", to: "a", amount: 5_000 },
      { from: "d", to: "c", amount: 1_234 },
    ]);
    expect(after(balances, payments).every((left) => left === 0)).toBe(true);
  });

  it("is the true minimum, exact to the cent, on hundreds of random sets of balances", () => {
    const next = rng(4280);
    for (let round = 0; round < 400; round++) {
      const n = 2 + Math.floor(next() * 7); // up to 8 people: small enough to check by brute force
      const nets = Array.from({ length: n - 1 }, () => Math.floor(next() * 20) * 250 - 2_500 + (next() < 0.3 ? Math.floor(next() * 99) : 0));
      nets.push(-sum(nets));
      const balances = named(nets);
      const payments = settleUp(balances);
      expect(after(balances, payments).every((left) => left === 0), JSON.stringify(nets)).toBe(true);
      expect(payments.every((p) => Number.isInteger(p.amount) && p.amount > 0 && p.from !== p.to)).toBe(true);
      expect(payments.length, JSON.stringify(nets)).toBe(bruteForceMinimum(nets));
    }
  });

  it("settles forty people exactly, in fewer payments than people", () => {
    const next = rng(40);
    const nets = Array.from({ length: 39 }, () => Math.floor(next() * 400_00) - 200_00);
    nets.push(-sum(nets));
    const balances = named(nets);
    expect(balances.filter((b) => b.net !== 0).length).toBeGreaterThan(EXACT_SETTLE_LIMIT);
    const started = Date.now();
    const payments = settleUp(balances);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(after(balances, payments).every((left) => left === 0)).toBe(true);
    expect(payments.length).toBeLessThanOrEqual(39);
    expect(payments.every((p) => Number.isInteger(p.amount) && p.amount > 0)).toBe(true);
  });

  it("is quick at the largest size it solves exactly", () => {
    const next = rng(18);
    const nets = Array.from({ length: EXACT_SETTLE_LIMIT - 1 }, (_, i) => (i + 1) * 1_01 * (next() < 0.5 ? -1 : 1) + Math.floor(next() * 37));
    nets.push(-sum(nets));
    const balances = named(nets);
    const started = Date.now();
    const payments = settleUp(balances);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(after(balances, payments).every((left) => left === 0)).toBe(true);
    expect(payments.length).toBeLessThanOrEqual(EXACT_SETTLE_LIMIT - 1);
  });

  it("gives the same answer whatever order the balances come in", () => {
    const balances = named([9_00, -4_00, -5_00, 8_00, -1_00, -7_00]);
    expect(settleUp([...balances].reverse())).toEqual(settleUp(balances));
  });

  it("refuses fractions of a cent", () => {
    expect(() => settleUp(named([10.5, -10.5]))).toThrow(RangeError);
  });
});

describe("settling a plan", () => {
  const f = nine();
  const expenses: Expense[] = [
    makeExpense(f.plan.id, "Lakeside house", 128_000, { paidByPersonId: f.lydia.id, split: { method: "by_party", parts: f.all() } }),
    makeExpense(f.plan.id, "Winter Park Catering", 10_000, { paidByPersonId: f.ruth.id, split: { method: "by_party", parts: f.all() } }),
  ];
  const data = makePlanData({ plan: f.plan, parties: f.parties, people: f.people, expenses });

  it("settles by household in two payments, and says who should hand the money to whom", () => {
    const result = settleUpPlan(data, { by: "party" });
    expect(result.line).toBe("2 payments settle everything.");
    expect(result.payments.map((p) => p.text)).toEqual([
      "The Portland Hartleys to The Seattle Hartleys: $460.00",
      "The Minneapolis Hartleys to The Seattle Hartleys: $359.99",
    ]);
    expect(result.payments[0]).toMatchObject({ fromId: f.portland.id, toId: f.seattle.id, amount: 46_000, currency: "USD", toPersonId: f.lydia.id });
    expect([f.dana.id, f.chris.id]).toContain(result.payments[0].fromPersonId);
    // Recording both as settlements clears every household.
    const settlements = result.payments.map((p) => makeSettlement(f.plan.id, p.fromPersonId, p.toPersonId, p.amount));
    expect(computeBalances({ ...data, settlements }).parties.every((row) => row.net === 0)).toBe(true);
    expect(settleUpPlan({ ...data, settlements }, { by: "party" }).settled).toBe(true);
  });

  it("settles by person when asked, exactly", () => {
    const result = settleUpPlan(data);
    expect(result.by).toBe("person");
    // Eight people owe; Lydia is owed. Ruth paid the catering, so she owes less.
    expect(result.payments).toHaveLength(8);
    expect(result.payments.every((p) => p.toName === "Lydia Hartley")).toBe(true);
    expect(sum(result.payments.map((p) => p.amount))).toBe(128_000 - 11_501);
    const settlements = result.payments.map((p) => makeSettlement(f.plan.id, p.fromPersonId, p.toPersonId, p.amount));
    expect(computeBalances({ ...data, settlements }).settled).toBe(true);
  });

  it("says one payment in the singular, and nothing to settle for one person or an empty plan", () => {
    const pizza = makeExpense(f.plan.id, "Pizza", 2_000, { paidByPersonId: f.lydia.id, split: { method: "equal", parts: f.all([f.lydia, f.dana]) } });
    const one = settleUpPlan({ ...data, expenses: [pizza] });
    expect(one.line).toBe("1 payment settles everything.");
    expect(one.payments[0].text).toBe("Dana Hartley to Lydia Hartley: $10.00");
    expect(settleUpPlan(makePlanData()).settled).toBe(true);
    const solo = makePlan();
    const me = makeParty(solo.id, "Me");
    const lydia = makePerson(me, "Lydia Hartley");
    const mine = makeExpense(solo.id, "Hotel", 50_000, { paidByPersonId: lydia.id, split: { method: "equal", parts: [{ personId: lydia.id }] } });
    expect(settleUpPlan(makePlanData({ plan: solo, parties: [me], people: [lydia], expenses: [mine] })).settled).toBe(true);
  });
});
