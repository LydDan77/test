import { describe, expect, it } from "vitest";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/domain";
import { airport, at, makeArrival, makeBooking, makeExpense, makeParty, makePerson, makePlan, makePlanData, seg } from "@/lib/people/testing";
import { hartleyExample } from "@/lib/readiness/hartley-example";
import { zonedToUtc } from "@/lib/time";
import { arrivalManifestCsv, EXPENSE_COLUMNS, expensesCsv, MANIFEST_COLUMNS, ROOMING_COLUMNS, roomingListCsv, toCsv } from "./exports";
import {
  categoryLabel,
  decimalAmount,
  everydayGroupOf,
  EXPORT_CATEGORY_NAMES,
  expenseStatusLabel,
  formatMoneyShort,
  moneySummary,
  paymentMethodLabel,
} from "./totals";

const now = zonedToUtc("2026-12-01T12:00", "America/New_York");

describe("writing money", () => {
  it("drops the cents when there are none, for a tile", () => {
    expect(formatMoneyShort(428_000, "USD")).toBe("$4,280");
    expect(formatMoneyShort(428_050, "USD")).toBe("$4,280.50");
    expect(formatMoneyShort(0, "USD")).toBe("$0");
    expect(formatMoneyShort(-1_250, "USD")).toBe("-$12.50");
    expect(formatMoneyShort(1_235, "JPY")).toBe("¥1,235");
    expect(formatMoneyShort(99, "EUR")).toBe("€0.99");
  });

  it("writes a plain decimal for a file, from the digits, in any currency", () => {
    expect(decimalAmount(428_000, "USD")).toBe("4280.00");
    expect(decimalAmount(5, "USD")).toBe("0.05");
    expect(decimalAmount(-1_250, "USD")).toBe("-12.50");
    expect(decimalAmount(0, "USD")).toBe("0.00");
    expect(decimalAmount(1_235, "JPY")).toBe("1235");
    expect(decimalAmount(12_345, "KWD")).toBe("12.345");
    // Too big for a float to hold its cents, and still right.
    expect(decimalAmount(9_007_199_254_740_991, "USD")).toBe("90071992547409.91");
  });

  it("names every category, payment method and status", () => {
    for (const category of EXPENSE_CATEGORIES) {
      expect(categoryLabel(category, "work")).toMatch(/^[A-Z]/);
      expect(categoryLabel(category, "everyday")).toMatch(/^[A-Z]/);
      expect(EXPORT_CATEGORY_NAMES[category]).toMatch(/^[A-Z]/);
    }
    // The app says Stay and Car; a finance export keeps the standard words.
    expect([categoryLabel("lodging", "work"), categoryLabel("car_rental", "work")]).toEqual(["Stay", "Car"]);
    expect([EXPORT_CATEGORY_NAMES.lodging, EXPORT_CATEGORY_NAMES.car_rental]).toEqual(["Lodging", "Car rental"]);
    const everyday = (category: ExpenseCategory) => [everydayGroupOf(category), categoryLabel(category, "everyday")];
    expect(everyday("airfare")).toEqual(["travel", "Travel"]);
    expect(everyday("fuel")).toEqual(["getting_around", "Getting around"]);
    expect(everyday("tips")).toEqual(["food", "Food"]);
    expect(everyday("conference")).toEqual(["activities", "Activities"]);
    expect(everyday("shipping")).toEqual(["other", "Other"]);
    expect(["personal_card", "company_card", "cash", "other"].map((m) => paymentMethodLabel(m as never))).toEqual(["Personal card", "Company card", "Cash", "Other"]);
    expect(["planned", "paid", "submitted", "reimbursed"].map((s) => expenseStatusLabel(s as never))).toEqual(["Planned", "Paid", "Submitted", "Reimbursed"]);
  });
});

describe("a family plan's money", () => {
  const example = hartleyExample();
  const money = moneySummary(example.data);

  it("totals what is spent, what is planned and what is left of the budget", () => {
    expect(money).toMatchObject({ currency: "USD", spent: 428_000, planned: 256_000, total: 684_000, budget: 700_000, remaining: 16_000, overBudget: false, entries: 7 });
    expect(money.line).toBe("$4,280 so far");
    expect(money.budgetLine).toBe("$160 left of $7,000");
  });

  it("groups by the everyday categories, largest first, with bar widths that add up", () => {
    expect(money.byCategory.map((row) => [row.key, row.label, row.spent, row.planned, row.total, row.permille])).toEqual([
      ["stay", "Stay", 128_000, 256_000, 384_000, 561],
      ["travel", "Travel", 284_300, 0, 284_300, 416],
      ["food", "Food", 10_000, 0, 10_000, 15],
      ["other", "Other", 5_700, 0, 5_700, 8],
    ]);
    expect(money.byCategory.reduce((sum, row) => sum + row.total, 0)).toBe(money.total);
    expect(money.byCategory.reduce((sum, row) => sum + row.permille, 0)).toBe(1000);
  });

  it("says who paid what and where each person stands", () => {
    const lydia = money.byPerson[0];
    expect(lydia).toMatchObject({ name: "Lydia Hartley", paid: 148_640 + 128_000 + 5_700 });
    expect(money.byPerson.reduce((sum, row) => sum + row.net, 0)).toBe(0);
    expect(money.byPerson.reduce((sum, row) => sum + row.paid, 0)).toBe(428_000);
    expect(money.byDay.map((day) => [day.date, day.spent, day.planned])).toEqual([
      ["2026-11-06", 412_300, 0],
      ["2026-11-20", 10_000, 0],
      ["2026-11-24", 5_700, 0],
      ["2026-12-19", 0, 256_000],
    ]);
  });

  it("says when the plan is over budget, and when there is no budget or nothing yet", () => {
    const tight = moneySummary({ ...example.data, plan: { ...example.data.plan, budgetTotal: 600_000 } });
    expect(tight).toMatchObject({ remaining: -84_000, overBudget: true, budgetLine: "$840 over $6,000" });
    const none = moneySummary({ ...example.data, plan: { ...example.data.plan, budgetTotal: null } });
    expect(none).toMatchObject({ budget: null, remaining: null, overBudget: false, budgetLine: null });
    const empty = moneySummary(makePlanData());
    expect(empty).toMatchObject({ spent: 0, planned: 0, total: 0, byCategory: [], byPerson: [], byDay: [], entries: 0, line: "Nothing yet" });
  });
});

/** A solo work trip to Austin with a claim to submit. */
function workTrip() {
  const plan = makePlan({ template: "work", workMode: "travel", title: "Austin kickoff", projectCode: "ACME-2027", currency: "USD" });
  const me = makeParty(plan.id, "Me");
  const lydia = makePerson(me, "Lydia Hartley", { phone: "+1 206 555 0100" });
  const client = makePerson(me, "Sam O'Neil");
  const hotel = makeBooking(plan.id, "lodging", { propertyName: "Hotel Ella" }, { confirmationCode: "ELLA-7781" });
  const base = { paidByPersonId: lydia.id, reimbursable: true };
  const expenses = [
    makeExpense(plan.id, "Alaska Airlines", 61_240, { ...base, date: "2027-01-05", category: "airfare", paymentMethod: "company_card", reimbursable: false, paidByPersonId: null, status: "paid" }),
    makeExpense(plan.id, "Hotel Ella", 84_900, { ...base, date: "2027-01-15", category: "lodging", bookingId: hotel.id, receipt: "not_required", status: "submitted" }),
    makeExpense(plan.id, 'Franklin "BBQ", Austin', 9_815, { ...base, date: "2027-01-13", category: "meals_with_others", description: "Dinner with the client", attendeeIds: [lydia.id, client.id], billable: true }),
    makeExpense(plan.id, "Lyft", 2_350, { ...base, date: "2027-01-12", category: "rideshare_taxi", paymentMethod: "cash", status: "reimbursed", projectCode: "OVERRIDE-1" }),
    makeExpense(plan.id, "=SUM(A1:A9)", 1_000, { ...base, date: "2027-01-14", category: "other", description: "+1 for luck\nsecond line" }),
    makeExpense(plan.id, "Bahnhof café", 1_250, { ...base, date: "2027-01-16", category: "meals", currency: "EUR" }),
    makeExpense(plan.id, "Parking", 4_000, { ...base, date: "2027-01-17", category: "parking_tolls", status: "planned" }),
  ];
  return { data: makePlanData({ plan, parties: [me], people: [lydia, client], bookings: [hotel], expenses }), lydia };
}

describe("a work plan's money", () => {
  const { data } = workTrip();
  const money = moneySummary(data);

  it("totals what gets claimed, what the company paid and what is billable", () => {
    expect(money.spent).toBe(61_240 + 84_900 + 9_815 + 2_350 + 1_000);
    expect(money.planned).toBe(4_000);
    expect(money.work).toMatchObject({
      reimbursable: 84_900 + 9_815 + 2_350 + 1_000,
      companyPaid: 61_240,
      billable: 9_815,
      toSubmit: 9_815 + 1_000,
      submitted: 84_900,
      reimbursed: 2_350,
      missingReceipts: 3,
    });
    expect(money.work.byPaymentMethod).toEqual([
      { method: "personal_card", label: "Personal card", amount: 84_900 + 9_815 + 1_000 },
      { method: "company_card", label: "Company card", amount: 61_240 },
      { method: "cash", label: "Cash", amount: 2_350 },
    ]);
  });

  it("uses the full category list, and never mixes another currency in", () => {
    expect(money.byCategory.map((row) => [row.key, row.label])).toEqual([
      ["lodging", "Stay"],
      ["airfare", "Airfare"],
      ["meals_with_others", "Meals with clients or team"],
      ["parking_tolls", "Parking and tolls"],
      ["rideshare_taxi", "Rideshare and taxi"],
      ["other", "Other"],
    ]);
    expect(money.otherCurrencies).toEqual([{ currency: "EUR", spent: 1_250, planned: 0 }]);
    expect(moneySummary(data, { categories: "everyday" }).byCategory.map((row) => row.label)).toEqual(["Stay", "Travel", "Food", "Getting around", "Other"]);
  });
});

describe("the expenses file", () => {
  const { data } = workTrip();
  const csv = expensesCsv(data);
  const lines = csv.split("\r\n");

  it("has the fixed columns, one row per expense, oldest first", () => {
    expect(lines[0]).toBe("date,merchant,description,category,amount,currency,amount_home,home_currency,payment_method,reimbursable,billable,project_code,paid_by,attendees,confirmation,receipt,plan,notes");
    expect(EXPENSE_COLUMNS).toHaveLength(18);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines.filter((line) => /^2027-01-\d\d,/.test(line)).map((line) => line.slice(0, 10))).toEqual([
      "2027-01-05", "2027-01-12", "2027-01-13", "2027-01-14", "2027-01-15", "2027-01-16", "2027-01-17",
    ]);
  });

  it("writes ISO dates, decimal amounts and plain yes and no", () => {
    expect(lines[1]).toBe("2027-01-05,Alaska Airlines,,Airfare,612.40,USD,612.40,USD,Company card,no,no,ACME-2027,,,,none,Austin kickoff,");
    expect(lines[2]).toBe("2027-01-12,Lyft,,Rideshare and taxi,23.50,USD,23.50,USD,Cash,yes,no,OVERRIDE-1,Lydia Hartley,,,none,Austin kickoff,reimbursed");
    expect(csv).toContain("2027-01-15,Hotel Ella,,Lodging,849.00,USD,849.00,USD,Personal card,yes,no,ACME-2027,Lydia Hartley,,ELLA-7781,not required,Austin kickoff,submitted");
    // Another currency keeps its own amount and leaves the home amount empty: there is no conversion.
    expect(csv).toContain("2027-01-16,Bahnhof café,,Meals,12.50,EUR,,USD,Personal card,yes,no,ACME-2027,Lydia Hartley,,,none,Austin kickoff,");
    expect(csv).toContain(",Parking and tolls,40.00,USD,40.00,USD,Personal card,yes,no,ACME-2027,Lydia Hartley,,,none,Austin kickoff,planned");
  });

  it("quotes commas, quotes and line breaks, and defuses anything a spreadsheet would run", () => {
    expect(csv).toContain('2027-01-13,"Franklin ""BBQ"", Austin",Dinner with the client,Meals with clients or team,98.15,USD,98.15,USD,Personal card,yes,yes,ACME-2027,Lydia Hartley,Lydia Hartley; Sam O\'Neil,,none,Austin kickoff,');
    expect(csv).toContain("2027-01-14,'=SUM(A1:A9),\"'+1 for luck\nsecond line\",Other,10.00,");
    expect(toCsv(["a", "b"], [["@cmd", "-2+3"], ["plain", 5], [null, undefined]])).toBe("a,b\r\n'@cmd,'-2+3\r\nplain,5\r\n,\r\n");
    // A negative amount is a number, not a formula: it is never given an apostrophe.
    const refund = { ...data, expenses: [makeExpense(data.plan.id, "Refund", -1_250, { date: "2027-01-20" })] };
    expect(expensesCsv(refund).split("\r\n")[1]).toContain(",-12.50,USD,-12.50,USD,");
  });

  it("is just the header for a plan with no expenses", () => {
    expect(expensesCsv(makePlanData())).toBe(`${EXPENSE_COLUMNS.join(",")}\r\n`);
  });
});

describe("the rooming list and the arrival manifest", () => {
  function offsite() {
    const austin = { kind: "city" as const, name: "Austin", tz: "America/Chicago" };
    const plan = makePlan({ template: "work", workMode: "event", destination: austin, tz: austin.tz, startDate: "2027-01-12", endDate: "2027-01-15" });
    const product = makeParty(plan.id, "Product", { sortOrder: 0 });
    const sales = makeParty(plan.id, "Sales", { sortOrder: 1 });
    const priya = makePerson(product, "Priya Nair", { phone: "+1 206 555 0111", accessNote: "Step-free room" });
    const omar = makePerson(product, "Omar Haddad");
    const jules = makePerson(sales, "Jules Martin", { rsvpStatus: "invited" });
    const kenji = makePerson(sales, "Kenji Sato", { rsvpStatus: "no" });
    const wen = makePerson(sales, "=Wen Li");
    const hotel = makeBooking(
      plan.id,
      "lodging",
      { lodgingType: "hotel", propertyName: "Hotel Ella", checkInDate: "2027-01-12", checkOutDate: "2027-01-15", rooms: [{ label: "Twin 204", personIds: [priya.id, omar.id] }, { label: "King 310", personIds: [wen.id] }] },
    );
    const flight = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("AS 580", "SEA", "2027-01-12T08:00", "AUS", "2027-01-12T14:10")] }, { personIds: [priya.id, omar.id] });
    const ride = makeBooking(plan.id, "ride", { rideType: "shuttle", fromPlace: airport("AUS"), pickupAt: at("2027-01-12T14:45", austin.tz) }, { status: "booked" });
    const arrivals = [
      makeArrival(product, "arrival", { bookingId: flight.id, segmentIndex: 0, rideNeed: "rideshare", rideBookingId: ride.id }),
      makeArrival(sales, "arrival", { personIds: [wen.id], mode: "drive", scheduledAt: zonedToUtc("2027-01-13T09:30", austin.tz), tz: austin.tz }),
      makeArrival(sales, "departure", { personIds: [wen.id], mode: "drive", scheduledAt: zonedToUtc("2027-01-14T18:00", austin.tz), tz: austin.tz }),
    ];
    return makePlanData({ plan, parties: [product, sales], people: [priya, omar, jules, kenji, wen], bookings: [hotel, flight, ride], arrivals });
  }

  it("lists who is in which room, for their own nights, and who has nowhere yet", () => {
    const csv = roomingListCsv(offsite(), now);
    expect(csv.split("\r\n")).toEqual([
      ROOMING_COLUMNS.join(","),
      // Wen drives in a day late and leaves a day early: one night.
      "'=Wen Li,Hotel Ella,King 310,2027-01-13,2027-01-14,1,,",
      "Omar Haddad,Hotel Ella,Twin 204,2027-01-12,2027-01-15,3,Priya Nair,",
      "Priya Nair,Hotel Ella,Twin 204,2027-01-12,2027-01-15,3,Omar Haddad,Step-free room",
      "Jules Martin,,,,,,,No stay on record yet",
      "",
    ]);
  });

  it("lists everyone expected in order of arrival, with nothing for the ones not booked", () => {
    const csv = arrivalManifestCsv(offsite(), now);
    expect(csv.split("\r\n")).toEqual([
      MANIFEST_COLUMNS.join(","),
      // A phone number that starts with "+" is text a spreadsheet would try to calculate: it is guarded like any other.
      "Priya Nair,2027-01-12,14:10,AS 580,AUS,Shuttle booked,'+1 206 555 0111",
      "Omar Haddad,2027-01-12,14:10,AS 580,AUS,Shuttle booked,",
      "'=Wen Li,2027-01-13,09:30,,Driving,Own car,",
      "Jules Martin,,,,,,",
      "",
    ]);
    // Kenji said no: he is on neither list.
    expect(csv).not.toContain("Kenji");
    expect(roomingListCsv(offsite(), now)).not.toContain("Kenji");
  });

  it("is just a header for an empty plan", () => {
    expect(roomingListCsv(makePlanData(), now)).toBe(`${ROOMING_COLUMNS.join(",")}\r\n`);
    expect(arrivalManifestCsv(makePlanData(), now)).toBe(`${MANIFEST_COLUMNS.join(",")}\r\n`);
  });
});
