// The worked example of product spec 11.5, built by hand: the Hartley family Christmas, 23 days
// out. It must compute to exactly 68 with the breakdown the spec states, and the tests assert it.
//
// It is a plain function of "today" so it can also serve whoever seeds the example plan for a
// new account: every date is relative to the day given, so the plan always starts 23 days out.
// With today = 2026-11-26 the dates are the spec's own (Sat, Dec 19 to Sun, Dec 27, 2026).
//
// If these rows are ever inserted into a database: the ids here are fixed, readable strings and
// each household's guest token is a placeholder derived from its id. Give every row a fresh
// newId() (keeping the references between rows) and let the database make real guest tokens.
//
// The states the spec lists, and how each is represented here:
//   Getting there  9 of 9 seats booked, both ways     three round-trip flight bookings, six arrival rows
//   Stay           Lakeside house, 8 nights, all 9    one booked rental
//   Car            needs booking                      one car booking in "needed", past its holiday date
//   Rides          one airport pickup, planned        one planned ride meeting the Minneapolis flight
//   Food           2 deliveries scheduled; groceries planned, window not open
//   Send ahead     1 box in transit                   one shipment, its one parcel "shipped"
//   Who's coming   7 of 9 replied                     the Portland household has not answered
//   Schedule       2 of 5 key moments have a time and place
//   Share page     published
//   To-dos         2 of 5 essential done

import type { PlaceRef } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import {
  airport,
  at,
  makeArrival,
  makeBooking,
  makeExpense,
  makeItem,
  makeParty,
  makePerson,
  makePlan,
  makeSite,
  makeTask,
  seg,
  timedItem,
} from "@/lib/people/testing";
import { addDays, zonedToUtc, type LocalDate } from "@/lib/time";
import type { ReadinessConfig } from "./types";

/** The family-event column of product spec 11.2, with the holiday dates of 10.4 for this plan. */
export function hartleyConfig(today: LocalDate = "2026-11-26"): ReadinessConfig {
  const start = addDays(today, 23);
  return {
    weights: { gettingThere: 15, lodging: 15, car: 10, rides: 5, meals: 10, shipAhead: 5, people: 15, schedule: 10, site: 5, tasks: 10 },
    words: { person: "guest", people: "guests", party: "household", parties: "households", timeline: "Schedule" },
    holidayPeriod: true,
    actBy: {
      flight: { recommended: addDays(start, -60), hard: addDays(start, -21) },
      lodging: { recommended: addDays(start, -60), hard: addDays(start, -21) },
      car: { recommended: addDays(start, -45), hard: addDays(start, -14) },
    },
  };
}

export type HartleyExample = {
  data: PlanData;
  /** A moment on `today`, mid-morning in Seattle. */
  now: Date;
  /** The plan's first and last day. */
  start: LocalDate;
  end: LocalDate;
  ids: {
    seattle: string;
    portland: string;
    minneapolis: string;
    lydia: string;
    dana: string;
    chris: string;
    ruth: string;
    house: string;
    car: string;
    pickup: string;
    groceries: string;
    box: string;
  };
};

/** The example plan as plain rows. `today` is the local date in Seattle; the plan starts 23 days later. */
export function hartleyExample(today: LocalDate = "2026-11-26"): HartleyExample {
  const start = addDays(today, 23);
  const end = addDays(start, 8);
  const eastern = "America/New_York";
  const planId = "hartley";

  const seattleHome: PlaceRef = { kind: "home", name: "Seattle", tz: "America/Los_Angeles", countryCode: "US" };
  const orlando: PlaceRef = { kind: "city", name: "Orlando", tz: eastern, countryCode: "US", lat: 28.5384, lon: -81.3789 };
  const house: PlaceRef = {
    kind: "lodging",
    name: "Lakeside house",
    addressLines: ["4120 Lake Butler Blvd"],
    locality: "Windermere",
    region: "FL",
    postalCode: "34786",
    countryCode: "US",
    tz: eastern,
  };
  const mco = airport("MCO", "Orlando International");

  const plan = makePlan({
    id: planId,
    template: "family_event",
    title: "Hartley Family Christmas",
    destination: orlando,
    origin: seattleHome,
    startDate: start,
    endDate: end,
    dateStatus: "fixed",
    tz: eastern,
    expectedPeople: 9,
    budgetTotal: 700_000,
    replyDeadline: addDays(start, -21),
    kindsInUse: ["flight", "lodging", "car", "ride", "meal", "shipment"],
    isExample: true,
  });

  // --- who ---------------------------------------------------------------------------------------
  const seattle = makeParty(planId, "The Seattle Hartleys", { id: "hartley_seattle", origin: seattleHome, sortOrder: 0 });
  const portland = makeParty(planId, "The Portland Hartleys", {
    id: "hartley_portland",
    origin: { kind: "city", name: "Portland", tz: "America/Los_Angeles", countryCode: "US" },
    sortOrder: 1,
  });
  const minneapolis = makeParty(planId, "The Minneapolis Hartleys", {
    id: "hartley_minneapolis",
    origin: { kind: "city", name: "Minneapolis", tz: "America/Chicago", countryCode: "US" },
    sortOrder: 2,
  });

  const lydia = makePerson(seattle, "Lydia Hartley", { id: "hartley_lydia", role: "organizer", canDrive: true });
  const mark = makePerson(seattle, "Mark Hartley", { id: "hartley_mark", canDrive: true });
  const theo = makePerson(seattle, "Theo Hartley", { id: "hartley_theo", ageGroup: "child", childAge: 9 });
  const june = makePerson(seattle, "June Hartley", { id: "hartley_june", ageGroup: "child", childAge: 6, dietaryTags: ["nut_allergy"] });
  const dana = makePerson(portland, "Dana Hartley", { id: "hartley_dana", rsvpStatus: "invited" });
  const chris = makePerson(portland, "Chris Hartley", { id: "hartley_chris", rsvpStatus: "invited" });
  const ruth = makePerson(minneapolis, "Ruth Hartley", { id: "hartley_ruth", dietaryTags: ["vegetarian"] });
  const dale = makePerson(minneapolis, "Dale Hartley", { id: "hartley_dale", accessNote: "Ground-floor bedroom, please" });
  const rob = makePerson(minneapolis, "Rob Hartley", { id: "hartley_rob", canDrive: true });
  const people = [lydia, mark, theo, june, dana, chris, ruth, dale, rob];
  const ids = (list: { id: string }[]) => list.map((person) => person.id);
  const seattleIds = ids([lydia, mark, theo, june]);
  const portlandIds = ids([dana, chris]);
  const minneapolisIds = ids([ruth, dale, rob]);

  // --- flights: 9 of 9 seats, both ways ----------------------------------------------------------
  const day = (date: LocalDate, time: string) => `${date}T${time}`;
  const seattleFlights = makeBooking(
    planId,
    "flight",
    {
      tripType: "round_trip",
      cabin: "economy",
      segments: [
        seg("AS 1054", "SEA", day(start, "07:35"), "MCO", day(start, "16:10")),
        seg("AS 1055", "MCO", day(end, "17:30"), "SEA", day(end, "20:45")),
      ],
    },
    { id: "hartley_flight_seattle", title: "AS 1054 SEA to MCO", personIds: seattleIds, vendorName: "Alaska", confirmationCode: "KXHM4T", priceAmount: 148_640, priceCurrency: "USD" },
  );
  const portlandFlights = makeBooking(
    planId,
    "flight",
    {
      tripType: "round_trip",
      segments: [
        seg("AS 772", "PDX", day(start, "07:40"), "MCO", day(start, "15:55")),
        seg("AS 773", "MCO", day(end, "16:45"), "PDX", day(end, "19:50")),
      ],
    },
    { id: "hartley_flight_portland", title: "AS 772 PDX to MCO", personIds: portlandIds, vendorName: "Alaska", confirmationCode: "PQ7RWD" },
  );
  const minneapolisFlights = makeBooking(
    planId,
    "flight",
    {
      tripType: "round_trip",
      segments: [
        seg("DL 1420", "MSP", day(start, "10:05"), "MCO", day(start, "14:20")),
        seg("DL 1421", "MCO", day(end, "15:10"), "MSP", day(end, "17:40")),
      ],
    },
    { id: "hartley_flight_minneapolis", title: "DL 1420 MSP to MCO", personIds: minneapolisIds, vendorName: "Delta", confirmationCode: "H3LLQZ" },
  );

  // --- stay: Lakeside house, 8 nights, all 9 -----------------------------------------------------
  const stay = makeBooking(
    planId,
    "lodging",
    { lodgingType: "rental", propertyName: "Lakeside house", place: house, checkInDate: start, checkOutDate: end, accessNotes: "Door code 4471. Wi-Fi on the fridge." },
    { id: "hartley_house", title: "Lakeside house", personIds: ids(people), provider: "vrbo", confirmationCode: "HA-88213", priceAmount: 384_000, priceCurrency: "USD" },
  );

  // --- car: needs booking, past its holiday "book by" date ---------------------------------------
  const car = makeBooking(
    planId,
    "car",
    { vehicleClass: "minivan", seats: 7, pickupPlace: mco, returnPlace: mco },
    { id: "hartley_car", title: "Minivan", status: "needed", actBy: { recommended: addDays(start, -45), hard: addDays(start, -14) } },
  );

  // --- rides: one airport pickup, planned --------------------------------------------------------
  const pickup = makeBooking(
    planId,
    "ride",
    {
      rideType: "rideshare",
      fromPlace: mco,
      toPlace: house,
      pickupAt: at(day(start, "14:50"), eastern),
      passengerIds: minneapolisIds,
      bags: 4,
      arrivalIds: ["hartley_arrival_minneapolis"],
    },
    { id: "hartley_pickup", title: "Airport pickup", status: "planned", provider: "uber", personIds: minneapolisIds },
  );

  // --- food: two deliveries scheduled, groceries planned with the window not open yet --------------
  const welcomeDinner = makeBooking(
    planId,
    "meal",
    { mealType: "restaurant_delivery", vendorName: "Luigi's Kitchen", deliverToPlace: house, windowStart: at(day(start, "18:30"), eastern), windowEnd: at(day(start, "19:00"), eastern), headcount: 9, dietarySummary: "1 nut allergy, 1 vegetarian" },
    { id: "hartley_dinner", title: "Arrival night dinner", provider: "ubereats" },
  );
  const eve = addDays(start, 5);
  const eveDinner = makeBooking(
    planId,
    "meal",
    { mealType: "catering", vendorName: "Winter Park Catering", deliverToPlace: house, windowStart: at(day(eve, "17:00"), eastern), windowEnd: at(day(eve, "17:30"), eastern), headcount: 9 },
    { id: "hartley_eve_dinner", title: "Christmas Eve dinner", provider: "ezcater" },
  );
  const groceries = makeBooking(
    planId,
    "meal",
    { mealType: "groceries", deliverToPlace: house, windowStart: at(day(start, "17:00"), eastern), windowEnd: at(day(start, "18:00"), eastern), headcount: 9, orderOpensOn: addDays(start, -5) },
    { id: "hartley_groceries", title: "Groceries for the week", status: "planned", provider: "instacart", actBy: { opensOn: addDays(start, -5), recommended: addDays(start, -5), hard: addDays(start, -1) } },
  );

  // --- send ahead: one box in transit (product spec 15.1: a rental house gets it on Dec 21) -------
  const box = makeBooking(
    planId,
    "shipment",
    {
      shipmentKind: "box",
      destinationType: "vacation_rental",
      lodgingBookingId: stay.id,
      recipientName: "Lydia Hartley",
      propertyName: "Lakeside house",
      arrivalDate: start,
      serviceKey: "ups_ground",
      shipByDate: addDays(start, -9),
      targetDeliveryDate: addDays(start, 2),
      latestRiskyDate: addDays(start, -4),
      contents: [{ description: "Wrapped gifts", quantity: 12, flags: [] }],
      parcels: [{ trackingNumber: "1Z999AA10123456784", carrierDetected: "ups", status: "shipped" }],
    },
    { id: "hartley_box", title: "Box of gifts", provider: "ups" },
  );

  // --- arrivals: three households, both ways. Only the Minneapolis arrival needs a ride. -----------
  const arrivals = [
    makeArrival(seattle, "arrival", { id: "hartley_arrival_seattle", personIds: seattleIds, bookingId: seattleFlights.id, segmentIndex: 0, source: "booking", rideNeed: "rental_car", status: "scheduled" }),
    makeArrival(seattle, "departure", { id: "hartley_departure_seattle", personIds: seattleIds, bookingId: seattleFlights.id, segmentIndex: 1, source: "booking", rideNeed: "rental_car", status: "scheduled" }),
    makeArrival(portland, "arrival", { id: "hartley_arrival_portland", personIds: portlandIds, bookingId: portlandFlights.id, segmentIndex: 0, source: "booking", rideNeed: "rental_car", status: "scheduled" }),
    makeArrival(portland, "departure", { id: "hartley_departure_portland", personIds: portlandIds, bookingId: portlandFlights.id, segmentIndex: 1, source: "booking", rideNeed: "rental_car", status: "scheduled" }),
    makeArrival(minneapolis, "arrival", { id: "hartley_arrival_minneapolis", personIds: minneapolisIds, bookingId: minneapolisFlights.id, segmentIndex: 0, source: "booking", rideNeed: "rideshare", rideBookingId: pickup.id, bags: 4, status: "scheduled" }),
    makeArrival(minneapolis, "departure", { id: "hartley_departure_minneapolis", personIds: minneapolisIds, bookingId: minneapolisFlights.id, segmentIndex: 1, source: "booking", rideNeed: "rental_car", status: "scheduled" }),
  ];

  // --- schedule: five key moments, two with a time and a place -------------------------------------
  const items = [
    timedItem(planId, "Welcome dinner", day(start, "18:30"), day(start, "20:00"), { id: "hartley_item_welcome", place: house, isKeyMoment: true }),
    makeItem(planId, "Lake picnic", { id: "hartley_item_picnic", localDate: addDays(start, 1), startTz: eastern, isKeyMoment: true }),
    timedItem(planId, "Christmas Eve dinner", day(eve, "17:30"), null, { id: "hartley_item_eve", isKeyMoment: true }),
    timedItem(planId, "Christmas morning", day(addDays(start, 6), "08:00"), null, { id: "hartley_item_morning", place: house, isKeyMoment: true }),
    makeItem(planId, "Farewell brunch", { id: "hartley_item_brunch", localDate: end, startTz: eastern, place: house, isKeyMoment: true }),
  ];

  // --- to-dos: five essential, two done ------------------------------------------------------------
  const done = { done: true, doneAt: zonedToUtc(`${addDays(today, -3)}T10:00`, "America/Los_Angeles") };
  const tasks = [
    makeTask(planId, "Ask about dietary needs", { id: "hartley_task_dietary", essential: true, source: "template", ruleKey: "family.dietary", sortOrder: 0, ...done }),
    makeTask(planId, "Send the box of gifts", { id: "hartley_task_box", essential: true, bookingId: box.id, sortOrder: 1, ...done }),
    makeTask(planId, "Confirm who cooks what", { id: "hartley_task_cooks", essential: true, source: "template", ruleKey: "family.cooks", dueDate: addDays(start, -9), sortOrder: 2 }),
    makeTask(planId, "Arrange airport pickups", { id: "hartley_task_pickups", essential: true, source: "template", ruleKey: "family.pickups", dueDate: addDays(start, -7), sortOrder: 3 }),
    makeTask(planId, "Hold the mail", { id: "hartley_task_mail", essential: true, source: "template", ruleKey: "family.mail", dueDate: addDays(start, -3), sortOrder: 4 }),
    makeTask(planId, "Swimsuits", { id: "hartley_task_swimsuits", kind: "packing", sortOrder: 5 }),
    makeTask(planId, "A side dish for Christmas Eve", { id: "hartley_task_side", kind: "bring", quantity: 2, sortOrder: 6 }),
  ];

  // --- money: $4,280 so far ------------------------------------------------------------------------
  const everyone = ids(people).map((personId) => ({ personId }));
  const paidOn = addDays(today, -20);
  const expenses = [
    makeExpense(planId, "Alaska Airlines", 148_640, { id: "hartley_exp_flights_sea", date: paidOn, category: "airfare", paidByPersonId: lydia.id, bookingId: seattleFlights.id }),
    makeExpense(planId, "Alaska Airlines", 61_200, { id: "hartley_exp_flights_pdx", date: paidOn, category: "airfare", paidByPersonId: dana.id, bookingId: portlandFlights.id }),
    makeExpense(planId, "Delta Air Lines", 74_460, { id: "hartley_exp_flights_msp", date: paidOn, category: "airfare", paidByPersonId: ruth.id, bookingId: minneapolisFlights.id }),
    makeExpense(planId, "Lakeside house", 128_000, { id: "hartley_exp_house", date: paidOn, description: "Deposit", category: "lodging", paidByPersonId: lydia.id, bookingId: stay.id, split: { method: "by_party", parts: everyone } }),
    makeExpense(planId, "UPS", 5_700, { id: "hartley_exp_ups", date: addDays(today, -2), category: "shipping", paidByPersonId: lydia.id, bookingId: box.id }),
    makeExpense(planId, "Winter Park Catering", 10_000, { id: "hartley_exp_catering", date: addDays(today, -6), description: "Deposit", category: "meals", paidByPersonId: ruth.id, bookingId: eveDinner.id, split: { method: "by_party", parts: everyone } }),
    makeExpense(planId, "Lakeside house", 256_000, { id: "hartley_exp_house_balance", date: start, description: "Balance due at check-in", category: "lodging", status: "planned", bookingId: stay.id, split: { method: "by_party", parts: everyone } }),
  ];

  const site = makeSite(planId, {
    id: "hartley_site",
    slug: "hartley-christmas",
    status: "published",
    title: "Hartley Family Christmas",
    replyDeadline: addDays(start, -21),
    publishedAt: zonedToUtc(`${addDays(today, -10)}T09:00`, "America/Los_Angeles"),
  });

  return {
    data: {
      plan,
      parties: [seattle, portland, minneapolis],
      people,
      arrivals,
      bookings: [seattleFlights, portlandFlights, minneapolisFlights, stay, car, pickup, welcomeDinner, eveDinner, groceries, box],
      handoffs: [],
      items,
      tasks,
      expenses,
      settlements: [],
      site,
    },
    now: zonedToUtc(`${today}T09:30`, "America/Los_Angeles"),
    start,
    end,
    ids: {
      seattle: seattle.id,
      portland: portland.id,
      minneapolis: minneapolis.id,
      lydia: lydia.id,
      dana: dana.id,
      chris: chris.id,
      ruth: ruth.id,
      house: stay.id,
      car: car.id,
      pickup: pickup.id,
      groceries: groceries.id,
      box: box.id,
    },
  };
}
