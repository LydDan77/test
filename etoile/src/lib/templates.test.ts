import { describe, expect, it } from "vitest";
import { BOOKING_KINDS, SITE_SECTION_TYPES, rsvpQuestionsSchema, siteSectionsSchema, type PlaceRef } from "@/lib/domain";
import type { PeopleWords } from "@/lib/people/summary";
import { READINESS_COMPONENTS as READINESS_MODULE_COMPONENTS, TOOLS as READINESS_MODULE_TOOLS, type ReadinessConfig } from "@/lib/readiness";
import {
  KIND_FOR_TOOL,
  MAP_SECTION_AVAILABLE,
  PLAN_TOOLS,
  READINESS_COMPONENTS,
  READINESS_COMPONENT_FOR_KIND,
  SITE_THEME_ACCENTS,
  TEMPLATE_KEYS,
  TOOL_FOR_KIND,
  capitalize,
  countNoun,
  defaultReplyDeadline,
  isInternational,
  seededTasksFor,
  templateConfig,
  templateKey,
  type TemplateKey,
  type TemplatePlan,
} from "./templates";

const PLANS: Record<TemplateKey, TemplatePlan> = {
  family_event: { template: "family_event" },
  trip: { template: "trip" },
  work_travel: { template: "work", workMode: "travel" },
  work_event: { template: "work", workMode: "event" },
};

const chicago: PlaceRef = { kind: "home", name: "Chicago", countryCode: "US", tz: "America/Chicago" };
const orlando: PlaceRef = { kind: "city", name: "Orlando", countryCode: "US", tz: "America/New_York" };
const lisbon: PlaceRef = { kind: "city", name: "Lisbon", countryCode: "PT", tz: "Europe/Lisbon" };

const enabled = (plan: TemplatePlan) =>
  templateConfig(plan)
    .site.sections.filter((section) => section.enabled)
    .map((section) => section.type);

describe("templateKey", () => {
  it("folds the work mode into the template", () => {
    expect(templateKey({ template: "family_event" })).toBe("family_event");
    expect(templateKey({ template: "trip", workMode: null })).toBe("trip");
    expect(templateKey({ template: "work", workMode: "travel" })).toBe("work_travel");
    expect(templateKey({ template: "work", workMode: "event" })).toBe("work_event");
  });

  it("treats work without a mode as travel, and ignores a mode on other templates", () => {
    expect(templateKey({ template: "work" })).toBe("work_travel");
    expect(templateKey({ template: "work", workMode: null })).toBe("work_travel");
    expect(templateKey({ template: "trip", workMode: "event" })).toBe("trip");
    expect(templateConfig({ template: "trip", workMode: "event" }).workMode).toBeNull();
    expect(templateConfig({ template: "work" }).workMode).toBe("travel");
  });
});

describe("words", () => {
  it("calls people, households and replying what each template calls them", () => {
    const words = (key: TemplateKey) => templateConfig(PLANS[key]).words;
    expect(words("family_event")).toMatchObject({
      plan: "family get-together",
      person: "guest",
      people: "guests",
      party: "household",
      parties: "households",
      reply: { name: "RSVP", verb: "RSVP" },
      timeline: "Schedule",
      money: "Money",
    });
    expect(words("trip")).toMatchObject({ person: "traveler", people: "travelers", party: "group", parties: "groups", reply: { name: "in or out" }, timeline: "Schedule" });
    expect(words("work_travel")).toMatchObject({ people: "travelers", party: "team", parties: "teams", reply: { name: "registration" }, timeline: "Schedule" });
    expect(words("work_event")).toMatchObject({ person: "attendee", people: "attendees", party: "team", reply: { name: "registration", verb: "register" }, timeline: "Agenda" });
  });

  it("names the ten tools the way the build spec's vocabulary table does", () => {
    const tools = templateConfig(PLANS.family_event).words.tools;
    expect(PLAN_TOOLS.map((tool) => tools[tool])).toEqual([
      "Flights", "Stay", "Car", "Rides", "Food", "Send ahead", "Who's coming", "Schedule", "Money", "Share page",
    ]);
    // Only a work event's schedule is an agenda.
    expect(templateConfig(PLANS.work_event).words.tools.schedule).toBe("Agenda");
    expect(templateConfig(PLANS.work_travel).words.tools.schedule).toBe("Schedule");
  });

  it("never uses a word the build spec retired, and never an exclamation mark", () => {
    const retired = /briefing|readiness|lodging|rental car|itinerary|budget|expenses|mini-site|hand-off|ship ahead/i;
    for (const key of TEMPLATE_KEYS) {
      const { words } = templateConfig(PLANS[key]);
      const all = [words.plan, words.person, words.people, words.party, words.parties, words.reply.name, words.reply.verb, words.timeline, words.money, ...Object.values(words.tools)];
      for (const word of all) {
        expect(word, `${key}: ${word}`).not.toMatch(retired);
        expect(word).not.toContain("!");
      }
    }
  });

  it("has helpers for starting a sentence and counting", () => {
    expect(capitalize("guests")).toBe("Guests");
    expect(capitalize("RSVP")).toBe("RSVP");
    expect(capitalize("")).toBe("");
    const words = templateConfig(PLANS.family_event).words;
    expect(countNoun(1, words.person, words.people)).toBe("1 guest");
    expect(countNoun(9, words.person, words.people)).toBe("9 guests");
    expect(countNoun(0, words.party, words.parties)).toBe("0 households");
  });
});

describe("tools on by default", () => {
  it("switches on the booking kinds of product spec 3.2, in the fixed order", () => {
    expect(templateConfig(PLANS.family_event).kinds.on).toEqual(["flight", "lodging", "car", "ride", "meal", "shipment"]);
    expect(templateConfig(PLANS.trip).kinds.on).toEqual(["flight", "lodging", "car", "ride"]);
    expect(templateConfig(PLANS.work_travel).kinds.on).toEqual(["flight", "lodging", "ride"]);
    expect(templateConfig(PLANS.work_event).kinds.on).toEqual(["flight", "lodging", "ride", "meal", "shipment"]);
  });

  it("offers the rest switched off, and together they are all six kinds", () => {
    expect(templateConfig(PLANS.family_event).kinds.offered).toEqual([]);
    expect(templateConfig(PLANS.trip).kinds.offered).toEqual(["meal", "shipment"]);
    expect(templateConfig(PLANS.work_travel).kinds.offered).toEqual(["car", "meal", "shipment"]);
    expect(templateConfig(PLANS.work_event).kinds.offered).toEqual(["car"]);
    for (const key of TEMPLATE_KEYS) {
      const { on, offered } = templateConfig(PLANS[key]).kinds;
      expect([...on, ...offered].sort()).toEqual([...BOOKING_KINDS].sort());
    }
  });

  it("suggests Food and Send ahead for a trip of seven nights or more, and only then", () => {
    expect(templateConfig({ template: "trip", startDate: "2027-03-01", endDate: "2027-03-08" }).kinds.suggested).toEqual(["meal", "shipment"]);
    expect(templateConfig({ template: "trip", startDate: "2027-03-01", endDate: "2027-03-07" }).kinds.suggested).toEqual([]);
    expect(templateConfig({ template: "trip" }).kinds.suggested).toEqual([]);
    expect(templateConfig({ template: "work", workMode: "travel", startDate: "2027-03-01", endDate: "2027-03-20" }).kinds.suggested).toEqual([]);
  });

  it("maps every tool state from the kinds, and every kind to a tool and back", () => {
    for (const key of TEMPLATE_KEYS) {
      const config = templateConfig({ ...PLANS[key], expectedPeople: 4 });
      for (const kind of BOOKING_KINDS) {
        expect(config.tools[TOOL_FOR_KIND[kind]], `${key} ${kind}`).toBe(config.kinds.on.includes(kind) ? "on" : "offered");
        expect(KIND_FOR_TOOL[TOOL_FOR_KIND[kind]]).toBe(kind);
      }
      for (const tool of ["people", "schedule", "money", "page"] as const) expect(config.tools[tool]).toBe("on");
    }
  });

  it("hides Who's coming on a trip or work trip for one, and nowhere else", () => {
    expect(templateConfig({ template: "trip", expectedPeople: 1 }).tools.people).toBe("hidden");
    expect(templateConfig({ template: "trip", expectedPeople: 2 }).tools.people).toBe("on");
    expect(templateConfig({ template: "work", workMode: "travel", expectedPeople: 1 }).tools.people).toBe("hidden");
    // The usual count for a work trip is one, so with no count given it is hidden too.
    expect(templateConfig(PLANS.work_travel).tools.people).toBe("hidden");
    expect(templateConfig({ template: "work", workMode: "event", expectedPeople: 1 }).tools.people).toBe("on");
    expect(templateConfig({ template: "family_event", expectedPeople: 1 }).tools.people).toBe("on");
  });

  it("starts the who's-coming count where product spec 5.3 says", () => {
    expect(TEMPLATE_KEYS.map((key) => templateConfig(PLANS[key]).defaultPeopleCount)).toEqual([6, 2, 1, 10]);
  });
});

describe("seeded tasks", () => {
  it("seeds each template's tasks with keys that are unique within the template", () => {
    expect(templateConfig(PLANS.family_event).seededTasks.map((task) => task.title)).toEqual([
      "Ask about dietary needs", "Arrange airport pickups", "Confirm who cooks what", "Hold the mail",
    ]);
    expect(templateConfig(PLANS.work_event).seededTasks.map((task) => task.title)).toEqual(["Confirm approval", "Note the project code", "Submit expenses"]);
    for (const key of TEMPLATE_KEYS) {
      const keys = templateConfig(PLANS[key]).seededTasks.map((task) => task.ruleKey);
      expect(new Set(keys).size, key).toBe(keys.length);
      expect(keys.every((ruleKey) => ruleKey.startsWith("template:"))).toBe(true);
    }
  });

  it("asks about passports only when the trip leaves the country", () => {
    const abroad = seededTasksFor({ template: "trip", origin: chicago, destination: lisbon });
    const atHome = seededTasksFor({ template: "trip", origin: chicago, destination: orlando });
    const unknown = seededTasksFor({ template: "trip" });
    expect(abroad.map((task) => task.ruleKey)).toContain("template:passport");
    expect(atHome.map((task) => task.ruleKey)).not.toContain("template:passport");
    expect(unknown.map((task) => task.ruleKey)).not.toContain("template:passport");
    expect(isInternational({ origin: chicago, destination: lisbon })).toBe(true);
    expect(isInternational({ origin: chicago, destination: orlando })).toBe(false);
    expect(isInternational({ origin: chicago, destination: null })).toBe(false);
  });

  it("works out due dates from the plan's dates, and leaves them empty without dates", () => {
    const dated = seededTasksFor({ template: "work", workMode: "travel", startDate: "2027-01-12", endDate: "2027-01-15" });
    // "Submit expenses" is due seven days after return.
    expect(dated.find((task) => task.ruleKey === "template:submit-expenses")?.dueDate).toBe("2027-01-22");
    expect(dated.find((task) => task.ruleKey === "template:approval")?.dueDate).toBe("2026-12-29");
    expect(seededTasksFor(PLANS.family_event).every((task) => task.dueDate === null)).toBe(true);
    // A one-day plan has no end date of its own: "after return" counts from its only day.
    const oneDay = seededTasksFor({ template: "work", workMode: "travel", startDate: "2027-01-12", endDate: null });
    expect(oneDay.find((task) => task.ruleKey === "template:submit-expenses")?.dueDate).toBe("2027-01-19");
  });
});

describe("money", () => {
  it("splits by household for a family, evenly for a trip, and not at all for work", () => {
    expect(templateConfig(PLANS.family_event).money).toMatchObject({ mode: "shared", split: "by_party", reimbursable: false, projectCode: false, balances: true });
    expect(templateConfig(PLANS.trip).money).toMatchObject({ mode: "shared", split: "equal", balances: true });
    for (const key of ["work_travel", "work_event"] as const) {
      expect(templateConfig(PLANS[key]).money).toMatchObject({ mode: "expense_report", split: "none", reimbursable: true, projectCode: true, balances: false });
    }
  });

  it("shows the short category list to families and trips and the full one to work", () => {
    expect(templateConfig(PLANS.family_event).money.categories.map((category) => category.label)).toEqual([
      "Travel", "Lodging", "Getting around", "Food", "Activities", "Shopping", "Other",
    ]);
    const work = templateConfig(PLANS.work_event).money.categories;
    expect(work).toHaveLength(16);
    expect(work[0]).toEqual({ key: "airfare", label: "Airfare" });
    expect(work.at(-1)).toEqual({ key: "other", label: "Other" });
    expect(new Set(work.map((category) => category.key)).size).toBe(16);
  });
});

describe("the share page", () => {
  it("starts with the access and theme of product spec 3.2, and the theme's first accent", () => {
    expect(templateConfig(PLANS.family_event).site).toMatchObject({ access: "link", theme: "invitation", accent: "evergreen", whoIsComing: "first_names" });
    expect(templateConfig(PLANS.trip).site).toMatchObject({ access: "link", theme: "postcard", accent: "sea-blue" });
    expect(templateConfig(PLANS.work_travel).site).toMatchObject({ access: "passcode", theme: "agenda", accent: "signal-orange", whoIsComing: "hidden" });
    expect(templateConfig(PLANS.work_event).site).toMatchObject({ access: "passcode", theme: "agenda" });
    for (const accents of Object.values(SITE_THEME_ACCENTS)) expect(accents).toHaveLength(5);
  });

  it("switches on the sections of product spec 9.2, in order, with the host note under the cover", () => {
    expect(enabled({ template: "family_event" })).toEqual([
      "cover", "announcement", "details", "schedule", "rsvp", "stay", "getting_there", "who", "bring", "weather", "faq", "contact",
    ]);
    expect(enabled({ template: "trip", expectedPeople: 2 })).toEqual([
      "cover", "announcement", "details", "schedule", "stay", "getting_there", "who", "bring", "weather", "local_time", "contact",
    ]);
    expect(enabled({ template: "work", workMode: "travel" })).toEqual([
      "cover", "announcement", "details", "schedule", "stay", "getting_there", "local_time", "weather", "links", "contact",
    ]);
    expect(enabled({ template: "work", workMode: "event" })).toEqual([
      "cover", "announcement", "details", "schedule", "rsvp", "stay", "getting_there", "costs", "local_time", "weather", "faq", "links", "contact",
    ]);
  });

  it("adds in-or-out to a trip for three or more, and opens replies only when the section is on", () => {
    expect(enabled({ template: "trip", expectedPeople: 2 })).not.toContain("rsvp");
    expect(enabled({ template: "trip", expectedPeople: 3 })).toContain("rsvp");
    expect(templateConfig({ template: "trip", expectedPeople: 2 }).site.repliesOpen).toBe(false);
    expect(templateConfig({ template: "trip", expectedPeople: 3 }).site.repliesOpen).toBe(true);
    expect(templateConfig(PLANS.family_event).site.repliesOpen).toBe(true);
    expect(templateConfig(PLANS.work_travel).site.repliesOpen).toBe(false);
  });

  it("adds travel notes just above contact when the destination is abroad", () => {
    const abroad = enabled({ template: "family_event", origin: chicago, destination: lisbon });
    expect(abroad.slice(-2)).toEqual(["travel_notes", "contact"]);
    expect(enabled({ template: "family_event", origin: chicago, destination: orlando })).not.toContain("travel_notes");
  });

  it("keeps the map off until it ships", () => {
    expect(MAP_SECTION_AVAILABLE).toBe(false);
    for (const key of TEMPLATE_KEYS) expect(enabled(PLANS[key])).not.toContain("map");
  });

  it("lists every section of the catalog exactly once, in a shape the database accepts", () => {
    for (const key of TEMPLATE_KEYS) {
      const { sections } = templateConfig(PLANS[key]).site;
      expect(sections.map((section) => section.type).sort(), key).toEqual([...SITE_SECTION_TYPES].sort());
      expect(siteSectionsSchema.safeParse(sections).success).toBe(true);
      // Sections that are on come first, so the stored order is the display order.
      const firstOff = sections.findIndex((section) => !section.enabled);
      expect(sections.slice(firstOff).every((section) => !section.enabled)).toBe(true);
    }
  });

  it("keeps the guest list, arrivals, costs, links and photos for guests only", () => {
    for (const key of TEMPLATE_KEYS) {
      const visibility = Object.fromEntries(templateConfig(PLANS[key]).site.sections.map((section) => [section.type, section.visibility]));
      for (const type of ["who", "arrivals", "costs", "links", "photos"]) expect(visibility[type], `${key} ${type}`).toBe("guests");
      for (const type of ["cover", "details", "schedule", "rsvp", "weather", "contact"]) expect(visibility[type], `${key} ${type}`).toBe("everyone");
    }
    // A family gathering is usually at somebody's home: where to stay starts guests-only.
    const stay = (key: TemplateKey) => templateConfig(PLANS[key]).site.sections.find((section) => section.type === "stay")?.visibility;
    expect(stay("family_event")).toBe("guests");
    expect(stay("trip")).toBe("everyone");
    expect(stay("work_event")).toBe("everyone");
  });

  it("starts with reply questions the database accepts once they have ids", () => {
    for (const key of TEMPLATE_KEYS) {
      const questions = templateConfig(PLANS[key]).site.rsvpQuestions.map((question, index) => ({ ...question, id: `q${index}` }));
      expect(rsvpQuestionsSchema.safeParse(questions).success, key).toBe(true);
    }
    expect(templateConfig(PLANS.family_event).site.rsvpQuestions.map((question) => question.builtIn)).toEqual(["dietary", "arrival", "needs_ride"]);
    expect(templateConfig(PLANS.work_travel).site.rsvpQuestions).toEqual([]);
  });

  it("sets the reply deadline 21, 30 and 14 days ahead, and none for a work trip", () => {
    const dated = (plan: TemplatePlan) => defaultReplyDeadline({ ...plan, startDate: "2026-12-19", endDate: "2026-12-27" });
    expect(dated(PLANS.family_event)).toBe("2026-11-28");
    expect(dated(PLANS.trip)).toBe("2026-11-19");
    expect(dated(PLANS.work_event)).toBe("2026-12-05");
    expect(dated(PLANS.work_travel)).toBeNull();
    expect(defaultReplyDeadline(PLANS.family_event)).toBeNull();
    expect(TEMPLATE_KEYS.map((key) => templateConfig(PLANS[key]).replyDeadlineDaysBefore)).toEqual([21, 30, null, 14]);
  });
});

describe("readiness weights", () => {
  it("are the table of product spec 11.2", () => {
    const column = (key: TemplateKey) => READINESS_COMPONENTS.map((component) => templateConfig(PLANS[key]).weights[component]);
    //                                  there stay car rides meals ship people sched site tasks
    expect(column("family_event")).toEqual([15, 15, 10, 5, 10, 5, 15, 10, 5, 10]);
    expect(column("trip")).toEqual([25, 25, 10, 5, 5, 5, 5, 5, 5, 10]);
    expect(column("work_travel")).toEqual([30, 25, 5, 10, 5, 5, 0, 10, 0, 10]);
    expect(column("work_event")).toEqual([15, 15, 0, 5, 10, 5, 15, 15, 10, 10]);
  });

  it("add up to 100 for every template", () => {
    for (const key of TEMPLATE_KEYS) {
      const weights = templateConfig(PLANS[key]).weights;
      expect(Object.keys(weights).sort(), key).toEqual([...READINESS_COMPONENTS].sort());
      expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0), key).toBe(100);
    }
  });

  it("gives every booking kind a component", () => {
    expect(BOOKING_KINDS.map((kind) => READINESS_COMPONENT_FOR_KIND[kind])).toEqual(["gettingThere", "lodging", "car", "rides", "meals", "shipAhead"]);
  });
});

describe("what other modules take from a template", () => {
  it("is the config computeReadiness() takes, and its words are the people module's words", () => {
    for (const key of TEMPLATE_KEYS) {
      // These two assignments are the check: `npm run typecheck` fails if the shapes drift apart.
      const config: ReadinessConfig = templateConfig(PLANS[key]);
      const words: PeopleWords = templateConfig(PLANS[key]).words;
      expect(Object.keys(config.weights).sort()).toEqual([...READINESS_MODULE_COMPONENTS].sort());
      expect(config.words?.timeline).toBe(key === "work_event" ? "Agenda" : "Schedule");
      expect([words.person, words.people, words.party, words.parties].every((word) => word === word.toLowerCase())).toBe(true);
    }
    expect([...READINESS_COMPONENTS]).toEqual([...READINESS_MODULE_COMPONENTS]);
    expect([...PLAN_TOOLS]).toEqual([...READINESS_MODULE_TOOLS]);
  });
});

describe("templateConfig", () => {
  it("hands out fresh copies, so a caller that changes one cannot change the next", () => {
    const first = templateConfig(PLANS.family_event);
    first.kinds.on.pop();
    first.seededTasks[0].title = "changed";
    first.weights.car = 99;
    first.words.reply.name = "changed";
    first.site.sections[0].enabled = false;
    first.money.categories[0].label = "changed";
    const second = templateConfig(PLANS.family_event);
    expect(second.kinds.on).toHaveLength(6);
    expect(second.seededTasks[0].title).toBe("Ask about dietary needs");
    expect(second.weights.car).toBe(10);
    expect(second.words.reply.name).toBe("RSVP");
    expect(second.site.sections[0].enabled).toBe(true);
    expect(second.money.categories[0].label).toBe("Travel");
  });
});
