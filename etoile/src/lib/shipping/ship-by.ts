// "Ship by Dec 10 so it arrives Dec 21", and how that was worked out.
//
// The arithmetic is a port of shipBy() in research/ship-ahead-code/shipby.mjs (report 5.6). The
// numbers it uses are all in ./config. Three things go beyond the reference, each marked below:
// the carriers' own published last days to ship cap the ship-by date (report 5.4, which the
// reference left out), a rental host's confirmed hold window is honoured, and the "cutting it
// close" date is never earlier than the ship-by date.
//
// Pure: no clock, no database. "Today" is an argument.

import type { Money, Parcel, ShipmentDestinationType, ShipmentKind } from "@/lib/domain";
import { addDays, compareDates, formatDateRange, type LocalDate } from "@/lib/time";
import {
  addTransitDays,
  calendarConfidence,
  carrierDay,
  closedDaysBetween,
  inPeakSeason,
  isDeliveryDay,
  nextDeliveryDay,
  nextShipDay,
  previousDeliveryDay,
  previousShipDay,
  subtractTransitDays,
} from "./calendar";
import {
  DEFAULT_ZONE,
  DESTINATION_POLICIES,
  DROP_OFF_CUTOFF_HOUR,
  GROUND_DAYS_BY_ZONE,
  HANDLING_FEE_DEFAULTS,
  INTERNATIONAL_BUFFER_DAYS,
  OFFSHORE_ZONE,
  PEAK_PADDING_DAYS,
  PUBLISHED_LAST_SHIP_DATES,
  RENTAL_BUFFER_DAYS_WITH_HOST_CONSENT,
  SERVICES,
  SEVERE_WEATHER_PADDING_DAYS,
  TRANSIT_CALCULATOR_URLS,
  USPS_GROUND_ADVANTAGE_DAYS_BY_ZONE,
  type ServiceConfig,
  type ServiceKey,
  type ServiceProvider,
  type TransitDays,
} from "./config";
import {
  DESTINATION_WORDS,
  carrierName,
  count,
  dayAndDate,
  isPickupPoint,
  isStaffedProperty,
  listOf,
  parcelNoun,
  plainMoney,
  sentenceCase,
} from "./words";
import { estimateZone, isOffshoreZip, type ZoneEstimate } from "./zones";

// --- input -----------------------------------------------------------------------------------------

/**
 * What the property or host said when asked. Both a shipment's `propertyAnswers` and a stay's
 * `packagePolicy` fit this shape, so either can be passed as it is.
 */
export type PropertyTerms = {
  /** She has an answer from the property (ShipmentDetails.propertyAnswers.confirmed). */
  confirmed?: boolean;
  /** The property said yes or no to receiving packages (LodgingDetails.packagePolicy.accepts). */
  accepts?: boolean;
  /** How many days before arrival it will hold a parcel. Replaces the usual hold window. */
  holdDays?: number;
  /** What it charges per box. Replaces the usual fee estimate. */
  feePerBox?: Money;
};

export type ShipByInput = {
  /** Where it is going. A cruise is `cruise_precruise_hotel`; pickup points are the last five kinds. */
  destination: ShipmentDestinationType;
  /** The day she gets there (a stay's check-in date), as a local date at the destination. */
  arrivalDate: LocalDate;
  /** The service level, a key of SERVICES in ./config. Use DEFAULT_SERVICE until she picks one. */
  service: ServiceKey;
  /** US ZIP codes, when known. Together they set how many days ground takes. */
  originPostalCode?: string | null;
  destinationPostalCode?: string | null;
  /** A carrier zone (1 to 9) she or a carrier's calculator supplied. Wins over the postal codes. */
  zone?: number | null;
  /** True when it crosses a border. An international service counts as international either way. */
  international?: boolean;
  /** What the property confirmed. Replaces the usual hold window and fee. */
  property?: PropertyTerms | null;
  /**
   * Today where she ships from: `localDateOf(now, user.home.tz)`. Leave out to get the dates
   * without "the ship-by date has passed" warnings.
   */
  today?: LocalDate;
  /** True when severe weather is forecast on the route: one more business day is allowed. */
  severeWeather?: boolean;
  /** What is being sent, so sentences say "bag" or "box". */
  shipmentKind?: ShipmentKind | null;
  /** The parcels, for the weight-based fee and the heavy-box warning. Only `weight` is read. */
  parcels?: readonly Pick<Parcel, "weight">[];
  /** Business days to arrive before she does, overriding the usual buffer for the destination. */
  bufferDays?: number;
};

// --- output ----------------------------------------------------------------------------------------

export type ShipByStepKey =
  | "arrival"
  | "window"
  | "target"
  | "transit"
  | "padding"
  | "count_back"
  | "carrier_cutoff"
  | "cutting_close"
  | "drop_off";

/** One line of "how we worked this out", in the order to show them. */
export type ShipByStep = { key: ShipByStepKey; text: string };

export type ShipByWarningCode =
  | "ship_by_passed"
  | "ship_by_today"
  | "property_declined"
  | "host_consent_needed"
  | "no_delivery_day_in_window"
  | "service_not_international"
  | "carrier_mismatch"
  | "amazon_orders_only"
  | "heavy_box"
  | "cruise_terminal"
  | "calendar_not_covered"
  | "calendar_projected"
  | "peak_season"
  | "ask_property_first";

export type ShipByWarning = {
  code: ShipByWarningCode;
  /** The app's three calm levels. Never show by colour alone. */
  level: "alert" | "caution" | "info";
  /** A plain sentence or two: what is going on and what to do. */
  text: string;
};

export type HandlingFee = {
  /** `property`: what the property told her. `typical`: what such places usually charge. */
  source: "property" | "typical";
  /** The fee for one box, when it is a single figure. */
  perBox: Money | null;
  /** The usual range, for a typical fee. */
  low: Money | null;
  high: Money | null;
  /** A plain sentence: "Hotels often charge about $10 a box to receive it, anywhere from nothing to $25." */
  text: string;
};

export type FasterOption = {
  service: ServiceKey;
  serviceName: string;
  shipByDate: LocalDate;
  targetDeliveryDate: LocalDate;
};

export type ShipByPlan = {
  service: ServiceKey;
  /** "UPS Ground". */
  serviceName: string;
  /** The day it should be delivered. Store as details.targetDeliveryDate. */
  targetDeliveryDate: LocalDate;
  /** The last safe day to hand it to the carrier. Store as details.shipByDate. */
  shipByDate: LocalDate;
  /**
   * The "cutting it close" date: the last day it can still arrive before she needs it if nothing
   * goes wrong. Never earlier than shipByDate. Store as details.latestRiskyDate.
   */
  latestRiskyDate: LocalDate;
  /** The first day the destination will take it. Before this, expect storage fees or a refusal. */
  earliestAcceptableDate: LocalDate;
  /** "Ship by Thu, Dec 10 so it arrives Mon, Dec 21". */
  headline: string;
  /**
   * The chain in one line, for under the headline: "UPS Ground, 5 business days plus 2 for peak
   * season. Arrives Mon, Dec 21, the first delivery day after you check in on Sat, Dec 19."
   */
  summary: string;
  /** "Cutting it close: Tue, Dec 15", or null when there is no later date worth showing. */
  cuttingItClose: string | null;
  /** Each step of the arithmetic as a sentence she can read, in order. */
  steps: ShipByStep[];
  /** Things to know, most serious first. Empty when there is nothing to say. */
  warnings: ShipByWarning[];
  /** What the place is likely to charge to receive it, or null where nobody charges. */
  fee: HandlingFee | null;
  /** The numbers behind the sentences. */
  transit: {
    /** Business days planned for the carrier, before padding. */
    planDays: number;
    /** Business days if everything goes right. */
    bestDays: number;
    /** Extra business days added, in total and by reason. */
    paddingDays: number;
    customsDays: number;
    peakDays: number;
    weatherDays: number;
    /** The carrier zone used (2 to 9), and where it came from. Null for services that ignore distance. */
    zone: number | null;
    zoneBasis: "given" | "postal_codes" | "assumed" | "not_used";
  };
  /** Dates for reminders (report 5.6). `askPropertyOn` is null where there is nobody to ask. */
  reminders: {
    /** Message the property five days before the ship-by date (or today, if that has passed). */
    askPropertyOn: LocalDate | null;
    /** Pack and label it the day before the ship-by date. */
    packOn: LocalDate;
    /** The day after it should have arrived: "Did it arrive?" */
    checkArrivedOn: LocalDate;
  };
  /** When the ship-by date has passed: the slowest faster service that still gets it there, if any. */
  fasterOption: FasterOption | null;
  /** The carrier's own time-in-transit calculator, for "check the exact time". Null for luggage services. */
  calculatorUrl: string | null;
};

// --- the arithmetic (port of shipBy in shipby.mjs) -------------------------------------------------

type ZoneBasis = ShipByPlan["transit"]["zoneBasis"];

type Core = {
  service: ServiceKey;
  config: ServiceConfig;
  international: boolean;
  buffer: number;
  holdDays: number;
  holdSource: "usual" | "property";
  afterArrival: boolean;
  target: LocalDate;
  earliest: LocalDate;
  clippedToWindow: boolean;
  noDeliveryDayInWindow: boolean;
  transit: TransitDays;
  zone: number | null;
  zoneBasis: ZoneBasis;
  zoneEstimate: ZoneEstimate | null;
  customsDays: number;
  peakDays: number;
  weatherDays: number;
  /** The day the count-back lands on, before stepping to a safe ship day. */
  counted: LocalDate;
  shipBy: LocalDate;
  latestRisky: LocalDate;
  riskyTarget: LocalDate;
  /** Set when the carrier's own published last day to ship replaced the computed date. */
  carrierCutoff: LocalDate | null;
  /** The carrier's published last day to ship, when it is earlier than the "cutting it close" date. */
  carrierLastDay: LocalDate | null;
};

function resolveZone(input: ShipByInput): { zone: number; basis: ZoneBasis; estimate: ZoneEstimate | null } {
  if (typeof input.zone === "number" && Number.isInteger(input.zone) && input.zone >= 1 && input.zone <= 9) {
    return { zone: input.zone, basis: "given", estimate: null };
  }
  const estimate = estimateZone(input.originPostalCode, input.destinationPostalCode);
  if (estimate) return { zone: estimate.zone, basis: "postal_codes", estimate };
  // One end known and it is Alaska, Hawaii or an island: the other end is almost certainly not.
  if (isOffshoreZip(input.originPostalCode) || isOffshoreZip(input.destinationPostalCode)) {
    return { zone: OFFSHORE_ZONE, basis: "postal_codes", estimate: null };
  }
  return { zone: DEFAULT_ZONE, basis: "assumed", estimate: null };
}

/** The business days a service takes over a zone: `{ best, plan }`. */
export function transitDaysFor(service: ServiceKey, zone: number = DEFAULT_ZONE): TransitDays {
  const transit: ServiceConfig["transit"] = SERVICES[service].transit;
  if (transit.kind === "by_zone") {
    const table = transit.table === "ground" ? GROUND_DAYS_BY_ZONE : USPS_GROUND_ADVANTAGE_DAYS_BY_ZONE;
    return table[zone] ?? table[DEFAULT_ZONE];
  }
  return zone >= OFFSHORE_ZONE && transit.offshoreDays ? transit.offshoreDays : transit.days;
}

function publishedCutoffFor(service: ServiceKey, target: LocalDate, planDays: number, offshore: boolean): LocalDate | null {
  const rows = PUBLISHED_LAST_SHIP_DATES.filter(
    (row) => row.service === service && compareDates(target, row.deliverBy) <= 0,
  );
  if (rows.length === 0) return null;
  // Ground cutoffs depend on the lane: take the row for the planned days, or the longest lane listed.
  const laned = rows.filter((row) => row.laneDays !== undefined);
  const row =
    laned.length > 0
      ? (laned.find((candidate) => candidate.laneDays === planDays) ??
        laned.reduce((longest, candidate) => ((candidate.laneDays ?? 0) > (longest.laneDays ?? 0) ? candidate : longest)))
      : rows[0];
  const lastShip = offshore && row.offshoreLastShip ? row.offshoreLastShip : row.lastShip;
  // Only for a delivery in the days the cutoff is about: after the cutoff, up to the promised day.
  return compareDates(target, lastShip) > 0 ? lastShip : null;
}

function compute(input: ShipByInput): Core {
  const service = input.service;
  const config: ServiceConfig = SERVICES[service];
  const base = DESTINATION_POLICIES[input.destination];
  const international = input.international === true || config.international;

  // What the property confirmed replaces the usual policy.
  const confirmedHold =
    typeof input.property?.holdDays === "number" && input.property.holdDays >= 0 ? Math.floor(input.property.holdDays) : null;
  let bufferDays = base.bufferDays;
  let afterArrival = base.afterArrival === true;
  const holdDays = confirmedHold ?? base.holdDays;
  if (afterArrival && confirmedHold !== null && confirmedHold >= 1) {
    // Beyond the reference: a rental host who will hold a box makes the rental work like a hotel.
    afterArrival = false;
    bufferDays = RENTAL_BUFFER_DAYS_WITH_HOST_CONSENT;
  }
  if (typeof input.bufferDays === "number" && Number.isInteger(input.bufferDays) && input.bufferDays >= 0) {
    bufferDays = input.bufferDays;
  }

  // 1. Target delivery date: N delivery days before arrival, not earlier than the hold window.
  const buffer = bufferDays + (international ? INTERNATIONAL_BUFFER_DAYS : 0);
  let target = previousDeliveryDay(service, subtractTransitDays(service, input.arrivalDate, buffer));
  const earliest = addDays(input.arrivalDate, -holdDays);
  let clippedToWindow = false;
  let noDeliveryDayInWindow = false;
  if (afterArrival) {
    target = nextDeliveryDay(service, input.arrivalDate);
  } else if (compareDates(target, earliest) < 0) {
    // The buffer does not fit inside the hold window: take the first delivery day inside it.
    let day = earliest;
    while (!isDeliveryDay(service, day) && compareDates(day, input.arrivalDate) < 0) day = addDays(day, 1);
    if (compareDates(day, input.arrivalDate) <= 0 && isDeliveryDay(service, day)) {
      target = day;
      clippedToWindow = true;
    } else {
      noDeliveryDayInWindow = true;
    }
  }

  // 2. Transit days to plan with, and padding.
  const zoneInfo = resolveZone(input);
  const transit = transitDaysFor(service, zoneInfo.zone);
  // Distance matters to ground services, and to the few others that slow down offshore.
  const usesZone =
    config.transit.kind === "by_zone" || (config.transit.offshoreDays !== undefined && zoneInfo.zone >= OFFSHORE_ZONE);
  const customsDays = international ? config.customsPadDays || 2 : 0;
  const weatherDays = input.severeWeather ? SEVERE_WEATHER_PADDING_DAYS : 0;
  let pad = customsDays + weatherDays;

  // 3. Walk back plan + pad transit days; the ship date must be a safe ship day.
  const countBack = (days: number) => subtractTransitDays(service, target, days);
  let counted = countBack(transit.plan + pad);
  let shipBy = previousShipDay(service, counted);
  let peakDays = 0;
  if (inPeakSeason(shipBy) || inPeakSeason(target)) {
    peakDays = config.air && !international ? PEAK_PADDING_DAYS.domesticExpress : PEAK_PADDING_DAYS.ground;
    pad += peakDays;
    counted = countBack(transit.plan + pad);
    shipBy = previousShipDay(service, counted);
  }

  // "Cutting it close": best-case transit, aiming for the last delivery day before she arrives.
  const riskyTarget = afterArrival
    ? target
    : previousDeliveryDay(service, addDays(input.arrivalDate, bufferDays === 0 ? 0 : -1));
  let latestRisky = previousShipDay(service, subtractTransitDays(service, riskyTarget, transit.best + (international ? 1 : 0)));

  // Beyond the reference (report 5.4): the carrier's own published last day to ship wins when earlier.
  const offshore = zoneInfo.zone >= OFFSHORE_ZONE;
  let carrierCutoff: LocalDate | null = null;
  const cutoff = publishedCutoffFor(service, target, transit.plan, offshore);
  if (cutoff && compareDates(shipBy, cutoff) > 0) {
    shipBy = previousShipDay(service, cutoff);
    carrierCutoff = cutoff;
  }
  // Beyond the reference: "cutting it close" is never earlier than the safe date.
  if (compareDates(latestRisky, shipBy) < 0) latestRisky = shipBy;
  // The "cutting it close" date is left as computed (the report's worked examples depend on it),
  // but the sentence beside it names the carrier's own last day when that is earlier.
  const riskyCutoff = publishedCutoffFor(service, riskyTarget, transit.plan, offshore);
  const carrierLastDay = riskyCutoff && compareDates(latestRisky, riskyCutoff) > 0 ? riskyCutoff : null;

  return {
    service, config, international, buffer, holdDays,
    holdSource: confirmedHold !== null ? "property" : "usual",
    afterArrival, target, earliest, clippedToWindow, noDeliveryDayInWindow,
    transit,
    zone: usesZone ? zoneInfo.zone : null,
    zoneBasis: usesZone ? zoneInfo.basis : "not_used",
    zoneEstimate: usesZone ? zoneInfo.estimate : null,
    customsDays, peakDays, weatherDays, counted, shipBy, latestRisky, riskyTarget, carrierCutoff, carrierLastDay,
  };
}

// --- the words -------------------------------------------------------------------------------------

/** USPS counts Saturdays, so its days are "delivery days"; everyone else's are "business days". */
function dayWord(config: ServiceConfig): string {
  return config.calendar === "usps" ? "delivery day" : "business day";
}

function paddingReasons(core: Core): { days: number; reason: string }[] {
  const parts: { days: number; reason: string }[] = [];
  if (core.customsDays > 0) parts.push({ days: core.customsDays, reason: "customs" });
  if (core.peakDays > 0) parts.push({ days: core.peakDays, reason: "peak season" });
  if (core.weatherDays > 0) parts.push({ days: core.weatherDays, reason: "bad weather" });
  return parts;
}

function targetReason(input: ShipByInput, core: Core): string {
  const words = DESTINATION_WORDS[input.destination];
  const when = `you ${words.arriveVerb} on ${dayAndDate(input.arrivalDate)}`;
  if (core.target === input.arrivalDate) return `the day you ${words.arriveVerb}`;
  if (core.afterArrival) return `the first delivery day after ${when}`;
  if (core.clippedToWindow) return `the first delivery day ${words.place} will hold it before ${when}`;
  if (core.buffer === 0) return `the last delivery day before ${when}`;
  return `${count(core.buffer, dayWord(core.config))} before ${when}`;
}

function buildSteps(input: ShipByInput, core: Core): ShipByStep[] {
  const words = DESTINATION_WORDS[input.destination];
  const noun = parcelNoun(input.shipmentKind).one;
  const carrier = carrierName(core.config.provider);
  const unit = dayWord(core.config);
  const policy = DESTINATION_POLICIES[input.destination];
  const steps: ShipByStep[] = [];
  const arrival = input.arrivalDate;

  steps.push({ key: "arrival", text: `You ${words.arriveVerb} on ${dayAndDate(arrival)}.` });

  // The window it should arrive in.
  if (core.afterArrival) {
    steps.push({
      key: "window",
      text: `A rental has nobody to take in a ${noun} before you ${words.arriveVerb}, so it should arrive on or after ${dayAndDate(arrival)}.`,
    });
  } else {
    const windowEnd = core.buffer === 0 || core.holdDays === 0 ? arrival : addDays(arrival, -1);
    const range = formatDateRange(core.earliest, windowEnd);
    const held = count(core.holdDays, "day");
    let text: string;
    if (core.holdSource === "property") {
      const isPlace = isPickupPoint(input.destination) || isStaffedProperty(input.destination);
      const who = isPlace ? `${sentenceCase(words.place)} said it` : "Your host said they";
      text =
        core.holdDays === 0
          ? `${who} can't hold a ${noun} before you ${words.arriveVerb}, so it should arrive on ${dayAndDate(arrival)}, the day you ${words.arriveVerb}.`
          : `${who} can hold a ${noun} for ${held}, so it should arrive ${range}.`;
    } else if (isPickupPoint(input.destination)) {
      const kept = policy.keptForDays ?? core.holdDays;
      text =
        input.destination === "usps_general_delivery"
          ? `Post offices keep General Delivery mail for up to ${kept} days. To leave room, it should arrive ${range}.`
          : `${words.kindPlural} keep a package for ${count(kept, "day")}, then send it back. To leave room, it should arrive ${range}.`;
    } else if (input.destination === "relative_home") {
      text = `A ${noun} can wait at someone's home for about ${count(Math.round(core.holdDays / 7), "week")}, so it should arrive ${range}.`;
    } else {
      text = `${words.kindPlural} usually hold a ${noun} for ${held}, so it should arrive ${range}.`;
    }
    steps.push({ key: "window", text });
  }

  // The day to aim for.
  let targetText: string;
  if (core.afterArrival) {
    targetText =
      core.target === arrival
        ? `${carrier} delivers that day, so that is the day to aim for.`
        : `The first delivery day on or after that is ${dayAndDate(core.target)}.`;
  } else if (core.noDeliveryDayInWindow) {
    targetText = `No delivery day falls inside that window. The closest one before it is ${dayAndDate(core.target)}.`;
  } else if (core.target === arrival) {
    targetText = `Aim for ${dayAndDate(core.target)}, the day you ${words.arriveVerb}.`;
  } else if (core.clippedToWindow) {
    targetText = `Aim for ${dayAndDate(core.target)}, the first delivery day inside that window.`;
  } else if (core.buffer === 0) {
    targetText = `Aim for ${dayAndDate(core.target)}, the last delivery day before you ${words.arriveVerb}.`;
  } else {
    const customs = core.international ? `, ${INTERNATIONAL_BUFFER_DAYS} of them because customs can hold things up` : "";
    targetText = `Aim for ${dayAndDate(core.target)}: ${count(core.buffer, unit)} before you ${words.arriveVerb}${customs}, so there is time to sort things out if it runs late.`;
  }
  steps.push({ key: "target", text: targetText });

  // How long the carrier takes.
  const { best, plan } = core.transit;
  const name = core.config.name;
  let transitText: string;
  if (core.zoneBasis === "not_used") {
    transitText = best === plan ? `${name} takes ${count(plan, unit)}.` : `${name} takes ${best}–${plan} ${unit}s. This plan allows ${plan}.`;
  } else if (core.zoneBasis === "postal_codes" && core.zoneEstimate) {
    const route =
      core.zoneEstimate.fromArea === core.zoneEstimate.toArea
        ? `within ${core.zoneEstimate.fromArea}`
        : `from ${core.zoneEstimate.fromArea} to ${core.zoneEstimate.toArea}`;
    transitText = `${name} takes about ${count(plan, unit)} ${route}.`;
  } else if (core.zone !== null && core.zone >= OFFSHORE_ZONE) {
    transitText = `${name} takes about ${count(plan, unit)} to or from Alaska, Hawaii and the islands.`;
  } else if (core.zoneBasis === "given") {
    transitText = `${name} takes about ${count(plan, unit)} over this distance.`;
  } else {
    transitText = `${name} can take up to ${count(plan, unit)} coast to coast. Add both ZIP codes for a closer estimate.`;
  }
  if (!core.config.air) transitText += " That is an estimate, not a promise.";
  steps.push({ key: "transit", text: transitText });

  // Padding.
  const reasons = paddingReasons(core);
  if (reasons.length > 0) {
    const parts = reasons.map((part, index) => `${index === 0 ? count(part.days, unit) : part.days} for ${part.reason}`);
    const why = core.peakDays > 0 ? ", when the holidays slow every carrier down" : "";
    steps.push({ key: "padding", text: `Add ${listOf(parts)}${reasons[reasons.length - 1].reason === "peak season" ? why : ""}.` });
  }

  // Counting back.
  const total = plan + core.customsDays + core.peakDays + core.weatherDays;
  let countText = `Counting back ${count(total, unit)} from ${dayAndDate(core.target)} gives ${dayAndDate(core.counted)}.`;
  const skipped = closedDaysBetween(core.service, core.counted, core.target);
  if (skipped.length > 0) {
    const names = [...new Set(skipped.map((day) => day.name))];
    const allClosed = skipped.every((day) => day.status === "closed");
    countText += ` That skips ${listOf(names)}, when ${carrier} ${allClosed ? "is closed" : "isn't moving ground parcels"}.`;
  }
  const safeDay = previousShipDay(core.service, core.counted);
  if (safeDay !== core.counted) {
    const special = carrierDay(core.service, core.counted);
    const what = special?.status === "modified" ? "closes early" : "doesn't pick up";
    countText += ` ${carrier} ${what} on ${special?.name ?? "that day"}, so ship by ${dayAndDate(safeDay)} instead.`;
  }
  steps.push({ key: "count_back", text: countText });

  if (core.carrierCutoff) {
    steps.push({
      key: "carrier_cutoff",
      text: `${carrier} itself says ${dayAndDate(core.carrierCutoff)} is the last day to ship this way for Christmas, so that is the date to go by.`,
    });
  }

  if (compareDates(core.latestRisky, core.shipBy) > 0) {
    const ownLastDay = core.carrierLastDay
      ? ` ${carrier}'s own last day to ship this way for Christmas is ${dayAndDate(core.carrierLastDay)}.`
      : "";
    steps.push({
      key: "cutting_close",
      text: `Cutting it close: sent by ${dayAndDate(core.latestRisky)}, it can still arrive by ${dayAndDate(core.riskyTarget)} if nothing goes wrong.${ownLastDay}`,
    });
  }

  steps.push({
    key: "drop_off",
    text: `Hand it over before about ${DROP_OFF_CUTOFF_HOUR - 12} pm. Later than that, or in a drop box, it leaves the next day.`,
  });
  return steps;
}

function poundsOf(weight: Parcel["weight"]): number | null {
  if (!weight) return null;
  return weight.unit === "kg" ? weight.value * 2.20462 : weight.value;
}

const usd = (amount: number): Money => ({ amount, currency: HANDLING_FEE_DEFAULTS.currency });

/**
 * What the place is likely to charge to receive one box: what the property confirmed, or what
 * such places usually charge. Null for homes, rentals and pickup points, which do not charge.
 */
export function handlingFeeEstimate(
  destination: ShipmentDestinationType,
  options: { property?: PropertyTerms | null; parcels?: readonly Pick<Parcel, "weight">[]; shipmentKind?: ShipmentKind | null } = {},
): HandlingFee | null {
  const words = DESTINATION_WORDS[destination];
  const noun = parcelNoun(options.shipmentKind).one;
  const confirmed = options.property?.feePerBox;
  if (confirmed) {
    const who = isStaffedProperty(destination) || isPickupPoint(destination) ? sentenceCase(words.place) : "Your host";
    return {
      source: "property",
      perBox: confirmed,
      low: null,
      high: null,
      text:
        confirmed.amount === 0
          ? `${who} doesn't charge to receive a ${noun}.`
          : `${who} charges ${plainMoney(confirmed)} a ${noun} to receive it.`,
    };
  }
  if (!isStaffedProperty(destination)) return null;

  if (destination === "conference_venue") {
    const { perPound, minimum, maximum } = HANDLING_FEE_DEFAULTS.conferenceVenue;
    const heaviest = Math.max(0, ...(options.parcels ?? []).map((parcel) => poundsOf(parcel.weight) ?? 0));
    const rule = `about ${plainMoney(usd(perPound))} a pound, with a ${plainMoney(usd(minimum))} minimum`;
    if (heaviest > 0) {
      const fee = usd(Math.min(maximum, Math.max(minimum, Math.round(perPound * heaviest))));
      return {
        source: "typical",
        perBox: fee,
        low: usd(minimum),
        high: usd(maximum),
        text: `Conference hotels and venues usually charge by weight, ${rule}: about ${plainMoney(fee)} for a ${Math.round(heaviest)} lb ${noun}.`,
      };
    }
    return {
      source: "typical", perBox: null, low: usd(minimum), high: usd(maximum),
      text: `Conference hotels and venues usually charge by weight, ${rule}.`,
    };
  }

  const { low, typical, high } = HANDLING_FEE_DEFAULTS.hotel;
  return {
    source: "typical",
    perBox: usd(typical),
    low: usd(low),
    high: usd(high),
    text:
      `${words.kindPlural} often charge about ${plainMoney(usd(typical))} a ${noun} to receive it, anywhere from nothing to ${plainMoney(usd(high))}. ` +
      `If it arrives before they are ready to hold it, storage can run about ${plainMoney(usd(HANDLING_FEE_DEFAULTS.storagePerDay))} a day.`,
  };
}

const LEVEL_ORDER: Record<ShipByWarning["level"], number> = { alert: 0, caution: 1, info: 2 };

/** The carrier a pickup point belongs to, or null when any carrier can deliver there. */
function requiredProvider(destination: ShipmentDestinationType): "ups" | "fedex" | "usps" | null {
  if (destination === "ups_access_point") return "ups";
  if (destination === "fedex_hold_at_location") return "fedex";
  if (destination === "usps_general_delivery") return "usps";
  return null;
}

const LADDERS: Record<ServiceProvider, { domestic: ServiceKey[]; international: ServiceKey[] }> = {
  ups: {
    domestic: ["ups_ground", "ups_3_day_select", "ups_2nd_day_air", "ups_next_day_air"],
    international: ["ups_worldwide_expedited", "ups_worldwide_express"],
  },
  fedex: {
    domestic: ["fedex_ground", "fedex_express_saver", "fedex_2day", "fedex_overnight"],
    international: ["fedex_intl_economy", "fedex_intl_priority_express"],
  },
  usps: {
    domestic: ["usps_ground_advantage", "usps_priority_mail", "usps_priority_mail_express"],
    international: ["usps_priority_mail_intl", "usps_priority_mail_express_intl"],
  },
  dhl: { domestic: [], international: ["dhl_express_worldwide"] },
  lugless: { domestic: ["lugless_ground", "lugless_express"], international: [] },
  luggage_forward: {
    domestic: ["luggage_forward_domestic"],
    international: ["luggage_forward_intl_standard", "luggage_forward_intl_express"],
  },
  luggage_free: { domestic: ["luggage_free_domestic"], international: ["luggage_free_intl"] },
};

/**
 * The service levels one carrier or luggage service offers, slowest (and usually cheapest)
 * first: servicesOf("ups") is Ground, 3 Day Select, 2nd Day Air, Next Day Air.
 * For a home or a rental, FedEx Ground becomes FedEx Home Delivery, its residential name.
 */
export function servicesOf(
  provider: ServiceProvider,
  options: { international?: boolean; destination?: ShipmentDestinationType } = {},
): ServiceKey[] {
  const ladder = LADDERS[provider][options.international ? "international" : "domestic"];
  const residential = options.destination === "relative_home" || options.destination === "vacation_rental";
  return ladder.map((service) => (service === "fedex_ground" && residential ? "fedex_home_delivery" : service));
}

function findFasterOption(input: ShipByInput, core: Core, today: LocalDate): FasterOption | null {
  const own = core.config.provider;
  const required = requiredProvider(input.destination);
  const others: ServiceProvider[] = required ? [] : (["ups", "fedex", "usps", "dhl"] as const).filter((p) => p !== own);
  const options = { international: core.international, destination: input.destination };
  for (const provider of [own, ...others]) {
    // Slowest first, so the first one that works is the cheapest way to still make it.
    for (const service of servicesOf(provider, options)) {
      if (service === core.service) continue;
      const other = compute({ ...input, service });
      if (other.noDeliveryDayInWindow) continue;
      if (compareDates(other.shipBy, today) >= 0) {
        return { service, serviceName: SERVICES[service].name, shipByDate: other.shipBy, targetDeliveryDate: other.target };
      }
    }
  }
  return null;
}

function buildWarnings(input: ShipByInput, core: Core, faster: FasterOption | null): ShipByWarning[] {
  const words = DESTINATION_WORDS[input.destination];
  const noun = parcelNoun(input.shipmentKind).one;
  const carrier = carrierName(core.config.provider);
  const name = core.config.name;
  const place = sentenceCase(words.place);
  const warnings: ShipByWarning[] = [];
  const add = (code: ShipByWarningCode, level: ShipByWarning["level"], text: string) => warnings.push({ code, level, text });

  if (input.today && compareDates(core.shipBy, input.today) < 0) {
    let text = `The safe day to send this by ${name} was ${dayAndDate(core.shipBy)}.`;
    if (faster) {
      text += ` ${faster.serviceName} still works if you ship by ${dayAndDate(faster.shipByDate)}.`;
    } else if (compareDates(core.latestRisky, input.today) >= 0) {
      text += ` Sent by ${dayAndDate(core.latestRisky)}, it can still make it if nothing goes wrong.`;
    } else {
      text += ` Nothing gets it to ${words.place} in time now. Send it to a pickup point near where you're staying, or buy it there.`;
    }
    add("ship_by_passed", "alert", text);
  } else if (input.today && core.shipBy === input.today) {
    add(
      "ship_by_today",
      "caution",
      `Today is the last safe day to send this by ${name}. Hand it over before about ${DROP_OFF_CUTOFF_HOUR - 12} pm.`,
    );
  }

  if (input.property?.accepts === false) {
    add("property_declined", "alert", `${place} said it won't accept packages. Send it to a pickup point nearby instead.`);
  } else if (input.destination === "vacation_rental" && input.property?.confirmed !== true && input.property?.accepts !== true) {
    add(
      "host_consent_needed",
      "caution",
      "Only send it to a rental if the host says yes in writing. If they say no, use a pickup point nearby.",
    );
  }

  if (core.noDeliveryDayInWindow) {
    add(
      "no_delivery_day_in_window",
      "caution",
      `No delivery day falls inside the days ${words.place} will hold a ${noun}. Ask ${words.whoToAsk} whether ${dayAndDate(core.target)} is all right, or use a pickup point.`,
    );
  }

  if (input.international === true && !core.config.international) {
    add("service_not_international", "caution", `${name} doesn't cross borders. Pick an international service to get dates you can rely on.`);
  }

  const required = requiredProvider(input.destination);
  if (required && core.config.provider !== required) {
    const only = carrierName(required);
    const where = input.destination === "usps_general_delivery" ? "General Delivery" : words.place.replace(/^the /, "a ");
    add("carrier_mismatch", "caution", `Only ${only} delivers to ${where}. Pick a ${only} service.`);
  }
  if (input.destination === "amazon_locker" || input.destination === "amazon_counter") {
    add(
      "amazon_orders_only",
      "info",
      `Only Amazon orders can go to ${words.place.replace(/^the /, "an ")}. Choose it as the delivery address when you order.`,
    );
  }

  const heaviest = Math.max(0, ...(input.parcels ?? []).map((parcel) => poundsOf(parcel.weight) ?? 0));
  if (isStaffedProperty(input.destination) && heaviest > HANDLING_FEE_DEFAULTS.heavyBoxLb) {
    add(
      "heavy_box",
      "caution",
      `Over ${HANDLING_FEE_DEFAULTS.heavyBoxLb} lb, ${words.kindPlural.toLowerCase()} often charge more or turn the ${noun} away. Split it in two if you can.`,
    );
  }

  if (input.destination === "cruise_precruise_hotel") {
    add(
      "cruise_terminal",
      "info",
      "Never send anything to the cruise terminal: it has nowhere to keep it. This goes to your hotel the night before. To have bags waiting in your cabin, use a luggage service that delivers to the ship.",
    );
  }

  const confidence = calendarConfidence(core.service, core.target);
  if (confidence === "unknown") {
    add("calendar_not_covered", "caution", "Carrier holidays that far ahead aren't known yet, so this date ignores them. Check again closer to the day.");
  } else if (confidence === "projected") {
    const who = core.config.calendar === "major_holidays" ? "Carriers have" : `${carrier} has`;
    add("calendar_projected", "info", `${who} not published a holiday schedule that far ahead, so this follows last year's pattern. Check again closer to the day.`);
  }

  if (core.peakDays > 0) {
    add(
      "peak_season",
      "info",
      `Peak season: ${count(core.peakDays, "extra business day")} ${core.peakDays === 1 ? "is" : "are"} built in, because carriers run slow from mid-November to early January.`,
    );
  }

  if (isStaffedProperty(input.destination) && input.property?.confirmed !== true && core.holdSource === "usual" && input.property?.accepts !== false) {
    add("ask_property_first", "info", `This uses what ${words.kindPlural.toLowerCase()} usually allow. Ask ${words.whoToAsk} to confirm before you ship.`);
  }

  return warnings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

// --- the public functions --------------------------------------------------------------------------

/**
 * Works out when to ship so it is waiting when she arrives, and explains each step.
 *
 *   const plan = shipByPlan({
 *     destination: "vacation_rental", arrivalDate: "2026-12-19", service: "ups_ground",
 *     originPostalCode: "98101", destinationPostalCode: "32801", today: localDateOf(now, user.home.tz),
 *   });
 *   plan.headline   // "Ship by Thu, Dec 10 so it arrives Mon, Dec 21"
 *   plan.steps      // the arithmetic, one sentence per step
 *   plan.warnings   // "Only send it to a rental if the host says yes in writing. …"
 *
 * Store the result with shipByFieldsToStore(plan). Dates are local calendar dates: the ship-by
 * date where she ships from, the delivery date at the destination.
 *
 * Transit times are planning estimates, not carrier quotes. Throws RangeError only when
 * `arrivalDate` (or `today`) is not a real `YYYY-MM-DD` date.
 */
export function shipByPlan(input: ShipByInput): ShipByPlan {
  const core = compute(input);
  const config = core.config;
  const unit = dayWord(config);

  const passed = input.today !== undefined && compareDates(core.shipBy, input.today) < 0;
  const fasterOption = passed && input.today ? findFasterOption(input, core, input.today) : null;

  const reasons = paddingReasons(core);
  const plus = reasons.length > 0 ? ` plus ${listOf(reasons.map((part) => `${part.days} for ${part.reason}`))}` : "";
  const summary = `${config.name}, ${count(core.transit.plan, unit)}${plus}. Arrives ${dayAndDate(core.target)}, ${targetReason(input, core)}.`;

  const fiveDaysBefore = addDays(core.shipBy, -5);
  const askPropertyOn = isPickupPoint(input.destination)
    ? null
    : input.today && compareDates(fiveDaysBefore, input.today) < 0
      ? input.today
      : fiveDaysBefore;

  return {
    service: core.service,
    serviceName: config.name,
    targetDeliveryDate: core.target,
    shipByDate: core.shipBy,
    latestRiskyDate: core.latestRisky,
    earliestAcceptableDate: core.earliest,
    headline: `Ship by ${dayAndDate(core.shipBy)} so it arrives ${dayAndDate(core.target)}`,
    summary,
    cuttingItClose: compareDates(core.latestRisky, core.shipBy) > 0 ? `Cutting it close: ${dayAndDate(core.latestRisky)}` : null,
    steps: buildSteps(input, core),
    warnings: buildWarnings(input, core, fasterOption),
    fee: handlingFeeEstimate(input.destination, input),
    transit: {
      planDays: core.transit.plan,
      bestDays: core.transit.best,
      paddingDays: core.customsDays + core.peakDays + core.weatherDays,
      customsDays: core.customsDays,
      peakDays: core.peakDays,
      weatherDays: core.weatherDays,
      zone: core.zone,
      zoneBasis: core.zoneBasis,
    },
    reminders: {
      askPropertyOn,
      packOn: addDays(core.shipBy, -1),
      checkArrivedOn: addDays(core.target, 1),
    },
    fasterOption,
    calculatorUrl: TRANSIT_CALCULATOR_URLS[config.provider] ?? null,
  };
}

export type ShipByOption = {
  service: ServiceKey;
  serviceName: string;
  /** "UPS Ground: ship by Thu, Dec 10". */
  line: string;
  /** False when today is already past this service's ship-by date. Always true without `today`. */
  stillPossible: boolean;
  plan: ShipByPlan;
};

/**
 * The ship-by date for each speed one carrier offers, slowest first: the "When" step of the
 * flow. The carrier defaults to the one the destination needs (UPS for a UPS Access Point, USPS
 * for General Delivery), otherwise UPS.
 *
 *   shipByOptions({ destination: "vacation_rental", arrivalDate: "2026-12-19" }).map((o) => o.line)
 *     -> ["UPS Ground: ship by Thu, Dec 10", "UPS 3 Day Select: ship by Tue, Dec 15", …]
 */
export function shipByOptions(
  input: Omit<ShipByInput, "service">,
  provider?: ServiceProvider,
): ShipByOption[] {
  const carrier = provider ?? requiredProvider(input.destination) ?? "ups";
  return servicesOf(carrier, { international: input.international === true, destination: input.destination }).map((service) => {
    const plan = shipByPlan({ ...input, service });
    return {
      service,
      serviceName: plan.serviceName,
      line: `${plan.serviceName}: ship by ${dayAndDate(plan.shipByDate)}`,
      stillPossible: input.today === undefined || compareDates(plan.shipByDate, input.today) >= 0,
      plan,
    };
  });
}

/**
 * The fields of bookings.details that the arithmetic owns, ready to spread into ShipmentDetails:
 *
 *   details = { ...details, ...shipByFieldsToStore(plan) }
 *
 * Warnings that depend on today's date ("the ship-by date has passed") are left out, because a
 * stored copy would go stale; shipmentStatus() works those out fresh each time.
 */
export function shipByFieldsToStore(plan: ShipByPlan): {
  serviceKey: ServiceKey;
  targetDeliveryDate: LocalDate;
  shipByDate: LocalDate;
  latestRiskyDate: LocalDate;
  warnings: string[];
} {
  return {
    serviceKey: plan.service,
    targetDeliveryDate: plan.targetDeliveryDate,
    shipByDate: plan.shipByDate,
    latestRiskyDate: plan.latestRiskyDate,
    warnings: plan.warnings
      .filter((warning) => warning.code !== "ship_by_passed" && warning.code !== "ship_by_today")
      .map((warning) => warning.text.slice(0, 300)),
  };
}

// --- the way home ----------------------------------------------------------------------------------

export type ReturnInput = {
  /** The day she leaves (the stay's check-out date), as a local date where she is staying. */
  checkoutDate: LocalDate;
  service: ServiceKey;
  /** Where it leaves from (the stay) and where it is going (home). */
  originPostalCode?: string | null;
  destinationPostalCode?: string | null;
  zone?: number | null;
  international?: boolean;
  shipmentKind?: ShipmentKind | null;
};

export type ReturnPlan = {
  service: ServiceKey;
  serviceName: string;
  /** The day to hand it over: check-out day, or the first day after it the carrier collects. */
  shipOnDate: LocalDate;
  /** When to expect it home, planning for the slow end. */
  arrivesByDate: LocalDate;
  /** "Send it home on Sat, Dec 26. Expect it by Mon, Jan 4". */
  headline: string;
  /** The arithmetic, one sentence per step. */
  steps: { key: "ship_on" | "transit" | "arrives"; text: string }[];
};

/**
 * The way home: send it on check-out day and say when it should be back (report 5.6: the same
 * transit days and padding as the way out, with no arrival buffer, counted forwards).
 *
 *   returnPlan({ checkoutDate: stay.checkOutDate, service: "ups_ground", originPostalCode: "32801", destinationPostalCode: "98101" })
 *
 * Ask the property first whether it will hold a prepaid, labeled box for the carrier to collect
 * (question 8 of PROPERTY_CHECKLIST).
 */
export function returnPlan(input: ReturnInput): ReturnPlan {
  const config: ServiceConfig = SERVICES[input.service];
  const international = input.international === true || config.international;
  const zoneInfo = resolveZone({ ...input, destination: "relative_home", arrivalDate: input.checkoutDate });
  const transit = transitDaysFor(input.service, zoneInfo.zone);
  const noun = parcelNoun(input.shipmentKind).one;
  const unit = dayWord(config);
  const carrier = carrierName(config.provider);

  const shipOn = nextShipDay(input.service, input.checkoutDate);
  const customsDays = international ? config.customsPadDays || 2 : 0;
  let arrives = addTransitDays(input.service, shipOn, transit.plan + customsDays);
  let peakDays = 0;
  if (inPeakSeason(shipOn) || inPeakSeason(arrives)) {
    peakDays = config.air && !international ? PEAK_PADDING_DAYS.domesticExpress : PEAK_PADDING_DAYS.ground;
    arrives = addTransitDays(input.service, shipOn, transit.plan + customsDays + peakDays);
  }

  const reasons = [
    ...(customsDays > 0 ? [`${customsDays} for customs`] : []),
    ...(peakDays > 0 ? [`${peakDays} for peak season`] : []),
  ];
  const special = carrierDay(input.service, input.checkoutDate);
  const shipText =
    shipOn === input.checkoutDate
      ? `You check out on ${dayAndDate(input.checkoutDate)}, and ${carrier} collects that day.`
      : `You check out on ${dayAndDate(input.checkoutDate)}${special ? ` (${special.name})` : ""}. The first day ${carrier} collects after that is ${dayAndDate(shipOn)}, so leave the ${noun} labeled and ready.`;
  return {
    service: input.service,
    serviceName: config.name,
    shipOnDate: shipOn,
    arrivesByDate: arrives,
    headline: `Send it home on ${dayAndDate(shipOn)}. Expect it by ${dayAndDate(arrives)}`,
    steps: [
      { key: "ship_on", text: shipText },
      {
        key: "transit",
        text: `${config.name} takes about ${count(transit.plan, unit)}${reasons.length > 0 ? `, plus ${listOf(reasons)}` : ""}.`,
      },
      { key: "arrives", text: `Counting forward from ${dayAndDate(shipOn)}, it should be home by ${dayAndDate(arrives)}.` },
    ],
  };
}
