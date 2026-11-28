import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emptyBookingDetails,
  parseBookingDetails,
  type FlightDetails,
  type PlaceRef,
  type ShipmentDetails,
} from "@/lib/domain";
import { isId, isToken } from "@/lib/ids";
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation } from "./errors";
import { getDb, getDbHandle, schema } from "./index";
import { isBookingOf } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const failure = (promise: PromiseLike<unknown>) => Promise.resolve(promise).then(
  () => null,
  (error: unknown) => error,
);

const home: PlaceRef = { kind: "home", name: "Seattle", tz: "America/Los_Angeles", countryCode: "US", lat: 47.61, lon: -122.33 };
const orlando: PlaceRef = { kind: "city", name: "Orlando", region: "FL", countryCode: "US", lat: 28.54, lon: -81.38, tz: "America/New_York" };
const mco: PlaceRef = { kind: "airport", name: "Orlando International", iata: "MCO", countryCode: "US", lat: 28.4294, lon: -81.309, tz: "America/New_York" };
const house: PlaceRef = { kind: "lodging", name: "Lake Butler house", addressLines: ["8800 Lake Butler Blvd"], locality: "Windermere", region: "FL", postalCode: "34786", countryCode: "US", tz: "America/New_York" };

const flightDetails: FlightDetails = {
  kind: "flight",
  tripType: "one_way",
  cabin: "economy",
  search: { originIata: "SEA", destinationIata: "MCO", departDate: "2026-12-19", adults: 2, children: 2, infants: 0 },
  segments: [
    {
      airlineIata: "AS", airlineName: "Alaska Airlines", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO",
      departsAt: "2026-12-19T16:10:00Z", originTz: "America/Los_Angeles", arrivesAt: "2026-12-19T21:35:00Z", destinationTz: "America/New_York",
    },
  ],
};

describe("the test database", () => {
  it("is a private in-memory PGlite with the migrations applied, and is what getDb() returns", async () => {
    const handle = await getDbHandle();
    expect(handle.driver).toBe("pglite");
    expect(handle.location).toBe("memory://");
    expect(await getDb()).toBe(t.db);
    expect(await t.db.select().from(schema.users)).toEqual([]);
  });

  it("has every table of the build spec, and the migration creates exactly those", async () => {
    const expected = [
      "arrivals", "bookings", "briefing_states", "clocks", "expenses", "handoffs", "itinerary_items", "parties",
      "people", "plans", "rate_limits", "sessions", "settlements", "signal_cache", "sites", "tasks", "users",
    ];
    const declared = (Object.values(schema) as unknown[])
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableName(table))
      .sort();
    expect(declared).toEqual(expected);

    const result = await t.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
    const inDatabase = (result as unknown as { rows: { table_name: string }[] }).rows.map((r) => r.table_name);
    expect(inDatabase).toEqual(expected);

    const migration = readFileSync(path.join(process.cwd(), "drizzle", "0000_init.sql"), "utf8");
    for (const table of expected) expect(migration).toContain(`CREATE TABLE "${table}"`);
  });

  it("gives every table id, created_at and updated_at", async () => {
    const result = await t.db.execute(sql`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and column_name in ('id', 'created_at', 'updated_at')`);
    const rows = (result as unknown as { rows: { table_name: string; column_name: string; data_type: string }[] }).rows;
    const byTable = new Map<string, Map<string, string>>();
    for (const row of rows) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Map());
      byTable.get(row.table_name)!.set(row.column_name, row.data_type);
    }
    expect(byTable.size).toBe(17);
    for (const [table, columns] of byTable) {
      expect(columns.get("id"), table).toBe("text");
      expect(columns.get("created_at"), table).toBe("timestamp with time zone");
      expect(columns.get("updated_at"), table).toBe("timestamp with time zone");
    }
  });
});

describe("a representative row in every table", () => {
  // ONE STORY, TOLD IN ORDER. Each test adds rows the later ones build on (the user, then the
  // plan, then its people, bookings …), so this block is run whole: a single test picked out
  // with `-t` fails at once with a message that says so, instead of with a puzzling database
  // error. Tests that stand alone are in the other describe blocks and in people.test.ts.
  const made = {} as Partial<Record<"user" | "plan" | "party" | "lydia" | "mark" | "flight" | "lodging" | "expense", string>>;
  const ids = new Proxy(made, {
    get(target, name: string) {
      const value = target[name as keyof typeof made];
      if (value === undefined) throw new Error(`"${name}" has not been created yet: run this describe block whole, its tests build on one another`);
      return value;
    },
  }) as Record<keyof typeof made, string>;
  /** Long enough for a clock that counts milliseconds to have moved on. */
  const aMoment = () => new Promise((resolve) => setTimeout(resolve, 15));

  it("users", async () => {
    const [user] = await t.db
      .insert(schema.users)
      .values({ email: "lydia@example.com", name: "Lydia Hartley", passwordHash: "scrypt$1$1$1$a$b", home, homeAirportIata: "SEA", currency: "USD" })
      .returning();
    made.user = user.id;
    expect(isId(user.id)).toBe(true);
    expect(user).toMatchObject({
      email: "lydia@example.com", name: "Lydia Hartley", home, homeAirportIata: "SEA",
      timeStyle: "12h_with_24h", militaryStyle: "1441", show24hEverywhere: false, units: "imperial",
      theme: "system", currency: "USD", clockShowsWeather: true, exampleState: "seeded",
    });
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const [read] = await t.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(read).toEqual(user);
  });

  it("users: the email is unique and must be lower-case", async () => {
    const duplicate = await failure(t.db.insert(schema.users).values({ email: "lydia@example.com", name: "Again", passwordHash: "x", home }));
    expect(isUniqueViolation(duplicate)).toBe(true);
    const upper = await failure(t.db.insert(schema.users).values({ email: "Lydia@Example.com", name: "Upper", passwordHash: "x", home }));
    expect(isCheckViolation(upper)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });

  it("sessions", async () => {
    const expiresAt = new Date("2027-01-01T00:00:00Z");
    const [session] = await t.db.insert(schema.sessions).values({ tokenHash: "a".repeat(64), userId: ids.user, expiresAt }).returning();
    expect(session).toMatchObject({ tokenHash: "a".repeat(64), userId: ids.user });
    // timestamptz comes back as a JS Date holding the same instant.
    expect(session.expiresAt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    const again = await failure(t.db.insert(schema.sessions).values({ tokenHash: "a".repeat(64), userId: ids.user, expiresAt }));
    expect(isUniqueViolation(again)).toBe(true);
    const orphan = await failure(t.db.insert(schema.sessions).values({ tokenHash: "b".repeat(64), userId: "nobody", expiresAt }));
    expect(isForeignKeyViolation(orphan)).toBe(true);
  });

  it("plans", async () => {
    const [plan] = await t.db
      .insert(schema.plans)
      .values({
        ownerId: ids.user, template: "family_event", title: "Hartley Family Christmas", destination: orlando, origin: home,
        stops: [{ place: { kind: "city", name: "Savannah", tz: "America/New_York" }, arriveOn: "2026-12-27", leaveOn: "2026-12-29" }],
        startDate: "2026-12-19", endDate: "2026-12-27", dateStatus: "fixed", tz: "America/New_York", expectedPeople: 11,
        currency: "USD", budgetTotal: 650000, replyDeadline: "2026-12-05", purpose: "Everyone together for the holidays",
        kindsInUse: ["flight", "lodging", "car", "ride", "meal", "shipment"], kindsNotNeeded: [], isExample: true,
      })
      .returning();
    made.plan = plan.id;
    expect(plan).toMatchObject({
      template: "family_event", workMode: null, title: "Hartley Family Christmas", destination: orlando, origin: home,
      startDate: "2026-12-19", endDate: "2026-12-27", dateStatus: "fixed", tz: "America/New_York", expectedPeople: 11,
      archivedAt: null, budgetTotal: 650000, replyDeadline: "2026-12-05", projectCode: null,
      kindsInUse: ["flight", "lodging", "car", "ride", "meal", "shipment"], kindsNotNeeded: [], isExample: true,
    });
    expect(plan.stops).toEqual([{ place: { kind: "city", name: "Savannah", tz: "America/New_York" }, arriveOn: "2026-12-27", leaveOn: "2026-12-29" }]);

    // The smallest plan: defaults fill the rest.
    const [draft] = await t.db.insert(schema.plans).values({ ownerId: ids.user, template: "work", workMode: "travel", title: "Denver sales visit", origin: home, tz: "America/Los_Angeles" }).returning();
    expect(draft).toMatchObject({ destination: null, stops: [], startDate: null, endDate: null, dateStatus: "undecided", expectedPeople: 1, currency: "USD", kindsInUse: [], kindsNotNeeded: [], isExample: false, workMode: "travel" });
  });

  it("clocks: one home clock per person", async () => {
    const [homeClock] = await t.db.insert(schema.clocks).values({ userId: ids.user, place: home, isHome: true }).returning();
    expect(homeClock).toMatchObject({ place: home, label: null, isHome: true, source: "manual", planId: null, pinned: false, expiresOn: null, sortOrder: 0 });
    const [planClock] = await t.db
      .insert(schema.clocks)
      .values({ userId: ids.user, place: orlando, label: "Mom and Dad", source: "plan", planId: ids.plan, expiresOn: "2027-01-03", sortOrder: 1 })
      .returning();
    expect(planClock).toMatchObject({ source: "plan", planId: ids.plan, expiresOn: "2027-01-03", label: "Mom and Dad", isHome: false });
    const secondHome = await failure(t.db.insert(schema.clocks).values({ userId: ids.user, place: orlando, isHome: true }));
    expect(isUniqueViolation(secondHome)).toBe(true);
  });

  it("parties", async () => {
    const [party] = await t.db.insert(schema.parties).values({ planId: ids.plan, name: "The Seattle Hartleys", origin: home, notes: "Arriving together", sortOrder: 0 }).returning();
    made.party = party.id;
    expect(party).toMatchObject({ name: "The Seattle Hartleys", origin: home, notes: "Arriving together" });
    // The personal link is a secret token, made by the database layer.
    expect(isToken(party.guestToken)).toBe(true);
    const [other] = await t.db.insert(schema.parties).values({ planId: ids.plan, name: "Grandma June" }).returning();
    expect(other.guestToken).not.toBe(party.guestToken);
    const clash = await failure(t.db.insert(schema.parties).values({ planId: ids.plan, name: "Copycats", guestToken: party.guestToken }));
    expect(isUniqueViolation(clash)).toBe(true);
  });

  it("people", async () => {
    const [lydia] = await t.db
      .insert(schema.people)
      .values({
        planId: ids.plan, partyId: ids.party, name: "Lydia Hartley", email: "lydia@example.com", phone: "+1 206 555 0100", role: "organizer",
        canDrive: true, vehicleSeats: 5, rsvpStatus: "yes", rsvpAt: new Date("2026-11-20T18:00:00Z"), rsvpVia: "organizer",
      })
      .returning();
    made.lydia = lydia.id;
    const [mark] = await t.db
      .insert(schema.people)
      .values({
        planId: ids.plan, partyId: ids.party, name: "Theo Hartley", ageGroup: "child", childAge: 9, dietaryTags: ["vegetarian", "nut_allergy"],
        dietaryNote: "No tree nuts", accessNote: "None", room: "Bunk room", team: null, guestToken: "t".repeat(43), privateNotes: "Bring the inhaler",
        rsvpStatus: "maybe", rsvpVia: "site_form", rsvpAnswers: { q1: ["Vegetarian"], q2: "Saturday", q3: true, q4: 2 }, messageToHost: "Can't wait", needsHostConfirmation: true,
      })
      .returning();
    made.mark = mark.id;
    expect(lydia).toMatchObject({ role: "organizer", ageGroup: "adult", childAge: null, dietaryTags: [], canDrive: true, vehicleSeats: 5, rsvpStatus: "yes", rsvpVia: "organizer", rsvpAnswers: {}, needsHostConfirmation: false, guestToken: null });
    expect(lydia.rsvpAt?.toISOString()).toBe("2026-11-20T18:00:00.000Z");
    expect(mark).toMatchObject({
      role: "guest", ageGroup: "child", childAge: 9, dietaryTags: ["vegetarian", "nut_allergy"], dietaryNote: "No tree nuts", room: "Bunk room",
      privateNotes: "Bring the inhaler", rsvpStatus: "maybe", rsvpAnswers: { q1: ["Vegetarian"], q2: "Saturday", q3: true, q4: 2 }, messageToHost: "Can't wait", needsHostConfirmation: true,
    });
    const sameToken = await failure(t.db.insert(schema.people).values({ planId: ids.plan, partyId: ids.party, name: "Clone", guestToken: "t".repeat(43) }));
    expect(isUniqueViolation(sameToken)).toBe(true);
  });

  it("bookings: one of each kind, details typed by kind", async () => {
    const [flight] = await t.db
      .insert(schema.bookings)
      .values({
        planId: ids.plan, kind: "flight", status: "booked", title: "AS 1054 SEA to MCO", personIds: [ids.lydia, ids.mark], provider: "alaskaair.com",
        vendorName: "Alaska Airlines", confirmationCode: "KQ7RTX", priceAmount: 124800, priceCurrency: "USD", paidByPersonId: ids.lydia,
        startsAt: new Date("2026-12-19T16:10:00Z"), startTz: "America/Los_Angeles", endsAt: new Date("2026-12-19T21:35:00Z"), endTz: "America/New_York",
        actBy: { recommended: "2026-11-28", hard: "2026-12-12" }, cancelBy: new Date("2026-11-27T08:00:00Z"), notes: "Seats together", details: flightDetails,
      })
      .returning();
    made.flight = flight.id;
    expect(flight).toMatchObject({
      kind: "flight", status: "booked", title: "AS 1054 SEA to MCO", personIds: [ids.lydia, ids.mark], confirmationCode: "KQ7RTX",
      priceAmount: 124800, priceCurrency: "USD", paidByPersonId: ids.lydia, expenseId: null, startTz: "America/Los_Angeles", endTz: "America/New_York",
      actBy: { recommended: "2026-11-28", hard: "2026-12-12" }, guestProvided: false, notes: "Seats together",
    });
    expect(flight.details).toEqual(flightDetails);
    expect(flight.startsAt?.toISOString()).toBe("2026-12-19T16:10:00.000Z");
    // The union narrows on kind.
    if (flight.details.kind === "flight") expect(flight.details.segments[0].destinationIata).toBe("MCO");
    expect(isBookingOf(flight, "flight")).toBe(true);
    expect(isBookingOf(flight, "lodging")).toBe(false);
    // What comes back from the database still passes the schema.
    expect(parseBookingDetails("flight", flight.details)).toEqual({ ok: true, details: flightDetails });

    const lodgingDetails = parseBookingDetails("lodging", { lodgingType: "rental", propertyName: "Lake Butler house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27", accessNotes: "Door code 4471" });
    const shipmentDetails = parseBookingDetails("shipment", { shipmentKind: "gift", destinationType: "vacation_rental", labelLines: ["Lydia Hartley", "8800 Lake Butler Blvd"], arrivalDate: "2026-12-19", shipByDate: "2026-12-10", parcels: [{ trackingNumber: "1Z999AA10123456784", status: "shipped" }] });
    if (!lodgingDetails.ok || !shipmentDetails.ok) throw new Error("fixtures must parse");

    const rest = await t.db
      .insert(schema.bookings)
      .values([
        { planId: ids.plan, kind: "lodging", status: "booked", title: "Lake Butler house", details: lodgingDetails.details },
        { planId: ids.plan, kind: "car", title: "Minivan from MCO", details: { ...emptyBookingDetails("car"), company: "Alamo", pickupPlace: mco, pickupAt: { at: "2026-12-19T22:15:00Z", tz: "America/New_York" } } },
        { planId: ids.plan, kind: "ride", status: "planned", title: "Airport pickup", details: { ...emptyBookingDetails("ride"), rideType: "personal_pickup", fromPlace: mco, toPlace: house, passengerIds: [ids.mark] } },
        { planId: ids.plan, kind: "meal", status: "planned", title: "Groceries for arrival night", guestProvided: false, details: { ...emptyBookingDetails("meal"), mealType: "groceries", headcount: 11, list: [{ name: "Milk", quantity: 2 }] } },
        { planId: ids.plan, kind: "shipment", status: "looking", title: "Box of gifts", provider: "ups", details: shipmentDetails.details },
      ])
      .returning();
    expect(rest.map((b) => b.kind)).toEqual(["lodging", "car", "ride", "meal", "shipment"]);
    expect(rest.map((b) => b.details.kind)).toEqual(["lodging", "car", "ride", "meal", "shipment"]);
    expect(rest[1]).toMatchObject({ status: "needed", personIds: [], actBy: {}, priceAmount: null, startsAt: null });
    made.lodging = rest[0].id;
    const shipment = rest[4].details as ShipmentDetails;
    expect(shipment.parcels[0]).toEqual({ trackingNumber: "1Z999AA10123456784", status: "shipped" });
    expect(shipment.international).toBe(false);

    await t.db.update(schema.people).set({ lodgingBookingId: ids.lodging }).where(eq(schema.people.id, ids.mark));
  });

  it("bookings: the database refuses details of the wrong kind, a price without a currency and a time without a zone", async () => {
    const wrongKind = await failure(t.db.insert(schema.bookings).values({ planId: ids.plan, kind: "car", title: "Mismatch", details: flightDetails }));
    expect(isCheckViolation(wrongKind)).toBe(true);
    const noCurrency = await failure(t.db.insert(schema.bookings).values({ planId: ids.plan, kind: "car", title: "No currency", priceAmount: 100, details: emptyBookingDetails("car") }));
    expect(isCheckViolation(noCurrency)).toBe(true);
    const noZone = await failure(t.db.insert(schema.bookings).values({ planId: ids.plan, kind: "car", title: "No zone", startsAt: new Date(), details: emptyBookingDetails("car") }));
    expect(isCheckViolation(noZone)).toBe(true);
    const noEndZone = await failure(t.db.insert(schema.bookings).values({ planId: ids.plan, kind: "car", title: "No end zone", endsAt: new Date(), details: emptyBookingDetails("car") }));
    expect(isCheckViolation(noEndZone)).toBe(true);
  });

  it("handoffs", async () => {
    const [handoff] = await t.db
      .insert(schema.handoffs)
      .values({
        bookingId: ids.flight, planId: ids.plan, provider: "google_flights", url: "https://www.google.com/travel/flights?q=SEA%20to%20MCO", linkGrade: "observed",
        unfilled: [{ label: "Child ages", value: "9, 6" }],
      })
      .returning();
    expect(handoff).toMatchObject({ provider: "google_flights", linkGrade: "observed", unfilled: [{ label: "Child ages", value: "9, 6" }], outcome: null, resolvedAt: null });
    expect(handoff.openedAt).toBeInstanceOf(Date);
    await aMoment();
    const [resolved] = await t.db.update(schema.handoffs).set({ outcome: "booked", resolvedAt: new Date("2026-11-27T20:00:00Z") }).where(eq(schema.handoffs.id, handoff.id)).returning();
    expect(resolved.outcome).toBe("booked");
    // db.update() moves updatedAt on by itself; createdAt stays.
    expect(resolved.updatedAt.getTime()).toBeGreaterThan(handoff.updatedAt.getTime());
    expect(resolved.createdAt.getTime()).toBe(handoff.createdAt.getTime());
  });

  it("arrivals: one per party per direction", async () => {
    const [arrival] = await t.db
      .insert(schema.arrivals)
      .values({
        planId: ids.plan, partyId: ids.party, personIds: [ids.lydia, ids.mark], direction: "arrival", mode: "flight", bookingId: ids.flight, segmentIndex: 0,
        fromLabel: "SEA", toPlace: mco, scheduledAt: new Date("2026-12-19T21:35:00Z"), tz: "America/New_York", expectedAt: new Date("2026-12-19T22:05:00Z"),
        source: "booking", rideNeed: "driver_assigned", driverPersonId: ids.lydia, bags: 4, status: "scheduled", statusAt: new Date("2026-12-19T12:00:00Z"), statusBy: "Lydia",
      })
      .returning();
    expect(arrival).toMatchObject({
      personIds: [ids.lydia, ids.mark], direction: "arrival", mode: "flight", bookingId: ids.flight, segmentIndex: 0, carrier: null, number: null,
      fromLabel: "SEA", toPlace: mco, tz: "America/New_York", source: "booking", rideNeed: "driver_assigned", driverPersonId: ids.lydia, rideBookingId: null, bags: 4, status: "scheduled", statusBy: "Lydia",
    });
    expect(arrival.scheduledAt?.toISOString()).toBe("2026-12-19T21:35:00.000Z");

    const [departure] = await t.db.insert(schema.arrivals).values({ planId: ids.plan, partyId: ids.party, direction: "departure", mode: "drive", carrier: null }).returning();
    expect(departure).toMatchObject({ direction: "departure", mode: "drive", personIds: [], source: "organizer", rideNeed: "unknown", status: "unknown", scheduledAt: null, tz: null });

    const second = await failure(t.db.insert(schema.arrivals).values({ planId: ids.plan, partyId: ids.party, direction: "arrival", mode: "drive" }));
    expect(isUniqueViolation(second)).toBe(true);
    const noZone = await failure(t.db.update(schema.arrivals).set({ scheduledAt: new Date() }).where(eq(schema.arrivals.id, departure.id)));
    expect(isCheckViolation(noZone)).toBe(true);
  });

  it("itinerary_items", async () => {
    const [dinner] = await t.db
      .insert(schema.itineraryItems)
      .values({
        planId: ids.plan, type: "event", title: "Christmas Eve dinner", startsAt: new Date("2026-12-24T23:00:00Z"), startTz: "America/New_York",
        endsAt: new Date("2026-12-25T01:30:00Z"), endTz: "America/New_York", localDate: "2026-12-24", place: house, personIds: [], visibility: "guests",
        isKeyMoment: true, description: "Grandma June's recipe", link: "https://example.com/menu", status: "confirmed", changedAt: new Date("2026-12-20T15:00:00Z"),
      })
      .returning();
    expect(dinner).toMatchObject({ type: "event", title: "Christmas Eve dinner", startTz: "America/New_York", endTz: "America/New_York", localDate: "2026-12-24", allDay: false, place: house, personIds: [], visibility: "guests", isKeyMoment: true, status: "confirmed" });
    const [note] = await t.db.insert(schema.itineraryItems).values({ planId: ids.plan, type: "note", title: "Beach day", startTz: "America/New_York", localDate: "2026-12-22", allDay: true }).returning();
    expect(note).toMatchObject({ startsAt: null, endsAt: null, endTz: null, allDay: true, visibility: "private", isKeyMoment: false, status: "confirmed", owner: null, room: null, track: null });
    const [session] = await t.db.insert(schema.itineraryItems).values({ planId: ids.plan, type: "session", title: "Kickoff", startTz: "America/New_York", localDate: "2026-12-21", owner: "Lydia", room: "Den", track: "Main", visibility: "public", status: "tentative" }).returning();
    expect(session).toMatchObject({ type: "session", owner: "Lydia", room: "Den", track: "Main", visibility: "public", status: "tentative" });
  });

  it("tasks: a suggested task is never created twice", async () => {
    const [task] = await t.db
      .insert(schema.tasks)
      .values({ planId: ids.plan, kind: "todo", title: "Hold the mail", notes: "USPS hold request", essential: true, dueDate: "2026-12-17", assigneePersonId: ids.lydia, source: "rule", ruleKey: "hold-mail", bookingId: ids.flight, sortOrder: 2 })
      .returning();
    expect(task).toMatchObject({ kind: "todo", title: "Hold the mail", essential: true, dueDate: "2026-12-17", assigneePersonId: ids.lydia, done: false, doneAt: null, source: "rule", ruleKey: "hold-mail", bookingId: ids.flight, sortOrder: 2 });
    const [bring] = await t.db.insert(schema.tasks).values({ planId: ids.plan, kind: "bring", title: "Pies", quantity: 2, claimedByName: "Aunt Carol", claimedByPersonId: ids.mark }).returning();
    expect(bring).toMatchObject({ kind: "bring", quantity: 2, claimedByName: "Aunt Carol", claimedByPersonId: ids.mark, source: "user", ruleKey: null, essential: false });

    const again = await failure(t.db.insert(schema.tasks).values({ planId: ids.plan, title: "Hold the mail (again)", source: "rule", ruleKey: "hold-mail" }));
    expect(isUniqueViolation(again)).toBe(true);
    // onConflictDoNothing is how a rule creates its task safely.
    const skipped = await t.db.insert(schema.tasks).values({ planId: ids.plan, title: "Hold the mail (again)", source: "rule", ruleKey: "hold-mail" }).onConflictDoNothing().returning();
    expect(skipped).toEqual([]);
    // Tasks without a rule key never collide.
    await t.db.insert(schema.tasks).values([{ planId: ids.plan, title: "One" }, { planId: ids.plan, title: "Two" }]);
  });

  it("expenses", async () => {
    const [expense] = await t.db
      .insert(schema.expenses)
      .values({
        planId: ids.plan, date: "2026-11-27", merchant: "Alaska Airlines", description: "Flights for four", category: "airfare", amount: 124800, currency: "USD",
        paidByPersonId: ids.lydia, paymentMethod: "personal_card", split: { method: "equal", parts: [{ personId: ids.lydia }, { personId: ids.mark }] },
        reimbursable: false, billable: false, projectCode: null, attendeeIds: [ids.lydia, ids.mark], bookingId: ids.flight, receipt: "not_required", status: "paid",
      })
      .returning();
    made.expense = expense.id;
    expect(expense).toMatchObject({
      date: "2026-11-27", merchant: "Alaska Airlines", category: "airfare", amount: 124800, currency: "USD", paidByPersonId: ids.lydia, paymentMethod: "personal_card",
      split: { method: "equal", parts: [{ personId: ids.lydia }, { personId: ids.mark }] }, attendeeIds: [ids.lydia, ids.mark], bookingId: ids.flight, receipt: "not_required", status: "paid",
    });
    const [plain] = await t.db.insert(schema.expenses).values({ planId: ids.plan, date: "2026-12-20", merchant: "Publix", category: "meals", amount: 18450, currency: "USD" }).returning();
    expect(plain).toMatchObject({ paidByPersonId: null, paymentMethod: "personal_card", split: { method: "none", parts: [] }, reimbursable: false, billable: false, attendeeIds: [], bookingId: null, receipt: "none", status: "paid" });

    // A booking can point at the expense recorded for it.
    const [before] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, ids.flight));
    await aMoment();
    await t.db.update(schema.bookings).set({ expenseId: expense.id }).where(eq(schema.bookings.id, ids.flight));
    const [booking] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, ids.flight));
    expect(booking.expenseId).toBe(expense.id);
    expect(booking.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(booking.updatedAt.getTime()).toBeGreaterThan(booking.createdAt.getTime());
  });

  it("money: amounts past two billion minor units fit, and a currency is three capital letters", async () => {
    // 3,000,000,000 dong is about 120,000 US dollars: an ordinary amount in a currency with no decimals.
    const [big] = await t.db.insert(schema.expenses).values({ planId: ids.plan, date: "2026-12-21", merchant: "Venue", category: "other", amount: 3_000_000_000, currency: "VND" }).returning();
    expect(big.amount).toBe(3_000_000_000);
    expect(typeof big.amount).toBe("number");
    const [budget] = await t.db.update(schema.plans).set({ budgetTotal: 2_500_000_000 }).where(eq(schema.plans.id, ids.plan)).returning();
    expect(budget.budgetTotal).toBe(2_500_000_000);
    const [priced] = await t.db.update(schema.bookings).set({ priceAmount: 9_000_000_000, priceCurrency: "IDR" }).where(eq(schema.bookings.id, ids.lodging)).returning();
    expect(priced.priceAmount).toBe(9_000_000_000);
    // Put things back for the tests that follow.
    await t.db.delete(schema.expenses).where(eq(schema.expenses.id, big.id));
    await t.db.update(schema.plans).set({ budgetTotal: 650000 }).where(eq(schema.plans.id, ids.plan));
    await t.db.update(schema.bookings).set({ priceAmount: null, priceCurrency: null }).where(eq(schema.bookings.id, ids.lodging));

    // A stored "dollars" would break every screen that formats it: the database refuses it.
    for (const bad of ["dollars", "usd", "US", "", "USDX", " USD"]) {
      expect(isCheckViolation(await failure(t.db.update(schema.plans).set({ currency: bad }).where(eq(schema.plans.id, ids.plan)))), bad).toBe(true);
      expect(isCheckViolation(await failure(t.db.update(schema.users).set({ currency: bad }).where(eq(schema.users.id, ids.user)))), bad).toBe(true);
      expect(isCheckViolation(await failure(t.db.insert(schema.expenses).values({ planId: ids.plan, date: "2026-12-21", merchant: "x", category: "other", amount: 1, currency: bad }))), bad).toBe(true);
      expect(isCheckViolation(await failure(t.db.update(schema.bookings).set({ priceAmount: 1, priceCurrency: bad }).where(eq(schema.bookings.id, ids.lodging)))), bad).toBe(true);
      expect(isCheckViolation(await failure(t.db.insert(schema.settlements).values({ planId: ids.plan, fromPersonId: ids.mark, toPersonId: ids.lydia, amount: 1, currency: bad }))), bad).toBe(true);
    }
  });

  it("settlements", async () => {
    const [settlement] = await t.db
      .insert(schema.settlements)
      .values({ planId: ids.plan, fromPersonId: ids.mark, toPersonId: ids.lydia, amount: 62400, currency: "USD", method: "Venmo", settledAt: new Date("2026-12-28T17:00:00Z") })
      .returning();
    expect(settlement).toMatchObject({ fromPersonId: ids.mark, toPersonId: ids.lydia, amount: 62400, currency: "USD", method: "Venmo" });
    expect(settlement.settledAt.toISOString()).toBe("2026-12-28T17:00:00.000Z");
  });

  it("sites: one per plan, one slug each", async () => {
    const [site] = await t.db
      .insert(schema.sites)
      .values({
        planId: ids.plan, slug: "hartley-christmas", status: "published", access: "passcode", passcodeHash: "scrypt$1$1$1$a$b", theme: "invitation", accent: "evergreen",
        colorScheme: "auto", title: "Hartley Family Christmas", subtitle: "Dec 19–27 in Orlando", hostLine: "Hosted by Lydia and Mark",
        announcement: { text: "Dinner moved to 7", postedAt: "2026-12-24T18:00:00Z" }, repliesOpen: true, replyDeadline: "2026-12-05", replyByParty: true, allowMaybe: false,
        whoIsComing: "first_names", publishedAt: new Date("2026-11-27T19:00:00Z"), unpublishOn: "2027-01-26", viewCount: 12,
        sections: [
          { type: "cover", enabled: true, visibility: "everyone", content: {} },
          { type: "faq", enabled: true, visibility: "guests", titleOverride: "Good to know", content: { items: [{ question: "Parking?", answer: "In the driveway." }] } },
        ],
        rsvpQuestions: [{ id: "q1", label: "Any dietary needs?", type: "multi", options: ["Vegetarian", "Vegan"], required: false, builtIn: "dietary" }],
      })
      .returning();
    expect(site).toMatchObject({
      slug: "hartley-christmas", status: "published", access: "passcode", theme: "invitation", accent: "evergreen", colorScheme: "auto", title: "Hartley Family Christmas",
      subtitle: "Dec 19–27 in Orlando", announcement: { text: "Dinner moved to 7", postedAt: "2026-12-24T18:00:00Z" }, repliesOpen: true, replyDeadline: "2026-12-05",
      replyByParty: true, allowMaybe: false, whoIsComing: "first_names", unpublishOn: "2027-01-26", viewCount: 12,
    });
    expect(site.sections).toHaveLength(2);
    expect(site.sections[1]).toEqual({ type: "faq", enabled: true, visibility: "guests", titleOverride: "Good to know", content: { items: [{ question: "Parking?", answer: "In the driveway." }] } });
    expect(site.rsvpQuestions[0]).toMatchObject({ id: "q1", type: "multi", builtIn: "dietary" });

    const secondSite = await failure(t.db.insert(schema.sites).values({ planId: ids.plan, slug: "another", theme: "postcard", accent: "coral", title: "Second" }));
    expect(isUniqueViolation(secondSite)).toBe(true);
    const [otherPlan] = await t.db.insert(schema.plans).values({ ownerId: ids.user, template: "trip", title: "Other", origin: home, tz: "UTC" }).returning();
    const sameSlug = await failure(t.db.insert(schema.sites).values({ planId: otherPlan.id, slug: "hartley-christmas", theme: "postcard", accent: "coral", title: "Clash" }));
    expect(isUniqueViolation(sameSlug)).toBe(true);
    const [defaults] = await t.db.insert(schema.sites).values({ planId: otherPlan.id, slug: "other-trip", theme: "postcard", accent: "coral", title: "Other" }).returning();
    expect(defaults).toMatchObject({ status: "draft", access: "link", passcodeHash: null, colorScheme: "auto", announcement: null, repliesOpen: true, replyByParty: true, allowMaybe: true, whoIsComing: "first_names", publishedAt: null, viewCount: 0, sections: [], rsvpQuestions: [] });
  });

  it("briefing_states: one state per person per item", async () => {
    const [state] = await t.db.insert(schema.briefingStates).values({ userId: ids.user, itemKey: "W3:MCO:2026-12-19", planId: ids.plan, state: "dismissed", bucket: "delay 30 to 59" }).returning();
    expect(state).toMatchObject({ itemKey: "W3:MCO:2026-12-19", planId: ids.plan, state: "dismissed", bucket: "delay 30 to 59" });
    const again = await failure(t.db.insert(schema.briefingStates).values({ userId: ids.user, itemKey: "W3:MCO:2026-12-19", state: "done", bucket: "delay 60+" }));
    expect(isUniqueViolation(again)).toBe(true);
    // Acting on it again replaces the state.
    const [updated] = await t.db
      .insert(schema.briefingStates)
      .values({ userId: ids.user, itemKey: "W3:MCO:2026-12-19", state: "done", bucket: "delay 60+" })
      .onConflictDoUpdate({ target: [schema.briefingStates.userId, schema.briefingStates.itemKey], set: { state: "done", bucket: "delay 60+" } })
      .returning();
    expect(updated).toMatchObject({ id: state.id, state: "done", bucket: "delay 60+" });
    const [noPlan] = await t.db.insert(schema.briefingStates).values({ userId: ids.user, itemKey: "H1:US:2026-12-25", state: "done", bucket: "-" }).returning();
    expect(noPlan.planId).toBeNull();
  });

  it("signal_cache", async () => {
    const [row] = await t.db
      .insert(schema.signalCache)
      .values({ key: "faa:airport-status", fetchedAt: new Date("2026-12-19T12:00:00Z"), expiresAt: new Date("2026-12-19T12:05:00Z"), ok: true, payload: { delays: [{ airport: "ORD", minutes: 45 }] } })
      .returning();
    expect(row).toMatchObject({ key: "faa:airport-status", ok: true, payload: { delays: [{ airport: "ORD", minutes: 45 }] } });
    expect(row.expiresAt.getTime() - row.fetchedAt.getTime()).toBe(5 * 60_000);
    const [empty] = await t.db.insert(schema.signalCache).values({ key: "never-fetched", fetchedAt: new Date(), expiresAt: new Date(), ok: false, payload: null }).returning();
    expect(empty.payload).toBeNull();
    const again = await failure(t.db.insert(schema.signalCache).values({ key: "faa:airport-status", fetchedAt: new Date(), expiresAt: new Date(), ok: true, payload: {} }));
    expect(isUniqueViolation(again)).toBe(true);
  });

  it("rate_limits", async () => {
    const windowStart = new Date("2026-12-19T12:00:00Z");
    const [row] = await t.db.insert(schema.rateLimits).values({ key: "sign-in:abc", count: 3, windowStart }).returning();
    expect(row).toMatchObject({ key: "sign-in:abc", count: 3 });
    expect(row.windowStart.toISOString()).toBe("2026-12-19T12:00:00.000Z");
    const again = await failure(t.db.insert(schema.rateLimits).values({ key: "sign-in:abc", count: 1, windowStart }));
    expect(isUniqueViolation(again)).toBe(true);
  });

  it("reads a whole plan back with a relational query", async () => {
    const plan = await t.db.query.plans.findFirst({
      where: eq(schema.plans.id, ids.plan),
      with: {
        owner: true,
        parties: { with: { people: true, arrivals: true } },
        people: true,
        arrivals: true,
        bookings: { with: { handoffs: true } },
        handoffs: true,
        itineraryItems: { orderBy: schema.itineraryItems.localDate },
        tasks: true,
        expenses: true,
        settlements: true,
        site: true,
        clocks: true,
        briefingStates: true,
      },
    });
    expect(plan?.owner.email).toBe("lydia@example.com");
    expect(plan?.parties).toHaveLength(2);
    expect(plan?.parties.find((p) => p.id === ids.party)?.people.map((p) => p.name).sort()).toEqual(["Lydia Hartley", "Theo Hartley"]);
    expect(plan?.parties.find((p) => p.id === ids.party)?.arrivals).toHaveLength(2);
    expect(plan?.people).toHaveLength(2);
    expect(plan?.arrivals).toHaveLength(2);
    expect(plan?.bookings.map((b) => b.kind).sort()).toEqual(["car", "flight", "lodging", "meal", "ride", "shipment"]);
    expect(plan?.bookings.find((b) => b.id === ids.flight)?.handoffs).toHaveLength(1);
    expect(plan?.handoffs).toHaveLength(1);
    expect(plan?.itineraryItems.map((i) => i.localDate)).toEqual(["2026-12-21", "2026-12-22", "2026-12-24"]);
    expect(plan?.tasks).toHaveLength(4);
    expect(plan?.expenses).toHaveLength(2);
    expect(plan?.settlements).toHaveLength(1);
    expect(plan?.site?.slug).toBe("hartley-christmas");
    expect(plan?.clocks).toHaveLength(1);
    expect(plan?.briefingStates).toHaveLength(1);

    const user = await t.db.query.users.findFirst({ where: eq(schema.users.id, ids.user), with: { sessions: true, clocks: true, plans: true, briefingStates: true } });
    expect(user?.sessions).toHaveLength(1);
    expect(user?.clocks).toHaveLength(2);
    expect(user?.plans).toHaveLength(3);
    expect(user?.briefingStates).toHaveLength(2);
  });

  it("links between siblings are cleared, not cascaded, when one of them is removed", async () => {
    // Removing the lodging booking leaves the person, without a place to stay.
    await t.db.delete(schema.bookings).where(eq(schema.bookings.id, ids.lodging));
    const [mark] = await t.db.select().from(schema.people).where(eq(schema.people.id, ids.mark));
    expect(mark.lodgingBookingId).toBeNull();

    // Removing the expense leaves the booking.
    await t.db.delete(schema.expenses).where(eq(schema.expenses.id, ids.expense));
    const [flight] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, ids.flight));
    expect(flight.expenseId).toBeNull();

    // Removing the flight leaves the arrival and the task, and removes its hand-offs.
    await t.db.delete(schema.bookings).where(eq(schema.bookings.id, ids.flight));
    const arrivals = await t.db.select().from(schema.arrivals).where(eq(schema.arrivals.planId, ids.plan));
    expect(arrivals).toHaveLength(2);
    expect(arrivals.every((a) => a.bookingId === null)).toBe(true);
    const [task] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.ruleKey, "hold-mail"));
    expect(task.bookingId).toBeNull();
    expect(await t.db.select().from(schema.handoffs).where(eq(schema.handoffs.planId, ids.plan))).toEqual([]);
  });

  it("rolls a transaction back when the callback throws", async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await tx.insert(schema.users).values({ email: "rollback@example.com", name: "R", passwordHash: "x", home });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "rollback@example.com"))).toEqual([]);
  });

  it("deleting a plan deletes everything in it; deleting a user deletes everything of theirs", async () => {
    // Make sure every table really has something to lose (the hand-offs went with the flight above).
    const [car] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.planId, ids.plan)).limit(1);
    await t.db.insert(schema.handoffs).values({ bookingId: car.id, planId: ids.plan, provider: "kayak", url: "https://www.kayak.com/cars", linkGrade: "documented" });
    for (const table of [schema.parties, schema.people, schema.arrivals, schema.bookings, schema.handoffs, schema.itineraryItems, schema.tasks, schema.expenses, schema.settlements] as const) {
      expect((await t.db.select().from(table).where(eq(table.planId, ids.plan))).length, `${getTableName(table)} before`).toBeGreaterThan(0);
    }
    expect(await t.db.select().from(schema.sites).where(eq(schema.sites.planId, ids.plan))).toHaveLength(1);
    expect(await t.db.select().from(schema.briefingStates).where(eq(schema.briefingStates.planId, ids.plan))).toHaveLength(1);

    await t.db.delete(schema.plans).where(eq(schema.plans.id, ids.plan));
    for (const table of [schema.parties, schema.people, schema.arrivals, schema.bookings, schema.handoffs, schema.itineraryItems, schema.tasks, schema.expenses, schema.settlements] as const) {
      expect(await t.db.select().from(table).where(eq(table.planId, ids.plan)), getTableName(table)).toEqual([]);
    }
    expect(await t.db.select().from(schema.sites).where(eq(schema.sites.planId, ids.plan))).toEqual([]);
    expect(await t.db.select().from(schema.briefingStates).where(eq(schema.briefingStates.planId, ids.plan))).toEqual([]);
    // The plan's clock went with it; the home clock stays.
    const clocks = await t.db.select().from(schema.clocks).where(eq(schema.clocks.userId, ids.user));
    expect(clocks.map((c) => c.isHome)).toEqual([true]);

    await t.db.delete(schema.users).where(eq(schema.users.id, ids.user));
    expect(await t.db.select().from(schema.plans)).toEqual([]);
    expect(await t.db.select().from(schema.sessions)).toEqual([]);
    expect(await t.db.select().from(schema.clocks)).toEqual([]);
    expect(await t.db.select().from(schema.sites)).toEqual([]);
    expect(await t.db.select().from(schema.briefingStates)).toEqual([]);
    // Shared caches belong to nobody and stay.
    expect((await t.db.select().from(schema.signalCache)).length).toBe(2);
    expect((await t.db.select().from(schema.rateLimits)).length).toBe(1);
  });
});

describe("indexes", () => {
  it("has an index that leads with every foreign-key column, so removing a row never scans a whole table", async () => {
    // For each foreign key, the column that picks out the referencing rows: the key's own column,
    // or for a (plan_id, x) pair the x. Is there an index that starts with it?
    const result = await t.db.execute(sql`
      with keys as (
        select c.conrelid, c.conname, a.attname, a.attnum, array_length(c.conkey, 1) as width
        from pg_constraint c
        join unnest(c.conkey) as k(attnum) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      )
      select k.conrelid::regclass::text as "table", k.conname as "constraint", k.attname as "column"
      from keys k
      where (k.width = 1 or k.attname <> 'plan_id')
        and not exists (select 1 from pg_index i where i.indrelid = k.conrelid and (i.indkey::int2[])[0] = k.attnum)
      order by 1, 3`);
    const missing = (result as unknown as { rows: { table: string; constraint: string; column: string }[] }).rows;
    expect(missing.map((row) => `${row.table}.${row.column}`)).toEqual([]);

    // The check itself can fail: it sees a foreign key with no index when there is one.
    await t.db.execute(sql`create table fk_probe (id text primary key, user_id text references users(id))`);
    const probe = await t.db.execute(sql`
      select 1 from pg_constraint c
      where c.conrelid = 'fk_probe'::regclass and c.contype = 'f'
        and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and (i.indkey::int2[])[0] = c.conkey[1])`);
    expect((probe as unknown as { rows: unknown[] }).rows).toHaveLength(1);
    await t.db.execute(sql`drop table fk_probe`);
  });
});

describe("createTestDb", () => {
  it("gives a fresh, empty database each time it is called", async () => {
    const first = await createTestDb();
    await first.db.insert(schema.users).values({ email: "one@example.com", name: "One", passwordHash: "x", home });
    const second = await createTestDb();
    expect(await second.db.select().from(schema.users)).toEqual([]);
    expect(await getDb()).toBe(second.db);
    expect(await first.db.select().from(schema.users)).toHaveLength(1);
    await first.close();
    // Closing an older database does not disturb the current one.
    expect(await getDb()).toBe(second.db);
    await second.close();
    // Put this file's database back for anything that runs after.
    t = await createTestDb();
  });
});
