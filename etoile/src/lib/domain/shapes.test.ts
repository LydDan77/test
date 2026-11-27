import { describe, expect, it } from "vitest";
import {
  NO_SPLIT,
  announcementSchema,
  expenseSplitSchema,
  formatMoney,
  hasCoordinates,
  homePlaceFromTimeZone,
  instantOf,
  localDateSchema,
  localTimeSchema,
  localeDefaults,
  minorUnitDigits,
  moneySchema,
  parseMoneyInput,
  placeRefSchema,
  planStopsSchema,
  readSectionContent,
  regionOfLocale,
  rsvpAnswersSchema,
  rsvpQuestionSchema,
  rsvpQuestionsSchema,
  siteSectionSchema,
  siteSectionsSchema,
  splitMatchesAmount,
  timeZoneSchema,
  validateRsvpAnswers,
  zonedInstant,
  zonedInstantSchema,
  BOOKING_KINDS,
  EXPENSE_CATEGORIES,
  SITE_SECTION_TYPES,
  type RsvpQuestion,
} from "./index";

describe("PlaceRef", () => {
  it("accepts the smallest place and a full one", () => {
    expect(placeRefSchema.parse({ kind: "city", name: "Orlando", tz: "America/New_York" })).toEqual({ kind: "city", name: "Orlando", tz: "America/New_York" });
    const full = {
      kind: "airport", name: "Orlando International", addressLines: ["1 Jeff Fuqua Blvd"], locality: "Orlando", region: "FL",
      postalCode: "32827", countryCode: "US", lat: 28.4294, lon: -81.309, tz: "America/New_York", iata: "MCO",
      phone: "+1 407 825 2001", url: "https://flymco.com", notes: "Terminal C for international arrivals.",
    };
    expect(placeRefSchema.parse(full)).toEqual(full);
  });

  it("always needs a kind, a name and a zone", () => {
    expect(placeRefSchema.safeParse({ name: "Orlando", tz: "America/New_York" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ kind: "city", tz: "America/New_York" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ kind: "city", name: "  ", tz: "America/New_York" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ kind: "city", name: "Orlando" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ kind: "city", name: "Orlando", tz: "Eastern" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ kind: "planet", name: "Mars", tz: "UTC" }).success).toBe(false);
  });

  it("checks coordinates, country, airport code and links", () => {
    const base = { kind: "city", name: "Orlando", tz: "America/New_York" };
    expect(placeRefSchema.safeParse({ ...base, lat: 28.5 }).success).toBe(false); // latitude without longitude
    expect(placeRefSchema.safeParse({ ...base, lat: 91, lon: 0 }).success).toBe(false);
    expect(placeRefSchema.safeParse({ ...base, lat: 0, lon: 181 }).success).toBe(false);
    expect(placeRefSchema.safeParse({ ...base, countryCode: "USA" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ ...base, iata: "ORLANDO" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ ...base, url: "javascript:alert(1)" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ ...base, url: "ftp://example.com" }).success).toBe(false);
    expect(placeRefSchema.safeParse({ ...base, lat: 0, lon: 0 }).success).toBe(true); // zero is a coordinate
  });

  it("trims text and drops fields it does not know", () => {
    const parsed = placeRefSchema.parse({ kind: "city", name: "  Orlando ", tz: "America/New_York", secret: "x" });
    expect(parsed).toEqual({ kind: "city", name: "Orlando", tz: "America/New_York" });
  });

  it("builds a home place from a browser time zone", () => {
    expect(homePlaceFromTimeZone("America/Chicago")).toEqual({ kind: "home", name: "Chicago", tz: "America/Chicago" });
    expect(homePlaceFromTimeZone("America/Los_Angeles").name).toBe("Los Angeles");
    expect(homePlaceFromTimeZone("Asia/Calcutta")).toEqual({ kind: "home", name: "Kolkata", tz: "Asia/Calcutta" });
    expect(placeRefSchema.safeParse(homePlaceFromTimeZone("UTC")).success).toBe(true);
    expect(hasCoordinates(homePlaceFromTimeZone("UTC"))).toBe(false);
    expect(hasCoordinates({ kind: "city", name: "Null Island", tz: "UTC", lat: 0, lon: 0 })).toBe(true);
  });
});

describe("Money", () => {
  it("is whole minor units and an upper-case currency", () => {
    expect(moneySchema.parse({ amount: 123456, currency: "USD" })).toEqual({ amount: 123456, currency: "USD" });
    expect(moneySchema.parse({ amount: -500, currency: "EUR" }).amount).toBe(-500); // a refund
    expect(moneySchema.safeParse({ amount: 12.34, currency: "USD" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: "100", currency: "USD" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: 100, currency: "usd" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: 100, currency: "DOLLARS" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: 100 }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: 3_000_000_000, currency: "USD" }).success).toBe(false); // would not fit the column
  });

  it("formats and parses with the currency's own decimals", () => {
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(formatMoney({ amount: 123450, currency: "USD" })).toBe("$1,234.50");
    expect(formatMoney({ amount: 1235, currency: "JPY" })).toBe("¥1,235");
    expect(formatMoney({ amount: -500, currency: "USD" })).toBe("-$5.00");
    expect(parseMoneyInput("1,234.50", "USD")).toEqual({ amount: 123450, currency: "USD" });
    expect(parseMoneyInput("$12", "USD")).toEqual({ amount: 1200, currency: "USD" });
    expect(parseMoneyInput("12.5", "USD")).toEqual({ amount: 1250, currency: "USD" });
    expect(parseMoneyInput("19.99", "USD")).toEqual({ amount: 1999, currency: "USD" }); // no float drift
    expect(parseMoneyInput("1235", "JPY")).toEqual({ amount: 1235, currency: "JPY" });
    expect(parseMoneyInput("", "USD")).toBeNull();
    expect(parseMoneyInput("twelve", "USD")).toBeNull();
    expect(parseMoneyInput("1.2.3", "USD")).toBeNull();
  });
});

describe("ZonedInstant and the small shared pieces", () => {
  it("is a UTC instant plus its zone", () => {
    expect(zonedInstantSchema.parse({ at: "2026-12-19T22:41:00Z", tz: "America/Los_Angeles" })).toEqual({ at: "2026-12-19T22:41:00Z", tz: "America/Los_Angeles" });
    expect(zonedInstantSchema.safeParse({ at: "2026-12-19T22:41:00Z" }).success).toBe(false);
    expect(zonedInstantSchema.safeParse({ at: "2026-12-19T14:41:00-08:00", tz: "America/Los_Angeles" }).success).toBe(false);
    expect(zonedInstantSchema.safeParse({ at: "2026-12-19", tz: "America/Los_Angeles" }).success).toBe(false);
    expect(zonedInstantSchema.safeParse({ at: "2026-12-19T22:41:00Z", tz: "Pacific" }).success).toBe(false);
    const zi = zonedInstant(new Date("2026-12-19T22:41:00Z"), "America/Los_Angeles");
    expect(zi).toEqual({ at: "2026-12-19T22:41:00.000Z", tz: "America/Los_Angeles" });
    expect(zonedInstantSchema.safeParse(zi).success).toBe(true);
    expect(instantOf(zi).getTime()).toBe(Date.UTC(2026, 11, 19, 22, 41));
  });

  it("validates local dates, local times and zones", () => {
    expect(localDateSchema.safeParse("2026-12-19").success).toBe(true);
    expect(localDateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(localDateSchema.safeParse("19/12/2026").success).toBe(false);
    expect(localTimeSchema.safeParse("16:00").success).toBe(true);
    expect(localTimeSchema.safeParse("00:00").success).toBe(true);
    expect(localTimeSchema.safeParse("24:00").success).toBe(false);
    expect(localTimeSchema.safeParse("4:00").success).toBe(false);
    expect(timeZoneSchema.safeParse("Asia/Kolkata").success).toBe(true);
    expect(timeZoneSchema.safeParse("EST5EDT ").success).toBe(false);
  });
});

describe("plan stops", () => {
  const lisbon = { kind: "city", name: "Lisbon", tz: "Europe/Lisbon" };
  const porto = { kind: "city", name: "Porto", tz: "Europe/Lisbon" };

  it("accepts stops in travel order", () => {
    const stops = planStopsSchema.parse([
      { place: lisbon, arriveOn: "2027-05-01", leaveOn: "2027-05-04" },
      { place: porto, arriveOn: "2027-05-04", leaveOn: "2027-05-07" },
    ]);
    expect(stops).toHaveLength(2);
    expect(planStopsSchema.parse([])).toEqual([]);
  });

  it("rejects impossible stops", () => {
    expect(planStopsSchema.safeParse([{ place: lisbon, arriveOn: "2027-05-04", leaveOn: "2027-05-01" }]).success).toBe(false);
    expect(planStopsSchema.safeParse([
      { place: lisbon, arriveOn: "2027-05-01", leaveOn: "2027-05-04" },
      { place: porto, arriveOn: "2027-05-03", leaveOn: "2027-05-07" }, // overlaps the stop before
    ]).success).toBe(false);
    expect(planStopsSchema.safeParse([{ place: { name: "Lisbon" }, arriveOn: "2027-05-01", leaveOn: "2027-05-04" }]).success).toBe(false);
    expect(planStopsSchema.safeParse([{ place: lisbon, arriveOn: "May 1", leaveOn: "May 4" }]).success).toBe(false);
  });
});

describe("expense split", () => {
  it("accepts each method with what it needs", () => {
    expect(expenseSplitSchema.parse({ method: "none" })).toEqual(NO_SPLIT);
    expect(expenseSplitSchema.parse({ method: "equal", parts: [{ personId: "a" }, { personId: "b" }] }).parts).toHaveLength(2);
    expect(expenseSplitSchema.safeParse({ method: "by_party", parts: [{ personId: "a" }, { personId: "b" }] }).success).toBe(true);
    expect(expenseSplitSchema.safeParse({ method: "shares", parts: [{ personId: "a", share: 2 }, { personId: "b", share: 1 }] }).success).toBe(true);
    expect(expenseSplitSchema.safeParse({ method: "exact", parts: [{ personId: "a", amount: 6000 }, { personId: "b", amount: 4000 }] }).success).toBe(true);
  });

  it("rejects splits that cannot be worked out", () => {
    expect(expenseSplitSchema.safeParse({ method: "equal", parts: [] }).success).toBe(false); // nobody shares it
    expect(expenseSplitSchema.safeParse({ method: "none", parts: [{ personId: "a" }] }).success).toBe(false);
    expect(expenseSplitSchema.safeParse({ method: "shares", parts: [{ personId: "a" }] }).success).toBe(false);
    expect(expenseSplitSchema.safeParse({ method: "shares", parts: [{ personId: "a", share: 0 }] }).success).toBe(false);
    expect(expenseSplitSchema.safeParse({ method: "exact", parts: [{ personId: "a" }] }).success).toBe(false);
    expect(expenseSplitSchema.safeParse({ method: "exact", parts: [{ personId: "a", amount: 10.5 }] }).success).toBe(false);
    expect(expenseSplitSchema.safeParse({ method: "equal", parts: [{ personId: "a" }, { personId: "a" }] }).success).toBe(false); // twice
    expect(expenseSplitSchema.safeParse({ method: "thirds", parts: [{ personId: "a" }] }).success).toBe(false);
  });

  it("checks that exact parts add up", () => {
    const split = expenseSplitSchema.parse({ method: "exact", parts: [{ personId: "a", amount: 6000 }, { personId: "b", amount: 4000 }] });
    expect(splitMatchesAmount(split, 10000)).toBe(true);
    expect(splitMatchesAmount(split, 10001)).toBe(false);
    expect(splitMatchesAmount(NO_SPLIT, 999)).toBe(true);
  });
});

describe("site sections", () => {
  it("accepts a section and defaults its content", () => {
    expect(siteSectionSchema.parse({ type: "cover", enabled: true, visibility: "everyone" })).toEqual({ type: "cover", enabled: true, visibility: "everyone", content: {} });
    expect(siteSectionSchema.safeParse({ type: "faq", enabled: true, visibility: "guests", titleOverride: "Good to know", content: { items: [] } }).success).toBe(true);
  });

  it("rejects unknown types and visibilities", () => {
    expect(siteSectionSchema.safeParse({ type: "guestbook", enabled: true, visibility: "everyone" }).success).toBe(false);
    expect(siteSectionSchema.safeParse({ type: "cover", enabled: true, visibility: "public" }).success).toBe(false);
    expect(siteSectionSchema.safeParse({ type: "cover", enabled: "yes", visibility: "everyone" }).success).toBe(false);
    expect(siteSectionSchema.safeParse({ type: "cover", visibility: "everyone" }).success).toBe(false);
  });

  it("allows each section once, and up to three sections of your own", () => {
    const section = (type: string) => ({ type, enabled: true, visibility: "everyone" });
    expect(siteSectionsSchema.safeParse(SITE_SECTION_TYPES.map(section)).success).toBe(true);
    expect(siteSectionsSchema.safeParse([section("cover"), section("cover")]).success).toBe(false);
    expect(siteSectionsSchema.safeParse([section("notes"), section("notes"), section("notes")]).success).toBe(true);
    expect(siteSectionsSchema.safeParse([section("notes"), section("notes"), section("notes"), section("notes")]).success).toBe(false);
  });

  it("reads typed content without throwing on what does not fit", () => {
    expect(readSectionContent("faq", { items: [{ question: "Is there parking?", answer: "Yes, in the driveway." }] })?.items).toHaveLength(1);
    expect(readSectionContent("faq", {})).toEqual({ items: [] });
    expect(readSectionContent("faq", null)).toEqual({ items: [] });
    expect(readSectionContent("faq", { items: "none" })).toBeNull();
    expect(readSectionContent("links", { items: [{ label: "Slides", url: "javascript:alert(1)" }] })).toBeNull();
    expect(readSectionContent("links", { items: [{ label: "Slides", url: "https://example.com/slides" }] })?.items[0].label).toBe("Slides");
    expect(readSectionContent("contact", { people: [{ name: "Lydia", phone: "+1 612 555 0100" }] })?.people[0].name).toBe("Lydia");
    expect(readSectionContent("notes", { title: "Parking", text: "Use the driveway." })).toEqual({ title: "Parking", text: "Use the driveway." });
  });

  it("validates the pinned host note", () => {
    expect(announcementSchema.safeParse({ text: "Dinner moved to 7", postedAt: "2026-12-19T21:00:00Z" }).success).toBe(true);
    expect(announcementSchema.safeParse({ text: "", postedAt: "2026-12-19T21:00:00Z" }).success).toBe(false);
    expect(announcementSchema.safeParse({ text: "Dinner moved to 7" }).success).toBe(false);
  });
});

describe("reply questions and answers", () => {
  const questions: RsvpQuestion[] = rsvpQuestionsSchema.parse([
    { id: "q1", label: "Any dietary needs?", type: "multi", options: ["Vegetarian", "Vegan", "Gluten-free"], builtIn: "dietary" },
    { id: "q2", label: "Which dinner?", type: "choice", options: ["Friday", "Saturday"], required: true },
    { id: "q3", label: "Do you need a ride from the airport?", type: "yes_no", builtIn: "needs_ride" },
    { id: "q4", label: "How many pies can you bring?", type: "number" },
    { id: "q5", label: "Anything else?", type: "text" },
  ]);

  it("accepts well-formed questions and defaults required to false", () => {
    expect(questions).toHaveLength(5);
    expect(questions[0].required).toBe(false);
    expect(questions[1].required).toBe(true);
  });

  it("rejects malformed questions", () => {
    expect(rsvpQuestionSchema.safeParse({ id: "q", label: "Pick one", type: "choice" }).success).toBe(false); // no options
    expect(rsvpQuestionSchema.safeParse({ id: "q", label: "Pick one", type: "choice", options: ["Only"] }).success).toBe(false);
    expect(rsvpQuestionSchema.safeParse({ id: "q", label: "", type: "text" }).success).toBe(false);
    expect(rsvpQuestionSchema.safeParse({ id: "q", label: "Rate us", type: "stars" }).success).toBe(false);
    expect(rsvpQuestionSchema.safeParse({ id: "q", label: "Shoe size", type: "number", builtIn: "shoe_size" }).success).toBe(false);
    expect(rsvpQuestionsSchema.safeParse([{ id: "same", label: "A", type: "text" }, { id: "same", label: "B", type: "text" }]).success).toBe(false);
  });

  it("checks a guest's answers against the questions", () => {
    const good = validateRsvpAnswers(questions, { q1: ["Vegan", "Vegan"], q2: "Saturday", q3: "yes", q4: "2", q5: "  See you there  ", extra: "ignored" });
    expect(good).toEqual({ ok: true, answers: { q1: ["Vegan"], q2: "Saturday", q3: true, q4: 2, q5: "See you there" } });
    if (good.ok) expect(rsvpAnswersSchema.safeParse(good.answers).success).toBe(true);

    // Optional questions may be skipped; the required one may not.
    expect(validateRsvpAnswers(questions, { q2: "Friday" })).toEqual({ ok: true, answers: { q2: "Friday" } });
    expect(validateRsvpAnswers(questions, {})).toEqual({ ok: false, errors: { q2: "Please answer this one" } });
    expect(validateRsvpAnswers(questions, null)).toMatchObject({ ok: false });
  });

  it("refuses answers that were not on offer", () => {
    const bad = validateRsvpAnswers(questions, { q1: ["Carnivore"], q2: "Sunday", q3: "maybe", q4: "lots" });
    expect(bad).toEqual({
      ok: false,
      errors: { q1: "Pick from the choices", q2: "Pick one of the choices", q3: "Answer yes or no", q4: "Enter a number" },
    });
  });
});

describe("locale defaults", () => {
  it("guesses units and currency from the browser's language", () => {
    expect(localeDefaults("en-US")).toEqual({ units: "imperial", currency: "USD" });
    expect(localeDefaults("en-GB")).toEqual({ units: "metric", currency: "GBP" });
    expect(localeDefaults("fr-CA")).toEqual({ units: "metric", currency: "CAD" });
    expect(localeDefaults("de-DE")).toEqual({ units: "metric", currency: "EUR" });
    expect(localeDefaults("ja-JP")).toEqual({ units: "metric", currency: "JPY" });
    expect(localeDefaults("en")).toEqual({ units: "imperial", currency: "USD" }); // "en" alone is read as en-US
    expect(regionOfLocale("es-MX")).toBe("MX");
  });

  it("falls back safely on junk", () => {
    for (const junk of [null, undefined, "", "not a locale!!", "xx-YY-zz-123456789"]) {
      const result = localeDefaults(junk);
      expect(["imperial", "metric"]).toContain(result.units);
      expect(result.currency).toMatch(/^[A-Z]{3}$/);
    }
    expect(localeDefaults(null)).toEqual({ units: "imperial", currency: "USD" });
  });
});

describe("fixed lists", () => {
  it("keeps the six booking kinds in the order people see them", () => {
    expect(BOOKING_KINDS).toEqual(["flight", "lodging", "car", "ride", "meal", "shipment"]);
  });

  it("has no duplicates in any list", () => {
    expect(new Set(EXPENSE_CATEGORIES).size).toBe(EXPENSE_CATEGORIES.length);
    expect(new Set(SITE_SECTION_TYPES).size).toBe(SITE_SECTION_TYPES.length);
    expect(SITE_SECTION_TYPES).toHaveLength(21);
  });
});
