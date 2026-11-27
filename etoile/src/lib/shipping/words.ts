// The words Send ahead uses for carriers, places and parcels. Everything here is text a person
// reads, so it follows the build spec's section 3: plain, warm, specific, sentence case, no
// exclamation marks, en dashes for ranges. The word "shipment" never appears: people see a box,
// a bag, a package.

import type { Money, ShipmentDestinationType, ShipmentKind, ShipmentProvider } from "@/lib/domain";
import { formatMoney } from "@/lib/domain/money";
import { formatDate, parseLocalDate, type LocalDate } from "@/lib/time";

/** Carrier and luggage-service names as people know them. */
export const PROVIDER_NAMES: Record<ShipmentProvider, string> = {
  ups: "UPS",
  fedex: "FedEx",
  usps: "USPS",
  dhl: "DHL",
  amazon: "Amazon",
  ontrac: "OnTrac",
  canadapost: "Canada Post",
  royalmail: "Royal Mail",
  lugless: "LugLess",
  luggage_forward: "Luggage Forward",
  shipgo: "ShipGo",
  luggage_free: "Luggage Free",
  send_my_bag: "Send My Bag",
  other: "Another carrier",
};

/**
 * The display name of a carrier or luggage service: carrierName("canadapost") is "Canada Post".
 * Takes any string, because bookings.provider and parcel.carrierDetected are stored as text;
 * an unknown or missing value gives "Another carrier".
 */
export function carrierName(provider: string | null | undefined): string {
  if (provider && Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, provider)) {
    return PROVIDER_NAMES[provider as ShipmentProvider];
  }
  return PROVIDER_NAMES.other;
}

/** "Thu, Dec 10". */
export function dayAndDate(date: LocalDate): string {
  return formatDate(date, { weekday: true });
}

/** "DEC 23, 2026": how a date is written on a label. */
export function labelDate(date: LocalDate): string {
  return formatDate(date, { year: true }).toUpperCase();
}

/** "12/23": the short form for a carrier's 35-character address line. */
export function slashDate(date: LocalDate): string {
  const { month, day } = parseLocalDate(date);
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

/** "1 box", "2 boxes", "1 business day", "3 business days". */
export function count(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** "a", "a and b", "a, b and c". */
export function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** First letter upper-cased, the rest untouched. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What one parcel is called for each kind of thing sent: "bag", "box", "package", "order". */
export function parcelNoun(kind: ShipmentKind | null | undefined): { one: string; many: string } {
  switch (kind) {
    case "luggage":
    case "gear":
      return { one: "bag", many: "bags" };
    case "mail":
      return { one: "package", many: "packages" };
    case "retail_order":
      return { one: "order", many: "orders" };
    case "box":
    case "gift":
    default:
      return { one: "box", many: "boxes" };
  }
}

type DestinationWords = {
  /** "the hotel": the place, in the middle of a sentence. */
  place: string;
  /** "Hotels": the kind of place, starting a sentence about what such places usually do. */
  kindPlural: string;
  /** "the front desk": who to ask about a parcel. */
  whoToAsk: string;
  /** "check in" or "arrive": what the traveler does there. */
  arriveVerb: string;
  /** A short label for a picker: "Hotel", "Family or friend's home". */
  label: string;
};

/** Words for each kind of destination. Typed by the domain list, so a new kind cannot be missed. */
export const DESTINATION_WORDS: Record<ShipmentDestinationType, DestinationWords> = {
  hotel: { place: "the hotel", kindPlural: "Hotels", whoToAsk: "the front desk", arriveVerb: "check in", label: "Hotel" },
  resort: { place: "the resort", kindPlural: "Resorts", whoToAsk: "the front desk", arriveVerb: "check in", label: "Resort" },
  conference_venue: {
    place: "the venue", kindPlural: "Conference hotels and venues", whoToAsk: "the business center or front desk",
    arriveVerb: "arrive", label: "Conference hotel or venue",
  },
  relative_home: {
    place: "the house", kindPlural: "Family and friends", whoToAsk: "your host", arriveVerb: "arrive",
    label: "Family or friend's home",
  },
  vacation_rental: {
    place: "the rental", kindPlural: "Rentals", whoToAsk: "your host", arriveVerb: "check in", label: "Vacation rental",
  },
  cruise_precruise_hotel: {
    place: "the hotel before your cruise", kindPlural: "Hotels", whoToAsk: "the front desk", arriveVerb: "check in",
    label: "Hotel before a cruise",
  },
  ups_access_point: {
    place: "the UPS Access Point", kindPlural: "UPS Access Points", whoToAsk: "the counter", arriveVerb: "arrive",
    label: "UPS Access Point",
  },
  fedex_hold_at_location: {
    place: "the FedEx location", kindPlural: "FedEx locations", whoToAsk: "the counter", arriveVerb: "arrive",
    label: "FedEx Hold at Location",
  },
  usps_general_delivery: {
    place: "the post office", kindPlural: "Post offices", whoToAsk: "the post office counter", arriveVerb: "arrive",
    label: "USPS General Delivery",
  },
  amazon_locker: {
    place: "the Amazon Locker", kindPlural: "Amazon Lockers", whoToAsk: "Amazon", arriveVerb: "arrive", label: "Amazon Locker",
  },
  amazon_counter: {
    place: "the Amazon Counter", kindPlural: "Amazon Counters", whoToAsk: "the counter", arriveVerb: "arrive",
    label: "Amazon Counter",
  },
};

/** The picker label for a destination kind: "Hotel", "Vacation rental", "UPS Access Point". */
export function destinationLabel(destination: ShipmentDestinationType): string {
  return DESTINATION_WORDS[destination].label;
}

/** True for places where a guest's parcel waits behind a desk: hotel, resort, venue, cruise hotel. */
export function isStaffedProperty(destination: ShipmentDestinationType): boolean {
  return (
    destination === "hotel" ||
    destination === "resort" ||
    destination === "conference_venue" ||
    destination === "cruise_precruise_hotel"
  );
}

/** True for the five pickup points, where nobody needs to be asked first. */
export function isPickupPoint(destination: ShipmentDestinationType): boolean {
  return (
    destination === "ups_access_point" ||
    destination === "fedex_hold_at_location" ||
    destination === "usps_general_delivery" ||
    destination === "amazon_locker" ||
    destination === "amazon_counter"
  );
}

/** "$10", "$12.50": money for a sentence. Whole amounts lose the ".00". */
export function plainMoney(money: Money): string {
  return formatMoney(money).replace(/\.00$/, "");
}
