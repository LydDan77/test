// parseConfirmation: pasted confirmation text in, a booking to check and save out.
//
// It reads what is clearly there and nothing else. A field it is not sure of is left empty and
// named in `warnings`, in plain words the record form can show as they are. It never invents a
// value, never fills a time zone in (every date and time is local, as printed), and never
// throws, whatever is pasted.

import type { FlightSegment, Money, MealType, LodgingType, VehicleClass } from "@/lib/domain";
import { isLocalDate, zonedToUtc } from "@/lib/time";
import { readCar } from "./parsing/car";
import { detectKind, findConfirmationCode, findOrderNumber, findTotal, type ParsedKind } from "./parsing/common";
import { findDates } from "./parsing/dates";
import { readFlight, type ParsedFlightSegment } from "./parsing/flight";
import { readFood } from "./parsing/food";
import { readRide } from "./parsing/ride";
import { readStay } from "./parsing/stay";
import { prepare, type Prepared } from "./parsing/text";

export type { ParsedKind } from "./parsing/common";
export type { ParsedFlightSegment } from "./parsing/flight";

/** A hint for the reader. Just the kind is fine: `parseConfirmation(text, "flight")`. */
export type ParseHint = {
  /** The kind of booking the person is recording. Read as that kind without guessing. */
  kind?: ParsedKind | "shipment";
  /**
   * A date near the booking (the plan's first day, or today), used ONLY to give a year to dates
   * the text prints without one. When it is used, a warning says which year was assumed.
   */
  referenceDate?: string;
  /** The currency a bare "$" stands for. Default USD. */
  currency?: string;
  /** Says whether three letters are a real airport code, when an airport table is at hand. Fewer false readings with it. */
  isAirportCode?: (code: string) => boolean;
};

export type FlightFields = {
  /** The airline of the first flight: "AS" and "Alaska Airlines". */
  airlineIata?: string;
  airlineName?: string;
  confirmationCode?: string;
  /** Names after a "Passengers:" label, as "First Last". Empty when the text has no such label. */
  passengerNames: string[];
  total?: Money;
};

export type StayFields = {
  /** The site it was booked through, when named: "Airbnb". */
  provider?: string;
  lodgingType?: LodgingType;
  propertyName?: string;
  /** One line: "1420 Lake Shore Dr, Orlando, FL 32801". */
  address?: string;
  /** Local dates (`YYYY-MM-DD`) and times (`HH:mm`) at the property. */
  checkInDate?: string;
  checkInTime?: string;
  checkOutDate?: string;
  checkOutTime?: string;
  confirmationCode?: string;
  total?: Money;
};

export type CarFields = {
  company?: string;
  /** Where the car is picked up and returned, in the confirmation's own words. */
  pickupPlace?: string;
  pickupDate?: string;
  pickupTime?: string;
  returnPlace?: string;
  returnDate?: string;
  returnTime?: string;
  vehicleClass?: VehicleClass;
  /** "Toyota RAV4 or similar (Intermediate SUV)". */
  vehicleDescription?: string;
  confirmationCode?: string;
  total?: Money;
};

export type RideFields = {
  /** "Uber", "Lyft". */
  provider?: string;
  pickupDate?: string;
  pickupTime?: string;
  pickupAddress?: string;
  dropoffAddress?: string;
  /** A trip or confirmation number, when the receipt has one. */
  confirmationCode?: string;
  total?: Money;
};

export type FoodFields = {
  /** "DoorDash", "Instacart". */
  provider?: string;
  /** The restaurant, store or caterer. */
  vendorName?: string;
  mealType?: MealType;
  deliveryDate?: string;
  windowStart?: string;
  windowEnd?: string;
  deliveryAddress?: string;
  orderNumber?: string;
  total?: Money;
};

/** The fields for whichever kind was read. */
export type ParsedFields = FlightFields | StayFields | CarFields | RideFields | FoodFields;

type Common = {
  /**
   * 0 to 1: how much of what a booking of this kind needs was found, and how sure the kind is.
   * 0.75 and up is "looks complete"; under 0.4, show the form mostly empty and say so.
   */
  confidence: number;
  /** What could not be found or needs a check, each a plain sentence to show above the form. */
  warnings: string[];
};

/**
 * What was read. `switch (parsed.kind)` narrows `fields`. Dates are `YYYY-MM-DD` and times
 * `HH:mm`, local to the place, exactly as printed: the reader does not know time zones.
 */
export type ParsedConfirmation = Common &
  (
    | { kind: "flight"; fields: FlightFields; /** One per flight, in travel order. */ segments: ParsedFlightSegment[] }
    | { kind: "lodging"; fields: StayFields; segments?: undefined }
    | { kind: "car"; fields: CarFields; segments?: undefined }
    | { kind: "ride"; fields: RideFields; segments?: undefined }
    | { kind: "meal"; fields: FoodFields; segments?: undefined }
    | { kind: null; fields: Record<string, never>; segments?: undefined }
  );

const ADD_BELOW = "Add it below.";

function prune<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
}

/** A reading without the two notes that only feed the warnings. */
function withoutNotes<T extends { yearAssumed: boolean; ambiguousDate?: string }>(reading: T): Omit<T, "yearAssumed" | "ambiguousDate"> {
  const copy: Partial<T> = { ...reading };
  delete copy.yearAssumed;
  delete copy.ambiguousDate;
  return copy as Omit<T, "yearAssumed" | "ambiguousDate">;
}

function score(parts: Array<[found: unknown, weight: number]>): number {
  return parts.reduce((sum, [found, weight]) => sum + (found ? weight : 0), 0);
}

function yearWarning(yearAssumed: boolean, referenceDate: string | undefined): string[] {
  return yearAssumed && referenceDate ? [`The text doesn't say the year. We used ${referenceDate.slice(0, 4)}. Check the dates.`] : [];
}

function ambiguityWarning(raw: string | undefined): string[] {
  return raw ? [`We read ${raw} as month first, then day. Check the date.`] : [];
}

function readByKind(kind: ParsedKind, prepared: Prepared, hint: ParseHint, sentDate: string | undefined): ParsedConfirmation {
  const dateOpts = { sentDate, referenceDate: hint.referenceDate };
  const total = findTotal(prepared, hint.currency ?? "USD");
  const warnings: string[] = [];

  switch (kind) {
    case "flight": {
      const flight = readFlight(prepared, { ...dateOpts, isAirportCode: hint.isAirportCode });
      const confirmationCode = findConfirmationCode(prepared);
      if (flight.segments.length === 0) warnings.push("We couldn't find a flight number. Add the flights below.");
      for (const segment of flight.segments) {
        const name = `${segment.airlineIata ?? "Flight"} ${segment.flightNumber ?? ""}`.trim();
        if (!segment.airlineIata) warnings.push(`We couldn't tell which airline flight ${segment.flightNumber} is. ${ADD_BELOW}`);
        if (!segment.originIata || !segment.destinationIata) warnings.push(`We couldn't find the airports for ${name}. Add them below.`);
        if (!segment.departTime) warnings.push(`We couldn't find when ${name} leaves. ${ADD_BELOW}`);
        else if (!segment.departDate) warnings.push(`We couldn't tell which day ${name} leaves. ${ADD_BELOW}`);
        if (!segment.arriveTime) warnings.push(`We couldn't find when ${name} lands. ${ADD_BELOW}`);
        else if (!segment.arriveDate) warnings.push(`We couldn't tell which day ${name} lands. ${ADD_BELOW}`);
      }
      if (!confirmationCode) warnings.push("We couldn't find the confirmation code. Add it below, or choose No code.");
      warnings.push(...yearWarning(flight.yearAssumed, hint.referenceDate), ...ambiguityWarning(flight.ambiguousDate));
      const complete = flight.segments.filter((s) => s.airlineIata && s.originIata && s.destinationIata && s.departDate && s.departTime && s.arriveDate && s.arriveTime);
      const confidence = score([
        [flight.segments.length > 0, 0.35],
        [flight.segments.length > 0 && complete.length === flight.segments.length, 0.35],
        [confirmationCode, 0.2],
        [flight.airlineIata, 0.1],
      ]);
      return {
        kind,
        confidence,
        warnings,
        segments: flight.segments.map(prune),
        fields: prune({ airlineIata: flight.airlineIata, airlineName: flight.airlineName, confirmationCode, passengerNames: flight.passengerNames, total }),
      };
    }
    case "lodging": {
      const stay = readStay(prepared, dateOpts);
      const confirmationCode = findConfirmationCode(prepared);
      if (!stay.propertyName) warnings.push(`We couldn't find the name of the place. ${ADD_BELOW}`);
      if (!stay.checkInDate) warnings.push(`We couldn't find the check-in date. ${ADD_BELOW}`);
      if (!stay.checkOutDate) warnings.push(`We couldn't find the check-out date. ${ADD_BELOW}`);
      if (!stay.address) warnings.push(`We couldn't find the address. ${ADD_BELOW}`);
      if (!confirmationCode) warnings.push("We couldn't find the confirmation number. Add it below, or choose No code.");
      warnings.push(...yearWarning(stay.yearAssumed, hint.referenceDate), ...ambiguityWarning(stay.ambiguousDate));
      const confidence = score([
        [stay.propertyName, 0.25],
        [stay.checkInDate, 0.2],
        [stay.checkOutDate, 0.2],
        [confirmationCode, 0.2],
        [stay.address, 0.15],
      ]);
      const found = withoutNotes(stay);
      return { kind, confidence, warnings, fields: prune({ ...found, confirmationCode, total }) };
    }
    case "car": {
      const car = readCar(prepared, dateOpts);
      const confirmationCode = findConfirmationCode(prepared);
      if (!car.company) warnings.push(`We couldn't find the rental company. ${ADD_BELOW}`);
      if (!car.pickupDate) warnings.push(`We couldn't find the pick-up day. ${ADD_BELOW}`);
      if (!car.pickupTime) warnings.push(`We couldn't find the pick-up time. ${ADD_BELOW}`);
      if (!car.returnDate) warnings.push(`We couldn't find the return day. ${ADD_BELOW}`);
      if (!car.returnTime) warnings.push(`We couldn't find the return time. ${ADD_BELOW}`);
      if (!car.pickupPlace) warnings.push(`We couldn't find where you pick the car up. ${ADD_BELOW}`);
      if (!confirmationCode) warnings.push("We couldn't find the confirmation number. Add it below, or choose No code.");
      warnings.push(...yearWarning(car.yearAssumed, hint.referenceDate), ...ambiguityWarning(car.ambiguousDate));
      const confidence = score([
        [car.company, 0.15],
        [car.pickupDate && car.pickupTime, 0.25],
        [car.returnDate && car.returnTime, 0.25],
        [car.pickupPlace, 0.15],
        [confirmationCode, 0.2],
      ]);
      const found = withoutNotes(car);
      return { kind, confidence, warnings, fields: prune({ ...found, confirmationCode, total }) };
    }
    case "ride": {
      const ride = readRide(prepared, dateOpts);
      const confirmationCode = findConfirmationCode(prepared);
      if (!ride.provider) warnings.push(`We couldn't tell who the ride is with. ${ADD_BELOW}`);
      if (!ride.pickupDate) warnings.push(`We couldn't find the pick-up day. ${ADD_BELOW}`);
      if (!ride.pickupTime) warnings.push(`We couldn't find the pick-up time. ${ADD_BELOW}`);
      if (!ride.pickupAddress) warnings.push(`We couldn't find where the ride starts. ${ADD_BELOW}`);
      if (!ride.dropoffAddress) warnings.push(`We couldn't find where the ride ends. ${ADD_BELOW}`);
      warnings.push(...yearWarning(ride.yearAssumed, hint.referenceDate), ...ambiguityWarning(ride.ambiguousDate));
      const confidence = score([
        [ride.provider, 0.2],
        [ride.pickupDate && ride.pickupTime, 0.3],
        [ride.pickupAddress, 0.15],
        [ride.dropoffAddress, 0.15],
        [total, 0.2],
      ]);
      const found = withoutNotes(ride);
      return { kind, confidence, warnings, fields: prune({ ...found, confirmationCode, total }) };
    }
    case "meal": {
      const food = readFood(prepared, dateOpts);
      const orderNumber = findOrderNumber(prepared);
      if (!food.provider && !food.vendorName) warnings.push(`We couldn't tell who the order is with. ${ADD_BELOW}`);
      if (!food.deliveryDate) warnings.push(`We couldn't find the delivery day. ${ADD_BELOW}`);
      if (!food.windowStart) warnings.push(`We couldn't find the delivery time. ${ADD_BELOW}`);
      if (!food.deliveryAddress) warnings.push(`We couldn't find the delivery address. ${ADD_BELOW}`);
      if (!orderNumber) warnings.push("We couldn't find the order number. Add it below, or choose No code.");
      warnings.push(...yearWarning(food.yearAssumed, hint.referenceDate), ...ambiguityWarning(food.ambiguousDate));
      const confidence = score([
        [food.provider || food.vendorName, 0.2],
        [food.deliveryDate, 0.2],
        [food.windowStart, 0.15],
        [food.deliveryAddress, 0.1],
        [orderNumber, 0.2],
        [total, 0.15],
      ]);
      const found = withoutNotes(food);
      return { kind, confidence, warnings, fields: prune({ ...found, orderNumber, total }) };
    }
  }
}

const NOTHING: ParsedConfirmation = { kind: null, confidence: 0, fields: {}, warnings: [] };

/**
 * Reads a pasted confirmation email or page and returns the booking it describes, for the
 * person to check before saving.
 *
 *   const parsed = parseConfirmation(pastedText, { kind: "flight", referenceDate: plan.startDate });
 *   if (parsed.kind === "flight") parsed.segments  // each flight: airline, number, airports, local times
 *   parsed.fields.confirmationCode                  // "KXWQPL"
 *   parsed.warnings                                 // ["We couldn't find when AS 1055 lands. Add it below."]
 *
 * `hint` is the kind being recorded, or an object with more (see ParseHint). With no kind the
 * reader works it out; when it cannot, `kind` is null and a warning says so.
 *
 * What comes back is only what the text clearly says. Every date is a local `YYYY-MM-DD` and
 * every time a local `HH:mm`; turn a flight into stored segments with `toFlightSegments`, which
 * takes the airports' time zones from you. Private text is not kept: only the fields are.
 * Never throws.
 */
export function parseConfirmation(text: string, hint?: ParseHint | ParseHint["kind"]): ParsedConfirmation {
  const given: ParseHint = typeof hint === "string" ? { kind: hint } : (hint ?? {});
  try {
    if (typeof text !== "string" || text.trim().length < 12) {
      return { ...NOTHING, warnings: ["There isn't enough here to read. Paste the whole confirmation email or page."] };
    }
    if (given.kind === "shipment") {
      return { ...NOTHING, warnings: ["Send-ahead details are entered by hand. Paste the tracking number on the send-ahead page instead."] };
    }
    // Very long pastes (a whole inbox) are cut: a confirmation is near the top.
    const prepared = prepare(text.slice(0, 40_000));
    const sent = prepared.sentHeader ? findDates(prepared.sentHeader)[0]?.date ?? undefined : undefined;
    const sentDate = sent && isLocalDate(sent) ? sent : undefined;

    const detected = detectKind(prepared.text);
    const kind = given.kind ?? detected.kind;
    if (!kind) {
      return { ...NOTHING, warnings: ["We couldn't tell what kind of booking this is. Choose the kind and paste it again, or fill in the details below."] };
    }
    const result = readByKind(kind, prepared, given, sentDate);
    // Less sure when the kind was a close call, or the text reads like a different kind than the one asked for.
    const unsureOfKind = given.kind ? detected.kind !== null && detected.kind !== given.kind && detected.margin >= 3 : detected.margin < 2;
    const confidence = Math.round(Math.min(1, result.confidence * (unsureOfKind ? 0.7 : 1)) * 100) / 100;
    const warnings = [...result.warnings];
    if (given.kind && unsureOfKind) warnings.unshift("This doesn't read like the kind of booking you're recording. Check every field.");
    return { ...result, confidence, warnings: [...new Set(warnings)].slice(0, 12) };
  } catch {
    return { ...NOTHING, warnings: ["We couldn't read that. Fill in the details below."] };
  }
}

/**
 * Parsed flights as the segments a flight booking stores, for the flights that are complete.
 *
 * The confirmation gives local times; `timeZoneOf(iata)` supplies each airport's IANA zone (from
 * the airport table), and the instants are worked out here. A flight missing an airline, an
 * airport, a date or a time, or whose airport you cannot place, is not returned: its position is
 * listed in `incomplete` so the form can ask for it.
 *
 *   const { segments, incomplete } = toFlightSegments(parsed.segments, (iata) => airports.get(iata)?.tz);
 *   const details = parseBookingDetails("flight", { segments });
 */
export function toFlightSegments(
  parsed: readonly ParsedFlightSegment[],
  timeZoneOf: (iata: string) => string | null | undefined,
): { segments: FlightSegment[]; incomplete: number[] } {
  const segments: FlightSegment[] = [];
  const incomplete: number[] = [];
  parsed.forEach((flight, index) => {
    const originTz = flight.originIata ? timeZoneOf(flight.originIata) : undefined;
    const destinationTz = flight.destinationIata ? timeZoneOf(flight.destinationIata) : undefined;
    const ready =
      flight.airlineIata && flight.flightNumber && flight.originIata && flight.destinationIata && flight.departDate && flight.departTime && flight.arriveDate && flight.arriveTime && originTz && destinationTz;
    if (!ready) {
      incomplete.push(index);
      return;
    }
    try {
      const departsAt = zonedToUtc(`${flight.departDate}T${flight.departTime}`, originTz as string).toISOString();
      const arrivesAt = zonedToUtc(`${flight.arriveDate}T${flight.arriveTime}`, destinationTz as string).toISOString();
      // A flight that "lands before it takes off" was misread somewhere: ask rather than store it.
      if (Date.parse(arrivesAt) <= Date.parse(departsAt)) {
        incomplete.push(index);
        return;
      }
      segments.push({
        airlineIata: flight.airlineIata as string,
        ...(flight.airlineName ? { airlineName: flight.airlineName } : {}),
        flightNumber: (flight.flightNumber as string).toUpperCase(),
        originIata: flight.originIata as string,
        destinationIata: flight.destinationIata as string,
        departsAt,
        originTz: originTz as string,
        arrivesAt,
        destinationTz: destinationTz as string,
      });
    } catch {
      incomplete.push(index);
    }
  });
  return { segments, incomplete };
}

