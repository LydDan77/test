// Send ahead: every number the date arithmetic depends on, in one place.
//
// Source: research/ship-ahead.md, researched 2026-11-26, and its reference code
// (research/ship-ahead-code/shipby.mjs), ported value for value. Each block says where its numbers
// come from, using the report's own evidence labels:
//
//   (P)  the carrier's or provider's own page
//   (3P) third-party only: a lead, not a fact
//   (H)  the report's heuristic, not a carrier-published number
//   (M)  background knowledge, not confirmed
//
// TO UPDATE EACH YEAR: when UPS and FedEx publish their 2027 schedules, replace the entries
// built with `projected()` below and move CALENDAR_PUBLISHED_THROUGH forward. Nothing else in
// the folder needs to change.

import type { ShipmentDestinationType } from "@/lib/domain";
import type { LocalDate } from "@/lib/time";

/** The day the report's facts were checked. Shown nowhere; here so a reader can judge staleness. */
export const SHIPPING_DATA_AS_OF: LocalDate = "2026-11-26";

// --- carrier calendars ---------------------------------------------------------------------------

/**
 * What a carrier does on a day that is not a normal working day.
 *  - `closed`: no pickup, no delivery.
 *  - `no_pickup`: delivers, but will not collect a ground parcel (UPS on Christmas Eve).
 *  - `air_only`: air and express services move, ground does not (UPS on New Year's Eve).
 *  - `modified`: open, but with early pickup cutoffs and closed drop boxes (FedEx). Fine as a
 *    delivery day, not safe as a ship day.
 */
export type CarrierDayStatus = "closed" | "no_pickup" | "air_only" | "modified";

export type CalendarDay = {
  status: CarrierDayStatus;
  /** The day's name as people say it: "Christmas Eve", "the day after Thanksgiving". */
  name: string;
  /**
   * True when the carrier had not published this date by SHIPPING_DATA_AS_OF, so the entry
   * repeats the carrier's 2026 rule for the same holiday. Re-check before relying on it.
   */
  projected?: true;
};

const published = (status: CarrierDayStatus, name: string): CalendarDay => ({ status, name });
const projected = (status: CarrierDayStatus, name: string): CalendarDay => ({ status, name, projected: true });

/** The carriers with a holiday calendar of their own. */
export const CALENDAR_CARRIERS = ["usps", "ups", "fedex"] as const;
export type CalendarCarrier = (typeof CALENDAR_CARRIERS)[number];

/**
 * Carrier holiday calendars for the 2026 to 2027 season (report section 5.3).
 *
 * USPS: usps.com holiday list and about.usps.com "Holidays & events". 2026 AND 2027 are both
 *       published (P). In 2027 Juneteenth and Christmas fall on Saturdays (closed that Saturday,
 *       open the Friday before) and July 4 is a Sunday (closed Monday July 5).
 * UPS:  ups.com US holiday schedule and the 2026 year-end schedule PDF (P). Published through
 *       2027-01-01 only: EVERY LATER 2027 DATE IS PROJECTED from the 2026 rule.
 * FedEx: "2026 FedEx holiday service schedule (June 2026 update)" PDF (P). Published through
 *       the New Year weekend only: EVERY LATER 2027 DATE IS PROJECTED from the 2026 rule.
 */
export const CARRIER_CALENDAR: Record<CalendarCarrier, Readonly<Record<LocalDate, CalendarDay>>> = {
  usps: {
    "2026-01-01": published("closed", "New Year's Day"),
    "2026-01-19": published("closed", "Martin Luther King Jr. Day"),
    "2026-02-16": published("closed", "Presidents' Day"),
    "2026-05-25": published("closed", "Memorial Day"),
    "2026-06-19": published("closed", "Juneteenth"),
    "2026-07-04": published("closed", "Independence Day"),
    "2026-09-07": published("closed", "Labor Day"),
    "2026-10-12": published("closed", "Columbus Day"),
    "2026-11-11": published("closed", "Veterans Day"),
    "2026-11-26": published("closed", "Thanksgiving"),
    "2026-12-25": published("closed", "Christmas Day"),
    "2027-01-01": published("closed", "New Year's Day"),
    "2027-01-18": published("closed", "Martin Luther King Jr. Day"),
    "2027-02-15": published("closed", "Presidents' Day"),
    "2027-05-31": published("closed", "Memorial Day"),
    "2027-06-19": published("closed", "Juneteenth"),
    "2027-07-05": published("closed", "the Independence Day holiday"),
    "2027-09-06": published("closed", "Labor Day"),
    "2027-10-11": published("closed", "Columbus Day"),
    "2027-11-11": published("closed", "Veterans Day"),
    "2027-11-25": published("closed", "Thanksgiving"),
    "2027-12-25": published("closed", "Christmas Day"),
  },
  ups: {
    "2026-01-01": published("closed", "New Year's Day"),
    "2026-01-19": published("closed", "Martin Luther King Jr. Day"),
    "2026-05-25": published("closed", "Memorial Day"),
    "2026-07-04": published("closed", "Independence Day"),
    "2026-09-07": published("closed", "Labor Day"),
    "2026-11-26": published("closed", "Thanksgiving"),
    "2026-12-24": published("no_pickup", "Christmas Eve"),
    "2026-12-25": published("closed", "Christmas Day"),
    "2026-12-31": published("air_only", "New Year's Eve"),
    "2027-01-01": published("closed", "New Year's Day"),
    // Projected: UPS had not published 2027 beyond January 1 as of 2026-11-26.
    "2027-01-18": projected("closed", "Martin Luther King Jr. Day"),
    "2027-05-31": projected("closed", "Memorial Day"),
    "2027-07-05": projected("closed", "the Independence Day holiday"),
    "2027-09-06": projected("closed", "Labor Day"),
    "2027-11-25": projected("closed", "Thanksgiving"),
    "2027-12-24": projected("no_pickup", "Christmas Eve"),
    "2027-12-25": projected("closed", "Christmas Day"),
    "2027-12-31": projected("air_only", "New Year's Eve"),
  },
  fedex: {
    "2026-01-01": published("closed", "New Year's Day"),
    "2026-01-19": published("modified", "Martin Luther King Jr. Day"),
    "2026-02-16": published("modified", "Presidents' Day"),
    "2026-05-25": published("closed", "Memorial Day"),
    "2026-07-03": published("modified", "the day before Independence Day"),
    "2026-07-04": published("closed", "Independence Day"),
    "2026-09-07": published("closed", "Labor Day"),
    "2026-10-12": published("modified", "Columbus Day"),
    "2026-11-11": published("modified", "Veterans Day"),
    "2026-11-25": published("modified", "the day before Thanksgiving"),
    "2026-11-26": published("closed", "Thanksgiving"),
    "2026-11-27": published("modified", "the day after Thanksgiving"),
    "2026-12-24": published("modified", "Christmas Eve"),
    "2026-12-25": published("closed", "Christmas Day"),
    "2026-12-31": published("modified", "New Year's Eve"),
    "2027-01-01": published("closed", "New Year's Day"),
    // Projected: FedEx had not published 2027 beyond January 1 as of 2026-11-26.
    "2027-01-18": projected("modified", "Martin Luther King Jr. Day"),
    "2027-02-15": projected("modified", "Presidents' Day"),
    "2027-05-31": projected("closed", "Memorial Day"),
    "2027-07-05": projected("modified", "the Independence Day holiday"),
    "2027-09-06": projected("closed", "Labor Day"),
    "2027-10-11": projected("modified", "Columbus Day"),
    "2027-11-11": projected("modified", "Veterans Day"),
    "2027-11-24": projected("modified", "the day before Thanksgiving"),
    "2027-11-25": projected("closed", "Thanksgiving"),
    "2027-11-26": projected("modified", "the day after Thanksgiving"),
    "2027-12-24": projected("modified", "Christmas Eve"),
    "2027-12-25": projected("closed", "Christmas Day"),
    "2027-12-31": projected("modified", "New Year's Eve"),
  },
};

/**
 * The last date each carrier had published when the report was written. A delivery planned after
 * it rests on projected dates, and shipByPlan() says so.
 */
export const CALENDAR_PUBLISHED_THROUGH: Record<CalendarCarrier, LocalDate> = {
  usps: "2027-12-31",
  ups: "2027-01-01",
  fedex: "2027-01-02",
};

/** No calendar here knows any holiday after this date. Past it, holidays are not counted at all. */
export const CALENDAR_COVERS_THROUGH: LocalDate = "2027-12-31";

/**
 * Weekly operating days used for PLANNING, deliberately conservative (report 5.2). 0 = Sunday.
 * UPS and FedEx do run some Saturday and Sunday services; the plan never counts on them.
 * Sunday is never a planning day for anyone.
 */
export const CARRIER_WEEK: Record<CalendarCarrier | "weekdays", readonly number[]> = {
  usps: [1, 2, 3, 4, 5, 6],
  ups: [1, 2, 3, 4, 5],
  fedex: [1, 2, 3, 4, 5],
  weekdays: [1, 2, 3, 4, 5],
};

// --- peak season -----------------------------------------------------------------------------------

/**
 * Peak windows. 2026-27 is UPS's own statement that "a limited number of UPS Ground and UPS
 * Standard packages will require additional time in transit" (P). 2027-28 is projected (H).
 */
export const PEAK_WINDOWS: readonly { from: LocalDate; to: LocalDate; projected?: true }[] = [
  { from: "2026-11-16", to: "2027-01-08" },
  { from: "2027-11-15", to: "2028-01-07", projected: true },
];

/** Extra business days when the ship date or the delivery date falls in a peak window (H, report 5.4). */
export const PEAK_PADDING_DAYS = {
  /** Ground, economy and everything international. */
  ground: 2,
  /** Domestic express: overnight, 2-day, 3-day, Priority Mail. */
  domesticExpress: 1,
} as const;

/** Extra business days when the caller says severe weather is forecast on the route (H, report 5.4). */
export const SEVERE_WEATHER_PADDING_DAYS = 1;

/** Extra business days of arrival buffer for anything crossing a border (H, report 5.5: customs). */
export const INTERNATIONAL_BUFFER_DAYS = 2;

/** After about this hour at the counter, the parcel leaves the next day (H, report 5.2). */
export const DROP_OFF_CUTOFF_HOUR = 15;

// --- transit times ---------------------------------------------------------------------------------

/**
 * Carrier zones by straight-line miles (3P, consistent across sources; report 5.1). Zones 1 and 2
 * share a row. Zone 9 is Alaska, Hawaii, Puerto Rico and the territories, and is never reached by
 * distance: it comes from the postal code.
 */
export const ZONE_MAX_MILES: readonly { zone: number; maxMiles: number }[] = [
  { zone: 2, maxMiles: 150 },
  { zone: 3, maxMiles: 300 },
  { zone: 4, maxMiles: 600 },
  { zone: 5, maxMiles: 1000 },
  { zone: 6, maxMiles: 1400 },
  { zone: 7, maxMiles: 1800 },
  { zone: 8, maxMiles: Number.POSITIVE_INFINITY },
];

/** The zone assumed when nobody knows where the parcel starts: coast to coast. */
export const DEFAULT_ZONE = 8;
/** Alaska, Hawaii, Puerto Rico and the territories. */
export const OFFSHORE_ZONE = 9;

/** Business days in transit: plan with `plan`; `best` is what happens when everything goes right. */
export type TransitDays = { best: number; plan: number };

const days = (best: number, plan: number): TransitDays => ({ best, plan });

/**
 * Ground days per zone. HEURISTIC (H): bounded by the carriers' published ranges (UPS and FedEx
 * Ground 1 to 5 business days, 3 to 7 to Alaska and Hawaii; USPS Ground Advantage 2 to 5 days)
 * but the split per zone is the report's own estimate, not a carrier table.
 */
export const GROUND_DAYS_BY_ZONE: Readonly<Record<number, TransitDays>> = {
  1: days(1, 1), 2: days(1, 1), 3: days(1, 2), 4: days(2, 3), 5: days(2, 3),
  6: days(3, 4), 7: days(4, 5), 8: days(4, 5), 9: days(5, 7),
};
export const USPS_GROUND_ADVANTAGE_DAYS_BY_ZONE: Readonly<Record<number, TransitDays>> = {
  1: days(2, 2), 2: days(2, 2), 3: days(2, 3), 4: days(2, 3), 5: days(3, 4),
  6: days(3, 4), 7: days(4, 5), 8: days(4, 5), 9: days(5, 8),
};

/**
 * Which holiday calendar a service follows.
 *  - a carrier: that carrier's calendar and week;
 *  - `major_holidays`: Monday to Friday, closed on the days BOTH UPS and FedEx close (New Year's
 *    Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, Christmas Day). Used for DHL
 *    and for the luggage services, which ride on those networks. This is our addition (H): the
 *    reference code gave these services no holidays at all, which could plan a delivery for
 *    Christmas Day.
 */
export type ServiceCalendar = CalendarCarrier | "major_holidays";

export type ServiceTransit =
  | { kind: "fixed"; days: TransitDays; offshoreDays?: TransitDays }
  | { kind: "by_zone"; table: "ground" | "usps_ground_advantage" };

export type ServiceConfig = {
  /** The name on the carrier's own menu: "UPS 2nd Day Air". */
  name: string;
  /** Who carries it. A ShipmentProvider value. */
  provider: "ups" | "fedex" | "usps" | "dhl" | "lugless" | "luggage_forward" | "luggage_free";
  calendar: ServiceCalendar;
  /** Air and express services: they move on UPS "air only" days and get the smaller peak padding. */
  air: boolean;
  /** Crosses a border: customs padding and a longer arrival buffer apply. */
  international: boolean;
  /** Business days added for customs (H): 1 for express, 2 for economy and postal. 0 when domestic. */
  customsPadDays: 0 | 1 | 2;
  transit: ServiceTransit;
  /** What the carrier itself claims, for the "how we worked this out" line. */
  carrierClaim: string;
  /** The report's evidence label for the claim. */
  evidence: "P" | "3P" | "H" | "M";
};

/** The carriers and luggage services that have entries in the transit table. */
export type ServiceProvider = ServiceConfig["provider"];

const fixed = (best: number, plan: number): ServiceTransit => ({ kind: "fixed", days: days(best, plan) });

/**
 * The transit table (report 5.1, plus the luggage services' planning numbers from 1.3).
 * Keys are stored in bookings.details.serviceKey; never rename one.
 *
 * Not offered on purpose: USPS First-Class Package International ("varies by destination"),
 * ShipGo (publishes no transit days) and Send My Bag (use the date it quotes at booking, plus
 * 3 working days).
 */
export const SERVICES = {
  // Ground, by distance.
  ups_ground: {
    name: "UPS Ground", provider: "ups", calendar: "ups", air: false, international: false, customsPadDays: 0,
    transit: { kind: "by_zone", table: "ground" },
    carrierClaim: "1 to 5 business days in the 50 states", evidence: "P",
  },
  fedex_ground: {
    name: "FedEx Ground", provider: "fedex", calendar: "fedex", air: false, international: false, customsPadDays: 0,
    transit: { kind: "by_zone", table: "ground" },
    carrierClaim: "1 to 5 business days, 3 to 7 to Alaska and Hawaii", evidence: "P",
  },
  fedex_home_delivery: {
    name: "FedEx Home Delivery", provider: "fedex", calendar: "fedex", air: false, international: false, customsPadDays: 0,
    transit: { kind: "by_zone", table: "ground" },
    carrierClaim: "1 to 5 days, 3 to 7 to Alaska and Hawaii", evidence: "P",
  },
  usps_ground_advantage: {
    name: "USPS Ground Advantage", provider: "usps", calendar: "usps", air: false, international: false, customsPadDays: 0,
    transit: { kind: "by_zone", table: "usps_ground_advantage" },
    carrierClaim: "2 to 5 days", evidence: "P",
  },
  // Domestic express.
  ups_3_day_select: {
    name: "UPS 3 Day Select", provider: "ups", calendar: "ups", air: true, international: false, customsPadDays: 0,
    transit: fixed(3, 3), carrierClaim: "3 business days in the lower 48 states", evidence: "P",
  },
  fedex_express_saver: {
    name: "FedEx Express Saver", provider: "fedex", calendar: "fedex", air: true, international: false, customsPadDays: 0,
    transit: fixed(3, 3), carrierClaim: "the third business day", evidence: "P",
  },
  usps_priority_mail: {
    name: "USPS Priority Mail", provider: "usps", calendar: "usps", air: true, international: false, customsPadDays: 0,
    transit: { kind: "fixed", days: days(2, 3), offshoreDays: days(3, 5) },
    carrierClaim: "2 to 3 business days, not guaranteed", evidence: "P",
  },
  ups_2nd_day_air: {
    name: "UPS 2nd Day Air", provider: "ups", calendar: "ups", air: true, international: false, customsPadDays: 0,
    transit: fixed(2, 2), carrierClaim: "the second business day", evidence: "P",
  },
  fedex_2day: {
    name: "FedEx 2Day", provider: "fedex", calendar: "fedex", air: true, international: false, customsPadDays: 0,
    transit: fixed(2, 2), carrierClaim: "the second business day", evidence: "P",
  },
  ups_next_day_air: {
    name: "UPS Next Day Air", provider: "ups", calendar: "ups", air: true, international: false, customsPadDays: 0,
    transit: fixed(1, 1), carrierClaim: "the next business day", evidence: "P",
  },
  fedex_overnight: {
    name: "FedEx Standard Overnight", provider: "fedex", calendar: "fedex", air: true, international: false, customsPadDays: 0,
    transit: fixed(1, 1), carrierClaim: "the next business day", evidence: "P",
  },
  usps_priority_mail_express: {
    name: "USPS Priority Mail Express", provider: "usps", calendar: "usps", air: true, international: false, customsPadDays: 0,
    transit: fixed(1, 3), carrierClaim: "1 to 3 days, guaranteed", evidence: "P",
  },
  // International, door to door, before customs padding.
  fedex_intl_priority_express: {
    name: "FedEx International Priority", provider: "fedex", calendar: "fedex", air: true, international: true, customsPadDays: 1,
    transit: fixed(1, 3), carrierClaim: "typically 1 to 3 business days", evidence: "P",
  },
  ups_worldwide_express: {
    name: "UPS Worldwide Express", provider: "ups", calendar: "ups", air: true, international: true, customsPadDays: 1,
    transit: fixed(1, 3), carrierClaim: "1 to 3 business days", evidence: "P",
  },
  dhl_express_worldwide: {
    name: "DHL Express Worldwide", provider: "dhl", calendar: "major_holidays", air: true, international: true, customsPadDays: 1,
    transit: fixed(1, 3), carrierClaim: "1 to 3 business days", evidence: "M",
  },
  fedex_intl_economy: {
    name: "FedEx International Economy", provider: "fedex", calendar: "fedex", air: false, international: true, customsPadDays: 2,
    transit: fixed(2, 5), carrierClaim: "2 to 5 business days", evidence: "P",
  },
  ups_worldwide_expedited: {
    name: "UPS Worldwide Expedited", provider: "ups", calendar: "ups", air: false, international: true, customsPadDays: 2,
    transit: fixed(2, 5), carrierClaim: "2 to 5 business days", evidence: "P",
  },
  ups_standard_canada_mexico: {
    name: "UPS Standard to Canada and Mexico", provider: "ups", calendar: "ups", air: false, international: true, customsPadDays: 2,
    transit: fixed(2, 7), carrierClaim: "2 to 7 business days from the US", evidence: "P",
  },
  usps_priority_mail_express_intl: {
    name: "USPS Priority Mail Express International", provider: "usps", calendar: "usps", air: true, international: true, customsPadDays: 1,
    transit: fixed(3, 5), carrierClaim: "3 to 5 business days, varies with customs", evidence: "P",
  },
  usps_priority_mail_intl: {
    name: "USPS Priority Mail International", provider: "usps", calendar: "usps", air: true, international: true, customsPadDays: 2,
    transit: fixed(6, 10), carrierClaim: "6 to 10 business days, varies with customs", evidence: "P",
  },
  // Luggage services: the report's planning numbers (section 1.3, H) from each provider's own
  // published speeds (section 1.1, P). Not in the reference code's table.
  lugless_ground: {
    name: "LugLess Ground", provider: "lugless", calendar: "major_holidays", air: false, international: false, customsPadDays: 0,
    transit: fixed(2, 6), carrierClaim: "2 to 6 business days by distance", evidence: "P",
  },
  lugless_express: {
    name: "LugLess Express", provider: "lugless", calendar: "major_holidays", air: true, international: false, customsPadDays: 0,
    transit: fixed(1, 3), carrierClaim: "1 to 3 business days", evidence: "P",
  },
  luggage_forward_domestic: {
    name: "Luggage Forward", provider: "luggage_forward", calendar: "major_holidays", air: false, international: false, customsPadDays: 0,
    transit: fixed(1, 5), carrierClaim: "1 to 5 business days by speed option", evidence: "P",
  },
  luggage_forward_intl_standard: {
    name: "Luggage Forward International", provider: "luggage_forward", calendar: "major_holidays", air: false, international: true, customsPadDays: 2,
    transit: fixed(7, 11), carrierClaim: "7 to 11 business days, customs can add time", evidence: "P",
  },
  luggage_forward_intl_express: {
    name: "Luggage Forward International Express", provider: "luggage_forward", calendar: "major_holidays", air: true, international: true, customsPadDays: 1,
    transit: fixed(4, 9), carrierClaim: "2 to 3 business days faster than standard", evidence: "P",
  },
  luggage_free_domestic: {
    name: "Luggage Free", provider: "luggage_free", calendar: "major_holidays", air: false, international: false, customsPadDays: 0,
    transit: fixed(1, 5), carrierClaim: "next morning to 5 business days", evidence: "P",
  },
  luggage_free_intl: {
    name: "Luggage Free International", provider: "luggage_free", calendar: "major_holidays", air: false, international: true, customsPadDays: 2,
    transit: fixed(1, 7), carrierClaim: "1 to 7 business days", evidence: "P",
  },
} as const satisfies Record<string, ServiceConfig>;

/** A key of the transit table: what bookings.details.serviceKey holds. */
export type ServiceKey = keyof typeof SERVICES;

export const SERVICE_KEYS = Object.keys(SERVICES) as ServiceKey[];

/** The service assumed until she picks one: the slow, cheap, most common way to send a box. */
export const DEFAULT_SERVICE: ServiceKey = "ups_ground";

/** The carriers' own calculators, for "check the exact time" (UPS and USPS are M, FedEx P). */
export const TRANSIT_CALCULATOR_URLS: Partial<Record<ServiceProvider, string>> = {
  ups: "https://www.ups.com/ctc",
  fedex: "https://www.fedex.com/grd/maps/ShowMapEntry.do",
  usps: "https://postcalc.usps.com/",
};

// --- where it is going -----------------------------------------------------------------------------

export type DestinationPolicy = {
  /** Business days the parcel should land before the traveler does. */
  bufferDays: number;
  /** The most calendar days early the place will usually take it. */
  holdDays: number;
  /** True when nobody can receive it early: deliver on the first delivery day on or after arrival. */
  afterArrival?: true;
  /** For pickup points: how many days the place keeps a parcel before sending it back. */
  keptForDays?: number;
};

/**
 * Buffer and hold window per destination (report 5.5). What a property confirms replaces these.
 *
 * hotel            LugLess: deliver 1 to 2 days before check-in, never the same day (P);
 *                  Marriott sheets charge storage beyond 3 days (P).
 * resort           Disney accepts packages about a week ahead (P and Disney panel answers).
 * conference_venue Same as a hotel; fees go by weight.
 * relative_home    (H)
 * vacation_rental  (H) First delivery day on or after check-in, and only with the host's consent.
 * cruise_...       (H) The hotel the night before the cruise. Never the terminal.
 * pickup points    Hold periods are the providers' own (P): UPS Access Point 7 calendar days,
 *                  FedEx Office 5 business days, General Delivery 30 days, Amazon Locker 3 days,
 *                  Amazon Counter 7 days. The window is the hold period less 2 days of slack (H).
 */
export const DESTINATION_POLICIES: Record<ShipmentDestinationType, DestinationPolicy> = {
  hotel: { bufferDays: 2, holdDays: 3 },
  resort: { bufferDays: 2, holdDays: 5 },
  conference_venue: { bufferDays: 2, holdDays: 3 },
  relative_home: { bufferDays: 3, holdDays: 21 },
  vacation_rental: { bufferDays: 0, holdDays: 0, afterArrival: true },
  cruise_precruise_hotel: { bufferDays: 2, holdDays: 3 },
  ups_access_point: { bufferDays: 1, holdDays: 5, keptForDays: 7 },
  fedex_hold_at_location: { bufferDays: 1, holdDays: 4, keptForDays: 7 },
  usps_general_delivery: { bufferDays: 2, holdDays: 21, keptForDays: 30 },
  amazon_locker: { bufferDays: 0, holdDays: 1, keptForDays: 3 },
  amazon_counter: { bufferDays: 1, holdDays: 5, keptForDays: 7 },
};

/**
 * When a rental host confirms a hold window of a day or more, somebody is there to receive the
 * box, so it is planned like a hotel: this many business days before arrival, inside the window
 * the host gave. Our addition (H): the reference code ignored a rental host's answer.
 */
export const RENTAL_BUFFER_DAYS_WITH_HOST_CONSENT = 2;

// --- fees ------------------------------------------------------------------------------------------

/**
 * What properties charge to receive a box, in US cents (H, derived from the published sheets in
 * report 2.2: Marriott $6 to $10 a box and $25 a day storage after 3 days; Tampa Marriott
 * Waterside $1.35 per lb, minimum $10, maximum $135; Park Lane New York $10; Disney $6).
 * A fee the property confirms replaces these.
 */
export const HANDLING_FEE_DEFAULTS = {
  currency: "USD",
  /** Per box under 50 lb at a hotel or resort. */
  hotel: { low: 0, typical: 1000, high: 2500 },
  /** Conference hotels and venues charge by weight. */
  conferenceVenue: { perPound: 135, minimum: 1000, maximum: 13500 },
  /** Storage per box per day once the free hold window has passed. */
  storagePerDay: 2500,
  /** Above this, fees jump or the box is refused. */
  heavyBoxLb: 50,
} as const;

// --- the carriers' own last days to ship -----------------------------------------------------------

export type PublishedCutoff = {
  service: ServiceKey;
  /** The carrier's promise: ship by `lastShip` to be delivered by this date. */
  deliverBy: LocalDate;
  lastShip: LocalDate;
  /** For ground services whose cutoff depends on the lane: the planned transit days it is for. */
  laneDays?: number;
  /** A different date for Alaska, Hawaii and the territories. */
  offshoreLastShip?: LocalDate;
  /** `P`: the carrier's own page. `3P`: shipping blogs only (FedEx's PDF was not readable). */
  evidence: "P" | "3P";
};

/**
 * Published last days to ship for Christmas 2026 (report 5.3). When one of these is earlier than
 * the date the arithmetic gives for the same service, the published date wins (report 5.4).
 *
 * USPS: usps.com/holiday/holiday-shipping-dates.htm and the release of Sep 22, 2026 (P).
 * UPS:  ups.com holiday schedule and year-end PDF (P). UPS Ground has none: it depends on the lane.
 * FedEx: 3P. FedEx's own PDF exists but its grid could not be read; these dates are from shipping
 *        blogs and agree with business-day arithmetic. Re-check against FedEx before the season.
 */
export const PUBLISHED_LAST_SHIP_DATES: readonly PublishedCutoff[] = [
  { service: "usps_ground_advantage", deliverBy: "2026-12-25", lastShip: "2026-12-17", offshoreLastShip: "2026-12-16", evidence: "P" },
  { service: "usps_priority_mail", deliverBy: "2026-12-25", lastShip: "2026-12-18", offshoreLastShip: "2026-12-18", evidence: "P" },
  { service: "usps_priority_mail_express", deliverBy: "2026-12-25", lastShip: "2026-12-19", offshoreLastShip: "2026-12-19", evidence: "P" },
  { service: "usps_priority_mail_express_intl", deliverBy: "2026-12-25", lastShip: "2026-12-16", evidence: "P" },
  { service: "ups_3_day_select", deliverBy: "2026-12-24", lastShip: "2026-12-21", evidence: "P" },
  { service: "ups_2nd_day_air", deliverBy: "2026-12-24", lastShip: "2026-12-22", evidence: "P" },
  { service: "ups_next_day_air", deliverBy: "2026-12-24", lastShip: "2026-12-23", evidence: "P" },
  { service: "fedex_ground", deliverBy: "2026-12-24", lastShip: "2026-12-17", laneDays: 5, evidence: "3P" },
  { service: "fedex_ground", deliverBy: "2026-12-24", lastShip: "2026-12-18", laneDays: 4, evidence: "3P" },
  { service: "fedex_ground", deliverBy: "2026-12-24", lastShip: "2026-12-21", laneDays: 3, evidence: "3P" },
  { service: "fedex_ground", deliverBy: "2026-12-24", lastShip: "2026-12-22", laneDays: 2, evidence: "3P" },
  { service: "fedex_ground", deliverBy: "2026-12-24", lastShip: "2026-12-23", laneDays: 1, evidence: "3P" },
  { service: "fedex_home_delivery", deliverBy: "2026-12-24", lastShip: "2026-12-17", laneDays: 5, evidence: "3P" },
  { service: "fedex_home_delivery", deliverBy: "2026-12-24", lastShip: "2026-12-18", laneDays: 4, evidence: "3P" },
  { service: "fedex_home_delivery", deliverBy: "2026-12-24", lastShip: "2026-12-21", laneDays: 3, evidence: "3P" },
  { service: "fedex_home_delivery", deliverBy: "2026-12-24", lastShip: "2026-12-22", laneDays: 2, evidence: "3P" },
  { service: "fedex_home_delivery", deliverBy: "2026-12-24", lastShip: "2026-12-23", laneDays: 1, evidence: "3P" },
  { service: "fedex_express_saver", deliverBy: "2026-12-24", lastShip: "2026-12-21", evidence: "3P" },
  { service: "fedex_2day", deliverBy: "2026-12-24", lastShip: "2026-12-22", evidence: "3P" },
  { service: "fedex_overnight", deliverBy: "2026-12-24", lastShip: "2026-12-23", evidence: "3P" },
];

// --- tracking pages --------------------------------------------------------------------------------

/** The carriers whose tracking numbers the app recognises and can link to. */
export const TRACKING_CARRIERS = ["ups", "fedex", "usps", "dhl", "amazon", "ontrac", "canadapost", "royalmail"] as const;
export type TrackingCarrier = (typeof TRACKING_CARRIERS)[number];

export type TrackingLinkConfig = {
  /** `{n}` is replaced with the normalized number, URL-encoded. */
  template: string;
  /** Where to send her if the deep link ever breaks: the carrier's tracking front page. */
  fallback: string;
  /**
   * How sure the report is that the deep link works. NONE of these was click-tested (report
   * section 8, item 1): each must be opened once with a real number before launch.
   * `published`: on the carrier's own site. `observed`: reported working by third parties.
   * `unverified`: from memory only.
   */
  evidence: "published" | "observed" | "unverified";
};

/** Tracking-page links (report 4.1). Kept here, not in code, so a broken one is a one-line fix. */
export const TRACKING_LINKS: Record<TrackingCarrier, TrackingLinkConfig> = {
  ups: {
    template: "https://www.ups.com/track?loc=en_US&tracknum={n}",
    fallback: "https://www.ups.com/track",
    evidence: "observed",
  },
  fedex: {
    template: "https://www.fedex.com/fedextrack/?trknbr={n}",
    fallback: "https://www.fedex.com/fedextrack/",
    evidence: "observed",
  },
  usps: {
    template: "https://tools.usps.com/go/TrackConfirmAction?tLabels={n}",
    fallback: "https://tools.usps.com/go/TrackConfirmAction",
    evidence: "observed",
  },
  dhl: {
    template: "https://www.dhl.com/us-en/home/tracking.html?tracking-id={n}&submit=1",
    fallback: "https://www.dhl.com/us-en/home/tracking.html",
    evidence: "unverified",
  },
  amazon: {
    template: "https://track.amazon.com/tracking/{n}",
    fallback: "https://www.amazon.com/gp/css/order-history",
    evidence: "observed",
  },
  ontrac: {
    template: "https://www.ontrac.com/tracking/?number={n}",
    fallback: "https://www.ontrac.com/tracking/",
    evidence: "unverified",
  },
  canadapost: {
    template: "https://www.canadapost-postescanada.ca/track-reperage/en/details/{n}",
    fallback: "https://www.canadapost-postescanada.ca/track-reperage/en",
    evidence: "observed",
  },
  royalmail: {
    template: "https://www.royalmail.com/portal/rm/track?trackNumber={n}",
    fallback: "https://www.royalmail.com/track-your-item",
    evidence: "published",
  },
};
