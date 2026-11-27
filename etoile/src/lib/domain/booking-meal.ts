// Details of a meal booking (product spec 7.9): restaurant delivery, groceries or catering.
// People see "Food". PRIVATE, never on a share page: total, tip, orderNumber.

import { z } from "zod";
import { localDateSchema, longText, shortText } from "./common";
import { moneySchema } from "./money";
import { placeRefSchema } from "./place";
import { zonedInstantSchema } from "./zoned-instant";

export const MEAL_TYPES = ["restaurant_delivery", "groceries", "catering"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const mealListItemSchema = z.object({
  name: shortText(200),
  quantity: z.number().min(0).max(10_000).optional(),
  note: shortText(200).optional(),
});
export type MealListItem = z.infer<typeof mealListItemSchema>;

export const mealDetailsSchema = z
  .object({
    kind: z.literal("meal"),
    mealType: z.enum(MEAL_TYPES).optional(),
    vendorName: shortText(200).optional(),
    deliverToPlace: placeRefSchema.optional(),
    /** Delivery window, in the delivery place's zone. */
    windowStart: zonedInstantSchema.optional(),
    windowEnd: zonedInstantSchema.optional(),
    headcount: z.number().int().min(0).max(5000).optional(),
    /** Snapshot of the dietary roll-up from people ("2 vegetarian, 1 nut allergy"). */
    dietarySummary: shortText(500).optional(),
    /** The grocery list or the order. */
    list: z.array(mealListItemSchema).max(300).default([]),
    deliveryNote: longText(1000).optional(),
    /** The first day the provider takes orders for the window. */
    orderOpensOn: localDateSchema.optional(),
    orderNumber: shortText(80).optional(),
    total: moneySchema.optional(),
    tip: moneySchema.optional(),
  })
  .refine(
    (d) => !d.windowStart || !d.windowEnd || Date.parse(d.windowEnd.at) >= Date.parse(d.windowStart.at),
    { message: "The delivery window ends after it starts", path: ["windowEnd"] },
  );
export type MealDetails = z.infer<typeof mealDetailsSchema>;
