import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stand-ins for the request: who is signed in, a cookie jar, and Next's request-only functions.
const session: { user: Record<string, unknown> | null } = { user: null };
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: async () => {
    if (!session.user) throw new Error("REDIRECT /sign-in");
    return session.user;
  },
}));
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => ({ get: () => null }),
}));
const refresh = vi.fn();
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/cache")>()), refresh: () => refresh() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { seedExamplePlan } from "@/features/plans/seed";
import { hashPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session";
import type { PlaceRef } from "@/lib/domain";
import { newToken } from "@/lib/ids";
import { deleteAccount, exportMyData, updateHome, updateSettings } from "./actions";
import { exportUserData } from "./queries";

const chicago: PlaceRef = { kind: "home", name: "Chicago", tz: "America/Chicago" };
const minneapolis: PlaceRef = { kind: "city", name: "Minneapolis", region: "Minnesota", countryCode: "US", lat: 44.97997, lon: -93.26384, tz: "America/Chicago" };
const orlando: PlaceRef = { kind: "city", name: "Orlando", region: "Florida", countryCode: "US", lat: 28.53834, lon: -81.37924, tz: "America/New_York" };
const PASSWORD = "correct horse battery staple";

type TestUser = Omit<typeof schema.users.$inferSelect, "passwordHash">;
let t: TestDb;
let passwordHash: string;
let lydia: TestUser;
let mallory: TestUser;
let counter = 0;

async function addUser(name: string): Promise<TestUser> {
  counter += 1;
  const [row] = await t.db.insert(schema.users).values({ email: `user${counter}@example.com`, name, passwordHash, home: chicago }).returning();
  await t.db.insert(schema.clocks).values({ userId: row.id, place: chicago, isHome: true, label: "Home sweet home" });
  const { passwordHash: _hash, ...user } = row;
  void _hash;
  return user;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const account = async (user: TestUser) => (await t.db.select().from(schema.users).where(eq(schema.users.id, user.id)))[0];
const clocksOf = (user: TestUser) => t.db.select().from(schema.clocks).where(eq(schema.clocks.userId, user.id));

beforeAll(async () => {
  t = await createTestDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => t.close());
beforeEach(async () => {
  lydia = await addUser("Lydia Hartley");
  mallory = await addUser("Mallory Quill");
  session.user = lydia;
  jar.clear();
  refresh.mockClear();
});

describe("updateSettings", () => {
  it("changes only the settings that are sent", async () => {
    const before = await account(lydia);
    expect(before).toMatchObject({ timeStyle: "12h_with_24h", militaryStyle: "1441", show24hEverywhere: false, units: "imperial", theme: "system", currency: "USD", clockShowsWeather: true });

    expect(await updateSettings(null, form({ timeStyle: "24h" }))).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    const after = await account(lydia);
    expect(after.timeStyle).toBe("24h");
    const { timeStyle: _a, updatedAt: _b, ...restBefore } = before;
    const { timeStyle: _c, updatedAt: _d, ...restAfter } = after;
    void _a; void _b; void _c; void _d;
    expect(restAfter).toEqual(restBefore);
  });

  it("changes the name, time style, military style, units, theme and currency", async () => {
    expect(
      await updateSettings(null, form({ name: "  Lydia H. ", timeStyle: "12h", militaryStyle: "14:41", show24hEverywhere: "1", units: "metric", theme: "dark", currency: "eur", clockShowsWeather: "0" })),
    ).toEqual({ ok: true });
    expect(await account(lydia)).toMatchObject({
      name: "Lydia H.",
      timeStyle: "12h",
      militaryStyle: "14:41",
      show24hEverywhere: true,
      units: "metric",
      theme: "dark",
      currency: "EUR",
      clockShowsWeather: false,
    });
    expect(await updateSettings(null, form({ show24hEverywhere: "off", clockShowsWeather: "on", theme: "system" }))).toEqual({ ok: true });
    expect(await account(lydia)).toMatchObject({ show24hEverywhere: false, clockShowsWeather: true, theme: "system" });
  });

  it("takes a home airport it knows, by code, and clears it when sent empty", async () => {
    expect(await updateSettings(null, form({ homeAirport: "msp" }))).toEqual({ ok: true });
    expect((await account(lydia)).homeAirportIata).toBe("MSP");
    expect(await updateSettings(null, form({ homeAirport: "XQX" }))).toMatchObject({ ok: false, error: "We do not know that airport code. Pick the airport from the list." });
    expect(await updateSettings(null, form({ homeAirport: "Minneapolis" }))).toMatchObject({ ok: false });
    expect((await account(lydia)).homeAirportIata).toBe("MSP");
    expect(await updateSettings(null, form({ homeAirport: "" }))).toEqual({ ok: true });
    expect((await account(lydia)).homeAirportIata).toBeNull();
  });

  it("refuses values that are not on the list, and says which field", async () => {
    const before = await account(lydia);
    const cases: [Record<string, string>, string][] = [
      [{ name: "" }, "name"],
      [{ name: "x".repeat(81) }, "name"],
      [{ timeStyle: "13h" }, "timeStyle"],
      [{ militaryStyle: "2pm" }, "militaryStyle"],
      [{ units: "furlongs" }, "units"],
      [{ theme: "sepia" }, "theme"],
      [{ currency: "XXQ" }, "currency"],
      [{ currency: "dollars" }, "currency"],
    ];
    for (const [fields, field] of cases) {
      const result = await updateSettings(null, form({ ...fields, theme: fields.theme ?? "dark" }));
      expect(result.ok, JSON.stringify(fields)).toBe(false);
      if (!result.ok) {
        expect(result.fieldErrors?.[field], field).toBeTruthy();
        expect(result.values?.[field]).toBe(fields[field]);
      }
    }
    // One bad field stops the whole save: the theme sent alongside did not change either.
    expect(await account(lydia)).toEqual(before);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does nothing, without complaint, when nothing is sent", async () => {
    expect(await updateSettings(null, new FormData())).toEqual({ ok: true });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("changes nobody else's settings, and needs someone signed in", async () => {
    await updateSettings(null, form({ name: "Changed", theme: "dark" }));
    expect(await account(mallory)).toMatchObject({ name: "Mallory Quill", theme: "system" });
    session.user = null;
    await expect(updateSettings(null, form({ name: "Nobody" }))).rejects.toThrow("REDIRECT /sign-in");
  });
});

describe("updateHome", () => {
  it("moves home, the home clock with it, and suggests the airport people there fly from", async () => {
    const result = await updateHome(null, form({ place: JSON.stringify(minneapolis) }));
    expect(result).toEqual({ ok: true, homeAirportIata: "MSP" });
    const after = await account(lydia);
    // Whatever kind of place was chosen, on the account it is home.
    expect(after.home).toEqual({ ...minneapolis, kind: "home" });
    expect(after.homeAirportIata).toBe("MSP");

    const clocks = await clocksOf(lydia);
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ isHome: true, label: null });
    expect(clocks[0].place).toEqual({ ...minneapolis, kind: "home" });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Mallory's home and clock are where they were.
    expect((await account(mallory)).home).toEqual(chicago);
    expect((await clocksOf(mallory))[0]).toMatchObject({ label: "Home sweet home" });
  });

  it("takes the airport the person chose over the suggestion, or none", async () => {
    expect(await updateHome(null, form({ place: JSON.stringify(orlando), homeAirport: "sfb" }))).toEqual({ ok: true, homeAirportIata: "SFB" });
    expect(await updateHome(null, form({ place: JSON.stringify(orlando), homeAirport: "" }))).toEqual({ ok: true, homeAirportIata: null });
    expect(await updateHome(null, form({ place: JSON.stringify(orlando) }))).toEqual({ ok: true, homeAirportIata: "MCO" });
    expect(await updateHome(null, form({ place: JSON.stringify(orlando), homeAirport: "XQX" }))).toMatchObject({ ok: false });
    // An airport as the home place is its own home airport; a place with no coordinates suggests none.
    const airport: PlaceRef = { kind: "airport", name: "Seattle-Tacoma International Airport", lat: 47.4438, lon: -122.3017, tz: "America/Los_Angeles", iata: "SEA" };
    expect(await updateHome(null, form({ place: JSON.stringify(airport) }))).toEqual({ ok: true, homeAirportIata: "SEA" });
    expect(await updateHome(null, form({ place: JSON.stringify(chicago) }))).toEqual({ ok: true, homeAirportIata: null });
  });

  it("refuses what is not a place, and leaves home alone", async () => {
    for (const place of ["", "Minneapolis", "{broken", JSON.stringify({ kind: "city", name: "Nowhere", tz: "CST" }), "null"]) {
      expect(await updateHome(null, form({ place })), place).toMatchObject({ ok: false, error: "Choose your home city from the list." });
    }
    expect((await account(lydia)).home).toEqual(chicago);
    expect((await clocksOf(lydia))[0].label).toBe("Home sweet home");
  });

  it("drops a plan's clock when home moves to the plan's place, and repairs a missing home clock", async () => {
    await seedExamplePlan(lydia);
    expect((await clocksOf(lydia)).map((clock) => clock.place.name).sort()).toEqual(["Chicago", "Orlando"]);
    await t.db.delete(schema.clocks).where(and(eq(schema.clocks.userId, lydia.id), eq(schema.clocks.isHome, true)));

    await updateHome(null, form({ place: JSON.stringify(orlando) }));
    // One clock: home, which is Orlando now. A second Orlando would say the same thing.
    const clocks = await clocksOf(lydia);
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ isHome: true, source: "manual", planId: null });
    expect(clocks[0].place.name).toBe("Orlando");

    // Moving away again brings the plan's clock back.
    await updateHome(null, form({ place: JSON.stringify(minneapolis) }));
    expect((await clocksOf(lydia)).map((clock) => [clock.place.name, clock.source]).sort()).toEqual([["Minneapolis", "manual"], ["Orlando", "plan"]]);
  });
});

describe("exportMyData", () => {
  it("hands over everything the account holds, as JSON, under a dated file name", async () => {
    await seedExamplePlan(lydia);
    await t.db.insert(schema.briefingStates).values({ userId: lydia.id, itemKey: "deadline:car:past-recommended", state: "dismissed", bucket: "past-recommended" });

    const result = await exportMyData();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toMatch(/^etoile-export-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(result.json);

    expect(data).toMatchObject({ format: "etoile-export", version: 1 });
    expect(Date.parse(data.exportedAt)).not.toBeNaN();
    expect(data.account).toMatchObject({ id: lydia.id, email: lydia.email, name: "Lydia Hartley", home: chicago, timeStyle: "12h_with_24h", currency: "USD" });
    expect(data.clocks.map((clock: { place: PlaceRef }) => clock.place.name).sort()).toEqual(["Chicago", "Orlando"]);
    expect(data.headsUp).toHaveLength(1);
    expect(data.plans).toHaveLength(1);

    const [plan] = data.plans;
    expect(plan.plan).toMatchObject({ title: "Hartley Family Christmas", isExample: true, ownerId: lydia.id });
    expect([plan.households.length, plan.people.length, plan.arrivals.length, plan.bookings.length, plan.schedule.length, plan.tasks.length, plan.expenses.length]).toEqual([3, 9, 6, 10, 5, 11, 5]);
    expect(plan.sharePage).toMatchObject({ slug: expect.stringMatching(/^hartley-christmas/), status: "published" });
    // Her own private details are hers to take: codes, prices, notes.
    const house = plan.bookings.find((booking: { kind: string }) => booking.kind === "lodging");
    expect(house).toMatchObject({ confirmationCode: "HA-4417K29", priceAmount: 384_000 });
    expect(house.details.accessNotes).toContain("4417");
    expect(plan.people.find((person: { name: string }) => person.name === "Ruth Hartley")).toMatchObject({ email: "ruth.hartley@example.com", rsvpStatus: "yes" });
  });

  it("leaves out everything that works as a key", async () => {
    const planId = (await seedExamplePlan(lydia)).planId!;
    const token = newToken();
    await t.db.insert(schema.sessions).values({ userId: lydia.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) });
    const sitePasscodeHash = await hashPassword("lake-house");
    await t.db.update(schema.sites).set({ passcodeHash: sitePasscodeHash }).where(eq(schema.sites.planId, planId));
    const [party] = await t.db.select().from(schema.parties).where(eq(schema.parties.planId, planId)).limit(1);
    const [organizer] = await t.db.select().from(schema.people).where(and(eq(schema.people.planId, planId), eq(schema.people.role, "organizer")));
    const [person] = await t.db.update(schema.people).set({ guestToken: newToken() }).where(eq(schema.people.id, organizer.id)).returning();

    const result = await exportMyData();
    if (!result.ok) throw new Error(result.error);
    for (const secret of [passwordHash, sitePasscodeHash, hashSessionToken(token), party.guestToken, person.guestToken!, "passwordHash", "passcodeHash", "guestToken", "tokenHash"]) {
      expect(result.json.includes(secret), secret.slice(0, 12)).toBe(false);
    }
  });

  it("holds nothing of anybody else's", async () => {
    await seedExamplePlan(lydia);
    session.user = mallory;
    const result = await exportMyData();
    if (!result.ok) throw new Error(result.error);
    const data = JSON.parse(result.json);
    expect(data.account.id).toBe(mallory.id);
    expect(data.plans).toEqual([]);
    expect(data.clocks).toHaveLength(1);
    expect(result.json).not.toContain(lydia.id);
    expect(result.json).not.toContain("Hartley");
    expect(await exportUserData("nobody000000")).toBeNull();
  });

  it("needs someone signed in", async () => {
    session.user = null;
    await expect(exportMyData()).rejects.toThrow("REDIRECT /sign-in");
  });
});

describe("deleteAccount", () => {
  it("deletes nothing without the right password", async () => {
    await seedExamplePlan(lydia);
    expect(await deleteAccount(null, form({}))).toMatchObject({ ok: false, error: "Enter your password to delete your account." });
    const wrong = await deleteAccount(null, form({ password: "not the password" }));
    expect(wrong).toMatchObject({ ok: false, error: "That password is not right." });
    // The password is never sent back.
    expect(wrong?.values).toBeUndefined();
    expect(await deleteAccount(null, form({ password: "x".repeat(300) }))).toMatchObject({ ok: false });
    expect(await account(lydia)).toBeDefined();
    expect(await t.db.select().from(schema.plans).where(eq(schema.plans.ownerId, lydia.id))).toHaveLength(1);
  });

  it("deletes the account and everything in it, ends the session, and touches nobody else", async () => {
    const mine = (await seedExamplePlan(lydia)).planId!;
    const theirs = (await seedExamplePlan(mallory)).planId!;
    const token = newToken();
    await t.db.insert(schema.sessions).values({ userId: lydia.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) });
    await t.db.insert(schema.briefingStates).values({ userId: lydia.id, itemKey: "k", state: "done", bucket: "b" });
    jar.set(SESSION_COOKIE, token);

    await expect(deleteAccount(null, form({ password: PASSWORD }))).rejects.toThrow("REDIRECT /");

    expect(await account(lydia)).toBeUndefined();
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    for (const table of [schema.sessions, schema.clocks, schema.briefingStates] as const) {
      expect(await t.db.select().from(table).where(eq(table.userId, lydia.id))).toEqual([]);
    }
    expect(await t.db.select().from(schema.plans).where(eq(schema.plans.ownerId, lydia.id))).toEqual([]);
    for (const table of [schema.parties, schema.people, schema.arrivals, schema.bookings, schema.itineraryItems, schema.tasks, schema.expenses, schema.sites] as const) {
      expect(await t.db.select().from(table).where(eq(table.planId, mine))).toEqual([]);
    }
    // Her share page's address answers nothing any more; Mallory's whole account is intact.
    expect(await account(mallory)).toBeDefined();
    expect(await t.db.select().from(schema.people).where(eq(schema.people.planId, theirs))).toHaveLength(9);
    expect(await t.db.select().from(schema.sites).where(eq(schema.sites.planId, theirs))).toHaveLength(1);
    expect(await clocksOf(mallory)).toHaveLength(2);
  });

  it("stops counting password tries after five in a quarter of an hour", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await deleteAccount(null, form({ password: `wrong ${attempt}` }))).toMatchObject({ error: "That password is not right." });
    }
    const blocked = await deleteAccount(null, form({ password: PASSWORD }));
    expect(blocked?.error).toMatch(/^Too many tries\. Wait .+ and try again\.$/);
    expect(await account(lydia)).toBeDefined();
    // Somebody else's tries are their own.
    session.user = mallory;
    await expect(deleteAccount(null, form({ password: PASSWORD }))).rejects.toThrow("REDIRECT /");
  });

  it("needs someone signed in", async () => {
    session.user = null;
    await expect(deleteAccount(null, form({ password: PASSWORD }))).rejects.toThrow("REDIRECT /sign-in");
  });
});
