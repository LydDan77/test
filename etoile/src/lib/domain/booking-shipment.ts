// Details of a shipment booking: luggage, boxes or gifts sent ahead (product spec 7.9 and
// research/ship-ahead.md section 7). People see "Send ahead".
//
// The dates (targetDeliveryDate, shipByDate, latestRiskyDate) and warnings are the outputs of the
// ship-by arithmetic in src/lib/shipping; they are stored so the page does not recompute on
// every read, and recomputed whenever an input changes.
// Parcel status is set by hand: carrier tracking APIs all need keys, so tracking is a link.

import { z } from "zod";
import { idSchema, instantSchema, localDateSchema, longText, shortText } from "./common";
import { moneySchema } from "./money";

export const SHIPMENT_KINDS = ["luggage", "box", "gift", "gear", "mail", "retail_order"] as const;
export type ShipmentKind = (typeof SHIPMENT_KINDS)[number];

export const SHIPMENT_DIRECTIONS = ["outbound", "return"] as const;
export type ShipmentDirection = (typeof SHIPMENT_DIRECTIONS)[number];

export const SHIPMENT_DESTINATION_TYPES = [
  "hotel", "resort", "conference_venue", "relative_home", "vacation_rental", "cruise_precruise_hotel",
  "ups_access_point", "fedex_hold_at_location", "usps_general_delivery", "amazon_locker", "amazon_counter",
] as const;
export type ShipmentDestinationType = (typeof SHIPMENT_DESTINATION_TYPES)[number];

/** Carriers and luggage services. Goes in bookings.provider for a shipment. */
export const SHIPMENT_PROVIDERS = [
  "ups", "fedex", "usps", "dhl", "amazon", "ontrac", "canadapost", "royalmail",
  "lugless", "luggage_forward", "shipgo", "luggage_free", "send_my_bag", "other",
] as const;
export type ShipmentProvider = (typeof SHIPMENT_PROVIDERS)[number];

export const CONTENT_FLAGS = ["lithium", "medication", "alcohol", "aerosol", "perishable", "valuable"] as const;
export type ContentFlag = (typeof CONTENT_FLAGS)[number];

export const PARCEL_STATUSES = ["planned", "packed", "shipped", "delivered", "picked_up", "problem"] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

export const shipmentContentSchema = z.object({
  description: shortText(200),
  quantity: z.number().int().min(1).max(999).default(1),
  /** Declared value of one item. */
  value: moneySchema.optional(),
  /** Used goods matter for customs. */
  used: z.boolean().optional(),
  flags: z.array(z.enum(CONTENT_FLAGS)).max(CONTENT_FLAGS.length).default([]),
});
export type ShipmentContent = z.infer<typeof shipmentContentSchema>;

export const parcelSchema = z.object({
  weight: z.object({ value: z.number().positive().max(2000), unit: z.enum(["lb", "kg"]) }).optional(),
  dimensions: z
    .object({
      length: z.number().positive().max(500),
      width: z.number().positive().max(500),
      height: z.number().positive().max(500),
      unit: z.enum(["in", "cm"]),
    })
    .optional(),
  trackingNumber: shortText(60).optional(),
  /** The carrier recognised from the tracking number's format. */
  carrierDetected: shortText(40).optional(),
  status: z.enum(PARCEL_STATUSES).default("planned"),
  statusAt: instantSchema.optional(),
});
export type Parcel = z.infer<typeof parcelSchema>;

/** What the property said when asked. Mirrors a lodging booking's packagePolicy. */
export const propertyAnswersSchema = z.object({
  confirmed: z.boolean().default(false),
  holdDays: z.number().int().min(0).max(365).optional(),
  feePerBox: moneySchema.optional(),
  receivingAddress: longText(500).optional(),
  contact: shortText(200).optional(),
  notes: longText(1000).optional(),
});
export type PropertyAnswers = z.infer<typeof propertyAnswersSchema>;

export const shipmentDetailsSchema = z.object({
  kind: z.literal("shipment"),
  shipmentKind: z.enum(SHIPMENT_KINDS).optional(),
  direction: z.enum(SHIPMENT_DIRECTIONS).default("outbound"),
  destinationType: z.enum(SHIPMENT_DESTINATION_TYPES).optional(),
  /** The stay this is being sent to (bookings.id of a lodging booking). */
  lodgingBookingId: idSchema.optional(),
  recipientName: shortText(120).optional(),
  propertyName: shortText(200).optional(),
  reservationNumber: shortText(80).optional(),
  /** The address block exactly as it goes on the label, one line per entry. */
  labelLines: z.array(shortText(200)).max(10).default([]),
  /** The "HOLD FOR GUEST …" line generated for the destination type. */
  holdNote: shortText(300).optional(),
  /** The day the traveler reaches the destination. */
  arrivalDate: localDateSchema.optional(),
  /** Key into the transit-time table of src/lib/shipping (for example "ups_ground"). */
  serviceKey: shortText(60).optional(),
  originPostal: shortText(20).optional(),
  destinationPostal: shortText(20).optional(),
  /** Carrier zone 2-8, when known. */
  zone: z.number().int().min(1).max(9).optional(),
  international: z.boolean().default(false),
  /** Outputs of the ship-by arithmetic. */
  targetDeliveryDate: localDateSchema.optional(),
  shipByDate: localDateSchema.optional(),
  latestRiskyDate: localDateSchema.optional(),
  warnings: z.array(shortText(300)).max(30).default([]),
  propertyAnswers: propertyAnswersSchema.optional(),
  contents: z.array(shipmentContentSchema).max(100).default([]),
  /** One entry per box or bag. */
  parcels: z.array(parcelSchema).max(30).default([]),
})
  .refine((d) => !d.shipByDate || !d.targetDeliveryDate || d.shipByDate <= d.targetDeliveryDate, {
    message: "The ship-by date is on or before the day it should arrive",
    path: ["shipByDate"],
  });
export type ShipmentDetails = z.infer<typeof shipmentDetailsSchema>;
