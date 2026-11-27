// Places to stay: Booking.com, Airbnb, Vrbo, Hotels.com, Expedia.
// Formats exactly as in research/booking-links.md section 3.

import { headCountText } from "../context";
import type { StayQuery } from "../types";
import {
  adultsPerRoom,
  agesText,
  compact,
  destinationText,
  encodedQuery,
  need,
  needDate,
  unfilledField,
  type BuiltLink,
  type LinkEnv,
} from "./shared";

type Basics = { destination: string; checkIn: string; checkOut: string };

function basics(q: StayQuery): Basics {
  return {
    destination: destinationText(need(q.place, "where you are staying")),
    checkIn: needDate(q.checkInDate, "the check-in date"),
    checkOut: needDate(q.checkOutDate, "the check-out date"),
  };
}

const kids = (q: StayQuery) => q.children + q.infants;
/** Every child's and infant's age, or null when some are not known. */
const allAges = (q: StayQuery) => (kids(q) === 0 ? [] : q.childAges.length === kids(q) ? q.childAges : null);
const kidsText = (q: StayQuery) => headCountText({ adults: 0, children: q.children, infants: q.infants });

/**
 * Booking.com. OBSERVED (the search page itself is not documented, though its date and guest
 * parameters appear in Booking's partner docs):
 *   searchresults.html?ss={place}&checkin=…&checkout=…&group_adults=…&no_rooms=…&group_children=…&age=…&age=…
 * Children go with one `age` each (0 to 17), so they are only sent when every age is known.
 */
export function bookingComLink(q: StayQuery, env: LinkEnv = {}): BuiltLink {
  const { destination, checkIn, checkOut } = basics(q);
  const ages = allAges(q);
  const url = `https://www.booking.com/searchresults.html?${encodedQuery([
    ["ss", destination],
    ["checkin", checkIn],
    ["checkout", checkOut],
    ["group_adults", q.adults],
    ["no_rooms", Math.max(1, q.rooms)],
    ["group_children", ages && ages.length > 0 ? ages.length : null],
    ...(ages ?? []).map((age): [string, number] => ["age", age]),
    ["aid", env.partnerIds?.bookingAid],
  ])}`;
  return {
    url,
    grade: "observed",
    unfilled: compact([kids(q) > 0 && !ages ? unfilledField("Children (they ask each age)", kidsText(q)) : null]),
  };
}

/**
 * Airbnb. OBSERVED:
 *   /s/{Place--Region}/homes?checkin=…&checkout=…&adults=…&children=…&infants=…&pets=0
 * The place is a slug: parts joined with "--", spaces as "-". Airbnb counts ages 2 to 12 as
 * children and under 2 as infants, and takes counts only, so nothing is left to enter.
 */
export function airbnbLink(q: StayQuery): BuiltLink {
  const { destination, checkIn, checkOut } = basics(q);
  const slug = destination
    .split(",")
    .map((part) => encodeURIComponent(part.trim().replace(/\s+/g, "-")))
    .filter(Boolean)
    .join("--");
  // With ages on record: 13 and over count as adults, 2 to 12 as children, under 2 as infants.
  const ages = allAges(q);
  const counts = ages
    ? {
        adults: q.adults + ages.filter((age) => age >= 13).length,
        children: ages.filter((age) => age >= 2 && age < 13).length,
        infants: ages.filter((age) => age < 2).length,
      }
    : { adults: q.adults, children: q.children, infants: q.infants };
  const url = `https://www.airbnb.com/s/${slug}/homes?${encodedQuery([
    ["checkin", checkIn],
    ["checkout", checkOut],
    ["adults", counts.adults],
    ["children", counts.children],
    ["infants", counts.infants],
    ["pets", 0],
  ])}`;
  return { url, grade: "observed", unfilled: [] };
}

/**
 * Vrbo. OBSERVED, and it has changed its format once before (2021):
 *   /search?destination={place}&startDate=…&endDate=…&adults=…
 * How children are written has not been confirmed, so they are left to enter.
 */
export function vrboLink(q: StayQuery): BuiltLink {
  const { destination, checkIn, checkOut } = basics(q);
  const url = `https://www.vrbo.com/search?${encodedQuery([
    ["destination", destination],
    ["startDate", checkIn],
    ["endDate", checkOut],
    ["adults", q.adults],
  ])}`;
  return {
    url,
    grade: "observed",
    unfilled: compact([kids(q) > 0 ? unfilledField("Children", childrenWithAges(q)) : null]),
  };
}

function childrenWithAges(q: StayQuery): string {
  const ages = allAges(q);
  return ages && ages.length > 0 ? `${kidsText(q)} (ages ${agesText(ages)})` : kidsText(q);
}

/** Rooms with their adults, and each child placed in a room in turn: "1_12,1_9" is room 1, ages 12 and 9. */
function roomPlan(q: StayQuery): { adults: number[]; children: Array<{ room: number; age: number }> | null } {
  const adults = adultsPerRoom(q.adults, q.rooms);
  const ages = allAges(q);
  const children = ages ? ages.map((age, index) => ({ room: (index % adults.length) + 1, age })) : null;
  return { adults, children };
}

/**
 * Hotels.com. OBSERVED:
 *   /Hotel-Search?destination={place}&startDate=…&endDate=…&adults={per room, comma list}&rooms=…&children={room_age,…}
 * Each child is "{room}_{age}", so children are only sent when every age is known.
 */
export function hotelsComLink(q: StayQuery): BuiltLink {
  const { destination, checkIn, checkOut } = basics(q);
  const plan = roomPlan(q);
  const url = `https://www.hotels.com/Hotel-Search?${encodedQuery([
    ["destination", destination],
    ["startDate", checkIn],
    ["endDate", checkOut],
    ["adults", plan.adults.join(",")],
    ["rooms", plan.adults.length],
    ["children", plan.children && plan.children.length > 0 ? plan.children.map((c) => `${c.room}_${c.age}`).join(",") : null],
  ])}`;
  return {
    url,
    grade: "observed",
    unfilled: compact([kids(q) > 0 && !plan.children ? unfilledField("Children (they ask each age)", kidsText(q)) : null]),
  };
}

/**
 * Expedia hotels. DOCUMENTED deeplink (Expedia Group "Lodging deeplinks"):
 *   /go/hotel/search/Destination/{start}/{end}?CityName={city}&NumRoom=…&NumAdult1=…&NumChild1=…&Rm1child1age=…
 * Expedia's notes say it searches up to 330 days ahead.
 */
export function expediaStayLink(q: StayQuery, env: LinkEnv = {}): BuiltLink {
  const { destination, checkIn, checkOut } = basics(q);
  const plan = roomPlan(q);
  const pairs: Array<[string, string | number | null | undefined]> = [
    ["CityName", destination],
    ["NumRoom", plan.adults.length],
  ];
  plan.adults.forEach((count, index) => {
    const room = index + 1;
    pairs.push([`NumAdult${room}`, count]);
    const here = (plan.children ?? []).filter((child) => child.room === room);
    if (here.length > 0) {
      pairs.push([`NumChild${room}`, here.length]);
      here.forEach((child, childIndex) => pairs.push([`Rm${room}child${childIndex + 1}age`, child.age]));
    }
  });
  pairs.push(["mdpcid", env.partnerIds?.expediaMarketingCode]);
  return {
    url: `https://www.expedia.com/go/hotel/search/Destination/${checkIn}/${checkOut}?${encodedQuery(pairs)}`,
    grade: "documented",
    unfilled: compact([kids(q) > 0 && !plan.children ? unfilledField("Children (they ask each age)", kidsText(q)) : null]),
  };
}
