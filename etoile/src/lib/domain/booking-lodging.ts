// Details of a lodging booking (product spec 7.9). People see "Stay".
// PRIVATE, never on a share page: accessNotes (door code, Wi-Fi), contactPhone.

import { z } from "zod";
import { httpUrlSchema, idSchema, localDateSchema, localTimeSchema, longText, shortText } from "./common";
import { moneySchema } from "./money";
import { placeRefSchema } from "./place";

export const LODGING_TYPES = ["hotel", "rental", "family_home", "room_block", "other"] as const;
export type LodgingType = (typeof LODGING_TYPES)[number];

export const lodgingRoomSchema = z.object({
  label: shortText(80),
  personIds: z.array(idSchema).max(30).default([]),
});
export type LodgingRoom = z.infer<typeof lodgingRoomSchema>;

/** What the property said about receiving packages before arrival (feeds Send ahead). */
export const packagePolicySchema = z.object({
  accepts: z.boolean().optional(),
  holdDays: z.number().int().min(0).max(365).optional(),
  feePerBox: moneySchema.optional(),
  receivingAddress: longText(500).optional(),
  contact: shortText(200).optional(),
});
export type PackagePolicy = z.infer<typeof packagePolicySchema>;

/** A block of rooms guests book themselves. Shown on the share page. */
export const roomBlockSchema = z.object({
  code: shortText(60).optional(),
  /** Nightly rate. */
  rate: moneySchema.optional(),
  bookBy: localDateSchema.optional(),
  bookingUrl: httpUrlSchema.optional(),
});
export type RoomBlock = z.infer<typeof roomBlockSchema>;

export const DEFAULT_CHECK_IN_TIME = "16:00";
export const DEFAULT_CHECK_OUT_TIME = "11:00";

export const lodgingDetailsSchema = z
  .object({
    kind: z.literal("lodging"),
    lodgingType: z.enum(LODGING_TYPES).optional(),
    propertyName: shortText(200).optional(),
    /** Where it is. Its address feeds rides, meals and shipments. */
    place: placeRefSchema.optional(),
    /** Local dates and times at the property. */
    checkInDate: localDateSchema.optional(),
    checkInTime: localTimeSchema.default(DEFAULT_CHECK_IN_TIME),
    checkOutDate: localDateSchema.optional(),
    checkOutTime: localTimeSchema.default(DEFAULT_CHECK_OUT_TIME),
    rooms: z.array(lodgingRoomSchema).max(60).default([]),
    contactName: shortText(120).optional(),
    contactPhone: shortText(40).optional(),
    /** Private: door code, Wi-Fi, where the key is. */
    accessNotes: longText(2000).optional(),
    packagePolicy: packagePolicySchema.optional(),
    roomBlock: roomBlockSchema.optional(),
  })
  .refine((d) => !d.checkInDate || !d.checkOutDate || d.checkOutDate >= d.checkInDate, {
    message: "Check-out cannot be before check-in",
    path: ["checkOutDate"],
  });
export type LodgingDetails = z.infer<typeof lodgingDetailsSchema>;
