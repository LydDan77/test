// Travel status per attendee (product spec 13.2): the table a work event's host reads to see
// who is sorted and who is missing something. Works for any plan; a solo work trip reads the
// same row as its trip sheet. Pure.

import type { PlanData } from "@/lib/plan-data";
import { formatDate, type InstantInput } from "@/lib/time";
import { isOnRecord, resolveArrivals, travelByPerson, type ArrivalRow } from "./arrivals";
import { sleepingPlan, type PersonStay } from "./sleeping";
import { dietaryWord } from "./summary";
import { count, type Wording } from "./text";

export type TravelStatusInput = Pick<PlanData, "plan" | "parties" | "people" | "arrivals" | "bookings">;

/** The one word that sums a person up, in the order the checks are made. */
export type OverallStatus = "not_coming" | "no_reply" | "missing_arrival" | "missing_lodging" | "missing_departure" | "ready";

const OVERALL_LABELS: Record<OverallStatus, string> = {
  not_coming: "Not coming",
  no_reply: "No reply",
  missing_arrival: "Missing arrival",
  missing_lodging: "Missing stay",
  missing_departure: "Missing departure",
  ready: "Ready",
};

export type TravelCell = {
  /** True when there is nothing on record and there should be. */
  missing: boolean;
  /** "AS 1054, Mon 4:10 PM", "Driving", "Local", "Missing". */
  label: string;
  /** The board row behind it, for a link or a tooltip. */
  row: ArrivalRow | null;
};

export type TravelStatusRow = {
  personId: string;
  name: string;
  /** The person's team when one is set, otherwise their household, group or team in the plan. */
  team: string | null;
  jobTitle: string | null;
  registered: { value: "yes" | "no" | "maybe" | "no_reply"; label: string };
  arrival: TravelCell;
  departure: TravelCell;
  lodging: {
    missing: boolean;
    /** "Hotel Ella, 3 nights", "Own arrangement", "Lives nearby", "Missing", "Missing 2 of 3 nights". */
    label: string;
    stay: PersonStay | null;
  };
  /** "Covered", "Needs a ride", "Not known yet", or "" when there is no arrival to meet. */
  ride: { label: string; needsRide: boolean };
  /** "vegetarian", "nut allergy" … plus anything they wrote themselves. */
  dietary: string[];
  access: string | null;
  overall: { value: OverallStatus; label: string };
  /** Everything still missing for this person, not only the first thing. */
  missing: ("reply" | "arrival" | "lodging" | "departure")[];
};

export type TravelStatus = {
  rows: TravelStatusRow[];
  counts: {
    total: number;
    ready: number;
    /** People who are coming (or have not said) and lack a reply, an arrival, a stay or a departure. */
    missingSomething: number;
    missingArrival: number;
    missingLodging: number;
    missingDeparture: number;
    noReply: number;
    notComing: number;
  };
  /** For Home: "3 arrivals still unbooked". Null when every expected person has one. */
  homeLine: string | null;
};

/**
 * One row per person: registered, arrival, stay, ride, departure, needs and an overall word.
 *
 *   const status = travelStatus(planData, now);
 *   status.rows.filter((row) => row.missing.length > 0)   // the "Missing something" filter
 *   status.homeLine                                         // "3 arrivals still unbooked"
 */
export function travelStatus(input: TravelStatusInput, now: InstantInput, options: { wording?: Wording } = {}): TravelStatus {
  const board = resolveArrivals(input, now, { wording: options.wording });
  const travel = travelByPerson(board);
  const stays = new Map(sleepingPlan(input, now).people.map((stay) => [stay.personId, stay]));
  const partyNames = new Map(input.parties.map((party) => [party.id, party.name]));

  const rows: TravelStatusRow[] = input.people.map((person) => {
    const mine = travel.get(person.id);
    const notComing = person.rsvpStatus === "no";
    const registered: TravelStatusRow["registered"] =
      person.rsvpStatus === "yes"
        ? { value: "yes", label: "Yes" }
        : person.rsvpStatus === "no"
          ? { value: "no", label: "No" }
          : person.rsvpStatus === "maybe"
            ? { value: "maybe", label: "Maybe" }
            : { value: "no_reply", label: "No reply" };

    const arrival = travelCell(mine?.arrival ?? null, notComing);
    const departure = travelCell(mine?.departure ?? null, notComing);
    const stay = stays.get(person.id) ?? null;
    const lodging = lodgingCell(stay, notComing);
    const arrivalRide = mine?.arrival?.ride;
    const ride =
      !arrivalRide || notComing
        ? { label: "", needsRide: false }
        : arrivalRide.state === "needs_ride"
          ? { label: "Needs a ride", needsRide: true }
          : arrivalRide.state === "unknown"
            ? { label: "Not known yet", needsRide: false }
            : { label: "Covered", needsRide: false };

    const missing: TravelStatusRow["missing"] = [];
    if (!notComing) {
      if (registered.value === "no_reply") missing.push("reply");
      if (arrival.missing) missing.push("arrival");
      if (lodging.missing) missing.push("lodging");
      if (departure.missing) missing.push("departure");
    }
    const overall: OverallStatus = notComing
      ? "not_coming"
      : missing.includes("reply")
        ? "no_reply"
        : missing.includes("arrival")
          ? "missing_arrival"
          : missing.includes("lodging")
            ? "missing_lodging"
            : missing.includes("departure")
              ? "missing_departure"
              : "ready";

    const dietary = person.dietaryTags.map(dietaryWord);
    if (person.dietaryNote?.trim()) dietary.push(person.dietaryNote.trim());

    return {
      personId: person.id,
      name: person.name,
      team: person.team ?? partyNames.get(person.partyId) ?? null,
      jobTitle: person.jobTitle,
      registered,
      arrival,
      departure,
      lodging,
      ride,
      dietary,
      access: person.accessNote?.trim() || null,
      overall: { value: overall, label: OVERALL_LABELS[overall] },
      missing,
    };
  });

  const expected = rows.filter((row) => row.overall.value !== "not_coming");
  const missingArrival = expected.filter((row) => row.missing.includes("arrival")).length;
  return {
    rows,
    counts: {
      total: rows.length,
      ready: rows.filter((row) => row.overall.value === "ready").length,
      missingSomething: expected.filter((row) => row.missing.length > 0).length,
      missingArrival,
      missingLodging: expected.filter((row) => row.missing.includes("lodging")).length,
      missingDeparture: expected.filter((row) => row.missing.includes("departure")).length,
      noReply: expected.filter((row) => row.missing.includes("reply")).length,
      notComing: rows.length - expected.length,
    },
    homeLine: missingArrival > 0 ? `${count(missingArrival, "arrival")} still unbooked` : null,
  };
}

function travelCell(row: ArrivalRow | null, notComing: boolean): TravelCell {
  if (notComing) return { missing: false, label: "", row: null };
  if (!isOnRecord(row)) return { missing: true, label: "Missing", row: row ?? null };
  if (row.mode === "local") return { missing: false, label: "Local", row };
  const when = row.at && row.localDate ? `${formatDate(row.localDate, { weekday: true }).split(",")[0]} ${row.timeText ?? ""}`.trim() : null;
  const how =
    row.mode === "flight" ? (row.flight?.designator ?? "Flight") : row.mode === "drive" ? "Driving" : row.mode === "train" ? "Train" : row.mode === "bus" ? "Bus" : null;
  // "Driving" alone is the whole answer the table asks for; anything timetabled shows its time.
  if (row.mode === "drive") return { missing: false, label: "Driving", row };
  return { missing: false, label: [how, when].filter(Boolean).join(", ") || "On record", row };
}

function lodgingCell(stay: PersonStay | null, notComing: boolean): TravelStatusRow["lodging"] {
  if (notComing || !stay) return { missing: false, label: "", stay };
  if (stay.need === "lives_here") return { missing: false, label: "Lives nearby", stay };
  if (stay.need === "no_dates") return { missing: false, label: "No dates yet", stay };
  if (stay.nights.length === 0) return { missing: false, label: "No nights needed", stay };
  if (stay.uncovered.length === stay.nights.length) return { missing: true, label: "Missing", stay };
  if (stay.uncovered.length > 0) {
    return { missing: true, label: `Missing ${stay.uncovered.length} of ${count(stay.nights.length, "night")}`, stay };
  }
  if (stay.ownArrangement) return { missing: false, label: "Own arrangement", stay };
  return { missing: false, label: stay.line, stay };
}
