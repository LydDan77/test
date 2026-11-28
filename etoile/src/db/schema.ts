// The whole data model (BUILD-SPEC 5.2). This file and the migrations under drizzle/ are frozen
// after the foundation: if you need a column, say so in your report instead of editing here.
// (drizzle/0001 was added by the foundation's own review: see "Integrity" below.)
//
// Conventions
//  - Every table has `id` (short random text from newId()), `createdAt` and `updatedAt`.
//  - Local calendar dates are text `YYYY-MM-DD`. Instants are timestamptz and always sit next
//    to a text column holding their IANA zone.
//  - Money is a whole number of minor units (a 64-bit column, read as a JavaScript number) plus
//    an ISO 4217 currency code, which the database checks is three capital letters.
//  - Fixed lists of values are plain text columns typed from src/lib/domain/enums.ts. The
//    database does not enforce them (adding a value needs no migration); Zod does, at the edge.
//  - jsonb columns are typed with the domain types. Validate with the matching Zod schema
//    before writing: TypeScript only checks the shape you claim, not what a form sent.
//  - Everything hangs off a user or a plan and is deleted with it (ON DELETE CASCADE).
//    References between siblings inside a plan are SET NULL, so removing a booking or a person
//    never silently removes something else. The one thing a person cannot be removed from
//    under is money: a person with settlements cannot be deleted at all (the database refuses),
//    and removePerson() (src/db/people.ts) also refuses one who paid for or shares an expense.
//
// Integrity
//  - A child row belongs to the same plan as its parent, and the database enforces it for the
//    parent/child tree: people and arrivals reference their party by (plan_id, party_id),
//    hand-offs their booking by (plan_id, booking_id), settlements both people by
//    (plan_id, person_id). A row can therefore never sit in one plan and hang off another.
//  - The SET NULL links between siblings (a person's lodging booking, an arrival's driver, a
//    task's assignee, a payer …) are single columns: Postgres can only clear the whole key of a
//    composite reference, and plan_id is NOT NULL. For those, and for the ids inside jsonb
//    (personIds, split parts, seats …), check every id that came from a browser against the
//    plan with requireParty / requirePerson / requireBooking (src/lib/auth/require.ts).
//  - Ids inside jsonb are not foreign keys at all, so they can outlive the row they name.
//    removePerson() cleans them; code that reads them must still tolerate an unknown id.
//
// Relative imports only: drizzle-kit loads this file without the "@/…" alias.

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { newId, newToken } from "../lib/ids";
import type { ActBy, BookingDetails, BookingDetailsOf, UnfilledField } from "../lib/domain/booking";
import {
  AGE_GROUPS,
  ARRIVAL_DIRECTIONS,
  ARRIVAL_MODES,
  ARRIVAL_SOURCES,
  ARRIVAL_STATUSES,
  BOOKING_KINDS,
  BOOKING_STATUSES,
  BRIEFING_STATES,
  CLOCK_SOURCES,
  DATE_STATUSES,
  EXAMPLE_STATES,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  HANDOFF_OUTCOMES,
  ITEM_VISIBILITIES,
  ITINERARY_ITEM_TYPES,
  ITINERARY_STATUSES,
  LINK_GRADES,
  MILITARY_STYLES,
  PAYMENT_METHODS,
  PERSON_ROLES,
  PLAN_TEMPLATES,
  RECEIPT_STATES,
  RIDE_NEEDS,
  RSVP_STATUSES,
  RSVP_VIAS,
  SITE_ACCESS_LEVELS,
  SITE_COLOR_SCHEMES,
  SITE_STATUSES,
  SITE_THEMES,
  TASK_KINDS,
  TASK_SOURCES,
  THEMES,
  TIME_STYLES,
  UNIT_SYSTEMS,
  WHO_IS_COMING_LEVELS,
  WORK_MODES,
  type BookingKind,
  type DietaryTag,
} from "../lib/domain/enums";
import type { ExpenseSplit } from "../lib/domain/expense";
import type { PlaceRef } from "../lib/domain/place";
import type { PlanStop } from "../lib/domain/plan";
import type { Announcement, RsvpAnswers, RsvpQuestion, SiteSection } from "../lib/domain/site";

// --- shared column builders -----------------------------------------------------------------------

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => newId());

const instant = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Minor units of a currency. 64-bit in the database, because a 32-bit column ends at about 21
 * million dollars in cents and at 2.1 billion dong, won or rupiah, which is an ordinary budget
 * in a currency with no decimals. Read as a JavaScript number: moneySchema keeps amounts well
 * inside what a number holds exactly.
 */
const money = (name: string) => bigint(name, { mode: "number" });

/** ISO 4217: three capital letters. A stored "dollars" would break every screen that formats it. */
const isCurrencyCode = (column: AnyPgColumn) => sql`${column} ~ '^[A-Z]{3}$'`;

const timestamps = {
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// --- users, sessions, clocks ----------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: id(),
    /** Always stored lower-cased (the check below enforces it). */
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** Set from the browser's time zone at sign-up; confirmed by the person later. */
    home: jsonb("home").$type<PlaceRef>().notNull(),
    homeAirportIata: text("home_airport_iata"),
    timeStyle: text("time_style", { enum: TIME_STYLES }).notNull().default("12h_with_24h"),
    militaryStyle: text("military_style", { enum: MILITARY_STYLES }).notNull().default("1441"),
    show24hEverywhere: boolean("show_24h_everywhere").notNull().default(false),
    units: text("units", { enum: UNIT_SYSTEMS }).notNull().default("imperial"),
    theme: text("theme", { enum: THEMES }).notNull().default("system"),
    currency: text("currency").notNull().default("USD"),
    clockShowsWeather: boolean("clock_shows_weather").notNull().default(true),
    exampleState: text("example_state", { enum: EXAMPLE_STATES }).notNull().default("seeded"),
    ...timestamps,
  },
  (t) => [
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check("users_currency_code", isCurrencyCode(t.currency)),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    /** SHA-256 (hex) of the opaque token held in the cookie. The raw token is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: instant("expires_at").notNull(),
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId), index("sessions_expires_at_idx").on(t.expiresAt)],
);

export const clocks = pgTable(
  "clocks",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Supplies the name, the zone, and latitude and longitude for sunrise and sunset. */
    place: jsonb("place").$type<PlaceRef>().notNull(),
    /** Overrides the place name. */
    label: text("label"),
    isHome: boolean("is_home").notNull().default(false),
    source: text("source", { enum: CLOCK_SOURCES }).notNull().default("manual"),
    /** Set when `source` is "plan". The clock goes when the plan is deleted. */
    planId: text("plan_id").references((): AnyPgColumn => plans.id, { onDelete: "cascade" }),
    /** A pinned plan clock does not expire. */
    pinned: boolean("pinned").notNull().default(false),
    /** Local date: the plan's end plus 7 days. */
    expiresOn: text("expires_on"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("clocks_user_id_idx").on(t.userId),
    index("clocks_plan_id_idx").on(t.planId),
    // Exactly one home clock per person.
    uniqueIndex("clocks_one_home_per_user").on(t.userId).where(sql`${t.isHome}`),
  ],
);

// --- plans ----------------------------------------------------------------------------------------

export const plans = pgTable(
  "plans",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    template: text("template", { enum: PLAN_TEMPLATES }).notNull(),
    /** Only when `template` is "work". */
    workMode: text("work_mode", { enum: WORK_MODES }),
    title: text("title").notNull(),
    /** The main place. Empty while the person has not decided. */
    destination: jsonb("destination").$type<PlaceRef>(),
    /** Where people set out from. Default: the owner's home. */
    origin: jsonb("origin").$type<PlaceRef>().notNull(),
    /** Extra stops of a multi-stop trip, in travel order. */
    stops: jsonb("stops").$type<PlanStop[]>().notNull().default([]),
    /** Local dates at the destination. Empty means the plan is a draft. */
    startDate: text("start_date"),
    endDate: text("end_date"),
    dateStatus: text("date_status", { enum: DATE_STATUSES }).notNull().default("undecided"),
    /** The destination's zone (the owner's home zone until there is a destination). */
    tz: text("tz").notNull(),
    /** From the new-plan flow; the real count replaces it once people exist. */
    expectedPeople: integer("expected_people").notNull().default(1),
    archivedAt: instant("archived_at"),
    currency: text("currency").notNull().default("USD"),
    /** Minor units of `currency`. */
    budgetTotal: money("budget_total"),
    /** Local date. */
    replyDeadline: text("reply_deadline"),
    projectCode: text("project_code"),
    purpose: text("purpose"),
    /** Booking kinds this plan uses, from the template; editable. */
    kindsInUse: jsonb("kinds_in_use").$type<BookingKind[]>().notNull().default([]),
    /** Kinds the person said they do not need; removed from "what's left". */
    kindsNotNeeded: jsonb("kinds_not_needed").$type<BookingKind[]>().notNull().default([]),
    isExample: boolean("is_example").notNull().default(false),
    // Plan status (draft, upcoming, in progress, past, archived) is derived, not stored.
    // Readiness is computed on read, not stored.
    ...timestamps,
  },
  (t) => [
    index("plans_owner_id_idx").on(t.ownerId),
    index("plans_owner_start_idx").on(t.ownerId, t.startDate),
    check("plans_currency_code", isCurrencyCode(t.currency)),
  ],
);

// --- people ---------------------------------------------------------------------------------------

export const parties = pgTable(
  "parties",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    /** "The Seattle Hartleys". */
    name: text("name").notNull(),
    origin: jsonb("origin").$type<PlaceRef>(),
    /** The personal link for the whole party. A secret: never log it, never show it to other guests. */
    guestToken: text("guest_token")
      .notNull()
      .unique()
      .$defaultFn(() => newToken()),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("parties_plan_id_idx").on(t.planId),
    // The target of the (plan_id, party_id) references on people and arrivals.
    unique("parties_plan_id_id_unique").on(t.planId, t.id),
  ],
);

export const people = pgTable(
  "people",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    /** Every person is in exactly one party (a party of one by default), in the same plan. */
    partyId: text("party_id").notNull(),
    name: text("name").notNull(),
    /** Private: never on a share page. */
    email: text("email"),
    /** Private: never on a share page. */
    phone: text("phone"),
    role: text("role", { enum: PERSON_ROLES }).notNull().default("guest"),
    ageGroup: text("age_group", { enum: AGE_GROUPS }).notNull().default("adult"),
    childAge: integer("child_age"),
    dietaryTags: jsonb("dietary_tags").$type<DietaryTag[]>().notNull().default([]),
    dietaryNote: text("dietary_note"),
    accessNote: text("access_note"),
    canDrive: boolean("can_drive").notNull().default(false),
    vehicleSeats: integer("vehicle_seats"),
    /** Where they are staying. */
    lodgingBookingId: text("lodging_booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
    room: text("room"),
    team: text("team"),
    jobTitle: text("job_title"),
    /** A personal link for one person, when the party link is too broad. A secret. */
    guestToken: text("guest_token").unique(),
    /** Private: organizer only. */
    privateNotes: text("private_notes"),
    // The reply.
    rsvpStatus: text("rsvp_status", { enum: RSVP_STATUSES }).notNull().default("not_invited"),
    rsvpAt: instant("rsvp_at"),
    rsvpVia: text("rsvp_via", { enum: RSVP_VIAS }),
    /** Answers keyed by question id (sites.rsvpQuestions[].id). */
    rsvpAnswers: jsonb("rsvp_answers").$type<RsvpAnswers>().notNull().default({}),
    messageToHost: text("message_to_host"),
    /** True when a name typed on the public form matched nobody and the host must confirm. */
    needsHostConfirmation: boolean("needs_host_confirmation").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("people_plan_id_idx").on(t.planId),
    index("people_party_id_idx").on(t.partyId),
    index("people_lodging_booking_id_idx").on(t.lodgingBookingId),
    // The target of the (plan_id, person_id) references on settlements.
    unique("people_plan_id_id_unique").on(t.planId, t.id),
    // The party must be one of this plan's parties. Removing the party removes its people.
    foreignKey({ name: "people_plan_party_fk", columns: [t.planId, t.partyId], foreignColumns: [parties.planId, parties.id] }).onDelete("cascade"),
  ],
);

export const arrivals = pgTable(
  "arrivals",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    /** The party arriving or leaving: one of this plan's parties. */
    partyId: text("party_id").notNull(),
    /** Who is on it (people.id). */
    personIds: jsonb("person_ids").$type<string[]>().notNull().default([]),
    direction: text("direction", { enum: ARRIVAL_DIRECTIONS }).notNull(),
    mode: text("mode", { enum: ARRIVAL_MODES }).notNull(),
    /**
     * Set with `segmentIndex` when this comes from a recorded flight. Then the time, carrier
     * and number are read from the booking at read time, not from the columns below.
     */
    bookingId: text("booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
    segmentIndex: integer("segment_index"),
    /** When a guest typed it themselves. */
    carrier: text("carrier"),
    number: text("number"),
    /** "Portland" or "PDX". */
    fromLabel: text("from_label"),
    /** The airport, station or venue. */
    toPlace: jsonb("to_place").$type<PlaceRef>(),
    scheduledAt: instant("scheduled_at"),
    /** Zone `scheduledAt` and `expectedAt` are shown in. */
    tz: text("tz"),
    /** A hand-entered update ("now 5:05 PM"). */
    expectedAt: instant("expected_at"),
    source: text("source", { enum: ARRIVAL_SOURCES }).notNull().default("organizer"),
    rideNeed: text("ride_need", { enum: RIDE_NEEDS }).notNull().default("unknown"),
    driverPersonId: text("driver_person_id").references((): AnyPgColumn => people.id, { onDelete: "set null" }),
    rideBookingId: text("ride_booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
    bags: integer("bags"),
    status: text("status", { enum: ARRIVAL_STATUSES }).notNull().default("unknown"),
    statusAt: instant("status_at"),
    /** Who set the status: a person's name, or "guest". */
    statusBy: text("status_by"),
    ...timestamps,
  },
  (t) => [
    index("arrivals_plan_id_idx").on(t.planId),
    index("arrivals_booking_id_idx").on(t.bookingId),
    index("arrivals_driver_person_id_idx").on(t.driverPersonId),
    index("arrivals_ride_booking_id_idx").on(t.rideBookingId),
    // One per party per direction.
    unique("arrivals_party_direction_unique").on(t.partyId, t.direction),
    // The party must be one of this plan's parties. Removing the party removes its arrivals.
    foreignKey({ name: "arrivals_plan_party_fk", columns: [t.planId, t.partyId], foreignColumns: [parties.planId, parties.id] }).onDelete("cascade"),
    check("arrivals_times_have_zone", sql`(${t.scheduledAt} is null and ${t.expectedAt} is null) or ${t.tz} is not null`),
  ],
);

// --- bookings -------------------------------------------------------------------------------------

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: BOOKING_KINDS }).notNull(),
    status: text("status", { enum: BOOKING_STATUSES }).notNull().default("needed"),
    /** Generated ("AS 1054 SEA to MCO"), editable. */
    title: text("title").notNull(),
    /** Who it covers (people.id). */
    personIds: jsonb("person_ids").$type<string[]>().notNull().default([]),
    /** Where it was booked. */
    provider: text("provider"),
    /** Airline, property, rental company, restaurant, carrier. */
    vendorName: text("vendor_name"),
    /** Private: never on a share page. */
    confirmationCode: text("confirmation_code"),
    /** Private: never on a share page. Minor units of `priceCurrency`. */
    priceAmount: money("price_amount"),
    priceCurrency: text("price_currency"),
    paidByPersonId: text("paid_by_person_id").references((): AnyPgColumn => people.id, { onDelete: "set null" }),
    /** The expense created when a price was recorded. */
    expenseId: text("expense_id").references((): AnyPgColumn => expenses.id, { onDelete: "set null" }),
    /** For sorting and the timeline. Each instant carries its zone. */
    startsAt: instant("starts_at"),
    startTz: text("start_tz"),
    endsAt: instant("ends_at"),
    endTz: text("end_tz"),
    /** Recommended, hard and opens-on dates (product spec 10.4). */
    actBy: jsonb("act_by").$type<ActBy>().notNull().default({}),
    /** Free-cancellation deadline. */
    cancelBy: instant("cancel_by"),
    /** True when a guest entered it about themselves. */
    guestProvided: boolean("guest_provided").notNull().default(false),
    /** Private. */
    notes: text("notes"),
    /**
     * Kind-specific fields: one Zod schema per kind in src/lib/domain/booking-<kind>.ts.
     * Write through parseBookingDetails(kind, input). Flight segments and shipment parcels are
     * arrays inside this object.
     */
    details: jsonb("details").$type<BookingDetails>().notNull(),
    ...timestamps,
  },
  (t) => [
    index("bookings_plan_id_idx").on(t.planId),
    index("bookings_plan_kind_idx").on(t.planId, t.kind),
    index("bookings_paid_by_person_id_idx").on(t.paidByPersonId),
    index("bookings_expense_id_idx").on(t.expenseId),
    // The target of the (plan_id, booking_id) reference on hand-offs.
    unique("bookings_plan_id_id_unique").on(t.planId, t.id),
    check("bookings_price_currency_code", sql`${t.priceCurrency} is null or ${isCurrencyCode(t.priceCurrency)}`),
    // details carries its own kind; it must be the booking's kind.
    check("bookings_details_match_kind", sql`${t.details}->>'kind' = ${t.kind}`),
    check("bookings_price_has_currency", sql`${t.priceAmount} is null or ${t.priceCurrency} is not null`),
    check("bookings_start_has_zone", sql`${t.startsAt} is null or ${t.startTz} is not null`),
    check("bookings_end_has_zone", sql`${t.endsAt} is null or ${t.endTz} is not null`),
  ],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: id(),
    /** The booking this link was opened for: one of this plan's bookings. */
    bookingId: text("booking_id").notNull(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    url: text("url").notNull(),
    linkGrade: text("link_grade", { enum: LINK_GRADES }).notNull(),
    /** What the link could not prefill, each with a value to copy. */
    unfilled: jsonb("unfilled").$type<UnfilledField[]>().notNull().default([]),
    openedAt: instant("opened_at").notNull().defaultNow(),
    /** The answer to "Did you book it?". Empty until the person answers. */
    outcome: text("outcome", { enum: HANDOFF_OUTCOMES }),
    resolvedAt: instant("resolved_at"),
    ...timestamps,
  },
  (t) => [
    index("handoffs_booking_id_idx").on(t.bookingId),
    index("handoffs_plan_id_idx").on(t.planId),
    // The booking must be one of this plan's bookings. Removing the booking removes its hand-offs.
    foreignKey({ name: "handoffs_plan_booking_fk", columns: [t.planId, t.bookingId], foreignColumns: [bookings.planId, bookings.id] }).onDelete("cascade"),
  ],
);

// --- schedule and tasks ---------------------------------------------------------------------------

/**
 * Only hand-made items are stored. Flights, check-in and check-out, car pickup and return, rides,
 * meals and shipment due dates are derived from bookings at read time (src/lib/itinerary/derive.ts).
 */
export const itineraryItems = pgTable(
  "itinerary_items",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    type: text("type", { enum: ITINERARY_ITEM_TYPES }).notNull(),
    title: text("title").notNull(),
    /** Empty for an untimed item. */
    startsAt: instant("starts_at"),
    /** The zone of the place where it happens. Always present, even for an untimed item. */
    startTz: text("start_tz").notNull(),
    endsAt: instant("ends_at"),
    endTz: text("end_tz"),
    /** Which day it sits on, local to `startTz`. */
    localDate: text("local_date").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    place: jsonb("place").$type<PlaceRef>(),
    /** people.id list. Empty means everyone. */
    personIds: jsonb("person_ids").$type<string[]>().notNull().default([]),
    /** Events and sessions are usually "public"; set it explicitly. The default is the safe one. */
    visibility: text("visibility", { enum: ITEM_VISIBILITIES }).notNull().default("private"),
    /** Counts toward schedule readiness. */
    isKeyMoment: boolean("is_key_moment").notNull().default(false),
    description: text("description"),
    link: text("link"),
    // Sessions.
    owner: text("owner"),
    room: text("room"),
    track: text("track"),
    status: text("status", { enum: ITINERARY_STATUSES }).notNull().default("confirmed"),
    /** Drives the "Changed" tag on a published agenda. */
    changedAt: instant("changed_at"),
    ...timestamps,
  },
  (t) => [index("itinerary_items_plan_date_idx").on(t.planId, t.localDate)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    /** "bring" items appear in the share page's "Things to bring". */
    kind: text("kind", { enum: TASK_KINDS }).notNull().default("todo"),
    title: text("title").notNull(),
    notes: text("notes"),
    /** Counts toward readiness. */
    essential: boolean("essential").notNull().default(false),
    /** Local date. */
    dueDate: text("due_date"),
    assigneePersonId: text("assignee_person_id").references(() => people.id, { onDelete: "set null" }),
    /** A guest claiming a "bring" item: a known person, or a typed name. */
    claimedByPersonId: text("claimed_by_person_id").references(() => people.id, { onDelete: "set null" }),
    claimedByName: text("claimed_by_name"),
    /** "2 pies". */
    quantity: integer("quantity"),
    done: boolean("done").notNull().default(false),
    doneAt: instant("done_at"),
    source: text("source", { enum: TASK_SOURCES }).notNull().default("user"),
    /** Stable key of the rule or template entry that suggested it, so it is never created twice. */
    ruleKey: text("rule_key"),
    bookingId: text("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("tasks_plan_id_idx").on(t.planId),
    index("tasks_assignee_person_id_idx").on(t.assigneePersonId),
    index("tasks_claimed_by_person_id_idx").on(t.claimedByPersonId),
    index("tasks_booking_id_idx").on(t.bookingId),
    // Rows without a ruleKey are unaffected: NULLs never collide in a unique constraint.
    unique("tasks_plan_rule_key_unique").on(t.planId, t.ruleKey),
  ],
);

// --- money ----------------------------------------------------------------------------------------

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    /** Local date. */
    date: text("date").notNull(),
    merchant: text("merchant").notNull(),
    description: text("description"),
    category: text("category", { enum: EXPENSE_CATEGORIES }).notNull(),
    /** Minor units of `currency`. */
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    /** Empty means the company paid, or it was not recorded. */
    paidByPersonId: text("paid_by_person_id").references(() => people.id, { onDelete: "set null" }),
    paymentMethod: text("payment_method", { enum: PAYMENT_METHODS }).notNull().default("personal_card"),
    split: jsonb("split").$type<ExpenseSplit>().notNull().default({ method: "none", parts: [] }),
    reimbursable: boolean("reimbursable").notNull().default(false),
    billable: boolean("billable").notNull().default(false),
    projectCode: text("project_code"),
    /** Who was at the meal (people.id); finance teams ask. */
    attendeeIds: jsonb("attendee_ids").$type<string[]>().notNull().default([]),
    /** The booking this came from. */
    bookingId: text("booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
    receipt: text("receipt", { enum: RECEIPT_STATES }).notNull().default("none"),
    status: text("status", { enum: EXPENSE_STATUSES }).notNull().default("paid"),
    ...timestamps,
  },
  (t) => [
    index("expenses_plan_date_idx").on(t.planId, t.date),
    index("expenses_paid_by_person_id_idx").on(t.paidByPersonId),
    index("expenses_booking_id_idx").on(t.bookingId),
    check("expenses_currency_code", isCurrencyCode(t.currency)),
  ],
);

export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    // A payment between two people of this plan. A person with payments recorded cannot be
    // deleted: the database refuses (see the references below), so the app has to say "this
    // person has payments recorded" instead of quietly changing everyone else's balance.
    fromPersonId: text("from_person_id").notNull(),
    toPersonId: text("to_person_id").notNull(),
    /** Minor units of `currency`. */
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    /** "Venmo", "cash" … free text. */
    method: text("method"),
    settledAt: instant("settled_at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index("settlements_plan_id_idx").on(t.planId),
    index("settlements_from_person_id_idx").on(t.fromPersonId),
    index("settlements_to_person_id_idx").on(t.toPersonId),
    check("settlements_currency_code", isCurrencyCode(t.currency)),
    // Both people must be people of this plan. NO ACTION, not CASCADE: deleting a person who
    // has a settlement fails. (NO ACTION rather than RESTRICT so that deleting the whole plan
    // still works: it is checked at the end of the statement, when the settlements are gone too.)
    foreignKey({ name: "settlements_plan_from_person_fk", columns: [t.planId, t.fromPersonId], foreignColumns: [people.planId, people.id] }).onDelete("no action"),
    foreignKey({ name: "settlements_plan_to_person_fk", columns: [t.planId, t.toPersonId], foreignColumns: [people.planId, people.id] }).onDelete("no action"),
  ],
);

// --- share page -----------------------------------------------------------------------------------

export const sites = pgTable("sites", {
  id: id(),
  /** One share page per plan. */
  planId: text("plan_id")
    .notNull()
    .unique()
    .references(() => plans.id, { onDelete: "cascade" }),
  /** The page lives at /[slug]. Validate with isValidSlug() (src/lib/slugs.ts) before writing. */
  slug: text("slug").notNull().unique(),
  status: text("status", { enum: SITE_STATUSES }).notNull().default("draft"),
  access: text("access", { enum: SITE_ACCESS_LEVELS }).notNull().default("link"),
  /** hashPassword() of the shared passcode. */
  passcodeHash: text("passcode_hash"),
  theme: text("theme", { enum: SITE_THEMES }).notNull(),
  /** One of the theme's five accents, by name. */
  accent: text("accent").notNull(),
  colorScheme: text("color_scheme", { enum: SITE_COLOR_SCHEMES }).notNull().default("auto"),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  hostLine: text("host_line"),
  /** The pinned host note. */
  announcement: jsonb("announcement").$type<Announcement>(),
  repliesOpen: boolean("replies_open").notNull().default(true),
  /** Local date. */
  replyDeadline: text("reply_deadline"),
  replyByParty: boolean("reply_by_party").notNull().default(true),
  allowMaybe: boolean("allow_maybe").notNull().default(true),
  whoIsComing: text("who_is_coming", { enum: WHO_IS_COMING_LEVELS }).notNull().default("first_names"),
  publishedAt: instant("published_at"),
  /** Local date the page takes itself down: 30 days after the plan ends by default. */
  unpublishOn: text("unpublish_on"),
  /** A plain counter. No tracking of people. */
  viewCount: integer("view_count").notNull().default(0),
  /** Sections in display order. */
  sections: jsonb("sections").$type<SiteSection[]>().notNull().default([]),
  /** Reply questions in the order asked (product spec 7.6). */
  rsvpQuestions: jsonb("rsvp_questions").$type<RsvpQuestion[]>().notNull().default([]),
  ...timestamps,
});

// --- heads up, shared caches ----------------------------------------------------------------------

/** Briefing items are computed on demand; only what the person did with one is stored. */
export const briefingStates = pgTable(
  "briefing_states",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Stable key of the item: rule id, subject and bucket. */
    itemKey: text("item_key").notNull(),
    planId: text("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    state: text("state", { enum: BRIEFING_STATES }).notNull(),
    /** The value band when the person acted. A change of bucket re-opens a dismissed item. */
    bucket: text("bucket").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("briefing_states_user_item_unique").on(t.userId, t.itemKey),
    index("briefing_states_plan_id_idx").on(t.planId),
  ],
);

/** One shared copy of each external feed. Read and write through src/lib/cache.ts. */
export const signalCache = pgTable(
  "signal_cache",
  {
    id: id(),
    key: text("key").notNull().unique(),
    /** When `payload` was fetched (or, if nothing has ever been fetched, when it was last tried). */
    fetchedAt: instant("fetched_at").notNull(),
    /** When to try the source again. */
    expiresAt: instant("expires_at").notNull(),
    /** Whether the most recent attempt succeeded. `payload` keeps the last good value either way. */
    ok: boolean("ok").notNull(),
    payload: jsonb("payload").$type<unknown>(),
    ...timestamps,
  },
  // pruneCached() finds rows nobody has asked for in a long time by this.
  (t) => [index("signal_cache_expires_at_idx").on(t.expiresAt)],
);

/** Fixed-window counters. Read and write through src/lib/rate-limit.ts. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: id(),
    key: text("key").notNull().unique(),
    count: integer("count").notNull(),
    windowStart: instant("window_start").notNull(),
    ...timestamps,
  },
  (t) => [index("rate_limits_window_start_idx").on(t.windowStart)],
);

// --- relations (for db.query.*) -------------------------------------------------------------------
// Only the parent/child tree is declared. Links between siblings (a person's lodging booking, a
// booking's payer …) are plain id columns: load the plan's lists and join them in memory.

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  clocks: many(clocks),
  plans: many(plans),
  briefingStates: many(briefingStates),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const clocksRelations = relations(clocks, ({ one }) => ({
  user: one(users, { fields: [clocks.userId], references: [users.id] }),
  plan: one(plans, { fields: [clocks.planId], references: [plans.id] }),
}));

export const plansRelations = relations(plans, ({ one, many }) => ({
  owner: one(users, { fields: [plans.ownerId], references: [users.id] }),
  parties: many(parties),
  people: many(people),
  arrivals: many(arrivals),
  bookings: many(bookings),
  handoffs: many(handoffs),
  itineraryItems: many(itineraryItems),
  tasks: many(tasks),
  expenses: many(expenses),
  settlements: many(settlements),
  site: one(sites),
  clocks: many(clocks),
  briefingStates: many(briefingStates),
}));

export const partiesRelations = relations(parties, ({ one, many }) => ({
  plan: one(plans, { fields: [parties.planId], references: [plans.id] }),
  people: many(people),
  arrivals: many(arrivals),
}));

export const peopleRelations = relations(people, ({ one }) => ({
  plan: one(plans, { fields: [people.planId], references: [plans.id] }),
  party: one(parties, { fields: [people.partyId], references: [parties.id] }),
}));

export const arrivalsRelations = relations(arrivals, ({ one }) => ({
  plan: one(plans, { fields: [arrivals.planId], references: [plans.id] }),
  party: one(parties, { fields: [arrivals.partyId], references: [parties.id] }),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  plan: one(plans, { fields: [bookings.planId], references: [plans.id] }),
  handoffs: many(handoffs),
}));

export const handoffsRelations = relations(handoffs, ({ one }) => ({
  booking: one(bookings, { fields: [handoffs.bookingId], references: [bookings.id] }),
  plan: one(plans, { fields: [handoffs.planId], references: [plans.id] }),
}));

export const itineraryItemsRelations = relations(itineraryItems, ({ one }) => ({
  plan: one(plans, { fields: [itineraryItems.planId], references: [plans.id] }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  plan: one(plans, { fields: [tasks.planId], references: [plans.id] }),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  plan: one(plans, { fields: [expenses.planId], references: [plans.id] }),
}));

export const settlementsRelations = relations(settlements, ({ one }) => ({
  plan: one(plans, { fields: [settlements.planId], references: [plans.id] }),
}));

export const sitesRelations = relations(sites, ({ one }) => ({
  plan: one(plans, { fields: [sites.planId], references: [plans.id] }),
}));

export const briefingStatesRelations = relations(briefingStates, ({ one }) => ({
  user: one(users, { fields: [briefingStates.userId], references: [users.id] }),
  plan: one(plans, { fields: [briefingStates.planId], references: [plans.id] }),
}));

// --- row types ------------------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Clock = typeof clocks.$inferSelect;
export type NewClock = typeof clocks.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Party = typeof parties.$inferSelect;
export type NewParty = typeof parties.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type Arrival = typeof arrivals.$inferSelect;
export type NewArrival = typeof arrivals.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type Handoff = typeof handoffs.$inferSelect;
export type NewHandoff = typeof handoffs.$inferInsert;
export type ItineraryItem = typeof itineraryItems.$inferSelect;
export type NewItineraryItem = typeof itineraryItems.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
export type Settlement = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;
export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type BriefingStateRow = typeof briefingStates.$inferSelect;
export type NewBriefingStateRow = typeof briefingStates.$inferInsert;
export type SignalCacheRow = typeof signalCache.$inferSelect;
export type RateLimitRow = typeof rateLimits.$inferSelect;

/**
 * A booking row narrowed to one kind: BookingOf<"flight"> has `kind: "flight"` and FlightDetails.
 * Narrow a Booking with isBookingOf(booking, "flight").
 */
export type BookingOf<K extends BookingKind> = Omit<Booking, "kind" | "details"> & {
  kind: K;
  details: BookingDetailsOf<K>;
};

export function isBookingOf<K extends BookingKind>(booking: Booking, kind: K): booking is Booking & BookingOf<K> {
  return booking.kind === kind;
}
