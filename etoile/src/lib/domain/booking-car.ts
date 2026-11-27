// Details of a rental car booking (product spec 7.9). People see "Car".

import { z } from "zod";
import { idSchema, shortText } from "./common";
import { placeRefSchema } from "./place";
import { zonedInstantSchema } from "./zoned-instant";

export const VEHICLE_CLASSES = [
  "economy", "compact", "midsize", "standard", "full_size", "suv", "minivan", "van", "pickup", "luxury", "other",
] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const carDetailsSchema = z
  .object({
    kind: z.literal("car"),
    company: shortText(120).optional(),
    vehicleClass: z.enum(VEHICLE_CLASSES).optional(),
    seats: z.number().int().min(1).max(15).optional(),
    pickupPlace: placeRefSchema.optional(),
    /** Pick-up time, in the pick-up place's zone. */
    pickupAt: zonedInstantSchema.optional(),
    returnPlace: placeRefSchema.optional(),
    /** Return time, in the return place's zone. */
    returnAt: zonedInstantSchema.optional(),
    driverPersonIds: z.array(idSchema).max(10).default([]),
    childSeats: z.number().int().min(0).max(6).optional(),
  })
  .refine((d) => !d.pickupAt || !d.returnAt || Date.parse(d.returnAt.at) > Date.parse(d.pickupAt.at), {
    message: "The car is returned after it is picked up",
    path: ["returnAt"],
  });
export type CarDetails = z.infer<typeof carDetailsSchema>;
