import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { emptyBookingDetails } from "@/lib/domain";
import { newId } from "@/lib/ids";
import { findExamplePlan, findInPlans, findPlanData, listPlans, loadPlanData } from "./queries";
import { seedExamplePlan } from "./seed";

const NOW = new Date("2026-11-26T21:30:00Z");
const chicago = { kind: "home" as const, name: "Chicago", tz: "America/Chicago" };
const lisbon = { kind: "city" as const, name: "Lisbon", region: "Lisbon District", countryCode: "PT", lat: 38.72509, lon: -9.1498, tz: "Europe/Lisbon" };

let t: TestDb;
let lydia: { id: string; home: typeof chicago };
let mallory: { id: string; home: typeof chicago };
let exampleId: string;
let malloryPlanId: string;

async function addUser(email: string, name: string) {
  const [row] = await t.db.insert(schema.users).values({ email, name, passwordHash: "x", home: chicago }).returning();
  return { id: row.id, home: chicago };
}

async function addPlan(ownerId: string, fields: Partial<typeof schema.plans.$inferInsert> & { title: string }) {
  const [plan] = await t.db
    .insert(schema.plans)
    .values({ ownerId, template: "trip", origin: chicago, tz: "America/Chicago", ...fields })
    .returning();
  return plan;
}

beforeAll(async () => {
  t = await createTestDb();
  lydia = await addUser("lydia@example.com", "Lydia Hartley");
  mallory = await addUser("mallory@example.com", "Mallory");
  exampleId = (await seedExamplePlan(lydia, { now: NOW })).planId!;

  // Somebody else's plan, with a person and a code that must never turn up in Lydia's searches.
  const theirs = await addPlan(mallory.id, { title: "Hartley surprise party", destination: lisbon, tz: lisbon.tz, startDate: "2026-12-01", endDate: "2026-12-03" });
  malloryPlanId = theirs.id;
  const [party] = await t.db.insert(schema.parties).values({ planId: theirs.id, name: "Mallory's group" }).returning();
  await t.db.insert(schema.people).values({ planId: theirs.id, partyId: party.id, name: "Ruth Imposter", email: "ruth@elsewhere.example" });
  await t.db.insert(schema.bookings).values({ planId: theirs.id, kind: "flight", status: "booked", title: "TP 202 EWR to LIS", confirmationCode: "KXLPQD", details: emptyBookingDetails("flight") });
  await t.db.insert(schema.sites).values({ planId: theirs.id, slug: "surprise", theme: "postcard", accent: "sea-blue", title: "Surprise" });
});
afterAll(() => t.close());

/** Counts the statements a piece of code sends, by watching drizzle's session prepare them. */
async function countQueries<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const session = (t.db as unknown as { session?: { prepareQuery?: unknown } }).session;
  if (!session || typeof session.prepareQuery !== "function") throw new Error("drizzle's session has changed shape: update countQueries()");
  const spy = vi.spyOn(session as { prepareQuery: (...args: unknown[]) => unknown }, "prepareQuery");
  try {
    const result = await run();
    return { result, queries: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

describe("loadPlanData", () => {
  it("returns the whole plan as plain rows, in one query", async () => {
    const { result: data, queries } = await countQueries(() => loadPlanData(lydia, exampleId));
    expect(queries).toBe(1);
    expect(Object.keys(data).sort()).toEqual(["arrivals", "bookings", "expenses", "handoffs", "items", "parties", "people", "plan", "settlements", "site", "tasks"]);
    expect(data.plan.id).toBe(exampleId);
    expect(data.plan.title).toBe("Hartley Family Christmas");
    expect([data.parties.length, data.people.length, data.arrivals.length, data.bookings.length, data.handoffs.length, data.items.length, data.tasks.length, data.expenses.length, data.settlements.length]).toEqual([3, 9, 6, 10, 0, 5, 11, 5, 0]);
    expect(data.site?.slug).toBe("hartley-christmas");
    // The plan is a plan row and nothing else: no lists hanging off it.
    expect("people" in data.plan).toBe(false);
    expect("itineraryItems" in data.plan).toBe(false);
  });

  it("gives back the same values as reading each table directly: dates as Dates, JSON as objects", async () => {
    const data = await loadPlanData(lydia, exampleId);
    const [plan] = await t.db.select().from(schema.plans).where(eq(schema.plans.id, exampleId));
    expect(data.plan).toEqual(plan);

    const people = await t.db.select().from(schema.people).where(eq(schema.people.planId, exampleId));
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(data.people)).toEqual(byId(people));
    const bookings = await t.db.select().from(schema.bookings).where(eq(schema.bookings.planId, exampleId));
    expect(byId(data.bookings)).toEqual(byId(bookings));
    const [site] = await t.db.select().from(schema.sites).where(eq(schema.sites.planId, exampleId));
    expect(data.site).toEqual(site);

    expect(data.plan.createdAt).toBeInstanceOf(Date);
    expect(data.bookings.find((booking) => booking.kind === "lodging")?.startsAt).toBeInstanceOf(Date);
    expect(data.people.find((person) => person.rsvpAt)?.rsvpAt).toBeInstanceOf(Date);
    expect(data.site?.publishedAt).toBeInstanceOf(Date);
    expect(data.plan.destination?.name).toBe("Orlando");
  });

  it("orders each list the way screens read it", async () => {
    const data = await loadPlanData(lydia, exampleId);
    expect(data.parties.map((party) => party.sortOrder)).toEqual([0, 1, 2]);
    expect(data.people.map((person) => person.name)).toEqual([...data.people.map((person) => person.name)].sort());
    expect(data.tasks.map((task) => task.sortOrder)).toEqual(data.tasks.map((_, index) => index));
    expect(data.items.map((item) => item.localDate)).toEqual([...data.items.map((item) => item.localDate)].sort());
    expect(data.expenses.map((expense) => expense.date)).toEqual([...data.expenses.map((expense) => expense.date)].sort());
    // Bookings by start time, the ones without a time last.
    const starts = data.bookings.map((booking) => booking.startsAt?.getTime() ?? Number.POSITIVE_INFINITY);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(data.bookings.at(-1)?.startsAt).toBeNull();
  });

  it("never loads another person's plan: not found, exactly as if it did not exist", async () => {
    await expect(loadPlanData(mallory, exampleId)).rejects.toThrow("NOT_FOUND");
    await expect(loadPlanData(lydia, malloryPlanId)).rejects.toThrow("NOT_FOUND");
    await expect(loadPlanData(lydia, newId())).rejects.toThrow("NOT_FOUND");
    expect(await findPlanData(mallory, exampleId)).toBeNull();
    expect(await findPlanData(lydia, malloryPlanId)).toBeNull();
  });

  it("refuses an id that is not an id without asking the database", async () => {
    for (const junk of ["", "x", "../etc/passwd", "' or 1=1 --", exampleId.toUpperCase(), `${exampleId} `]) {
      const { result, queries } = await countQueries(() => findPlanData(lydia, junk));
      expect(result, junk).toBeNull();
      expect(queries, junk).toBe(0);
    }
  });

  it("returns empty lists and no page for a bare plan", async () => {
    const bare = await addPlan(mallory.id, { title: "Bare" });
    const data = await loadPlanData(mallory, bare.id);
    expect(data).toMatchObject({ parties: [], people: [], arrivals: [], bookings: [], handoffs: [], items: [], tasks: [], expenses: [], settlements: [], site: null });
    await t.db.delete(schema.plans).where(eq(schema.plans.id, bare.id));
  });
});

describe("listPlans", () => {
  let ids: Record<string, string>;

  beforeAll(async () => {
    const add = async (title: string, fields: Partial<typeof schema.plans.$inferInsert>) => (await addPlan(lydia.id, { title, ...fields })).id;
    ids = {
      now: await add("Thanksgiving at ours", { startDate: "2026-11-25", endDate: "2026-11-29", expectedPeople: 12 }),
      soon: await add("Austin kickoff", { template: "work", workMode: "event", startDate: "2026-12-02", endDate: "2026-12-04", expectedPeople: 14 }),
      later: await add("Lisbon in spring", { destination: lisbon, tz: lisbon.tz, startDate: "2027-04-10", endDate: "2027-04-17", expectedPeople: 2 }),
      draft: await add("Somewhere warm", { expectedPeople: 4 }),
      past: await add("Lake weekend", { startDate: "2026-08-14", endDate: "2026-08-16" }),
      older: await add("Spring break", { startDate: "2026-03-20", endDate: "2026-03-27" }),
      archived: await add("Cancelled reunion", { startDate: "2026-12-10", endDate: "2026-12-12", archivedAt: new Date("2026-11-01T00:00:00Z") }),
    };
    // Lisbon has three people added against a count of two; it also has a draft page.
    const [party] = await t.db.insert(schema.parties).values({ planId: ids.later, name: "Us" }).returning();
    await t.db.insert(schema.people).values(["Ana", "Bea", "Cy"].map((name) => ({ planId: ids.later, partyId: party.id, name })));
    await t.db.insert(schema.sites).values({ planId: ids.later, slug: "lisbon-in-spring", theme: "postcard", accent: "sea-blue", title: "Lisbon in spring" });
  });

  it("lists the user's plans with name, place, dates, people and a derived status, in one query", async () => {
    const { result: plans, queries } = await countQueries(() => listPlans(lydia, { now: NOW }));
    expect(queries).toBe(1);
    expect(plans.map((plan) => [plan.title, plan.status])).toEqual([
      ["Thanksgiving at ours", "in_progress"],
      ["Austin kickoff", "upcoming"],
      ["Hartley Family Christmas", "upcoming"],
      ["Lisbon in spring", "upcoming"],
      ["Somewhere warm", "draft"],
      ["Lake weekend", "past"],
      ["Spring break", "past"],
      ["Cancelled reunion", "archived"],
    ]);

    const example = plans.find((plan) => plan.id === exampleId)!;
    expect(example).toMatchObject({
      title: "Hartley Family Christmas",
      template: "family_event",
      workMode: null,
      startDate: "2026-12-19",
      endDate: "2026-12-27",
      tz: "America/New_York",
      status: "upcoming",
      daysToGo: 23,
      people: 9,
      peopleAdded: 9,
      isExample: true,
      site: { slug: "hartley-christmas", status: "published" },
    });
    expect(example.destination).toMatchObject({ name: "Orlando", region: "Florida" });
  });

  it("counts people as the larger of the count given and the people added", async () => {
    const plans = await listPlans(lydia, { now: NOW });
    const byId = new Map(plans.map((plan) => [plan.id, plan]));
    expect(byId.get(ids.soon)).toMatchObject({ people: 14, peopleAdded: 0, site: null, workMode: "event" });
    expect(byId.get(ids.later)).toMatchObject({ people: 3, peopleAdded: 3, site: { slug: "lisbon-in-spring", status: "draft" } });
    expect(byId.get(ids.draft)).toMatchObject({ people: 4, startDate: null, endDate: null, daysToGo: null, destination: null });
    expect(byId.get(ids.now)?.daysToGo).toBe(-1);
  });

  it("derives the status from the time it is asked", async () => {
    const status = async (now: string) => Object.fromEntries((await listPlans(lydia, { now: new Date(now) })).map((plan) => [plan.id, plan.status]));
    const spring = await status("2027-04-12T12:00:00Z");
    expect(spring[ids.later]).toBe("in_progress");
    expect(spring[exampleId]).toBe("past");
    expect(spring[ids.draft]).toBe("draft");
    expect(spring[ids.archived]).toBe("archived");
    // With no time given it uses the present, and still answers.
    expect((await listPlans(lydia)).length).toBe(8);
  });

  it("lists nobody else's plans", async () => {
    const theirs = await listPlans(mallory, { now: NOW });
    expect(theirs.map((plan) => plan.title)).toEqual(["Hartley surprise party"]);
    const mine = await listPlans(lydia, { now: NOW });
    expect(mine.some((plan) => plan.id === malloryPlanId)).toBe(false);
    expect(await listPlans({ id: newId() }, { now: NOW })).toEqual([]);
  });
});

describe("findInPlans", () => {
  it("finds plans by name and by place", async () => {
    const byName = await findInPlans(lydia, "christmas");
    expect(byName).toEqual([{ type: "plan", planId: exampleId, planTitle: "Hartley Family Christmas", id: exampleId, label: "Hartley Family Christmas", detail: "Orlando" }]);
    const byPlace = await findInPlans(lydia, "orlando");
    expect(byPlace.map((hit) => [hit.type, hit.label])).toEqual([["plan", "Hartley Family Christmas"]]);
  });

  it("finds people by name, and by the address only the organizer knows", async () => {
    const dana = await findInPlans(lydia, "dana");
    expect(dana).toHaveLength(1);
    expect(dana[0]).toMatchObject({ type: "person", planId: exampleId, planTitle: "Hartley Family Christmas", label: "Dana Hartley", detail: "Dana and Chris" });
    expect((await findInPlans(lydia, "ruth.hartley@example")).map((hit) => hit.label)).toEqual(["Ruth Hartley"]);
  });

  it("finds a booking by its confirmation code, with or without the dashes and spaces people type", async () => {
    for (const typed of ["HA-4417K29", "ha4417k29", "HA 4417 K29", "4417k"]) {
      const hits = await findInPlans(lydia, typed);
      expect(hits.map((hit) => [hit.type, hit.label, hit.detail]), typed).toEqual([["booking", "Lakeside house", "HA-4417K29"]]);
    }
    expect((await findInPlans(lydia, "KXLPQD")).map((hit) => hit.label)).toEqual(["AS 1054 SEA to MCO"]);
  });

  it("puts plans first, then people, then bookings, in one query", async () => {
    const { result: hits, queries } = await countQueries(() => findInPlans(lydia, "hartley"));
    expect(queries).toBe(1);
    expect(hits[0]).toMatchObject({ type: "plan", label: "Hartley Family Christmas" });
    expect(hits.filter((hit) => hit.type === "person").map((hit) => hit.label)).toEqual([
      "Dana Hartley", "June Hartley", "Lydia Hartley", "Rob Hartley", "Ruth Hartley", "Theo Hartley", "Walt Hartley", "Wes Hartley",
    ]);
    expect(hits.map((hit) => hit.type)).toEqual(["plan", ...Array<string>(8).fill("person")]);
  });

  it("never finds anything in another person's plans", async () => {
    // Mallory has a plan called "Hartley surprise party", a "Ruth Imposter" and the same code KXLPQD.
    const hits = [...(await findInPlans(lydia, "hartley")), ...(await findInPlans(lydia, "ruth")), ...(await findInPlans(lydia, "KXLPQD")), ...(await findInPlans(lydia, "surprise")), ...(await findInPlans(lydia, "lisbon"))];
    expect(hits.some((hit) => hit.planId === malloryPlanId)).toBe(false);
    expect(hits.some((hit) => hit.label === "Ruth Imposter")).toBe(false);
    // And she finds only her own.
    const theirs = await findInPlans(mallory, "hartley");
    expect(theirs.map((hit) => hit.planId)).toEqual([malloryPlanId]);
    expect((await findInPlans(mallory, "KXLPQD")).map((hit) => hit.label)).toEqual(["TP 202 EWR to LIS"]);
    expect(await findInPlans(mallory, "lakeside")).toEqual([]);
  });

  it("treats what was typed as text, not as a pattern or as SQL", async () => {
    expect(await findInPlans(lydia, "%%")).toEqual([]);
    expect(await findInPlans(lydia, "__")).toEqual([]);
    expect(await findInPlans(lydia, "h_rtley")).toEqual([]);
    expect(await findInPlans(lydia, "'; drop table plans; --")).toEqual([]);
    expect(await findInPlans(lydia, "\\\\")).toEqual([]);
    expect((await listPlans(lydia, { now: NOW })).length).toBeGreaterThan(0);
  });

  it("finds nothing for under two characters, or for nothing at all", async () => {
    const { result, queries } = await countQueries(() => findInPlans(lydia, " h "));
    expect(result).toEqual([]);
    expect(queries).toBe(0);
    expect(await findInPlans(lydia, "")).toEqual([]);
    expect(await findInPlans(lydia, "zzzzqqqxj")).toEqual([]);
  });
});

describe("findExamplePlan", () => {
  it("finds the user's example and nobody else's", async () => {
    expect((await findExamplePlan(lydia))?.id).toBe(exampleId);
    expect(await findExamplePlan(mallory)).toBeNull();
  });
});
