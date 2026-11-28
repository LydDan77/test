import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stand-ins for the request: a cookie jar and request headers.
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
const requestHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => void jar.set(name, { value, options }),
  }),
  headers: async () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
}));

import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { PlanData } from "@/lib/plan-data";
import { createTestDb, type TestDb } from "@/db/testing";
import { verifyPassword } from "@/lib/auth/password";
import { emptyBookingDetails, parseBookingDetails, type PlaceRef } from "@/lib/domain";
import { newToken } from "@/lib/ids";
import { checkSitePasscode, findGuestByToken, isSiteUnlocked, setSitePasscode, toPublicBookingDetails, toPublicPlanData, visitorFor } from "./index";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => {
  jar.clear();
  requestHeaders.clear();
  vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
  requestHeaders.set("x-forwarded-for", "203.0.113.7");
});
afterEach(() => vi.unstubAllEnvs());

const home: PlaceRef = { kind: "home", name: "Seattle", tz: "America/Los_Angeles" };
let counter = 0;

type Made = { planId: string; siteId: string; slug: string; partyId: string; partyToken: string; personId: string; personToken: string };

async function makePage(options: { status?: "draft" | "published" | "unpublished"; access?: "link" | "passcode" } = {}): Promise<Made> {
  counter += 1;
  const [user] = await t.db.insert(schema.users).values({ email: `host-${counter}@example.com`, name: "Host", passwordHash: "x", home }).returning();
  const [plan] = await t.db.insert(schema.plans).values({ ownerId: user.id, template: "family_event", title: `Reunion ${counter}`, origin: home, tz: "America/New_York" }).returning();
  const [party] = await t.db.insert(schema.parties).values({ planId: plan.id, name: "The Hartleys" }).returning();
  const personToken = newToken();
  const [person] = await t.db.insert(schema.people).values({ planId: plan.id, partyId: party.id, name: "Theo", guestToken: personToken }).returning();
  const slug = `reunion-page-${counter}`;
  const [site] = await t.db
    .insert(schema.sites)
    .values({ planId: plan.id, slug, status: options.status ?? "published", access: options.access ?? "link", theme: "invitation", accent: "evergreen", title: `Reunion ${counter}` })
    .returning();
  return { planId: plan.id, siteId: site.id, slug, partyId: party.id, partyToken: party.guestToken, personId: person.id, personToken };
}

describe("findGuestByToken", () => {
  it("finds the household for its link and the person for their own link", async () => {
    const page = await makePage();
    const household = await findGuestByToken(page.slug, page.partyToken);
    expect(household).toMatchObject({ party: { id: page.partyId }, person: null, plan: { id: page.planId }, site: { slug: page.slug } });
    const own = await findGuestByToken(page.slug, page.personToken);
    expect(own).toMatchObject({ party: { id: page.partyId }, person: { id: page.personId, name: "Theo" } });
    // The page it returns never carries the passcode hash.
    expect(household!.site).not.toHaveProperty("passcodeHash");
  });

  it("gives null for a token of another plan: a link only opens its own page", async () => {
    const mine = await makePage();
    const theirs = await makePage();
    expect(await findGuestByToken(mine.slug, theirs.partyToken)).toBeNull();
    expect(await findGuestByToken(mine.slug, theirs.personToken)).toBeNull();
    expect(await findGuestByToken(theirs.slug, theirs.partyToken)).not.toBeNull();
  });

  it("gives null for junk, without asking the database about it", async () => {
    const page = await makePage();
    for (const token of ["", "short", "' or 1=1 --", page.partyToken.slice(0, -1), `${page.partyToken}x`, null, undefined, 42, ["x"]]) {
      expect(await findGuestByToken(page.slug, token), String(token)).toBeNull();
    }
    for (const slug of ["", "no-such-page", "Not A Slug", "plans", "../etc"]) expect(await findGuestByToken(slug, page.partyToken), slug).toBeNull();
  });

  it("gives null while the page is a draft or has been taken down", async () => {
    const draft = await makePage({ status: "draft" });
    const down = await makePage({ status: "unpublished" });
    expect(await findGuestByToken(draft.slug, draft.partyToken)).toBeNull();
    expect(await findGuestByToken(down.slug, down.partyToken)).toBeNull();
  });
});

describe("the page's passcode", () => {
  it("is stored as a light hash, never as typed, and turns the page to passcode access", async () => {
    const page = await makePage();
    expect(await setSitePasscode(page.planId, "  lake-house  ")).toEqual({ ok: true });
    const [site] = await t.db.select().from(schema.sites).where(eq(schema.sites.id, page.siteId));
    expect(site.access).toBe("passcode");
    // 16 MiB, not the 128 MiB of an account password: a guess at a public page must be cheap for the server.
    expect(site.passcodeHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(site.passcodeHash).not.toContain("lake-house");
    expect((await verifyPassword("lake-house", site.passcodeHash!)).ok).toBe(true);

    expect(await setSitePasscode(page.planId, "abc")).toEqual({ ok: false, reason: "too_short" });
    expect(await setSitePasscode(page.planId, "x".repeat(65))).toEqual({ ok: false, reason: "too_long" });
    expect(await setSitePasscode("no-such-plan", "lake-house")).toEqual({ ok: false, reason: "no_page" });

    expect(await setSitePasscode(page.planId, null)).toEqual({ ok: true });
    const [cleared] = await t.db.select().from(schema.sites).where(eq(schema.sites.id, page.siteId));
    expect(cleared).toMatchObject({ access: "link", passcodeHash: null });
  });

  it("lets a visitor in with the right passcode and remembers the browser for 30 days", async () => {
    const page = await makePage();
    await setSitePasscode(page.planId, "lake-house");
    const site = async () => (await t.db.select().from(schema.sites).where(eq(schema.sites.id, page.siteId)))[0];

    expect(await visitorFor(page.slug)).toEqual({ state: "locked", title: expect.stringMatching(/^Reunion/) });
    expect(await checkSitePasscode(page.slug, "not it")).toEqual({ ok: false, reason: "wrong" });
    expect(jar.size).toBe(0);
    expect(await isSiteUnlocked(await site())).toBe(false);

    expect(await checkSitePasscode(page.slug, " lake-house ")).toEqual({ ok: true });
    expect(await isSiteUnlocked(await site())).toBe(true);
    expect(await visitorFor(page.slug)).toMatchObject({ state: "open", viewer: "guest", party: null, person: null });

    // The cookie: HttpOnly, a 30-day life, and nothing in it but a time and a proof.
    const [[name, cookie]] = [...jar.entries()];
    expect(name).toBe(`etoile_page_${page.siteId}`);
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false });
    const expires = cookie.options!.expires as Date;
    expect(Math.abs(expires.getTime() - (Date.now() + 30 * 24 * 60 * 60 * 1000))).toBeLessThan(5000);
    expect(cookie.value).toMatch(/^\d{10}\.[A-Za-z0-9_-]{43}$/);
    expect(cookie.value).not.toContain("lake-house");
    expect((await site()).passcodeHash).not.toContain(cookie.value.split(".")[1]);
  });

  it("stops remembering when the passcode changes, when the 30 days are over, and for a forged cookie", async () => {
    const page = await makePage();
    await setSitePasscode(page.planId, "lake-house");
    const site = async () => (await t.db.select().from(schema.sites).where(eq(schema.sites.id, page.siteId)))[0];
    await checkSitePasscode(page.slug, "lake-house");
    const name = `etoile_page_${page.siteId}`;
    const good = jar.get(name)!.value;
    expect(await isSiteUnlocked(await site())).toBe(true);

    // 31 days later.
    expect(await isSiteUnlocked(await site(), new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(false);
    // A later expiry written into the cookie by hand does not verify.
    const [seconds, proof] = good.split(".");
    jar.set(name, { value: `${Number(seconds) + 86_400}.${proof}` });
    expect(await isSiteUnlocked(await site())).toBe(false);
    for (const forged of ["unlocked", "1", `${seconds}.`, `${seconds}.${"a".repeat(43)}`, `9999999999.${proof}`, `${seconds}.${proof}.extra`, ""]) {
      jar.set(name, { value: forged });
      expect(await isSiteUnlocked(await site()), forged).toBe(false);
    }
    // Another page's cookie is no use here.
    const other = await makePage();
    await setSitePasscode(other.planId, "lake-house");
    await checkSitePasscode(other.slug, "lake-house");
    jar.set(name, jar.get(`etoile_page_${other.siteId}`)!);
    expect(await isSiteUnlocked(await site())).toBe(false);

    // The organizer changes the passcode: everyone who had the old one is asked again.
    jar.set(name, { value: good });
    expect(await isSiteUnlocked(await site())).toBe(true);
    await setSitePasscode(page.planId, "new-passcode");
    expect(await isSiteUnlocked(await site())).toBe(false);
    expect(await visitorFor(page.slug)).toMatchObject({ state: "locked" });
  });

  it("limits tries per page and address, before any hashing", async () => {
    const page = await makePage();
    await setSitePasscode(page.planId, "lake-house");
    const answers: string[] = [];
    for (let i = 0; i < 12; i++) {
      const result = await checkSitePasscode(page.slug, `guess-${i}`);
      answers.push(result.ok ? "ok" : result.reason);
    }
    expect(answers).toEqual([...Array(10).fill("wrong"), "too_many_tries", "too_many_tries"]);
    // Even the right passcode has to wait now …
    const blocked = await checkSitePasscode(page.slug, "lake-house");
    expect(blocked).toMatchObject({ ok: false, reason: "too_many_tries" });
    if (!blocked.ok && blocked.reason === "too_many_tries") expect(blocked.retryAfterMs).toBeGreaterThan(9 * 60_000);
    // … but only from that address.
    requestHeaders.set("x-forwarded-for", "198.51.100.9");
    expect(await checkSitePasscode(page.slug, "lake-house")).toEqual({ ok: true });
  });

  it("limits tries per page from everywhere together, so many addresses cannot guess a short word", async () => {
    const page = await makePage();
    await setSitePasscode(page.planId, "lake-house");
    let wrong = 0;
    let refused = 0;
    // 80 tries, each from an address never seen before.
    for (let i = 0; i < 80; i++) {
      requestHeaders.set("x-forwarded-for", `192.0.2.${i + 1}`);
      const result = await checkSitePasscode(page.slug, `guess-${i}`);
      if (!result.ok && result.reason === "wrong") wrong++;
      if (!result.ok && result.reason === "too_many_tries") refused++;
    }
    expect([wrong, refused]).toEqual([60, 20]);
    // The same holds when no address is known at all.
    const second = await makePage();
    await setSitePasscode(second.planId, "lake-house");
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    const results: boolean[] = [];
    for (let i = 0; i < 62; i++) results.push((await checkSitePasscode(second.slug, `guess-${i}`)).ok === false);
    expect(await checkSitePasscode(second.slug, "lake-house")).toMatchObject({ ok: false, reason: "too_many_tries" });
    expect(results.every(Boolean)).toBe(true);
  });

  it("answers 'wrong' for a page that does not exist, is not published, or has no passcode", async () => {
    const open = await makePage();
    const draft = await makePage({ status: "draft" });
    await setSitePasscode(draft.planId, "lake-house");
    expect(await checkSitePasscode("no-such-page", "lake-house")).toEqual({ ok: false, reason: "wrong" });
    expect(await checkSitePasscode(open.slug, "lake-house")).toEqual({ ok: false, reason: "wrong" });
    expect(await checkSitePasscode(draft.slug, "lake-house")).toEqual({ ok: false, reason: "wrong" });
    expect(await checkSitePasscode("Not A Slug!", "lake-house")).toEqual({ ok: false, reason: "wrong" });
    expect(jar.size).toBe(0);
  });
});

describe("visitorFor", () => {
  it("opens an unlisted page to anyone with the address, as 'everyone', and to a personal link as a guest", async () => {
    const page = await makePage();
    expect(await visitorFor(page.slug)).toMatchObject({ state: "open", viewer: "everyone", party: null, person: null, site: { slug: page.slug } });
    expect(await visitorFor(page.slug, page.partyToken)).toMatchObject({ state: "open", viewer: "guest", party: { id: page.partyId }, person: null });
    expect(await visitorFor(page.slug, page.personToken)).toMatchObject({ state: "open", viewer: "guest", person: { id: page.personId } });
    const visitor = await visitorFor(page.slug);
    if (visitor.state === "open") expect(visitor.site).not.toHaveProperty("passcodeHash");
  });

  it("answers not found for a wrong token, a draft, and a page that does not exist", async () => {
    const page = await makePage();
    const draft = await makePage({ status: "draft" });
    expect(await visitorFor(page.slug, newToken())).toEqual({ state: "not_found" });
    expect(await visitorFor(page.slug, "junk")).toEqual({ state: "not_found" });
    expect(await visitorFor(draft.slug)).toEqual({ state: "not_found" });
    expect(await visitorFor(draft.slug, draft.partyToken)).toEqual({ state: "not_found" });
    expect(await visitorFor("no-such-page")).toEqual({ state: "not_found" });
  });

  it("keeps a passcode page shut until the passcode is entered; a personal link opens it anyway", async () => {
    const page = await makePage({ access: "passcode" });
    // Set to "passcode" with none stored yet: nobody can have entered it.
    expect(await visitorFor(page.slug)).toMatchObject({ state: "locked" });
    await setSitePasscode(page.planId, "lake-house");
    expect(await visitorFor(page.slug)).toMatchObject({ state: "locked" });
    // The locked answer carries the title and nothing else.
    expect(Object.keys(await visitorFor(page.slug)).sort()).toEqual(["state", "title"]);
    expect(await visitorFor(page.slug, page.partyToken)).toMatchObject({ state: "open", viewer: "guest" });
  });
});

describe("toPublicPlanData", () => {
  const SECRET = "SECRET";
  const house: PlaceRef = {
    kind: "lodging", name: "Lake Butler house", addressLines: ["8800 Lake Butler Blvd"], locality: "Windermere", region: "FL", countryCode: "US",
    tz: "America/New_York", phone: `${SECRET}-place-phone`, notes: `${SECRET}-place-notes`,
  };
  const airport: PlaceRef = { kind: "airport", name: "Orlando International", iata: "MCO", tz: "America/New_York", notes: "Terminal C for international arrivals." };

  async function fullPlan(): Promise<{ data: PlanData; made: Made }> {
    const made = await makePage();
    const p = made.planId;
    await t.db.update(schema.plans).set({ budgetTotal: 650000, projectCode: `${SECRET}-project`, purpose: `${SECRET}-purpose`, destination: house, startDate: "2026-12-19", endDate: "2026-12-27" }).where(eq(schema.plans.id, p));
    await t.db.update(schema.parties).set({ notes: `${SECRET}-party-notes`, origin: { ...home, notes: `${SECRET}-origin` } }).where(eq(schema.parties.id, made.partyId));
    await t.db
      .update(schema.people)
      .set({
        email: `${SECRET}-theo@example.com`, phone: `${SECRET}-phone`, privateNotes: `${SECRET}-private`, dietaryNote: `${SECRET}-diet`, accessNote: `${SECRET}-access`,
        messageToHost: `${SECRET}-message`, rsvpAnswers: { q1: `${SECRET}-answer` }, rsvpStatus: "yes", room: "Bunk room",
      })
      .where(eq(schema.people.id, made.personId));
    await t.db.insert(schema.people).values({ planId: p, partyId: made.partyId, name: "Mark", rsvpStatus: "maybe", email: `${SECRET}-mark@example.com` });

    const lodging = parseBookingDetails("lodging", {
      lodgingType: "rental", propertyName: "Lake Butler house", place: house, checkInDate: "2026-12-19", checkOutDate: "2026-12-27",
      accessNotes: `${SECRET}-door-code 4471`, contactName: `${SECRET}-contact`, contactPhone: `${SECRET}-contact-phone`,
      rooms: [{ label: "Bunk room", personIds: [made.personId] }], packagePolicy: { accepts: true, contact: `${SECRET}-package-contact` },
      roomBlock: { code: "HARTLEY26", bookBy: "2026-12-01" },
    });
    const flight = parseBookingDetails("flight", {
      search: { originIata: "SEA", destinationIata: "MCO", adults: 2 },
      segments: [{
        airlineIata: "AS", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO", departsAt: "2026-12-19T16:10:00Z", originTz: "America/Los_Angeles",
        arrivesAt: "2026-12-19T21:35:00Z", destinationTz: "America/New_York", seats: { [made.personId]: `${SECRET}-14C`.slice(0, 8) },
      }],
    });
    const meal = parseBookingDetails("meal", { mealType: "groceries", vendorName: "Publix", orderNumber: `${SECRET}-order`, total: { amount: 18450, currency: "USD" }, deliveryNote: `${SECRET}-gate`, list: [{ name: `${SECRET}-item` }], headcount: 11 });
    const shipment = parseBookingDetails("shipment", { recipientName: `${SECRET}-recipient`, labelLines: [`${SECRET}-label`] });
    if (!lodging.ok || !flight.ok || !meal.ok || !shipment.ok) throw new Error("fixtures must parse");
    const [flightBooking] = await t.db
      .insert(schema.bookings)
      .values([
        { planId: p, kind: "flight", status: "booked", title: "AS 1054 SEA to MCO", personIds: [made.personId], provider: `${SECRET}-provider`, confirmationCode: `${SECRET}-KQ7RTX`, priceAmount: 124800, priceCurrency: "USD", notes: `${SECRET}-booking-notes`, details: flight.details },
        { planId: p, kind: "lodging", status: "booked", title: "Lake Butler house", confirmationCode: `${SECRET}-HM123`, details: lodging.details },
        { planId: p, kind: "meal", status: "planned", title: "Groceries", details: meal.details },
        { planId: p, kind: "shipment", status: "looking", title: `${SECRET}-box of gifts`, details: shipment.details },
        { planId: p, kind: "car", status: "cancelled", title: `${SECRET}-cancelled car`, details: emptyBookingDetails("car") },
      ])
      .returning();
    await t.db.insert(schema.handoffs).values({ planId: p, bookingId: flightBooking.id, provider: "google_flights", url: `https://example.com/${SECRET}`, linkGrade: "observed" });
    await t.db.insert(schema.arrivals).values({ planId: p, partyId: made.partyId, personIds: [made.personId], direction: "arrival", mode: "flight", toPlace: airport, statusBy: `${SECRET}-status-by`, bags: 4 });
    await t.db.insert(schema.itineraryItems).values([
      { planId: p, type: "event", title: "Christmas Eve dinner", startTz: "America/New_York", localDate: "2026-12-24", place: house, visibility: "public" },
      { planId: p, type: "event", title: "Cousins' breakfast", startTz: "America/New_York", localDate: "2026-12-23", visibility: "guests" },
      { planId: p, type: "note", title: `${SECRET}-surprise party`, startTz: "America/New_York", localDate: "2026-12-22", visibility: "private" },
    ]);
    await t.db.insert(schema.tasks).values([
      { planId: p, kind: "bring", title: "Pies", quantity: 2, claimedByName: "Aunt Carol", notes: `${SECRET}-task-notes` },
      { planId: p, kind: "todo", title: `${SECRET}-hold the mail` },
    ]);
    await t.db.insert(schema.expenses).values({ planId: p, date: "2026-12-20", merchant: `${SECRET}-merchant`, category: "meals", amount: 18450, currency: "USD" });
    await t.db
      .update(schema.sites)
      .set({
        passcodeHash: `${SECRET}-passcode-hash`, viewCount: 12,
        sections: [
          { type: "cover", enabled: true, visibility: "everyone", content: {} },
          { type: "who", enabled: true, visibility: "guests", content: {} },
          { type: "arrivals", enabled: true, visibility: "everyone", content: {} }, // stored wrongly on purpose
          { type: "faq", enabled: false, visibility: "everyone", content: {} },
        ],
      })
      .where(eq(schema.sites.id, made.siteId));

    const one = async <T,>(rows: Promise<T[]>) => (await rows)[0];
    const data: PlanData = {
      plan: await one(t.db.select().from(schema.plans).where(eq(schema.plans.id, p))),
      parties: await t.db.select().from(schema.parties).where(eq(schema.parties.planId, p)),
      people: await t.db.select().from(schema.people).where(eq(schema.people.planId, p)),
      arrivals: await t.db.select().from(schema.arrivals).where(eq(schema.arrivals.planId, p)),
      bookings: await t.db.select().from(schema.bookings).where(eq(schema.bookings.planId, p)),
      handoffs: await t.db.select().from(schema.handoffs).where(eq(schema.handoffs.planId, p)),
      items: await t.db.select().from(schema.itineraryItems).where(eq(schema.itineraryItems.planId, p)),
      tasks: await t.db.select().from(schema.tasks).where(eq(schema.tasks.planId, p)),
      expenses: await t.db.select().from(schema.expenses).where(eq(schema.expenses.planId, p)),
      settlements: await t.db.select().from(schema.settlements).where(eq(schema.settlements.planId, p)),
      site: await one(t.db.select().from(schema.sites).where(eq(schema.sites.id, made.siteId))),
    };
    return { data, made };
  }

  it("lets none of the private fields through, for a guest or for anyone", async () => {
    const { data, made } = await fullPlan();
    // The fixture really is full of secrets, tokens included.
    const everything = JSON.stringify(data);
    expect(everything.match(/SECRET/g)!.length).toBeGreaterThan(30);
    expect(everything).toContain(made.partyToken);

    for (const viewer of ["guest", "everyone"] as const) {
      const text = JSON.stringify(toPublicPlanData(data, viewer));
      expect(text, viewer).not.toContain(SECRET);
      expect(text, viewer).not.toContain(made.partyToken);
      expect(text, viewer).not.toContain(made.personToken);
      for (const field of ["guestToken", "passcodeHash", "passwordHash", "confirmationCode", "priceAmount", "privateNotes", "accessNotes", "email", "phone", "budgetTotal", "ownerId", "expenses", "settlements", "handoffs", "orderNumber", "seats", "viewCount"]) {
        expect(text, `${viewer} ${field}`).not.toContain(`"${field}"`);
      }
    }
  });

  it("gives a guest the people, the arrivals and the guests' schedule; anyone else only counts and what is public", async () => {
    const { data, made } = await fullPlan();
    const guest = toPublicPlanData(data, "guest");
    const anyone = toPublicPlanData(data, "everyone");

    expect(guest.people.map((person) => person.name).sort()).toEqual(["Mark", "Theo"]);
    expect(guest.people.find((person) => person.id === made.personId)).toEqual({ id: made.personId, partyId: made.partyId, name: "Theo", role: "guest", ageGroup: "adult", team: null, jobTitle: null, room: "Bunk room", lodgingBookingId: null, rsvpStatus: "yes" });
    expect(guest.parties).toEqual([{ id: made.partyId, name: "The Hartleys", sortOrder: 0 }]);
    expect(guest.arrivals).toHaveLength(1);
    expect(guest.arrivals[0].toPlace).toMatchObject({ iata: "MCO", notes: "Terminal C for international arrivals." }); // an airport's notes are public
    expect(guest.items.map((item) => item.title).sort()).toEqual(["Christmas Eve dinner", "Cousins' breakfast"]);
    expect(guest.site.sections.map((section) => section.type)).toEqual(["cover", "who", "arrivals"]);

    expect(anyone.people).toEqual([]);
    expect(anyone.parties).toEqual([]);
    expect(anyone.arrivals).toEqual([]);
    expect(anyone.counts).toEqual({ people: 2, yes: 1, maybe: 1, no: 0 });
    expect(anyone.items.map((item) => item.title)).toEqual(["Christmas Eve dinner"]);
    // The arrivals section was stored as "everyone"; it is guests-only all the same. A switched-off section goes to nobody.
    expect(anyone.site.sections.map((section) => section.type)).toEqual(["cover"]);

    for (const view of [guest, anyone]) {
      expect(view.plan).toMatchObject({ title: expect.stringMatching(/^Reunion/), startDate: "2026-12-19", endDate: "2026-12-27", tz: "America/New_York" });
      expect(view.plan.destination).toEqual({ kind: "lodging", name: "Lake Butler house", addressLines: ["8800 Lake Butler Blvd"], locality: "Windermere", region: "FL", countryCode: "US", tz: "America/New_York" });
      expect(view.site).toMatchObject({ slug: made.slug, status: "published", theme: "invitation" });
      expect(view.bookings.map((booking) => booking.kind).sort()).toEqual(["flight", "lodging", "meal"]); // no shipment, no cancelled car
      expect(view.tasks).toEqual([{ id: expect.any(String), kind: "bring", title: "Pies", quantity: 2, claimedByPersonId: null, claimedByName: "Aunt Carol", done: false, sortOrder: 0 }]);
      const flight = view.bookings.find((booking) => booking.kind === "flight")!;
      expect(flight).toMatchObject({ title: "AS 1054 SEA to MCO", status: "booked" });
      expect(flight.details).toEqual({
        kind: "flight",
        segments: [{ airlineIata: "AS", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO", departsAt: "2026-12-19T16:10:00Z", originTz: "America/Los_Angeles", arrivesAt: "2026-12-19T21:35:00Z", destinationTz: "America/New_York" }],
      });
      const stay = view.bookings.find((booking) => booking.kind === "lodging")!;
      expect(stay.details).toMatchObject({ kind: "lodging", propertyName: "Lake Butler house", checkInDate: "2026-12-19", checkInTime: "16:00", roomBlock: { code: "HARTLEY26", bookBy: "2026-12-01" } });
    }
  });

  it("refuses a plan with no share page, and a shipment never has public details", async () => {
    const { data } = await fullPlan();
    expect(() => toPublicPlanData({ ...data, site: null }, "guest")).toThrow(/no share page/);
    expect(toPublicBookingDetails(emptyBookingDetails("shipment"))).toBeNull();
  });
});
