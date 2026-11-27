import { PLACE_QUERY_MIN, placesSource, searchPlaces } from "@/lib/places";
import { placeDetail, placeLabel } from "@/lib/places/labels";
import { readTypeaheadRequest, typeaheadJson } from "@/lib/places/typeahead";

// GET /api/places?q=orlando
// Typeahead for "where": cities and towns (and an airport, when q is its code), each as a
// PlaceRef ready to send back in a form field.
//
//   200 { ok: true, results: [{ place, label, detail }], stale, source }
//   200 { ok: true, results: [], unavailable: true, … }   the place service could not be asked:
//                                                          say so, and offer "use it as typed"
//   400 query too long · 401 not signed in · 429 too many searches
export async function GET(request: Request) {
  const checked = await readTypeaheadRequest(request, "typeahead-places");
  if (!checked.ok) return checked.response;
  if (checked.query.length < PLACE_QUERY_MIN) {
    return typeaheadJson({ ok: true, results: [], stale: false, unavailable: false, source: placesSource });
  }

  const found = await searchPlaces(checked.query);
  return typeaheadJson({
    ok: true,
    results: found.places.map((place) => ({ place, label: placeLabel(place), detail: placeDetail(place) })),
    stale: found.ok ? found.stale : true,
    // Not the same as "nothing by that name": the screen must not say there is no such place.
    unavailable: !found.ok,
    source: placesSource,
  });
}
