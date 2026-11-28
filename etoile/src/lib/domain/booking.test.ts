import { describe, expect, it } from "vitest";
import {
  actBySchema,
  bookingDetailsSchema,
  bookingKindListSchema,
  carDetailsSchema,
  emptyBookingDetails,
  flightDesignator,
  flightDetailsSchema,
  flightSegmentSchema,
  flightSegmentTimes,
  lodgingDetailsSchema,
  mealDetailsSchema,
  parseBookingDetails,
  rideDetailsSchema,
  shipmentDetailsSchema,
  unfilledListSchema,
  withoutEmptyText,
  BOOKING_KINDS,
  type BookingDetails,
  type PlaceRef,
} from "./index";

const orlandoHouse: PlaceRef = {
  kind: "lodging",
  name: "Lake Butler house",
  addressLines: ["8800 Lake Butler Blvd"],
  locality: "Windermere",
  region: "FL",
  postalCode: "34786",
  countryCode: "US",
  lat: 28.4956,
  lon: -81.5348,
  tz: "America/New_York",
};
const mco: PlaceRef = { kind: "airport", name: "Orlando International", iata: "MCO", countryCode: "US", lat: 28.4294, lon: -81.309, tz: "America/New_York" };

const segment = {
  airlineIata: "AS",
  airlineName: "Alaska Airlines",
  flightNumber: "1054",
  originIata: "SEA",
  destinationIata: "MCO",
  departsAt: "2026-12-19T16:10:00Z",
  originTz: "America/Los_Angeles",
  arrivesAt: "2026-12-19T21:35:00Z",
  destinationTz: "America/New_York",
  terminal: "N",
  seats: { p0000000001a: "14C", p0000000002b: "14D" },
};

describe("flight details", () => {
  it("accepts a recorded round trip", () => {
    const parsed = flightDetailsSchema.parse({
      kind: "flight",
      tripType: "round_trip",
      cabin: "economy",
      search: { originIata: "SEA", destinationIata: "MCO", departDate: "2026-12-19", returnDate: "2026-12-27", adults: 2, children: 2, childAges: [9, 6] },
      segments: [segment, { ...segment, flightNumber: "1055", originIata: "MCO", destinationIata: "SEA", departsAt: "2026-12-27T15:00:00Z", originTz: "America/New_York", arrivesAt: "2026-12-27T21:20:00Z", destinationTz: "America/Los_Angeles", seats: undefined }],
    });
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.search).toMatchObject({ adults: 2, children: 2, infants: 0 });
    expect(flightDesignator(parsed.segments[0])).toBe("AS 1054");
    expect(flightSegmentTimes(parsed.segments[0])).toEqual({
      departs: { at: "2026-12-19T16:10:00Z", tz: "America/Los_Angeles" },
      arrives: { at: "2026-12-19T21:35:00Z", tz: "America/New_York" },
    });
  });

  it("accepts a booking that is only needed so far, and fills the defaults", () => {
    expect(flightDetailsSchema.parse({ kind: "flight" })).toEqual({ kind: "flight", segments: [] });
    expect(flightDetailsSchema.parse({ kind: "flight", search: {} }).search).toEqual({ adults: 1, children: 0, infants: 0 });
  });

  it("rejects bad segments", () => {
    const bad = (patch: Record<string, unknown>) => flightSegmentSchema.safeParse({ ...segment, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ airlineIata: "Alaska" })).toBe(false);
    expect(bad({ airlineIata: "as" })).toBe(false);
    expect(bad({ flightNumber: "AS1054" })).toBe(false);
    expect(bad({ flightNumber: "" })).toBe(false);
    expect(bad({ originIata: "Seattle" })).toBe(false);
    expect(bad({ destinationIata: "mco" })).toBe(false);
    expect(bad({ departsAt: "2026-12-19 08:10" })).toBe(false); // not a UTC instant
    expect(bad({ departsAt: "2026-12-19T08:10:00-08:00" })).toBe(false); // offsets are not stored
    expect(bad({ originTz: "PST" })).toBe(false); // not an IANA zone
    expect(bad({ originTz: undefined })).toBe(false); // an instant always travels with its zone
    expect(bad({ arrivesAt: "2026-12-19T16:00:00Z" })).toBe(false); // lands before it takes off
    expect(bad({ seats: { p1: "this is not a seat number" } })).toBe(false);
  });

  it("rejects bad searches", () => {
    const ok = (search: Record<string, unknown>) => flightDetailsSchema.safeParse({ kind: "flight", search }).success;
    expect(ok({ adults: 2 })).toBe(true);
    expect(ok({ adults: -1 })).toBe(false);
    expect(ok({ adults: 1.5 })).toBe(false);
    expect(ok({ departDate: "12/19/2026" })).toBe(false);
    expect(ok({ departDate: "2026-02-30" })).toBe(false);
    expect(flightDetailsSchema.safeParse({ kind: "flight", cabin: "steerage" }).success).toBe(false);
    expect(flightDetailsSchema.safeParse({ kind: "flight", tripType: "there_and_back" }).success).toBe(false);
  });
});

describe("lodging details", () => {
  const stay = {
    kind: "lodging",
    lodgingType: "rental",
    propertyName: "Lake Butler house",
    place: orlandoHouse,
    checkInDate: "2026-12-19",
    checkOutDate: "2026-12-27",
    rooms: [{ label: "Primary", personIds: ["p0000000001a"] }, { label: "Bunk room" }],
    contactName: "Dana (host)",
    contactPhone: "+1 407 555 0100",
    accessNotes: "Door code 4471. Wi-Fi: lakehouse / sunshine.",
    packagePolicy: { accepts: true, holdDays: 3, feePerBox: { amount: 500, currency: "USD" }, contact: "Front desk" },
    roomBlock: { code: "HARTLEY26", rate: { amount: 18900, currency: "USD" }, bookBy: "2026-12-01", bookingUrl: "https://example.com/block" },
  };

  it("accepts a full stay and fills the default times", () => {
    const parsed = lodgingDetailsSchema.parse(stay);
    expect(parsed.checkInTime).toBe("16:00");
    expect(parsed.checkOutTime).toBe("11:00");
    expect(parsed.rooms[1]).toEqual({ label: "Bunk room", personIds: [] });
    expect(parsed.place?.tz).toBe("America/New_York");
  });

  it("accepts a stay that is only needed so far", () => {
    expect(lodgingDetailsSchema.parse({ kind: "lodging" })).toEqual({ kind: "lodging", checkInTime: "16:00", checkOutTime: "11:00", rooms: [] });
  });

  it("rejects bad stays", () => {
    const ok = (patch: Record<string, unknown>) => lodgingDetailsSchema.safeParse({ ...stay, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ checkOutDate: "2026-12-18" })).toBe(false); // before check-in
    expect(ok({ checkOutDate: "2026-12-19" })).toBe(true); // a day room
    expect(ok({ checkInTime: "4 PM" })).toBe(false);
    expect(ok({ checkInTime: "24:00" })).toBe(false);
    expect(ok({ lodgingType: "castle" })).toBe(false);
    expect(ok({ place: { ...orlandoHouse, tz: undefined } })).toBe(false); // a place always has a zone
    expect(ok({ place: { ...orlandoHouse, lat: 128 } })).toBe(false);
    expect(ok({ roomBlock: { bookingUrl: "javascript:alert(1)" } })).toBe(false);
    expect(ok({ packagePolicy: { feePerBox: { amount: 5.5, currency: "USD" } } })).toBe(false); // minor units are whole
    expect(ok({ rooms: [{ label: "" }] })).toBe(false);
  });
});

describe("car details", () => {
  const car = {
    kind: "car",
    company: "Alamo",
    vehicleClass: "minivan",
    seats: 7,
    pickupPlace: mco,
    pickupAt: { at: "2026-12-19T22:15:00Z", tz: "America/New_York" },
    returnPlace: mco,
    returnAt: { at: "2026-12-27T13:00:00Z", tz: "America/New_York" },
    driverPersonIds: ["p0000000001a"],
    childSeats: 1,
  };

  it("accepts a full booking and an empty one", () => {
    expect(carDetailsSchema.parse(car)).toMatchObject({ company: "Alamo", seats: 7 });
    expect(carDetailsSchema.parse({ kind: "car" })).toEqual({ kind: "car", driverPersonIds: [] });
  });

  it("rejects bad bookings", () => {
    const ok = (patch: Record<string, unknown>) => carDetailsSchema.safeParse({ ...car, ...patch }).success;
    expect(ok({ returnAt: { at: "2026-12-19T22:00:00Z", tz: "America/New_York" } })).toBe(false); // returned before pickup
    expect(ok({ pickupAt: { at: "2026-12-19T22:15:00Z" } })).toBe(false); // no zone
    expect(ok({ pickupAt: "2026-12-19T22:15:00Z" })).toBe(false);
    expect(ok({ vehicleClass: "tank" })).toBe(false);
    expect(ok({ seats: 0 })).toBe(false);
    expect(ok({ childSeats: -1 })).toBe(false);
  });
});

describe("ride details", () => {
  const ride = {
    kind: "ride",
    rideType: "personal_pickup",
    fromPlace: mco,
    toPlace: orlandoHouse,
    pickupAt: { at: "2026-12-19T22:05:00Z", tz: "America/New_York" },
    passengerIds: ["p0000000001a", "p0000000002b"],
    bags: 4,
    childSeatNeeded: true,
    driverPersonId: "p0000000009z",
    vehicleSeats: 5,
    arrivalIds: ["a0000000001a"],
    reserveOn: "2026-12-12",
  };

  it("accepts a full ride and an empty one", () => {
    expect(rideDetailsSchema.parse(ride)).toMatchObject({ rideType: "personal_pickup", bags: 4 });
    expect(rideDetailsSchema.parse({ kind: "ride" })).toEqual({ kind: "ride", passengerIds: [], arrivalIds: [] });
  });

  it("rejects bad rides", () => {
    const ok = (patch: Record<string, unknown>) => rideDetailsSchema.safeParse({ ...ride, ...patch }).success;
    expect(ok({ rideType: "helicopter" })).toBe(false);
    expect(ok({ bags: -1 })).toBe(false);
    expect(ok({ reserveOn: "next Tuesday" })).toBe(false);
    expect(ok({ pickupAt: { at: "soon", tz: "America/New_York" } })).toBe(false);
    expect(ok({ toPlace: { name: "Somewhere" } })).toBe(false); // no kind, no zone
    expect(ok({ passengerIds: "everyone" })).toBe(false);
  });
});

describe("meal details", () => {
  const meal = {
    kind: "meal",
    mealType: "groceries",
    vendorName: "Publix via Instacart",
    deliverToPlace: orlandoHouse,
    windowStart: { at: "2026-12-19T23:00:00Z", tz: "America/New_York" },
    windowEnd: { at: "2026-12-20T00:00:00Z", tz: "America/New_York" },
    headcount: 11,
    dietarySummary: "2 vegetarian, 1 nut allergy",
    list: [{ name: "Milk", quantity: 2 }, { name: "Cereal" }, { name: "Coffee", note: "Whole bean" }],
    deliveryNote: "Leave at the side door.",
    orderOpensOn: "2026-12-12",
    orderNumber: "IC-88211",
    total: { amount: 18450, currency: "USD" },
    tip: { amount: 2000, currency: "USD" },
  };

  it("accepts a full order and an empty one", () => {
    expect(mealDetailsSchema.parse(meal).list).toHaveLength(3);
    expect(mealDetailsSchema.parse({ kind: "meal" })).toEqual({ kind: "meal", list: [] });
  });

  it("rejects bad orders", () => {
    const ok = (patch: Record<string, unknown>) => mealDetailsSchema.safeParse({ ...meal, ...patch }).success;
    expect(ok({ windowEnd: { at: "2026-12-19T22:00:00Z", tz: "America/New_York" } })).toBe(false); // ends before it starts
    expect(ok({ mealType: "picnic" })).toBe(false);
    expect(ok({ headcount: 2.5 })).toBe(false);
    expect(ok({ list: [{ quantity: 2 }] })).toBe(false); // an item needs a name
    expect(ok({ total: { amount: 100 } })).toBe(false); // money needs a currency
    expect(ok({ total: { amount: 100, currency: "usd" } })).toBe(false);
  });
});

describe("shipment details", () => {
  const shipment = {
    kind: "shipment",
    shipmentKind: "gift",
    direction: "outbound",
    destinationType: "vacation_rental",
    lodgingBookingId: "b0000000001a",
    recipientName: "Lydia Hartley",
    propertyName: "Lake Butler house",
    labelLines: ["Lydia Hartley", "8800 Lake Butler Blvd", "Windermere, FL 34786"],
    holdNote: "GUEST ARRIVING 12/19",
    arrivalDate: "2026-12-19",
    serviceKey: "ups_ground",
    originPostal: "98101",
    destinationPostal: "34786",
    zone: 8,
    targetDeliveryDate: "2026-12-21",
    shipByDate: "2026-12-10",
    latestRiskyDate: "2026-12-15",
    warnings: ["Peak season: 2 extra business days added."],
    propertyAnswers: { confirmed: true, holdDays: 0, contact: "Dana" },
    contents: [
      { description: "Wrapped gifts", quantity: 6, value: { amount: 4000, currency: "USD" }, flags: [] },
      { description: "Toy drone", flags: ["lithium", "valuable"] },
    ],
    parcels: [
      { weight: { value: 18, unit: "lb" }, dimensions: { length: 18, width: 14, height: 12, unit: "in" }, trackingNumber: "1Z999AA10123456784", carrierDetected: "ups", status: "shipped", statusAt: "2026-12-10T19:00:00Z" },
      {},
    ],
  };

  it("accepts a full shipment and fills the defaults", () => {
    const parsed = shipmentDetailsSchema.parse(shipment);
    expect(parsed.international).toBe(false);
    expect(parsed.contents[1]).toMatchObject({ quantity: 1, flags: ["lithium", "valuable"] });
    expect(parsed.parcels[1]).toEqual({ status: "planned" });
    expect(parsed.parcels[0].status).toBe("shipped");
  });

  it("accepts a shipment that is only needed so far", () => {
    expect(shipmentDetailsSchema.parse({ kind: "shipment" })).toEqual({
      kind: "shipment", direction: "outbound", labelLines: [], international: false, warnings: [], contents: [], parcels: [],
    });
  });

  it("rejects bad shipments", () => {
    const ok = (patch: Record<string, unknown>) => shipmentDetailsSchema.safeParse({ ...shipment, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ shipmentKind: "livestock" })).toBe(false);
    expect(ok({ destinationType: "moon_base" })).toBe(false);
    expect(ok({ direction: "sideways" })).toBe(false);
    expect(ok({ shipByDate: "Dec 10" })).toBe(false);
    expect(ok({ contents: [{ description: "Batteries", flags: ["explosive"] }] })).toBe(false);
    expect(ok({ contents: [{ description: "Socks", quantity: 0 }] })).toBe(false);
    expect(ok({ parcels: [{ status: "lost_at_sea" }] })).toBe(false);
    expect(ok({ parcels: [{ weight: { value: -3, unit: "lb" } }] })).toBe(false);
    expect(ok({ parcels: [{ weight: { value: 3, unit: "stone" } }] })).toBe(false);
    expect(ok({ parcels: [{ statusAt: "yesterday" }] })).toBe(false);
  });
});

describe("the discriminated union", () => {
  it("picks the schema from kind", () => {
    const parsed: BookingDetails = bookingDetailsSchema.parse({ kind: "car", company: "Alamo" });
    expect(parsed.kind).toBe("car");
    if (parsed.kind === "car") expect(parsed.driverPersonIds).toEqual([]);
    expect(bookingDetailsSchema.safeParse({ kind: "boat" }).success).toBe(false);
    expect(bookingDetailsSchema.safeParse({ company: "Alamo" }).success).toBe(false);
    // Fields of another kind are dropped, not stored.
    expect(bookingDetailsSchema.parse({ kind: "ride", company: "Alamo" })).not.toHaveProperty("company");
  });

  it("gives every kind an empty starting value that parses again unchanged", () => {
    for (const kind of BOOKING_KINDS) {
      const empty = emptyBookingDetails(kind);
      expect(empty.kind).toBe(kind);
      expect(bookingDetailsSchema.parse(empty)).toEqual(empty);
      expect(JSON.parse(JSON.stringify(empty))).toEqual(empty);
    }
  });
});

describe("parseBookingDetails", () => {
  it("validates details against the booking's kind", () => {
    const flight = parseBookingDetails("flight", { kind: "flight", segments: [segment] });
    expect(flight.ok).toBe(true);
    if (flight.ok) expect(flight.details.segments[0].flightNumber).toBe("1054");

    // kind may be left out; it is filled in from the booking.
    const lodging = parseBookingDetails("lodging", { propertyName: "Lake Butler house" });
    expect(lodging).toEqual({ ok: true, details: { kind: "lodging", propertyName: "Lake Butler house", checkInTime: "16:00", checkOutTime: "11:00", rooms: [] } });
  });

  it("refuses details of another kind", () => {
    const result = parseBookingDetails("flight", { kind: "lodging", propertyName: "Lake Butler house" });
    expect(result).toMatchObject({ ok: false, error: "These are lodging details, but the booking is a flight" });
  });

  it("reports the first problem and where it is, without throwing", () => {
    const result = parseBookingDetails("flight", { segments: [{ ...segment, originIata: "Seattle" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("segments.0.originIata: Use a 3-letter airport code");
      expect(result.issues.length).toBeGreaterThan(0);
    }
    for (const junk of [null, undefined, "flight", 42, [], [{ kind: "flight" }]]) {
      expect(parseBookingDetails("flight", junk), JSON.stringify(junk)).toMatchObject({ ok: false, error: "Booking details must be an object" });
    }
    expect(parseBookingDetails("boat" as never, {})).toMatchObject({ ok: false, error: "Unknown booking kind: boat" });
  });

  it("works for every kind", () => {
    for (const kind of BOOKING_KINDS) {
      const result = parseBookingDetails(kind, {});
      expect(result.ok, kind).toBe(true);
      if (result.ok) expect(result.details.kind).toBe(kind);
    }
  });
});

describe("shared booking shapes", () => {
  it("validates act-by dates", () => {
    expect(actBySchema.parse({})).toEqual({});
    expect(actBySchema.parse({ recommended: "2026-12-05", hard: "2026-12-12", opensOn: "2026-11-19" })).toEqual({ recommended: "2026-12-05", hard: "2026-12-12", opensOn: "2026-11-19" });
    expect(actBySchema.safeParse({ hard: "soon" }).success).toBe(false);
  });

  it("validates the list of things a hand-off could not prefill", () => {
    expect(unfilledListSchema.parse([{ label: "Child seat", value: "1 forward-facing" }])).toHaveLength(1);
    expect(unfilledListSchema.safeParse([{ label: "Child seat" }]).success).toBe(false);
  });

  it("validates lists of booking kinds", () => {
    expect(bookingKindListSchema.parse(["flight", "lodging", "car"])).toEqual(["flight", "lodging", "car"]);
    expect(bookingKindListSchema.safeParse(["flight", "flight"]).success).toBe(false);
    expect(bookingKindListSchema.safeParse(["cruise"]).success).toBe(false);
  });
});

describe("bookings that contradict themselves", () => {
  const leg = (from: string, to: string, departsAt: string, arrivesAt: string) => ({ ...segment, originIata: from, destinationIata: to, departsAt, arrivesAt });

  it("refuses a flight to the airport it left from", () => {
    expect(parseBookingDetails("flight", { segments: [leg("SEA", "SEA", "2026-12-19T16:10:00Z", "2026-12-19T21:35:00Z")] })).toMatchObject({
      ok: false,
      error: "segments.0.destinationIata: A flight lands at a different airport from the one it leaves",
    });
  });

  it("accepts flights out of order: the schedule points that out to the person, the schema does not refuse it", () => {
    // The connection leaves before the first flight has landed. detectConflicts (src/lib/itinerary)
    // reports it; code that reads segments must not assume they are in time order.
    const overlapping = parseBookingDetails("flight", {
      segments: [leg("SEA", "DEN", "2026-12-19T16:10:00Z", "2026-12-19T19:00:00Z"), leg("DEN", "MCO", "2026-12-19T18:30:00Z", "2026-12-19T22:00:00Z")],
    });
    expect(overlapping.ok).toBe(true);
  });

  it("refuses a search that comes back before it leaves, or goes nowhere", () => {
    expect(parseBookingDetails("flight", { search: { departDate: "2026-12-27", returnDate: "2026-12-19" } })).toMatchObject({ ok: false });
    expect(parseBookingDetails("flight", { search: { originIata: "SEA", destinationIata: "SEA" } })).toMatchObject({ ok: false });
    expect(parseBookingDetails("flight", { search: { departDate: "2026-12-19", returnDate: "2026-12-19", originIata: "SEA", destinationIata: "MCO" } }).ok).toBe(true);
  });

  it("refuses a parcel that ships after it should have arrived", () => {
    expect(parseBookingDetails("shipment", { shipByDate: "2026-12-18", targetDeliveryDate: "2026-12-16" })).toMatchObject({
      ok: false,
      error: "shipByDate: The ship-by date is on or before the day it should arrive",
    });
    expect(parseBookingDetails("shipment", { shipByDate: "2026-12-10", targetDeliveryDate: "2026-12-16" }).ok).toBe(true);
  });

  it("refuses a last possible day that comes before the recommended one", () => {
    expect(actBySchema.safeParse({ recommended: "2026-12-05", hard: "2026-11-28" }).success).toBe(false);
    expect(actBySchema.safeParse({ recommended: "2026-11-28", hard: "2026-11-28" }).success).toBe(true);
  });
});

describe("what a form sends for a field left empty", () => {
  it("is refused as it is, and accepted once the empty fields are dropped", () => {
    // formText() gives "" for an empty input, and an optional text field is not an empty one.
    const fromForm = { propertyName: "", contactName: "  ", accessNotes: "", checkInDate: "2026-12-19", rooms: [{ label: "Bunk room", personIds: [] }] };
    expect(parseBookingDetails("lodging", fromForm)).toMatchObject({ ok: false, error: expect.stringMatching(/^propertyName: /) });
    const cleaned = parseBookingDetails("lodging", withoutEmptyText(fromForm));
    expect(cleaned).toMatchObject({ ok: true, details: { kind: "lodging", checkInDate: "2026-12-19", rooms: [{ label: "Bunk room", personIds: [] }] } });
    if (cleaned.ok) expect(cleaned.details).not.toHaveProperty("propertyName");
  });

  it("drops empty text, null and undefined at every depth, and nothing else", () => {
    expect(
      withoutEmptyText({ a: "", b: " \n ", c: null, d: undefined, e: 0, f: false, g: "kept", h: { i: "", j: "in" }, k: [{ l: "", m: 1 }, "", "x"], n: [] }),
    ).toEqual({ e: 0, f: false, g: "kept", h: { j: "in" }, k: [{ m: 1 }, "", "x"], n: [] });
    const when = new Date("2026-12-19T00:00:00Z");
    expect(withoutEmptyText({ when })).toEqual({ when }); // not a plain object: left alone
    expect(withoutEmptyText("")).toBe("");
  });
});
