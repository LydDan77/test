// The example plan every new account starts with: "Hartley Family Christmas".
//
// Product spec 11.5 states it and BUILD-SPEC section 3 item 7 fixes it: nine people in three
// households flying in from three cities, flights booked for all nine, a lakeside house for
// eight nights, the rental car still needing booking, one airport pickup planned, two food
// deliveries set and a grocery order planned (its order window not open yet), one box sent
// ahead and on its way, seven of nine replied, five key moments of which two have a time and a
// place, a published share page, five essential tasks with two done, and a few expenses.
// With the family weights of product spec 11.2 that is 68 points out of 100.
//
// Corrections of product spec 15.1: the box goes to a rental house, so it is due on the first
// delivery day on or after check-in (not three days before, which is the hotel rule), and the
// host's answer is on record.
//
// Everything is fiction: the people, the address, the codes, the flight numbers.
// Dates hang off the day the account is created, so the plan always starts 23 days out.
//
// This file only builds rows (pure, no database); seed.ts writes them.

import type {
  NewArrival,
  NewBooking,
  NewExpense,
  NewItineraryItem,
  NewParty,
  NewPerson,
  NewPlan,
  NewSite,
  NewTask,
} from "@/db/schema";
import {
  parseBookingDetails,
  type BookingKind,
  type ExpenseSplit,
  type FlightSegment,
  type PlaceRef,
  type RsvpQuestion,
  type SiteSection,
} from "@/lib/domain";
import { newId } from "@/lib/ids";
import { templateConfig } from "@/lib/templates";
import { addBusinessDays, addDays, localDateOf, nextBusinessDay, parseLocalDate, zonedToUtc } from "@/lib/time";

export const EXAMPLE_TITLE = "Hartley Family Christmas";
/** The page's address; the first account gets it as is, later ones with a short tail. */
export const EXAMPLE_SLUG = "hartley-christmas";
export const EXAMPLE_DAYS_OUT = 23;
export const EXAMPLE_NIGHTS = 8;

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";

const ORLANDO: PlaceRef = { kind: "city", name: "Orlando", region: "Florida", countryCode: "US", lat: 28.53834, lon: -81.37924, tz: ET };
const MINNEAPOLIS: PlaceRef = { kind: "city", name: "Minneapolis", region: "Minnesota", countryCode: "US", lat: 44.97997, lon: -93.26384, tz: CT };
const SEATTLE: PlaceRef = { kind: "city", name: "Seattle", region: "Washington", countryCode: "US", lat: 47.60621, lon: -122.33207, tz: PT };
const PORTLAND: PlaceRef = { kind: "city", name: "Portland", region: "Oregon", countryCode: "US", lat: 45.52345, lon: -122.67621, tz: PT };
const MCO: PlaceRef = {
  kind: "airport",
  name: "Orlando International Airport",
  locality: "Orlando",
  region: "Florida",
  countryCode: "US",
  lat: 28.4322,
  lon: -81.3083,
  tz: ET,
  iata: "MCO",
};
/** The house with its street address: private, for the stay and for rides and deliveries. */
const HOUSE: PlaceRef = {
  kind: "lodging",
  name: "Lakeside house",
  addressLines: ["418 Lakeshore Loop"],
  locality: "Windermere",
  region: "Florida",
  postalCode: "34786",
  countryCode: "US",
  lat: 28.4955,
  lon: -81.5348,
  tz: ET,
};
/** The house as the schedule names it: no street, no coordinates, so a public item gives nothing away. */
const HOUSE_PUBLIC: PlaceRef = { kind: "lodging", name: "Lakeside house", locality: "Windermere", region: "Florida", countryCode: "US", tz: ET };

export type ExamplePlanRows = {
  plan: NewPlan & { id: string };
  parties: NewParty[];
  people: NewPerson[];
  /** Insert first without `expenseId`; set it once the expenses exist (see `bookingExpenses`). */
  bookings: NewBooking[];
  /** booking id to expense id, for bookings.expenseId. */
  bookingExpenses: { bookingId: string; expenseId: string }[];
  /** person id to lodging booking id and room, for people.lodgingBookingId. */
  rooms: { personId: string; lodgingBookingId: string; room: string }[];
  arrivals: NewArrival[];
  items: NewItineraryItem[];
  tasks: NewTask[];
  expenses: NewExpense[];
  site: NewSite;
};

/** The fixed-date days carriers do not deliver: enough to keep the example's box off Christmas Day. */
function isFixedHoliday(date: string): boolean {
  const { month, day } = parseLocalDate(date);
  return (month === 12 && day === 25) || (month === 1 && day === 1) || (month === 7 && day === 4);
}

function details<K extends BookingKind>(kind: K, input: Record<string, unknown>) {
  const parsed = parseBookingDetails(kind, input);
  if (!parsed.ok) throw new Error(`Example plan: bad ${kind} details (${parsed.error})`);
  return parsed.details;
}

/**
 * All the rows of the example plan for one account.
 *
 * `now` is when the account was made. The plan starts 23 days after today at its own place
 * (Orlando), which is the day every countdown counts from: daysUntil(startDate, plan.tz, now)
 * is exactly 23.
 */
export function buildExamplePlan(input: { ownerId: string; slug: string; now: Date }): ExamplePlanRows {
  const { ownerId, slug, now } = input;
  const today = localDateOf(now, ET);
  const first = addDays(today, EXAMPLE_DAYS_OUT);
  const last = addDays(first, EXAMPLE_NIGHTS);

  /** The local date `offset` days into the plan (0 is arrival day). */
  const day = (offset: number) => addDays(first, offset);
  /** The instant the clocks in `tz` read `time` on day `offset`. */
  const at = (offset: number, time: string, tz: string) => zonedToUtc(`${day(offset)}T${time}`, tz);
  const iso = (offset: number, time: string, tz: string) => at(offset, time, tz).toISOString();
  /** The local date `days` before the account was made (when things were booked or answered). */
  const agoDate = (days: number) => addDays(today, -days);
  /** Midday on that date: an instant that is always in the past for one day ago or more. */
  const ago = (days: number) => zonedToUtc(`${agoDate(days)}T12:00`, ET);

  const planId = newId();

  // --- who --------------------------------------------------------------------------------------
  const party = { minneapolis: newId(), seattle: newId(), portland: newId() };
  const p = {
    lydia: newId(), rob: newId(), theo: newId(), june: newId(), wes: newId(),
    ruth: newId(), walt: newId(),
    dana: newId(), chris: newId(),
  };
  const hosts = [p.lydia, p.rob, p.theo, p.june, p.wes];
  const seattle = [p.ruth, p.walt];
  const portland = [p.dana, p.chris];
  const everyone = [...hosts, ...seattle, ...portland];

  const parties: NewParty[] = [
    { id: party.minneapolis, planId, name: "The Minneapolis Hartleys", origin: MINNEAPOLIS, sortOrder: 0 },
    { id: party.seattle, planId, name: "The Seattle Hartleys", origin: SEATTLE, sortOrder: 1 },
    { id: party.portland, planId, name: "Dana and Chris", origin: PORTLAND, notes: "Dana said yes in the family chat but has not replied on the page yet.", sortOrder: 2 },
  ];

  // --- the share page's questions (answers are keyed by these ids) ------------------------------
  const template = templateConfig({ template: "family_event", expectedPeople: 9, startDate: first, endDate: last, destination: ORLANDO, origin: MINNEAPOLIS });
  const rsvpQuestions: RsvpQuestion[] = template.site.rsvpQuestions.map((question) => ({ ...question, id: newId() }));
  const question = (builtIn: RsvpQuestion["builtIn"]) => rsvpQuestions.find((q) => q.builtIn === builtIn)?.id;
  const answers = (dietary: string | null, arrival: string, needsRide: boolean) => {
    const out: Record<string, string | boolean> = {};
    const dietaryId = question("dietary");
    const arrivalId = question("arrival");
    const rideId = question("needs_ride");
    if (dietaryId && dietary) out[dietaryId] = dietary;
    if (arrivalId) out[arrivalId] = arrival;
    if (rideId) out[rideId] = needsRide;
    return out;
  };

  const host = { rsvpStatus: "yes" as const, rsvpAt: ago(12), rsvpVia: "organizer" as const };
  const replied = { rsvpStatus: "yes" as const, rsvpAt: ago(8), rsvpVia: "personal_link" as const };
  const people: NewPerson[] = [
    { id: p.lydia, planId, partyId: party.minneapolis, name: "Lydia Hartley", email: "lydia.hartley@example.com", phone: "612-555-0142", role: "organizer", canDrive: true, ...host },
    { id: p.rob, planId, partyId: party.minneapolis, name: "Rob Hartley", phone: "612-555-0167", canDrive: true, vehicleSeats: 6, privateNotes: "Offered to do the evening airport run in the minivan.", ...host },
    { id: p.theo, planId, partyId: party.minneapolis, name: "Theo Hartley", ageGroup: "child", childAge: 11, ...host },
    { id: p.june, planId, partyId: party.minneapolis, name: "June Hartley", ageGroup: "child", childAge: 8, dietaryTags: ["nut_allergy"], dietaryNote: "Tree nuts and peanuts. Carries an EpiPen.", ...host },
    { id: p.wes, planId, partyId: party.minneapolis, name: "Wes Hartley", ageGroup: "child", childAge: 5, privateNotes: "Needs a booster seat in the car.", ...host },
    {
      id: p.ruth, planId, partyId: party.seattle, name: "Ruth Hartley", email: "ruth.hartley@example.com", phone: "206-555-0113", canDrive: true,
      dietaryTags: ["vegetarian"], ...replied,
      rsvpAnswers: answers("Vegetarian", "Flying in from Seattle on Alaska 1054", true),
      messageToHost: "We can't wait. Walt is bringing the cribbage board.",
    },
    {
      id: p.walt, planId, partyId: party.seattle, name: "Walt Hartley", accessNote: "Uses a cane. A ground-floor bedroom helps.", ...replied,
      rsvpAnswers: answers(null, "Flying in from Seattle on Alaska 1054", true),
    },
    { id: p.dana, planId, partyId: party.portland, name: "Dana Hartley", email: "dana.hartley@example.com", phone: "503-555-0190", canDrive: true, rsvpStatus: "invited" },
    { id: p.chris, planId, partyId: party.portland, name: "Chris Okafor", canDrive: true, rsvpStatus: "invited" },
  ];

  // --- bookings ---------------------------------------------------------------------------------
  const b = {
    flightMsp: newId(), flightSea: newId(), flightPdx: newId(), house: newId(), car: newId(), pickup: newId(),
    pizza: newId(), dinner: newId(), groceries: newId(), box: newId(),
  };
  const arrival = { msp: newId(), sea: newId(), pdx: newId() };
  const departure = { msp: newId(), sea: newId(), pdx: newId() };

  type Leg = [airline: string, name: string, number: string, from: string, fromTz: string, dayOut: number, out: string, to: string, toTz: string, dayIn: number, landing: string];
  const segment = ([airlineIata, airlineName, flightNumber, originIata, originTz, dayOut, out, destinationIata, destinationTz, dayIn, landing]: Leg) => ({
    airlineIata, airlineName, flightNumber, originIata, originTz, departsAt: iso(dayOut, out, originTz),
    destinationIata, destinationTz, arrivesAt: iso(dayIn, landing, destinationTz),
  });
  const flight = (id: string, title: string, vendorName: string, confirmationCode: string, personIds: string[], bookedDaysAgo: number, legs: Leg[], seats?: Record<string, string>): NewBooking => {
    const segments = legs.map(segment) as FlightSegment[];
    if (seats) segments[0] = { ...segments[0], seats };
    const flightDetails = details("flight", { tripType: "round_trip", cabin: "economy", segments });
    return {
      id, planId, kind: "flight", status: "booked", title, personIds, provider: vendorName, vendorName, confirmationCode,
      startsAt: new Date(flightDetails.segments[0].departsAt), startTz: flightDetails.segments[0].originTz,
      endsAt: new Date(flightDetails.segments[flightDetails.segments.length - 1].arrivesAt),
      endTz: flightDetails.segments[flightDetails.segments.length - 1].destinationTz,
      details: flightDetails,
      createdAt: ago(bookedDaysAgo),
    };
  };

  const pickupAt = at(0, "19:15", ET);
  const boxTarget = nextBusinessDay(first, isFixedHoliday);
  const dietarySummary = "1 vegetarian, 1 nut allergy";

  const bookings: NewBooking[] = [
    // Flights: all nine, both ways.
    flight(b.flightMsp, "DL 1482 MSP to MCO", "Delta Air Lines", "GH7K2M", hosts, 61, [
      ["DL", "Delta Air Lines", "1482", "MSP", CT, 0, "11:45", "MCO", ET, 0, "16:00"],
      ["DL", "Delta Air Lines", "1483", "MCO", ET, EXAMPLE_NIGHTS, "11:05", "MSP", CT, EXAMPLE_NIGHTS, "13:40"],
    ], { [p.lydia]: "23A", [p.rob]: "23B", [p.theo]: "23C", [p.june]: "23D", [p.wes]: "23E" }),
    flight(b.flightSea, "AS 1054 SEA to MCO", "Alaska Airlines", "KXLPQD", seattle, 48, [
      ["AS", "Alaska Airlines", "1054", "SEA", PT, 0, "10:25", "MCO", ET, 0, "18:50"],
      ["AS", "Alaska Airlines", "1055", "MCO", ET, EXAMPLE_NIGHTS, "08:15", "SEA", PT, EXAMPLE_NIGHTS, "11:30"],
    ]),
    flight(b.flightPdx, "UA 1722 PDX to MCO", "United Airlines", "M4TR8Z", portland, 40, [
      ["UA", "United Airlines", "1722", "PDX", PT, 0, "08:05", "DEN", MT, 0, "11:40"],
      ["UA", "United Airlines", "2041", "DEN", MT, 0, "12:45", "MCO", ET, 0, "18:20"],
      ["UA", "United Airlines", "1138", "MCO", ET, EXAMPLE_NIGHTS, "12:10", "DEN", MT, EXAMPLE_NIGHTS, "14:25"],
      ["UA", "United Airlines", "573", "DEN", MT, EXAMPLE_NIGHTS, "15:30", "PDX", PT, EXAMPLE_NIGHTS, "17:15"],
    ]),

    // Stay: the lakeside house, eight nights, all nine.
    {
      id: b.house, planId, kind: "lodging", status: "booked", title: "Lakeside house", personIds: everyone,
      provider: "Vrbo", vendorName: "Lakeside house", confirmationCode: "HA-4417K29",
      priceAmount: 384_000, priceCurrency: "USD", paidByPersonId: p.lydia,
      startsAt: at(0, "16:00", ET), startTz: ET, endsAt: at(EXAMPLE_NIGHTS, "10:00", ET), endTz: ET,
      cancelBy: at(-14, "23:59", ET),
      notes: "Marisol answers fastest by message on Vrbo.",
      details: details("lodging", {
        lodgingType: "rental",
        propertyName: "Lakeside house",
        place: HOUSE,
        checkInDate: first,
        checkInTime: "16:00",
        checkOutDate: last,
        checkOutTime: "10:00",
        rooms: [
          { label: "Lake room", personIds: [p.lydia, p.rob] },
          { label: "Bunk room", personIds: [p.theo, p.june, p.wes] },
          { label: "Garden room (ground floor)", personIds: seattle },
          { label: "Loft", personIds: portland },
        ],
        contactName: "Marisol Vega (host)",
        contactPhone: "407-555-0118",
        accessNotes: "Front door code 4417, then the star key. Wi-Fi: LakesideGuest, password heron-dock-22. Bins go to the curb Monday night.",
        packagePolicy: {
          accepts: true,
          holdDays: 0,
          receivingAddress: "418 Lakeshore Loop, Windermere, FL 34786",
          contact: "Marisol Vega, by message on Vrbo",
        },
      }),
      createdAt: ago(58),
    },

    // Car: the one thing still needing Lydia. Past its recommended date, not yet at its hard one.
    {
      id: b.car, planId, kind: "car", status: "needed", title: "A minivan in Orlando", personIds: hosts,
      actBy: { recommended: day(-45), hard: day(-14) },
      details: details("car", { vehicleClass: "minivan", seats: 7 }),
      createdAt: ago(58),
    },

    // Rides: one airport pickup, planned. Seattle and Portland land half an hour apart, so one
    // run meets both. Who, when and where are set; nobody has been named as the driver yet,
    // which is what keeps it "planned" rather than settled.
    {
      id: b.pickup, planId, kind: "ride", status: "planned", title: "Airport pickup for Ruth, Walt, Dana and Chris",
      personIds: [...seattle, ...portland],
      startsAt: pickupAt, startTz: ET,
      notes: "Rob has offered to take the minivan back to the airport once the kids are settled. First lands 6:20, last 6:50.",
      details: details("ride", {
        rideType: "personal_pickup",
        fromPlace: MCO,
        toPlace: HOUSE,
        pickupAt: { at: pickupAt.toISOString(), tz: ET },
        passengerIds: [...seattle, ...portland],
        bags: 6,
        arrivalIds: [arrival.sea, arrival.pdx],
      }),
      createdAt: ago(6),
    },

    // Food: two deliveries set, and groceries planned for when the order window opens.
    {
      id: b.pizza, planId, kind: "meal", status: "booked", title: "Pizza night", personIds: everyone,
      provider: "Dockside Pizza Co.", vendorName: "Dockside Pizza Co.", confirmationCode: "DP-20417",
      priceAmount: 14_140, priceCurrency: "USD", paidByPersonId: p.lydia,
      startsAt: at(0, "20:00", ET), startTz: ET, endsAt: at(0, "20:30", ET), endTz: ET,
      details: details("meal", {
        mealType: "restaurant_delivery",
        vendorName: "Dockside Pizza Co.",
        deliverToPlace: HOUSE,
        windowStart: { at: iso(0, "20:00", ET), tz: ET },
        windowEnd: { at: iso(0, "20:30", ET), tz: ET },
        headcount: 9,
        dietarySummary,
        list: [
          { name: "Large cheese pizza", quantity: 2 },
          { name: "Large pepperoni pizza", quantity: 2 },
          { name: "Large roasted vegetable pizza", quantity: 1, note: "For Ruth" },
          { name: "Garden salad", quantity: 2, note: "No nuts, dressing on the side" },
        ],
        deliveryNote: "Side door by the carport. Text Lydia when you are outside.",
        orderNumber: "DP-20417",
        total: { amount: 14_140, currency: "USD" },
        tip: { amount: 2_000, currency: "USD" },
      }),
      createdAt: ago(2),
    },
    {
      id: b.dinner, planId, kind: "meal", status: "booked", title: "Christmas Eve dinner", personIds: everyone,
      provider: "Heron & Oak Catering", vendorName: "Heron & Oak Catering", confirmationCode: "HO-3391",
      priceAmount: 61_200, priceCurrency: "USD", paidByPersonId: p.lydia,
      startsAt: at(5, "17:15", ET), startTz: ET, endsAt: at(5, "17:45", ET), endTz: ET,
      cancelBy: at(3, "12:00", ET),
      notes: "Deposit paid. The balance is due on delivery.",
      details: details("meal", {
        mealType: "catering",
        vendorName: "Heron & Oak Catering",
        deliverToPlace: HOUSE,
        windowStart: { at: iso(5, "17:15", ET), tz: ET },
        windowEnd: { at: iso(5, "17:45", ET), tz: ET },
        headcount: 9,
        dietarySummary,
        list: [
          { name: "Glazed ham", quantity: 1 },
          { name: "Roast turkey breast", quantity: 1 },
          { name: "Mushroom Wellington", quantity: 1, note: "Vegetarian main, for Ruth" },
          { name: "Mashed potatoes", quantity: 2 },
          { name: "Green beans", quantity: 2, note: "No almonds" },
          { name: "Dinner rolls", quantity: 18 },
          { name: "Apple pie", quantity: 2, note: "From their nut-free kitchen" },
        ],
        deliveryNote: "Side door by the carport. Dinner is at 6, so anything from 5:15 is fine.",
        orderNumber: "HO-3391",
        total: { amount: 61_200, currency: "USD" },
      }),
      createdAt: ago(15),
    },
    {
      id: b.groceries, planId, kind: "meal", status: "planned", title: "Groceries for the first days", personIds: everyone,
      provider: "Instacart", vendorName: "Publix",
      startsAt: at(0, "18:00", ET), startTz: ET, endsAt: at(0, "19:00", ET), endTz: ET,
      // Orders open a week ahead; until then there is nothing to do but wait.
      actBy: { opensOn: day(-7), recommended: day(-7), hard: day(-1) },
      details: details("meal", {
        mealType: "groceries",
        vendorName: "Publix",
        deliverToPlace: HOUSE,
        windowStart: { at: iso(0, "18:00", ET), tz: ET },
        windowEnd: { at: iso(0, "19:00", ET), tz: ET },
        headcount: 9,
        dietarySummary,
        list: [
          { name: "Milk", quantity: 2 },
          { name: "Oat milk", quantity: 1 },
          { name: "Eggs", quantity: 2, note: "Dozens" },
          { name: "Coffee", quantity: 1 },
          { name: "Bread", quantity: 2 },
          { name: "Butter", quantity: 1 },
          { name: "Pancake mix", quantity: 1, note: "Check the label: no tree nuts" },
          { name: "Clementines", quantity: 2, note: "Bags" },
          { name: "Hot cocoa and marshmallows", quantity: 1 },
          { name: "Cereal", quantity: 2 },
        ],
        deliveryNote: "Side door by the carport. Leave it inside the screen porch if nobody answers.",
        orderOpensOn: day(-7),
      }),
      createdAt: ago(4),
    },

    // Send ahead: one box of gifts, on its way, due the first delivery day on or after check-in.
    {
      id: b.box, planId, kind: "shipment", status: "booked", title: "Gift box to the lake house", personIds: [p.lydia],
      provider: "ups", vendorName: "UPS",
      priceAmount: 4_860, priceCurrency: "USD", paidByPersonId: p.lydia,
      notes: "Wrapped gifts and the stockings, so nothing has to fly.",
      details: details("shipment", {
        shipmentKind: "gift",
        direction: "outbound",
        destinationType: "vacation_rental",
        lodgingBookingId: b.house,
        recipientName: "Lydia Hartley",
        propertyName: "Lakeside house",
        reservationNumber: "HA-4417K29",
        labelLines: ["Lydia Hartley", "c/o Marisol Vega", "418 Lakeshore Loop", "Windermere, FL 34786"],
        arrivalDate: first,
        serviceKey: "ups_ground",
        originPostal: "55406",
        destinationPostal: "34786",
        zone: 6,
        international: false,
        targetDeliveryDate: boxTarget,
        shipByDate: addBusinessDays(boxTarget, -7),
        latestRiskyDate: addBusinessDays(boxTarget, -5),
        propertyAnswers: {
          confirmed: true,
          holdDays: 0,
          receivingAddress: "418 Lakeshore Loop, Windermere, FL 34786",
          contact: "Marisol Vega",
          notes: "Marisol said one box is fine once we have checked in. UPS is holding it for delivery that day.",
        },
        contents: [
          { description: "Wrapped gifts", quantity: 8, flags: [] },
          { description: "Christmas stockings", quantity: 5, flags: [] },
        ],
        parcels: [
          {
            weight: { value: 24, unit: "lb" },
            dimensions: { length: 20, width: 16, height: 14, unit: "in" },
            trackingNumber: "1Z999AA10123456784",
            carrierDetected: "ups",
            status: "shipped",
            statusAt: ago(1).toISOString(),
          },
        ],
      }),
      createdAt: ago(3),
    },
  ];

  const rooms: ExamplePlanRows["rooms"] = [
    ...[p.lydia, p.rob].map((personId) => ({ personId, lodgingBookingId: b.house, room: "Lake room" })),
    ...[p.theo, p.june, p.wes].map((personId) => ({ personId, lodgingBookingId: b.house, room: "Bunk room" })),
    ...seattle.map((personId) => ({ personId, lodgingBookingId: b.house, room: "Garden room (ground floor)" })),
    ...portland.map((personId) => ({ personId, lodgingBookingId: b.house, room: "Loft" })),
  ];

  // --- arrivals: one per household per direction, each read from its flight ----------------------
  const flightRow = (id: string, partyId: string, personIds: string[], direction: "arrival" | "departure", bookingId: string, segmentIndex: number, fromLabel: string, scheduledAt: Date, rest: Partial<NewArrival>): NewArrival => ({
    id, planId, partyId, personIds, direction, mode: "flight", bookingId, segmentIndex, fromLabel, toPlace: MCO,
    scheduledAt, tz: ET, source: "booking", status: "scheduled", ...rest,
  });
  const arrivals: NewArrival[] = [
    flightRow(arrival.msp, party.minneapolis, hosts, "arrival", b.flightMsp, 0, "Minneapolis", at(0, "16:00", ET), { rideNeed: "rental_car", bags: 7 }),
    flightRow(arrival.pdx, party.portland, portland, "arrival", b.flightPdx, 1, "Portland", at(0, "18:20", ET), { rideNeed: "needs_ride", rideBookingId: b.pickup, bags: 3 }),
    flightRow(arrival.sea, party.seattle, seattle, "arrival", b.flightSea, 0, "Seattle", at(0, "18:50", ET), { rideNeed: "needs_ride", rideBookingId: b.pickup, bags: 3 }),
    // Going home, everyone rides in the minivan: Rob runs Ruth and Walt over first.
    flightRow(departure.sea, party.seattle, seattle, "departure", b.flightSea, 1, "Seattle", at(EXAMPLE_NIGHTS, "08:15", ET), { rideNeed: "rental_car", bags: 3 }),
    flightRow(departure.msp, party.minneapolis, hosts, "departure", b.flightMsp, 1, "Minneapolis", at(EXAMPLE_NIGHTS, "11:05", ET), { rideNeed: "rental_car", bags: 7 }),
    flightRow(departure.pdx, party.portland, portland, "departure", b.flightPdx, 2, "Portland", at(EXAMPLE_NIGHTS, "12:10", ET), { rideNeed: "rental_car", bags: 3 }),
  ];

  // --- schedule: five key moments, two of them with a time and a place ---------------------------
  const moment = (offset: number, title: string, description: string, timed?: { from: string; to: string }): NewItineraryItem => ({
    id: newId(), planId, type: "event", title, description,
    localDate: day(offset), startTz: ET,
    ...(timed ? { startsAt: at(offset, timed.from, ET), endsAt: at(offset, timed.to, ET), endTz: ET, place: HOUSE_PUBLIC } : {}),
    visibility: "public", isKeyMoment: true, status: "confirmed",
  });
  const items: NewItineraryItem[] = [
    moment(0, "Everyone arrives, pizza night", "Flights land through the afternoon and evening. Pizza at the house once everyone is in."),
    moment(3, "A day at the parks", "Which park is still open. The kids vote on Monday."),
    moment(5, "Christmas Eve dinner", "Dinner at the long table, then one present each.", { from: "18:00", to: "20:00" }),
    moment(6, "Christmas morning brunch", "Stockings first. Pajamas encouraged.", { from: "10:00", to: "11:30" }),
    moment(7, "Beach day", "Cocoa Beach or New Smyrna, depending on the wind."),
  ];

  // --- tasks: five essential, two done -----------------------------------------------------------
  let order = 0;
  const task = (fields: Omit<NewTask, "id" | "planId" | "sortOrder">): NewTask => ({ id: newId(), planId, sortOrder: order++, ...fields });
  const done = (days: number) => ({ done: true, doneAt: ago(days) });
  const tasks: NewTask[] = [
    task({ title: "Ask about dietary needs", essential: true, dueDate: day(-14), source: "template", ruleKey: "template:dietary", ...done(6) }),
    task({ title: "Send everyone the link to the page", essential: true, dueDate: day(-30), source: "user", ...done(9) }),
    task({ title: "Arrange airport pickups", essential: true, dueDate: day(-7), assigneePersonId: p.rob, source: "template", ruleKey: "template:airport-pickups", bookingId: b.pickup }),
    task({ title: "Confirm who cooks what", essential: true, dueDate: day(-7), source: "template", ruleKey: "template:who-cooks", notes: "Christmas Eve is catered. Still open: Christmas dinner and the first breakfast." }),
    task({ title: "Tell Marisol which day the box arrives", essential: true, dueDate: addDays(boxTarget, -3), source: "user", bookingId: b.box }),
    task({ title: "Hold the mail", essential: false, dueDate: day(-3), source: "template", ruleKey: "template:hold-mail" }),
    task({ kind: "packing", title: "Swimsuits and sunscreen", essential: false, source: "user" }),
    task({ kind: "packing", title: "Phone chargers and the long HDMI cable", essential: false, source: "user" }),
    // Things guests can claim on the page: two taken, one still open.
    task({ kind: "bring", title: "Board games", essential: false, source: "user", claimedByPersonId: p.ruth }),
    task({ kind: "bring", title: "Christmas cookies", quantity: 3, notes: "Dozens. Nut-free, please.", essential: false, source: "user", claimedByPersonId: p.walt }),
    task({ kind: "bring", title: "Beach towels", quantity: 9, essential: false, source: "user" }),
  ];

  // --- money: $4,280.00 paid so far, the catering balance still to come --------------------------
  const byHousehold: ExpenseSplit = { method: "by_party", parts: everyone.map((personId) => ({ personId })) };
  const e = { house: newId(), deposit: newId(), balance: newId(), pizza: newId(), box: newId() };
  const expense = (fields: Omit<NewExpense, "planId" | "currency">): NewExpense => ({ planId, currency: "USD", ...fields });
  const expenses: NewExpense[] = [
    expense({ id: e.house, date: agoDate(58), merchant: "Vrbo", description: "Lakeside house, 8 nights", category: "lodging", amount: 384_000, paidByPersonId: p.lydia, split: byHousehold, bookingId: b.house, status: "paid" }),
    expense({ id: e.deposit, date: agoDate(15), merchant: "Heron & Oak Catering", description: "Christmas Eve dinner, deposit", category: "meals", amount: 25_000, paidByPersonId: p.lydia, split: byHousehold, bookingId: b.dinner, status: "paid" }),
    expense({ id: e.pizza, date: agoDate(2), merchant: "Dockside Pizza Co.", description: "Pizza night", category: "meals", amount: 14_140, paidByPersonId: p.lydia, split: byHousehold, bookingId: b.pizza, status: "paid" }),
    expense({ id: e.box, date: agoDate(3), merchant: "UPS", description: "Gift box to the lake house", category: "shipping", amount: 4_860, paidByPersonId: p.lydia, bookingId: b.box, status: "paid" }),
    expense({ id: e.balance, date: day(5), merchant: "Heron & Oak Catering", description: "Christmas Eve dinner, balance on delivery", category: "meals", amount: 36_200, paidByPersonId: p.lydia, split: byHousehold, bookingId: b.dinner, status: "planned" }),
  ];
  const bookingExpenses = [
    { bookingId: b.house, expenseId: e.house },
    { bookingId: b.dinner, expenseId: e.deposit },
    { bookingId: b.pizza, expenseId: e.pizza },
    { bookingId: b.box, expenseId: e.box },
  ];

  // --- the share page: published, with something in the sections a person types into -------------
  const content: Partial<Record<SiteSection["type"], Record<string, unknown>>> = {
    details: {
      text: "A week at the lake house, all of us under one roof. Come for the whole week or whatever part you can. The only fixed things are Christmas Eve dinner and Christmas morning.",
      dressCode: "Pajamas on Christmas morning. Otherwise, whatever you would wear to a lake.",
    },
    getting_there: {
      text: "Fly into Orlando (MCO). The house is about 35 minutes west of the airport. Tell us your flight and somebody will meet you.",
      parking: "Room for three cars in the drive.",
    },
    faq: {
      items: [
        { question: "Do we need to bring bedding?", answer: "No. Beds are made and there are towels for the house. Bring a beach towel if you have one." },
        { question: "Is there a pool?", answer: "No pool, but there is a dock and the lake is swimmable. The kids wear life jackets on the dock." },
        { question: "What about presents?", answer: "One present each on Christmas Eve, the rest in the morning. We are shipping ours ahead so nothing has to fly." },
      ],
    },
    contact: { people: [{ name: "Lydia", role: "Host", phone: "612-555-0142" }, { name: "Rob", role: "Airport runs", phone: "612-555-0167" }] },
  };
  const sections: SiteSection[] = template.site.sections.map((section) => ({ ...section, content: content[section.type] ?? {} }));

  const site: NewSite = {
    id: newId(),
    planId,
    slug,
    status: "published",
    access: template.site.access,
    theme: template.site.theme,
    accent: template.site.accent,
    title: EXAMPLE_TITLE,
    subtitle: "A week at the lake house",
    hostLine: "Hosted by Lydia and Rob",
    announcement: { text: "Flights are booked and the house is ours from the first afternoon. Bring a swimsuit: there is a dock.", postedAt: ago(2).toISOString() },
    repliesOpen: true,
    replyDeadline: day(-21),
    replyByParty: true,
    allowMaybe: true,
    whoIsComing: template.site.whoIsComing,
    publishedAt: ago(9),
    unpublishOn: addDays(last, 30),
    viewCount: 31,
    sections,
    rsvpQuestions,
  };

  const plan: ExamplePlanRows["plan"] = {
    id: planId,
    ownerId,
    template: "family_event",
    title: EXAMPLE_TITLE,
    destination: ORLANDO,
    origin: MINNEAPOLIS,
    startDate: first,
    endDate: last,
    dateStatus: "fixed",
    tz: ET,
    expectedPeople: 9,
    currency: "USD",
    budgetTotal: 650_000,
    replyDeadline: day(-21),
    kindsInUse: template.kinds.on,
    kindsNotNeeded: [],
    isExample: true,
  };

  return { plan, parties, people, bookings, bookingExpenses, rooms, arrivals, items, tasks, expenses, site };
}
