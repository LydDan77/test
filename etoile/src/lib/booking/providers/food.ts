// Food: DoorDash, Uber Eats, Grubhub, Instacart, ezCater.
// Formats exactly as in research/booking-links.md section 6. All are OBSERVED patterns.
//
// No food link can carry a delivery address or a delivery time: both are always on the "you'll
// need to enter" list. A link can only carry what to search for (a cuisine, a restaurant, a
// store); without that the builder has nothing to prefill and the home page is used.

import type { UnfilledField } from "@/lib/domain";
import type { FoodQuery } from "../types";
import { addressText, countOf, dateText, dateTimeText, timeSpanText } from "../wording";
import {
  CannotPrefill,
  compact,
  coordinate,
  encodedQuery,
  hasCoordinates,
  need,
  timeOrNone,
  unfilledField,
  type BuiltLink,
} from "./shared";

/** What every food provider leaves to enter: where, when, how many, and anything to tell the kitchen. */
export function foodUnfilled(q: FoodQuery): UnfilledField[] {
  const start = timeOrNone(q.windowStart);
  const end = timeOrNone(q.windowEnd);
  const when = !q.date
    ? null
    : start && end
      ? `${dateText(q.date)}, ${timeSpanText(start, end)}`
      : start
        ? dateTimeText(q.date, start)
        : dateText(q.date);
  return compact([
    q.deliverToPlace ? unfilledField("Deliver to", addressText(q.deliverToPlace)) : null,
    unfilledField("Deliver at", when),
    q.headcount > 0 ? unfilledField("How many", countOf(q.headcount, "person", "people")) : null,
    unfilledField("Dietary needs", q.dietarySummary),
    unfilledField("Delivery note", q.deliveryNote),
  ]);
}

function searchText(q: FoodQuery): string {
  return need(q.searchText?.trim(), "what to search for");
}

/** DoorDash. OBSERVED:  https://www.doordash.com/search/store/{query}/ */
export function doordashLink(q: FoodQuery): BuiltLink {
  return {
    url: `https://www.doordash.com/search/store/${encodeURIComponent(searchText(q))}/`,
    grade: "observed",
    unfilled: foodUnfilled(q),
  };
}

/** Uber Eats. OBSERVED:  https://www.ubereats.com/search?q={query} */
export function uberEatsLink(q: FoodQuery): BuiltLink {
  return {
    url: `https://www.ubereats.com/search?${encodedQuery([["q", searchText(q)]])}`,
    grade: "observed",
    unfilled: foodUnfilled(q),
  };
}

/**
 * Grubhub. OBSERVED:  https://www.grubhub.com/search?queryText={query}
 * and, when the delivery place has coordinates, &orderMethod=delivery&locationMode=DELIVERY&latitude=…&longitude=…
 * (the only food provider where a location in the link has been seen).
 */
export function grubhubLink(q: FoodQuery): BuiltLink {
  const place = q.deliverToPlace;
  const near: Array<[string, string | number | null | undefined]> = hasCoordinates(place)
    ? [
        ["orderMethod", "delivery"],
        ["locationMode", "DELIVERY"],
        ["latitude", coordinate(place.lat)],
        ["longitude", coordinate(place.lon)],
      ]
    : [];
  return {
    url: `https://www.grubhub.com/search?${encodedQuery([["queryText", searchText(q)], ...near])}`,
    grade: "observed",
    unfilled: foodUnfilled(q),
  };
}

/** Instacart. OBSERVED:  https://www.instacart.com/store/s?k={query} */
export function instacartLink(q: FoodQuery): BuiltLink {
  return {
    url: `https://www.instacart.com/store/s?${encodedQuery([["k", searchText(q)]])}`,
    grade: "observed",
    unfilled: foodUnfilled(q),
  };
}

/**
 * ezCater. No link that prefills a search has been found, so this always declines and the
 * button opens ezCater's home page with the details to copy.
 */
export function ezcaterLink(q: FoodQuery): BuiltLink {
  void q;
  throw new CannotPrefill("a way to prefill ezCater (it has no search link)");
}
