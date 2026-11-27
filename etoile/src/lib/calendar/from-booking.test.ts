import { describe, expect, it } from "vitest";
import { CAR_NEEDED, LAKESIDE_HOUSE, LAKESIDE_STAY, makeBooking, SEATTLE_FLIGHTS, AIRPORTS } from "@/lib/booking/fixtures/plan";
import { calendarItemFromTimeline, calendarItemsForBooking } from "./from-booking";
import { icsForItems } from "./ics";
import { calendarLinks } from "./links";

const NOW = new Date("2026-11-27T18:00:00Z");

describe("calendarItemsForBooking", () => {
  it("makes one entry per flight, take-off to landing, with stable ids", () => {
    expect(calendarItemsForBooking(SEATTLE_FLIGHTS)).toEqual([
      {
        id: "b-flight-sea-flight-0",
        title: "AS 1054 SEA to MCO",
        start: { at: "2026-12-19T15:35:00Z", tz: "America/Los_Angeles" },
        end: { at: "2026-12-19T21:10:00Z", tz: "America/New_York" },
        location: "SEA",
        description: "Alaska Airlines flight 1054 from SEA to MCO.",
      },
      {
        id: "b-flight-sea-flight-1",
        title: "AS 1055 MCO to SEA",
        start: { at: "2026-12-27T15:30:00Z", tz: "America/New_York" },
        end: { at: "2026-12-27T21:45:00Z", tz: "America/Los_Angeles" },
        location: "MCO",
        description: "Alaska Airlines flight 1055 from MCO to SEA.",
      },
    ]);
  });

  it("makes a stay an all-day entry that ends on the last night, with the times in the notes", () => {
    const [stay] = calendarItemsForBooking(LAKESIDE_STAY);
    expect(stay).toMatchObject({
      id: "b-stay-stay",
      title: "Stay: Lakeside House",
      allDay: true,
      localDate: "2026-12-19",
      // Check-out is Dec 27, so the last night is Dec 26.
      endDate: "2026-12-26",
      description: "Check-in from 4:00 PM. Check-out by 11:00 AM.",
    });
    const ics = icsForItems([stay], { now: NOW });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261219");
    expect(ics).toContain("DTEND;VALUE=DATE:20261227");
  });

  it("never lets a private field into a calendar: no code, price, note, door code or phone", () => {
    const bookings = [SEATTLE_FLIGHTS, LAKESIDE_STAY];
    const items = bookings.flatMap(calendarItemsForBooking);
    const everything = [icsForItems(items, { now: NOW, calendarName: "Hartley Family Christmas" }), ...items.flatMap((item) => calendarLinks(item).map((link) => decodeURIComponent(link.url)))].join("\n");
    for (const secret of ["KXWQPL", "HMXQ4T9RPA", "1,799", "179944", "456413", "4,564", "4417", "lakehouse", "heron2218", "555-0100", "kayak", "Marisol"]) {
      expect(everything, secret).not.toContain(secret);
    }
    // The public parts are there.
    expect(everything).toContain("Lakeside House");
    expect(everything).toContain("1420 Lake Shore Dr");
    expect(everything).toContain("AS 1054 SEA to MCO");
  });

  it("makes a pick-up and a return entry for a car", () => {
    const car = makeBooking("car", {
      id: "b-car",
      status: "booked",
      title: "Hertz at MCO",
      confirmationCode: "K58921437B2",
      details: { company: "Hertz", pickupPlace: AIRPORTS.MCO, pickupAt: { at: "2026-12-19T22:00:00Z", tz: "America/New_York" }, returnAt: { at: "2026-12-27T13:00:00Z", tz: "America/New_York" } },
    });
    const items = calendarItemsForBooking(car);
    expect(items.map((item) => [item.id, item.title, item.start?.at, item.place?.iata])).toEqual([
      ["b-car-car-pickup", "Pick up the car: Hertz", "2026-12-19T22:00:00Z", "MCO"],
      ["b-car-car-return", "Return the car: Hertz", "2026-12-27T13:00:00Z", "MCO"],
    ]);
    expect(JSON.stringify(items)).not.toContain("K58921437B2");
  });

  it("makes one entry for a ride, a food delivery and the last day to send something ahead", () => {
    const ride = makeBooking("ride", { id: "b-ride", status: "planned", title: "Airport ride", details: { fromPlace: AIRPORTS.MCO, toPlace: LAKESIDE_HOUSE, pickupAt: { at: "2026-12-19T21:40:00Z", tz: "America/New_York" } } });
    expect(calendarItemsForBooking(ride)).toEqual([{ id: "b-ride-ride", title: "Ride to Lakeside House", start: { at: "2026-12-19T21:40:00Z", tz: "America/New_York" }, place: AIRPORTS.MCO, description: "Pick-up at Orlando International Airport." }]);

    const meal = makeBooking("meal", {
      id: "b-meal",
      status: "booked",
      title: "Dinner",
      details: { mealType: "groceries", vendorName: "Publix", orderNumber: "IC-48213907", total: { amount: 21812, currency: "USD" }, deliverToPlace: LAKESIDE_HOUSE, windowStart: { at: "2026-12-19T23:00:00Z", tz: "America/New_York" }, windowEnd: { at: "2026-12-20T00:00:00Z", tz: "America/New_York" } },
    });
    const [food] = calendarItemsForBooking(meal);
    expect(food).toMatchObject({ id: "b-meal-food", title: "Groceries delivered: Publix", start: { at: "2026-12-19T23:00:00Z" }, end: { at: "2026-12-20T00:00:00Z" } });
    expect(JSON.stringify(food)).not.toContain("IC-48213907");
    expect(icsForItems([food], { now: NOW })).not.toMatch(/218|4417|555/);

    const box = makeBooking("shipment", { id: "b-box", status: "planned", title: "Box of gifts", details: { shipByDate: "2026-12-10" } });
    expect(calendarItemsForBooking(box)).toEqual([{ id: "b-box-ship-by", title: "Last safe day to send: Box of gifts", allDay: true, localDate: "2026-12-10" }]);
  });

  it("gives nothing for a booking with no dates yet, or one that is not needed", () => {
    expect(calendarItemsForBooking(CAR_NEEDED)).toEqual([]);
    expect(calendarItemsForBooking(makeBooking("lodging", { id: "x", title: "Stay" }))).toEqual([]);
    expect(calendarItemsForBooking(makeBooking("ride", { id: "x", title: "Ride" }))).toEqual([]);
    expect(calendarItemsForBooking(makeBooking("meal", { id: "x", title: "Dinner" }))).toEqual([]);
    expect(calendarItemsForBooking(makeBooking("shipment", { id: "x", title: "Box" }))).toEqual([]);
    expect(calendarItemsForBooking({ ...SEATTLE_FLIGHTS, status: "not_needed" })).toEqual([]);
  });

  it("marks a cancelled booking's entries cancelled, with the same ids, so calendars strike them out", () => {
    const items = calendarItemsForBooking({ ...SEATTLE_FLIGHTS, status: "cancelled" });
    expect(items.map((item) => [item.id, item.cancelled])).toEqual([
      ["b-flight-sea-flight-0", true],
      ["b-flight-sea-flight-1", true],
    ]);
    expect(icsForItems(items, { now: NOW }).match(/STATUS:CANCELLED/g)).toHaveLength(2);
  });

  it("says 'Terminal' once, however the terminal was typed", () => {
    const withTerminal = (terminal: string) =>
      calendarItemsForBooking(
        makeBooking("flight", { id: "f", status: "booked", title: "t", details: { segments: [{ airlineIata: "UA", flightNumber: "123", originIata: "JFK", destinationIata: "LHR", departsAt: "2026-12-18T23:00:00Z", originTz: "America/New_York", arrivesAt: "2026-12-19T06:00:00Z", destinationTz: "Europe/London", terminal }] } }),
      )[0].location;
    expect(withTerminal("7")).toBe("JFK, Terminal 7");
    expect(withTerminal("Terminal 7")).toBe("JFK, Terminal 7");
  });
});

describe("calendarItemFromTimeline", () => {
  const row = {
    key: "booking:b-flight-sea:flight:0",
    type: "flight",
    title: "Flight AS 1054, SEA to MCO",
    detail: "5 hours 35 minutes",
    start: { at: "2026-12-19T15:35:00Z", tz: "America/Los_Angeles" },
    end: { at: "2026-12-19T21:10:00Z", tz: "America/New_York" },
    localDate: "2026-12-19",
    tz: "America/Los_Angeles",
    allDay: false,
    place: AIRPORTS.SEA,
    description: null,
    link: null,
    status: "confirmed",
    visibility: "private",
  };

  it("carries a schedule row into a calendar with its key as the stable id", () => {
    const item = calendarItemFromTimeline(row);
    expect(item).toEqual({
      id: "booking:b-flight-sea:flight:0",
      title: "Flight AS 1054, SEA to MCO",
      start: row.start,
      end: row.end,
      allDay: false,
      localDate: "2026-12-19",
      place: AIRPORTS.SEA,
      description: null,
      url: null,
      cancelled: false,
    });
    const ics = icsForItems([item], { now: NOW });
    expect(ics).toContain("UID:booking:b-flight-sea:flight:0@etoile");
    expect(ics).toContain("DTSTART:20261219T153500Z");
  });

  it("makes a row with a day and no time an all-day entry, and marks a cancelled one", () => {
    const item = calendarItemFromTimeline({ key: "item:x", title: "Tree lighting", start: null, end: null, localDate: "2026-12-20", allDay: false, place: null, status: "cancelled" });
    expect(item).toMatchObject({ allDay: true, localDate: "2026-12-20", cancelled: true });
    expect(icsForItems([item], { now: NOW })).toContain("DTSTART;VALUE=DATE:20261220");
  });
});
