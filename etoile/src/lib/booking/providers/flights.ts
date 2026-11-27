// Flight search links: Google Flights, Kayak, Skyscanner, Expedia.
// Formats exactly as in research/booking-links.md section 2. Each builder says in a comment what
// is documented by the provider and what is only an observed pattern.

import type { Cabin } from "@/lib/domain";
import { headCountText } from "../context";
import type { FlightQuery } from "../types";
import { CABIN_LABELS } from "../wording";
import {
  agesText,
  CannotPrefill,
  compact,
  encodedQuery,
  need,
  needDate,
  unfilledField,
  usDatePadded,
  yymmdd,
  type BuiltLink,
  type LinkEnv,
} from "./shared";

type Route = { origin: string; destination: string; depart: string; back: string | undefined };

function route(q: FlightQuery): Route {
  return {
    origin: need(q.originIata, "the airport you are flying from"),
    destination: need(q.destinationIata, "the airport you are flying to"),
    depart: needDate(q.departDate, "the day you leave"),
    back: q.tripType === "round_trip" && q.returnDate ? needDate(q.returnDate, "the day you come back") : undefined,
  };
}

/** "2 adults, 2 children (ages 9 and 5)". */
function travelersText(q: FlightQuery): string {
  const ages = q.childAges && q.childAges.length > 0 ? ` (ages ${agesText(q.childAges)})` : "";
  return `${headCountText(q)}${ages}`;
}

/**
 * The ages of the children (not the infants), or null when they are not all known. `childAges`
 * may hold the children's ages alone, or the children's and infants' together.
 */
function childrenAges(q: FlightQuery): number[] | null {
  const ages = q.childAges ?? [];
  if (q.children === 0) return [];
  if (ages.length === q.children) return ages;
  if (ages.length === q.children + q.infants) return [...ages].sort((a, b) => b - a).slice(0, q.children);
  return null;
}

function isJustOneAdult(q: FlightQuery): boolean {
  return q.adults === 1 && q.children === 0 && q.infants === 0;
}

/**
 * Google Flights. OBSERVED: Google publishes no link format. A plain-English sentence in `q`:
 *   round trip  "Flights to {DEST} from {ORIG} on {date} through {date}"
 *   one way     "Flights from {ORIG} to {DEST} on {date} one way"
 * Cannot carry: who is flying, the cabin, or more than one stop (multi-city).
 */
export function googleFlightsLink(q: FlightQuery, env: LinkEnv = {}): BuiltLink {
  if (q.tripType === "multi_city") throw new CannotPrefill("a single route (Google Flights links cannot carry several stops)");
  const { origin, destination, depart, back } = route(q);
  const sentence = back
    ? `Flights to ${destination} from ${origin} on ${depart} through ${back}`
    : `Flights from ${origin} to ${destination} on ${depart} one way`;
  const url = `https://www.google.com/travel/flights?${encodedQuery([
    ["q", sentence],
    ["hl", "en"],
    ["curr", env.currency ?? "USD"],
  ])}`;
  return {
    url,
    grade: "observed",
    unfilled: compact([
      isJustOneAdult(q) ? null : unfilledField("Travelers", travelersText(q)),
      q.cabin === "economy" ? null : unfilledField("Cabin", CABIN_LABELS[q.cabin]),
    ]),
  };
}

/**
 * Kayak flights. OBSERVED. Everything is in the path:
 *   /flights/{ORIG}-{DEST}/{depart}[/{return}][/business][/{N}adults]?sort=bestflight_a
 *   /flights/{O1}-{D1}/{date1}/{O2}-{D2}/{date2}/…            (several stops)
 * Only "business" has been seen as a cabin word, so premium economy and first are left for the
 * person to choose. Children are not sent: the spelling of that part is not confirmed.
 */
export function kayakFlightsLink(q: FlightQuery): BuiltLink {
  const { origin, destination, depart, back } = route(q);
  const seg = encodeURIComponent;
  const kids = q.children + q.infants > 0;

  if (q.tripType === "multi_city" && q.legs?.length) {
    const legs = [{ originIata: origin, destinationIata: destination, date: depart }, ...q.legs];
    const path = legs.map((leg) => `${seg(leg.originIata)}-${seg(leg.destinationIata)}/${needDate(leg.date, "a flight date")}`).join("/");
    return {
      url: `https://www.kayak.com/flights/${path}`,
      grade: "observed",
      unfilled: compact([
        isJustOneAdult(q) ? null : unfilledField("Travelers", travelersText(q)),
        q.cabin === "economy" ? null : unfilledField("Cabin", CABIN_LABELS[q.cabin]),
      ]),
    };
  }

  const parts = [`${seg(origin)}-${seg(destination)}`, depart];
  if (back) parts.push(back);
  if (q.cabin === "business") parts.push("business");
  if (q.adults >= 2) parts.push(`${q.adults}adults`);
  return {
    url: `https://www.kayak.com/flights/${parts.join("/")}?sort=bestflight_a`,
    grade: "observed",
    unfilled: compact([
      kids ? unfilledField("Children", travelersText({ ...q, adults: 0 })) : null,
      q.cabin === "premium_economy" || q.cabin === "first" ? unfilledField("Cabin", CABIN_LABELS[q.cabin]) : null,
    ]),
  };
}

const SKYSCANNER_CABIN: Readonly<Record<Cabin, string>> = {
  economy: "economy",
  premium_economy: "premiumeconomy",
  business: "business",
  first: "first",
};

/**
 * Skyscanner. Two links:
 *  - DOCUMENTED (Affiliates Link API), used when a `skyscannerMediaPartnerId` is set:
 *    skyscanner.net/g/referrals/v1/flights/day-view/?origin=…&destination=…&outboundDate=…
 *  - OBSERVED consumer page otherwise, which needs no id:
 *    skyscanner.com/transport/flights/{orig}/{dest}/{YYMMDD}/[{YYMMDD}/]?adultsv2=…&cabinclass=…&childrenv2=…&rtn=…
 * Children are sent by age ("9|5"); when ages are not all known they are left to enter by hand.
 * Infants are not sent.
 */
export function skyscannerFlightsLink(q: FlightQuery, env: LinkEnv = {}): BuiltLink {
  if (q.tripType === "multi_city") throw new CannotPrefill("a single route (the Skyscanner link cannot carry several stops)");
  const { origin, destination, depart, back } = route(q);
  const o = origin.toLowerCase();
  const d = destination.toLowerCase();
  const childAges = childrenAges(q);
  const children = childAges ? childAges.join("|") : "";
  const cabin = SKYSCANNER_CABIN[q.cabin];
  const unfilled = compact([
    q.children > 0 && !childAges ? unfilledField("Children", headCountText({ adults: 0, children: q.children, infants: 0 })) : null,
    q.infants > 0 ? unfilledField("Infants", headCountText({ adults: 0, children: 0, infants: q.infants })) : null,
  ]);

  const partner = env.partnerIds?.skyscannerMediaPartnerId;
  if (partner) {
    const url = `https://skyscanner.net/g/referrals/v1/flights/day-view/?${encodedQuery([
      ["origin", o],
      ["destination", d],
      ["outboundDate", depart],
      ["inboundDate", back],
      ["adultsv2", q.adults],
      ["childrenv2", children],
      ["cabinclass", cabin],
      ["mediaPartnerId", partner],
    ])}`;
    return { url, grade: "documented", unfilled };
  }

  const dates = back ? `${yymmdd(depart)}/${yymmdd(back)}` : yymmdd(depart);
  const url = `https://www.skyscanner.com/transport/flights/${encodeURIComponent(o)}/${encodeURIComponent(d)}/${dates}/?${encodedQuery([
    ["adultsv2", q.adults],
    ["cabinclass", cabin],
    ["childrenv2", children, true],
    ["rtn", back ? 1 : 0],
  ])}`;
  return { url, grade: "observed", unfilled };
}

const EXPEDIA_CABIN: Readonly<Record<Cabin, string>> = {
  economy: "economy",
  premium_economy: "premium_economy",
  business: "business",
  first: "first",
};

/**
 * Expedia flights. Two links, as the research recommends:
 *  - DOCUMENTED deeplink when the cabin is economy (it has no cabin parameter):
 *    /go/flight/search/{Roundtrip|oneway}/{start}/{end}?load=1&FromAirport=…&ToAirport=…&FromTime=362&ToTime=362&NumAdult=…
 *    (`FromTime`/`ToTime=362` are copied from Expedia's own examples, which do not explain them.)
 *  - OBSERVED `Flights-Search` page when a cabin has to be carried.
 * Children are sent with their ages on the documented link; without ages they are left to enter.
 * Infants are never sent. Several stops (multi-city) are not supported by either link.
 */
export function expediaFlightsLink(q: FlightQuery, env: LinkEnv = {}): BuiltLink {
  if (q.tripType === "multi_city") throw new CannotPrefill("a single route (the Expedia link cannot carry several stops)");
  const { origin, destination, depart, back } = route(q);
  const childAges = childrenAges(q);
  const infants = q.infants > 0 ? unfilledField("Infants", headCountText({ adults: 0, children: 0, infants: q.infants })) : null;

  if (q.cabin === "economy") {
    // For a one-way search the second date is required by the path but not used.
    const end = back ?? (q.returnDate ? needDate(q.returnDate, "the second date") : depart);
    const url = `https://www.expedia.com/go/flight/search/${back ? "Roundtrip" : "oneway"}/${depart}/${end}?${encodedQuery([
      ["load", 1],
      ["FromAirport", origin],
      ["ToAirport", destination],
      ["FromTime", 362],
      ["ToTime", back ? 362 : null],
      ["NumAdult", q.adults],
      ["NumChild", childAges && childAges.length > 0 ? childAges.length : null],
      ...(childAges ?? []).map((age, index): [string, number] => [`Child${index + 1}Age`, age]),
      ["mdpcid", env.partnerIds?.expediaMarketingCode],
    ])}`;
    return {
      url,
      grade: "documented",
      unfilled: compact([
        q.children > 0 && !childAges ? unfilledField("Children", headCountText({ adults: 0, children: q.children, infants: 0 })) : null,
        infants,
      ]),
    };
  }

  // The observed page is written with its colons, commas and slashes as they are.
  const leg = (from: string, to: string, date: string) => `from:${from},to:${to},departure:${usDatePadded(date)}TANYT`;
  const parts = [
    `trip=${back ? "roundtrip" : "oneway"}`,
    `leg1=${leg(origin, destination, depart)}`,
    ...(back ? [`leg2=${leg(destination, origin, back)}`] : []),
    `passengers=adults:${q.adults},children:${q.children},seniors:0,infantinlap:Y`,
    `options=cabinclass:${EXPEDIA_CABIN[q.cabin]}`,
    "mode=search",
  ];
  return {
    url: `https://www.expedia.com/Flights-Search?${parts.join("&")}`,
    grade: "observed",
    unfilled: compact([
      q.children > 0 ? unfilledField("Children's ages", childAges ? agesText(childAges) : "Enter each child's age") : null,
      infants,
    ]),
  };
}
