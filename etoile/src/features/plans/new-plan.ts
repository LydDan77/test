// Pure helpers for the new-plan flow: reading the box of names, suggesting a name for the plan.
// No database and no server-only imports, so the flow's client components can use them to show
// the same answers the server will give.

import type { PlaceRef, PlanTemplate, WorkMode } from "@/lib/domain";
import { parseLocalDate, toLocalDate, weekday } from "@/lib/time/dates";

export const MAX_PEOPLE = 500;
export const MAX_NAMES = 200;

export type NamedPerson = { name: string; email: string | null };

const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

/** "dana.hartley@example.com" to "Dana Hartley": a name to start from when only an email was given. */
function nameFromEmail(email: string): string {
  const words = email
    .split("@")[0]
    .replace(/\+.*$/, "")
    .split(/[._-]+/)
    .filter(Boolean);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  return name || email;
}

/**
 * Reads the "names, one per line" box. Understood on each line:
 *   Dana Hartley
 *   Dana Hartley <dana@example.com>
 *   Dana Hartley, dana@example.com      (also with a space, a tab or a semicolon between)
 *   dana@example.com                    (the name is made from the address)
 * Blank lines are skipped, a name given twice is kept once (the first), and a line with
 * something that is not an address after the name keeps the whole line as the name.
 */
export function parseNameLines(text: string): NamedPerson[] {
  const people: NamedPerson[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim().replace(/^[-*•]\s*/, "");
    if (!line) continue;

    let name = line;
    let email: string | null = null;

    const angled = /^(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(line);
    if (angled && EMAIL.test(angled[2])) {
      name = angled[1];
      email = angled[2];
    } else if (EMAIL.test(line)) {
      name = "";
      email = line;
    } else {
      const trailing = /^(.*?)[\s,;]+([^\s,;]+)$/.exec(line);
      if (trailing && EMAIL.test(trailing[2])) {
        name = trailing[1];
        email = trailing[2];
      }
    }

    name = name.replace(/^["'“”]+|["'“”,;]+$/g, "").trim();
    if (email) email = email.toLowerCase();
    if (!name && email) name = nameFromEmail(email);
    if (!name) continue;
    name = name.slice(0, 120);

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ name, email });
    if (people.length >= MAX_NAMES) break;
  }
  return people;
}

/** The nth (1-based) given weekday of a month: the 4th Thursday of November. */
function nthWeekday(year: number, month: number, day: number, n: number): string {
  const first = weekday(toLocalDate(year, month, 1));
  return toLocalDate(year, month, 1 + ((day - first + 7) % 7) + (n - 1) * 7);
}

/** A holiday the dates include that people name a plan after, or null. */
function occasion(startDate: string | null | undefined, endDate: string | null | undefined, countryCode: string | undefined): string | null {
  if (!startDate) return null;
  const end = endDate && endDate >= startDate ? endDate : startDate;
  const includes = (date: string) => date >= startDate && date <= end;
  const startYear = parseLocalDate(startDate).year;
  const us = !countryCode || countryCode === "US";
  for (const year of [startYear, startYear + 1]) {
    if (includes(toLocalDate(year, 12, 25))) return "Christmas";
    if (us && includes(nthWeekday(year, 11, 4, 4))) return "Thanksgiving";
    if (includes(toLocalDate(year, 1, 1))) return "New Year's";
    if (us && includes(toLocalDate(year, 7, 4))) return "Fourth of July";
  }
  return null;
}

export type TitleInput = {
  template: PlanTemplate;
  workMode?: WorkMode | null;
  destination?: Pick<PlaceRef, "name" | "countryCode" | "kind" | "locality"> | null;
  startDate?: string | null;
  endDate?: string | null;
};

/**
 * The name the new-plan flow suggests: "Christmas in Orlando" when the dates include a holiday
 * people name plans after, otherwise the kind of plan and the place ("Trip to Lisbon",
 * "Work event in Austin"). The person can change it.
 */
export function suggestPlanTitle(input: TitleInput): string {
  const destination = input.destination;
  // An airport as the destination reads better as its city.
  const place = destination ? (destination.kind === "airport" && destination.locality ? destination.locality : destination.name) : null;

  if (input.template !== "work") {
    const holiday = occasion(input.startDate, input.endDate, destination?.countryCode);
    if (holiday) return place ? `${holiday} in ${place}` : holiday;
  }
  if (input.template === "family_event") return place ? `Family get-together in ${place}` : "Family get-together";
  if (input.template === "trip") return place ? `Trip to ${place}` : "Trip";
  if (input.workMode === "event") return place ? `Work event in ${place}` : "Work event";
  return place ? `Work trip to ${place}` : "Work trip";
}
