import { describe, expect, it } from "vitest";
import { parseBookingDetails } from "@/lib/domain";
import { bookingDetailsFromQuery } from "./details";
import { reviseProposal } from "./fields";
import {
  AIRPORTS,
  ARRIVALS,
  CAR_NEEDED,
  contextFor,
  hartley,
  LAKESIDE_HOUSE,
  LAKESIDE_STAY,
  makeArrival,
  makeBooking,
  makeParty,
  makePerson,
  makePlan,
  NOW,
  ORLANDO,
  PARTIES,
  PEOPLE,
  planData,
  SEATTLE,
  SEATTLE_FLIGHTS,
} from "./fixtures/plan";
import { estimateDriveMinutes, orderOpensOn, orderWindowNote, proposeSearch } from "./propose";
import type { Proposal } from "./types";

const fieldOf = (proposal: Proposal, key: string) => {
  const found = proposal.fields.find((field) => field.key === key);
  if (!found) throw new Error(`No field ${key} in ${proposal.key}`);
  return found;
};

describe("flights", () => {
  const ctx = contextFor(hartley());
  const proposals = proposeSearch("flight", ctx);

  it("proposes one search per household that flies from a different airport, open ones first", () => {
    expect(proposals.map((p) => [p.key, p.status])).toEqual([
      ["flight:from:PDX", "open"],
      ["flight:from:ORD", "open"],
      ["flight:from:SEA", "covered"],
    ]);
    expect(proposals.map((p) => p.title)).toEqual(["Flights for the Portland Hartleys", "Flights for Aunt Carol", "Flights for the Seattle Hartleys"]);
  });

  it("fills in the route, the dates and who is flying, each with its reason", () => {
    const portland = proposals[0];
    expect(portland.query).toMatchObject({ originIata: "PDX", destinationIata: "MCO", departDate: "2026-12-19", returnDate: "2026-12-27", tripType: "round_trip", cabin: "economy", adults: 2, children: 0, infants: 0 });
    expect(portland.summary).toBe("PDX to MCO · Sat, Dec 19 – Sun, Dec 27 · 2 adults · Economy");
    expect(portland.fields.map((f) => [f.key, f.label, f.display, f.because])).toEqual([
      ["from", "Flying from", "Portland International Airport (PDX)", "where the Portland Hartleys set out from"],
      ["to", "Flying to", "Orlando International Airport (MCO)", "where the flights already booked land"],
      ["depart", "Leaving", "Sat, Dec 19", "the day you check in"],
      ["return", "Coming back", "Sun, Dec 27", "the day you check out"],
      ["travelers", "Who's flying", "2 adults", "everyone in the Portland Hartleys"],
      ["cabin", "Cabin", "Economy", undefined],
    ]);
    expect(portland.missing).toEqual([]);
    expect(portland.personIds).toEqual(["p-dana", "p-chris"]);
    expect(portland.partyIds).toEqual(["party-pdx"]);
  });

  it("says a household's flights are covered once they are booked, and by what", () => {
    const seattle = proposals[2];
    expect(seattle.coveredBy).toBe("Booked: AS 1054 SEA to MCO");
    expect(seattle.query).toMatchObject({ originIata: "SEA", adults: 2, children: 2, childAges: [9, 5] });
    expect(fieldOf(seattle, "from").because).toBe("your home airport");
  });

  it("leaves out households that are already there or are not flying", () => {
    expect(proposals.some((p) => p.partyIds.includes("party-orl"))).toBe(false);
    const driving = hartley({ arrivals: [...Object.values(ARRIVALS), makeArrival({ id: "a-ord-in", partyId: "party-ord", direction: "arrival", mode: "drive" })] });
    expect(proposeSearch("flight", contextFor(driving)).map((p) => p.key)).toEqual(["flight:from:PDX", "flight:from:SEA"]);
  });

  it("leaves out a household that lives where the plan is, even before the arrivals board says so", () => {
    const data = hartley({ arrivals: [] });
    expect(proposeSearch("flight", contextFor(data)).map((p) => p.key)).toEqual(["flight:from:PDX", "flight:from:ORD", "flight:from:SEA"]);
  });

  it("puts households that share an airport into one search", () => {
    const cousins = makeParty({ id: "party-pdx2", name: "The Beaverton Hartleys", sortOrder: 5, origin: { kind: "city", name: "Beaverton", iata: "PDX", tz: "America/Los_Angeles" } });
    const data = hartley({ parties: [...Object.values(PARTIES), cousins], people: [...Object.values(PEOPLE), makePerson({ id: "p-sam", name: "Sam Hartley", partyId: "party-pdx2" })] });
    const [portland] = proposeSearch("flight", contextFor(data));
    expect(portland.title).toBe("Flights for the Portland Hartleys and the Beaverton Hartleys");
    expect(portland.query.adults).toBe(3);
  });

  it("does not count people who said no", () => {
    const data = hartley({ people: Object.values(PEOPLE).map((p) => (p.id === "p-chris" ? { ...p, rsvpStatus: "no" as const } : p)) });
    expect(proposeSearch("flight", contextFor(data))[0].query.adults).toBe(1);
  });

  it("proposes for the number given at creation when nobody has been added yet", () => {
    const data = planData({ plan: makePlan({ expectedPeople: 4, destination: { ...ORLANDO, iata: "MCO" } }) });
    const [only] = proposeSearch("flight", contextFor(data));
    expect(only.key).toBe("flight:from:SEA");
    expect(only.title).toBe("Flights");
    expect(only.query).toMatchObject({ originIata: "SEA", destinationIata: "MCO", adults: 4 });
    expect(fieldOf(only, "travelers")).toMatchObject({ display: "4 adults", because: "the number you gave when you made the plan" });
    expect(fieldOf(only, "to").because).toBe("the airport for Orlando");
    expect(fieldOf(only, "depart").because).toBe("the day the plan starts");
    expect(only.missing).toEqual([]);
  });

  it("says plainly what it does not know: no dates, no destination, no airports", () => {
    const bare = planData({ plan: makePlan({ destination: null, startDate: null, endDate: null, expectedPeople: 1 }) });
    const [only] = proposeSearch("flight", contextFor(bare, { homeAirportIata: null }));
    expect(only.missing).toEqual([
      "Choose where you're going and we'll find the airport.",
      "We don't know which airport you would fly from. Choose one below.",
      "Pick your dates and we'll fill in the days to fly.",
    ]);
    expect(fieldOf(only, "from")).toMatchObject({ value: null, display: "Not set yet" });
    expect(fieldOf(only, "from").because).toBeUndefined();
    expect(only.query.tripType).toBe("one_way");
    expect(only.summary).toBe("1 adult · Economy");
  });

  it("uses the home airport only when the plan sets out from home", () => {
    const fromChicago = planData({ plan: makePlan({ origin: { kind: "city", name: "Chicago", region: "IL", tz: "America/Chicago" }, destination: { ...ORLANDO, iata: "MCO" } }) });
    const [only] = proposeSearch("flight", contextFor(fromChicago));
    // Home is Seattle (SEA), but this plan starts in Chicago.
    expect(only.query.originIata).toBeUndefined();
    expect(only.key).toBe("flight:from:chicago");
    expect(only.missing).toEqual(["We don't know which airport you would fly from. Choose one below."]);
    const [found] = proposeSearch("flight", contextFor(fromChicago, { nearestAirport: (place) => (place.name === "Chicago" ? "ORD" : undefined) }));
    expect(found.query.originIata).toBe("ORD");
    expect(fieldOf(found, "from").because).toBe("the nearest airport to Chicago");
  });

  it("asks which airport when the destination has none and no lookup is wired", () => {
    const data = planData({ plan: makePlan() });
    const [only] = proposeSearch("flight", contextFor(data));
    expect(only.missing).toEqual(["We don't know which airport is nearest to Orlando. Choose one below."]);
  });

  it("uses the nearest-airport lookup when it is wired", () => {
    const data = planData({ plan: makePlan() });
    const [only] = proposeSearch("flight", contextFor(data, { nearestAirport: (place) => (place.name === "Orlando" ? "MCO" : undefined) }));
    expect(only.query.destinationIata).toBe("MCO");
    expect(fieldOf(only, "to").because).toBe("the nearest airport to Orlando");
    expect(only.missing).toEqual([]);
  });

  it("still answers when nobody needs a flight", () => {
    const locals = planData({ parties: [PARTIES.orlando], people: [PEOPLE.rob, PEOPLE.june], arrivals: [ARRIVALS.orlandoIn] });
    const [only] = proposeSearch("flight", contextFor(locals));
    expect(only).toMatchObject({ status: "covered", coveredBy: "Nobody needs to fly" });
    expect(only.notes).toEqual(["Nobody on this plan needs a flight: everyone is driving, taking the train or already there."]);
  });

  it("notes when children's ages are missing", () => {
    const data = hartley({ people: Object.values(PEOPLE).map((p) => (p.id === "p-mae" ? { ...p, childAge: null } : p)), bookings: [LAKESIDE_STAY] });
    const seattle = proposeSearch("flight", contextFor(data)).find((p) => p.key === "flight:from:SEA");
    expect(seattle?.query.childAges).toBeUndefined();
    expect(seattle?.notes).toEqual(["Airlines ask each child's age. Add the ages under Who's coming and we'll fill them in."]);
  });
});

describe("stay", () => {
  it("proposes a whole home for a big family, on the days the flights give", () => {
    const data = hartley({ bookings: [SEATTLE_FLIGHTS] });
    const [stay] = proposeSearch("lodging", contextFor(data));
    expect(stay.query).toMatchObject({ lodgingType: "rental", checkInDate: "2026-12-19", checkOutDate: "2026-12-27", adults: 7, children: 2, infants: 0, childAges: [9, 5], rooms: 1 });
    expect(stay.query.place?.name).toBe("Orlando");
    expect(stay.summary).toBe("Orlando, FL · Sat, Dec 19 – Sun, Dec 27 · 7 adults, 2 children · A whole home");
    expect(fieldOf(stay, "checkIn")).toMatchObject({ display: "Sat, Dec 19", because: "the night you arrive" });
    expect(fieldOf(stay, "checkOut").because).toBe("the day you fly home");
    expect(fieldOf(stay, "guests")).toMatchObject({ display: "7 adults, 2 children", because: "everyone who's coming" });
    expect(fieldOf(stay, "type")).toMatchObject({ display: "A whole home", because: "9 of you fit best under one roof" });
    expect(fieldOf(stay, "rooms")).toMatchObject({ label: "Homes", display: "1 home", because: "one place for everyone" });
    expect(stay.status).toBe("open");
  });

  it("is covered once a stay is booked", () => {
    const [stay] = proposeSearch("lodging", contextFor(hartley()));
    expect(stay).toMatchObject({ status: "covered", coveredBy: "Booked: Lakeside House" });
  });

  it("proposes a hotel with a room each for a work trip", () => {
    const data = planData({
      plan: makePlan({ template: "work", workMode: "travel", destination: { kind: "city", name: "Austin", region: "TX", countryCode: "US", tz: "America/Chicago" }, startDate: "2027-01-12", endDate: "2027-01-15", tz: "America/Chicago" }),
      parties: [makeParty({ id: "team", name: "Marketing" })],
      people: [makePerson({ id: "a", name: "Lydia Hartley", partyId: "team", role: "organizer" }), makePerson({ id: "b", name: "Priya Shah", partyId: "team" }), makePerson({ id: "c", name: "Ben Ortiz", partyId: "team" })],
    });
    const [stay] = proposeSearch("lodging", contextFor(data));
    expect(stay.query).toMatchObject({ lodgingType: "hotel", rooms: 3, checkInDate: "2027-01-12", checkOutDate: "2027-01-15" });
    expect(fieldOf(stay, "type").because).toBe("work trips usually mean a hotel");
    expect(fieldOf(stay, "rooms")).toMatchObject({ label: "Rooms", display: "3 rooms", because: "a room each" });
    expect(fieldOf(stay, "checkIn").because).toBe("the day the plan starts");
  });

  it("counts hotel rooms by household for a small family trip", () => {
    const data = planData({
      plan: makePlan({ template: "trip", expectedPeople: 4 }),
      parties: [PARTIES.seattle, PARTIES.portland],
      people: [PEOPLE.lydia, PEOPLE.mark, PEOPLE.dana, PEOPLE.chris],
    });
    const [stay] = proposeSearch("lodging", contextFor(data));
    expect(stay.query).toMatchObject({ lodgingType: "hotel", rooms: 2 });
    expect(fieldOf(stay, "rooms").because).toBe("two adults to a room, household by household");
  });

  it("books the night before for a landing in the small hours", () => {
    const redEye = makeBooking("flight", {
      id: "b-red-eye",
      status: "booked",
      title: "UA 1876 SFO to MCO",
      personIds: ["p-lydia"],
      details: { segments: [{ airlineIata: "UA", flightNumber: "1876", originIata: "SFO", destinationIata: "MCO", departsAt: "2026-12-19T03:40:00Z", originTz: "America/Los_Angeles", arrivesAt: "2026-12-19T08:55:00Z", destinationTz: "America/New_York" }] },
    });
    const data = planData({ parties: [PARTIES.seattle], people: [PEOPLE.lydia], bookings: [redEye] });
    const [stay] = proposeSearch("lodging", contextFor(data));
    // Lands 3:55 AM on the 19th: the room is needed from the 18th.
    expect(stay.query.checkInDate).toBe("2026-12-18");
    expect(fieldOf(stay, "checkIn").because).toBe("you land in the small hours, so the room starts the night before");
  });

  it("adds a search for each extra stop of a trip", () => {
    const data = planData({
      plan: makePlan({ template: "trip", stops: [{ place: { kind: "city", name: "Miami", region: "FL", tz: "America/New_York" }, arriveOn: "2026-12-27", leaveOn: "2026-12-30" }] }),
    });
    const proposals = proposeSearch("lodging", contextFor(data));
    expect(proposals.map((p) => p.key)).toEqual(["lodging:main", "lodging:stop:0"]);
    expect(proposals[1].title).toBe("A place to stay in Miami");
    expect(proposals[1].query).toMatchObject({ checkInDate: "2026-12-27", checkOutDate: "2026-12-30" });
  });

  it("says what is missing when there is no place and no dates", () => {
    const [stay] = proposeSearch("lodging", contextFor(planData({ plan: makePlan({ destination: null, startDate: null, endDate: null, expectedPeople: 0 }) })));
    expect(stay.missing).toEqual(["Choose where you're going and we'll look for places there.", "Pick your dates and we'll fill in check-in and check-out.", "Add who's coming so we can count beds."]);
    expect(stay.summary).toBe("Hotel");
  });

  it("drops a check-out that is not after check-in instead of proposing a zero-night stay", () => {
    const [stay] = proposeSearch("lodging", contextFor(planData({ plan: makePlan({ startDate: "2026-12-19", endDate: "2026-12-19" }) })));
    expect(stay.query.checkOutDate).toBeUndefined();
    expect(stay.missing).toContain("Add the day you leave and we'll fill in check-out.");
  });
});

describe("car", () => {
  const [car] = proposeSearch("car", contextFor(hartley()));

  it("picks the car up where the organizer lands, about 45 minutes later, rounded to the half hour", () => {
    // AS 1054 lands at 4:10 PM Eastern; 45 minutes later is 4:55 PM, so 5:00 PM.
    expect(car.query).toMatchObject({ pickupDate: "2026-12-19", pickupTime: "17:00", returnDate: "2026-12-27", returnTime: "08:00", seats: 4, childSeats: 1 });
    expect(car.query.pickupPlace).toEqual(AIRPORTS.MCO);
    expect(car.query.returnPlace).toBeUndefined();
    expect(fieldOf(car, "pickupPlace")).toMatchObject({ label: "Pick up at", value: "MCO", display: "Orlando International Airport (MCO)", because: "where you land" });
    expect(fieldOf(car, "pickup")).toMatchObject({ label: "Pick-up time", value: "2026-12-19T17:00", display: "Sat, Dec 19, 5:00 PM", because: "about 45 minutes after you land at 4:10 PM" });
  });

  it("returns it two and a half hours before the flight home", () => {
    expect(fieldOf(car, "return")).toMatchObject({ display: "Sun, Dec 27, 8:00 AM", because: "2 hours 30 minutes before your 10:30 AM flight" });
    expect(fieldOf(car, "returnPlace")).toMatchObject({ display: "Orlando International Airport (MCO)", because: "where your flight home leaves from" });
  });

  it("counts seats and child seats for the people on that landing", () => {
    expect(fieldOf(car, "seats")).toMatchObject({ display: "4 seats", because: "4 of you: 2 adults, 2 children" });
    expect(fieldOf(car, "childSeats")).toMatchObject({ display: "1 child seat", because: "children 7 and under" });
    expect(car.personIds).toEqual(["p-lydia", "p-mark", "p-theo", "p-mae"]);
    expect(car.summary).toBe("Orlando International Airport (MCO) · Sat, Dec 19, 5:00 PM – Sun, Dec 27, 8:00 AM · 4 seats");
    expect(car.missing).toEqual([]);
    expect(car.status).toBe("open");
  });

  it("falls back to the plan's days and asks for the flight when none is recorded", () => {
    const data = planData({ plan: makePlan({ destination: { ...ORLANDO, iata: "MCO" }, expectedPeople: 9 }) });
    const [bare] = proposeSearch("car", contextFor(data));
    expect(bare.query).toMatchObject({ pickupDate: "2026-12-19", returnDate: "2026-12-27", seats: 9 });
    expect(bare.query.pickupTime).toBeUndefined();
    expect(fieldOf(bare, "pickup")).toMatchObject({ display: "Sat, Dec 19", because: "the day the plan starts" });
    expect(bare.missing).toEqual(["Add your flight and we'll time the pick-up to your landing."]);
    expect(bare.notes).toEqual(["9 people need a minivan or a large SUV, or two cars."]);
  });

  it("says what is missing with no destination and no dates", () => {
    const [bare] = proposeSearch("car", contextFor(planData({ plan: makePlan({ destination: null, startDate: null, endDate: null }) })));
    expect(bare.missing).toEqual(["Choose where you're going and we'll suggest where to pick the car up.", "Pick your dates and we'll fill in the pick-up and return days."]);
  });

  it("is covered once a car is booked", () => {
    const booked = makeBooking("car", { id: "b-car", status: "booked", title: "Hertz at MCO", details: { company: "Hertz" } });
    const [covered] = proposeSearch("car", contextFor(hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, booked] })));
    expect(covered).toMatchObject({ status: "covered", coveredBy: "Booked: Hertz" });
  });
});

describe("rides", () => {
  const ctx = contextFor(hartley());
  const rides = proposeSearch("ride", ctx);

  it("proposes a ride for each landing and each flight home, in time order, covered ones last", () => {
    expect(rides.map((r) => [r.key, r.title, r.status])).toEqual([
      ["ride:arrival:a-pdx-in", "Ride from the airport for the Portland Hartleys", "open"],
      ["ride:arrival:a-sea-in", "Ride from the airport for the Seattle Hartleys", "open"],
      ["ride:departure:a-sea-out", "Ride to the airport for the Seattle Hartleys", "open"],
    ]);
  });

  it("times the airport pick-up 30 minutes after landing, with the reason", () => {
    const seattle = rides[1];
    expect(seattle.query).toMatchObject({ direction: "from_airport", pickupDate: "2026-12-19", pickupTime: "16:40", passengers: 4, bags: 4, childSeatNeeded: true, arrivalIds: ["a-sea-in"] });
    expect(seattle.query.fromPlace).toEqual(AIRPORTS.MCO);
    expect(seattle.query.toPlace).toEqual(LAKESIDE_HOUSE);
    expect(seattle.fields.map((f) => [f.label, f.display, f.because])).toEqual([
      ["Pick up at", "Orlando International Airport (MCO)", "where AS 1054 lands"],
      ["Going to", "Lakeside House", "where you're staying"],
      ["Pick-up time", "Sat, Dec 19, 4:40 PM", "30 minutes after you land"],
      ["Riders", "4 people", "the Seattle Hartleys on AS 1054"],
      ["Bags", "4 bags", "what they told you"],
      ["Child seat", "Needed", "a child 7 or under is riding"],
    ]);
    expect(seattle.summary).toBe("Orlando International Airport (MCO) to Lakeside House · Sat, Dec 19, 4:40 PM · 4 riders");
  });

  it("reads a landing a guest typed in themselves", () => {
    const portland = rides[0];
    // DL 2210 lands 3:55 PM Eastern.
    expect(portland.query).toMatchObject({ pickupDate: "2026-12-19", pickupTime: "16:25", passengers: 2, bags: 3, childSeatNeeded: false });
    expect(portland.fields.find((f) => f.key === "pickup")?.because).toBe("30 minutes after they land");
  });

  it("works back from the flight home: two hours at the airport plus the drive", () => {
    const home = rides[2];
    // AS 1055 leaves 10:30 AM. Lake house to MCO is about 15 km: a 35-minute estimate.
    const drive = estimateDriveMinutes(LAKESIDE_HOUSE, AIRPORTS.MCO);
    expect(drive).toBe(35);
    expect(home.query).toMatchObject({ direction: "to_airport", pickupDate: "2026-12-27", pickupTime: "07:55" });
    expect(home.query.fromPlace).toEqual(LAKESIDE_HOUSE);
    expect(home.query.toPlace).toEqual(AIRPORTS.MCO);
    expect(home.fields.find((f) => f.key === "pickup")?.because).toBe("to be at the airport 2 hours before the 10:30 AM flight, with about 35 minutes for the drive");
  });

  it("tells people how reserving works, and when the window opens", () => {
    expect(rides[1].notes).toEqual([
      "Uber and Lyft can't take a time from a link. Choose Reserve or Schedule in the app and enter the pick-up time.",
      "Both take reservations up to 90 days ahead, so you can reserve this ride now.",
    ]);
    const early = proposeSearch("ride", contextFor(hartley(), { now: new Date("2026-08-01T12:00:00Z") }));
    expect(early[1].notes[1]).toBe("Both take reservations up to 90 days ahead. You can reserve this ride from Sun, Sep 20.");
  });

  it("marks a landing as covered when a driver, a car or a booked ride has it", () => {
    const withDriver = hartley({ arrivals: [{ ...ARRIVALS.portlandIn, rideNeed: "driver_assigned", driverPersonId: "p-rob" }, { ...ARRIVALS.seattleIn, rideNeed: "rental_car" }, ARRIVALS.seattleOut, ARRIVALS.orlandoIn] });
    const result = proposeSearch("ride", contextFor(withDriver));
    expect(result.map((r) => [r.key, r.status, r.coveredBy])).toEqual([
      ["ride:departure:a-sea-out", "open", undefined],
      ["ride:arrival:a-pdx-in", "covered", "Rob is driving"],
      ["ride:arrival:a-sea-in", "covered", "Covered by the rental car"],
    ]);
    const bookedRide = makeBooking("ride", { id: "b-ride", status: "booked", title: "Uber from MCO", details: { arrivalIds: ["a-pdx-in"] } });
    const booked = proposeSearch("ride", contextFor(hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, bookedRide] })));
    expect(booked.find((r) => r.key === "ride:arrival:a-pdx-in")?.coveredBy).toBe("Booked: Uber from MCO");
  });

  it("uses the destination until a stay has an address, and says so", () => {
    const noStay = proposeSearch("ride", contextFor(hartley({ bookings: [SEATTLE_FLIGHTS] })));
    const seattle = noStay.find((r) => r.key === "ride:arrival:a-sea-in");
    expect(seattle?.query.toPlace?.name).toBe("Orlando");
    expect(seattle?.fields.find((f) => f.key === "to")?.because).toBe("your destination, until you add where you're staying");
    expect(seattle?.missing).toEqual(["Add where you're staying and we'll fill in the address."]);
  });

  it("derives landings straight from a recorded flight when the board has no row for it", () => {
    const data = planData({ parties: [PARTIES.seattle], people: [PEOPLE.lydia, PEOPLE.mark, PEOPLE.theo, PEOPLE.mae], bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY] });
    const result = proposeSearch("ride", contextFor(data));
    expect(result.map((r) => [r.key, r.title, r.query.pickupTime])).toEqual([
      ["ride:arrival:b-flight-sea:0", "Ride from the airport", "16:40"],
      ["ride:departure:b-flight-sea:1", "Ride to the airport", "07:55"],
    ]);
  });

  it("uses a 45-minute drive when a place has no coordinates", () => {
    const stayNoCoords = makeBooking("lodging", { id: "b-stay", status: "booked", title: "Lakeside House", details: { place: { ...LAKESIDE_HOUSE, lat: undefined, lon: undefined }, checkInDate: "2026-12-19", checkOutDate: "2026-12-27" } });
    const result = proposeSearch("ride", contextFor(hartley({ bookings: [SEATTLE_FLIGHTS, stayNoCoords] })));
    const home = result.find((r) => r.key === "ride:departure:a-sea-out");
    expect(home?.query.pickupTime).toBe("07:45");
    expect(home?.fields.find((f) => f.key === "pickup")?.because).toContain("about 45 minutes for the drive");
  });

  it("proposes one plain airport ride, and asks for flights, when none are known", () => {
    const [only] = proposeSearch("ride", contextFor(planData({ plan: makePlan({ destination: { ...ORLANDO, iata: "MCO" } }) })));
    expect(only.key).toBe("ride:arrival:plan");
    expect(only.query).toMatchObject({ pickupDate: "2026-12-19", passengers: 9, direction: "from_airport" });
    expect(only.query.pickupTime).toBeUndefined();
    expect(only.missing).toEqual(["Add your flights and we'll time the ride to your landing.", "Add where you're staying and we'll fill in the address."]);
  });

  it("copes with nothing at all", () => {
    const [only] = proposeSearch("ride", contextFor(planData({ plan: makePlan({ destination: null, startDate: null, endDate: null }) })));
    expect(only.missing).toEqual(["Add your flights and we'll time the ride to your landing.", "Add where you're staying and we'll fill in the address.", "Pick your dates and we'll fill in the day."]);
    expect(only.summary).toBe("9 riders");
  });
});

describe("food", () => {
  const ctx = contextFor(hartley());
  const food = proposeSearch("meal", ctx);

  it("proposes dinner and groceries for arrival evening", () => {
    expect(food.map((f) => [f.key, f.title])).toEqual([
      ["meal:arrival-evening:dinner", "Dinner on arrival night"],
      ["meal:arrival-evening:groceries", "Groceries for when you arrive"],
    ]);
  });

  it("times the delivery to when the family is in: 6:30 PM for a 4:10 PM landing and a 4:00 PM check-in", () => {
    const dinner = food[0];
    expect(dinner.query).toMatchObject({ mealType: "restaurant_delivery", date: "2026-12-19", windowStart: "18:30", windowEnd: "19:30", headcount: 9, dietarySummary: "1 vegetarian, 1 nut allergy" });
    expect(dinner.query.deliverToPlace).toEqual(LAKESIDE_HOUSE);
    expect(dinner.fields.map((f) => [f.label, f.display, f.because])).toEqual([
      ["What", "Dinner delivered", undefined],
      ["Cuisine or restaurant", "Not set yet", undefined],
      ["Deliver to", "Lakeside House", "where you're staying"],
      ["Deliver at", "Sat, Dec 19, 6:30 PM – 7:30 PM", "you land at 4:10 PM, so you should be in by about 6:30 PM"],
      ["How many", "9 people", "9 of you: 7 adults, 2 children"],
      ["Dietary needs", "1 vegetarian, 1 nut allergy", "from people's replies"],
    ]);
    expect(dinner.summary).toBe("Dinner delivered · Lakeside House · Sat, Dec 19, 6:30 PM – 7:30 PM · 9 people");
    expect(dinner.missing).toEqual([]);
  });

  it("notes each provider's ordering window", () => {
    expect(food[0].notes).toEqual([
      "Uber Eats takes orders 7 days ahead. Ordering opens Sat, Dec 12.",
      "DoorDash takes orders 4 days ahead. Ordering opens Tue, Dec 15.",
      "Grubhub takes orders 4 days ahead. Ordering opens Tue, Dec 15.",
    ]);
    expect(food[1].notes).toEqual(["Instacart takes orders 5 days ahead. Ordering opens Mon, Dec 14."]);
    const close = proposeSearch("meal", contextFor(hartley(), { now: new Date("2026-12-16T15:00:00Z") }));
    expect(close[0].notes).toEqual([
      "Uber Eats takes orders 7 days ahead, so you can order now.",
      "DoorDash takes orders 4 days ahead, so you can order now.",
      "Grubhub takes orders 4 days ahead, so you can order now.",
    ]);
  });

  it("never plans a delivery earlier than an hour after check-in", () => {
    // No flight: check-in at 6:00 PM governs (7:00 PM), not the 6:30 PM default.
    const lateCheckIn = makeBooking("lodging", { id: "b-stay", status: "booked", title: "Lakeside House", details: { place: LAKESIDE_HOUSE, checkInDate: "2026-12-19", checkInTime: "18:00", checkOutDate: "2026-12-27" } });
    const [dinner] = proposeSearch("meal", contextFor(planData({ bookings: [lateCheckIn] })));
    expect(dinner.query).toMatchObject({ windowStart: "19:00", windowEnd: "20:00" });
    expect(dinner.fields.find((f) => f.key === "when")?.because).toBe("an hour after check-in opens at 6:00 PM");
  });

  it("uses dinner time when the day is otherwise open", () => {
    const [dinner] = proposeSearch("meal", contextFor(planData({ bookings: [LAKESIDE_STAY] })));
    expect(dinner.query).toMatchObject({ date: "2026-12-19", windowStart: "18:30" });
    expect(dinner.fields.find((f) => f.key === "when")?.because).toBe("dinner time on the day you arrive");
  });

  it("plans for the next morning when the family gets in late", () => {
    const late = makeBooking("flight", {
      id: "b-late",
      status: "booked",
      title: "AS 322 SEA to MCO",
      personIds: ["p-lydia"],
      details: { segments: [{ airlineIata: "AS", flightNumber: "322", originIata: "SEA", destinationIata: "MCO", departsAt: "2026-12-19T22:00:00Z", originTz: "America/Los_Angeles", arrivesAt: "2026-12-20T03:30:00Z", destinationTz: "America/New_York" }] },
    });
    const data = planData({ parties: [PARTIES.seattle], people: [PEOPLE.lydia], bookings: [late, LAKESIDE_STAY] });
    const [dinner] = proposeSearch("meal", contextFor(data));
    // Lands 10:30 PM on the 19th.
    expect(dinner.query).toMatchObject({ date: "2026-12-20", windowStart: "09:00", windowEnd: "10:00" });
    expect(dinner.notes.at(-1)).toBe("You get in late. Most places stop delivering around 10 PM, so this is planned for the next morning.");
  });

  it("adds the front-desk note for a hotel", () => {
    const hotel = makeBooking("lodging", { id: "b-hotel", status: "booked", title: "Hyatt Regency Orlando", details: { lodgingType: "hotel", place: { ...LAKESIDE_HOUSE, name: "Hyatt Regency Orlando" }, checkInDate: "2026-12-19", checkOutDate: "2026-12-27" } });
    const [dinner] = proposeSearch("meal", contextFor(hartley({ bookings: [SEATTLE_FLIGHTS, hotel] })));
    expect(dinner.query.deliveryNote).toBe("Guest Lydia Hartley, arriving Dec 19. Leave with the front desk.");
    expect(dinner.fields.at(-1)).toMatchObject({ label: "Delivery note", because: "hotels hold deliveries at the front desk" });
  });

  it("puts catering first for a work event", () => {
    const data = planData({ plan: makePlan({ template: "work", workMode: "event", startDate: "2027-01-12", endDate: "2027-01-15", expectedPeople: 14 }) });
    const proposals = proposeSearch("meal", contextFor(data));
    expect(proposals.map((p) => p.title)).toEqual(["Catering for the group", "Dinner on arrival night", "Groceries for when you arrive"]);
    expect(proposals[0].notes).toEqual(["ezCater takes orders any time. Give the caterer at least 2 days."]);
    expect(proposals[0].query.headcount).toBe(14);
  });

  it("says what is missing: no address, no dates", () => {
    const [dinner] = proposeSearch("meal", contextFor(planData({ plan: makePlan({ startDate: null, endDate: null }) })));
    expect(dinner.missing).toEqual(["Add where you're staying and we'll fill in the delivery address.", "Pick your dates and we'll plan this for the night you arrive."]);
    expect(dinner.notes).toEqual(["Uber Eats takes orders 7 days ahead.", "DoorDash takes orders 4 days ahead.", "Grubhub takes orders 4 days ahead."]);
    const [dated] = proposeSearch("meal", contextFor(planData()));
    expect(dated.missing).toEqual(["Add where you're staying and we'll fill in the delivery address.", "Add your flight or where you're staying and we'll time the delivery to when you get in."]);
  });

  it("is covered once that evening's order is recorded", () => {
    const ordered = makeBooking("meal", { id: "b-meal", status: "booked", title: "Dinner", details: { mealType: "restaurant_delivery", vendorName: "Luigi's Trattoria", windowStart: { at: "2026-12-19T23:30:00Z", tz: "America/New_York" } } });
    const proposals = proposeSearch("meal", contextFor(hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, ordered] })));
    expect(proposals.map((p) => [p.key, p.status, p.coveredBy])).toEqual([
      ["meal:arrival-evening:groceries", "open", undefined],
      ["meal:arrival-evening:dinner", "covered", "Ordered: Luigi's Trattoria"],
    ]);
  });

  it("explains ordering windows on their own", () => {
    expect(orderOpensOn("doordash", "2026-12-19")).toBe("2026-12-15");
    expect(orderOpensOn("ezcater", "2026-12-19")).toBeNull();
    expect(orderWindowNote("instacart", undefined, "2026-11-27")).toBe("Instacart takes orders 5 days ahead.");
    // The day the window opens counts as open.
    expect(orderWindowNote("doordash", "2026-12-19", "2026-12-15")).toBe("DoorDash takes orders 4 days ahead, so you can order now.");
    expect(orderWindowNote("doordash", "2026-12-19", "2026-12-14")).toBe("DoorDash takes orders 4 days ahead. Ordering opens Tue, Dec 15.");
  });
});

describe("words people see", () => {
  it("never uses an exclamation mark, a hyphen for a range, or the internal vocabulary", () => {
    const plans = [hartley(), planData(), planData({ plan: makePlan({ destination: null, startDate: null, endDate: null }) }), planData({ plan: makePlan({ template: "work", workMode: "event" }) })];
    for (const data of plans) {
      for (const kind of ["flight", "lodging", "car", "ride", "meal"] as const) {
        for (const proposal of proposeSearch(kind, contextFor(data))) {
          const words = [proposal.title, proposal.summary, proposal.coveredBy ?? "", ...proposal.missing, ...proposal.notes, ...proposal.fields.flatMap((f) => [f.label, f.display, f.because ?? ""])].join("\n");
          expect(words, proposal.key).not.toMatch(/!/);
          expect(words, proposal.key).not.toMatch(/\b(lodging|rental car|shipment|hand-?off|itinerary|briefing|readiness)\b/i);
          expect(words, proposal.key).not.toMatch(/\d ?- ?\d{1,2}:\d{2}/);
          expect(words, proposal.key).not.toMatch(/undefined|null|NaN/);
        }
      }
    }
  });

  it("refuses a kind with nothing to search for", () => {
    expect(() => proposeSearch("shipment" as never, contextFor(hartley()))).toThrow(RangeError);
  });
});

describe("reviseProposal", () => {
  const [car] = proposeSearch("car", contextFor(hartley()));

  it("rebuilds the lines from the changed search and drops the reason for what the person changed", () => {
    const revised = reviseProposal(car, { pickupTime: "17:30" });
    expect(revised.query.pickupTime).toBe("17:30");
    expect(fieldOf(revised, "pickup")).toEqual({ key: "pickup", label: "Pick-up time", value: "2026-12-19T17:30", display: "Sat, Dec 19, 5:30 PM" });
    expect(fieldOf(revised, "return").because).toBe("2 hours 30 minutes before your 10:30 AM flight");
    expect(revised.summary).toContain("5:30 PM");
  });

  it("does not touch the proposal it was given", () => {
    reviseProposal(car, { seats: 7 });
    expect(car.query.seats).toBe(4);
    expect(fieldOf(car, "seats").display).toBe("4 seats");
  });

  it("shows a changed airport by its code alone until a new label is given", () => {
    const [flight] = proposeSearch("flight", contextFor(hartley()));
    const revised = reviseProposal(flight, { originIata: "SEA" });
    expect(fieldOf(revised, "from")).toEqual({ key: "from", label: "Flying from", value: "SEA", display: "SEA" });
    const labelled = reviseProposal(flight, { originIata: "SEA", originLabel: "Seattle (SEA)" });
    expect(fieldOf(labelled, "from").display).toBe("Seattle (SEA)");
  });

  it("turns a round trip into one way", () => {
    const [flight] = proposeSearch("flight", contextFor(hartley()));
    const oneWay = reviseProposal(flight, { tripType: "one_way" });
    expect(fieldOf(oneWay, "return")).toEqual({ key: "return", label: "Coming back", value: null, display: "One way, no flight back" });
    expect(oneWay.summary).toBe("PDX to MCO · Sat, Dec 19, one way · 2 adults · Economy");
  });
});

describe("bookingDetailsFromQuery", () => {
  const ctx = contextFor(hartley());

  it("turns each proposal into details the domain schemas accept", () => {
    for (const kind of ["flight", "lodging", "car", "ride", "meal"] as const) {
      for (const proposal of proposeSearch(kind, ctx)) {
        const parsed = parseBookingDetails(kind, bookingDetailsFromQuery(proposal.query));
        expect(parsed.ok, `${proposal.key}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      }
    }
  });

  it("turns local dates and times into instants in the place's own zone", () => {
    const [car] = proposeSearch("car", ctx);
    const details = bookingDetailsFromQuery(car.query);
    // 5:00 PM Eastern on Dec 19 is 22:00 UTC; 8:00 AM Eastern on Dec 27 is 13:00 UTC.
    expect(details.pickupAt).toEqual({ at: "2026-12-19T22:00:00.000Z", tz: "America/New_York" });
    expect(details.returnAt).toEqual({ at: "2026-12-27T13:00:00.000Z", tz: "America/New_York" });
    expect(details.returnPlace).toEqual(AIRPORTS.MCO);

    const [dinner] = proposeSearch("meal", ctx);
    const meal = bookingDetailsFromQuery(dinner.query);
    expect(meal.windowStart).toEqual({ at: "2026-12-19T23:30:00.000Z", tz: "America/New_York" });
    // Uber Eats opens first, 7 days ahead.
    expect(meal.orderOpensOn).toBe("2026-12-12");
  });

  it("leaves out what is not known rather than inventing an instant", () => {
    const [bare] = proposeSearch("car", contextFor(planData({ plan: makePlan({ destination: null }) })));
    const details = bookingDetailsFromQuery(bare.query);
    expect(details).toEqual({ kind: "car", seats: 9 });
  });
});

describe("data that does not hang together", () => {
  it("never throws when rows point at things that are not there", () => {
    const orphanArrival = makeArrival({ id: "a-x", partyId: "no-such-party", direction: "arrival", mode: "flight", bookingId: "no-such-booking", segmentIndex: 4, personIds: ["nobody"] });
    const outOfRange = makeArrival({ id: "a-y", partyId: "party-sea", direction: "departure", mode: "flight", bookingId: "b-flight-sea", segmentIndex: 9 });
    const emptyFlight = makeBooking("flight", { id: "b-empty", status: "booked", title: "Empty" });
    const lonely = makePerson({ id: "p-x", name: "", partyId: "no-such-party", ageGroup: "infant" });
    const data = hartley({
      arrivals: [orphanArrival, outOfRange, ...Object.values(ARRIVALS)],
      bookings: [emptyFlight, SEATTLE_FLIGHTS, makeBooking("lodging", { id: "b-s", status: "booked", title: "No address" }), makeBooking("car", { id: "b-c", status: "cancelled", title: "Cancelled" })],
      people: [...Object.values(PEOPLE), lonely],
    });
    for (const now of [NOW, new Date("2020-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z")]) {
      const ctx = contextFor(data, { now });
      for (const kind of ["flight", "lodging", "car", "ride", "meal"] as const) {
        const proposals = proposeSearch(kind, ctx);
        expect(proposals.length, kind).toBeGreaterThan(0);
        for (const proposal of proposals) {
          expect(proposal.fields.length).toBeGreaterThan(0);
          expect(new Set(proposal.fields.map((f) => f.key)).size).toBe(proposal.fields.length);
          expect(() => bookingDetailsFromQuery(proposal.query)).not.toThrow();
        }
      }
    }
  });

  it("gives every proposal in a plan its own key", () => {
    const ctx = contextFor(hartley());
    const keys = (["flight", "lodging", "car", "ride", "meal"] as const).flatMap((kind) => proposeSearch(kind, ctx).map((p) => p.key));
    expect(new Set(keys).size).toBe(keys.length);
    // And the same keys the next time it is asked.
    const again = (["flight", "lodging", "car", "ride", "meal"] as const).flatMap((kind) => proposeSearch(kind, contextFor(hartley(), { now: new Date("2026-12-10T00:00:00Z") })).map((p) => p.key));
    expect([...again].sort()).toEqual([...keys].sort());
  });
});

describe("the fixture itself", () => {
  it("is 22 days before a plan of nine people", () => {
    expect(NOW.toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(hartley().people).toHaveLength(9);
    expect(CAR_NEEDED.status).toBe("needed");
    expect(SEATTLE.tz).toBe("America/Los_Angeles");
  });
});
