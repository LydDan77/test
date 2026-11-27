import { airportPlace, airportsSource, searchAirports } from "@/lib/places";
import { countryName, placeLabel } from "@/lib/places/labels";
import { readTypeaheadRequest, typeaheadJson } from "@/lib/places/typeahead";

// GET /api/airports?q=msp        (also a city, "new york", or part of a name, "heathrow")
// Typeahead for airports, from the bundled table. Each result carries the airport's code and
// zone, and `place`: the same airport as a PlaceRef, ready to send back in a form field.
//
//   200 { ok: true, results: [{ iata, name, city, country, countryName, tz, place, label }], source }
//   400 query too long · 401 not signed in · 429 too many searches
export async function GET(request: Request) {
  const checked = await readTypeaheadRequest(request, "typeahead-airports");
  if (!checked.ok) return checked.response;

  const results = searchAirports(checked.query, 8).map((airport) => {
    const place = airportPlace(airport);
    return {
      iata: airport.iata,
      name: airport.name,
      city: airport.city,
      country: airport.country,
      countryName: countryName(airport.country),
      tz: airport.timeZone,
      place,
      label: placeLabel(place),
    };
  });
  return typeaheadJson({ ok: true, results, source: airportsSource });
}
