// What a plan's template decides (product spec 3.2, 9.1, 9.2, 10.4 and 11.2, with the words of
// BUILD-SPEC section 3). Structure is identical across templates; these are the only differences:
// the words people see, which tools start switched on, the tasks a new plan starts with, how
// money is shared, how the share page starts out, and what counts toward "what's left".
//
// Pure, with no server-only imports: usable in server code, client components and tests.
//
//   const t = templateConfig(plan);
//   t.words.people   // "guests"
//   t.kinds.on       // ["flight", "lodging", "car", "ride", "meal", "shipment"]
//   t.weights.car    // 10
//
// A TemplateConfig is also what computeReadiness() and toolStates() of "@/lib/readiness" take as
// their `config` (it has the `weights` and `words` they read), and its `words` fit the
// PeopleWords of "@/lib/people": templates.test.ts holds both to that.

import type { Plan } from "@/db/schema";
import type {
  BookingKind,
  ExpenseCategory,
  PlanTemplate,
  RsvpQuestion,
  SectionVisibility,
  SiteAccess,
  SiteSection,
  SiteSectionType,
  SiteTheme,
  SplitMethod,
  WhoIsComing,
  WorkMode,
} from "@/lib/domain";
import { BOOKING_KINDS, SITE_SECTION_TYPES } from "@/lib/domain/enums";
import { addDays, nightsBetween } from "@/lib/time/dates";

// --- the four variants ----------------------------------------------------------------------------

/** A template with its work mode folded in: the four columns of the product spec's tables. */
export const TEMPLATE_KEYS = ["family_event", "trip", "work_travel", "work_event"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** The part of a plan that templateConfig() reads. A whole Plan row fits. */
export type TemplatePlan = Pick<Plan, "template"> &
  Partial<Pick<Plan, "workMode" | "expectedPeople" | "startDate" | "endDate" | "destination" | "origin">>;

/** Work without a mode is treated as travel: the person's own trip is the common case. */
export function templateKey(plan: Pick<TemplatePlan, "template" | "workMode">): TemplateKey {
  if (plan.template === "work") return plan.workMode === "event" ? "work_event" : "work_travel";
  return plan.template;
}

// --- the ten tools --------------------------------------------------------------------------------

/** The ten tools of a plan, in the order they appear. Each is its own screen at /plans/[planId]/<tool>. */
export const PLAN_TOOLS = [
  "flights", "stay", "car", "rides", "food", "send-ahead", "people", "schedule", "money", "page",
] as const;
export type PlanTool = (typeof PLAN_TOOLS)[number];

/** The booking tool for each booking kind, and back. */
export const TOOL_FOR_KIND = {
  flight: "flights",
  lodging: "stay",
  car: "car",
  ride: "rides",
  meal: "food",
  shipment: "send-ahead",
} as const satisfies Record<BookingKind, PlanTool>;

export const KIND_FOR_TOOL: Partial<Record<PlanTool, BookingKind>> = {
  flights: "flight",
  stay: "lodging",
  car: "car",
  rides: "ride",
  food: "meal",
  "send-ahead": "shipment",
};

/**
 * - "on": part of the plan from the start.
 * - "offered": there, switched off; the plan may suggest it (see `kinds.suggested`).
 * - "hidden": not shown until it is needed (the people tool on a trip for one).
 */
export type ToolDefault = "on" | "offered" | "hidden";

// --- words ----------------------------------------------------------------------------------------

export type TemplateWords = {
  /** What this kind of plan is called: "family get-together", "trip", "work trip", "work event". */
  plan: string;
  /** What someone in the plan is called, lower case for use inside a sentence: "guest". */
  person: string;
  /** More than one of them: "guests", "travelers", "attendees". */
  people: string;
  /** What people who travel and reply together are called: "household", "group", "team". */
  party: string;
  /** More than one: "households", "groups", "teams". */
  parties: string;
  /**
   * What replying is called. `name` is the thing ("RSVP", "in or out", "registration"); `verb`
   * completes "Ask them to …" ("RSVP", "say if they're in", "register").
   */
  reply: { name: string; verb: string };
  /** What the timeline is called, as its tool is named: "Schedule", or "Agenda" for a work event. */
  timeline: string;
  /**
   * What the money tool is called. Always "Money": the build spec retired "budget" and
   * "expenses" as names. How money behaves per template is in `money`.
   */
  money: string;
  /** The name of each tool as people see it, sentence case: "Flights", "Who's coming", "Share page". */
  tools: Record<PlanTool, string>;
};

/** "guests" to "Guests", to start a sentence or a heading. Leaves "RSVP" alone. */
export function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

/** "1 guest", "9 guests": countNoun(9, words.person, words.people). */
export function countNoun(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// --- tasks ----------------------------------------------------------------------------------------

export type SeededTask = {
  /** Stable key, stored in tasks.ruleKey so the task is never created twice for a plan. */
  ruleKey: string;
  title: string;
  /** Counts toward "what's left". */
  essential: boolean;
  /** Only for a plan whose destination is in another country than its origin. */
  onlyWhen?: "international";
  /** When it is due, in days from the plan's first day ("start") or last day ("end"). */
  due?: { from: "start" | "end"; days: number };
};

/** A seeded task with its due date worked out for one plan. */
export type TaskSeed = Pick<SeededTask, "ruleKey" | "title" | "essential"> & { dueDate: string | null };

// --- money ----------------------------------------------------------------------------------------

export type MoneyDefaults = {
  /**
   * "shared": costs are shared among the people and settled up at the end (family, trip).
   * "expense_report": costs are claimed back from a company (work).
   */
  mode: "shared" | "expense_report";
  /** How a new expense is split. */
  split: SplitMethod;
  /** New expenses start as reimbursable. */
  reimbursable: boolean;
  /** Show the project code on the plan and on each expense. */
  projectCode: boolean;
  /** Show who owes whom and "settle up". */
  balances: boolean;
  /** The categories offered, in order, with the word people see. Keys are the fixed export list. */
  categories: { key: ExpenseCategory; label: string }[];
};

// --- the share page -------------------------------------------------------------------------------

/** Each theme's five accents, chosen in advance (product spec 9.4). The first is the default. */
export const SITE_THEME_ACCENTS = {
  invitation: ["evergreen", "ink-blue", "burgundy", "ochre", "charcoal"],
  postcard: ["sea-blue", "coral", "palm-green", "sand", "slate"],
  agenda: ["signal-orange", "cobalt", "teal", "plum", "graphite"],
  departures: ["amber", "ice", "lime", "coral", "white"],
} as const satisfies Record<SiteTheme, readonly string[]>;

/**
 * The map section stays off until the map ships (BUILD-SPEC section 3, item 6: maps are optional
 * polish and nothing may depend on them). Flip this when it does and Trip and Work event get it.
 */
export const MAP_SECTION_AVAILABLE = false;

export type SiteDefaults = {
  /** "link": anyone with the link. "passcode": the link and a shared passcode (work). */
  access: SiteAccess;
  theme: SiteTheme;
  accent: string;
  /** Guests' names: first names to guests for family and trips, hidden for work. */
  whoIsComing: WhoIsComing;
  /** Whether the page takes replies from the start. */
  repliesOpen: boolean;
  replyByParty: boolean;
  allowMaybe: boolean;
  /**
   * Every section of the catalog: the ones on by default first, in the order of product spec
   * 9.2, then the rest switched off. Ready to store in sites.sections.
   */
  sections: SiteSection[];
  /** The reply questions a new page starts with. Give each an id (newId()) before storing. */
  rsvpQuestions: Omit<RsvpQuestion, "id">[];
};

// --- readiness ------------------------------------------------------------------------------------

/**
 * The ten things that count toward how ready a plan is (product spec 11.2), in table order.
 * The same names "@/lib/readiness" uses.
 */
export const READINESS_COMPONENTS = [
  "gettingThere", "lodging", "car", "rides", "meals", "shipAhead", "people", "schedule", "site", "tasks",
] as const;
export type ReadinessComponent = (typeof READINESS_COMPONENTS)[number];

/** Points per component. Each template's weights add up to 100. */
export type ReadinessWeights = Record<ReadinessComponent, number>;

/** The readiness component each booking kind feeds. */
export const READINESS_COMPONENT_FOR_KIND = {
  flight: "gettingThere",
  lodging: "lodging",
  car: "car",
  ride: "rides",
  meal: "meals",
  shipment: "shipAhead",
} as const satisfies Record<BookingKind, ReadinessComponent>;

// --- the whole thing ------------------------------------------------------------------------------

export type TemplateConfig = {
  key: TemplateKey;
  template: PlanTemplate;
  workMode: WorkMode | null;
  words: TemplateWords;
  /** The count the new-plan flow starts with in "Who's coming?". */
  defaultPeopleCount: number;
  kinds: {
    /** Booking kinds a new plan uses (plans.kindsInUse), in the fixed order. */
    on: BookingKind[];
    /** Kinds that are there but switched off. */
    offered: BookingKind[];
    /** Offered kinds worth suggesting for this plan: Food and Send ahead on a trip of 7 nights or more. */
    suggested: BookingKind[];
  };
  /** Where each of the ten tools starts. */
  tools: Record<PlanTool, ToolDefault>;
  /** The tasks a new plan starts with. seededTasksFor() filters them and works out due dates. */
  seededTasks: SeededTask[];
  money: MoneyDefaults;
  /** The reply deadline, as days before the first day; null when the template sets none. */
  replyDeadlineDaysBefore: number | null;
  site: SiteDefaults;
  /** The readiness weights of product spec 11.2 for this template. They add up to 100. */
  weights: ReadinessWeights;
};

// --- data -----------------------------------------------------------------------------------------

const TOOL_NAMES: Record<PlanTool, string> = {
  flights: "Flights",
  stay: "Stay",
  car: "Car",
  rides: "Rides",
  food: "Food",
  "send-ahead": "Send ahead",
  people: "Who's coming",
  schedule: "Schedule",
  money: "Money",
  page: "Share page",
};

type Words = Omit<TemplateWords, "tools" | "money">;

const WORDS: Record<TemplateKey, Words> = {
  family_event: {
    plan: "family get-together",
    person: "guest",
    people: "guests",
    party: "household",
    parties: "households",
    reply: { name: "RSVP", verb: "RSVP" },
    timeline: "Schedule",
  },
  trip: {
    plan: "trip",
    person: "traveler",
    people: "travelers",
    party: "group",
    parties: "groups",
    reply: { name: "in or out", verb: "say if they're in" },
    timeline: "Schedule",
  },
  work_travel: {
    plan: "work trip",
    person: "traveler",
    people: "travelers",
    party: "team",
    parties: "teams",
    reply: { name: "registration", verb: "register" },
    timeline: "Schedule",
  },
  work_event: {
    plan: "work event",
    person: "attendee",
    people: "attendees",
    party: "team",
    parties: "teams",
    reply: { name: "registration", verb: "register" },
    timeline: "Agenda",
  },
};

const DEFAULT_PEOPLE: Record<TemplateKey, number> = { family_event: 6, trip: 2, work_travel: 1, work_event: 10 };

const KINDS_ON: Record<TemplateKey, BookingKind[]> = {
  family_event: ["flight", "lodging", "car", "ride", "meal", "shipment"],
  trip: ["flight", "lodging", "car", "ride"],
  work_travel: ["flight", "lodging", "ride"],
  // An event you run adds catering and materials shipped ahead.
  work_event: ["flight", "lodging", "ride", "meal", "shipment"],
};

const SEEDED_TASKS: Record<TemplateKey, SeededTask[]> = {
  family_event: [
    { ruleKey: "template:dietary", title: "Ask about dietary needs", essential: true, due: { from: "start", days: -14 } },
    { ruleKey: "template:airport-pickups", title: "Arrange airport pickups", essential: true, due: { from: "start", days: -7 } },
    { ruleKey: "template:who-cooks", title: "Confirm who cooks what", essential: true, due: { from: "start", days: -7 } },
    { ruleKey: "template:hold-mail", title: "Hold the mail", essential: false, due: { from: "start", days: -3 } },
  ],
  trip: [
    {
      ruleKey: "template:passport",
      title: "Check passports are valid for the whole trip",
      essential: true,
      onlyWhen: "international",
      due: { from: "start", days: -60 },
    },
    { ruleKey: "template:tell-bank", title: "Tell the bank you are traveling", essential: true, due: { from: "start", days: -7 } },
    { ruleKey: "template:hold-mail", title: "Hold the mail", essential: false, due: { from: "start", days: -3 } },
    { ruleKey: "template:offline-maps", title: "Download offline maps", essential: false, due: { from: "start", days: -1 } },
  ],
  work_travel: [
    { ruleKey: "template:approval", title: "Confirm approval", essential: true, due: { from: "start", days: -14 } },
    { ruleKey: "template:project-code", title: "Note the project code", essential: true, due: { from: "start", days: -7 } },
    { ruleKey: "template:submit-expenses", title: "Submit expenses", essential: true, due: { from: "end", days: 7 } },
  ],
  work_event: [
    { ruleKey: "template:approval", title: "Confirm approval", essential: true, due: { from: "start", days: -14 } },
    { ruleKey: "template:project-code", title: "Note the project code", essential: true, due: { from: "start", days: -7 } },
    { ruleKey: "template:submit-expenses", title: "Submit expenses", essential: true, due: { from: "end", days: 7 } },
  ],
};

// Family and trip plans see a short list that maps onto the fixed export keys.
const SHARED_CATEGORIES: MoneyDefaults["categories"] = [
  { key: "airfare", label: "Travel" },
  { key: "lodging", label: "Lodging" },
  { key: "rideshare_taxi", label: "Getting around" },
  { key: "meals", label: "Food" },
  { key: "activities", label: "Activities" },
  { key: "shopping", label: "Shopping" },
  { key: "other", label: "Other" },
];

// Work plans see the whole list, so exports are consistent (product spec 13.1).
const WORK_CATEGORIES: MoneyDefaults["categories"] = [
  { key: "airfare", label: "Airfare" },
  { key: "lodging", label: "Lodging" },
  { key: "car_rental", label: "Car rental" },
  { key: "fuel", label: "Fuel" },
  { key: "rideshare_taxi", label: "Rideshare and taxi" },
  { key: "rail_transit", label: "Rail and transit" },
  { key: "parking_tolls", label: "Parking and tolls" },
  { key: "mileage", label: "Mileage" },
  { key: "meals", label: "Meals" },
  { key: "meals_with_others", label: "Meals with clients or team" },
  { key: "conference", label: "Conference and registration" },
  { key: "shipping", label: "Shipping" },
  { key: "phone_internet", label: "Phone and internet" },
  { key: "supplies", label: "Supplies" },
  { key: "tips", label: "Tips" },
  { key: "other", label: "Other" },
];

const WORK_MONEY: MoneyDefaults = {
  mode: "expense_report",
  split: "none",
  reimbursable: true,
  projectCode: true,
  balances: false,
  categories: WORK_CATEGORIES,
};

const MONEY: Record<TemplateKey, MoneyDefaults> = {
  // Split by household.
  family_event: { mode: "shared", split: "by_party", reimbursable: false, projectCode: false, balances: true, categories: SHARED_CATEGORIES },
  // Split evenly.
  trip: { mode: "shared", split: "equal", reimbursable: false, projectCode: false, balances: true, categories: SHARED_CATEGORIES },
  work_travel: WORK_MONEY,
  work_event: WORK_MONEY,
};

/** Replies are due this many days before the first day (product spec 10.4). */
const REPLY_DEADLINE_DAYS: Record<TemplateKey, number | null> = {
  family_event: 21,
  trip: 30,
  work_travel: null,
  work_event: 14,
};

// Sections on by default, in order (product spec 9.2). "rsvp" on a trip and "map" anywhere are
// decided per plan in buildSections().
const SECTIONS_ON: Record<TemplateKey, SiteSectionType[]> = {
  family_event: ["cover", "details", "schedule", "rsvp", "stay", "getting_there", "who", "bring", "weather", "faq", "contact"],
  trip: ["cover", "details", "schedule", "rsvp", "stay", "getting_there", "who", "bring", "weather", "local_time", "map", "contact"],
  work_travel: ["cover", "details", "schedule", "stay", "getting_there", "local_time", "weather", "links", "contact"],
  work_event: [
    "cover", "details", "schedule", "rsvp", "stay", "getting_there", "costs", "local_time", "weather", "map", "faq", "links", "contact",
  ],
};

// Who can see a section unless the organizer says otherwise (product spec 9.1). Everything not
// listed is for everyone with the link.
const GUESTS_ONLY_BY_DEFAULT: ReadonlySet<SiteSectionType> = new Set(["who", "arrivals", "costs", "links", "photos"]);

const SITE_BASE: Record<TemplateKey, Pick<SiteDefaults, "access" | "theme" | "whoIsComing">> = {
  family_event: { access: "link", theme: "invitation", whoIsComing: "first_names" },
  trip: { access: "link", theme: "postcard", whoIsComing: "first_names" },
  // Work pages start behind a passcode with "Who's coming" off (product spec 13.4).
  work_travel: { access: "passcode", theme: "agenda", whoIsComing: "hidden" },
  work_event: { access: "passcode", theme: "agenda", whoIsComing: "hidden" },
};

const DIETARY_QUESTION: Omit<RsvpQuestion, "id"> = { label: "Any dietary needs?", type: "text", required: false, builtIn: "dietary" };
const ARRIVAL_QUESTION: Omit<RsvpQuestion, "id"> = { label: "How are you getting here, and when?", type: "text", required: false, builtIn: "arrival" };
const RIDE_QUESTION: Omit<RsvpQuestion, "id"> = { label: "Do you need a ride when you arrive?", type: "yes_no", required: false, builtIn: "needs_ride" };

const RSVP_QUESTIONS: Record<TemplateKey, Omit<RsvpQuestion, "id">[]> = {
  family_event: [DIETARY_QUESTION, ARRIVAL_QUESTION, RIDE_QUESTION],
  trip: [DIETARY_QUESTION],
  work_travel: [],
  work_event: [DIETARY_QUESTION, ARRIVAL_QUESTION, RIDE_QUESTION],
};

/** Product spec 11.2. Each row adds to 100 (templates.test.ts checks). */
const WEIGHTS: Record<TemplateKey, ReadinessWeights> = {
  family_event: { gettingThere: 15, lodging: 15, car: 10, rides: 5, meals: 10, shipAhead: 5, people: 15, schedule: 10, site: 5, tasks: 10 },
  trip: { gettingThere: 25, lodging: 25, car: 10, rides: 5, meals: 5, shipAhead: 5, people: 5, schedule: 5, site: 5, tasks: 10 },
  work_travel: { gettingThere: 30, lodging: 25, car: 5, rides: 10, meals: 5, shipAhead: 5, people: 0, schedule: 10, site: 0, tasks: 10 },
  work_event: { gettingThere: 15, lodging: 15, car: 0, rides: 5, meals: 10, shipAhead: 5, people: 15, schedule: 15, site: 10, tasks: 10 },
};

// --- per-plan decisions ---------------------------------------------------------------------------

/** True when both places name a country and the countries differ. Unknown counts as domestic. */
export function isInternational(plan: Partial<Pick<Plan, "destination" | "origin">>): boolean {
  const there = plan.destination?.countryCode;
  const from = plan.origin?.countryCode;
  return Boolean(there && from && there !== from);
}

function sectionVisibility(key: TemplateKey, type: SiteSectionType): SectionVisibility {
  if (GUESTS_ONLY_BY_DEFAULT.has(type)) return "guests";
  // A family gathering is usually at somebody's home, whose address is for guests only. The
  // share page may open this up once the stay is known to be a hotel.
  if (type === "stay" && key === "family_event") return "guests";
  return "everyone";
}

function buildSections(key: TemplateKey, plan: TemplatePlan): SiteSection[] {
  const people = plan.expectedPeople ?? DEFAULT_PEOPLE[key];
  const on = SECTIONS_ON[key].filter((type) => {
    // "In or out" joins a trip's page for three or more travelers.
    if (type === "rsvp" && key === "trip") return people >= 3;
    if (type === "map") return MAP_SECTION_AVAILABLE;
    return true;
  });
  // The host note sits right under the cover and shows as soon as one is written.
  on.splice(1, 0, "announcement");
  // Travel notes join every page when the destination is abroad, just above Contact.
  if (isInternational(plan)) on.splice(on.indexOf("contact"), 0, "travel_notes");

  const off = SITE_SECTION_TYPES.filter((type) => !on.includes(type));
  return [...on.map((type) => ({ type, enabled: true })), ...off.map((type) => ({ type, enabled: false }))].map(
    ({ type, enabled }) => ({ type, enabled, visibility: sectionVisibility(key, type), content: {} }),
  );
}

/**
 * Everything the plan's template decides. `plan` needs only `template` (and `workMode` for
 * work); with `expectedPeople`, the dates and the two places it also settles the choices that
 * depend on them (the people tool for a solo trip, "in or out" for three or more, travel notes
 * abroad, Food and Send ahead for a long trip).
 */
export function templateConfig(plan: TemplatePlan): TemplateConfig {
  const key = templateKey(plan);
  const base = WORDS[key];
  const people = plan.expectedPeople ?? DEFAULT_PEOPLE[key];

  const on = KINDS_ON[key];
  const offered = BOOKING_KINDS.filter((kind) => !on.includes(kind));
  const nights = plan.startDate && plan.endDate ? nightsBetween(plan.startDate, plan.endDate) : 0;
  // A long trip is worth a grocery order and a box sent ahead; work only ever offers the car.
  const suggested = key === "trip" && nights >= 7 ? offered.filter((kind) => kind === "meal" || kind === "shipment") : [];

  const tools = Object.fromEntries(PLAN_TOOLS.map((tool) => [tool, "on" as ToolDefault])) as Record<PlanTool, ToolDefault>;
  for (const kind of offered) tools[TOOL_FOR_KIND[kind]] = "offered";
  // Family: always on. A trip or work trip for one has nobody else to track. An event always does.
  if ((key === "trip" || key === "work_travel") && people < 2) tools.people = "hidden";

  const sections = buildSections(key, plan);
  const site: SiteDefaults = {
    ...SITE_BASE[key],
    accent: SITE_THEME_ACCENTS[SITE_BASE[key].theme][0],
    repliesOpen: sections.some((section) => section.type === "rsvp" && section.enabled),
    replyByParty: true,
    allowMaybe: true,
    sections,
    rsvpQuestions: RSVP_QUESTIONS[key].map((question) => ({ ...question })),
  };

  return {
    key,
    template: plan.template,
    workMode: plan.template === "work" ? (key === "work_event" ? "event" : "travel") : null,
    words: {
      ...base,
      reply: { ...base.reply },
      money: TOOL_NAMES.money,
      tools: { ...TOOL_NAMES, schedule: base.timeline },
    },
    defaultPeopleCount: DEFAULT_PEOPLE[key],
    kinds: { on: [...on], offered, suggested },
    tools,
    seededTasks: SEEDED_TASKS[key].map((task) => ({ ...task })),
    money: { ...MONEY[key], categories: MONEY[key].categories.map((category) => ({ ...category })) },
    replyDeadlineDaysBefore: REPLY_DEADLINE_DAYS[key],
    site,
    weights: { ...WEIGHTS[key] },
  };
}

/**
 * The tasks a new plan of this template starts with, for this plan: conditional ones are left
 * out when they do not apply, and due dates are set when the plan has dates.
 */
export function seededTasksFor(plan: TemplatePlan): TaskSeed[] {
  const international = isInternational(plan);
  return templateConfig(plan)
    .seededTasks.filter((task) => task.onlyWhen !== "international" || international)
    .map(({ ruleKey, title, essential, due }) => {
      const anchor = due ? (due.from === "end" ? (plan.endDate ?? plan.startDate) : plan.startDate) : null;
      return { ruleKey, title, essential, dueDate: due && anchor ? addDays(anchor, due.days) : null };
    });
}

/** The reply deadline a plan starts with: a local date, or null without dates or for work travel. */
export function defaultReplyDeadline(plan: TemplatePlan): string | null {
  const days = REPLY_DEADLINE_DAYS[templateKey(plan)];
  return days !== null && plan.startDate ? addDays(plan.startDate, -days) : null;
}

/** What the choices in "What are you planning?" are called, in order. Work asks one more question. */
export const TEMPLATE_CHOICES: { template: PlanTemplate; label: string; examples: string }[] = [
  { template: "family_event", label: "Family get-together", examples: "A holiday, a reunion, a big birthday, a graduation" },
  { template: "trip", label: "Trip", examples: "A vacation, a group trip, a weekend away" },
  { template: "work", label: "Work", examples: "A business trip, or an offsite or conference you run" },
];

export const WORK_MODE_CHOICES: { workMode: WorkMode; label: string }[] = [
  { workMode: "travel", label: "I'm traveling" },
  { workMode: "event", label: "I'm hosting" },
];
