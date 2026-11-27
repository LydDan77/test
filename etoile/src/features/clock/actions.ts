"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { fail, formText, invalid, ok, type ActionResult } from "@/lib/action";
import { requireUser } from "@/lib/auth";
import { placeRefSchema } from "@/lib/domain";
import { isId, newId } from "@/lib/ids";
import { localDateOf } from "@/lib/time";
import { CLOCK_DISMISSED_ON, MAX_MANUAL_CLOCKS, clockName, isClockVisible, isSameClockPlace } from "./rules";

// The world clock's actions. Every one checks who is asking and only ever touches that
// person's own clocks: the user id is part of every WHERE clause.

export type ClockResult = ActionResult<{ clockId: string }>;
export type ClocksResult = ActionResult;

const labelSchema = z.string().max(40, "Use a shorter name");

function readPlace(value: string) {
  if (!value) return null;
  try {
    const parsed = placeRefSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Adds a clock for a place. Fields: `place` (the JSON of a PlaceRef, as /api/places and
 * /api/airports hand it over), `label` (optional: what to call it instead of the place's name).
 */
export async function addClock(_prev: ClockResult | null, formData: FormData): Promise<ClockResult> {
  const user = await requireUser();
  const values = { label: formText(formData, "label") };

  const place = readPlace(formText(formData, "place"));
  if (!place) return fail("Choose a place from the list.", { fieldErrors: { place: ["Choose a place from the list"] }, values });
  const label = labelSchema.safeParse(values.label);
  if (!label.success) return invalid(label.error, values);

  const db = await getDb();
  const clocks = await db.select().from(schema.clocks).where(eq(schema.clocks.userId, user.id));
  const today = localDateOf(new Date(), user.home.tz);
  const showing = clocks.filter((clock) => isClockVisible(clock, today));

  const twin = showing.find((clock) => isSameClockPlace(clock.place, place));
  if (twin) return fail(`You already have a clock for ${clockName(twin)}.`, { values });
  if (clocks.filter((clock) => clock.source === "manual" && !clock.isHome).length >= MAX_MANUAL_CLOCKS) {
    return fail(`That is the most clocks you can add (${MAX_MANUAL_CLOCKS}). Remove one first.`, { values });
  }

  const [clock] = await db
    .insert(schema.clocks)
    .values({
      id: newId(),
      userId: user.id,
      place,
      label: label.data || null,
      source: "manual",
      sortOrder: clocks.reduce((max, existing) => Math.max(max, existing.sortOrder), 0) + 1,
    })
    .returning({ id: schema.clocks.id });

  refresh();
  return ok({ clockId: clock.id });
}

async function ownClock(userId: string, clockId: string) {
  if (!isId(clockId)) return null;
  const db = await getDb();
  const [clock] = await db
    .select()
    .from(schema.clocks)
    .where(and(eq(schema.clocks.id, clockId), eq(schema.clocks.userId, userId)))
    .limit(1);
  return clock ?? null;
}

const GONE = "That clock is no longer there.";

/**
 * Removes a clock. Field: `clockId`. The home clock stays (change the home place in settings).
 * A plan's clock is put away rather than deleted, so it does not come back while the plan lasts.
 */
export async function removeClock(_prev: ClocksResult | null, formData: FormData): Promise<ClocksResult> {
  const user = await requireUser();
  const clock = await ownClock(user.id, formText(formData, "clockId"));
  if (!clock) return fail(GONE);
  if (clock.isHome) return fail("Your home clock stays. To change it, change your home place in settings.");

  const db = await getDb();
  const mine = and(eq(schema.clocks.id, clock.id), eq(schema.clocks.userId, user.id));
  if (clock.source === "plan") {
    await db.update(schema.clocks).set({ pinned: false, expiresOn: CLOCK_DISMISSED_ON }).where(mine);
  } else {
    await db.delete(schema.clocks).where(mine);
  }
  refresh();
  return ok();
}

/** Renames a clock. Fields: `clockId`, `label` (empty goes back to the place's own name). */
export async function relabelClock(_prev: ClockResult | null, formData: FormData): Promise<ClockResult> {
  const user = await requireUser();
  const values = { label: formText(formData, "label") };
  const label = labelSchema.safeParse(values.label);
  if (!label.success) return invalid(label.error, values);

  const clock = await ownClock(user.id, formText(formData, "clockId"));
  if (!clock) return fail(GONE, { values });

  const db = await getDb();
  await db
    .update(schema.clocks)
    .set({ label: label.data || null })
    .where(and(eq(schema.clocks.id, clock.id), eq(schema.clocks.userId, user.id)));
  refresh();
  return ok({ clockId: clock.id });
}

/**
 * Puts the clocks in a new order. Field: `order`, the clock ids separated by commas, first to
 * last. The home clock always leads, wherever it is in the list; clocks left out keep their
 * place after the ones named.
 */
export async function reorderClocks(_prev: ClocksResult | null, formData: FormData): Promise<ClocksResult> {
  const user = await requireUser();
  const wanted = formText(formData, "order")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (wanted.length === 0 || wanted.length > 200 || !wanted.every(isId) || new Set(wanted).size !== wanted.length) {
    return fail("That order could not be read. Try again.");
  }

  const db = await getDb();
  const clocks = await db
    .select({ id: schema.clocks.id, isHome: schema.clocks.isHome, sortOrder: schema.clocks.sortOrder })
    .from(schema.clocks)
    .where(eq(schema.clocks.userId, user.id))
    .orderBy(schema.clocks.sortOrder, schema.clocks.createdAt, schema.clocks.id);
  const mine = new Set(clocks.map((clock) => clock.id));
  // An id that is not one of this person's clocks: refuse the lot rather than guess.
  if (!wanted.every((id) => mine.has(id))) return fail("One of those clocks is no longer there. Reload and try again.");

  const home = clocks.filter((clock) => clock.isHome).map((clock) => clock.id);
  const named = wanted.filter((id) => !home.includes(id));
  const rest = clocks.map((clock) => clock.id).filter((id) => !home.includes(id) && !named.includes(id));
  const order = [...home, ...named, ...rest];

  await db.transaction(async (tx) => {
    for (const [index, id] of order.entries()) {
      if (clocks.find((clock) => clock.id === id)?.sortOrder === index) continue;
      await tx
        .update(schema.clocks)
        .set({ sortOrder: index })
        .where(and(eq(schema.clocks.id, id), eq(schema.clocks.userId, user.id)));
    }
  });
  refresh();
  return ok();
}

/**
 * Pins or unpins a plan's clock. Fields: `clockId`, `pinned` ("1" to keep it after the plan is
 * over, anything else to let it go a week after). Only a plan's clock can be pinned: the others
 * never leave by themselves.
 */
export async function setClockPinned(_prev: ClockResult | null, formData: FormData): Promise<ClockResult> {
  const user = await requireUser();
  const clock = await ownClock(user.id, formText(formData, "clockId"));
  if (!clock) return fail(GONE);
  if (clock.source !== "plan") return fail("This clock stays until you remove it. There is nothing to pin.");

  const pinned = ["1", "true", "on"].includes(formText(formData, "pinned"));
  const db = await getDb();
  await db
    .update(schema.clocks)
    .set({ pinned })
    .where(and(eq(schema.clocks.id, clock.id), eq(schema.clocks.userId, user.id)));
  refresh();
  return ok({ clockId: clock.id });
}
