// JSON shapes on a plan: its extra stops (plans.stops).

import { z } from "zod";
import { localDateSchema } from "./common";
import { placeRefSchema } from "./place";

/** One extra stop of a multi-stop trip. Dates are local to the stop. */
export const planStopSchema = z
  .object({
    place: placeRefSchema,
    arriveOn: localDateSchema,
    leaveOn: localDateSchema,
  })
  .refine((stop) => stop.leaveOn >= stop.arriveOn, {
    message: "You cannot leave a stop before you arrive",
    path: ["leaveOn"],
  });
export type PlanStop = z.infer<typeof planStopSchema>;

/** plans.stops, in travel order: each stop starts on or after the day the one before it ends. */
export const planStopsSchema = z
  .array(planStopSchema)
  .max(20)
  .refine((stops) => stops.every((stop, i) => i === 0 || stop.arriveOn >= stops[i - 1].leaveOn), {
    message: "Stops must be in travel order",
  });
export type PlanStops = z.infer<typeof planStopsSchema>;
