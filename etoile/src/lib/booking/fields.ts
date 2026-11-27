// A search, said as lines a person can read and edit. The lines are always derived from the
// query, so what is shown and what the links carry can never disagree.

import { EN_DASH } from "@/lib/time";
import { headCountText } from "./context";
import type {
  CarQuery,
  FlightQuery,
  FoodQuery,
  Proposal,
  ProposalField,
  RideQuery,
  SearchQuery,
  SearchQueryOf,
  StayQuery,
} from "./types";
import {
  CABIN_LABELS,
  countOf,
  dateSpanText,
  dateText,
  dateTimeText,
  LODGING_TYPE_LABELS,
  MEAL_TYPE_LABELS,
  NOT_SET,
  placeLabel,
  placeSearchText,
  timeSpanText,
} from "./wording";

/** Why the app chose a value, by field key. */
export type Reasons = Readonly<Record<string, string | undefined>>;

const DOT = " · ";

function field(key: string, label: string, value: string | number | null | undefined, display: string | null | undefined, reasons: Reasons): ProposalField {
  const known = value !== null && value !== undefined && value !== "";
  const out: ProposalField = { key, label, value: known ? value : null, display: known && display ? display : NOT_SET };
  if (known && reasons[key]) out.because = reasons[key];
  return out;
}

function airportText(code: string | undefined, label: string | undefined): string | undefined {
  if (!code) return undefined;
  return label && label !== code ? label : code;
}

function travelersLine(q: { adults: number; children: number; infants: number }): string {
  return headCountText(q);
}

function when(date: string | undefined, time: string | undefined): { value: string | null; display: string | null } {
  if (!date) return { value: null, display: null };
  return time ? { value: `${date}T${time}`, display: dateTimeText(date, time) } : { value: date, display: dateText(date) };
}

function flightFields(q: FlightQuery, reasons: Reasons): ProposalField[] {
  const total = q.adults + q.children + q.infants;
  const fields = [
    field("from", "Flying from", q.originIata, airportText(q.originIata, q.originLabel), reasons),
    field("to", "Flying to", q.destinationIata, airportText(q.destinationIata, q.destinationLabel), reasons),
    field("depart", "Leaving", q.departDate, q.departDate ? dateText(q.departDate) : null, reasons),
  ];
  if (q.tripType === "one_way") {
    fields.push({ key: "return", label: "Coming back", value: null, display: "One way, no flight back" });
  } else {
    fields.push(field("return", "Coming back", q.returnDate, q.returnDate ? dateText(q.returnDate) : null, reasons));
  }
  for (const [index, leg] of (q.tripType === "multi_city" ? (q.legs ?? []) : []).entries()) {
    fields.push({
      key: `leg${index + 2}`,
      label: `Flight ${index + 2}`,
      value: `${leg.originIata}-${leg.destinationIata}`,
      display: `${leg.originIata} to ${leg.destinationIata}, ${dateText(leg.date)}`,
    });
  }
  fields.push(
    field("travelers", "Who's flying", total > 0 ? total : null, travelersLine(q), reasons),
    field("cabin", "Cabin", q.cabin, CABIN_LABELS[q.cabin], reasons),
  );
  return fields;
}

function stayFields(q: StayQuery, reasons: Reasons): ProposalField[] {
  const total = q.adults + q.children + q.infants;
  const home = q.lodgingType === "rental" || q.lodgingType === "family_home";
  return [
    field("where", "Where", q.place?.name, q.place ? placeSearchText(q.place) : null, reasons),
    field("checkIn", "Check-in", q.checkInDate, q.checkInDate ? dateText(q.checkInDate) : null, reasons),
    field("checkOut", "Check-out", q.checkOutDate, q.checkOutDate ? dateText(q.checkOutDate) : null, reasons),
    field("guests", "Who's staying", total > 0 ? total : null, travelersLine(q), reasons),
    field("type", "Kind of place", q.lodgingType, LODGING_TYPE_LABELS[q.lodgingType], reasons),
    field("rooms", home ? "Homes" : "Rooms", q.rooms, home ? countOf(q.rooms, "home", "homes") : countOf(q.rooms, "room", "rooms"), reasons),
  ];
}

function carFields(q: CarQuery, reasons: Reasons): ProposalField[] {
  const pickup = when(q.pickupDate, q.pickupTime);
  const back = when(q.returnDate, q.returnTime);
  const returnPlace = q.returnPlace ?? q.pickupPlace;
  const fields = [
    field("pickupPlace", "Pick up at", q.pickupPlace ? (q.pickupPlace.iata ?? q.pickupPlace.name) : null, q.pickupPlace ? placeLabel(q.pickupPlace) : null, reasons),
    field("pickup", "Pick-up time", pickup.value, pickup.display, reasons),
    field("returnPlace", "Return to", returnPlace ? (returnPlace.iata ?? returnPlace.name) : null, returnPlace ? placeLabel(returnPlace) : null, reasons),
    field("return", "Return time", back.value, back.display, reasons),
    field("seats", "Seats", q.seats > 0 ? q.seats : null, countOf(q.seats, "seat", "seats"), reasons),
  ];
  if (q.childSeats > 0) fields.push(field("childSeats", "Child seats", q.childSeats, countOf(q.childSeats, "child seat", "child seats"), reasons));
  return fields;
}

function rideFields(q: RideQuery, reasons: Reasons): ProposalField[] {
  const pickup = when(q.pickupDate, q.pickupTime);
  const fields = [
    field("from", "Pick up at", q.fromPlace ? (q.fromPlace.iata ?? q.fromPlace.name) : null, q.fromPlace ? placeLabel(q.fromPlace) : null, reasons),
    field("to", "Going to", q.toPlace ? (q.toPlace.iata ?? q.toPlace.name) : null, q.toPlace ? placeLabel(q.toPlace) : null, reasons),
    field("pickup", "Pick-up time", pickup.value, pickup.display, reasons),
    field("riders", "Riders", q.passengers > 0 ? q.passengers : null, countOf(q.passengers, "person", "people"), reasons),
  ];
  if (q.bags !== undefined) fields.push(field("bags", "Bags", q.bags, countOf(q.bags, "bag", "bags"), reasons));
  if (q.childSeatNeeded) fields.push(field("childSeat", "Child seat", "needed", "Needed", reasons));
  return fields;
}

function foodWhen(q: FoodQuery): { value: string | null; display: string | null } {
  if (!q.date) return { value: null, display: null };
  if (q.windowStart && q.windowEnd) {
    return { value: `${q.date}T${q.windowStart}`, display: `${dateText(q.date)}, ${timeSpanText(q.windowStart, q.windowEnd)}` };
  }
  return when(q.date, q.windowStart);
}

function foodFields(q: FoodQuery, reasons: Reasons): ProposalField[] {
  const time = foodWhen(q);
  const fields = [
    field("what", "What", q.mealType, MEAL_TYPE_LABELS[q.mealType], reasons),
    field("search", q.mealType === "groceries" ? "Store or item" : "Cuisine or restaurant", q.searchText, q.searchText, reasons),
    field("deliverTo", "Deliver to", q.deliverToPlace?.name, q.deliverToPlace ? placeLabel(q.deliverToPlace) : null, reasons),
    field("when", "Deliver at", time.value, time.display, reasons),
    field("headcount", "How many", q.headcount > 0 ? q.headcount : null, countOf(q.headcount, "person", "people"), reasons),
  ];
  if (q.dietarySummary) fields.push(field("dietary", "Dietary needs", q.dietarySummary, q.dietarySummary, reasons));
  if (q.deliveryNote) fields.push(field("note", "Delivery note", q.deliveryNote, q.deliveryNote, reasons));
  return fields;
}

/** The lines for a search, in the order to show them. `reasons` adds a "because" to the lines the app worked out. */
export function fieldsForQuery(query: SearchQuery, reasons: Reasons = {}): ProposalField[] {
  switch (query.kind) {
    case "flight":
      return flightFields(query, reasons);
    case "lodging":
      return stayFields(query, reasons);
    case "car":
      return carFields(query, reasons);
    case "ride":
      return rideFields(query, reasons);
    case "meal":
      return foodFields(query, reasons);
  }
}

/** One line of what will be searched: "SEA to MCO · Sat, Dec 19 – Sun, Dec 27 · 2 adults, 2 children · Economy". */
export function summaryForQuery(query: SearchQuery): string {
  const parts: Array<string | null | undefined> = [];
  switch (query.kind) {
    case "flight": {
      parts.push(query.originIata && query.destinationIata ? `${query.originIata} to ${query.destinationIata}` : (query.destinationIata ?? query.originIata));
      if (query.departDate) {
        parts.push(query.tripType !== "one_way" && query.returnDate ? dateSpanText(query.departDate, query.returnDate) : `${dateText(query.departDate)}, one way`);
      }
      if (query.adults + query.children + query.infants > 0) parts.push(headCountText(query));
      parts.push(CABIN_LABELS[query.cabin]);
      break;
    }
    case "lodging": {
      parts.push(query.place ? placeSearchText(query.place) : null);
      if (query.checkInDate && query.checkOutDate) parts.push(dateSpanText(query.checkInDate, query.checkOutDate));
      else if (query.checkInDate) parts.push(`From ${dateText(query.checkInDate)}`);
      if (query.adults + query.children + query.infants > 0) parts.push(headCountText(query));
      parts.push(LODGING_TYPE_LABELS[query.lodgingType]);
      break;
    }
    case "car": {
      parts.push(query.pickupPlace ? placeLabel(query.pickupPlace) : null);
      const from = when(query.pickupDate, query.pickupTime).display;
      const to = when(query.returnDate, query.returnTime).display;
      parts.push(from && to ? `${from} ${EN_DASH} ${to}` : from);
      if (query.seats > 0) parts.push(countOf(query.seats, "seat", "seats"));
      break;
    }
    case "ride": {
      const ends = [query.fromPlace, query.toPlace].map((place) => (place ? placeLabel(place) : null));
      parts.push(ends[0] && ends[1] ? `${ends[0]} to ${ends[1]}` : (ends[0] ?? ends[1]));
      parts.push(when(query.pickupDate, query.pickupTime).display);
      if (query.passengers > 0) parts.push(countOf(query.passengers, "rider", "riders"));
      break;
    }
    case "meal": {
      parts.push(MEAL_TYPE_LABELS[query.mealType]);
      parts.push(query.deliverToPlace ? placeLabel(query.deliverToPlace) : null);
      parts.push(foodWhen(query).display);
      if (query.headcount > 0) parts.push(countOf(query.headcount, "person", "people"));
      break;
    }
  }
  const said = parts.filter((part): part is string => Boolean(part));
  return said.length > 0 ? said.join(DOT) : "Nothing filled in yet";
}

// Which parts of a query each line is made from. When the person changes one of those parts,
// the line's "because" goes: it is their choice now, not the app's.
const FIELD_SOURCES: Readonly<Record<SearchQuery["kind"], Readonly<Record<string, readonly string[]>>>> = {
  flight: {
    from: ["originIata", "originLabel"],
    to: ["destinationIata", "destinationLabel"],
    depart: ["departDate"],
    return: ["returnDate", "tripType"],
    travelers: ["adults", "children", "infants", "childAges"],
    cabin: ["cabin"],
  },
  lodging: {
    where: ["place"],
    checkIn: ["checkInDate"],
    checkOut: ["checkOutDate"],
    guests: ["adults", "children", "infants", "childAges"],
    type: ["lodgingType"],
    rooms: ["rooms"],
  },
  car: {
    pickupPlace: ["pickupPlace"],
    pickup: ["pickupDate", "pickupTime"],
    returnPlace: ["returnPlace"],
    return: ["returnDate", "returnTime"],
    seats: ["seats"],
    childSeats: ["childSeats"],
  },
  ride: {
    from: ["fromPlace"],
    to: ["toPlace"],
    pickup: ["pickupDate", "pickupTime"],
    riders: ["passengers", "passengerIds"],
    bags: ["bags"],
    childSeat: ["childSeatNeeded"],
  },
  meal: {
    what: ["mealType"],
    search: ["searchText"],
    deliverTo: ["deliverToPlace"],
    when: ["date", "windowStart", "windowEnd"],
    headcount: ["headcount"],
    dietary: ["dietarySummary"],
    note: ["deliveryNote"],
  },
};

/**
 * A proposal with some of its search changed by the person: `reviseProposal(p, { pickupTime: "17:30" })`.
 * The lines and the summary are rebuilt from the new search. Lines the person changed lose their
 * "because"; the others keep theirs. The original proposal is not touched.
 *
 * Changing an airport code without giving a new label shows the code alone.
 */
export function reviseProposal<P extends Proposal>(proposal: P, changes: Partial<Omit<SearchQueryOf<P["kind"]>, "kind">>): P {
  const changed = new Set(Object.keys(changes));
  const query = { ...proposal.query, ...changes } as SearchQuery;
  if (query.kind === "flight") {
    if (changed.has("originIata") && !changed.has("originLabel")) delete query.originLabel;
    if (changed.has("destinationIata") && !changed.has("destinationLabel")) delete query.destinationLabel;
  }
  const sources = FIELD_SOURCES[proposal.kind];
  const reasons: Record<string, string | undefined> = {};
  for (const existing of proposal.fields) {
    const from = sources[existing.key] ?? [];
    if (existing.because && !from.some((name) => changed.has(name))) reasons[existing.key] = existing.because;
  }
  return { ...proposal, query, fields: fieldsForQuery(query, reasons), summary: summaryForQuery(query) } as P;
}
