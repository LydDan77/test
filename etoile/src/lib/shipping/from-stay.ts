// "Where is it going? It knows where she is staying." Turns a recorded stay into the starting
// answers for the Send ahead flow, so she is asked only what the app does not already know.

import type { LodgingDetails, LodgingType, PlaceRef, ShipmentDestinationType } from "@/lib/domain";
import type { LocalDate } from "@/lib/time";
import type { PropertyTerms } from "./ship-by";

/** The kind of destination a kind of stay is, or null when she has to say ("other", unknown). */
export function destinationForStay(lodgingType: LodgingType | null | undefined): ShipmentDestinationType | null {
  switch (lodgingType) {
    case "hotel":
    case "room_block":
      return "hotel";
    case "rental":
      return "vacation_rental";
    case "family_home":
      return "relative_home";
    default:
      return null;
  }
}

export type SendAheadDefaults = {
  /** What kind of place it is, or null when the stay does not say: ask her. */
  destination: ShipmentDestinationType | null;
  /** The stay's check-in and check-out dates. */
  arrivalDate: LocalDate | null;
  departureDate: LocalDate | null;
  /** The property's name, for the label and the note. */
  propertyName: string | null;
  /** The stay's place: pass it to labelBlock() as `place`. */
  place: PlaceRef | null;
  /** For shipByPlan(): where it is going and where it starts. */
  destinationPostalCode: string | null;
  originPostalCode: string | null;
  /** What the property already said about packages (the stay's package policy), for shipByPlan(). */
  property: PropertyTerms | null;
  /** True when the stay is in another country than home; null when either country is unknown. */
  international: boolean | null;
};

/**
 * The answers the app already has for a Send ahead to this stay.
 *
 *   const known = sendAheadDefaultsFromStay(stayBooking.details, user.home);
 *   if (known.destination && known.arrivalDate) {
 *     shipByPlan({ ...known, destination: known.destination, arrivalDate: known.arrivalDate,
 *                  international: known.international ?? false, service: DEFAULT_SERVICE, today });
 *   }
 *
 * Never guesses: anything the stay does not record comes back null.
 */
export function sendAheadDefaultsFromStay(
  stay: Pick<LodgingDetails, "lodgingType" | "propertyName" | "place" | "checkInDate" | "checkOutDate" | "packagePolicy">,
  home?: Pick<PlaceRef, "countryCode" | "postalCode"> | null,
): SendAheadDefaults {
  const place = stay.place ?? null;
  const policy = stay.packagePolicy;
  const property: PropertyTerms | null = policy
    ? {
        ...(policy.accepts !== undefined ? { accepts: policy.accepts, confirmed: true } : {}),
        ...(policy.holdDays !== undefined ? { holdDays: policy.holdDays } : {}),
        ...(policy.feePerBox !== undefined ? { feePerBox: policy.feePerBox } : {}),
      }
    : null;
  const homeCountry = home?.countryCode ?? null;
  const stayCountry = place?.countryCode ?? null;
  return {
    destination: destinationForStay(stay.lodgingType),
    arrivalDate: stay.checkInDate ?? null,
    departureDate: stay.checkOutDate ?? null,
    propertyName: stay.propertyName ?? place?.name ?? null,
    place,
    destinationPostalCode: place?.postalCode ?? null,
    originPostalCode: home?.postalCode ?? null,
    property: property && Object.keys(property).length > 0 ? property : null,
    international: homeCountry && stayCountry ? homeCountry !== stayCountry : null,
  };
}
