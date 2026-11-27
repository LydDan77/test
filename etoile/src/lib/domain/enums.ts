// Every fixed list of values the data model uses, in one place.
//
// Each list is a const array (so the database schema can type its text columns with it), a
// TypeScript union, and where it helps a Zod enum. These lists are NOT enforced by the database
// (the columns are plain text), so adding a value here needs no migration. Removing or renaming
// one does: rows may still hold it.
//
// No imports from "@/…" in this folder: drizzle-kit loads src/db/schema.ts, which imports these
// files, without the path alias.

import { z } from "zod";

// --- users ------------------------------------------------------------------------------------
export const TIME_STYLES = ["12h_with_24h", "12h", "24h"] as const;
export type TimeStyle = (typeof TIME_STYLES)[number];

export const MILITARY_STYLES = ["1441", "14:41"] as const;
export type MilitaryStyle = (typeof MILITARY_STYLES)[number];

export const UNIT_SYSTEMS = ["imperial", "metric"] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const EXAMPLE_STATES = ["seeded", "removed"] as const;
export type ExampleState = (typeof EXAMPLE_STATES)[number];

// --- places and clocks --------------------------------------------------------------------------
export const PLACE_KINDS = [
  "city", "airport", "lodging", "venue", "home", "address", "pickup_point", "station",
] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export const CLOCK_SOURCES = ["manual", "plan"] as const;
export type ClockSource = (typeof CLOCK_SOURCES)[number];

// --- plans --------------------------------------------------------------------------------------
export const PLAN_TEMPLATES = ["family_event", "trip", "work"] as const;
export type PlanTemplate = (typeof PLAN_TEMPLATES)[number];

export const WORK_MODES = ["travel", "event"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const DATE_STATUSES = ["fixed", "tentative", "undecided"] as const;
export type DateStatus = (typeof DATE_STATUSES)[number];

/** Derived from the dates and archivedAt at read time. Never stored. */
export const PLAN_STATUSES = ["draft", "upcoming", "in_progress", "past", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

// --- bookings -----------------------------------------------------------------------------------
/** Always shown in this order: Flights, Stay, Car, Rides, Food, Send ahead. */
export const BOOKING_KINDS = ["flight", "lodging", "car", "ride", "meal", "shipment"] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];
export const bookingKindSchema = z.enum(BOOKING_KINDS);

export const BOOKING_STATUSES = [
  "needed", "planned", "looking", "booked", "done", "cancelled", "not_needed",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const bookingStatusSchema = z.enum(BOOKING_STATUSES);

export const LINK_GRADES = ["documented", "observed"] as const;
export type LinkGrade = (typeof LINK_GRADES)[number];

export const HANDOFF_OUTCOMES = ["booked", "still_looking", "not_this_one"] as const;
export type HandoffOutcome = (typeof HANDOFF_OUTCOMES)[number];

// --- people -------------------------------------------------------------------------------------
export const PERSON_ROLES = ["organizer", "guest", "speaker", "staff"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const AGE_GROUPS = ["adult", "child", "infant"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export const DIETARY_TAGS = [
  "vegetarian", "vegan", "gluten_free", "nut_allergy", "shellfish_allergy", "kosher", "halal", "other",
] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];
export const dietaryTagSchema = z.enum(DIETARY_TAGS);

export const RSVP_STATUSES = ["not_invited", "invited", "yes", "no", "maybe"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const RSVP_VIAS = ["personal_link", "site_form", "organizer"] as const;
export type RsvpVia = (typeof RSVP_VIAS)[number];

// --- arrivals -----------------------------------------------------------------------------------
export const ARRIVAL_DIRECTIONS = ["arrival", "departure"] as const;
export type ArrivalDirection = (typeof ARRIVAL_DIRECTIONS)[number];

/** "local" means already there. */
export const ARRIVAL_MODES = ["flight", "drive", "train", "bus", "local", "other"] as const;
export type ArrivalMode = (typeof ARRIVAL_MODES)[number];

export const ARRIVAL_SOURCES = ["booking", "guest", "organizer"] as const;
export type ArrivalSource = (typeof ARRIVAL_SOURCES)[number];

export const RIDE_NEEDS = [
  "unknown", "needs_ride", "driver_assigned", "rideshare", "rental_car", "own_car", "not_needed",
] as const;
export type RideNeed = (typeof RIDE_NEEDS)[number];

export const ARRIVAL_STATUSES = [
  "unknown", "scheduled", "en_route", "landed", "picked_up", "arrived", "cancelled",
] as const;
export type ArrivalStatus = (typeof ARRIVAL_STATUSES)[number];

// --- itinerary ----------------------------------------------------------------------------------
/** Only hand-made items are stored. Everything that comes from a booking is derived on read. */
export const ITINERARY_ITEM_TYPES = ["event", "session", "note"] as const;
export type ItineraryItemType = (typeof ITINERARY_ITEM_TYPES)[number];

export const ITEM_VISIBILITIES = ["private", "guests", "public"] as const;
export type ItemVisibility = (typeof ITEM_VISIBILITIES)[number];

export const ITINERARY_STATUSES = ["confirmed", "tentative", "cancelled"] as const;
export type ItineraryStatus = (typeof ITINERARY_STATUSES)[number];

// --- tasks --------------------------------------------------------------------------------------
export const TASK_KINDS = ["todo", "packing", "bring"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_SOURCES = ["template", "user", "rule"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

// --- money --------------------------------------------------------------------------------------
export const PAYMENT_METHODS = ["personal_card", "company_card", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SPLIT_METHODS = ["equal", "by_party", "shares", "exact", "none"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

/** No file uploads in this version, so a receipt is never "attached". */
export const RECEIPT_STATES = ["none", "not_required"] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];

export const EXPENSE_STATUSES = ["planned", "paid", "submitted", "reimbursed"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/**
 * The fixed category list (product spec 13.1), so exports are consistent. Work plans show all
 * of the first fifteen plus "other"; family and trip plans show a shorter list that maps onto
 * these keys (Travel = airfare, Lodging = lodging, Getting around = rideshare_taxi, Food = meals,
 * Activities = activities, Shopping = shopping, Other = other).
 */
export const EXPENSE_CATEGORIES = [
  "airfare", "lodging", "car_rental", "fuel", "rideshare_taxi", "rail_transit", "parking_tolls",
  "mileage", "meals", "meals_with_others", "conference", "shipping", "phone_internet", "supplies",
  "tips", "activities", "shopping", "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const expenseCategorySchema = z.enum(EXPENSE_CATEGORIES);

// --- share page ---------------------------------------------------------------------------------
export const SITE_STATUSES = ["draft", "published", "unpublished"] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export const SITE_ACCESS_LEVELS = ["link", "passcode"] as const;
export type SiteAccess = (typeof SITE_ACCESS_LEVELS)[number];

export const SITE_THEMES = ["invitation", "postcard", "agenda", "departures"] as const;
export type SiteTheme = (typeof SITE_THEMES)[number];

export const SITE_COLOR_SCHEMES = ["auto", "light", "dark"] as const;
export type SiteColorScheme = (typeof SITE_COLOR_SCHEMES)[number];

export const WHO_IS_COMING_LEVELS = ["hidden", "count", "first_names", "names"] as const;
export type WhoIsComing = (typeof WHO_IS_COMING_LEVELS)[number];

export const SECTION_VISIBILITIES = ["everyone", "guests"] as const;
export type SectionVisibility = (typeof SECTION_VISIBILITIES)[number];

/** The section catalog of product spec 9.1, in catalog order. */
export const SITE_SECTION_TYPES = [
  "cover", "announcement", "details", "schedule", "rsvp", "stay", "getting_there", "who",
  "arrivals", "bring", "weather", "local_time", "faq", "contact", "travel_notes", "map", "costs",
  "links", "gifts", "photos", "notes",
] as const;
export type SiteSectionType = (typeof SITE_SECTION_TYPES)[number];

export const RSVP_QUESTION_TYPES = ["text", "choice", "multi", "yes_no", "number"] as const;
export type RsvpQuestionType = (typeof RSVP_QUESTION_TYPES)[number];

/** Built-in questions write to the person and arrival records instead of free answers. */
export const RSVP_BUILT_INS = ["dietary", "arrival", "needs_ride", "staying_where"] as const;
export type RsvpBuiltIn = (typeof RSVP_BUILT_INS)[number];

// --- heads up -----------------------------------------------------------------------------------
/** What a person did with a briefing item. Items themselves are computed, never stored. */
export const BRIEFING_STATES = ["done", "dismissed"] as const;
export type BriefingState = (typeof BRIEFING_STATES)[number];
