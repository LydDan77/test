import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A signed-in user, and Next's request-only functions stubbed. vi.mock calls go before imports.
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
import { createTestDb, type TestDb } from "@/db/testing";
import { bookingDetailsSchema, emptyBookingDetails, rsvpQuestionsSchema, siteSectionsSchema, type PlaceRef } from "@/lib/domain";
import { newId } from "@/lib/ids";
import { addDays, localDateOf } from "@/lib/time";
import { archivePlan, createPlan, deletePlan, duplicatePlan, removeExamplePlan, restoreExamplePlan, restorePlan, updatePlan } from "./actions";
import { findPlanData } from "./queries";
import { seedExamplePlan } from "./seed";

const chicago: PlaceRef = { kind: "home", name: "Chicago", countryCode: "US", tz: "America/Chicago" };
const orlando: PlaceRef = { kind: "city", name: "Orlando", region: "Florida", countryCode: "US", lat: 28.53834, lon: -81.37924, tz: "America/New_York" };
const lisbon: PlaceRef = { kind: "city", name: "Lisbon", region: "Lisbon District", countryCode: "PT", lat: 38.72509, lon: -9.1498, tz: "Europe/Lisbon" };
const austin: PlaceRef = { kind: "city", name: "Austin", region: "Texas", countryCode: "US", lat: 30.26715, lon: -97.74306, tz: "America/Chicago" };

type TestUser = Omit<typeof schema.users.$inferSelect, "passwordHash">;
let t: TestDb;
let lydia: TestUser;
let mallory: TestUser;

async function addUser(email: string, name: string): Promise<TestUser> {
  const [row] = await t.db.insert(schema.users).values({ email, name, passwordHash: "x", home: chicago }).returning();
  await t.db.insert(schema.clocks).values({ userId: row.id, place: chicago, isHome: true });
  const { passwordHash: _hash, ...user } = row;
  void _hash;
  return user;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const place = (ref: PlaceRef) => JSON.stringify(ref);
const as = (user: TestUser) => {
  session.user = user;
};
/** Dates far enough out that "today" never catches up with these tests. */
const inDays = (days: number) => addDays(localDateOf(new Date(), "America/New_York"), days);

async function created(fields: Record<string, string>): Promise<string> {
  const result = await createPlan(null, form(fields));
  if (!result.ok) throw new Error(`createPlan failed: ${result.error}`);
  return result.planId;
}

const clocksOf = (userId: string) => t.db.select().from(schema.clocks).where(eq(schema.clocks.userId, userId));
const planRow = async (planId: string) => (await t.db.select().from(schema.plans).where(eq(schema.plans.id, planId)))[0];

beforeAll(async () => {
  t = await createTestDb();
  lydia = await addUser("lydia@example.com", "Lydia Hartley");
  mallory = await addUser("mallory@example.com", "Mallory Quill");
});
afterAll(() => t.close());
beforeEach(async () => {
  // Every test starts with no plans, so that a plan's clock is never hidden behind an earlier
  // test's clock for the same place (one place, one clock: see the clock tests).
  await t.db.delete(schema.plans);
  await t.db.update(schema.users).set({ exampleState: "seeded" });
  as(lydia);
  refresh.mockClear();
});

describe("createPlan", () => {
  it("makes a family get-together from what, where, when and who", async () => {
    const result = await createPlan(
      null,
      form({
        template: "family_event",
        place: place(orlando),
        startDate: "2027-12-18",
        endDate: "2027-12-26",
        people: "9",
        names: "Rob Hartley\nTheo Hartley\nRuth Hartley <ruth@example.com>\nDana Okafor, dana@example.com\nChris Okafor\nLydia Hartley",
      }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(refresh).toHaveBeenCalledTimes(1);

    const data = (await findPlanData(lydia, result.planId))!;
    expect(data.plan).toMatchObject({
      ownerId: lydia.id,
      template: "family_event",
      workMode: null,
      // The dates include Christmas, so that is what the plan is called.
      title: "Christmas in Orlando",
      startDate: "2027-12-18",
      endDate: "2027-12-26",
      dateStatus: "fixed",
      tz: "America/New_York",
      expectedPeople: 9,
      currency: "USD",
      replyDeadline: "2027-11-27",
      kindsInUse: ["flight", "lodging", "car", "ride", "meal", "shipment"],
      kindsNotNeeded: [],
      isExample: false,
      archivedAt: null,
    });
    expect(data.plan.destination).toEqual(orlando);
    // People set out from the organizer's home unless told otherwise.
    expect(data.plan.origin).toEqual(chicago);

    // The organizer and everyone named, once each; a family shares a household by last name.
    expect(data.people.map((person) => person.name)).toEqual(["Chris Okafor", "Dana Okafor", "Lydia Hartley", "Rob Hartley", "Ruth Hartley", "Theo Hartley"]);
    expect(data.parties.map((party) => party.name)).toEqual(["Hartley household", "Okafor household"]);
    const hartleys = data.parties[0];
    expect(data.people.filter((person) => person.partyId === hartleys.id)).toHaveLength(4);
    expect(hartleys.origin).toEqual(chicago);
    const organizer = data.people.find((person) => person.role === "organizer")!;
    expect(organizer).toMatchObject({ name: "Lydia Hartley", email: "lydia@example.com", rsvpStatus: "yes", rsvpVia: "organizer" });
    expect(data.people.find((person) => person.name === "Ruth Hartley")).toMatchObject({ email: "ruth@example.com", role: "guest", rsvpStatus: "not_invited" });
    expect(data.people.find((person) => person.name === "Dana Okafor")?.email).toBe("dana@example.com");

    // A "Needs you" booking for each tool the template switches on, in the fixed order.
    expect(data.bookings.map((booking) => [booking.kind, booking.status, booking.title])).toEqual([
      ["flight", "needed", "Flights to Orlando"],
      ["lodging", "needed", "A place to stay in Orlando"],
      ["car", "needed", "A car in Orlando"],
      ["ride", "needed", "Rides"],
      ["meal", "needed", "Food"],
      ["shipment", "needed", "Send ahead"],
    ].sort((a, b) => data.bookings.findIndex((x) => x.kind === a[0]) - data.bookings.findIndex((x) => x.kind === b[0])));
    expect(data.bookings.map((booking) => booking.kind).sort()).toEqual(["car", "flight", "lodging", "meal", "ride", "shipment"]);
    for (const booking of data.bookings) {
      expect(booking.details).toEqual(emptyBookingDetails(booking.kind));
      expect(bookingDetailsSchema.safeParse(booking.details).success).toBe(true);
    }

    // The template's tasks, with due dates worked out from the plan's dates. Orlando is not abroad.
    expect(data.tasks.map((task) => [task.title, task.essential, task.dueDate, task.source, task.ruleKey])).toEqual([
      ["Ask about dietary needs", true, "2027-12-04", "template", "template:dietary"],
      ["Arrange airport pickups", true, "2027-12-11", "template", "template:airport-pickups"],
      ["Confirm who cooks what", true, "2027-12-11", "template", "template:who-cooks"],
      ["Hold the mail", false, "2027-12-15", "template", "template:hold-mail"],
    ]);
    expect(data.tasks.every((task) => !task.done)).toBe(true);

    // A draft share page at a free, readable address.
    expect(data.site).toMatchObject({
      slug: "christmas-in-orlando",
      status: "draft",
      access: "link",
      theme: "invitation",
      accent: "evergreen",
      title: "Christmas in Orlando",
      hostLine: "Hosted by Lydia Hartley",
      repliesOpen: true,
      replyDeadline: "2027-11-27",
      whoIsComing: "first_names",
      publishedAt: null,
      unpublishOn: "2028-01-25",
      viewCount: 0,
    });
    expect(siteSectionsSchema.safeParse(data.site!.sections).success).toBe(true);
    expect(rsvpQuestionsSchema.safeParse(data.site!.rsvpQuestions).success).toBe(true);
    expect(data.site!.rsvpQuestions).toHaveLength(3);

    // Nothing else yet.
    expect([data.arrivals, data.handoffs, data.items, data.expenses, data.settlements]).toEqual([[], [], [], [], []]);

    // And the destination's clock is on Home.
    const clock = (await clocksOf(lydia.id)).find((row) => row.planId === result.planId);
    expect(clock).toMatchObject({ source: "plan", isHome: false, pinned: false, expiresOn: "2028-01-02" });
    expect(clock?.place).toEqual(orlando);
  });

  it("makes a draft when the dates are not known yet, from a place used as typed", async () => {
    const planId = await created({ template: "trip", placeText: "Grandma's lake house", startDate: "", endDate: "" });
    const data = (await findPlanData(lydia, planId))!;
    expect(data.plan).toMatchObject({
      template: "trip",
      title: "Trip to Grandma's lake house",
      startDate: null,
      endDate: null,
      dateStatus: "undecided",
      replyDeadline: null,
      // The usual count for a trip.
      expectedPeople: 2,
      // An unmatched place borrows the zone of where the plan sets out.
      tz: "America/Chicago",
      kindsInUse: ["flight", "lodging", "car", "ride"],
    });
    expect(data.plan.destination).toEqual({ kind: "venue", name: "Grandma's lake house", tz: "America/Chicago" });
    expect(data.people.map((person) => person.name)).toEqual(["Lydia Hartley"]);
    // Everyone on a trip starts as a group of one.
    expect(data.parties.map((party) => party.name)).toEqual(["Lydia Hartley"]);
    expect(data.bookings).toHaveLength(4);
    expect(data.tasks.map((task) => task.dueDate)).toEqual([null, null, null]);
    expect(data.site).toMatchObject({ status: "draft", theme: "postcard", slug: "trip-to-grandmas-lake-house", replyDeadline: null, unpublishOn: null, repliesOpen: false, hostLine: null });
    // The clock waits until the place is matched.
    expect((await clocksOf(lydia.id)).some((clock) => clock.planId === planId)).toBe(false);
  });

  it("asks one more thing of work, and builds a work event with its own defaults", async () => {
    const missing = await createPlan(null, form({ template: "work", place: place(austin), startDate: "2028-01-12", endDate: "2028-01-15" }));
    expect(missing).toMatchObject({ ok: false, error: "Say whether you are traveling or hosting", fieldErrors: { workMode: ["Say whether you are traveling or hosting"] } });

    const planId = await created({ template: "work", workMode: "event", place: place(austin), startDate: "2028-01-12", endDate: "2028-01-15", title: "Q1 Sales Kickoff", names: "Ana Lopez\nBen Okoro" });
    const data = (await findPlanData(lydia, planId))!;
    expect(data.plan).toMatchObject({ template: "work", workMode: "event", title: "Q1 Sales Kickoff", expectedPeople: 10, replyDeadline: "2027-12-29", kindsInUse: ["flight", "lodging", "ride", "meal", "shipment"] });
    expect(data.bookings.map((booking) => booking.kind).sort()).toEqual(["flight", "lodging", "meal", "ride", "shipment"]);
    // Work pages start behind a passcode; teams are not guessed from names.
    expect(data.site).toMatchObject({ access: "passcode", theme: "agenda", whoIsComing: "hidden", slug: "q1-sales-kickoff", passcodeHash: null, status: "draft" });
    expect(data.parties.map((party) => party.name).sort()).toEqual(["Ana Lopez", "Ben Okoro", "Lydia Hartley"]);
    expect(data.tasks.find((task) => task.ruleKey === "template:submit-expenses")?.dueDate).toBe("2028-01-22");

    const solo = (await findPlanData(lydia, await created({ template: "work", workMode: "travel", place: place(austin) })))!;
    expect(solo.plan).toMatchObject({ workMode: "travel", expectedPeople: 1, title: "Work trip to Austin", kindsInUse: ["flight", "lodging", "ride"] });
  });

  it("seeds the passport check only when the plan leaves the country, and takes another origin", async () => {
    const abroad = (await findPlanData(lydia, await created({ template: "trip", place: place(lisbon), startDate: "2028-04-10", endDate: "2028-04-17", people: "2" })))!;
    expect(abroad.tasks.map((task) => task.ruleKey)).toContain("template:passport");
    expect(abroad.plan.tz).toBe("Europe/Lisbon");
    expect(abroad.site!.sections.filter((section) => section.enabled).map((section) => section.type)).toContain("travel_notes");

    const fromLisbon = (await findPlanData(lydia, await created({ template: "trip", place: place(orlando), origin: place(lisbon), title: "Back to Orlando" })))!;
    expect(fromLisbon.plan.origin).toEqual(lisbon);
    expect(fromLisbon.tasks.map((task) => task.ruleKey)).toContain("template:passport");
  });

  it("counts the larger of the number given and the names given, and treats one date as one day", async () => {
    const data = (await findPlanData(lydia, await created({ template: "trip", place: place(orlando), startDate: "2028-06-01", people: "2", names: "Ana\nBea\nCy\nDee", title: "Day out" })))!;
    expect(data.people).toHaveLength(5);
    expect(data.plan.expectedPeople).toBe(5);
    expect(data.plan).toMatchObject({ startDate: "2028-06-01", endDate: "2028-06-01", dateStatus: "fixed" });
    // "In or out" joins a trip's page for three or more.
    expect(data.site!.sections.find((section) => section.type === "rsvp")?.enabled).toBe(true);
  });

  it("finds another address when the readable one is taken", async () => {
    const first = (await findPlanData(lydia, await created({ template: "trip", place: place(orlando), title: "Beach week" })))!;
    const second = (await findPlanData(lydia, await created({ template: "trip", place: place(orlando), title: "Beach week" })))!;
    as(mallory);
    const third = (await findPlanData(mallory, await created({ template: "trip", place: place(orlando), title: "Beach Week!" })))!;
    expect([first.site!.slug, second.site!.slug, third.site!.slug]).toEqual(["beach-week", "beach-week-2", "beach-week-3"]);
    // A name that is a reserved word or says nothing still gets a real address.
    const reserved = (await findPlanData(mallory, await created({ template: "trip", place: place(orlando), title: "Plans" })))!;
    expect(reserved.site!.slug).toBe("plans-my-plan");
  });

  it("returns what was typed with a plain sentence when something is missing or wrong", async () => {
    const before = (await t.db.select().from(schema.plans)).length;
    const cases: [Record<string, string>, string, string][] = [
      [{ place: place(orlando) }, "template", "Choose what you are planning"],
      [{ template: "wedding", place: place(orlando) }, "template", "Choose what you are planning"],
      [{ template: "trip" }, "place", "Say where it is. A city is enough."],
      [{ template: "trip", place: "{not json" }, "place", "Choose the place from the list again."],
      [{ template: "trip", place: JSON.stringify({ kind: "city", name: "Nowhere", tz: "EST" }) }, "place", "Choose the place from the list again."],
      [{ template: "trip", place: place(orlando), startDate: "2028-02-10", endDate: "2028-02-01" }, "endDate", "The last day cannot be before the first."],
      [{ template: "trip", place: place(orlando), endDate: "2028-02-01" }, "startDate", "Choose the first day too."],
      [{ template: "trip", place: place(orlando), startDate: "2028-02-30" }, "startDate", "Use a real date in the form YYYY-MM-DD"],
      [{ template: "trip", place: place(orlando), people: "0" }, "people", "Count at least yourself"],
      [{ template: "trip", place: place(orlando), people: "a few" }, "people", "Enter how many people are coming"],
      [{ template: "trip", place: place(orlando), people: "2.5" }, "people", "Enter a whole number of people"],
      [{ template: "work", workMode: "remote", place: place(orlando) }, "workMode", "Say whether you are traveling or hosting"],
      [{ template: "trip", place: place(orlando), people: "100000" }, "people", "That is more people than a plan can hold"],
      [{ template: "trip", place: place(orlando), title: "x".repeat(121) }, "title", "Use a shorter name"],
    ];
    for (const [fields, field, message] of cases) {
      const result = await createPlan(null, form(fields));
      expect(result.ok, JSON.stringify(fields)).toBe(false);
      if (result.ok) continue;
      expect(result.error, JSON.stringify(fields)).toBe(message);
      expect(result.fieldErrors?.[field], field).toBeTruthy();
      expect(result.error).not.toContain("!");
      for (const [name, value] of Object.entries(fields)) expect(result.values?.[name]).toBe(value);
    }
    expect((await t.db.select().from(schema.plans)).length).toBe(before);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("needs someone signed in", async () => {
    session.user = null;
    await expect(createPlan(null, form({ template: "trip", place: place(orlando) }))).rejects.toThrow("REDIRECT /sign-in");
  });
});

describe("updatePlan", () => {
  let planId: string;
  const update = (fields: Record<string, string>) => updatePlan(null, form({ planId, ...fields }));

  beforeEach(async () => {
    planId = await created({ template: "family_event", placeText: "Somewhere warm", title: `Reunion ${newId()}` });
    refresh.mockClear();
  });

  it("changes only the fields that are sent", async () => {
    const before = await planRow(planId);
    expect(await update({ title: "Hartley reunion" })).toEqual({ ok: true, planId });
    const after = await planRow(planId);
    expect(after.title).toBe("Hartley reunion");
    const { title: _a, updatedAt: _b, ...restBefore } = before;
    const { title: _c, updatedAt: _d, ...restAfter } = after;
    void _a; void _b; void _c; void _d;
    expect(restAfter).toEqual(restBefore);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Sending nothing changes nothing and is not an error.
    expect(await update({})).toEqual({ ok: true, planId });
    expect((await planRow(planId)).title).toBe("Hartley reunion");
  });

  it("lets the share page's title follow the plan's until the person gives the page its own", async () => {
    const title = (await planRow(planId)).title;
    const site = async () => (await t.db.select().from(schema.sites).where(eq(schema.sites.planId, planId)))[0];
    expect((await site()).title).toBe(title);
    await update({ title: "Hartley reunion 2028" });
    expect((await site()).title).toBe("Hartley reunion 2028");

    await t.db.update(schema.sites).set({ title: "Come to the lake" }).where(eq(schema.sites.planId, planId));
    await update({ title: "Reunion (working title)" });
    expect((await site()).title).toBe("Come to the lake");
    // The address never changes by itself: people may already have the link.
    expect((await site()).slug).toMatch(/^reunion-/);
  });

  it("turns a draft into a dated plan, and moves the dates nobody has touched", async () => {
    const start = inDays(60);
    const end = inDays(64);
    expect(await update({ startDate: start, endDate: end })).toMatchObject({ ok: true });
    const data = (await findPlanData(lydia, planId))!;
    expect(data.plan).toMatchObject({ startDate: start, endDate: end, dateStatus: "fixed", replyDeadline: addDays(start, -21) });
    expect(data.site).toMatchObject({ replyDeadline: addDays(start, -21), unpublishOn: addDays(end, 30) });
    expect(data.tasks.find((task) => task.ruleKey === "template:dietary")?.dueDate).toBe(addDays(start, -14));

    // The person sets their own deadline and their own due date, and ticks a task off.
    await update({ replyDeadline: addDays(start, -10) });
    const dietary = data.tasks.find((task) => task.ruleKey === "template:dietary")!;
    const pickups = data.tasks.find((task) => task.ruleKey === "template:airport-pickups")!;
    const mail = data.tasks.find((task) => task.ruleKey === "template:hold-mail")!;
    await t.db.update(schema.tasks).set({ dueDate: addDays(start, -40) }).where(eq(schema.tasks.id, dietary.id));
    await t.db.update(schema.tasks).set({ done: true, doneAt: new Date() }).where(eq(schema.tasks.id, mail.id));

    // Then the whole plan moves a week later.
    await update({ startDate: addDays(start, 7), endDate: addDays(end, 7) });
    const moved = (await findPlanData(lydia, planId))!;
    expect(moved.plan.replyDeadline).toBe(addDays(start, -10));
    expect(moved.site?.replyDeadline).toBe(addDays(start, -10));
    expect(moved.site?.unpublishOn).toBe(addDays(end, 37));
    expect(moved.tasks.find((task) => task.id === dietary.id)?.dueDate).toBe(addDays(start, -40));
    expect(moved.tasks.find((task) => task.id === pickups.id)?.dueDate).toBe(addDays(start, 0));
    expect(moved.tasks.find((task) => task.id === mail.id)?.dueDate).toBe(addDays(start, -3));
  });

  it("goes back to a draft when the dates are cleared", async () => {
    await update({ startDate: inDays(60), endDate: inDays(64) });
    expect(await update({ startDate: "", endDate: "" })).toMatchObject({ ok: true });
    const data = (await findPlanData(lydia, planId))!;
    expect(data.plan).toMatchObject({ startDate: null, endDate: null, dateStatus: "undecided", replyDeadline: null });
    expect(data.site?.unpublishOn).toBeNull();
    expect(data.tasks.every((task) => task.dueDate === null)).toBe(true);
  });

  it("marks dates as tentative only when there are dates", async () => {
    expect(await update({ dateStatus: "tentative" })).toMatchObject({ ok: false, error: "Choose the dates first." });
    await update({ startDate: inDays(60), endDate: inDays(64) });
    expect(await update({ dateStatus: "tentative" })).toMatchObject({ ok: true });
    expect((await planRow(planId)).dateStatus).toBe("tentative");
    // New dates do not make tentative dates firm by themselves.
    await update({ startDate: inDays(70), endDate: inDays(74) });
    expect((await planRow(planId)).dateStatus).toBe("tentative");
    expect(await update({ startDate: inDays(80), endDate: inDays(70) })).toMatchObject({ ok: false, error: "The last day cannot be before the first." });
  });

  it("follows a new destination: its zone, and its clock on Home", async () => {
    const clock = async () => (await clocksOf(lydia.id)).find((row) => row.planId === planId);
    // "Somewhere warm" was used as typed, so there is no clock yet.
    expect(await clock()).toBeUndefined();

    await update({ place: place(lisbon), startDate: inDays(60), endDate: inDays(64) });
    expect(await planRow(planId)).toMatchObject({ tz: "Europe/Lisbon" });
    expect(await clock()).toMatchObject({ source: "plan", expiresOn: inDays(71) });
    expect((await clock())?.place).toEqual(lisbon);

    await update({ place: place(orlando) });
    expect((await planRow(planId)).tz).toBe("America/New_York");
    expect((await clock())?.place).toEqual(orlando);
    await update({ endDate: inDays(66), startDate: inDays(60) });
    expect((await clock())?.expiresOn).toBe(inDays(73));

    // Clearing the destination takes the clock away and falls back to the origin's zone.
    await update({ place: "", placeText: "" });
    expect(await planRow(planId)).toMatchObject({ destination: null, tz: "America/Chicago" });
    expect(await clock()).toBeUndefined();
  });

  it("gives a tool its Needs-you booking the first time it is switched on, and never a second", async () => {
    await update({ template: "work", workMode: "travel" });
    const kinds = async () => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.planId, planId))).map((booking) => booking.kind).sort();
    const before = await kinds();
    await t.db.delete(schema.bookings).where(eq(schema.bookings.planId, planId));

    expect(await update({ kindsInUse: "ride, flight" })).toMatchObject({ ok: true });
    // Stored in the fixed order whatever order was sent. Nothing new: both were already in use.
    expect((await planRow(planId)).kindsInUse).toEqual(["flight", "ride"]);
    expect(await kinds()).toEqual([]);

    await update({ kindsInUse: "flight,ride,car", kindsNotNeeded: "shipment" });
    expect(await planRow(planId)).toMatchObject({ kindsInUse: ["flight", "car", "ride"], kindsNotNeeded: ["shipment"] });
    expect(await kinds()).toEqual(["car"]);
    await update({ kindsInUse: "flight,ride" });
    await update({ kindsInUse: "flight,ride,car" });
    expect(await kinds()).toEqual(["car"]);

    expect(await update({ kindsInUse: "flight,submarine" })).toMatchObject({ ok: false });
    expect(await update({ kindsInUse: "flight,flight" })).toMatchObject({ ok: false });
    expect(await update({ kindsInUse: "" })).toMatchObject({ ok: true });
    expect((await planRow(planId)).kindsInUse).toEqual([]);
    expect(before).toHaveLength(6);
  });

  it("changes the kind of plan without touching what is in it", async () => {
    expect(await update({ template: "work" })).toMatchObject({ ok: false, error: "Say whether you are traveling or hosting." });
    expect(await update({ template: "work", workMode: "event" })).toMatchObject({ ok: true });
    expect(await planRow(planId)).toMatchObject({ template: "work", workMode: "event", kindsInUse: ["flight", "lodging", "car", "ride", "meal", "shipment"] });
    expect(await update({ workMode: "travel" })).toMatchObject({ ok: true });
    expect((await planRow(planId)).workMode).toBe("travel");
    // Leaving work drops the mode.
    await update({ template: "trip" });
    expect(await planRow(planId)).toMatchObject({ template: "trip", workMode: null });
    const data = (await findPlanData(lydia, planId))!;
    expect(data.bookings).toHaveLength(6);
    expect(data.site?.theme).toBe("invitation");
  });

  it("reads money, people, and the work fields, and clears what is sent empty", async () => {
    expect(await update({ budget: "$6,500", people: "12", currency: "USD", projectCode: " ACME-42 ", purpose: "Annual reunion" })).toMatchObject({ ok: true });
    expect(await planRow(planId)).toMatchObject({ budgetTotal: 650_000, expectedPeople: 12, projectCode: "ACME-42", purpose: "Annual reunion" });
    expect(await update({ budget: "", projectCode: "", purpose: "" })).toMatchObject({ ok: true });
    expect(await planRow(planId)).toMatchObject({ budgetTotal: null, projectCode: null, purpose: null, expectedPeople: 12 });

    expect(await update({ budget: "lots" })).toMatchObject({ ok: false, error: "Enter the budget as an amount, such as 2,500." });
    expect(await update({ budget: "-5" })).toMatchObject({ ok: false });
    expect(await update({ people: "0" })).toMatchObject({ ok: false, error: "Count at least yourself" });
    expect(await update({ people: "" })).toMatchObject({ ok: false, error: "Count at least yourself" });
    expect(await update({ people: "lots" })).toMatchObject({ ok: false, error: "Enter how many people are coming" });
    expect(await update({ template: "cruise" })).toMatchObject({ ok: false, error: "Choose what you are planning" });
    expect(await update({ currency: "dollars" })).toMatchObject({ ok: false });
    expect(await update({ title: "" })).toMatchObject({ ok: false, error: "Give the plan a name" });
    expect(await update({ place: "{broken" })).toMatchObject({ ok: false, error: "Choose the place from the list again." });
    expect(await planRow(planId)).toMatchObject({ budgetTotal: null, expectedPeople: 12 });
  });

  it("never changes another person's plan", async () => {
    const before = await planRow(planId);
    as(mallory);
    await expect(update({ title: "Mine now", startDate: inDays(5), endDate: inDays(6), place: place(lisbon) })).rejects.toThrow("NOT_FOUND");
    await expect(updatePlan(null, form({ planId: "", title: "x" }))).rejects.toThrow("NOT_FOUND");
    await expect(updatePlan(null, form({ title: "x" }))).rejects.toThrow("NOT_FOUND");
    expect(await planRow(planId)).toEqual(before);
    expect((await clocksOf(mallory.id)).some((clock) => clock.planId === planId)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("duplicatePlan", () => {
  it("starts the example again with its people, tasks and page, and nothing that belonged to the occasion", async () => {
    const original = (await findPlanData(lydia, (await seedExamplePlan(lydia)).planId!))!;
    const result = await duplicatePlan(null, form({ planId: original.plan.id }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.planId).not.toBe(original.plan.id);
    const copy = (await findPlanData(lydia, result.planId))!;

    expect(copy.plan).toMatchObject({
      title: "Hartley Family Christmas copy",
      template: "family_event",
      startDate: null,
      endDate: null,
      dateStatus: "undecided",
      replyDeadline: null,
      expectedPeople: 9,
      tz: "America/New_York",
      budgetTotal: 650_000,
      kindsInUse: original.plan.kindsInUse,
      // A copy of the example is a plan of the person's own.
      isExample: false,
      archivedAt: null,
    });
    expect(copy.plan.destination).toEqual(original.plan.destination);
    expect(copy.plan.origin).toEqual(original.plan.origin);

    // The same households and people, as new rows with new secret links.
    expect(copy.parties.map((party) => party.name)).toEqual(original.parties.map((party) => party.name));
    expect(copy.people.map((person) => person.name)).toEqual(original.people.map((person) => person.name));
    const oldIds = new Set([...original.parties, ...original.people, ...original.tasks, ...original.bookings].map((row) => row.id));
    expect([...copy.parties, ...copy.people, ...copy.tasks, ...copy.bookings].some((row) => oldIds.has(row.id))).toBe(false);
    const oldTokens = new Set(original.parties.map((party) => party.guestToken));
    expect(copy.parties.some((party) => oldTokens.has(party.guestToken))).toBe(false);
    // Each person is in the copy of their own household.
    for (const person of copy.people) {
      const was = original.people.find((candidate) => candidate.name === person.name)!;
      const household = copy.parties.find((party) => party.id === person.partyId)!;
      expect(household.name).toBe(original.parties.find((party) => party.id === was.partyId)!.name);
      // What is known about them carries over; what they said about last time does not.
      expect(person).toMatchObject({ ageGroup: was.ageGroup, childAge: was.childAge, dietaryTags: was.dietaryTags, canDrive: was.canDrive, email: was.email, role: was.role });
      expect(person).toMatchObject({ rsvpAnswers: {}, messageToHost: null, lodgingBookingId: null, room: null, guestToken: null });
      expect(person.rsvpStatus).toBe(person.role === "organizer" ? "yes" : "not_invited");
    }

    // The to-do list, nothing ticked, nothing claimed, no dates.
    expect(copy.tasks.map((task) => [task.title, task.kind, task.essential, task.ruleKey])).toEqual(original.tasks.map((task) => [task.title, task.kind, task.essential, task.ruleKey]));
    expect(copy.tasks.every((task) => !task.done && task.doneAt === null && task.dueDate === null && task.claimedByPersonId === null && task.bookingId === null)).toBe(true);
    const assigned = copy.tasks.find((task) => task.title === "Arrange airport pickups")!;
    expect(copy.people.find((person) => person.id === assigned.assigneePersonId)?.name).toBe("Rob Hartley");

    // Fresh "Needs you" bookings, and none of last time's travel, schedule or money.
    expect(copy.bookings.map((booking) => booking.status)).toEqual(Array(6).fill("needed"));
    expect(copy.bookings.every((booking) => booking.confirmationCode === null && booking.priceAmount === null)).toBe(true);
    expect([copy.arrivals, copy.items, copy.expenses, copy.settlements, copy.handoffs]).toEqual([[], [], [], [], []]);

    // The page keeps its look, sections and questions, as a draft at a new address.
    expect(copy.site).toMatchObject({
      status: "draft",
      slug: "hartley-family-christmas-copy",
      title: "Hartley Family Christmas copy",
      theme: original.site!.theme,
      accent: original.site!.accent,
      subtitle: original.site!.subtitle,
      hostLine: original.site!.hostLine,
      publishedAt: null,
      announcement: null,
      viewCount: 0,
      replyDeadline: null,
      unpublishOn: null,
    });
    expect(copy.site!.sections).toEqual(original.site!.sections);
    expect(copy.site!.rsvpQuestions).toEqual(original.site!.rsvpQuestions);

    // The original is exactly as it was.
    const untouched = (await findPlanData(lydia, original.plan.id))!;
    expect(untouched).toEqual(original);

    // Giving the copy dates brings the template's due dates back.
    await updatePlan(null, form({ planId: copy.plan.id, startDate: "2028-12-18", endDate: "2028-12-26" }));
    const dated = (await findPlanData(lydia, copy.plan.id))!;
    expect(dated.tasks.find((task) => task.ruleKey === "template:dietary")?.dueDate).toBe("2028-12-04");
    expect(dated.plan.replyDeadline).toBe("2028-11-27");
  });

  it("never copies another person's plan", async () => {
    const mine = await created({ template: "trip", place: place(orlando), title: "Private trip" });
    const count = (await t.db.select().from(schema.plans)).length;
    as(mallory);
    await expect(duplicatePlan(null, form({ planId: mine }))).rejects.toThrow("NOT_FOUND");
    expect((await t.db.select().from(schema.plans)).length).toBe(count);
  });
});

describe("archivePlan and restorePlan", () => {
  it("puts a plan away and brings it back, and its clock with it", async () => {
    const planId = await created({ template: "trip", place: place(lisbon), startDate: inDays(40), endDate: inDays(45), title: "Lisbon in spring" });
    const clock = async () => (await clocksOf(lydia.id)).find((row) => row.planId === planId);
    expect(await clock()).toBeDefined();

    expect(await archivePlan(null, form({ planId }))).toEqual({ ok: true, planId });
    const archived = await planRow(planId);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(await clock()).toBeUndefined();
    // Nothing else is lost.
    expect((await findPlanData(lydia, planId))!.bookings).toHaveLength(4);
    // Archiving twice keeps the first time.
    await archivePlan(null, form({ planId }));
    expect((await planRow(planId)).archivedAt).toEqual(archived.archivedAt);

    expect(await restorePlan(null, form({ planId }))).toEqual({ ok: true, planId });
    expect((await planRow(planId)).archivedAt).toBeNull();
    expect(await clock()).toMatchObject({ source: "plan", expiresOn: inDays(52) });
    expect(await restorePlan(null, form({ planId }))).toEqual({ ok: true, planId });
  });

  it("never archives or restores another person's plan", async () => {
    const planId = await created({ template: "trip", place: place(orlando), title: "Keep out" });
    as(mallory);
    await expect(archivePlan(null, form({ planId }))).rejects.toThrow("NOT_FOUND");
    expect((await planRow(planId)).archivedAt).toBeNull();
    await t.db.update(schema.plans).set({ archivedAt: new Date() }).where(eq(schema.plans.id, planId));
    await expect(restorePlan(null, form({ planId }))).rejects.toThrow("NOT_FOUND");
    expect((await planRow(planId)).archivedAt).not.toBeNull();
  });
});

describe("deletePlan", () => {
  it("deletes the plan with everything in it, its page and its clock, and nothing else", async () => {
    const keep = await created({ template: "trip", place: place(lisbon), startDate: inDays(30), endDate: inDays(33), title: "Keep me" });
    const planId = await created({ template: "family_event", place: place(austin), startDate: inDays(50), endDate: inDays(52), names: "Ana Lopez", title: "Delete me" });
    expect((await clocksOf(lydia.id)).some((clock) => clock.planId === planId)).toBe(true);

    expect(await deletePlan(null, form({ planId }))).toEqual({ ok: true });
    expect(await planRow(planId)).toBeUndefined();
    for (const table of [schema.parties, schema.people, schema.bookings, schema.tasks, schema.sites] as const) {
      expect(await t.db.select().from(table).where(eq(table.planId, planId))).toEqual([]);
    }
    expect((await clocksOf(lydia.id)).some((clock) => clock.planId === planId)).toBe(false);
    // The address is free again.
    expect(await t.db.select().from(schema.sites).where(eq(schema.sites.slug, "delete-me"))).toEqual([]);

    expect((await findPlanData(lydia, keep))!.bookings).toHaveLength(4);
    expect((await clocksOf(lydia.id)).some((clock) => clock.planId === keep)).toBe(true);
    expect((await t.db.select().from(schema.users).where(eq(schema.users.id, lydia.id)))[0].exampleState).toBe("seeded");
    // Deleting it again is the not-found page: it is gone.
    await expect(deletePlan(null, form({ planId }))).rejects.toThrow("NOT_FOUND");
  });

  it("never deletes another person's plan", async () => {
    const planId = await created({ template: "trip", place: place(orlando), title: "Not yours" });
    as(mallory);
    await expect(deletePlan(null, form({ planId }))).rejects.toThrow("NOT_FOUND");
    expect(await planRow(planId)).toBeDefined();
    expect((await findPlanData(lydia, planId))!.site).not.toBeNull();
  });
});

describe("removeExamplePlan", () => {
  it("removes the person's example in one go, remembers that, and leaves everyone else's alone", async () => {
    const mine = (await seedExamplePlan(lydia)).planId!;
    const theirs = (await seedExamplePlan(mallory)).planId!;
    const ownPlan = await created({ template: "trip", place: place(orlando), title: "My real trip" });
    expect((await clocksOf(lydia.id)).some((clock) => clock.planId === mine)).toBe(true);

    expect(await removeExamplePlan(null, new FormData())).toEqual({ ok: true });
    expect(await planRow(mine)).toBeUndefined();
    expect(await t.db.select().from(schema.people).where(eq(schema.people.planId, mine))).toEqual([]);
    expect(await t.db.select().from(schema.sites).where(eq(schema.sites.planId, mine))).toEqual([]);
    expect((await clocksOf(lydia.id)).some((clock) => clock.planId === mine)).toBe(false);
    const state = async (userId: string) => (await t.db.select().from(schema.users).where(eq(schema.users.id, userId)))[0].exampleState;
    expect(await state(lydia.id)).toBe("removed");

    // Her own plans stay, and so does Mallory's example.
    expect(await planRow(ownPlan)).toBeDefined();
    expect(await planRow(theirs)).toBeDefined();
    expect(await state(mallory.id)).toBe("seeded");
    expect((await findPlanData(mallory, theirs))!.people).toHaveLength(9);

    // A second tap is harmless, and signing up again would not bring it back.
    expect(await removeExamplePlan(null)).toEqual({ ok: true });
    expect(await seedExamplePlan(lydia)).toEqual({ planId: null, created: false });
  });

  it("is remembered when the example is deleted like any other plan", async () => {
    as(mallory);
    const theirs = (await seedExamplePlan(mallory)).planId!;
    expect(await deletePlan(null, form({ planId: theirs }))).toEqual({ ok: true });
    expect((await t.db.select().from(schema.users).where(eq(schema.users.id, mallory.id)))[0].exampleState).toBe("removed");
  });

  it("can be brought back, once", async () => {
    const first = (await seedExamplePlan(lydia)).planId!;
    await removeExamplePlan(null);
    expect(await planRow(first)).toBeUndefined();

    const back = await restoreExamplePlan(null);
    expect(back).toMatchObject({ ok: true });
    if (!back.ok) return;
    expect(back.planId).not.toBe(first);
    expect(await planRow(back.planId)).toMatchObject({ isExample: true, ownerId: lydia.id, title: "Hartley Family Christmas" });
    expect((await t.db.select().from(schema.users).where(eq(schema.users.id, lydia.id)))[0].exampleState).toBe("seeded");
    // Asking again gives the same one, not a second.
    expect(await restoreExamplePlan(null)).toEqual({ ok: true, planId: back.planId });
    expect((await t.db.select().from(schema.plans).where(eq(schema.plans.ownerId, lydia.id))).filter((plan) => plan.isExample)).toHaveLength(1);
  });
});
