// Every link builder against the example URLs in research/booking-links.md. A refactor that
// changes a link format fails here. The examples are quoted exactly; where a test needs a
// different input than the example had (a cabin, a trailing parameter) the comment says so.

import { describe, expect, it } from "vitest";
import type { PlaceRef } from "@/lib/domain";
import { PROVIDER_IDS, PROVIDERS, providerHomeUrl, providerInfo, providerName } from "./providers";
import { expediaCarsLink, kayakCarsLink, turoLink } from "./providers/car";
import { flightAwareUrl, flightradar24Url, googleFlightStatusUrl } from "./providers/flight-status";
import { expediaFlightsLink, googleFlightsLink, kayakFlightsLink, skyscannerFlightsLink } from "./providers/flights";
import { doordashLink, ezcaterLink, foodUnfilled, grubhubLink, instacartLink, uberEatsLink } from "./providers/food";
import { appleMapsDirectionsUrl, googleMapsDirectionsUrl, lyftLink, uberLink } from "./providers/rides";
import { adultsPerRoom, CannotPrefill, mapsQueryText } from "./providers/shared";
import { airbnbLink, bookingComLink, expediaStayLink, hotelsComLink, vrboLink } from "./providers/stay";
import type { CarQuery, FlightQuery, FoodQuery, RideQuery, StayQuery } from "./types";

const flight = (overrides: Partial<FlightQuery> = {}): FlightQuery => ({
  kind: "flight",
  tripType: "round_trip",
  cabin: "economy",
  originIata: "JFK",
  destinationIata: "LHR",
  departDate: "2026-12-18",
  returnDate: "2026-12-27",
  adults: 2,
  children: 0,
  infants: 0,
  ...overrides,
});

const LISBON: PlaceRef = { kind: "city", name: "Lisbon", countryCode: "PT", tz: "Europe/Lisbon" };

const stay = (overrides: Partial<StayQuery> = {}): StayQuery => ({
  kind: "lodging",
  lodgingType: "hotel",
  place: LISBON,
  checkInDate: "2026-12-18",
  checkOutDate: "2026-12-22",
  adults: 2,
  children: 0,
  infants: 0,
  childAges: [],
  rooms: 1,
  ...overrides,
});

const LAS: PlaceRef = { kind: "airport", name: "Harry Reid International Airport", iata: "LAS", tz: "America/Los_Angeles" };

const car = (overrides: Partial<CarQuery> = {}): CarQuery => ({
  kind: "car",
  pickupPlace: LAS,
  pickupDate: "2026-12-18",
  returnDate: "2026-12-22",
  seats: 2,
  childSeats: 0,
  ...overrides,
});

const HOTEL: PlaceRef = { kind: "lodging", name: "Hotel", addressLines: ["1535 Broadway"], locality: "New York", region: "NY", lat: 40.758, lon: -73.9855, tz: "America/New_York" };
const JFK_T4: PlaceRef = { kind: "airport", name: "JFK T4", addressLines: ["JFK Airport"], locality: "Queens", region: "NY", lat: 40.6413, lon: -73.7781, tz: "America/New_York" };

const ride = (overrides: Partial<RideQuery> = {}): RideQuery => ({
  kind: "ride",
  rideType: "rideshare",
  direction: "to_airport",
  fromPlace: HOTEL,
  toPlace: JFK_T4,
  pickupDate: "2026-12-18",
  pickupTime: "15:30",
  passengers: 2,
  passengerIds: [],
  childSeatNeeded: false,
  arrivalIds: [],
  ...overrides,
});

const food = (overrides: Partial<FoodQuery> = {}): FoodQuery => ({
  kind: "meal",
  mealType: "restaurant_delivery",
  headcount: 9,
  ...overrides,
});

describe("Google Flights (observed)", () => {
  it("matches the report's round-trip example", () => {
    const link = googleFlightsLink(flight({ adults: 1 }));
    expect(link.url).toBe("https://www.google.com/travel/flights?q=Flights%20to%20LHR%20from%20JFK%20on%202026-12-18%20through%202026-12-27&hl=en&curr=USD");
    expect(link.grade).toBe("observed");
    expect(link.unfilled).toEqual([]);
  });

  it("writes the one-way sentence seen in the wild", () => {
    const link = googleFlightsLink(flight({ tripType: "one_way", originIata: "BOM", destinationIata: "DXB", departDate: "2026-12-20", returnDate: undefined, adults: 1 }));
    // Observed: https://www.google.com/travel/flights?q=Flights+from+BOM+to+DXB+on+2026-12-20+one+way
    expect(new URL(link.url).searchParams.get("q")).toBe("Flights from BOM to DXB on 2026-12-20 one way");
    expect(new URL("https://www.google.com/travel/flights?q=Flights+from+BOM+to+DXB+on+2026-12-20+one+way").searchParams.get("q")).toBe("Flights from BOM to DXB on 2026-12-20 one way");
  });

  it("carries the plan's currency", () => {
    // Observed: …?q=Flights%20to%20CDG%20from%20TYO%20on%202027-03-01%20through%202027-03-08&hl=ja&curr=JPY
    const link = googleFlightsLink(flight({ originIata: "TYO", destinationIata: "CDG", departDate: "2027-03-01", returnDate: "2027-03-08", adults: 1 }), { currency: "JPY" });
    expect(link.url).toBe("https://www.google.com/travel/flights?q=Flights%20to%20CDG%20from%20TYO%20on%202027-03-01%20through%202027-03-08&hl=en&curr=JPY");
  });

  it("lists who is flying and the cabin, which the sentence cannot carry", () => {
    const link = googleFlightsLink(flight({ adults: 2, children: 2, childAges: [9, 5], cabin: "business" }));
    expect(link.unfilled).toEqual([
      { label: "Travelers", value: "2 adults, 2 children (ages 9 and 5)" },
      { label: "Cabin", value: "Business" },
    ]);
  });

  it("declines several stops, a missing airport and a missing date", () => {
    expect(() => googleFlightsLink(flight({ tripType: "multi_city", legs: [{ originIata: "LHR", destinationIata: "CDG", date: "2026-12-22" }] }))).toThrow(CannotPrefill);
    expect(() => googleFlightsLink(flight({ originIata: undefined }))).toThrow(CannotPrefill);
    expect(() => googleFlightsLink(flight({ departDate: undefined }))).toThrow(CannotPrefill);
    expect(() => googleFlightsLink(flight({ departDate: "2026-02-30" }))).toThrow(CannotPrefill);
  });
});

describe("Kayak flights (observed)", () => {
  it("matches the report's one-way example", () => {
    expect(kayakFlightsLink(flight({ tripType: "one_way", returnDate: undefined, adults: 1 })).url).toBe("https://www.kayak.com/flights/JFK-LHR/2026-12-18?sort=bestflight_a");
  });

  it("matches the report's round-trip example", () => {
    expect(kayakFlightsLink(flight()).url).toBe("https://www.kayak.com/flights/JFK-LHR/2026-12-18/2026-12-27/2adults?sort=bestflight_a");
  });

  it("matches the path of the report's business example", () => {
    // Example (verbatim, a third party's): https://www.kayak.com/flights/LAX-NYC/2026-09-15/2026-09-22/business/2adults?sort=price_a
    // Ours sorts by best flight; the path is the part that carries the search.
    const link = kayakFlightsLink(flight({ originIata: "LAX", destinationIata: "NYC", departDate: "2026-09-15", returnDate: "2026-09-22", cabin: "business" }));
    expect(link.url.split("?")[0]).toBe("https://www.kayak.com/flights/LAX-NYC/2026-09-15/2026-09-22/business/2adults");
  });

  it("matches the report's multi-city example", () => {
    const link = kayakFlightsLink(
      flight({
        tripType: "multi_city",
        returnDate: undefined,
        adults: 1,
        legs: [
          { originIata: "LHR", destinationIata: "CDG", date: "2026-12-22" },
          { originIata: "CDG", destinationIata: "JFK", date: "2026-12-27" },
        ],
      }),
    );
    expect(link.url).toBe("https://www.kayak.com/flights/JFK-LHR/2026-12-18/LHR-CDG/2026-12-22/CDG-JFK/2026-12-27");
  });

  it("does not send children or unconfirmed cabin words, and lists them instead", () => {
    const link = kayakFlightsLink(flight({ children: 2, childAges: [9, 5], cabin: "premium_economy" }));
    expect(link.url).toBe("https://www.kayak.com/flights/JFK-LHR/2026-12-18/2026-12-27/2adults?sort=bestflight_a");
    expect(link.unfilled).toEqual([
      { label: "Children", value: "2 children (ages 9 and 5)" },
      { label: "Cabin", value: "Premium economy" },
    ]);
  });
});

describe("Skyscanner", () => {
  it("matches the report's consumer example when there is no partner id (observed)", () => {
    const link = skyscannerFlightsLink(flight());
    expect(link.url).toBe("https://www.skyscanner.com/transport/flights/jfk/lhr/261218/261227/?adultsv2=2&cabinclass=economy&childrenv2=&rtn=1");
    expect(link.grade).toBe("observed");
  });

  it("uses the documented referral link when a partner id is set, starting as the docs example does", () => {
    const link = skyscannerFlightsLink(flight({ tripType: "one_way", originIata: "CDG", destinationIata: "EDI", departDate: "2024-12-07", returnDate: undefined, adults: 1 }), {
      partnerIds: { skyscannerMediaPartnerId: "12345" },
    });
    // Docs example: https://skyscanner.net/g/referrals/v1/flights/day-view/?origin=cdg&destination=edi&outboundDate=2024-12-07
    expect(link.url).toBe("https://skyscanner.net/g/referrals/v1/flights/day-view/?origin=cdg&destination=edi&outboundDate=2024-12-07&adultsv2=1&cabinclass=economy&mediaPartnerId=12345");
    expect(link.grade).toBe("documented");
  });

  it("sends children by age, separated by a bar, and one-way as rtn=0 with one date", () => {
    const link = skyscannerFlightsLink(flight({ tripType: "one_way", returnDate: undefined, children: 2, childAges: [9, 4], cabin: "premium_economy" }));
    expect(link.url).toBe("https://www.skyscanner.com/transport/flights/jfk/lhr/261218/?adultsv2=2&cabinclass=premiumeconomy&childrenv2=9%7C4&rtn=0");
    expect(link.unfilled).toEqual([]);
  });

  it("lists children whose ages are not known, and infants", () => {
    const link = skyscannerFlightsLink(flight({ children: 2, infants: 1 }));
    expect(link.url).toContain("childrenv2=&");
    expect(link.unfilled).toEqual([
      { label: "Children", value: "2 children" },
      { label: "Infants", value: "1 infant" },
    ]);
  });
});

describe("Expedia flights", () => {
  it("matches the documented round-trip example", () => {
    const link = expediaFlightsLink(flight({ originIata: "SEA", destinationIata: "SFO", departDate: "2022-12-27", returnDate: "2023-01-01" }));
    expect(link.url).toBe("https://www.expedia.com/go/flight/search/Roundtrip/2022-12-27/2023-01-01?load=1&FromAirport=SEA&ToAirport=SFO&FromTime=362&ToTime=362&NumAdult=2");
    expect(link.grade).toBe("documented");
  });

  it("matches the documented one-way example with children's ages", () => {
    const link = expediaFlightsLink(flight({ tripType: "one_way", originIata: "SEA", destinationIata: "SFO", departDate: "2022-12-27", returnDate: "2023-12-27", children: 2, childAges: [3, 8] }));
    // The docs example ends with &InfantInSeat=1, which we do not send (infants are left to enter).
    expect(`${link.url}&InfantInSeat=1`).toBe(
      "https://www.expedia.com/go/flight/search/oneway/2022-12-27/2023-12-27?load=1&FromAirport=SEA&ToAirport=SFO&FromTime=362&NumAdult=2&NumChild=2&Child1Age=3&Child2Age=8&InfantInSeat=1",
    );
  });

  it("uses the observed Flights-Search page when a cabin must be carried, as the report's example", () => {
    const link = expediaFlightsLink(flight({ cabin: "business" }));
    // Example: …options=cabinclass:economy&mode=search (with economy we use the documented link instead).
    const example =
      "https://www.expedia.com/Flights-Search?trip=roundtrip&leg1=from:JFK,to:LHR,departure:12/18/2026TANYT&leg2=from:LHR,to:JFK,departure:12/27/2026TANYT&passengers=adults:2,children:0,seniors:0,infantinlap:Y&options=cabinclass:economy&mode=search";
    expect(link.url).toBe(example.replace("cabinclass:economy", "cabinclass:business"));
    expect(link.grade).toBe("observed");
  });

  it("leaves children without ages, and infants, to be entered", () => {
    const link = expediaFlightsLink(flight({ children: 2, infants: 1 }));
    expect(link.url).not.toContain("NumChild");
    expect(link.unfilled).toEqual([
      { label: "Children", value: "2 children" },
      { label: "Infants", value: "1 infant" },
    ]);
  });
});

describe("Booking.com (observed)", () => {
  it("matches the report's example", () => {
    expect(bookingComLink(stay({ children: 2, childAges: [5, 9] })).url).toBe(
      "https://www.booking.com/searchresults.html?ss=Lisbon%2C%20Portugal&checkin=2026-12-18&checkout=2026-12-22&group_adults=2&no_rooms=1&group_children=2&age=5&age=9",
    );
  });

  it("sends no children when an age is missing, and lists them", () => {
    const link = bookingComLink(stay({ children: 2 }));
    expect(link.url).toBe("https://www.booking.com/searchresults.html?ss=Lisbon%2C%20Portugal&checkin=2026-12-18&checkout=2026-12-22&group_adults=2&no_rooms=1");
    expect(link.unfilled).toEqual([{ label: "Children (they ask each age)", value: "2 children" }]);
  });

  it("adds the affiliate id when one is set", () => {
    expect(bookingComLink(stay(), { partnerIds: { bookingAid: "304142" } }).url.endsWith("&aid=304142")).toBe(true);
  });

  it("declines without a place or dates", () => {
    expect(() => bookingComLink(stay({ place: undefined }))).toThrow(CannotPrefill);
    expect(() => bookingComLink(stay({ checkOutDate: undefined }))).toThrow(CannotPrefill);
  });
});

describe("Airbnb (observed)", () => {
  it("matches the report's example", () => {
    expect(airbnbLink(stay({ children: 2, childAges: [5, 9] })).url).toBe("https://www.airbnb.com/s/Lisbon--Portugal/homes?checkin=2026-12-18&checkout=2026-12-22&adults=2&children=2&infants=0&pets=0");
  });

  it("counts teenagers as adults and under-twos as infants, the way Airbnb does", () => {
    const link = airbnbLink(stay({ adults: 2, children: 2, infants: 1, childAges: [14, 6, 1] }));
    expect(new URL(link.url).search).toBe("?checkin=2026-12-18&checkout=2026-12-22&adults=3&children=1&infants=1&pets=0");
  });

  it("writes a place of several words as a slug", () => {
    const link = airbnbLink(stay({ place: { kind: "city", name: "Lake Buena Vista", region: "FL", countryCode: "US", tz: "America/New_York" } }));
    expect(link.url.startsWith("https://www.airbnb.com/s/Lake-Buena-Vista--FL/homes?")).toBe(true);
  });
});

describe("Vrbo (observed)", () => {
  it("matches the report's example", () => {
    const link = vrboLink(stay({ place: { kind: "city", name: "Orlando, Florida, United States of America", tz: "America/New_York" }, adults: 4 }));
    expect(link.url).toBe("https://www.vrbo.com/search?destination=Orlando%2C%20Florida%2C%20United%20States%20of%20America&startDate=2026-12-18&endDate=2026-12-22&adults=4");
  });

  it("lists children, whose spelling in the link is not confirmed", () => {
    expect(vrboLink(stay({ children: 2, childAges: [9, 5] })).unfilled).toEqual([{ label: "Children", value: "2 children (ages 9 and 5)" }]);
  });
});

describe("Hotels.com (observed)", () => {
  it("matches the report's example", () => {
    expect(hotelsComLink(stay()).url).toBe("https://www.hotels.com/Hotel-Search?destination=Lisbon%2C%20Portugal&startDate=2026-12-18&endDate=2026-12-22&adults=2&rooms=1");
  });

  it("writes several rooms in the captured grammar: adults per room, and each child as room_age", () => {
    // Captured: adults=1%2C2&rooms=2&children=1_12%2C1_9 (room 1 one adult, room 2 two; two children in room 1).
    const link = hotelsComLink(stay({ adults: 3, rooms: 2, children: 2, childAges: [12, 9] }));
    expect(new URL(link.url).search.split("&").slice(3).join("&")).toBe("adults=2%2C1&rooms=2&children=1_12%2C2_9");
  });

  it("spreads adults over rooms as evenly as they go", () => {
    expect(adultsPerRoom(7, 3)).toEqual([3, 2, 2]);
    expect(adultsPerRoom(2, 1)).toEqual([2]);
    expect(adultsPerRoom(1, 3)).toEqual([1]);
    expect(adultsPerRoom(0, 0)).toEqual([0]);
  });
});

describe("Expedia hotels (documented)", () => {
  it("matches the documented deeplink", () => {
    // Docs: /go/hotel/search/Destination/{START}/{END}?CityName=…&NumRoom=1&NumAdult1=3&NumChild1=2&Rm1child1age=9&Rm1child2age=6
    const link = expediaStayLink(stay({ place: { kind: "city", name: "Orlando", tz: "America/New_York" }, adults: 3, children: 2, childAges: [9, 6] }));
    expect(link.url).toBe("https://www.expedia.com/go/hotel/search/Destination/2026-12-18/2026-12-22?CityName=Orlando&NumRoom=1&NumAdult1=3&NumChild1=2&Rm1child1age=9&Rm1child2age=6");
    expect(link.grade).toBe("documented");
  });
});

describe("Kayak cars (observed)", () => {
  it("matches the report's example", () => {
    expect(kayakCarsLink(car()).url).toBe("https://www.kayak.com/cars/LAS/2026-12-18/2026-12-22?sort=price_a");
  });

  it("lists the times and a different return place, which it cannot carry", () => {
    const link = kayakCarsLink(car({ pickupTime: "17:00", returnTime: "08:00", returnPlace: { kind: "airport", name: "LAX", iata: "LAX", tz: "America/Los_Angeles" }, seats: 9, childSeats: 2 }));
    expect(link.url).toBe("https://www.kayak.com/cars/LAS/2026-12-18/2026-12-22?sort=price_a");
    expect(link.unfilled).toEqual([
      { label: "Pick-up time", value: "5:00 PM" },
      { label: "Return time", value: "8:00 AM" },
      { label: "Return to", value: "LAX" },
      { label: "Seats needed", value: "9, so look for a minivan or a large SUV" },
      { label: "Child seats", value: "2" },
    ]);
  });
});

describe("Expedia cars", () => {
  it("matches the documented example for an airport pick-up on the hour", () => {
    const link = expediaCarsLink(car({ pickupPlace: { kind: "airport", name: "SEA", iata: "SEA", tz: "America/Los_Angeles" }, pickupDate: "2022-11-01", returnDate: "2022-11-05", pickupTime: "11:00", returnTime: "11:00" }), {
      partnerIds: { expediaMarketingCode: "your.marketing.code" },
    });
    expect(link.url).toBe("https://www.expedia.com/go/car/search/Airport/2022-11-01/2022-11-05?PickUpLoc=sea&DiffDropLoc=0&PickUpTime=11AM&DropTime=11AM&Class=NoPreference&mdpcid=your.marketing.code");
    expect(link.grade).toBe("documented");
  });

  it("matches the report's consumer example for a place that is not an airport code", () => {
    const link = expediaCarsLink(car({ pickupPlace: { kind: "city", name: "Las Vegas (LAS)", tz: "America/Los_Angeles" }, pickupTime: "10:00", returnTime: "10:00" }));
    expect(link.url).toBe("https://www.expedia.com/carsearch?locn=Las%20Vegas%20(LAS)&date1=12/18/2026&date2=12/22/2026&time1=1000AM&time2=1000AM");
    expect(link.grade).toBe("observed");
  });

  it("uses the consumer page for a half-hour time, which the documented link cannot write", () => {
    const link = expediaCarsLink(car({ pickupTime: "16:30", returnTime: "14:00" }));
    expect(link.url).toBe("https://www.expedia.com/carsearch?locn=Harry%20Reid%20International%20Airport%20(LAS)&date1=12/18/2026&date2=12/22/2026&time1=0430PM&time2=0200PM");
  });

  it("writes a different return airport on the documented link", () => {
    const link = expediaCarsLink(car({ pickupTime: "12:00", returnTime: "00:00", returnPlace: { kind: "airport", name: "LAX", iata: "LAX", tz: "America/Los_Angeles" } }));
    expect(link.url).toBe("https://www.expedia.com/go/car/search/Airport/2026-12-18/2026-12-22?PickUpLoc=las&DiffDropLoc=1&DropLoc=lax&PickUpTime=12PM&DropTime=12AM&Class=NoPreference");
  });

  it("writes single-digit months and days without padding on the consumer page", () => {
    const link = expediaCarsLink(car({ pickupPlace: { kind: "city", name: "Austin", tz: "America/Chicago" }, pickupDate: "2027-01-05", returnDate: "2027-01-09" }));
    expect(link.url).toBe("https://www.expedia.com/carsearch?locn=Austin&date1=1/5/2027&date2=1/9/2027");
  });
});

describe("Turo (observed)", () => {
  it("matches the captured example", () => {
    const link = turoLink(car({ pickupPlace: { kind: "airport", name: "Orlando International Airport", iata: "MCO", countryCode: "US", tz: "America/New_York" }, pickupDate: "2026-11-05", pickupTime: "22:00", returnDate: "2026-11-09", returnTime: "12:00" }));
    // Captured (with &makes=Tesla on the end): turo.com/us/en/search?country=US&location=Orlando%20International%20Airport&locationType=AIRPORT&startDate=11%2F05%2F2026&startTime=22%3A00&endDate=11%2F09%2F2026&endTime=12%3A00&makes=Tesla
    expect(`${link.url}&makes=Tesla`).toBe(
      "https://turo.com/us/en/search?country=US&location=Orlando%20International%20Airport&locationType=AIRPORT&startDate=11%2F05%2F2026&startTime=22%3A00&endDate=11%2F09%2F2026&endTime=12%3A00&makes=Tesla",
    );
  });

  it("declines a pick-up outside the US, since the link is for the US site", () => {
    expect(() => turoLink(car({ pickupPlace: { kind: "city", name: "Lisbon", countryCode: "PT", tz: "Europe/Lisbon" } }))).toThrow(CannotPrefill);
  });
});

describe("Uber (documented)", () => {
  it("matches the report's example from the rider's location", () => {
    const link = uberLink(ride({ fromPlace: undefined, toPlace: { kind: "airport", name: "JFK Terminal 4", addressLines: ["JFK Airport"], locality: "Queens", region: "NY", postalCode: "11430", lat: 40.6413, lon: -73.7781, tz: "America/New_York" } }));
    expect(link.url).toBe(
      "https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff%5Blatitude%5D=40.6413&dropoff%5Blongitude%5D=-73.7781&dropoff%5Bnickname%5D=JFK%20Terminal%204&dropoff%5Bformatted_address%5D=JFK%20Airport%2C%20Queens%2C%20NY%2011430",
    );
    expect(link.grade).toBe("documented");
  });

  it("matches the report's example with a fixed pick-up and a client id", () => {
    const link = uberLink(ride(), { partnerIds: { uberClientId: "YOUR_CLIENT_ID" } });
    const example =
      "https://m.uber.com/ul/?action=setPickup&client_id=YOUR_CLIENT_ID&pickup%5Blatitude%5D=40.7580&pickup%5Blongitude%5D=-73.9855&pickup%5Bnickname%5D=Hotel&pickup%5Bformatted_address%5D=1535%20Broadway%2C%20New%20York%2C%20NY&dropoff%5Blatitude%5D=40.6413&dropoff%5Blongitude%5D=-73.7781&dropoff%5Bnickname%5D=JFK%20T4&dropoff%5Bformatted_address%5D=JFK%20Airport%2C%20Queens%2C%20NY";
    // The example writes 40.7580; a number has no trailing zero.
    expect(link.url).toBe(example.replace("40.7580", "40.758"));
  });

  it("always lists the pick-up time, which no ride link can carry", () => {
    expect(uberLink(ride()).unfilled).toEqual([{ label: "Pick-up time", value: "Fri, Dec 18, 3:30 PM" }]);
  });

  it("falls back to my location, and lists the address, when the pick-up has no coordinates", () => {
    const link = uberLink(ride({ fromPlace: { ...HOTEL, lat: undefined, lon: undefined }, passengers: 6, childSeatNeeded: true }));
    expect(link.url).toContain("pickup=my_location");
    expect(link.unfilled).toEqual([
      { label: "Pick-up time", value: "Fri, Dec 18, 3:30 PM" },
      { label: "Pick up at", value: "1535 Broadway, New York, NY" },
      { label: "Riders (choose a larger car)", value: "6" },
      { label: "Child seat", value: "Needed. Choose a car seat option or bring your own." },
    ]);
  });

  it("declines when the drop-off has no coordinates", () => {
    expect(() => uberLink(ride({ toPlace: { ...JFK_T4, lat: undefined, lon: undefined } }))).toThrow(CannotPrefill);
    expect(() => uberLink(ride({ toPlace: undefined }))).toThrow(CannotPrefill);
  });
});

describe("Lyft (documented)", () => {
  it("matches the report's example", () => {
    const link = lyftLink(ride(), { partnerIds: { lyftPartnerId: "YOUR_CLIENT_ID" } });
    const example =
      "https://lyft.com/ride?id=lyft&pickup%5Blatitude%5D=40.7580&pickup%5Blongitude%5D=-73.9855&destination%5Blatitude%5D=40.6413&destination%5Blongitude%5D=-73.7781&partner=YOUR_CLIENT_ID";
    expect(link.url).toBe(example.replace("40.7580", "40.758"));
    expect(link.grade).toBe("documented");
    expect(link.unfilled).toEqual([{ label: "Pick-up time", value: "Fri, Dec 18, 3:30 PM" }]);
  });

  it("declines unless both ends have coordinates", () => {
    expect(() => lyftLink(ride({ fromPlace: undefined }))).toThrow(CannotPrefill);
    expect(() => lyftLink(ride({ fromPlace: { ...HOTEL, lat: undefined, lon: undefined } }))).toThrow(CannotPrefill);
  });
});

describe("Google Maps and Apple Maps directions (documented)", () => {
  it("matches Google's driving example", () => {
    expect(googleMapsDirectionsUrl("JFK Airport", "1535 Broadway New York NY", "driving")).toBe("https://www.google.com/maps/dir/?api=1&origin=JFK+Airport&destination=1535+Broadway+New+York+NY&travelmode=driving");
  });

  it("matches Google's transit example", () => {
    expect(googleMapsDirectionsUrl("Space Needle Seattle WA", "Pike Place Market Seattle WA", "transit")).toBe(
      "https://www.google.com/maps/dir/?api=1&origin=Space+Needle+Seattle+WA&destination=Pike+Place+Market+Seattle+WA&travelmode=transit",
    );
  });

  it("matches Apple's transit example", () => {
    expect(appleMapsDirectionsUrl("476 Fifth Ave New York, NY 10018", "200 Central Park W New York, NY 10024", "transit")).toBe(
      "https://maps.apple.com/directions?source=476%20Fifth%20Ave%20New%20York%2C%20NY%2010018&destination=200%20Central%20Park%20W%20New%20York%2C%20NY%2010024&mode=transit",
    );
  });

  it("matches Apple's example from the current location", () => {
    expect(appleMapsDirectionsUrl(null, "JFK Airport, Queens, NY", "driving")).toBe("https://maps.apple.com/directions?destination=JFK%20Airport%2C%20Queens%2C%20NY&mode=driving");
  });

  it("leaves the origin out to start from where the person is, and names cycling each provider's way", () => {
    expect(googleMapsDirectionsUrl(null, "JFK Airport", "cycling")).toBe("https://www.google.com/maps/dir/?api=1&destination=JFK+Airport&travelmode=bicycling");
    expect(appleMapsDirectionsUrl(undefined, "JFK Airport", "cycling")).toBe("https://maps.apple.com/directions?destination=JFK%20Airport&mode=cycling");
  });

  it("turns a place into the words a map search wants", () => {
    expect(mapsQueryText(HOTEL)).toBe("1535 Broadway, New York, NY");
    expect(mapsQueryText({ kind: "airport", name: "Orlando International Airport", iata: "MCO", tz: "America/New_York" })).toBe("Orlando International Airport");
    expect(mapsQueryText({ kind: "airport", name: "MCO", iata: "MCO", tz: "America/New_York" })).toBe("MCO airport");
    expect(mapsQueryText({ kind: "pickup_point", name: "Trailhead", lat: 47.5, lon: -121.75, tz: "America/Los_Angeles" })).toBe("47.5,-121.75");
    expect(mapsQueryText({ kind: "city", name: "Orlando", region: "FL", tz: "America/New_York" })).toBe("Orlando, FL");
    expect(mapsQueryText("  JFK Airport ")).toBe("JFK Airport");
  });
});

describe("food providers (observed)", () => {
  const where: PlaceRef = { kind: "lodging", name: "Lakeside House", addressLines: ["1420 Lake Shore Dr"], locality: "Orlando", region: "FL", postalCode: "32803", lat: 28.5632, lon: -81.3601, tz: "America/New_York" };

  it("builds each provider's search link in the report's format", () => {
    expect(doordashLink(food({ searchText: "pizza" })).url).toBe("https://www.doordash.com/search/store/pizza/");
    expect(uberEatsLink(food({ searchText: "thai food" })).url).toBe("https://www.ubereats.com/search?q=thai%20food");
    expect(grubhubLink(food({ searchText: "pizza" })).url).toBe("https://www.grubhub.com/search?queryText=pizza");
    expect(instacartLink(food({ searchText: "whole milk" })).url).toBe("https://www.instacart.com/store/s?k=whole%20milk");
  });

  it("adds the delivery place to Grubhub, the only one seen to take coordinates", () => {
    expect(grubhubLink(food({ searchText: "pizza", deliverToPlace: where })).url).toBe(
      "https://www.grubhub.com/search?queryText=pizza&orderMethod=delivery&locationMode=DELIVERY&latitude=28.5632&longitude=-81.3601",
    );
  });

  it("encodes a search with awkward characters as one path segment", () => {
    expect(doordashLink(food({ searchText: "Luigi's / Trattoria?" })).url).toBe("https://www.doordash.com/search/store/Luigi's%20%2F%20Trattoria%3F/");
  });

  it("always lists the address and the time, which no food link can carry", () => {
    const query = food({ searchText: "pizza", deliverToPlace: where, date: "2026-12-19", windowStart: "18:30", windowEnd: "19:30", dietarySummary: "1 vegetarian, 1 nut allergy", deliveryNote: "Side door" });
    expect(foodUnfilled(query)).toEqual([
      { label: "Deliver to", value: "1420 Lake Shore Dr, Orlando, FL 32803" },
      { label: "Deliver at", value: "Sat, Dec 19, 6:30 PM – 7:30 PM" },
      { label: "How many", value: "9 people" },
      { label: "Dietary needs", value: "1 vegetarian, 1 nut allergy" },
      { label: "Delivery note", value: "Side door" },
    ]);
    expect(doordashLink(query).unfilled).toEqual(foodUnfilled(query));
  });

  it("declines when there is nothing to search for, and ezCater always (it has no search link)", () => {
    expect(() => doordashLink(food())).toThrow(CannotPrefill);
    expect(() => instacartLink(food({ searchText: "  " }))).toThrow(CannotPrefill);
    expect(() => ezcaterLink(food({ searchText: "sandwiches" }))).toThrow(CannotPrefill);
  });
});

describe("flight trackers (observed)", () => {
  it("matches the report's examples", () => {
    expect(flightAwareUrl("UA", "123")).toBe("https://www.flightaware.com/live/flight/UAL123");
    expect(flightradar24Url("UA", "123")).toBe("https://www.flightradar24.com/data/flights/ua123");
    expect(googleFlightStatusUrl("UA", "123", "2026-12-18")).toBe("https://www.google.com/search?q=UA123+flight+status+Dec+18");
  });

  it("falls back to the IATA code when the airline is not in the ICAO table", () => {
    expect(flightAwareUrl("ZZ", "9")).toBe("https://www.flightaware.com/live/flight/ZZ9");
  });

  it("leaves the date words out when the date is not known", () => {
    expect(googleFlightStatusUrl("as", "1054")).toBe("https://www.google.com/search?q=AS1054+flight+status");
  });
});

describe("the provider registry", () => {
  it("has every provider the product names, with an https home page", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(
      ["airbnb", "apple_maps", "booking", "doordash", "expedia", "ezcater", "google_flights", "google_maps", "grubhub", "hotels", "instacart", "kayak", "lyft", "skyscanner", "turo", "uber", "uber_eats", "vrbo"].sort(),
    );
    for (const id of PROVIDER_IDS) {
      const info = PROVIDERS[id];
      expect(info.id).toBe(id);
      expect(info.homeUrl).toMatch(/^https:\/\/[a-z.]+\/?[a-z/]*$/);
      expect(info.disabled).toBe(false);
      expect(Object.keys(info.kinds).length).toBeGreaterThan(0);
    }
  });

  it("says where each button goes, in plain words with no exclamation marks", () => {
    for (const id of PROVIDER_IDS) {
      for (const words of Object.values(PROVIDERS[id].kinds)) {
        expect(words.actionLabel).toContain(PROVIDERS[id].name);
        expect(words.actionLabel).not.toMatch(/!/);
        expect(words.blurb).not.toMatch(/!/);
        expect(words.blurb.endsWith(".")).toBe(true);
        expect(words.blurb.length).toBeLessThanOrEqual(90);
      }
    }
    expect(PROVIDERS.kayak.kinds.car?.actionLabel).toBe("See cars on Kayak");
    expect(PROVIDERS.google_flights.kinds.flight?.actionLabel).toBe("See flights on Google Flights");
  });

  it("covers the providers the task lists for each kind", () => {
    const offering = (kind: "flight" | "lodging" | "car" | "ride" | "meal") => PROVIDER_IDS.filter((id) => PROVIDERS[id].kinds[kind]).sort();
    expect(offering("flight")).toEqual(["expedia", "google_flights", "kayak", "skyscanner"]);
    expect(offering("lodging")).toEqual(["airbnb", "booking", "expedia", "hotels", "vrbo"]);
    expect(offering("car")).toEqual(["expedia", "kayak", "turo"]);
    expect(offering("ride")).toEqual(["apple_maps", "google_maps", "lyft", "uber"]);
    expect(offering("meal")).toEqual(["doordash", "ezcater", "grubhub", "instacart", "uber_eats"]);
  });

  it("looks providers up by id, and is calm about ids it does not know", () => {
    expect(providerName("uber_eats")).toBe("Uber Eats");
    expect(providerName("some_old_provider")).toBe("some_old_provider");
    expect(providerInfo("nope")).toBeNull();
    expect(providerHomeUrl("kayak", "car")).toBe("https://www.kayak.com/cars");
    expect(providerHomeUrl("kayak")).toBe("https://www.kayak.com/");
    expect(providerHomeUrl("expedia", "lodging")).toBe("https://www.expedia.com/");
  });
});
