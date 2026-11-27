import { describe, expect, it } from "vitest";
import type { PlaceRef } from "@/lib/domain";
import { airport, at, makeBooking, makeItem, makeParty, makePerson, makePlan, makePlanData, seg, timedItem } from "@/lib/people/testing";
import { zonedToUtc } from "@/lib/time";
import { groupByDay } from "./days";
import { deriveItinerary, timelineFor, timelineForPeople, upcomingItems } from "./derive";

const NY = "America/New_York";
const house: PlaceRef = { kind: "lodging", name: "Lakeside house", tz: NY, locality: "Windermere" };

function family() {
  const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
  const party = makeParty(plan.id, "The Seattle Hartleys");
  const lydia = makePerson(party, "Lydia Hartley");
  const mark = makePerson(party, "Mark Hartley");
  return { plan, party, lydia, mark, people: [lydia, mark], ids: [lydia.id, mark.id] };
}

describe("items that come from bookings", () => {
  const { plan, party, lydia, mark, people, ids } = family();
  const flight = makeBooking(
    plan.id,
    "flight",
    { tripType: "round_trip", segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"), seg("AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45")] },
    { personIds: ids, confirmationCode: "KXHM4T", priceAmount: 148_640, priceCurrency: "USD", notes: "Seats together" },
  );
  const stay = makeBooking(
    plan.id,
    "lodging",
    { lodgingType: "rental", propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27", accessNotes: "Door code 4471" },
    { confirmationCode: "HA-88213" },
  );
  const car = makeBooking(
    plan.id,
    "car",
    { company: "Hertz", vehicleClass: "minivan", seats: 7, pickupPlace: airport("MCO"), pickupAt: at("2026-12-19T16:55", NY), returnAt: at("2026-12-27T15:00", NY), driverPersonIds: [mark.id] },
  );
  const ride = makeBooking(
    plan.id,
    "ride",
    { rideType: "rideshare", fromPlace: airport("MCO"), toPlace: house, pickupAt: at("2026-12-19T16:40", NY), passengerIds: [lydia.id] },
    { status: "planned", provider: "uber" },
  );
  const dinner = makeBooking(
    plan.id,
    "meal",
    { mealType: "restaurant_delivery", vendorName: "Luigi's Kitchen", deliverToPlace: house, windowStart: at("2026-12-19T18:30", NY), windowEnd: at("2026-12-19T19:00", NY), headcount: 9, orderNumber: "UE-5512", total: { amount: 18_420, currency: "USD" } },
  );
  const box = makeBooking(
    plan.id,
    "shipment",
    { shipmentKind: "box", shipByDate: "2026-12-10", targetDeliveryDate: "2026-12-21", parcels: [{ status: "packed" }, { status: "planned" }] },
    { status: "planned" },
  );
  const data = makePlanData({ plan, parties: [party], people, bookings: [flight, stay, car, ride, dinner, box] });
  const timeline = deriveItinerary(data);
  const byKey = (suffix: string) => timeline.find((item) => item.key.endsWith(suffix))!;

  it("makes one item per flight segment, each end in its own airport's time", () => {
    const out = byKey(`${flight.id}:segment:0`);
    expect(out).toMatchObject({
      type: "flight",
      title: "Flight AS 1054, SEA to MCO",
      detail: "5 hours 35 minutes in the air.",
      localDate: "2026-12-19",
      tz: "America/Los_Angeles",
      bookingId: flight.id,
      itemId: null,
      segmentIndex: 0,
      personIds: ids,
      everyone: false,
      status: "confirmed",
      bookingStatus: "booked",
      flight: { designator: "AS 1054", originIata: "SEA", destinationIata: "MCO", durationMinutes: 335, dayShift: 0, expectedArrival: null },
    });
    expect(out.start).toEqual(at("2026-12-19T07:35", "America/Los_Angeles"));
    expect(out.end).toEqual(at("2026-12-19T16:10", NY));
    expect(out.place).toEqual({ kind: "airport", name: "SEA", iata: "SEA", tz: "America/Los_Angeles" });
    expect(out.endPlace?.iata).toBe("MCO");
    expect(byKey(`${flight.id}:segment:1`).localDate).toBe("2026-12-27");
  });

  it("makes check-in and check-out from the stay's dates and times", () => {
    expect(byKey(":check_in")).toMatchObject({ type: "check_in", title: "Check in at Lakeside house", detail: "8 nights.", localDate: "2026-12-19", everyone: true, personIds: [] });
    expect(byKey(":check_in").start).toEqual(at("2026-12-19T16:00", NY));
    expect(byKey(":check_out")).toMatchObject({ type: "check_out", title: "Check out of Lakeside house", localDate: "2026-12-27" });
    expect(byKey(":check_out").start).toEqual(at("2026-12-27T11:00", NY));
    expect(byKey(":check_out").end).toBeNull();
  });

  it("makes the car's pickup and return, the ride, the food and the send-by date", () => {
    expect(byKey(":car_pickup")).toMatchObject({ type: "car_pickup", title: "Pick up the minivan at MCO", detail: "Hertz.", personIds: [mark.id] });
    expect(byKey(":car_return")).toMatchObject({ type: "car_return", title: "Return the minivan at MCO", localDate: "2026-12-27" });
    expect(byKey(":ride")).toMatchObject({ type: "ride", title: "Ride from MCO to Lakeside house", detail: "Uber.", status: "tentative", bookingStatus: "planned", personIds: [lydia.id] });
    expect(byKey(":meal")).toMatchObject({ type: "meal", title: "Food from Luigi's Kitchen", detail: "For 9 people." });
    expect(byKey(":meal").end).toEqual(at("2026-12-19T19:00", NY));
    expect(byKey(":ship_by")).toMatchObject({
      type: "shipment_due",
      title: "Send 2 boxes by today",
      detail: "So it arrives by Mon, Dec 21.",
      localDate: "2026-12-10",
      allDay: true,
      start: null,
      tz: "America/Los_Angeles", // sent from home
    });
  });

  it("sorts by day, then all-day, then by the instant things happen", () => {
    expect(timeline.map((item) => `${item.localDate} ${item.title}`)).toEqual([
      "2026-12-10 Send 2 boxes by today",
      "2026-12-19 Flight AS 1054, SEA to MCO",
      "2026-12-19 Check in at Lakeside house",
      "2026-12-19 Ride from MCO to Lakeside house",
      "2026-12-19 Pick up the minivan at MCO",
      "2026-12-19 Food from Luigi's Kitchen",
      "2026-12-27 Check out of Lakeside house",
      "2026-12-27 Return the minivan at MCO",
      "2026-12-27 Flight AS 1055, MCO to SEA",
    ]);
  });

  it("marks everything from a booking private, and never copies a private detail onto an item", () => {
    expect(timeline.every((item) => item.visibility === "private")).toBe(true);
    expect(timelineFor(timeline, "guests")).toEqual([]);
    expect(timelineFor(timeline, "public")).toEqual([]);
    expect(timelineFor(timeline, "organizer")).toHaveLength(timeline.length);
    const text = JSON.stringify(timeline);
    for (const secret of ["KXHM4T", "HA-88213", "4471", "UE-5512", "18420", "148640", "Seats together"]) expect(text).not.toContain(secret);
  });

  it("uses city names in flight titles when it is given a way to look them up", () => {
    const cities: Record<string, string> = { SEA: "Seattle", MCO: "Orlando" };
    const named = deriveItinerary(data, { airportCity: (iata) => cities[iata] });
    expect(named.find((item) => item.type === "flight")).toMatchObject({ title: "Flight AS 1054, Seattle to Orlando", place: { name: "Seattle (SEA)", locality: "Seattle" } });
  });
});

describe("which bookings appear", () => {
  const { plan, party, people } = family();
  const stayWith = (status: "needed" | "planned" | "looking" | "booked" | "done" | "cancelled" | "not_needed") =>
    deriveItinerary(makePlanData({ plan, parties: [party], people, bookings: [makeBooking(plan.id, "lodging", { propertyName: "Hotel Ella", checkInDate: "2026-12-19", checkOutDate: "2026-12-20" }, { status })] }));

  it("shows planned and still-looking bookings as tentative, booked and done ones as confirmed", () => {
    expect(stayWith("planned").map((item) => item.status)).toEqual(["tentative", "tentative"]);
    expect(stayWith("looking")[0].status).toBe("tentative");
    expect(stayWith("booked")[0].status).toBe("confirmed");
    expect(stayWith("done")[0].status).toBe("confirmed");
  });

  it("shows nothing for a booking that is only needed, cancelled or not needed", () => {
    expect(stayWith("needed")).toEqual([]);
    expect(stayWith("cancelled")).toEqual([]);
    expect(stayWith("not_needed")).toEqual([]);
  });

  it("shows nothing for bookings with no times yet", () => {
    const empty = [
      makeBooking(plan.id, "flight", {}, { status: "planned" }),
      makeBooking(plan.id, "lodging", {}),
      makeBooking(plan.id, "car", {}),
      makeBooking(plan.id, "ride", {}),
      makeBooking(plan.id, "meal", {}),
      makeBooking(plan.id, "shipment", {}),
    ];
    expect(deriveItinerary(makePlanData({ plan, bookings: empty }))).toEqual([]);
  });

  it("words stays with family, drivers, groceries, catering and return shipments", () => {
    const rob = makePerson(party, "Rob Hartley");
    const bookings = [
      makeBooking(plan.id, "lodging", { lodgingType: "family_home", propertyName: "Grandma's", checkInDate: "2026-12-19", checkOutDate: "2026-12-20" }),
      makeBooking(plan.id, "ride", { rideType: "personal_pickup", driverPersonId: rob.id, fromPlace: airport("MCO"), pickupAt: at("2026-12-19T16:40", NY) }),
      makeBooking(plan.id, "ride", { rideType: "shuttle", toPlace: airport("MCO"), pickupAt: at("2026-12-20T09:00", NY) }),
      makeBooking(plan.id, "meal", { mealType: "groceries", windowStart: at("2026-12-19T17:00", NY) }),
      makeBooking(plan.id, "meal", { mealType: "catering", vendorName: "Winter Park Catering", windowStart: at("2026-12-19T12:00", NY) }),
      makeBooking(plan.id, "shipment", { shipmentKind: "luggage", direction: "return", shipByDate: "2026-12-20", parcels: [{ status: "planned" }] }),
      makeBooking(plan.id, "car", { vehicleClass: "suv", pickupAt: at("2026-12-19T15:00", NY) }),
    ];
    const titles = deriveItinerary(makePlanData({ plan, parties: [party], people: [...people, rob], bookings })).map((item) => item.title);
    expect(titles).toEqual([
      "Catering from Winter Park Catering",
      "Pick up the SUV",
      "Arrive at Grandma's",
      "Rob drives from MCO",
      "Groceries delivered",
      "Send the luggage home by today",
      "Shuttle to MCO",
      "Leave Grandma's",
    ]);
  });

  it("drops the send-by item once every parcel is on its way", () => {
    const shipped = makeBooking(plan.id, "shipment", { shipByDate: "2026-12-10", parcels: [{ status: "shipped" }, { status: "delivered" }] });
    const partly = makeBooking(plan.id, "shipment", { shipmentKind: "gift", shipByDate: "2026-12-10", parcels: [{ status: "shipped" }, { status: "packed" }] });
    const titles = deriveItinerary(makePlanData({ plan, bookings: [shipped, partly] })).map((item) => item.title);
    expect(titles).toEqual(["Send 2 boxes of gifts by today"]);
  });
});

describe("hand-made items", () => {
  const { plan, party, people, lydia } = family();
  const items = [
    timedItem(plan.id, "Welcome dinner", "2026-12-19T18:30", "2026-12-19T20:00", { place: house, isKeyMoment: true, visibility: "public", description: "Bring an appetite", link: "https://example.com/menu" }),
    makeItem(plan.id, "Lake picnic", { localDate: "2026-12-20", visibility: "guests" }),
    makeItem(plan.id, "Christmas Day", { localDate: "2026-12-25", allDay: true, visibility: "public" }),
    timedItem(plan.id, "Wrap the surprise gift", "2026-12-24T21:00", null, { visibility: "private", personIds: [lydia.id], type: "note" }),
    timedItem(plan.id, "Tree lighting", "2026-12-20T17:00", null, { status: "cancelled", visibility: "public" }),
  ];
  const timeline = deriveItinerary(makePlanData({ plan, parties: [party], people, items }));

  it("carries each item through with its own times, place, people and visibility", () => {
    const dinner = timeline.find((item) => item.title === "Welcome dinner")!;
    expect(dinner).toMatchObject({
      key: `item:${items[0].id}`,
      type: "event",
      itemId: items[0].id,
      bookingId: null,
      localDate: "2026-12-19",
      everyone: true,
      isKeyMoment: true,
      visibility: "public",
      status: "confirmed",
      bookingStatus: null,
      description: "Bring an appetite",
      link: "https://example.com/menu",
      place: house,
    });
    expect(dinner.start).toEqual(at("2026-12-19T18:30", NY));
    expect(dinner.end).toEqual(at("2026-12-19T20:00", NY));
    expect(timeline.find((item) => item.title === "Wrap the surprise gift")).toMatchObject({ everyone: false, personIds: [lydia.id], type: "note" });
  });

  it("puts all-day items first on their day and items with no time last", () => {
    const sameDay = [
      makeItem(plan.id, "No time yet", { localDate: "2026-12-21" }),
      timedItem(plan.id, "Lunch", "2026-12-21T12:00", null),
      makeItem(plan.id, "Winter solstice", { localDate: "2026-12-21", allDay: true }),
      timedItem(plan.id, "Breakfast", "2026-12-21T08:00", null),
    ];
    expect(deriveItinerary(makePlanData({ plan, items: sameDay })).map((item) => item.title)).toEqual(["Winter solstice", "Breakfast", "Lunch", "No time yet"]);
  });

  it("never shows a private item to guests or the public", () => {
    expect(timelineFor(timeline, "public").map((item) => item.title)).toEqual(["Welcome dinner", "Tree lighting", "Christmas Day"]);
    expect(timelineFor(timeline, "guests").map((item) => item.title)).toEqual(["Welcome dinner", "Tree lighting", "Lake picnic", "Christmas Day"]);
    expect(timelineFor(timeline, "organizer")).toHaveLength(5);
    expect(timelineFor(timeline, "guests").some((item) => item.visibility === "private")).toBe(false);
  });

  it("keeps a cancelled item in the list, marked, and out of what is coming up", () => {
    expect(timeline.find((item) => item.title === "Tree lighting")?.status).toBe("cancelled");
    const next = upcomingItems(timeline, zonedToUtc("2026-12-19T19:00", NY), 5).map((item) => item.title);
    expect(next).toEqual(["Wrap the surprise gift"]);
  });

  it("finds the items that involve someone", () => {
    const mark = people[1];
    expect(timelineForPeople(timeline, [mark.id]).map((item) => item.title)).not.toContain("Wrap the surprise gift");
    expect(timelineForPeople(timeline, [lydia.id]).map((item) => item.title)).toContain("Wrap the surprise gift");
  });
});

describe("grouped by day", () => {
  it("announces the change of clocks on the first row after landing, and says how far from home", () => {
    const { plan, party, people, ids } = family();
    const flight = makeBooking(plan.id, "flight", { segments: [seg("AS 1054", "SEA", "2026-12-19T07:35", "MCO", "2026-12-19T16:10"), seg("AS 1055", "MCO", "2026-12-27T17:30", "SEA", "2026-12-27T20:45")] }, { personIds: ids });
    const stay = makeBooking(plan.id, "lodging", { propertyName: "Lakeside house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27" });
    const items = [
      timedItem(plan.id, "Drop the dog at the sitter", "2026-12-18T18:00", null, { startTz: "America/Los_Angeles" }),
      timedItem(plan.id, "Welcome dinner", "2026-12-19T18:30", "2026-12-19T20:00", { place: house }),
      makeItem(plan.id, "Lake picnic", { localDate: "2026-12-20" }),
      timedItem(plan.id, "Unpack", "2026-12-27T21:30", null, { startTz: "America/Los_Angeles" }),
    ];
    const days = groupByDay(deriveItinerary(makePlanData({ plan, parties: [party], people, bookings: [flight, stay], items })), plan);

    expect(days.map((day) => [day.date, day.label, day.dayNumber])).toEqual([
      ["2026-12-18", "Fri, Dec 18", null], // a travel day before the plan starts
      ["2026-12-19", "Sat, Dec 19", 1],
      ["2026-12-20", "Sun, Dec 20", 2],
      ["2026-12-27", "Sun, Dec 27", 9],
    ]);
    const rows = days.flatMap((day) => day.entries.map((entry) => [entry.timeText, entry.title, entry.zoneChange?.text ?? null, entry.endNote]));
    expect(rows).toEqual([
      ["6:00 PM", "Drop the dog at the sitter", null, null],
      ["7:35 AM – 4:10 PM", "Flight AS 1054, SEA to MCO", null, "Orlando time"],
      ["4:00 PM", "Check in at Lakeside house", "Orlando time from here", null],
      ["6:30 PM – 8:00 PM", "Welcome dinner", null, null],
      [null, "Lake picnic", null, null],
      ["11:00 AM", "Check out of Lakeside house", null, null],
      ["5:30 PM – 8:45 PM", "Flight AS 1055, MCO to SEA", null, "Seattle time"],
      ["9:30 PM", "Unpack", "Seattle time from here", null],
    ]);
    const change = days[1].entries[1].zoneChange!;
    expect(change).toEqual({ tz: NY, placeName: "Orlando", text: "Orlando time from here", detail: "3 hours ahead of Seattle", minutesFromHome: 180 });
    expect(days[3].entries[2].zoneChange).toMatchObject({ placeName: "Seattle", detail: null, minutesFromHome: 0 });
    expect(days[2].entries[0].section).toBe("unscheduled");
  });

  it("says nothing about clocks when the trip never leaves home time", () => {
    const plan = makePlan({ destination: { kind: "city", name: "Portland", tz: "America/Los_Angeles" }, tz: "America/Los_Angeles", startDate: "2026-12-19", endDate: "2026-12-20" });
    const items = [timedItem(plan.id, "Lunch", "2026-12-19T12:00", null, { startTz: "America/Los_Angeles" }), timedItem(plan.id, "Call Tijuana", "2026-12-19T15:00", null, { startTz: "America/Tijuana" })];
    const days = groupByDay(deriveItinerary(makePlanData({ plan, items })), plan);
    expect(days[0].entries.every((entry) => entry.zoneChange === null)).toBe(true);
  });

  it("gives a red-eye a second row on the day it lands", () => {
    const { plan, party, people, ids } = family();
    const redEye = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("AS 20", "SEA", "2026-12-18T22:15", "MCO", "2026-12-19T06:40")] }, { personIds: ids });
    const breakfast = timedItem(plan.id, "Breakfast at the house", "2026-12-19T09:00", null, { place: house });
    const timeline = deriveItinerary(makePlanData({ plan, parties: [party], people, bookings: [redEye], items: [breakfast] }));
    expect(timeline[0]).toMatchObject({ localDate: "2026-12-18", detail: "5 hours 25 minutes in the air. Lands the next day.", flight: { dayShift: 1 } });

    const days = groupByDay(timeline, plan);
    expect(days.map((day) => day.entries.map((entry) => [entry.part, entry.timeText, entry.title, entry.endNote, entry.zoneChange?.text ?? null]))).toEqual([
      [["item", "10:15 PM – 6:40 AM", "Flight AS 20, SEA to MCO", "Orlando time, the next day", null]],
      [
        ["landing", "6:40 AM", "AS 20 lands at MCO", null, "Orlando time from here"],
        ["item", "9:00 AM", "Breakfast at the house", null, null],
      ],
    ]);
    expect(days[1].entries[0].key).toBe(`${timeline[0].key}:landing`);
  });

  it("follows a trip over the date line in both directions", () => {
    const sydney: PlaceRef = { kind: "city", name: "Sydney", tz: "Australia/Sydney" };
    const la: PlaceRef = { kind: "home", name: "Los Angeles", tz: "America/Los_Angeles" };
    const plan = makePlan({ destination: sydney, origin: la, tz: sydney.tz, startDate: "2027-01-12", endDate: "2027-01-20" });
    const flights = makeBooking(plan.id, "flight", {
      tripType: "round_trip",
      segments: [seg("QF 12", "LAX", "2027-01-10T22:30", "SYD", "2027-01-12T08:15"), seg("QF 11", "SYD", "2027-01-20T11:50", "LAX", "2027-01-20T06:10")],
    });
    const timeline = deriveItinerary(makePlanData({ plan, bookings: [flights] }));
    expect(timeline.map((item) => [item.localDate, item.flight?.dayShift, item.detail])).toEqual([
      ["2027-01-10", 2, "14 hours 45 minutes in the air. Lands 2 days later."],
      ["2027-01-20", 0, "13 hours 20 minutes in the air."],
    ]);
    const days = groupByDay(timeline, plan);
    expect(days.map((day) => day.date)).toEqual(["2027-01-10", "2027-01-12", "2027-01-20"]);
    expect(days[1].entries[0]).toMatchObject({ part: "landing", timeText: "8:15 AM", zoneChange: { text: "Sydney time from here", detail: "19 hours ahead of Los Angeles" } });
    // Home the same calendar morning they left: landing is "earlier" on the clock, never on the timeline.
    expect(days[2].entries[0]).toMatchObject({ timeText: "11:50 AM – 6:10 AM", endNote: "Los Angeles time" });

    // Tokyo to Honolulu lands on the calendar day before it leaves.
    const hop = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("HA 822", "NRT", "2027-01-05T20:00", "HNL", "2027-01-05T07:50")] });
    const [east] = deriveItinerary(makePlanData({ plan, bookings: [hop] }));
    expect(east.localDate).toBe("2027-01-05");
    expect(east.flight?.dayShift).toBe(0);
    const overMidnight = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("HA 458", "NRT", "2027-01-06T00:30", "HNL", "2027-01-05T12:20")] });
    const [dayBefore] = deriveItinerary(makePlanData({ plan, bookings: [overMidnight] }));
    expect(dayBefore).toMatchObject({ localDate: "2027-01-06", detail: "6 hours 50 minutes in the air. Lands the day before on the calendar.", flight: { dayShift: -1 } });
    const grouped = groupByDay([dayBefore], plan);
    expect(grouped.map((day) => day.date)).toEqual(["2027-01-05", "2027-01-06"]);
    expect(grouped[1].entries[0].endNote).toBe("Honolulu time, the day before on the calendar");
  });

  it("can fill in the empty days of the plan for a day strip", () => {
    const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-22" });
    const days = groupByDay(deriveItinerary(makePlanData({ plan, items: [timedItem(plan.id, "Lunch", "2026-12-20T12:00", null)] })), plan, { includeEmptyDays: true });
    expect(days.map((day) => [day.date, day.dayNumber, day.entries.length])).toEqual([
      ["2026-12-19", 1, 0],
      ["2026-12-20", 2, 1],
      ["2026-12-21", 3, 0],
      ["2026-12-22", 4, 0],
    ]);
    expect(groupByDay([], plan)).toEqual([]);
  });

  it("works for a plan with no dates, and writes times the way the person chose", () => {
    const plan = makePlan();
    const timeline = deriveItinerary(makePlanData({ plan, items: [timedItem(plan.id, "Lunch", "2026-12-20T12:05", "2026-12-20T13:00")] }));
    expect(groupByDay(timeline, plan)[0]).toMatchObject({ dayNumber: null, label: "Sun, Dec 20" });
    expect(groupByDay(timeline, plan, { includeEmptyDays: true })).toHaveLength(1);
    expect(groupByDay(timeline, plan, { wording: { style: "24h", militaryStyle: "14:41" } })[0].entries[0].timeText).toBe("12:05 – 13:00");
    expect(deriveItinerary(makePlanData())).toEqual([]);
  });
});
