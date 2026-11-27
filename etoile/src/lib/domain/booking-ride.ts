// Details of a ride booking (product spec 7.9): rideshare, taxi, shuttle, or a family member
// doing the airport run. People see "Rides".

import { z } from "zod";
import { idSchema, localDateSchema } from "./common";
import { placeRefSchema } from "./place";
import { zonedInstantSchema } from "./zoned-instant";

export const RIDE_TYPES = ["rideshare", "taxi", "shuttle", "personal_pickup"] as const;
export type RideType = (typeof RIDE_TYPES)[number];

export const rideDetailsSchema = z.object({
  kind: z.literal("ride"),
  rideType: z.enum(RIDE_TYPES).optional(),
  fromPlace: placeRefSchema.optional(),
  toPlace: placeRefSchema.optional(),
  /** Pick-up time, in the pick-up place's zone. */
  pickupAt: zonedInstantSchema.optional(),
  passengerIds: z.array(idSchema).max(30).default([]),
  bags: z.number().int().min(0).max(60).optional(),
  childSeatNeeded: z.boolean().optional(),
  /** For a personal pickup: who is driving. */
  driverPersonId: idSchema.optional(),
  vehicleSeats: z.number().int().min(1).max(60).optional(),
  /** The arrivals this ride meets (arrivals.id). */
  arrivalIds: z.array(idSchema).max(20).default([]),
  /** Reminder date to reserve, for providers that only book close in. */
  reserveOn: localDateSchema.optional(),
});
export type RideDetails = z.infer<typeof rideDetailsSchema>;
