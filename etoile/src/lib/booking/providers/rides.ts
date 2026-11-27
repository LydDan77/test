// Rides and directions: Uber, Lyft, Google Maps, Apple Maps.
// Formats exactly as in research/booking-links.md section 5. All four are documented by the
// provider (Uber and Lyft also in their published SDK source).
//
// No ride link can carry a pick-up time. Uber Reserve and Lyft scheduled rides are set inside
// the app, up to 90 days ahead, so the time is always on the "you'll need to enter" list.

import type { PlaceRef } from "@/lib/domain";
import type { RideQuery, TravelMode } from "../types";
import { addressText, dateTimeText, dateText, placeLabel } from "../wording";
import {
  CannotPrefill,
  compact,
  coordinate,
  encodedQuery,
  hasCoordinates,
  mapsQueryText,
  need,
  timeOrNone,
  unfilledField,
  type BuiltLink,
  type LinkEnv,
} from "./shared";

function pickupTimeField(q: RideQuery) {
  const time = timeOrNone(q.pickupTime);
  if (q.pickupDate && time) return unfilledField("Pick-up time", dateTimeText(q.pickupDate, time));
  if (q.pickupDate) return unfilledField("Pick-up day", dateText(q.pickupDate));
  return null;
}

function ridersField(q: RideQuery) {
  // A standard car seats four riders; say so when the group is bigger.
  return q.passengers > 4 ? unfilledField("Riders (choose a larger car)", q.passengers) : null;
}

function childSeatField(q: RideQuery) {
  return q.childSeatNeeded ? unfilledField("Child seat", "Needed. Choose a car seat option or bring your own.") : null;
}

/**
 * Uber. DOCUMENTED universal link (parameter names from Uber's own SDK):
 *   https://m.uber.com/ul/?action=setPickup&client_id=…&pickup[latitude]=…&pickup[longitude]=…&pickup[nickname]=…
 *     &pickup[formatted_address]=…&dropoff[latitude]=…&dropoff[longitude]=…&dropoff[nickname]=…&dropoff[formatted_address]=…
 * The drop-off needs coordinates and a name or the pin does not show. A pick-up without
 * coordinates becomes "my location" and its address goes on the list to enter. Opens the Uber
 * app when it is installed.
 */
export function uberLink(q: RideQuery, env: LinkEnv = {}): BuiltLink {
  const to = need(q.toPlace, "where the ride is going");
  if (!hasCoordinates(to)) throw new CannotPrefill("the exact location of where the ride is going");
  const from = q.fromPlace;
  const pickup: Array<[string, string | number | null | undefined]> = hasCoordinates(from)
    ? [
        ["pickup[latitude]", coordinate(from.lat)],
        ["pickup[longitude]", coordinate(from.lon)],
        ["pickup[nickname]", from.name],
        ["pickup[formatted_address]", addressText(from)],
      ]
    : [["pickup", "my_location"]];
  const url = `https://m.uber.com/ul/?${encodedQuery([
    ["action", "setPickup"],
    ["client_id", env.partnerIds?.uberClientId],
    ...pickup,
    ["dropoff[latitude]", coordinate(to.lat)],
    ["dropoff[longitude]", coordinate(to.lon)],
    ["dropoff[nickname]", to.name],
    ["dropoff[formatted_address]", addressText(to)],
  ])}`;
  return {
    url,
    grade: "documented",
    unfilled: compact([
      pickupTimeField(q),
      from && !hasCoordinates(from) ? unfilledField("Pick up at", addressText(from)) : null,
      ridersField(q),
      childSeatField(q),
    ]),
  };
}

/**
 * Lyft. DOCUMENTED universal link:
 *   https://lyft.com/ride?id=lyft&pickup[latitude]=…&pickup[longitude]=…&destination[latitude]=…&destination[longitude]=…&partner=…
 * Lyft requires a pick-up whenever a destination is given, and takes coordinates only, so both
 * ends need them.
 */
export function lyftLink(q: RideQuery, env: LinkEnv = {}): BuiltLink {
  const from = need(q.fromPlace, "where the ride starts");
  const to = need(q.toPlace, "where the ride is going");
  if (!hasCoordinates(from) || !hasCoordinates(to)) throw new CannotPrefill("the exact location of both ends of the ride");
  const url = `https://lyft.com/ride?${encodedQuery([
    ["id", "lyft"],
    ["pickup[latitude]", coordinate(from.lat)],
    ["pickup[longitude]", coordinate(from.lon)],
    ["destination[latitude]", coordinate(to.lat)],
    ["destination[longitude]", coordinate(to.lon)],
    ["partner", env.partnerIds?.lyftPartnerId],
  ])}`;
  return { url, grade: "documented", unfilled: compact([pickupTimeField(q), ridersField(q), childSeatField(q)]) };
}

const GOOGLE_MODE: Readonly<Record<TravelMode, string>> = {
  driving: "driving",
  walking: "walking",
  transit: "transit",
  cycling: "bicycling",
};

/**
 * Google Maps directions. DOCUMENTED ("Maps URLs", no key):
 *   https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=…
 * Leave `from` out to start from wherever the person is. No leave-at or arrive-by time exists.
 */
export function googleMapsDirectionsUrl(from: PlaceRef | string | null | undefined, to: PlaceRef | string, mode: TravelMode = "driving"): string {
  const destination = need(mapsQueryText(to), "where you are going");
  // Google's own examples write spaces as "+", which is what URLSearchParams does.
  const params = new URLSearchParams();
  params.set("api", "1");
  const origin = from ? mapsQueryText(from) : "";
  if (origin) params.set("origin", origin);
  params.set("destination", destination);
  params.set("travelmode", GOOGLE_MODE[mode]);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Apple Maps directions. DOCUMENTED (Apple, "Adopting unified Maps URLs"):
 *   https://maps.apple.com/directions?source=…&destination=…&mode=…
 * Leave `from` out to start from wherever the person is. Offer it on Apple devices only.
 */
export function appleMapsDirectionsUrl(from: PlaceRef | string | null | undefined, to: PlaceRef | string, mode: TravelMode = "driving"): string {
  const destination = need(mapsQueryText(to), "where you are going");
  return `https://maps.apple.com/directions?${encodedQuery([
    ["source", from ? mapsQueryText(from) : null],
    ["destination", destination],
    ["mode", mode],
  ])}`;
}

/** Directions for a ride that someone is driving themselves, or to check the route. */
export function googleMapsRideLink(q: RideQuery): BuiltLink {
  const to = need(q.toPlace, "where the ride is going");
  return { url: googleMapsDirectionsUrl(q.fromPlace, to, "driving"), grade: "documented", unfilled: compact([leaveAtField(q)]) };
}

export function appleMapsRideLink(q: RideQuery): BuiltLink {
  const to = need(q.toPlace, "where the ride is going");
  return { url: appleMapsDirectionsUrl(q.fromPlace, to, "driving"), grade: "documented", unfilled: compact([leaveAtField(q)]) };
}

function leaveAtField(q: RideQuery) {
  const time = timeOrNone(q.pickupTime);
  return q.pickupDate && time ? unfilledField("Leave at", dateTimeText(q.pickupDate, time)) : null;
}

/** For the hand-off sheet's fallback list: both ends as addresses. */
export function rideEndsText(q: RideQuery): string {
  const ends = [q.fromPlace, q.toPlace].filter((place): place is PlaceRef => Boolean(place)).map(placeLabel);
  return ends.join(" to ");
}
