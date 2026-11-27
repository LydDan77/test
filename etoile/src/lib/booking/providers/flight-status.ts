// Flight trackers: FlightAware, Flightradar24 and a Google search.
// Formats exactly as in research/booking-links.md section 7. All OBSERVED; none takes a date
// reliably, so each opens the flight's live page.

import { airlineIcao } from "@/lib/airlines";
import { formatDate } from "@/lib/time";

/** FlightAware wants the ICAO airline code ("UAL123"). The IATA form is the fallback when the code is not in the table. */
export function flightAwareUrl(airlineIata: string, flightNumber: string): string {
  const ident = `${airlineIcao(airlineIata) ?? airlineIata.toUpperCase()}${flightNumber.toUpperCase()}`;
  return `https://www.flightaware.com/live/flight/${encodeURIComponent(ident)}`;
}

/** Flightradar24 wants the everyday flight number in lower case ("ua123"). */
export function flightradar24Url(airlineIata: string, flightNumber: string): string {
  return `https://www.flightradar24.com/data/flights/${encodeURIComponent(`${airlineIata}${flightNumber}`.toLowerCase())}`;
}

/** "UA123 flight status Dec 18": Google shows a status card, and the date words help it pick the day. */
export function googleFlightStatusUrl(airlineIata: string, flightNumber: string, localDate?: string): string {
  const words = [`${airlineIata.toUpperCase()}${flightNumber.toUpperCase()}`, "flight", "status"];
  if (localDate) words.push(...formatDate(localDate).split(" "));
  return `https://www.google.com/search?q=${words.map(encodeURIComponent).join("+")}`;
}
