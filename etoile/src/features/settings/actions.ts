"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { syncPlanClocks } from "@/features/clock/sync";
import { fail, formText, invalid, ok, type ActionFailure, type ActionResult } from "@/lib/action";
import { requireUser } from "@/lib/auth";
import { verifyPassword } from "@/lib/auth/password";
import { destroySession } from "@/lib/auth/session";
import { BRAND } from "@/lib/brand";
import { MILITARY_STYLES, THEMES, TIME_STYLES, UNIT_SYSTEMS, airportCodeSchema, placeRefSchema, type PlaceRef } from "@/lib/domain";
import { airportByIata, nearestAirports } from "@/lib/places/airports";
import { describeWait, rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { localDateOf } from "@/lib/time";
import { exportUserData } from "./queries";

// Settings save as they are made: each control sends only its own field, and only the fields
// that are sent change. Every action reads the user from the session; none takes a user id.

export type SettingsResult = ActionResult;
export type HomeResult = ActionResult<{ homeAirportIata: string | null }>;
export type ExportResult = ActionResult<{ filename: string; json: string }>;
export type DeleteAccountState = ActionFailure | null;

const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));
const TRUE_VALUES = ["1", "true", "on", "yes"];

const settingsSchema = z.object({
  name: z.string().min(1, "Enter your name").max(80, "Use a shorter name").optional(),
  timeStyle: z.enum(TIME_STYLES).optional(),
  militaryStyle: z.enum(MILITARY_STYLES).optional(),
  units: z.enum(UNIT_SYSTEMS).optional(),
  theme: z.enum(THEMES).optional(),
  currency: z
    .string()
    .transform((value) => value.toUpperCase())
    .refine((value) => CURRENCIES.has(value), { message: "Choose a currency from the list" })
    .optional(),
  homeAirport: z.union([z.literal(""), airportCodeSchema]).optional(),
});

/**
 * Changes account and display settings. Any of these fields, each optional:
 *   name
 *   timeStyle       "12h_with_24h" | "12h" | "24h"
 *   militaryStyle   "1441" | "14:41"
 *   show24hEverywhere, clockShowsWeather     "1" for on, "0" for off
 *   units           "imperial" | "metric"
 *   theme           "system" | "light" | "dark"   (the page also keeps it in localStorage)
 *   currency        an ISO code such as "USD"
 *   homeAirport     an airport code such as "MSP"; empty for none
 */
export async function updateSettings(_prev: SettingsResult | null, formData: FormData): Promise<SettingsResult> {
  const user = await requireUser();

  const values: Record<string, string> = {};
  for (const name of ["name", "timeStyle", "militaryStyle", "show24hEverywhere", "clockShowsWeather", "units", "theme", "currency", "homeAirport"]) {
    if (formData.has(name)) values[name] = formText(formData, name);
  }
  const parsed = settingsSchema.safeParse({
    ...values,
    ...(values.homeAirport !== undefined ? { homeAirport: values.homeAirport.toUpperCase() } : {}),
  });
  if (!parsed.success) return invalid(parsed.error, values);
  const { homeAirport, ...plain } = parsed.data;

  const changes: Partial<typeof schema.users.$inferInsert> = { ...plain };
  if (values.show24hEverywhere !== undefined) changes.show24hEverywhere = TRUE_VALUES.includes(values.show24hEverywhere.toLowerCase());
  if (values.clockShowsWeather !== undefined) changes.clockShowsWeather = TRUE_VALUES.includes(values.clockShowsWeather.toLowerCase());
  if (homeAirport !== undefined) {
    if (homeAirport !== "" && !airportByIata(homeAirport)) {
      return fail("We do not know that airport code. Pick the airport from the list.", { fieldErrors: { homeAirport: ["We do not know that airport code"] }, values });
    }
    changes.homeAirportIata = homeAirport || null;
  }
  if (Object.keys(changes).length === 0) return ok();

  const db = await getDb();
  await db.update(schema.users).set(changes).where(eq(schema.users.id, user.id));
  refresh();
  return ok();
}

/** The airport most people near a place fly from: the closest big one, else the closest at all. */
function suggestedAirport(place: PlaceRef): string | null {
  if (place.iata && airportByIata(place.iata)) return place.iata;
  if (place.lat === undefined || place.lon === undefined) return null;
  const near = nearestAirports(place.lat, place.lon, 8, { withinKm: 250 });
  // rank 7 is a large airport with scheduled service, 5 a medium one.
  const main = near.find((airport) => airport.rank >= 7 && airport.distanceKm <= 120) ?? near.find((airport) => airport.rank >= 5);
  return (main ?? near[0])?.iata ?? null;
}

/**
 * Changes the home place. Fields: `place` (the JSON of the place chosen from /api/places),
 * and optionally `homeAirport` (a code; left out, the airport is suggested from the place).
 *
 * The home clock moves with it, since there is exactly one and it is home. Returns the home
 * airport now on record, so the form can show the suggestion.
 */
export async function updateHome(_prev: HomeResult | null, formData: FormData): Promise<HomeResult> {
  const user = await requireUser();

  let chosen: PlaceRef | null = null;
  try {
    const parsed = placeRefSchema.safeParse(JSON.parse(formText(formData, "place") || "null"));
    if (parsed.success) chosen = parsed.data;
  } catch {
    chosen = null;
  }
  if (!chosen) return fail("Choose your home city from the list.", { fieldErrors: { place: ["Choose your home city from the list"] } });

  const home: PlaceRef = { ...chosen, kind: "home" };
  let homeAirportIata: string | null;
  if (formData.has("homeAirport")) {
    const code = formText(formData, "homeAirport").toUpperCase();
    if (code && !airportByIata(code)) {
      return fail("We do not know that airport code. Pick the airport from the list.", { fieldErrors: { homeAirport: ["We do not know that airport code"] } });
    }
    homeAirportIata = code || null;
  } else {
    homeAirportIata = suggestedAirport(chosen);
  }

  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ home, homeAirportIata }).where(eq(schema.users.id, user.id));
    const moved = await tx
      .update(schema.clocks)
      // A label was written for the old home; it does not carry over.
      .set({ place: home, label: null })
      .where(and(eq(schema.clocks.userId, user.id), eq(schema.clocks.isHome, true)))
      .returning({ id: schema.clocks.id });
    // Every account has a home clock from sign-up; this only repairs one that lost it.
    if (moved.length === 0) await tx.insert(schema.clocks).values({ userId: user.id, place: home, isHome: true, sortOrder: 0 });
  });
  // "Today" for clock expiry is today at home, and a plan at the new home needs no second clock.
  await syncPlanClocks({ id: user.id, home });

  refresh();
  return ok({ homeAirportIata });
}

/**
 * All of the person's data as one JSON document, for "export everything as a file". The form
 * that calls it turns `json` into a download named `filename`.
 */
export async function exportMyData(_prev?: ExportResult | null, _formData?: FormData): Promise<ExportResult> {
  void _prev;
  void _formData;
  const user = await requireUser();
  const limit = await rateLimit(rateLimitKey("export", user.id), { limit: 10, windowMs: 10 * 60_000 });
  if (!limit.ok) return fail(`Too many tries. Wait ${describeWait(limit.retryAfterMs)} and try again.`);

  const now = new Date();
  const data = await exportUserData(user.id, now);
  if (!data) return fail("We could not find your account. Sign in again and try once more.");
  return ok({
    filename: `${BRAND.ascii}-export-${localDateOf(now, user.home.tz)}.json`,
    json: JSON.stringify(data, null, 2),
  });
}

/**
 * Deletes the account and everything in it: plans, people, replies, bookings, share pages,
 * clocks. Field: `password` (the person's current password; nothing is deleted without it).
 * On success the session ends and the person lands on the front page. There is no undo.
 */
export async function deleteAccount(_prev: DeleteAccountState, formData: FormData): Promise<DeleteAccountState> {
  const user = await requireUser();
  const raw = formData.get("password");
  const password = typeof raw === "string" ? raw : "";
  if (!password) return fail("Enter your password to delete your account.", { fieldErrors: { password: ["Enter your password"] } });
  if (password.length > 256) return fail("That password is not right.", { fieldErrors: { password: ["That password is not right"] } });

  // Each try costs a password hash, and this is the one action that cannot be undone.
  const limit = await rateLimit(rateLimitKey("delete-account", user.id), { limit: 5, windowMs: 15 * 60_000 });
  if (!limit.ok) return fail(`Too many tries. Wait ${describeWait(limit.retryAfterMs)} and try again.`);

  const db = await getDb();
  const [account] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  if (!account) redirect("/");
  const check = await verifyPassword(password, account.passwordHash);
  if (!check.ok) return fail("That password is not right.", { fieldErrors: { password: ["That password is not right"] } });

  // Plans, sessions, clocks and heads-up states all hang off the user row (ON DELETE CASCADE),
  // and everything in a plan, its share page included, hangs off the plan.
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
  await destroySession();
  redirect("/"); // throws; must stay outside try/catch
}
