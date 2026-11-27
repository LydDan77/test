// Act-by dates (product spec 10.4): for each kind of booking, the day it is wise to have it
// done by, the day after which it is too late, and the first day a provider will take it.
// Shared by the booking tools, "what's left" and the heads-up list, so they always agree.
//
// These are design defaults, not provider rules, except the ordering and reservation windows.

import type { Booking, BookingOf } from "@/db/schema";
import type { ActBy, BookingKind } from "@/lib/domain";
import type { PlanData } from "@/lib/plan-data";
import { addDays, compareDates, formatDate, localDateOf } from "@/lib/time";
import { isBooked, isDead } from "./context";
import { holidayPeriodTouching, type HolidayPeriod } from "./holiday-periods";
import { CATERING_NOTICE_DAYS, FOOD_ORDER_WINDOW_DAYS, PROVIDERS, RIDE_RESERVATION_WINDOW_DAYS } from "./providers";

/** How loudly to say it today: nothing, a quiet note, a nudge, or "this is the last moment". */
export type ActByLevel = "none" | "info" | "caution" | "alert";

/** The three dates (the shape stored in bookings.actBy) with the words to show beside them. */
export type ActByDates = ActBy & {
  /** Why these dates, in plain words. Always present, even when there are no dates yet. */
  reason: string;
  /** The short line for a list: "Book by Dec 5 (holiday week)", "Order window opens Dec 12", "Ship by Dec 10". Null when there is nothing to say. */
  line: string | null;
  /** The holiday period that pulled the dates forward, when one did. */
  holiday: HolidayPeriod | null;
  /**
   * Today's level (product spec 10.4): "none" before the last week, "info" in the 7 days before
   * the recommended date, "caution" once it has passed, "alert" from the hard date on.
   * Always "none" for a booking that is booked, done, cancelled or not needed.
   */
  level: ActByLevel;
};

/**
 * A narrow view of the send-ahead arithmetic in src/lib/shipping, passed in so this folder never
 * imports it. Given a shipment booking, return its ship-by date and its "cutting it close" date.
 * Left out, the dates stored on the booking are used.
 */
export type ShipByLookup = (
  shipment: Booking & BookingOf<"shipment">,
  data: PlanData,
) => { shipByDate?: string | null; latestRiskyDate?: string | null } | null | undefined;

export type ActByOptions = {
  /**
   * Replaces the built-in holiday calendar: given the plan's first and last day, return the
   * holiday period they touch, or null. Use it to make this agree with the heads-up engine.
   */
  holidayPeriod?: (start: string, end: string) => HolidayPeriod | null;
  shipBy?: ShipByLookup;
};

const LEAD_DAYS = {
  flight: { recommended: 45, hard: 14, holidayRecommended: 60, holidayHard: 21 },
  lodging: { recommended: 45, hard: 14, holidayRecommended: 60, holidayHard: 21 },
  car: { recommended: 30, hard: 7, holidayRecommended: 45, holidayHard: 14 },
} as const;

const RIDE_RECOMMENDED_DAYS = 2;
const RIDE_HOLIDAY_RECOMMENDED_DAYS = 7;
const RIDE_HARD_HOURS = 3;
const CATERING_RECOMMENDED_DAYS = 7;
const PROPERTY_MESSAGE_DAYS = 5;

const day = (date: string) => formatDate(date);

function levelFor(dates: ActBy, today: string, booking: Booking | null | undefined): ActByLevel {
  if (booking && (isBooked(booking) || isDead(booking))) return "none";
  if (dates.hard && compareDates(today, dates.hard) >= 0) return "alert";
  if (dates.recommended && compareDates(today, dates.recommended) > 0) return "caution";
  if (dates.recommended && compareDates(today, addDays(dates.recommended, -7)) >= 0) return "info";
  return "none";
}

function planHoliday(data: PlanData, opts: ActByOptions): HolidayPeriod | null {
  const { startDate, endDate, origin, destination } = data.plan;
  if (!startDate) return null;
  if (opts.holidayPeriod) return opts.holidayPeriod(startDate, endDate ?? startDate);
  const countries = [origin.countryCode, destination?.countryCode];
  // A missing country is taken as the US: the first users are, and the app starts from their home.
  const unitedStates = countries.some((code) => code === undefined || code === "US");
  return holidayPeriodTouching(startDate, endDate, { unitedStates });
}

function noDates(reason: string): ActByDates {
  return { reason, line: null, holiday: null, level: "none" };
}

const WHAT = {
  flight: { noun: "flights", normal: "about 6 weeks before you leave", late: "there is little left to choose from" },
  lodging: { noun: "a place to stay", normal: "about 6 weeks ahead", late: "there is little left to choose from" },
  car: { noun: "the car", normal: "about a month ahead", late: "prices climb and choice shrinks" },
} as const;

function travelDates(kind: "flight" | "lodging" | "car", data: PlanData, booking: Booking | null | undefined, today: string, holiday: HolidayPeriod | null): ActByDates {
  // The item's own day when it has one, else the day the plan starts.
  let t = data.plan.startDate ?? undefined;
  if (booking?.details.kind === "flight") {
    const first = booking.details.segments[0];
    t = booking.details.search?.departDate ?? (first ? localDateOf(first.departsAt, first.originTz) : t);
  } else if (booking?.details.kind === "lodging") {
    t = booking.details.checkInDate ?? t;
  } else if (booking?.details.kind === "car" && booking.details.pickupAt) {
    t = localDateOf(booking.details.pickupAt.at, booking.details.pickupAt.tz);
  }
  if (!t) return noDates("Pick your dates and we'll work out when to book.");

  const lead = LEAD_DAYS[kind];
  const dates: ActBy = {
    recommended: addDays(t, -(holiday ? lead.holidayRecommended : lead.recommended)),
    hard: addDays(t, -(holiday ? lead.holidayHard : lead.hard)),
  };
  const words = WHAT[kind];
  const reason = holiday
    ? `Your dates include ${holiday.name}, when everything goes early. Book ${words.noun} by ${day(dates.recommended as string)}; after ${day(dates.hard as string)} ${words.late}.`
    : `Book ${words.noun} by ${day(dates.recommended as string)}, ${words.normal}. After ${day(dates.hard as string)} ${words.late}.`;
  const tag = holiday ? ` (${holiday.tag})` : "";
  const pastHard = compareDates(today, dates.hard as string) > 0;
  const pastRecommended = compareDates(today, dates.recommended as string) > 0;
  const line = pastHard ? `Book as soon as you can${tag}` : `Book by ${day((pastRecommended ? dates.hard : dates.recommended) as string)}${tag}`;
  return { ...dates, reason, line, holiday, level: levelFor(dates, today, booking) };
}

function rideDates(data: PlanData, booking: Booking | null | undefined, today: string, holiday: HolidayPeriod | null): ActByDates {
  const details = booking?.details.kind === "ride" ? booking.details : undefined;
  const pickup = details?.pickupAt;
  const rideDay = pickup ? localDateOf(pickup.at, pickup.tz) : booking?.startsAt && booking.startTz ? localDateOf(booking.startsAt, booking.startTz) : (data.plan.startDate ?? undefined);
  if (!rideDay) return noDates("Pick your dates and we'll work out when to reserve the ride.");

  const recommended = addDays(rideDay, -(holiday ? RIDE_HOLIDAY_RECOMMENDED_DAYS : RIDE_RECOMMENDED_DAYS));
  // Three hours before pick-up. That is the same day unless the ride is in the small hours.
  const hard = pickup ? localDateOf(Date.parse(pickup.at) - RIDE_HARD_HOURS * 3_600_000, pickup.tz) : rideDay;
  const driving = details?.rideType === "personal_pickup";
  if (driving) {
    const dates: ActBy = { recommended, hard };
    return {
      ...dates,
      reason: `Confirm the pick-up with whoever is driving by ${day(recommended)}.`,
      line: `Confirm by ${day(recommended)}`,
      holiday,
      level: levelFor(dates, today, booking),
    };
  }
  const opensOn = addDays(rideDay, -RIDE_RESERVATION_WINDOW_DAYS);
  const dates: ActBy = { recommended, hard, opensOn };
  const notOpen = compareDates(today, opensOn) < 0;
  const reason = holiday
    ? `Uber and Lyft take reservations ${RIDE_RESERVATION_WINDOW_DAYS} days ahead, from ${day(opensOn)}. Your dates include ${holiday.name}, so reserve a week ahead, by ${day(recommended)}.`
    : `Uber and Lyft take reservations ${RIDE_RESERVATION_WINDOW_DAYS} days ahead, from ${day(opensOn)}. Reserve by ${day(recommended)}; the last moment is about ${RIDE_HARD_HOURS} hours before pick-up.`;
  const line = notOpen ? `Reservations open ${day(opensOn)}` : compareDates(today, recommended) > 0 ? `Reserve by ${day(hard)}` : `Reserve by ${day(recommended)}`;
  return { ...dates, reason, line, holiday, level: levelFor(dates, today, booking) };
}

function mealDates(data: PlanData, booking: Booking | null | undefined, today: string, holiday: HolidayPeriod | null): ActByDates {
  const details = booking?.details.kind === "meal" ? booking.details : undefined;
  const start = details?.windowStart;
  const deliveryDay = start ? localDateOf(start.at, start.tz) : (data.plan.startDate ?? undefined);
  if (!deliveryDay) return noDates("Pick your dates and we'll work out when the order window opens.");

  const chosen = booking?.provider && booking.provider in FOOD_ORDER_WINDOW_DAYS ? (booking.provider as keyof typeof FOOD_ORDER_WINDOW_DAYS) : undefined;
  const provider = chosen ?? (details?.mealType === "groceries" ? "instacart" : details?.mealType === "catering" ? "ezcater" : "uber_eats");
  const name = PROVIDERS[provider].name;
  const days = FOOD_ORDER_WINDOW_DAYS[provider];

  if (days === null || details?.mealType === "catering") {
    const dates: ActBy = { recommended: addDays(deliveryDay, -CATERING_RECOMMENDED_DAYS), hard: addDays(deliveryDay, -CATERING_NOTICE_DAYS) };
    return {
      ...dates,
      reason: `Caterers need notice. Order by ${day(dates.recommended as string)} to be comfortable, and no later than ${day(dates.hard as string)}, ${CATERING_NOTICE_DAYS} days before.`,
      line: `Order by ${day((compareDates(today, dates.recommended as string) > 0 ? dates.hard : dates.recommended) as string)}`,
      holiday,
      level: levelFor(dates, today, booking),
    };
  }
  const opensOn = addDays(deliveryDay, -days);
  const dates: ActBy = { recommended: opensOn, hard: addDays(deliveryDay, -1), opensOn };
  const notOpen = compareDates(today, opensOn) < 0;
  return {
    ...dates,
    reason: `${name} takes orders ${days} days ahead, so the window opens ${day(opensOn)}. Order by ${day(dates.hard as string)}, the day before.`,
    line: notOpen ? `Order window opens ${day(opensOn)}` : `Order by ${day(dates.hard as string)}`,
    holiday,
    level: levelFor(dates, today, booking),
  };
}

function shipmentDates(data: PlanData, booking: Booking | null | undefined, today: string, opts: ActByOptions): ActByDates {
  if (!booking || booking.details.kind !== "shipment") return noDates("Add what you're sending and where, and we'll work out the last safe day to ship.");
  const looked = opts.shipBy?.(booking as Booking & BookingOf<"shipment">, data);
  const shipBy = looked?.shipByDate ?? booking.details.shipByDate;
  const risky = looked?.latestRiskyDate ?? booking.details.latestRiskyDate;
  if (!shipBy) return noDates("Add where it's going and when you arrive, and we'll work out the last safe day to ship.");
  const dates: ActBy = { recommended: addDays(shipBy, -PROPERTY_MESSAGE_DAYS), hard: shipBy };
  const close = risky && compareDates(risky, shipBy) > 0 ? ` ${day(risky)} is cutting it close.` : "";
  return {
    ...dates,
    // Peak-season padding is already inside the ship-by date, so a holiday changes nothing here.
    reason: `Ask the property by ${day(dates.recommended as string)} whether it will hold a parcel. Ship by ${day(shipBy)}.${close}`,
    line: `Ship by ${day(shipBy)}`,
    holiday: null,
    level: levelFor(dates, today, booking),
  };
}

/**
 * The recommended-by, hard-by and opens-on dates for one kind of booking, with the reason in
 * plain words (product spec 10.4, holiday adjustments included).
 *
 *   const dates = actByFor("car", planData, carBooking, now);
 *   dates.line    // "Book by Dec 5 (holiday week)"
 *   dates.reason  // "Your dates include Christmas, when everything goes early. Book the car by …"
 *   dates.level   // "caution"
 *
 * `booking` may be left out to ask about the kind in general; with it, the booking's own day is
 * used (a ride's pick-up, a delivery's window) instead of the plan's first day. To store the
 * dates on the booking, pass the result through `actBySchema.parse(...)`, which keeps the three
 * dates and drops the words.
 *
 * Never throws: a plan with no dates gets no dates and a reason that says what to do.
 */
export function actByFor(kind: BookingKind, data: PlanData, booking: Booking | null | undefined, now: Date, opts: ActByOptions = {}): ActByDates {
  const today = localDateOf(now, data.plan.tz);
  const holiday = planHoliday(data, opts);
  const own = booking && booking.kind === kind ? booking : null;
  switch (kind) {
    case "flight":
    case "lodging":
    case "car":
      return travelDates(kind, data, own, today, holiday);
    case "ride":
      return rideDates(data, own, today, holiday);
    case "meal":
      return mealDates(data, own, today, holiday);
    case "shipment":
      return shipmentDates(data, own, today, opts);
    default:
      return noDates("There is nothing to book for this.");
  }
}
