import "server-only";

// Places and airports. Import from "@/lib/places" on the server.
//
//   searchPlaces(query)             cities and towns from the free place-search service (cached)
//   searchAirports(query, limit?)   the bundled airport table, by code, city or name
//   airportByIata(code)             one airport, or undefined
//   nearestAirports(lat, lon, n)    the closest airports with scheduled service
//   airportPlace(airport)           an airport as a PlaceRef
//   placeLabel(place) …             how a place is written (also in "@/lib/places/labels",
//                                   which a Client Component may import)
//
// The airport table is 886 kB and must stay on the server. A browser reaches both searches
// through GET /api/places?q= and GET /api/airports?q=.

export {
  airportByIata,
  airportPlace,
  airportsSource,
  distanceKm,
  hasScheduledService,
  nearestAirports,
  searchAirports,
  type Airport,
  type NearbyAirport,
  type NearestAirportsOptions,
} from "./airports";
export {
  PLACE_QUERY_MAX,
  PLACE_QUERY_MIN,
  normalizePlaceQuery,
  placesSource,
  searchPlaces,
  type PlaceSearchResult,
} from "./search";
export { countryName, placeDetail, placeLabel, placeShortLabel } from "./labels";
