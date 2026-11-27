// The expense split (expenses.split): who shares a cost and how. Product spec 7.11.
// The arithmetic (balances, settle-up) lives in src/lib/money; this file is the shape only.

import { z } from "zod";
import { idSchema } from "./common";
import { SPLIT_METHODS } from "./enums";

export const splitPartSchema = z.object({
  personId: idSchema,
  /** For method "shares": this person's number of shares (2 means twice a 1). */
  share: z.number().positive().max(1000).optional(),
  /** For method "exact": this person's part in minor units. */
  amount: z.number().int().min(0).max(2_000_000_000).optional(),
});
export type SplitPart = z.infer<typeof splitPartSchema>;

/**
 * How an expense is shared.
 *  - "none":     not shared (a work expense, or one person's own cost). `parts` is empty.
 *  - "equal":    equally among the people in `parts`.
 *  - "by_party": equally among the parties of the people in `parts` (each household pays one share).
 *  - "shares":   in proportion to each part's `share`.
 *  - "exact":    each part's `amount`; the amounts must add up to the expense (checked with
 *                splitMatchesAmount, because the split does not know the total).
 */
export const expenseSplitSchema = z
  .object({
    method: z.enum(SPLIT_METHODS),
    parts: z.array(splitPartSchema).max(200).default([]),
  })
  .superRefine((split, ctx) => {
    const ids = split.parts.map((p) => p.personId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "Someone is in the split twice", path: ["parts"] });
    }
    if (split.method === "none") {
      if (split.parts.length > 0) {
        ctx.addIssue({ code: "custom", message: "An expense that is not shared has no parts", path: ["parts"] });
      }
      return;
    }
    if (split.parts.length === 0) {
      ctx.addIssue({ code: "custom", message: "Choose who shares this", path: ["parts"] });
    }
    split.parts.forEach((part, index) => {
      if (split.method === "shares" && part.share === undefined) {
        ctx.addIssue({ code: "custom", message: "Give each person a share", path: ["parts", index, "share"] });
      }
      if (split.method === "exact" && part.amount === undefined) {
        ctx.addIssue({ code: "custom", message: "Give each person an amount", path: ["parts", index, "amount"] });
      }
    });
  });
export type ExpenseSplit = z.infer<typeof expenseSplitSchema>;

/** The split of an expense nobody shares. The column default. */
export const NO_SPLIT: ExpenseSplit = { method: "none", parts: [] };

/** For an "exact" split: do the parts add up to the expense? Always true for other methods. */
export function splitMatchesAmount(split: ExpenseSplit, amount: number): boolean {
  if (split.method !== "exact") return true;
  return split.parts.reduce((sum, part) => sum + (part.amount ?? 0), 0) === amount;
}
