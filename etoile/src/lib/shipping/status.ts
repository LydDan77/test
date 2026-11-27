// Where a send-ahead stands, in the words a tile shows, and what to do next.
//
// The app cannot read a parcel's location (carrier tracking APIs all need keys), so every status
// here is one she set by hand: planned, packed, shipped, delivered, picked up, problem.
// Pure: "today" and "now" are arguments.

import type { Parcel, ParcelStatus, ShipmentDestinationType, ShipmentKind } from "@/lib/domain";
import { PARCEL_STATUSES } from "@/lib/domain/booking-shipment";
import { addDays, compareDates, formatDate, type LocalDate } from "@/lib/time";
import { DESTINATION_POLICIES, DROP_OFF_CUTOFF_HOUR } from "./config";
import { detectCarrier, type DetectCarrierOptions, type TrackingDetection } from "./tracking";
import { DESTINATION_WORDS, count, dayAndDate, isPickupPoint, isStaffedProperty, parcelNoun, sentenceCase } from "./words";

export type ShipmentStatusInput = {
  /** The parcels as stored (ShipmentDetails.parcels). An empty list means one parcel, still planned. */
  parcels: readonly Pick<Parcel, "status" | "trackingNumber">[];
  /** Today. Before it ships, where she ships from; after, either: `localDateOf(now, user.home.tz)`. */
  today: LocalDate;
  shipmentKind?: ShipmentKind | null;
  destination?: ShipmentDestinationType | null;
  /** The stored outputs of shipByPlan(). */
  shipByDate?: LocalDate | null;
  targetDeliveryDate?: LocalDate | null;
  /** The day she gets there. */
  arrivalDate?: LocalDate | null;
  /** True once the property or host has answered (ShipmentDetails.propertyAnswers.confirmed). */
  propertyConfirmed?: boolean;
};

export type ShipmentActionKey =
  | "finish_planning"
  | "message_property"
  | "choose_how_to_send"
  | "mark_packed"
  | "see_faster_options"
  | "record_tracking"
  | "mark_delivered"
  | "mark_picked_up"
  | "check_tracking";

export type ShipmentTrackStep = {
  key: "planned" | "property_confirmed" | "packed" | "shipped" | "delivered" | "picked_up";
  /** "Planned", "Hotel confirmed", "Packed", "Shipped", "Delivered", "Picked up". */
  label: string;
  done: boolean;
  /** The step she is on now. Exactly one step is current unless everything is done. */
  current: boolean;
};

export type ShipmentStatus = {
  /**
   * The whole send-ahead in one word: the least advanced parcel's status, or `problem` when any
   * parcel has one. Readiness counts planned, shipped and delivered from this.
   */
  stage: ParcelStatus;
  /** The tile's line: "1 box on its way, arrives Dec 21". No full stop: it is a label. */
  line: string;
  /** The next nudge, as a sentence: "Did it arrive? Ask the front desk." Null when there is nothing to do. */
  nudge: string | null;
  /** How much the nudge matters. Null when there is no nudge. */
  level: "alert" | "caution" | "info" | null;
  /** The one button to show, or null when it is all done. */
  action: { key: ShipmentActionKey; label: string } | null;
  /** How many parcels are in each status. */
  counts: Record<ParcelStatus, number>;
  /** The status track, in order, for a stepper. */
  track: ShipmentTrackStep[];
};

/** Least advanced first. */
const RANK: Record<Exclude<ParcelStatus, "problem">, number> = { planned: 0, packed: 1, shipped: 2, delivered: 3, picked_up: 4 };

function phrase(status: ParcelStatus, n: number): string {
  switch (status) {
    case "planned": return "to send";
    case "packed": return "packed";
    case "shipped": return n === 1 ? "on its way" : "on their way";
    case "delivered": return "delivered";
    case "picked_up": return "picked up";
    case "problem": return n === 1 ? "has a problem" : "have a problem";
  }
}

/**
 * The plain status line and the next nudge for a send-ahead.
 *
 *   shipmentStatus({ parcels: details.parcels, today, shipmentKind: details.shipmentKind,
 *     destination: details.destinationType, shipByDate: details.shipByDate,
 *     targetDeliveryDate: details.targetDeliveryDate, arrivalDate: details.arrivalDate,
 *     propertyConfirmed: details.propertyAnswers?.confirmed })
 *   // { stage: "shipped", line: "1 box on its way, arrives Dec 21",
 *   //   nudge: null, action: { key: "mark_delivered", label: "Mark as arrived" }, … }
 *
 * The day after it should have arrived, the nudge becomes "Did it arrive? Ask the front desk."
 */
export function shipmentStatus(input: ShipmentStatusInput): ShipmentStatus {
  const noun = parcelNoun(input.shipmentKind);
  const parcels = input.parcels.length > 0 ? input.parcels : [{ status: "planned" as const }];
  const counts = Object.fromEntries(PARCEL_STATUSES.map((status) => [status, 0])) as Record<ParcelStatus, number>;
  for (const parcel of parcels) counts[parcel.status] += 1;

  const settled = (Object.keys(RANK) as (keyof typeof RANK)[]).filter((status) => counts[status] > 0);
  const stage: ParcelStatus =
    counts.problem > 0 ? "problem" : settled.reduce((least, status) => (RANK[status] < RANK[least] ? status : least), settled[0] ?? "planned");

  const { today, shipByDate, targetDeliveryDate } = input;
  const destination = input.destination ?? null;
  const words = destination ? DESTINATION_WORDS[destination] : null;
  const whoToAsk = words?.whoToAsk ?? "the place it was sent to";

  // --- the line: most pressing first ---
  const order: ParcelStatus[] = ["problem", "picked_up", "delivered", "shipped", "packed", "planned"];
  const present = order.filter((status) => counts[status] > 0);
  const parts = present.map((status, index) => {
    const n = counts[status];
    return index === 0 ? `${count(n, noun.one, noun.many)} ${phrase(status, n)}` : `${n} ${phrase(status, n)}`;
  });
  const last = present[present.length - 1];
  let tail = "";
  if (last === "shipped" && targetDeliveryDate) {
    tail = compareDates(today, targetDeliveryDate) > 0 ? `, due ${formatDate(targetDeliveryDate)}` : `, arrives ${formatDate(targetDeliveryDate)}`;
  } else if ((last === "planned" || last === "packed") && shipByDate) {
    tail = `, ship by ${dayAndDate(shipByDate)}`;
  }
  const line = `${parts.join(", ")}${tail}`;

  // --- the nudge and the button ---
  let nudge: string | null = null;
  let level: ShipmentStatus["level"] = null;
  let action: ShipmentStatus["action"] = null;
  const cutoff = `${DROP_OFF_CUTOFF_HOUR - 12} pm`;
  const it = parcels.length === 1 ? "it" : "them";
  const itIs = parcels.length === 1 ? "it" : "they";

  if (counts.problem > 0) {
    nudge = "Open the tracking page to see what happened, then call the carrier.";
    level = "alert";
    action = { key: "check_tracking", label: "Check tracking" };
  } else if (stage === "planned" || stage === "packed") {
    const packed = stage === "packed";
    const needsAnswer = destination !== null && !isPickupPoint(destination) && input.propertyConfirmed !== true;
    const askWho = destination && isStaffedProperty(destination) ? words?.place ?? "the property" : "your host";
    if (!shipByDate) {
      nudge = "Add where it is going and the day you arrive to see when to ship.";
      level = "info";
      action = { key: "finish_planning", label: "Finish planning" };
    } else if (compareDates(today, shipByDate) > 0) {
      nudge = `The safe day to ship was ${dayAndDate(shipByDate)}. Send ${it} today, or pick a faster service.`;
      level = "alert";
      action = { key: "see_faster_options", label: "See faster options" };
    } else if (today === shipByDate) {
      nudge = packed ? `Ship ${it} today, before about ${cutoff}.` : `Pack and label ${it}, and ship today before about ${cutoff}.`;
      level = "caution";
      action = packed ? { key: "record_tracking", label: "Mark as shipped" } : { key: "mark_packed", label: "Mark as packed" };
    } else if (today === addDays(shipByDate, -1)) {
      nudge = packed ? `Ship ${it} by tomorrow.` : `Pack and label ${it}. Ship by tomorrow.`;
      level = "caution";
      action = packed ? { key: "record_tracking", label: "Mark as shipped" } : { key: "mark_packed", label: "Mark as packed" };
    } else if (needsAnswer && !packed) {
      const question =
        destination === "relative_home" ? "it is all right to send" : destination === "vacation_rental" ? "they will accept" : "it will accept";
      nudge = `Ask ${askWho} whether ${question} a ${noun.one}.`;
      // Five days before the ship-by date this stops being optional (product spec 10.4).
      level = compareDates(today, addDays(shipByDate, -5)) >= 0 ? "caution" : "info";
      action = { key: "message_property", label: destination && isStaffedProperty(destination) ? `Message ${words?.place ?? "the property"}` : "Message your host" };
    } else if (packed) {
      nudge = `Drop ${it} off by ${dayAndDate(shipByDate)}.`;
      level = "info";
      action = { key: "record_tracking", label: "Mark as shipped" };
    } else {
      nudge = `Choose how to send ${it}, then pack and ship by ${dayAndDate(shipByDate)}.`;
      level = "info";
      action = { key: "choose_how_to_send", label: "Choose how to send" };
    }
  } else if (stage === "shipped") {
    const untracked = parcels.some((parcel) => parcel.status === "shipped" && !(parcel.trackingNumber ?? "").trim());
    if (targetDeliveryDate && compareDates(today, targetDeliveryDate) > 0) {
      // The day after the target date, if it is not marked delivered (product spec 6.4).
      nudge = destination && isPickupPoint(destination) ? "Did it arrive? Check the tracking page." : `Did it arrive? Ask ${whoToAsk}.`;
      level = "caution";
      action = { key: "mark_delivered", label: "Mark as arrived" };
    } else if (untracked) {
      nudge = "Add the tracking number so you can follow it.";
      level = "info";
      action = { key: "record_tracking", label: "Add tracking number" };
    } else if (targetDeliveryDate && today === targetDeliveryDate) {
      nudge = "It should arrive today.";
      level = "info";
      action = { key: "mark_delivered", label: "Mark as arrived" };
    } else {
      action = { key: "mark_delivered", label: "Mark as arrived" };
    }
  } else if (stage === "delivered") {
    const here = input.arrivalDate ? compareDates(today, input.arrivalDate) >= 0 : false;
    if (destination && isPickupPoint(destination)) {
      const kept = DESTINATION_POLICIES[destination].keptForDays;
      const bring = destination === "amazon_locker" || destination === "amazon_counter" ? "with your pickup code" : "with photo ID";
      nudge = `${sentenceCase(itIs)} arrived. Collect ${it} within ${kept} days, ${bring}.`;
      level = "caution";
    } else if (here) {
      nudge = destination && isStaffedProperty(destination) ? `${sentenceCase(itIs)} arrived. Pick ${it} up from ${whoToAsk}.` : `${sentenceCase(itIs)} arrived and should be waiting for you.`;
      level = "info";
    } else {
      nudge = `${sentenceCase(itIs)} arrived. Ask ${whoToAsk} to confirm they have ${it}.`;
      level = "info";
    }
    action = { key: "mark_picked_up", label: "Mark as picked up" };
  }

  // --- the track ---
  // With a problem, the track shows how far the other parcels got; a lone problem parcel had shipped.
  const rank = stage === "problem" ? (settled.length > 0 ? Math.min(...settled.map((status) => RANK[status])) : RANK.shipped) : RANK[stage];
  const askFirst = destination === null || !isPickupPoint(destination);
  const confirmLabel =
    destination === "hotel" || destination === "cruise_precruise_hotel" ? "Hotel confirmed"
    : destination === "resort" ? "Resort confirmed"
    : destination === "conference_venue" ? "Venue confirmed"
    : destination === "vacation_rental" || destination === "relative_home" ? "Host confirmed"
    : "Place confirmed";
  const steps: Omit<ShipmentTrackStep, "current">[] = [
    { key: "planned", label: "Planned", done: true },
    ...(askFirst ? [{ key: "property_confirmed" as const, label: confirmLabel, done: input.propertyConfirmed === true || rank >= RANK.shipped }] : []),
    { key: "packed", label: "Packed", done: rank >= RANK.packed },
    { key: "shipped", label: "Shipped", done: rank >= RANK.shipped },
    { key: "delivered", label: "Delivered", done: rank >= RANK.delivered },
    { key: "picked_up", label: "Picked up", done: rank >= RANK.picked_up },
  ];
  const firstOpen = steps.findIndex((step) => !step.done);
  const track = steps.map((step, index) => ({ ...step, current: index === firstOpen }));

  return { stage, line, nudge, level, action, counts, track };
}

/**
 * The parcel with a new status and the moment it was set. `now` comes from the server action
 * (`new Date()` there), never from inside this function.
 */
export function withParcelStatus(parcel: Parcel, status: ParcelStatus, now: Date): Parcel {
  return { ...parcel, status, statusAt: now.toISOString() };
}

/**
 * Records a tracking number she pasted: the number is normalized, the carrier recognised, and a
 * parcel that was only planned or packed becomes "shipped" (pasting a tracking number means it
 * has gone). A parcel already delivered, picked up or marked as a problem keeps its status.
 *
 * Returns the updated parcel and the detection, so the screen can ask her to confirm the carrier
 * when `detection.needsConfirmation` is true. An empty or blank number clears it. A number that
 * looks like a payment card is NOT stored (the parcel comes back unchanged) until she confirms
 * and the call is repeated with `storeCardLikeNumber: true`.
 */
export function withTrackingNumber(
  parcel: Parcel,
  trackingNumber: string,
  now: Date,
  options: DetectCarrierOptions & { storeCardLikeNumber?: boolean } = {},
): { parcel: Parcel; detection: TrackingDetection } {
  const detection = detectCarrier(trackingNumber, options);
  // Sixteen digits that pass the card test are never stored unless she has said it is right.
  if (detection.looksLikeCardNumber && options.storeCardLikeNumber !== true) return { parcel, detection };
  if (!detection.number) {
    const rest: Parcel = { ...parcel };
    delete rest.trackingNumber;
    delete rest.carrierDetected;
    return { parcel: rest, detection };
  }
  const next: Parcel = { ...parcel, trackingNumber: detection.number.slice(0, 60) };
  if (detection.best) next.carrierDetected = detection.best.carrier;
  else delete next.carrierDetected;
  const moves = parcel.status === "planned" || parcel.status === "packed";
  return { parcel: moves ? { ...next, status: "shipped", statusAt: now.toISOString() } : next, detection };
}
