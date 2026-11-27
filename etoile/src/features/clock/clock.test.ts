import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session: { user: Record<string, unknown> | null } = { user: null };
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: async () => {
    if (!session.user) throw new Error("REDIRECT /sign-in");
    return session.user;
  },
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

import { eq } from "drizzle-orm";
import { schema } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { createTestDb, type TestDb } from "@/db/testing";
import type { PlaceRef } from "@/lib/domain";
import { newId } from "@/lib/ids";
import { addClock, relabelClock, removeClock, reorderClocks, setClockPinned } from "./actions";
import { listClocks } from "./queries";
import {
  CLOCK_DISMISSED_ON,
  MAX_MANUAL_CLOCKS,
  clockName,
  isClockVisible,
  isMatchedPlace,
  isSameClockPlace,
  planClockExpiry,
  planWantsClock,
} from "./rules";
import { syncPlanClocks } from "./sync";

const minneapolis: PlaceRef = { kind: "home", name: "Minneapolis", tz: "America/Chicago" };
const orlando: PlaceRef = { kind: "city", name: "Orlando", region: "Florida", countryCode: "US", lat: 28.53834, lon: -81.37924, tz: "America/New_York" };
const london: PlaceRef = { kind: "city", name: "London", countryCode: "GB", lat: 51.50853, lon: -0.12574, tz: "Europe/London" };
const tokyo: PlaceRef = { kind: "city", name: "Tokyo", countryCode: "JP", lat: 35.6895, lon: 139.69171, tz: "Asia/Tokyo" };
const lisbon: PlaceRef = { kind: "city", name: "Lisbon", countryCode: "PT", lat: 38.72509, lon: -9.1498, tz: "Europe/Lisbon" };

// Noon in Minneapolis on Thursday, November 26.
const NOW = new Date("2026-11-26T18:00:00Z");
const TODAY = "2026-11-26";

type TestUser = Omit<typeof schema.users.$inferSelect, "passwordHash">;
let t: TestDb;
let lydia: TestUser;
let mallory: TestUser;

async function addUser(email: string): Promise<TestUser> {
  const [row] = await t.db.insert(schema.users).values({ email, name: email.split("@")[0], passwordHash: "x", home: minneapolis }).returning();
  await t.db.insert(schema.clocks).values({ userId: row.id, place: minneapolis, isHome: true, sortOrder: 0 });
  const { passwordHash: _hash, ...user } = row;
  void _hash;
  return user;
}

async function addPlan(owner: TestUser, title: string, fields: Partial<typeof schema.plans.$inferInsert> = {}) {
  const [plan] = await t.db
    .insert(schema.plans)
    .values({ ownerId: owner.id, template: "trip", title, origin: minneapolis, destination: orlando, tz: orlando.tz, startDate: "2026-12-19", endDate: "2026-12-27", ...fields })
    .returning();
  return plan;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const rows = (user: TestUser) => t.db.select().from(schema.clocks).where(eq(schema.clocks.userId, user.id));
const names = async (user: TestUser, now = NOW) => (await listClocks(user, { now })).map((clock) => clock.name);
async function added(place: PlaceRef, label = ""): Promise<string> {
  const result = await addClock(null, form({ place: JSON.stringify(place), label }));
  if (!result.ok) throw new Error(`addClock failed: ${result.error}`);
  return result.clockId;
}

beforeAll(async () => {
  t = await createTestDb();
  lydia = await addUser("lydia@example.com");
  mallory = await addUser("mallory@example.com");
});
afterAll(() => t.close());
beforeEach(async () => {
  // Back to one home clock each and no plans.
  await t.db.delete(schema.plans);
  await t.db.delete(schema.clocks).where(eq(schema.clocks.isHome, false));
  await t.db.update(schema.clocks).set({ sortOrder: 0, label: null, place: minneapolis });
  session.user = lydia;
  refresh.mockClear();
});

describe("the rules", () => {
  const plan = (fields: Partial<Parameters<typeof planWantsClock>[0]> = {}) => ({ destination: orlando, startDate: "2026-12-19", endDate: "2026-12-27", archivedAt: null, ...fields });

  it("lets a plan's clock go a week after the plan ends", () => {
    expect(planClockExpiry(plan())).toBe("2027-01-03");
    expect(planClockExpiry(plan({ endDate: null }))).toBe("2026-12-26");
    expect(planClockExpiry(plan({ startDate: null, endDate: null }))).toBeNull();
  });

  it("wants a clock for a plan with a matched destination that is not over and not put away", () => {
    expect(planWantsClock(plan(), TODAY)).toBe(true);
    expect(planWantsClock(plan(), "2027-01-03")).toBe(true);
    expect(planWantsClock(plan(), "2027-01-04")).toBe(false);
    // No dates yet: the clock stays until there are some.
    expect(planWantsClock(plan({ startDate: null, endDate: null }), "2030-01-01")).toBe(true);
    expect(planWantsClock(plan({ archivedAt: new Date() }), TODAY)).toBe(false);
    expect(planWantsClock(plan({ destination: null }), TODAY)).toBe(false);
    // A place used as typed has no coordinates: the clock waits until it is matched.
    expect(planWantsClock(plan({ destination: { kind: "venue", name: "Grandma's lake house", tz: "America/Chicago" } }), TODAY)).toBe(false);
    expect(isMatchedPlace(orlando)).toBe(true);
    expect(isMatchedPlace(minneapolis)).toBe(false);
    expect(isMatchedPlace(null)).toBe(false);
  });

  it("shows home, hand-added and pinned clocks always, and a plan's clock until it runs out", () => {
    const clock = (fields: Partial<Parameters<typeof isClockVisible>[0]>) => ({ isHome: false, source: "plan" as const, pinned: false, expiresOn: "2027-01-03", ...fields });
    expect(isClockVisible(clock({}), "2027-01-03")).toBe(true);
    expect(isClockVisible(clock({}), "2027-01-04")).toBe(false);
    expect(isClockVisible(clock({ pinned: true }), "2030-01-01")).toBe(true);
    expect(isClockVisible(clock({ expiresOn: null }), "2030-01-01")).toBe(true);
    expect(isClockVisible(clock({ expiresOn: CLOCK_DISMISSED_ON }), TODAY)).toBe(false);
    expect(isClockVisible(clock({ source: "manual", expiresOn: "2000-01-01" }), TODAY)).toBe(true);
    expect(isClockVisible(clock({ isHome: true, source: "manual", expiresOn: null }), TODAY)).toBe(true);
  });

  it("knows one place from another, and what to call a clock", () => {
    expect(isSameClockPlace(orlando, { name: " orlando ", tz: "America/New_York" })).toBe(true);
    expect(isSameClockPlace(orlando, { name: "Orlando", tz: "America/Chicago" })).toBe(false);
    expect(isSameClockPlace(orlando, { name: "Miami", tz: "America/New_York" })).toBe(false);
    expect(clockName({ label: "Grandma's", place: orlando })).toBe("Grandma's");
    expect(clockName({ label: "  ", place: orlando })).toBe("Orlando");
    expect(clockName({ label: null, place: orlando })).toBe("Orlando");
  });
});

describe("exactly one home clock", () => {
  it("is enforced by the database", async () => {
    const second = t.db.insert(schema.clocks).values({ userId: lydia.id, place: london, isHome: true });
    await expect(second.then(() => "inserted", (error: unknown) => (isUniqueViolation(error) ? "refused" : "other error"))).resolves.toBe("refused");
    expect((await rows(lydia)).filter((clock) => clock.isHome)).toHaveLength(1);
  });

  it("cannot be removed, and always leads the list", async () => {
    const home = (await rows(lydia)).find((clock) => clock.isHome)!;
    expect(await removeClock(null, form({ clockId: home.id }))).toMatchObject({ ok: false, error: "Your home clock stays. To change it, change your home place in settings." });
    expect((await rows(lydia)).some((clock) => clock.isHome)).toBe(true);

    const londonId = await added(london);
    const tokyoId = await added(tokyo);
    // Even when the order asks for it last, and even with a stray number in the database.
    await reorderClocks(null, form({ order: `${tokyoId},${londonId},${home.id}` }));
    await t.db.update(schema.clocks).set({ sortOrder: 99 }).where(eq(schema.clocks.id, home.id));
    expect(await names(lydia)).toEqual(["Minneapolis", "Tokyo", "London"]);
    expect((await listClocks(lydia, { now: NOW }))[0]).toMatchObject({ isHome: true, source: "manual", plan: null, tz: "America/Chicago" });
  });
});

describe("addClock", () => {
  it("adds a clock for a place, after the ones already there", async () => {
    const result = await addClock(null, form({ place: JSON.stringify(london) }));
    expect(result).toMatchObject({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    await added(tokyo, "Head office");
    const clocks = await listClocks(lydia, { now: NOW });
    expect(clocks.map((clock) => [clock.name, clock.label, clock.source, clock.isHome, clock.pinned, clock.expiresOn])).toEqual([
      ["Minneapolis", null, "manual", true, false, null],
      ["London", null, "manual", false, false, null],
      ["Head office", "Head office", "manual", false, false, null],
    ]);
    expect(clocks[2].place).toEqual(tokyo);
    expect(clocks[2].tz).toBe("Asia/Tokyo");
  });

  it("refuses a second clock for a place already showing, home included", async () => {
    await added(london);
    expect(await addClock(null, form({ place: JSON.stringify({ ...london, name: "LONDON" }) }))).toMatchObject({ ok: false, error: "You already have a clock for London." });
    expect(await addClock(null, form({ place: JSON.stringify({ kind: "city", name: "Minneapolis", tz: "America/Chicago" }) }))).toMatchObject({ ok: false, error: "You already have a clock for Minneapolis." });
    expect(await rows(lydia)).toHaveLength(2);
  });

  it("refuses what is not a place, a name that is too long, and more clocks than fit", async () => {
    expect(await addClock(null, form({}))).toMatchObject({ ok: false, error: "Choose a place from the list." });
    expect(await addClock(null, form({ place: "London" }))).toMatchObject({ ok: false, fieldErrors: { place: ["Choose a place from the list"] } });
    expect(await addClock(null, form({ place: JSON.stringify({ kind: "city", name: "Nowhere", tz: "Mars/Olympus" }) }))).toMatchObject({ ok: false });
    expect(await addClock(null, form({ place: JSON.stringify(london), label: "x".repeat(41) }))).toMatchObject({ ok: false, error: "Use a shorter name", values: { label: "x".repeat(41) } });
    expect(await rows(lydia)).toHaveLength(1);

    for (let i = 0; i < MAX_MANUAL_CLOCKS; i++) await added({ kind: "city", name: `City ${i}`, tz: "Europe/Paris" });
    const full = await addClock(null, form({ place: JSON.stringify(london) }));
    expect(full).toMatchObject({ ok: false });
    if (!full.ok) expect(full.error).toContain(String(MAX_MANUAL_CLOCKS));
    expect(await rows(lydia)).toHaveLength(1 + MAX_MANUAL_CLOCKS);
  });
});

describe("removeClock, relabelClock and reorderClocks", () => {
  it("removes a hand-added clock for good", async () => {
    const id = await added(london);
    expect(await removeClock(null, form({ clockId: id }))).toEqual({ ok: true });
    expect(await rows(lydia)).toHaveLength(1);
    expect(await removeClock(null, form({ clockId: id }))).toMatchObject({ ok: false, error: "That clock is no longer there." });
    expect(await removeClock(null, form({ clockId: "junk" }))).toMatchObject({ ok: false });
  });

  it("renames a clock, and goes back to the place's name when the label is cleared", async () => {
    const id = await added(london);
    expect(await relabelClock(null, form({ clockId: id, label: "  Mum and Dad " }))).toEqual({ ok: true, clockId: id });
    expect(await names(lydia)).toEqual(["Minneapolis", "Mum and Dad"]);
    expect(await relabelClock(null, form({ clockId: id, label: "" }))).toEqual({ ok: true, clockId: id });
    expect(await names(lydia)).toEqual(["Minneapolis", "London"]);
    expect(await relabelClock(null, form({ clockId: id, label: "y".repeat(41) }))).toMatchObject({ ok: false, error: "Use a shorter name" });
    // The home clock can be renamed too.
    const home = (await rows(lydia)).find((clock) => clock.isHome)!;
    await relabelClock(null, form({ clockId: home.id, label: "Home" }));
    expect((await names(lydia))[0]).toBe("Home");
  });

  it("puts the clocks in the order asked, with the ones left out after", async () => {
    const a = await added(london);
    const b = await added(tokyo);
    const c = await added(lisbon);
    expect(await names(lydia)).toEqual(["Minneapolis", "London", "Tokyo", "Lisbon"]);
    expect(await reorderClocks(null, form({ order: `${c}, ${a}, ${b}` }))).toEqual({ ok: true });
    expect(await names(lydia)).toEqual(["Minneapolis", "Lisbon", "London", "Tokyo"]);
    expect(await reorderClocks(null, form({ order: b }))).toEqual({ ok: true });
    expect(await names(lydia)).toEqual(["Minneapolis", "Tokyo", "Lisbon", "London"]);
    expect((await rows(lydia)).map((clock) => clock.sortOrder).sort()).toEqual([0, 1, 2, 3]);
  });

  it("refuses an order it cannot read, or one that names a clock that is not there", async () => {
    const a = await added(london);
    const b = await added(tokyo);
    for (const order of ["", "junk", `${a},${a}`, `${a},not-an-id`, `${a},${newId()}`]) {
      expect((await reorderClocks(null, form({ order }))).ok, order).toBe(false);
    }
    expect(await names(lydia)).toEqual(["Minneapolis", "London", "Tokyo"]);
    expect(b).toBeTruthy();
  });
});

describe("clocks that follow plans", () => {
  it("puts a plan's destination on Home, tagged with the plan, to leave a week after it ends", async () => {
    const plan = await addPlan(lydia, "Hartley Family Christmas");
    expect(await syncPlanClocks(lydia, { now: NOW })).toEqual({ added: 1, updated: 0, removed: 0 });
    const clocks = await listClocks(lydia, { now: NOW });
    expect(clocks).toHaveLength(2);
    expect(clocks[1]).toMatchObject({
      name: "Orlando",
      source: "plan",
      isHome: false,
      pinned: false,
      expiresOn: "2027-01-03",
      plan: { id: plan.id, title: "Hartley Family Christmas" },
      tz: "America/New_York",
    });
    // Doing it again changes nothing.
    expect(await syncPlanClocks(lydia, { now: NOW })).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(await rows(lydia)).toHaveLength(2);
  });

  it("shows the clock through the week after the plan and not a day longer", async () => {
    await addPlan(lydia, "Christmas");
    await syncPlanClocks(lydia, { now: NOW });
    // Jan 3 is the last day (end Dec 27 plus 7), counted where the person lives.
    expect(await names(lydia, new Date("2027-01-04T05:59:00Z"))).toEqual(["Minneapolis", "Orlando"]);
    expect(await names(lydia, new Date("2027-01-04T06:00:00Z"))).toEqual(["Minneapolis"]);
    // The next sync clears it away.
    expect(await syncPlanClocks(lydia, { now: new Date("2027-01-04T06:00:00Z") })).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(await rows(lydia)).toHaveLength(1);
  });

  it("keeps a pinned clock after the plan is over, and lets it go again once unpinned", async () => {
    await addPlan(lydia, "Christmas");
    await syncPlanClocks(lydia, { now: NOW });
    const clockId = (await listClocks(lydia, { now: NOW }))[1].id;
    expect(await setClockPinned(null, form({ clockId, pinned: "1" }))).toEqual({ ok: true, clockId });

    const later = new Date("2027-03-01T18:00:00Z");
    expect(await names(lydia, later)).toEqual(["Minneapolis", "Orlando"]);
    expect(await syncPlanClocks(lydia, { now: later })).toEqual({ added: 0, updated: 0, removed: 0 });
    expect((await listClocks(lydia, { now: later }))[1]).toMatchObject({ pinned: true, plan: { title: "Christmas" } });

    expect(await setClockPinned(null, form({ clockId, pinned: "0" }))).toEqual({ ok: true, clockId });
    expect(await names(lydia, later)).toEqual(["Minneapolis"]);
    expect((await syncPlanClocks(lydia, { now: later })).removed).toBe(1);
  });

  it("has nothing to pin on a clock that never leaves", async () => {
    const id = await added(london);
    expect(await setClockPinned(null, form({ clockId: id, pinned: "1" }))).toMatchObject({ ok: false, error: "This clock stays until you remove it. There is nothing to pin." });
  });

  it("follows the plan: new dates, a new destination, archived and back", async () => {
    const plan = await addPlan(lydia, "Christmas");
    await syncPlanClocks(lydia, { now: NOW });
    const clockId = (await listClocks(lydia, { now: NOW }))[1].id;
    await relabelClock(null, form({ clockId, label: "The lake house" }));

    await t.db.update(schema.plans).set({ endDate: "2026-12-30" }).where(eq(schema.plans.id, plan.id));
    expect(await syncPlanClocks(lydia, { now: NOW })).toEqual({ added: 0, updated: 1, removed: 0 });
    expect((await listClocks(lydia, { now: NOW }))[1]).toMatchObject({ id: clockId, name: "The lake house", expiresOn: "2027-01-06" });

    // A new destination moves the same clock; the old label does not describe it any more.
    await t.db.update(schema.plans).set({ destination: lisbon, tz: lisbon.tz }).where(eq(schema.plans.id, plan.id));
    await syncPlanClocks(lydia, { now: NOW });
    expect((await listClocks(lydia, { now: NOW }))[1]).toMatchObject({ id: clockId, name: "Lisbon", label: null, tz: "Europe/Lisbon" });

    await t.db.update(schema.plans).set({ archivedAt: NOW }).where(eq(schema.plans.id, plan.id));
    expect(await syncPlanClocks(lydia, { now: NOW })).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(await names(lydia)).toEqual(["Minneapolis"]);
    await t.db.update(schema.plans).set({ archivedAt: null }).where(eq(schema.plans.id, plan.id));
    expect((await syncPlanClocks(lydia, { now: NOW })).added).toBe(1);
    expect(await names(lydia)).toEqual(["Minneapolis", "Lisbon"]);

    // Deleting the plan takes its clock with it, pinned or not.
    await t.db.update(schema.clocks).set({ pinned: true }).where(eq(schema.clocks.planId, plan.id));
    await t.db.delete(schema.plans).where(eq(schema.plans.id, plan.id));
    expect(await rows(lydia)).toHaveLength(1);
  });

  it("waits for a destination the app can place, and has no clock for a plan at home", async () => {
    await addPlan(lydia, "Lake house", { destination: { kind: "venue", name: "Grandma's lake house", tz: "America/Chicago" } });
    await addPlan(lydia, "No place yet", { destination: null });
    // A matched Minneapolis, the same place as home: a second clock would say the same thing.
    await addPlan(lydia, "Hosting at ours", { destination: { kind: "city", name: "Minneapolis", lat: 44.98, lon: -93.26, tz: "America/Chicago" } });
    expect(await syncPlanClocks(lydia, { now: NOW })).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(await names(lydia)).toEqual(["Minneapolis"]);
    // A draft with a matched place has a clock with no end.
    await addPlan(lydia, "Someday", { destination: tokyo, tz: tokyo.tz, startDate: null, endDate: null });
    await syncPlanClocks(lydia, { now: NOW });
    expect((await listClocks(lydia, { now: new Date("2031-01-01T00:00:00Z") }))[1]).toMatchObject({ name: "Tokyo", expiresOn: null, plan: { title: "Someday" } });
  });

  it("shows one clock for two plans in the same place, and hands it on when the first is done", async () => {
    const first = await addPlan(lydia, "Christmas in Orlando");
    const second = await addPlan(lydia, "Spring break in Orlando", { startDate: "2027-03-20", endDate: "2027-03-27" });
    expect((await syncPlanClocks(lydia, { now: NOW })).added).toBe(1);
    expect(await listClocks(lydia, { now: NOW })).toHaveLength(2);
    expect((await listClocks(lydia, { now: NOW }))[1].plan).toEqual({ id: first.id, title: "Christmas in Orlando" });

    // A clock she already added by hand counts too.
    await addPlan(lydia, "London in May", { destination: london, tz: london.tz, startDate: "2027-05-01", endDate: "2027-05-05" });
    await added(london);
    expect((await syncPlanClocks(lydia, { now: NOW })).added).toBe(0);
    expect((await names(lydia)).filter((name) => name === "London")).toHaveLength(1);

    // Once Christmas is over and gone from Home, spring break takes the Orlando clock over.
    const february = new Date("2027-02-01T18:00:00Z");
    expect(await syncPlanClocks(lydia, { now: february })).toEqual({ added: 1, updated: 0, removed: 1 });
    const orlandoClock = (await listClocks(lydia, { now: february })).find((clock) => clock.name === "Orlando")!;
    expect(orlandoClock).toMatchObject({ plan: { id: second.id }, expiresOn: "2027-04-03" });
  });

  it("stays removed when the person removes it, for as long as the plan lasts", async () => {
    const plan = await addPlan(lydia, "Christmas");
    await syncPlanClocks(lydia, { now: NOW });
    const clockId = (await listClocks(lydia, { now: NOW }))[1].id;
    expect(await removeClock(null, form({ clockId }))).toEqual({ ok: true });
    expect(await names(lydia)).toEqual(["Minneapolis"]);

    // The plan changes; the clock does not come back.
    await t.db.update(schema.plans).set({ endDate: "2026-12-29" }).where(eq(schema.plans.id, plan.id));
    expect(await syncPlanClocks(lydia, { now: NOW })).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(await names(lydia)).toEqual(["Minneapolis"]);
    // She can still add Orlando by hand.
    await added(orlando);
    expect(await names(lydia)).toEqual(["Minneapolis", "Orlando"]);
    // The put-away row goes when the plan is over.
    expect((await syncPlanClocks(lydia, { now: new Date("2027-02-01T18:00:00Z") })).removed).toBe(1);
    expect((await rows(lydia)).map((clock) => clock.source)).toEqual(["manual", "manual"]);
  });
});

describe("whose clocks", () => {
  it("lists, changes and syncs only the signed-in person's own", async () => {
    const mine = await added(london, "Mine");
    await addPlan(lydia, "Christmas");
    await syncPlanClocks(lydia, { now: NOW });
    const before = await rows(lydia);

    // Mallory sees only her home clock, and her sync does not pick up Lydia's plan.
    expect(await names(mallory)).toEqual(["Minneapolis"]);
    expect(await syncPlanClocks(mallory, { now: NOW })).toEqual({ added: 0, updated: 0, removed: 0 });

    session.user = mallory;
    refresh.mockClear();
    const planClock = before.find((clock) => clock.source === "plan")!;
    const lydiasHome = before.find((clock) => clock.isHome)!;
    expect(await removeClock(null, form({ clockId: mine }))).toMatchObject({ ok: false, error: "That clock is no longer there." });
    expect(await removeClock(null, form({ clockId: planClock.id }))).toMatchObject({ ok: false });
    expect(await relabelClock(null, form({ clockId: mine, label: "Hers now" }))).toMatchObject({ ok: false });
    expect(await relabelClock(null, form({ clockId: lydiasHome.id, label: "Hers now" }))).toMatchObject({ ok: false });
    expect(await setClockPinned(null, form({ clockId: planClock.id, pinned: "1" }))).toMatchObject({ ok: false });
    expect(await reorderClocks(null, form({ order: `${planClock.id},${mine}` }))).toMatchObject({ ok: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(await rows(lydia)).toEqual(before);
    expect(await rows(mallory)).toHaveLength(1);

    // And the same place is hers to add: clocks are per person.
    expect(await addClock(null, form({ place: JSON.stringify(london) }))).toMatchObject({ ok: true });
    expect(await names(mallory)).toEqual(["Minneapolis", "London"]);
    expect(await names(lydia)).toEqual(["Minneapolis", "Mine", "Orlando"]);
  });

  it("needs someone signed in", async () => {
    session.user = null;
    await expect(addClock(null, form({ place: JSON.stringify(london) }))).rejects.toThrow("REDIRECT /sign-in");
    await expect(removeClock(null, form({ clockId: newId() }))).rejects.toThrow("REDIRECT /sign-in");
    await expect(reorderClocks(null, form({ order: newId() }))).rejects.toThrow("REDIRECT /sign-in");
  });
});
