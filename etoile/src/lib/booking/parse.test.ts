import { describe, expect, it } from "vitest";
import { flightSegmentSchema } from "@/lib/domain";
import * as fixtures from "./fixtures/confirmations";
import { parseConfirmation, toFlightSegments, type ParsedConfirmation } from "./parse";
import { detectKind, findAddresses, findConfirmationCode, findTotal } from "./parsing/common";
import { findDates, findTimes } from "./parsing/dates";
import { prepare } from "./parsing/text";

const usd = (amount: number) => ({ amount, currency: "USD" });

function flight(parsed: ParsedConfirmation) {
  if (parsed.kind !== "flight") throw new Error(`Expected a flight, got ${parsed.kind}`);
  return parsed;
}

describe("flights", () => {
  it("reads an Alaska round trip: both flights, the code, the travelers, the total", () => {
    const parsed = flight(parseConfirmation(fixtures.alaskaRoundTrip));
    expect(parsed.segments).toEqual([
      { airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO", departDate: "2026-12-19", departTime: "07:35", arriveDate: "2026-12-19", arriveTime: "16:10" },
      { airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "1055", originIata: "MCO", destinationIata: "SEA", departDate: "2026-12-27", departTime: "10:30", arriveDate: "2026-12-27", arriveTime: "13:45" },
    ]);
    expect(parsed.fields).toEqual({
      airlineIata: "AS",
      airlineName: "Alaska Airlines",
      confirmationCode: "KXWQPL",
      passengerNames: ["Lydia Hartley", "Mark Hartley", "Theo Hartley", "Mae Hartley"],
      total: usd(179944),
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.confidence).toBe(1);
  });

  it("does not take the phone number after the word confirmation for the code", () => {
    expect(parseConfirmation(fixtures.alaskaRoundTrip).fields).toMatchObject({ confirmationCode: "KXWQPL" });
    expect(parseConfirmation("Alaska Airlines flight AS 12. Questions about your confirmation? Call 1-800-555-0199.").fields).not.toHaveProperty("confirmationCode");
  });

  it("reads a Delta itinerary of four flights with connections, dates printed once per direction", () => {
    const parsed = flight(parseConfirmation(fixtures.deltaConnection));
    expect(parsed.segments.map((s) => [s.airlineIata, s.flightNumber, s.originIata, s.destinationIata, s.departDate, s.departTime, s.arriveDate, s.arriveTime])).toEqual([
      ["DL", "1423", "PDX", "ATL", "2026-12-19", "06:15", "2026-12-19", "14:05"],
      ["DL", "2210", "ATL", "MCO", "2026-12-19", "15:20", "2026-12-19", "16:55"],
      ["DL", "1876", "MCO", "ATL", "2026-12-27", "11:05", "2026-12-27", "12:45"],
      // "DELTA 0911" is flight 911.
      ["DL", "911", "ATL", "PDX", "2026-12-27", "14:10", "2026-12-27", "16:32"],
    ]);
    expect(parsed.fields).toMatchObject({ confirmationCode: "H7TQ2M", passengerNames: ["Dana Hartley", "Chris Hartley"], total: usd(104480) });
    expect(parsed.warnings).toEqual([]);
  });

  it("reads two United flights with a connection and an overnight leg whose landing day is printed", () => {
    const parsed = flight(parseConfirmation(fixtures.unitedOvernightConnection));
    expect(parsed.segments).toEqual([
      { airlineIata: "UA", airlineName: "United Airlines", flightNumber: "1876", originIata: "SFO", destinationIata: "IAD", departDate: "2026-12-18", departTime: "22:40", arriveDate: "2026-12-19", arriveTime: "06:38" },
      { airlineIata: "UA", airlineName: "United Airlines", flightNumber: "437", originIata: "IAD", destinationIata: "MCO", departDate: "2026-12-19", departTime: "08:15", arriveDate: "2026-12-19", arriveTime: "10:31" },
    ]);
    // Ticket-style "HARTLEY/CAROL MS" becomes a name; "Duration: 4:58" is not a time.
    expect(parsed.fields).toMatchObject({ confirmationCode: "P4LM9X", passengerNames: ["Carol Hartley"], total: usd(33460) });
  });

  it("reads a Southwest one-way that never prints the airline code", () => {
    const parsed = flight(parseConfirmation(fixtures.southwestOneWay));
    expect(parsed.segments).toEqual([
      { airlineIata: "WN", airlineName: "Southwest Airlines", flightNumber: "1432", originIata: "DEN", destinationIata: "MCO", departDate: "2026-12-19", departTime: "06:05", arriveDate: "2026-12-19", arriveTime: "11:50" },
    ]);
    expect(parsed.fields).toMatchObject({ confirmationCode: "3RK9TZ", passengerNames: ["Mark Hartley"], total: usd(31840) });
  });

  it("reads a Lufthansa booking in 24-hour time, day-first dates, a +1 arrival and a euro total", () => {
    const parsed = flight(parseConfirmation(fixtures.lufthansa24Hour));
    expect(parsed.segments).toEqual([
      { airlineIata: "LH", airlineName: "Lufthansa", flightNumber: "491", originIata: "SEA", destinationIata: "FRA", departDate: "2026-12-19", departTime: "13:55", arriveDate: "2026-12-20", arriveTime: "08:45" },
      { airlineIata: "LH", airlineName: "Lufthansa", flightNumber: "2416", originIata: "FRA", destinationIata: "ARN", departDate: "2026-12-20", departTime: "10:20", arriveDate: "2026-12-20", arriveTime: "12:25" },
    ]);
    expect(parsed.fields).toEqual({
      airlineIata: "LH",
      airlineName: "Lufthansa",
      confirmationCode: "7QK3RD",
      // "Your itinerary" follows the names and is not one.
      passengerNames: ["Lydia Hartley", "Mark Hartley"],
      total: { amount: 148260, currency: "EUR" },
    });
  });

  it("reads a forwarded email: quote marks off, headers ignored, the year taken from when it was sent", () => {
    const parsed = flight(parseConfirmation(fixtures.forwardedAmerican));
    expect(parsed.segments.map((s) => [s.airlineIata, s.flightNumber, s.originIata, s.destinationIata, s.departDate, s.departTime, s.arriveDate, s.arriveTime])).toEqual([
      ["AA", "2390", "ORD", "MCO", "2026-12-19", "09:05", "2026-12-19", "12:48"],
      ["AA", "1187", "MCO", "ORD", "2026-12-27", "17:40", "2026-12-27", "19:35"],
    ]);
    // The email's own "Date: Mon, Nov 2, 2026" is never a travel date, and no year had to be assumed.
    expect(parsed.fields).toMatchObject({ confirmationCode: "MNTBRV", total: usd(41218) });
    expect(parsed.warnings).toEqual([]);
    // No "Passengers:" label, so no names: "Carol Hartley" alone on a line is not clear enough.
    expect(parsed.fields.passengerNames).toEqual([]);
  });

  it("returns what a short text message has and warns about the rest", () => {
    const parsed = flight(parseConfirmation(fixtures.jetblueTextMessage));
    expect(parsed.segments).toEqual([{ airlineIata: "B6", airlineName: "JetBlue Airways", flightNumber: "915", originIata: "JFK", destinationIata: "MCO", departTime: "07:05" }]);
    expect(parsed.fields).toEqual({ airlineIata: "B6", airlineName: "JetBlue Airways", confirmationCode: "ZKHTWD", passengerNames: [] });
    expect(parsed.warnings).toEqual(["We couldn't tell which day B6 915 leaves. Add it below.", "We couldn't find when B6 915 lands. Add it below."]);
    expect(parsed.confidence).toBeLessThan(0.75);
  });

  it("uses the caller's reference date for a missing year, and says so", () => {
    const parsed = flight(parseConfirmation(fixtures.jetblueTextMessage, { kind: "flight", referenceDate: "2026-11-27" }));
    expect(parsed.segments[0]).toMatchObject({ departDate: "2026-12-19", departTime: "07:05" });
    expect(parsed.warnings).toEqual(["We couldn't find when B6 915 lands. Add it below.", "The text doesn't say the year. We used 2026. Check the dates."]);
  });

  it("picks the next occurrence of a yearless date after the reference", () => {
    const text = "JetBlue: Flight B6 915 from JFK to MCO departs Jan 3 at 7:05 AM. Confirmation: ZKHTWD.";
    expect(flight(parseConfirmation(text, { referenceDate: "2026-12-20" })).segments[0].departDate).toBe("2027-01-03");
  });

  it("leaves the landing day empty when the clock goes backwards and nothing says +1", () => {
    const text = `Alaska Airlines\nConfirmation code: RDEYEX\nFlight AS 322\nFri, Dec 18, 2026\nDeparts: Seattle (SEA) 11:30 PM\nArrives: Orlando (MCO) 7:45 AM`;
    const parsed = flight(parseConfirmation(text));
    expect(parsed.segments[0]).toEqual({ airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "322", originIata: "SEA", destinationIata: "MCO", departDate: "2026-12-18", departTime: "23:30", arriveTime: "07:45" });
    expect(parsed.warnings).toEqual(["We couldn't tell which day AS 322 lands. Add it below."]);
  });

  it("takes 'next day' beside the arrival as the day after", () => {
    const text = `Alaska Airlines\nConfirmation code: RDEYEX\nFlight AS 322\nFri, Dec 18, 2026\nDeparts: Seattle (SEA) 11:30 PM\nArrives: Orlando (MCO) 7:45 AM (next day)`;
    expect(flight(parseConfirmation(text)).segments[0].arriveDate).toBe("2026-12-19");
  });

  it("does not invent a flight from a code that is not an airline, a leg counter or a time", () => {
    expect(flight(parseConfirmation("Your flight to 2 cities is booked. ARRIVES AT 12:30 PM. Flight 1 of 2.", "flight")).segments).toEqual([]);
    const parsed = flight(parseConfirmation("Thanks for booking your flight. We will email your itinerary soon.", "flight"));
    expect(parsed.segments).toEqual([]);
    expect(parsed.warnings).toContain("We couldn't find a flight number. Add the flights below.");
    expect(parsed.warnings).toContain("We couldn't find the confirmation code. Add it below, or choose No code.");
    expect(parsed.confidence).toBe(0);
  });

  it("only believes a bare two-letter code when that airline is named", () => {
    // "AT 12" could be Royal Air Maroc, but nothing here says so.
    expect(flight(parseConfirmation("DEPARTS AT 12 NOON FROM GATE 4. BOARDING PASS ATTACHED.", "flight")).segments).toEqual([]);
    expect(flight(parseConfirmation("United Airlines\nUA 437 SFO to IAD\nSat, Dec 19, 2026 8:15 AM - 4:31 PM", "flight")).segments[0]).toMatchObject({ airlineIata: "UA", flightNumber: "437", originIata: "SFO", destinationIata: "IAD", departDate: "2026-12-19", departTime: "08:15", arriveTime: "16:31" });
  });

  it("filters airports with the caller's airport check when one is given", () => {
    const text = "United Airlines\nUA 437\nSan Francisco (SFO) 8:15 AM to Washington (IAD) 4:31 PM (EST)\nSat, Dec 19, 2026";
    const strict = flight(parseConfirmation(text, { kind: "flight", isAirportCode: (code) => ["SFO", "IAD"].includes(code) }));
    expect(strict.segments[0]).toMatchObject({ originIata: "SFO", destinationIata: "IAD" });
    const refuse = flight(parseConfirmation(text, { kind: "flight", isAirportCode: () => false }));
    expect(refuse.segments[0].originIata).toBeUndefined();
    expect(refuse.warnings).toContain("We couldn't find the airports for UA 437. Add them below.");
  });
});

describe("toFlightSegments", () => {
  const zones: Record<string, string> = { SEA: "America/Los_Angeles", MCO: "America/New_York", FRA: "Europe/Berlin", ARN: "Europe/Stockholm", SFO: "America/Los_Angeles", IAD: "America/New_York" };
  const tz = (iata: string) => zones[iata];

  it("turns local times into instants using each airport's zone", () => {
    const { segments, incomplete } = toFlightSegments(flight(parseConfirmation(fixtures.alaskaRoundTrip)).segments, tz);
    expect(incomplete).toEqual([]);
    expect(segments).toEqual([
      { airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO", departsAt: "2026-12-19T15:35:00.000Z", originTz: "America/Los_Angeles", arrivesAt: "2026-12-19T21:10:00.000Z", destinationTz: "America/New_York" },
      { airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "1055", originIata: "MCO", destinationIata: "SEA", departsAt: "2026-12-27T15:30:00.000Z", originTz: "America/New_York", arrivesAt: "2026-12-27T21:45:00.000Z", destinationTz: "America/Los_Angeles" },
    ]);
    for (const segment of segments) expect(flightSegmentSchema.safeParse(segment).success).toBe(true);
  });

  it("handles an overnight flight across an ocean", () => {
    const { segments } = toFlightSegments(flight(parseConfirmation(fixtures.lufthansa24Hour)).segments, tz);
    // 13:55 in Seattle is 21:55 UTC; 08:45 in Frankfurt the next day is 07:45 UTC.
    expect(segments[0]).toMatchObject({ departsAt: "2026-12-19T21:55:00.000Z", arrivesAt: "2026-12-20T07:45:00.000Z" });
  });

  it("lists flights it cannot place instead of guessing", () => {
    const parsed = flight(parseConfirmation(fixtures.jetblueTextMessage));
    expect(toFlightSegments(parsed.segments, tz)).toEqual({ segments: [], incomplete: [0] });
    const alaska = flight(parseConfirmation(fixtures.alaskaRoundTrip)).segments;
    expect(toFlightSegments(alaska, (iata) => (iata === "SEA" ? "America/Los_Angeles" : undefined))).toEqual({ segments: [], incomplete: [0, 1] });
  });

  it("refuses a flight that would land before it takes off", () => {
    const wrong = [{ airlineIata: "AS", flightNumber: "1", originIata: "SEA", destinationIata: "MCO", departDate: "2026-12-19", departTime: "10:00", arriveDate: "2026-12-19", arriveTime: "09:00" }];
    expect(toFlightSegments(wrong, tz)).toEqual({ segments: [], incomplete: [0] });
  });
});

describe("stays", () => {
  it("reads a Marriott hotel", () => {
    const parsed = parseConfirmation(fixtures.marriottHotel);
    expect(parsed).toEqual({
      kind: "lodging",
      confidence: 1,
      warnings: [],
      fields: {
        lodgingType: "hotel",
        propertyName: "Courtyard by Marriott Orlando Lake Buena Vista",
        address: "8623 Vineland Avenue, Orlando, FL 32821",
        checkInDate: "2026-12-19",
        checkInTime: "16:00",
        checkOutDate: "2026-12-27",
        checkOutTime: "11:00",
        confirmationCode: "83124477",
        total: usd(170184),
      },
    });
  });

  it("reads a Hampton Inn that says Arrival and Departure, with the times in brackets", () => {
    expect(parseConfirmation(fixtures.hamptonHotel).fields).toEqual({
      lodgingType: "hotel",
      propertyName: "Hampton Inn & Suites Orlando Airport at Gateway Village",
      address: "5460 Gateway Village Circle, Orlando, FL 32812",
      checkInDate: "2026-12-19",
      checkInTime: "15:00",
      checkOutDate: "2026-12-20",
      checkOutTime: "12:00",
      confirmationCode: "3381127540",
      // "Cancel by … Dec 17" is not a stay date, and the nightly rate is not the total.
      total: usd(18450),
    });
  });

  it("reads a Hyatt with numeric dates and an address over two lines", () => {
    expect(parseConfirmation(fixtures.hyattHotel).fields).toEqual({
      lodgingType: "hotel",
      propertyName: "Hyatt Regency Orlando",
      address: "9801 International Drive, Orlando, FL 32819",
      checkInDate: "2026-12-19",
      checkInTime: "16:00",
      checkOutDate: "2026-12-22",
      checkOutTime: "11:00",
      confirmationCode: "51873342",
      total: usd(103392),
    });
  });

  it("reads a home rental laid out in two columns, once it has a year to go on", () => {
    const parsed = parseConfirmation(fixtures.airbnbHome, { referenceDate: "2026-11-27" });
    expect(parsed.fields).toEqual({
      provider: "Airbnb",
      lodgingType: "rental",
      propertyName: "Lakefront Family House with Pool and Dock",
      address: "2218 Heron Cove Lane, Kissimmee, FL 34746",
      checkInDate: "2026-12-19",
      checkInTime: "16:00",
      checkOutDate: "2026-12-27",
      checkOutTime: "11:00",
      confirmationCode: "HMXQ4T9RPA",
      total: usd(456413),
    });
    expect(parsed.warnings).toEqual(["The text doesn't say the year. We used 2026. Check the dates."]);
  });

  it("leaves the dates empty, with a warning each, when nothing gives the year", () => {
    const parsed = parseConfirmation(fixtures.airbnbHome);
    expect(parsed.kind).toBe("lodging");
    expect(parsed.fields).not.toHaveProperty("checkInDate");
    expect(parsed.fields).not.toHaveProperty("checkOutDate");
    // The times are still read, and to the right ends.
    expect(parsed.fields).toMatchObject({ checkInTime: "16:00", checkOutTime: "11:00", propertyName: "Lakefront Family House with Pool and Dock" });
    expect(parsed.warnings).toEqual(["We couldn't find the check-in date. Add it below.", "We couldn't find the check-out date. Add it below."]);
    expect(parsed.confidence).toBe(0.6);
  });

  it("does not make a hotel out of a polite sentence", () => {
    const text = "Thank you for booking with us. Your reservation is confirmed.\nCheck-in: Dec 19, 2026\nCheck-out: Dec 22, 2026\nConfirmation number: 4471220";
    const parsed = parseConfirmation(text);
    expect(parsed.kind).toBe("lodging");
    expect(parsed.fields).not.toHaveProperty("propertyName");
    expect(parsed.warnings).toContain("We couldn't find the name of the place. Add it below.");
    expect(parsed.warnings).toContain("We couldn't find the address. Add it below.");
  });

  it("drops a check-out that is not after check-in rather than save a stay of no nights", () => {
    const parsed = parseConfirmation("The Westin Seattle\nCheck-in: Dec 22, 2026\nCheck-out: Dec 19, 2026\nConfirmation number: 4471220", "lodging");
    expect(parsed.fields).toMatchObject({ checkInDate: "2026-12-22" });
    expect(parsed.fields).not.toHaveProperty("checkOutDate");
    expect(parsed.warnings).toContain("We couldn't find the check-out date. Add it below.");
  });

  it("flags a date that could be read two ways", () => {
    const parsed = parseConfirmation("Hotel: The Westin Seattle\nCheck-in: 03/04/2027\nCheck-out: 03/06/2027\nConfirmation number: 4471220");
    expect(parsed.fields).toMatchObject({ checkInDate: "2027-03-04", checkOutDate: "2027-03-06", propertyName: "The Westin Seattle" });
    expect(parsed.warnings).toContain("We read 03/04/2027 as month first, then day. Check the date.");
  });
});

describe("cars", () => {
  it("reads a Hertz reservation with the place on its own line", () => {
    expect(parseConfirmation(fixtures.hertzCar)).toEqual({
      kind: "car",
      confidence: 1,
      warnings: [],
      fields: {
        company: "Hertz",
        pickupPlace: "Orlando International Airport (MCO)",
        pickupDate: "2026-12-19",
        pickupTime: "17:00",
        returnPlace: "Orlando International Airport (MCO)",
        returnDate: "2026-12-27",
        returnTime: "08:00",
        vehicleClass: "suv",
        vehicleDescription: "(L) Chevrolet Tahoe or similar | Large SUV",
        confirmationCode: "K58921437B2",
        total: usd(128440),
      },
    });
  });

  it("reads an Enterprise reservation, including 'same as pick-up'", () => {
    expect(parseConfirmation(fixtures.enterpriseCar).fields).toEqual({
      company: "Enterprise",
      pickupPlace: "Orlando Intl Airport (MCO), 1 Jeff Fuqua Blvd, Orlando, FL 32827",
      pickupDate: "2026-12-19",
      pickupTime: "17:30",
      returnPlace: "Orlando Intl Airport (MCO), 1 Jeff Fuqua Blvd, Orlando, FL 32827",
      returnDate: "2026-12-27",
      returnTime: "07:30",
      vehicleClass: "minivan",
      vehicleDescription: "Minivan (Chrysler Pacifica or similar)",
      confirmationCode: "1846302957COUNT",
      total: usd(109618),
    });
  });

  it("reads an Avis reservation with separate location and date lines", () => {
    expect(parseConfirmation(fixtures.avisCar).fields).toEqual({
      company: "Avis",
      pickupPlace: "Orlando Intl Airport (MCO)",
      pickupDate: "2026-12-19",
      pickupTime: "17:00",
      returnPlace: "Orlando Intl Airport (MCO)",
      returnDate: "2026-12-27",
      returnTime: "08:00",
      // "Intermediate SUV" is an SUV, not a midsize car.
      vehicleClass: "suv",
      vehicleDescription: "Group E - Intermediate SUV, Toyota RAV4 or similar",
      confirmationCode: "20914477US3",
      total: usd(94336),
    });
  });

  it("warns about each thing it could not find", () => {
    const parsed = parseConfirmation("Thrifty car rental\nPick-up: Orlando International Airport\nYour vehicle: Compact", "car");
    expect(parsed.fields).toEqual({ company: "Thrifty", pickupPlace: "Orlando International Airport", vehicleClass: "compact", vehicleDescription: "Compact" });
    expect(parsed.warnings).toEqual([
      "We couldn't find the pick-up day. Add it below.",
      "We couldn't find the pick-up time. Add it below.",
      "We couldn't find the return day. Add it below.",
      "We couldn't find the return time. Add it below.",
      "We couldn't find the confirmation number. Add it below, or choose No code.",
    ]);
    expect(parsed.confidence).toBe(0.3);
  });
});

describe("rides", () => {
  it("reads an Uber receipt with no labels: time and address rows", () => {
    expect(parseConfirmation(fixtures.uberReceipt)).toEqual({
      kind: "ride",
      confidence: 1,
      warnings: [],
      fields: {
        provider: "Uber",
        pickupDate: "2026-12-19",
        pickupTime: "16:42",
        pickupAddress: "1 Jeff Fuqua Blvd, Orlando, FL 32827",
        dropoffAddress: "2218 Heron Cove Lane, Kissimmee, FL 34746",
        total: usd(5841),
      },
    });
  });

  it("reads a scheduled Lyft, and does not take a fare range for a total", () => {
    const parsed = parseConfirmation(fixtures.lyftScheduled, { referenceDate: "2026-11-27" });
    expect(parsed.fields).toEqual({
      provider: "Lyft",
      pickupDate: "2026-12-27",
      pickupTime: "07:45",
      pickupAddress: "2218 Heron Cove Lane, Kissimmee, FL 34746",
      dropoffAddress: "Orlando International Airport (MCO)",
    });
    expect(parsed.fields).not.toHaveProperty("total");
  });

  it("says the day is missing when the text gives no year and the caller none", () => {
    const parsed = parseConfirmation(fixtures.lyftScheduled);
    expect(parsed.fields).not.toHaveProperty("pickupDate");
    expect(parsed.warnings).toEqual(["We couldn't find the pick-up day. Add it below."]);
  });
});

describe("food", () => {
  it("reads an Instacart grocery order", () => {
    expect(parseConfirmation(fixtures.instacartGroceries)).toEqual({
      kind: "meal",
      confidence: 1,
      warnings: [],
      fields: {
        provider: "Instacart",
        vendorName: "Publix",
        mealType: "groceries",
        deliveryDate: "2026-12-19",
        windowStart: "18:00",
        windowEnd: "19:00",
        deliveryAddress: "2218 Heron Cove Lane, Kissimmee, FL 34746",
        orderNumber: "IC-48213907",
        // The subtotal, the fees and the tip are not the total.
        total: usd(21812),
      },
    });
  });

  it("reads a DoorDash dinner whose labels sit on their own lines", () => {
    expect(parseConfirmation(fixtures.doordashDinner).fields).toEqual({
      provider: "DoorDash",
      vendorName: "Luigi's Trattoria",
      mealType: "restaurant_delivery",
      // "Saturday, December 19" takes its year from "Sent Dec 15, 2026".
      deliveryDate: "2026-12-19",
      windowStart: "18:30",
      windowEnd: "19:00",
      deliveryAddress: "1420 Lake Shore Dr, Orlando, FL 32803",
      orderNumber: "7F3A91C2",
      total: usd(12487),
    });
  });

  it("reads an ezCater order with the date and the time on different lines and a suite in the address", () => {
    expect(parseConfirmation(fixtures.ezcaterLunch).fields).toEqual({
      provider: "ezCater",
      vendorName: "Blue Door Sandwich Co",
      mealType: "catering",
      deliveryDate: "2027-01-12",
      windowStart: "11:30",
      windowEnd: "11:45",
      deliveryAddress: "301 Congress Ave, Suite 400, Austin, TX 78701",
      orderNumber: "EZ-7741-2290",
      total: usd(41275),
    });
  });
});

describe("telling the kinds apart", () => {
  it("reads every fixture as the right kind with no hint", () => {
    const expected: Record<keyof typeof fixtures.ALL_CONFIRMATIONS, ParsedConfirmation["kind"]> = {
      alaskaRoundTrip: "flight",
      deltaConnection: "flight",
      unitedOvernightConnection: "flight",
      southwestOneWay: "flight",
      lufthansa24Hour: "flight",
      forwardedAmerican: "flight",
      jetblueTextMessage: "flight",
      marriottHotel: "lodging",
      hamptonHotel: "lodging",
      hyattHotel: "lodging",
      airbnbHome: "lodging",
      hertzCar: "car",
      enterpriseCar: "car",
      avisCar: "car",
      uberReceipt: "ride",
      lyftScheduled: "ride",
      instacartGroceries: "meal",
      doordashDinner: "meal",
      ezcaterLunch: "meal",
      notAConfirmation: null,
    };
    expect(Object.keys(fixtures.ALL_CONFIRMATIONS).length).toBeGreaterThanOrEqual(15);
    for (const [name, text] of Object.entries(fixtures.ALL_CONFIRMATIONS)) {
      expect(parseConfirmation(text).kind, name).toBe(expected[name as keyof typeof expected]);
    }
  });

  it("does not take Uber Eats for a ride", () => {
    expect(detectKind("Uber Eats\nYour order from Thai Basil is on its way. Delivery fee $2.99. Total $31.20").kind).toBe("meal");
    expect(detectKind("Uber\nThanks for riding, Lydia. Trip fare $46.12").kind).toBe("ride");
  });

  it("says so when it cannot tell, and returns nothing made up", () => {
    expect(parseConfirmation(fixtures.notAConfirmation)).toEqual({
      kind: null,
      confidence: 0,
      fields: {},
      warnings: ["We couldn't tell what kind of booking this is. Choose the kind and paste it again, or fill in the details below."],
    });
  });

  it("reads as the kind it is told, and warns when the text reads like something else", () => {
    const parsed = parseConfirmation(fixtures.hertzCar, "lodging");
    expect(parsed.kind).toBe("lodging");
    expect(parsed.warnings[0]).toBe("This doesn't read like the kind of booking you're recording. Check every field.");
    expect(parsed.confidence).toBeLessThan(0.5);
    // The right hint changes nothing.
    expect(parseConfirmation(fixtures.hertzCar, "car")).toEqual(parseConfirmation(fixtures.hertzCar));
    expect(parseConfirmation(fixtures.hertzCar, { kind: "car" })).toEqual(parseConfirmation(fixtures.hertzCar));
  });

  it("has nothing to read for send ahead", () => {
    const parsed = parseConfirmation(fixtures.hertzCar, "shipment");
    expect(parsed.kind).toBeNull();
    expect(parsed.warnings).toEqual(["Send-ahead details are entered by hand. Paste the tracking number on the send-ahead page instead."]);
  });
});

describe("whatever is pasted, it never throws and never invents", () => {
  it("handles empty, tiny and wrong-typed input", () => {
    const tooShort = { kind: null, confidence: 0, fields: {}, warnings: ["There isn't enough here to read. Paste the whole confirmation email or page."] };
    expect(parseConfirmation("")).toEqual(tooShort);
    expect(parseConfirmation("   \n\n ")).toEqual(tooShort);
    expect(parseConfirmation("ok thanks")).toEqual(tooShort);
    expect(parseConfirmation(undefined as unknown as string)).toEqual(tooShort);
    expect(parseConfirmation(12345 as unknown as string)).toEqual(tooShort);
  });

  it("survives junk, markup, emoji and very long text", () => {
    const junk = ["<html><body><script>alert(1)</script><p>Flight</p></body></html>", "🎄".repeat(5000), "a".repeat(200_000), "\u0000\u0001\u0002 flight ￿", `${"Flight AS 1054 ".repeat(3000)}`, "((((((((((((((((((((", "Check-in ".repeat(2000)];
    for (const text of junk) {
      for (const hint of [undefined, "flight", "lodging", "car", "ride", "meal"] as const) {
        const parsed = parseConfirmation(text, hint);
        expect(parsed.confidence).toBeGreaterThanOrEqual(0);
        expect(parsed.confidence).toBeLessThanOrEqual(1);
        expect(Array.isArray(parsed.warnings)).toBe(true);
      }
    }
  });

  it("returns only dates that are real days and times that are real times", () => {
    const isDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const isTime = (value: unknown) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    for (const text of Object.values(fixtures.ALL_CONFIRMATIONS)) {
      const parsed = parseConfirmation(text, { referenceDate: "2026-11-27" });
      const records: Array<Record<string, unknown>> = [parsed.fields, ...(parsed.segments ?? [])];
      for (const record of records) {
        for (const [key, value] of Object.entries(record)) {
          if (/Date$/.test(key)) expect(isDate(value), `${key}=${String(value)}`).toBe(true);
          if (/Time$|^window(Start|End)$/.test(key)) expect(isTime(value), `${key}=${String(value)}`).toBe(true);
        }
      }
    }
    expect(parseConfirmation("Hotel: The Westin\nCheck-in: Feb 30, 2027\nCheck-out: 13/45/2027\nConfirmation number: 4471220").fields).not.toHaveProperty("checkInDate");
  });

  it("writes every warning as a plain sentence with no exclamation mark", () => {
    const all = [...Object.values(fixtures.ALL_CONFIRMATIONS), "Thrifty car rental", "Flight to somewhere", "Hotel stay check-out", "Your order", "Your ride with a driver, fare"];
    for (const text of all) {
      for (const hint of [undefined, "flight", "lodging", "car", "ride", "meal"] as const) {
        for (const warning of parseConfirmation(text, hint).warnings) {
          expect(warning).toMatch(/^[A-Z].*\.$/);
          expect(warning).not.toMatch(/!|undefined|null|NaN/);
        }
      }
    }
  });
});

describe("the readers underneath", () => {
  it("cleans quoted and forwarded text and keeps the sent date aside", () => {
    const prepared = prepare(fixtures.forwardedAmerican);
    expect(prepared.sentHeader).toBe("Mon, Nov 2, 2026 at 9:14 AM");
    expect(prepared.text).not.toMatch(/^>/m);
    expect(prepared.text).not.toContain("no-reply@");
    expect(prepared.text).not.toContain("Forwarded message");
    expect(prepared.lines.slice(0, 3)).toEqual(["Fwd: Your trip confirmation (ORD - MCO)", "Your trip confirmation (ORD - MCO)", "American Airlines"]);
  });

  it("leaves 'From:' and 'To:' alone when they are a route, not an email header", () => {
    const prepared = prepare("From: Seattle (SEA)\nTo: Orlando (MCO)\nFlight AS 1054");
    expect(prepared.lines).toEqual(["From: Seattle (SEA)", "To: Orlando (MCO)", "Flight AS 1054"]);
  });

  it("finds dates in the forms confirmations use", () => {
    const dates = (text: string) => findDates(text).map((hit) => hit.date);
    expect(dates("Sat, Dec 19, 2026")).toEqual(["2026-12-19"]);
    expect(dates("Saturday, December 19th, 2026")).toEqual(["2026-12-19"]);
    expect(dates("19 Dec 2026")).toEqual(["2026-12-19"]);
    expect(dates("19 December 2026")).toEqual(["2026-12-19"]);
    expect(dates("19DEC26")).toEqual(["2026-12-19"]);
    expect(dates("2026-12-19")).toEqual(["2026-12-19"]);
    expect(dates("12/19/2026")).toEqual(["2026-12-19"]);
    expect(dates("19/12/2026")).toEqual(["2026-12-19"]);
    expect(dates("19.12.2026")).toEqual(["2026-12-19"]);
    expect(dates("Sept 5, 2027 and May 5, 2027")).toEqual(["2027-09-05", "2027-05-05"]);
    // No year anywhere: nothing is guessed.
    expect(dates("Dec 19")).toEqual([null]);
    // A year printed elsewhere in the text is used.
    expect(dates("Dec 19 to Jan 2. Booked Nov 2, 2026.")).toEqual(["2026-12-19", "2027-01-02", "2026-11-02"]);
    // Not dates.
    expect(dates("March 2026, room 1204, $12.19, 12:19 PM, flight 1219")).toEqual([]);
    expect(dates("Feb 30, 2027")).toEqual([null]);
  });

  it("finds clock times and leaves durations, seats and prices alone", () => {
    const times = (text: string) => findTimes(text).map((hit) => hit.time);
    expect(times("4:10 PM, 4:10pm, 4:10 p.m., 4 PM, 4:10p, 12:00 AM, 12:30 PM, noon")).toEqual(["16:10", "16:10", "16:10", "16:00", "16:10", "00:00", "12:30", "12:00"]);
    expect(times("13:55 and 08:45 and 0:05")).toEqual(["13:55", "08:45", "00:05"]);
    expect(times("Duration: 5:30 · Seats 14A, 4A · $4.10 · 2 adults · 5 Park Ave · 10h 50m")).toEqual([]);
    expect(times("25:00, 13:75, 4:10:30")).toEqual([]);
  });

  it("finds a code only behind a label", () => {
    const code = (text: string) => findConfirmationCode(prepare(text));
    expect(code("Confirmation code: KXWQPL")).toBe("KXWQPL");
    expect(code("Your confirmation number is 4471-2290")).toBe("4471-2290");
    expect(code("Record locator\nMNTBRV")).toBe("MNTBRV");
    expect(code("Booking reference: 7QK3RD")).toBe("7QK3RD");
    expect(code("Reservation Number 20914477US3")).toBe("20914477US3");
    expect(code("KXWQPL")).toBeUndefined();
    expect(code("Confirmation email sent to lydia@example.com")).toBeUndefined();
    expect(code("Confirmation number: pending")).toBeUndefined();
  });

  it("finds a total only on a line that says total, with a currency", () => {
    const total = (text: string) => findTotal(prepare(text));
    expect(total("Subtotal $90.00\nTotal $124.87")).toEqual(usd(12487));
    expect(total("Grand Total: US$1,284.40")).toEqual(usd(128440));
    expect(total("Amount paid: 412.18 USD")).toEqual(usd(41218));
    expect(total("Total\n$58.41")).toEqual(usd(5841));
    expect(total("Total price: EUR 1.482,60")).toEqual({ amount: 148260, currency: "EUR" });
    expect(total("Total: £89.00")).toEqual({ amount: 8900, currency: "GBP" });
    expect(total("Total: CA$120.50")).toEqual({ amount: 12050, currency: "CAD" });
    expect(findTotal(prepare("Total $50.00"), "CAD")).toEqual({ amount: 5000, currency: "CAD" });
    expect(total("Subtotal $90.00")).toBeUndefined();
    expect(total("Total nights: 8")).toBeUndefined();
    expect(total("Total guests 9, room 1204")).toBeUndefined();
    expect(total("Estimated fare: $52 - $61")).toBeUndefined();
    expect(total("Total: $52 - $61")).toBeUndefined();
  });

  it("finds US street addresses, on one line or two", () => {
    expect(findAddresses("Meet at 1420 Lake Shore Dr, Orlando, FL 32803 at noon").map((a) => a.text)).toEqual(["1420 Lake Shore Dr, Orlando, FL 32803"]);
    expect(findAddresses("9801 International Drive\nOrlando, FL 32819").map((a) => a.text)).toEqual(["9801 International Drive, Orlando, FL 32819"]);
    expect(findAddresses("301 Congress Ave, Suite 400, Austin, TX 78701-1234").map((a) => a.text)).toEqual(["301 Congress Ave, Suite 400, Austin, TX 78701-1234"]);
    expect(findAddresses("Room 1204, 8 nights, 2 adults")).toEqual([]);
  });
});
