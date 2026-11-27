import { describe, expect, it } from "vitest";
import { unfilledListSchema } from "@/lib/domain";
import { reviseProposal } from "./fields";
import { AIRPORTS, CAR_NEEDED, contextFor, hartley, LAKESIDE_HOUSE, LAKESIDE_STAY, makeBooking, makeHandoff, makePlan, planData, SEATTLE_FLIGHTS } from "./fixtures/plan";
import { flightStatusLinks, handoffLinks, hasHandoff, mapsLinks, proposalForBooking, providerOrder } from "./links";
import { proposeSearch } from "./propose";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "./providers";

const ctx = contextFor(hartley());
const providers = (links: Array<{ provider: string }>) => links.map((link) => link.provider);

describe("handoffLinks: the shape of a button", () => {
  const [portland] = proposeSearch("flight", ctx);
  const links = handoffLinks(portland, ctx);

  it("returns every provider that fits, each with a name, a label that says where it goes, a blurb and a link", () => {
    expect(links.map((l) => [l.provider, l.name, l.actionLabel])).toEqual([
      ["google_flights", "Google Flights", "See flights on Google Flights"],
      ["kayak", "Kayak", "See flights on Kayak"],
      ["skyscanner", "Skyscanner", "See flights on Skyscanner"],
      ["expedia", "Expedia", "See flights on Expedia"],
    ]);
    for (const link of links) {
      expect(link.label).toBe(link.actionLabel);
      expect(link.blurb.length).toBeGreaterThan(10);
      expect(link.url).toMatch(/^https:\/\//);
      expect(link.tested).toBe(false);
      expect(link.prefilled).toBe(true);
      expect(["documented", "observed"]).toContain(link.grade);
    }
  });

  it("grades each link honestly", () => {
    expect(links.map((l) => [l.provider, l.grade])).toEqual([
      ["google_flights", "observed"],
      ["kayak", "observed"],
      ["skyscanner", "observed"],
      ["expedia", "documented"],
    ]);
  });

  it("prefills the plan's own dates, airports and people", () => {
    expect(links[0].url).toBe("https://www.google.com/travel/flights?q=Flights%20to%20MCO%20from%20PDX%20on%202026-12-19%20through%202026-12-27&hl=en&curr=USD");
    expect(links[1].url).toBe("https://www.kayak.com/flights/PDX-MCO/2026-12-19/2026-12-27/2adults?sort=bestflight_a");
    expect(links[3].url).toBe("https://www.expedia.com/go/flight/search/Roundtrip/2026-12-19/2026-12-27?load=1&FromAirport=PDX&ToAirport=MCO&FromTime=362&ToTime=362&NumAdult=2");
  });

  it("lists what each provider could not be prefilled with", () => {
    expect(links[0].unfilled).toEqual([{ label: "Travelers", value: "2 adults" }]);
    expect(links[1].unfilled).toEqual([]);
  });

  it("produces unfilled lists the handoffs table accepts", () => {
    for (const kind of ["flight", "lodging", "car", "ride", "meal"] as const) {
      for (const proposal of proposeSearch(kind, ctx)) {
        for (const link of handoffLinks(proposal, ctx)) {
          expect(unfilledListSchema.safeParse(link.unfilled).success, `${proposal.key} ${link.provider}`).toBe(true);
        }
      }
    }
  });

  it("uses the plan's currency and any partner ids", () => {
    const euros = contextFor(hartley({ plan: makePlan({ currency: "EUR" }) }), { partnerIds: { skyscannerMediaPartnerId: "777", uberClientId: "abc" } });
    const [proposal] = proposeSearch("flight", euros);
    const result = handoffLinks(proposal, euros);
    expect(result[0].url.endsWith("&curr=EUR")).toBe(true);
    expect(result[2]).toMatchObject({ provider: "skyscanner", grade: "documented" });
    expect(result[2].url).toContain("mediaPartnerId=777");
    const [ride] = proposeSearch("ride", euros);
    expect(handoffLinks(ride, euros)[0].url).toContain("client_id=abc");
  });
});

describe("handoffLinks: falling back to the home page", () => {
  it("opens the provider's home page, with everything to copy, when the search is missing something the link needs", () => {
    const bare = contextFor(planData({ plan: makePlan({ destination: null }) }));
    const [proposal] = proposeSearch("flight", bare);
    const links = handoffLinks(proposal, bare);
    expect(links.map((l) => [l.provider, l.url, l.prefilled])).toEqual([
      ["google_flights", "https://www.google.com/travel/flights", false],
      ["kayak", "https://www.kayak.com/flights", false],
      ["skyscanner", "https://www.skyscanner.com/", false],
      ["expedia", "https://www.expedia.com/", false],
    ]);
    expect(links[0].unfilled).toEqual([
      { label: "Flying from", value: "Seattle-Tacoma International Airport (SEA)" },
      { label: "Leaving", value: "Sat, Dec 19" },
      { label: "Coming back", value: "Sun, Dec 27" },
      { label: "Who's flying", value: "9 adults" },
      { label: "Cabin", value: "Economy" },
    ]);
  });

  it("does the same for a provider switched off through the context", () => {
    const off = contextFor(hartley(), { disabledProviders: ["kayak"] });
    const [proposal] = proposeSearch("flight", off);
    const kayak = handoffLinks(proposal, off).find((l) => l.provider === "kayak");
    expect(kayak).toMatchObject({ url: "https://www.kayak.com/flights", prefilled: false });
    expect(kayak?.unfilled.map((u) => u.label)).toEqual(["Flying from", "Flying to", "Leaving", "Coming back", "Who's flying", "Cabin"]);
    // The others are untouched.
    expect(handoffLinks(proposal, off).filter((l) => l.prefilled).map((l) => l.provider)).toEqual(["google_flights", "skyscanner", "expedia"]);
  });

  it("does the same for a provider switched off in the registry", () => {
    const registry = PROVIDERS as Record<ProviderId, { disabled: boolean }>;
    registry.turo.disabled = true;
    try {
      const [car] = proposeSearch("car", ctx);
      const turo = handoffLinks(car, ctx).find((l) => l.provider === "turo");
      expect(turo).toMatchObject({ url: "https://turo.com/", prefilled: false });
      expect(turo?.unfilled.length).toBeGreaterThan(0);
    } finally {
      registry.turo.disabled = false;
    }
  });

  it("never throws, whatever is missing, and every link is a web address", () => {
    const plans = [planData(), planData({ plan: makePlan({ destination: null, startDate: null, endDate: null, expectedPeople: 0 }) }), hartley({ bookings: [] }), hartley({ bookings: [SEATTLE_FLIGHTS] })];
    for (const data of plans) {
      const c = contextFor(data, { airport: undefined, homeAirportIata: null });
      for (const kind of ["flight", "lodging", "car", "ride", "meal"] as const) {
        for (const proposal of proposeSearch(kind, c)) {
          for (const link of handoffLinks(proposal, c)) {
            expect(() => new URL(link.url)).not.toThrow();
            expect(new URL(link.url).protocol).toBe("https:");
          }
        }
      }
    }
  });

  it("gives ride and food fallbacks the address to type, not the nickname", () => {
    const [dinner] = proposeSearch("meal", ctx);
    const doordash = handoffLinks(dinner, ctx)[0];
    expect(doordash).toMatchObject({ provider: "doordash", url: "https://www.doordash.com/", prefilled: false });
    expect(doordash.unfilled).toEqual([
      { label: "Deliver to", value: "1420 Lake Shore Dr, Orlando, FL 32803" },
      { label: "Deliver at", value: "Sat, Dec 19, 6:30 PM – 7:30 PM" },
      { label: "How many", value: "9 people" },
      { label: "Dietary needs", value: "1 vegetarian, 1 nut allergy" },
    ]);
  });
});

describe("handoffLinks: the order fits the situation", () => {
  it("shows a big family whole homes first", () => {
    const [stay] = proposeSearch("lodging", ctx);
    expect(providers(handoffLinks(stay, ctx))).toEqual(["vrbo", "airbnb", "booking", "hotels", "expedia"]);
  });

  it("shows a work trip hotels first", () => {
    const work = contextFor(planData({ plan: makePlan({ template: "work", workMode: "travel", expectedPeople: 1 }) }));
    const [stay] = proposeSearch("lodging", work);
    expect(providers(handoffLinks(stay, work))).toEqual(["booking", "hotels", "expedia", "airbnb", "vrbo"]);
  });

  it("offers nothing to book when staying with family", () => {
    const [stay] = proposeSearch("lodging", ctx);
    expect(handoffLinks(reviseProposal(stay, { lodgingType: "family_home" }), ctx)).toEqual([]);
  });

  it("adds catering for a work event, first when the order is catering", () => {
    const work = contextFor(planData({ plan: makePlan({ template: "work", workMode: "event", startDate: "2027-01-12", endDate: "2027-01-15" }) }));
    const [catering, dinner, groceries] = proposeSearch("meal", work);
    expect(providers(handoffLinks(catering, work))).toEqual(["ezcater", "grubhub", "doordash", "uber_eats"]);
    // Weeks ahead, only the caterer takes orders yet, so it leads even for a restaurant dinner.
    expect(providers(handoffLinks(dinner, work))).toEqual(["ezcater", "doordash", "uber_eats", "grubhub"]);
    expect(providers(handoffLinks(groceries, work))).toEqual(["instacart"]);
    // Two days before, everyone is taking orders and the usual order holds, catering last.
    const close = contextFor(work.data, { now: new Date("2027-01-10T18:00:00Z") });
    expect(providers(handoffLinks(proposeSearch("meal", close)[1], close))).toEqual(["doordash", "uber_eats", "grubhub", "ezcater"]);
    // A family dinner has no caterer in the list.
    const [family] = proposeSearch("meal", ctx);
    expect(providers(handoffLinks(family, ctx))).toEqual(["doordash", "uber_eats", "grubhub"]);
  });

  it("puts the food providers already taking orders first, and says when the others open", () => {
    // Dec 13: six days before. Only Uber Eats (7 days) is open.
    const sixDays = contextFor(hartley(), { now: new Date("2026-12-13T15:00:00Z") });
    const [dinner] = proposeSearch("meal", sixDays);
    const links = handoffLinks(dinner, sixDays);
    expect(links.map((l) => [l.provider, l.note])).toEqual([
      ["uber_eats", "Uber Eats takes orders 7 days ahead, so you can order now."],
      ["doordash", "DoorDash takes orders 4 days ahead. Ordering opens Tue, Dec 15."],
      ["grubhub", "Grubhub takes orders 4 days ahead. Ordering opens Tue, Dec 15."],
    ]);
  });

  it("prefills a food search once the person says what they want", () => {
    const [dinner] = proposeSearch("meal", ctx);
    const pizza = reviseProposal(dinner, { searchText: "pizza" });
    const links = handoffLinks(pizza, ctx);
    expect(links.map((l) => [l.provider, l.url, l.prefilled])).toEqual([
      ["doordash", "https://www.doordash.com/search/store/pizza/", true],
      ["uber_eats", "https://www.ubereats.com/search?q=pizza", true],
      ["grubhub", "https://www.grubhub.com/search?queryText=pizza&orderMethod=delivery&locationMode=DELIVERY&latitude=28.5632&longitude=-81.3601", true],
    ]);
    expect(links[0].unfilled[0]).toEqual({ label: "Deliver to", value: "1420 Lake Shore Dr, Orlando, FL 32803" });
  });

  it("offers Uber and Lyft, then directions, for a ride; directions only when someone is driving", () => {
    const [ride] = proposeSearch("ride", ctx);
    expect(providers(handoffLinks(ride, ctx))).toEqual(["uber", "lyft", "google_maps", "apple_maps"]);
    expect(providers(handoffLinks(reviseProposal(ride, { rideType: "personal_pickup" }), ctx))).toEqual(["google_maps", "apple_maps"]);
    expect(providers(handoffLinks(reviseProposal(ride, { rideType: "shuttle" }), ctx))).toEqual(["google_maps", "apple_maps", "uber", "lyft"]);
  });

  it("leaves Apple Maps out on devices that are not Apple's", () => {
    const android = contextFor(hartley(), { platform: "other" });
    const [ride] = proposeSearch("ride", android);
    expect(providers(handoffLinks(ride, android))).toEqual(["uber", "lyft", "google_maps"]);
  });

  it("says that a ride's time is set in the app, and lists the time to enter", () => {
    const seattle = proposeSearch("ride", ctx).find((p) => p.key === "ride:arrival:a-sea-in");
    if (!seattle) throw new Error("no proposal");
    const [uber, lyft] = handoffLinks(seattle, ctx);
    expect(uber.note).toBe("Uber can't take a time from a link. Choose Reserve in the app and enter the pick-up time.");
    expect(lyft.note).toBe("Lyft can't take a time from a link. Choose Schedule in the app and enter the pick-up time.");
    expect(uber.unfilled[0]).toEqual({ label: "Pick-up time", value: "Sat, Dec 19, 4:40 PM" });
    expect(uber.url).toContain("dropoff%5Blatitude%5D=28.5632");
    expect(lyft.url).toBe("https://lyft.com/ride?id=lyft&pickup%5Blatitude%5D=28.4312&pickup%5Blongitude%5D=-81.3081&destination%5Blatitude%5D=28.5632&destination%5Blongitude%5D=-81.3601");
  });

  it("falls back for Uber and Lyft when the airport's location is not known", () => {
    const noLookup = contextFor(hartley({ arrivals: [], bookings: [SEATTLE_FLIGHTS] }), { airport: undefined });
    const [ride] = proposeSearch("ride", noLookup);
    const links = handoffLinks(ride, noLookup);
    // The drop-off is the city of Orlando, which has coordinates; the airport pick-up has none.
    expect(links.find((l) => l.provider === "uber")).toMatchObject({ prefilled: true });
    expect(links.find((l) => l.provider === "uber")?.url).toContain("pickup=my_location");
    expect(links.find((l) => l.provider === "lyft")).toMatchObject({ prefilled: false, url: "https://www.lyft.com/" });
  });

  it("puts Kayak first for a trip with several stops, the only one that takes them", () => {
    const [flight] = proposeSearch("flight", ctx);
    const multi = reviseProposal(flight, { tripType: "multi_city", legs: [{ originIata: "MCO", destinationIata: "MIA", date: "2026-12-23" }] });
    const links = handoffLinks(multi, ctx);
    expect(providers(links)).toEqual(["kayak", "google_flights", "skyscanner", "expedia"]);
    expect(links[0].url).toBe("https://www.kayak.com/flights/PDX-MCO/2026-12-19/MCO-MIA/2026-12-23");
    expect(links.slice(1).every((l) => !l.prefilled)).toBe(true);
    expect(links[1].unfilled.find((u) => u.label === "Flight 2")).toEqual({ label: "Flight 2", value: "MCO to MIA, Wed, Dec 23" });
  });

  it("moves the provider used last time to the front, unless the answer was 'not this one'", () => {
    const used = contextFor(hartley({ handoffs: [makeHandoff({ id: "h1", bookingId: "b-car", provider: "turo", openedAt: new Date("2026-11-20T18:00:00Z") })] }));
    const [car] = proposeSearch("car", used);
    expect(providers(handoffLinks(car, used))).toEqual(["turo", "kayak", "expedia"]);
    expect(providerOrder(car.query, used)).toEqual(["turo", "kayak", "expedia"]);

    const rejected = contextFor(hartley({ handoffs: [makeHandoff({ id: "h1", bookingId: "b-car", provider: "turo", outcome: "not_this_one" })] }));
    expect(providers(handoffLinks(proposeSearch("car", rejected)[0], rejected))).toEqual(["kayak", "expedia", "turo"]);

    // A car hand-off says nothing about flights.
    expect(providers(handoffLinks(proposeSearch("flight", used)[0], used))[0]).toBe("google_flights");
  });

  it("takes the most recent of several hand-offs", () => {
    const two = contextFor(
      hartley({
        handoffs: [
          makeHandoff({ id: "h1", bookingId: "b-car", provider: "turo", openedAt: new Date("2026-11-20T18:00:00Z") }),
          makeHandoff({ id: "h2", bookingId: "b-car", provider: "expedia", openedAt: new Date("2026-11-22T18:00:00Z") }),
        ],
      }),
    );
    expect(providers(handoffLinks(proposeSearch("car", two)[0], two))).toEqual(["expedia", "kayak", "turo"]);
  });
});

describe("handoffLinks for a booking row", () => {
  it("builds the same links for a car that still needs booking as for the proposal", () => {
    const fromBooking = handoffLinks(CAR_NEEDED, ctx);
    const fromProposal = handoffLinks(proposeSearch("car", ctx)[0], ctx);
    expect(fromBooking).toEqual(fromProposal);
    expect(fromBooking[1].url).toBe("https://www.expedia.com/go/car/search/Airport/2026-12-19/2026-12-27?PickUpLoc=mco&DiffDropLoc=0&PickUpTime=5PM&DropTime=8AM&Class=NoPreference");
  });

  it("lays what the booking already says over what the plan would propose", () => {
    const planned = makeBooking("car", {
      id: "b-car",
      status: "planned",
      title: "Car",
      details: { pickupPlace: AIRPORTS.MCO, pickupAt: { at: "2026-12-19T23:00:00Z", tz: "America/New_York" }, returnAt: { at: "2026-12-27T12:30:00Z", tz: "America/New_York" }, seats: 7 },
    });
    const proposal = proposalForBooking(planned, ctx);
    expect(proposal?.kind === "car" && proposal.query).toMatchObject({ pickupDate: "2026-12-19", pickupTime: "18:00", returnDate: "2026-12-27", returnTime: "07:30", seats: 7 });
    // The person's own time carries no "because"; the untouched place keeps its reason.
    expect(proposal?.fields.find((f) => f.key === "pickup")?.because).toBeUndefined();
    const kayak = handoffLinks(planned, ctx)[0];
    expect(kayak.unfilled).toEqual([
      { label: "Pick-up time", value: "6:00 PM" },
      { label: "Return time", value: "7:30 AM" },
      { label: "Seats needed", value: "7, so look for a minivan or a large SUV" },
      { label: "Child seats", value: "1" },
    ]);
  });

  it("rebuilds a flight search from a saved search, keeping the people it covers", () => {
    const needed = makeBooking("flight", {
      id: "b-flight-pdx",
      status: "looking",
      title: "Flights for Portland",
      personIds: ["p-dana", "p-chris"],
      details: { tripType: "round_trip", cabin: "business", search: { originIata: "PDX", destinationIata: "MCO", departDate: "2026-12-18", returnDate: "2026-12-28", adults: 1, children: 0, infants: 0 } },
    });
    const links = handoffLinks(needed, ctx);
    // Business: Kayak carries it in the path, Expedia switches to its observed page.
    expect(links[1].url).toBe("https://www.kayak.com/flights/PDX-MCO/2026-12-18/2026-12-28/business/2adults?sort=bestflight_a");
    expect(links[3].url).toBe(
      "https://www.expedia.com/Flights-Search?trip=roundtrip&leg1=from:PDX,to:MCO,departure:12/18/2026TANYT&leg2=from:MCO,to:PDX,departure:12/28/2026TANYT&passengers=adults:2,children:0,seniors:0,infantinlap:Y&options=cabinclass:business&mode=search",
    );
    expect(links[3].grade).toBe("observed");
  });

  it("reads a recorded flight's route and days from its segments", () => {
    const proposal = proposalForBooking(SEATTLE_FLIGHTS, ctx);
    expect(proposal?.kind === "flight" && proposal.query).toMatchObject({ originIata: "SEA", destinationIata: "MCO", departDate: "2026-12-19", returnDate: "2026-12-27", tripType: "round_trip", adults: 2, children: 2 });
  });

  it("uses a stay's own place, dates and people", () => {
    const links = handoffLinks(LAKESIDE_STAY, ctx);
    expect(providers(links)).toEqual(["vrbo", "airbnb", "booking", "hotels", "expedia"]);
    expect(links[1].url).toBe("https://www.airbnb.com/s/Orlando--FL/homes?checkin=2026-12-19&checkout=2026-12-27&adults=7&children=2&infants=0&pets=0");
  });

  it("finds the ride that meets a booking's landing", () => {
    const ride = makeBooking("ride", { id: "b-ride", status: "planned", title: "Airport ride", details: { rideType: "rideshare", arrivalIds: ["a-sea-in"] } });
    const proposal = proposalForBooking(ride, contextFor(hartley({ bookings: [SEATTLE_FLIGHTS, LAKESIDE_STAY, ride] })));
    expect(proposal?.key).toBe("ride:arrival:a-sea-in");
    expect(proposal?.kind === "ride" && proposal.query.pickupTime).toBe("16:40");
  });

  it("uses a meal's own window and searches for its restaurant", () => {
    const meal = makeBooking("meal", {
      id: "b-meal",
      status: "planned",
      title: "Dinner",
      details: { mealType: "restaurant_delivery", vendorName: "Luigi's Trattoria", deliverToPlace: LAKESIDE_HOUSE, windowStart: { at: "2026-12-20T00:00:00Z", tz: "America/New_York" }, windowEnd: { at: "2026-12-20T00:30:00Z", tz: "America/New_York" }, headcount: 6 },
    });
    const links = handoffLinks(meal, ctx);
    expect(links[0].url).toBe("https://www.doordash.com/search/store/Luigi's%20Trattoria/");
    expect(links[0].unfilled.slice(0, 3)).toEqual([
      { label: "Deliver to", value: "1420 Lake Shore Dr, Orlando, FL 32803" },
      { label: "Deliver at", value: "Sat, Dec 19, 7:00 PM – 7:30 PM" },
      { label: "How many", value: "6 people" },
    ]);
  });

  it("has nothing to hand off for send ahead", () => {
    const shipment = makeBooking("shipment", { id: "b-ship", title: "Box of gifts" });
    expect(handoffLinks(shipment, ctx)).toEqual([]);
    expect(proposalForBooking(shipment, ctx)).toBeNull();
    expect(hasHandoff("shipment")).toBe(false);
    expect(hasHandoff("flight")).toBe(true);
  });
});

describe("flightStatusLinks", () => {
  it("links to the trackers in the report's formats, with the date in words for Google", () => {
    const links = flightStatusLinks(SEATTLE_FLIGHTS.details.kind === "flight" ? SEATTLE_FLIGHTS.details.segments[0] : ({} as never));
    expect(links.map((l) => [l.provider, l.actionLabel, l.url])).toEqual([
      ["flightaware", "Track AS 1054 on FlightAware", "https://www.flightaware.com/live/flight/ASA1054"],
      ["flightradar24", "Track AS 1054 on Flightradar24", "https://www.flightradar24.com/data/flights/as1054"],
      ["google_search", "Search Google for AS 1054", "https://www.google.com/search?q=AS1054+flight+status+Dec+19"],
    ]);
    expect(links.every((l) => l.tested === false && l.grade === "observed")).toBe(true);
  });

  it("takes the date from the departure airport's own day", () => {
    // 11:30 PM on Dec 18 in Seattle is already Dec 19 in UTC.
    const links = flightStatusLinks({ airlineIata: "UA", flightNumber: "123", departsAt: "2026-12-19T07:30:00Z", originTz: "America/Los_Angeles" });
    expect(links[2].url).toBe("https://www.google.com/search?q=UA123+flight+status+Dec+18");
  });

  it("works from just the airline and number", () => {
    expect(flightStatusLinks({ airlineIata: "ZZ", flightNumber: "7" }).map((l) => l.url)).toEqual([
      "https://www.flightaware.com/live/flight/ZZ7",
      "https://www.flightradar24.com/data/flights/zz7",
      "https://www.google.com/search?q=ZZ7+flight+status",
    ]);
  });
});

describe("mapsLinks", () => {
  it("gives Google Maps then Apple Maps, both documented", () => {
    const links = mapsLinks(AIRPORTS.MCO, LAKESIDE_HOUSE, "driving");
    expect(links.map((l) => [l.provider, l.actionLabel, l.grade, l.url])).toEqual([
      ["google_maps", "Directions in Google Maps", "documented", "https://www.google.com/maps/dir/?api=1&origin=Orlando+International+Airport&destination=1420+Lake+Shore+Dr%2C+Orlando%2C+FL+32803&travelmode=driving"],
      ["apple_maps", "Directions in Apple Maps", "documented", "https://maps.apple.com/directions?source=Orlando%20International%20Airport&destination=1420%20Lake%20Shore%20Dr%2C%20Orlando%2C%20FL%2032803&mode=driving"],
    ]);
  });

  it("starts from where the person is when there is no origin, and defaults to driving", () => {
    const links = mapsLinks(null, "JFK Airport, Queens, NY");
    expect(links[0].url).toBe("https://www.google.com/maps/dir/?api=1&destination=JFK+Airport%2C+Queens%2C+NY&travelmode=driving");
    expect(links[1].url).toBe("https://maps.apple.com/directions?destination=JFK%20Airport%2C%20Queens%2C%20NY&mode=driving");
  });

  it("offers walking and transit, leaves Apple out when asked, and returns nothing without a destination", () => {
    expect(mapsLinks("A", "B", "walking")[0].url).toContain("travelmode=walking");
    expect(mapsLinks("A", "B", "transit", { platform: "other" }).map((l) => l.provider)).toEqual(["google_maps"]);
    expect(mapsLinks("A", "   ")).toEqual([]);
  });
});

describe("the registry and the builders agree", () => {
  it("has a builder for every kind a provider is listed for", () => {
    for (const id of PROVIDER_IDS) {
      for (const kind of Object.keys(PROVIDERS[id].kinds) as Array<"flight" | "lodging" | "car" | "ride" | "meal">) {
        const everyone = contextFor(hartley({ plan: makePlan({ template: "work", workMode: "event" }) }));
        const offered = proposeSearch(kind, everyone).flatMap((proposal) => [
          ...handoffLinks(proposal, everyone),
          ...(proposal.kind === "meal" ? handoffLinks(reviseProposal(proposal, { mealType: "catering" }), everyone) : []),
          ...(proposal.kind === "meal" ? handoffLinks(reviseProposal(proposal, { mealType: "groceries" }), everyone) : []),
        ]);
        expect(offered.some((link) => link.provider === id), `${id} for ${kind}`).toBe(true);
      }
    }
  });
});
