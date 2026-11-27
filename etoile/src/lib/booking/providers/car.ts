// Cars: Kayak, Expedia, Turo. Formats exactly as in research/booking-links.md section 4.

import { clockText } from "@/lib/calendar";
import type { PlaceRef } from "@/lib/domain";
import type { CarQuery } from "../types";
import { placeLabel } from "../wording";
import {
  CannotPrefill,
  compact,
  destinationText,
  encodedQuery,
  need,
  needDate,
  timeOrNone,
  unfilledField,
  usDatePadded,
  usDatePlain,
  type BuiltLink,
  type LinkEnv,
} from "./shared";

/** Where a car search box wants the pick-up: the airport code when there is one, else the town. */
function pickupCodeOrText(place: PlaceRef): string {
  return place.iata ?? destinationText(place);
}

function isSamePlace(a: PlaceRef | undefined, b: PlaceRef | undefined): boolean {
  if (!a || !b) return true;
  if (a.iata || b.iata) return a.iata === b.iata;
  return a.name === b.name;
}

function seatsNote(q: CarQuery) {
  return compact([
    q.seats > 5 ? unfilledField("Seats needed", `${q.seats}, so look for a minivan or a large SUV`) : null,
    q.childSeats > 0 ? unfilledField("Child seats", q.childSeats) : null,
  ]);
}

/**
 * Kayak cars. OBSERVED:  /cars/{PICKUP}/{date}/{date}?sort=price_a
 * Cannot carry the pick-up and return times, or a different place to return the car (neither
 * could be confirmed), so both are left to enter.
 */
export function kayakCarsLink(q: CarQuery): BuiltLink {
  const pickup = need(q.pickupPlace, "where you pick the car up");
  const from = needDate(q.pickupDate, "the pick-up date");
  const to = needDate(q.returnDate, "the return date");
  const url = `https://www.kayak.com/cars/${encodeURIComponent(pickupCodeOrText(pickup))}/${from}/${to}?sort=price_a`;
  const pickupTime = timeOrNone(q.pickupTime);
  const returnTime = timeOrNone(q.returnTime);
  return {
    url,
    grade: "observed",
    unfilled: compact([
      pickupTime ? unfilledField("Pick-up time", clockText(pickupTime)) : null,
      returnTime ? unfilledField("Return time", clockText(returnTime)) : null,
      isSamePlace(pickup, q.returnPlace) ? null : unfilledField("Return to", placeLabel(q.returnPlace as PlaceRef)),
      ...seatsNote(q),
    ]),
  };
}

/** "11AM", "5PM": the hour-only form of Expedia's documented car link. */
function hourAmPm(time: string): string {
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? "AM" : "PM"}`;
}

/** "1030AM", "0200PM": the form of Expedia's own car search page. */
function hhmmAmPm(time: string): string {
  const hour = Number(time.slice(0, 2));
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(h12).padStart(2, "0")}${time.slice(3, 5)}${hour < 12 ? "AM" : "PM"}`;
}

/**
 * Expedia cars. Two links:
 *  - DOCUMENTED deeplink, used for an airport pick-up with times on the hour (it writes a time
 *    as "11AM"):  /go/car/search/Airport/{from}/{to}?PickUpLoc={code}&DiffDropLoc=0&PickUpTime=…&DropTime=…&Class=NoPreference
 *    Expedia's own pages disagree on the spelling of this path (/go/car/search/ and /go/carsearch/);
 *    this is the one in its worked example.
 *  - OBSERVED search page otherwise:  /carsearch?locn={text}&loc2={text}&date1=M/D/YYYY&date2=M/D/YYYY&time1=1030AM&time2=1000AM
 */
export function expediaCarsLink(q: CarQuery, env: LinkEnv = {}): BuiltLink {
  const pickup = need(q.pickupPlace, "where you pick the car up");
  const from = needDate(q.pickupDate, "the pick-up date");
  const to = needDate(q.returnDate, "the return date");
  const pickupTime = timeOrNone(q.pickupTime);
  const returnTime = timeOrNone(q.returnTime);
  const dropElsewhere = !isSamePlace(pickup, q.returnPlace);
  const onTheHour = (time: string | undefined) => time === undefined || time.endsWith(":00");

  if (pickup.iata && onTheHour(pickupTime) && onTheHour(returnTime) && (!dropElsewhere || q.returnPlace?.iata)) {
    const url = `https://www.expedia.com/go/car/search/Airport/${from}/${to}?${encodedQuery([
      ["PickUpLoc", pickup.iata.toLowerCase()],
      ["DiffDropLoc", dropElsewhere ? 1 : 0],
      ["DropLoc", dropElsewhere ? q.returnPlace?.iata?.toLowerCase() : null],
      ["PickUpTime", pickupTime ? hourAmPm(pickupTime) : null],
      ["DropTime", returnTime ? hourAmPm(returnTime) : null],
      ["Class", "NoPreference"],
      ["mdpcid", env.partnerIds?.expediaMarketingCode],
    ])}`;
    return { url, grade: "documented", unfilled: seatsNote(q) };
  }

  const text = (place: PlaceRef) => (place.iata && place.name !== place.iata ? `${place.name} (${place.iata})` : pickupCodeOrText(place));
  // Dates and times are written with their slashes as they are, the way the site's own links have them.
  const parts = [
    `locn=${encodeURIComponent(text(pickup))}`,
    ...(dropElsewhere && q.returnPlace ? [`loc2=${encodeURIComponent(text(q.returnPlace))}`] : []),
    `date1=${usDatePlain(from)}`,
    `date2=${usDatePlain(to)}`,
    ...(pickupTime ? [`time1=${hhmmAmPm(pickupTime)}`] : []),
    ...(returnTime ? [`time2=${hhmmAmPm(returnTime)}`] : []),
  ];
  return { url: `https://www.expedia.com/carsearch?${parts.join("&")}`, grade: "observed", unfilled: seatsNote(q) };
}

/**
 * Turo. OBSERVED:
 *   /us/en/search?country=US&location={text}&locationType={AIRPORT|ADDRESS|CITY}&startDate=MM/DD/YYYY&startTime=HH:MM&endDate=MM/DD/YYYY&endTime=HH:MM
 * US only (the path is the US site). The car comes back to where it was picked up, so a
 * different return place is left to arrange with the owner.
 */
export function turoLink(q: CarQuery): BuiltLink {
  const pickup = need(q.pickupPlace, "where you pick the car up");
  if (pickup.countryCode && pickup.countryCode !== "US") throw new CannotPrefill("a pick-up in the United States (this Turo link is for the US site)");
  const from = needDate(q.pickupDate, "the pick-up date");
  const to = needDate(q.returnDate, "the return date");
  const pickupTime = timeOrNone(q.pickupTime);
  const returnTime = timeOrNone(q.returnTime);
  const locationType = pickup.kind === "airport" ? "AIRPORT" : pickup.kind === "city" ? "CITY" : "ADDRESS";
  const location = pickup.kind === "airport" && pickup.name !== pickup.iata ? pickup.name : pickup.kind === "airport" ? `${pickup.iata ?? pickup.name} airport` : destinationText(pickup);
  const url = `https://turo.com/us/en/search?${encodedQuery([
    ["country", "US"],
    ["location", location],
    ["locationType", locationType],
    ["startDate", usDatePadded(from)],
    ["startTime", pickupTime],
    ["endDate", usDatePadded(to)],
    ["endTime", returnTime],
  ])}`;
  return {
    url,
    grade: "observed",
    unfilled: compact([
      // Turo cars go back where they were picked up, so a different return place is for the owner to agree.
      isSamePlace(pickup, q.returnPlace) ? null : unfilledField("Return to (ask the owner)", placeLabel(q.returnPlace as PlaceRef)),
      ...seatsNote(q),
    ]),
  };
}
