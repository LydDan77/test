// From a search to the booking row it becomes when the person says "plan it".

import type { BookingDetailsOf, ZonedInstant } from "@/lib/domain";
import { zonedToUtc } from "@/lib/time";
import { orderOpensOn } from "./propose";
import { FOOD_ORDER_WINDOW_DAYS } from "./providers";
import type { SearchKind, SearchQuery, SearchQueryOf } from "./types";

function instantAt(date: string | undefined, time: string | undefined, tz: string | undefined): ZonedInstant | undefined {
  if (!date || !time || !tz) return undefined;
  try {
    return { at: zonedToUtc(`${date}T${time}`, tz).toISOString(), tz };
  } catch {
    return undefined;
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The `details` to save on a booking for a search, so a "planned" booking remembers exactly
 * what was proposed and its links can be rebuilt later. Local dates and times become instants
 * in the zone of the place they belong to.
 *
 * The result is unvalidated input: pass it through `parseBookingDetails(kind, input)` before
 * writing, as with anything else that goes into bookings.details.
 */
export function bookingDetailsFromQuery<K extends SearchKind>(query: SearchQueryOf<K>): Partial<BookingDetailsOf<K>> & { kind: K };
export function bookingDetailsFromQuery(query: SearchQuery): object {
  switch (query.kind) {
    case "flight":
      return withoutUndefined({
        kind: "flight" as const,
        tripType: query.tripType,
        cabin: query.cabin,
        search: withoutUndefined({
          originIata: query.originIata,
          destinationIata: query.destinationIata,
          departDate: query.departDate,
          returnDate: query.returnDate,
          adults: query.adults,
          children: query.children,
          infants: query.infants,
          childAges: query.childAges,
          legs: query.legs,
        }),
      });
    case "lodging":
      return withoutUndefined({
        kind: "lodging" as const,
        lodgingType: query.lodgingType,
        place: query.place,
        checkInDate: query.checkInDate,
        checkOutDate: query.checkOutDate,
      });
    case "car": {
      const returnPlace = query.returnPlace ?? query.pickupPlace;
      return withoutUndefined({
        kind: "car" as const,
        pickupPlace: query.pickupPlace,
        pickupAt: instantAt(query.pickupDate, query.pickupTime, query.pickupPlace?.tz),
        returnPlace,
        returnAt: instantAt(query.returnDate, query.returnTime, returnPlace?.tz),
        seats: query.seats > 0 ? Math.min(query.seats, 15) : undefined,
        childSeats: query.childSeats > 0 ? Math.min(query.childSeats, 6) : undefined,
      });
    }
    case "ride":
      return withoutUndefined({
        kind: "ride" as const,
        rideType: query.rideType,
        fromPlace: query.fromPlace,
        toPlace: query.toPlace,
        pickupAt: instantAt(query.pickupDate, query.pickupTime, query.fromPlace?.tz ?? query.toPlace?.tz),
        passengerIds: query.passengerIds,
        bags: query.bags,
        childSeatNeeded: query.childSeatNeeded || undefined,
        arrivalIds: query.arrivalIds,
      });
    case "meal": {
      const tz = query.deliverToPlace?.tz;
      // The earliest any provider for this kind of order opens: the day to be reminded.
      const provider = query.mealType === "groceries" ? "instacart" : query.mealType === "catering" ? "ezcater" : "uber_eats";
      const opens = query.date && FOOD_ORDER_WINDOW_DAYS[provider] !== null ? orderOpensOn(provider, query.date) : null;
      return withoutUndefined({
        kind: "meal" as const,
        mealType: query.mealType,
        deliverToPlace: query.deliverToPlace,
        windowStart: instantAt(query.date, query.windowStart, tz),
        windowEnd: instantAt(query.date, query.windowEnd, tz),
        headcount: query.headcount,
        dietarySummary: query.dietarySummary,
        deliveryNote: query.deliveryNote,
        orderOpensOn: opens ?? undefined,
      });
    }
  }
}
