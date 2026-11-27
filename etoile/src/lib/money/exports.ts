// Files a person takes out of a plan: the expenses as CSV, and for work plans the rooming list
// and the arrival manifest (product spec 13.1 and 13.2). Each function returns the text of the
// file; a route handler adds the headers.
//
// These are the organizer's own exports and contain private details on purpose (confirmation
// codes, phone numbers). Never serve them from a share page.
//
// Format: UTF-8, CRLF line ends, ISO dates, decimal amounts with a point. Fields are quoted
// when they need to be. Text that a spreadsheet would run as a formula (it starts with =, +, -
// or @) is written with a leading apostrophe, because names and notes can be typed by guests.

import type { PlanData } from "@/lib/plan-data";
import { resolveArrivals, type ArrivalRow } from "@/lib/people/arrivals";
import { isExpected } from "@/lib/people/shared";
import { sleepingPlan } from "@/lib/people/sleeping";
import { addDays, utcToZoned, type InstantInput, type LocalDate } from "@/lib/time";
import { decimalAmount, EXPORT_CATEGORY_NAMES, paymentMethodLabel } from "./totals";

/** A cell: text is escaped and guarded; a number is written as it is. Null and undefined are empty. */
export type CsvCell = string | number | null | undefined;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  // Stop a spreadsheet treating typed text as a formula.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Rows to CSV text (RFC 4180): comma-separated, CRLF line ends, a final line end.
 * Pass amounts that are already formatted with `decimal()` so they are not guarded as text.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly (CsvCell | Decimal)[])[]): string {
  const line = (cells: readonly (CsvCell | Decimal)[]) => cells.map((c) => (isDecimal(c) ? c.text : cell(c))).join(",");
  return [line(header), ...rows.map(line)].join("\r\n") + "\r\n";
}

/** A number already written out as text ("-12.50"): never quoted, never guarded. */
export type Decimal = { decimal: true; text: string };
const isDecimal = (value: CsvCell | Decimal): value is Decimal => typeof value === "object" && value !== null && value.decimal === true;
const decimal = (amount: number, currency: string): Decimal => ({ decimal: true, text: decimalAmount(amount, currency) });

// --- expenses -------------------------------------------------------------------------------------

/** The columns of the expenses export, fixed so finance can rely on them (product spec 13.1). */
export const EXPENSE_COLUMNS = [
  "date", "merchant", "description", "category", "amount", "currency", "amount_home", "home_currency",
  "payment_method", "reimbursable", "billable", "project_code", "paid_by", "attendees", "confirmation",
  "receipt", "plan", "notes",
] as const;

/**
 * Every expense as CSV, one row each, oldest first.
 *
 *  - `amount` is in the expense's own currency. `amount_home` repeats it when that is the
 *    plan's currency and is empty otherwise (there is no currency conversion in this version).
 *  - `paid_by` is the person's name; empty means the company paid, or nobody was recorded.
 *  - `confirmation` comes from the booking the expense was recorded with.
 *  - `receipt` is "none" or "not required" (no receipt files in this version).
 *  - `notes` says "planned" for an amount that is booked and not yet paid, then the status
 *    ("submitted", "reimbursed") for a work claim.
 */
export function expensesCsv(input: Pick<PlanData, "plan" | "people" | "expenses" | "bookings">): string {
  const { plan } = input;
  const names = new Map(input.people.map((person) => [person.id, person.name]));
  const bookings = new Map(input.bookings.map((booking) => [booking.id, booking]));
  const rows = [...input.expenses]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((expense) => [
      expense.date,
      expense.merchant,
      expense.description,
      EXPORT_CATEGORY_NAMES[expense.category],
      decimal(expense.amount, expense.currency),
      expense.currency,
      expense.currency === plan.currency ? decimal(expense.amount, expense.currency) : "",
      plan.currency,
      paymentMethodLabel(expense.paymentMethod),
      expense.reimbursable ? "yes" : "no",
      expense.billable ? "yes" : "no",
      expense.projectCode ?? plan.projectCode,
      expense.paidByPersonId ? (names.get(expense.paidByPersonId) ?? "") : "",
      expense.attendeeIds.map((id) => names.get(id)).filter(Boolean).join("; "),
      expense.bookingId ? (bookings.get(expense.bookingId)?.confirmationCode ?? "") : "",
      expense.receipt === "not_required" ? "not required" : "none",
      plan.title,
      expense.status === "paid" ? "" : expense.status,
    ]);
  return toCsv(EXPENSE_COLUMNS, rows);
}

// --- rooming list -----------------------------------------------------------------------------------

export const ROOMING_COLUMNS = ["name", "hotel", "room_type", "check_in", "check_out", "nights", "sharing_with", "notes"] as const;

type ExportInput = Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings">;

/**
 * The rooming list: one row per person per place they stay, in name order within each place.
 *
 * `check_in` and `check_out` are that person's own first night and the morning after their
 * last one there, which is what a hotel needs. `sharing_with` names the others in the same
 * room. `notes` carries access needs. People who are expected and have nowhere to stay yet
 * are listed last, with the hotel empty, so the gap is visible.
 */
export function roomingListCsv(input: ExportInput, now: InstantInput): string {
  const plan = sleepingPlan(input, now);
  const people = new Map(input.people.map((person) => [person.id, person]));

  type Stretch = { personId: string; name: string; bookingId: string; hotel: string; room: string; from: LocalDate; last: LocalDate; nights: number };
  const stretches: Stretch[] = [];
  const without: string[] = [];
  for (const stay of plan.people) {
    if (stay.need !== "nights") continue;
    let open: Stretch | null = null;
    for (const night of stay.nights) {
      if (night.bookingId === null) {
        open = null;
        continue;
      }
      if (open && open.bookingId === night.bookingId) {
        open.nights += 1;
        open.last = night.date;
        continue;
      }
      open = {
        personId: stay.personId,
        name: stay.name,
        bookingId: night.bookingId,
        hotel: night.placeName ?? "",
        room: night.room ?? "",
        from: night.date,
        last: night.date,
        nights: 1,
      };
      stretches.push(open);
    }
    if (stay.nights.length > 0 && stay.uncovered.length === stay.nights.length) without.push(stay.personId);
  }

  stretches.sort((a, b) => a.hotel.localeCompare(b.hotel) || a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
  const rows: CsvCell[][] = stretches.map((s) => {
    const sharing = stretches
      .filter((other) => other !== s && other.bookingId === s.bookingId && s.room !== "" && other.room === s.room)
      .map((other) => other.name);
    // They leave the morning after their last night there.
    return [s.name, s.hotel, s.room, s.from, addDays(s.last, 1), s.nights, [...new Set(sharing)].join("; "), people.get(s.personId)?.accessNote ?? ""];
  });
  for (const personId of without) {
    const person = people.get(personId);
    if (person) rows.push([person.name, "", "", "", "", "", "", ["No stay on record yet", person.accessNote].filter(Boolean).join(". ")]);
  }
  return toCsv(ROOMING_COLUMNS, rows);
}

// --- arrival manifest -------------------------------------------------------------------------------

export const MANIFEST_COLUMNS = ["name", "date", "time", "flight", "airport", "ride", "phone"] as const;

/**
 * The arrival manifest: one row per person who is expected, in order of arrival.
 *
 * `date` and `time` are local to where they arrive (ISO date, 24-hour time). `airport` is the
 * code, or "Driving", "Local" and so on. People with nothing on record are listed last with
 * the date empty. Phone numbers are included: this is the organizer's own file.
 */
export function arrivalManifestCsv(input: ExportInput, now: InstantInput): string {
  const board = resolveArrivals(input, now);
  const people = new Map(input.people.map((person) => [person.id, person]));
  const rows: CsvCell[][] = [];
  const listed = new Set<string>();
  const line = (personId: string, row: ArrivalRow | null) => {
    const person = people.get(personId);
    if (!person || listed.has(personId)) return;
    listed.add(personId);
    const local = row?.at ? utcToZoned(row.at.at, row.at.tz) : null;
    const where = !row ? "" : row.mode === "drive" ? "Driving" : row.mode === "local" ? "Local" : (row.place.iata ?? row.place.label);
    rows.push([person.name, local?.date ?? "", local?.time ?? "", row?.flight?.designator ?? "", where, row ? row.ride.label : "", person.phone ?? ""]);
  };
  for (const row of board.arrivals.rows) {
    if (row.status.value === "cancelled") continue;
    for (const personId of row.personIds) line(personId, row);
  }
  // Everyone else who is expected has nothing on record yet.
  for (const person of input.people) if (isExpected(person)) line(person.id, null);
  return toCsv(MANIFEST_COLUMNS, rows);
}
