"use server";

import { and, eq, inArray } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { NewPerson, NewTask, Plan } from "@/db/schema";
import { syncPlanClocks } from "@/features/clock/sync";
import { fail, formText, invalid, ok, type ActionFailure, type ActionResult } from "@/lib/action";
import { requirePlan, requireUser } from "@/lib/auth";
import {
  BOOKING_KINDS,
  DATE_STATUSES,
  PLAN_TEMPLATES,
  WORK_MODES,
  bookingKindListSchema,
  currencySchema,
  localDateSchema,
  parseMoneyInput,
  type BookingKind,
  type PlaceRef,
} from "@/lib/domain";
import { newId } from "@/lib/ids";
import { defaultReplyDeadline, seededTasksFor, templateConfig } from "@/lib/templates";
import {
  defaultUnpublishOn,
  draftSite,
  neededBooking,
  readPlaceField,
  seededTaskRows,
  startingPeople,
  typedPlace,
  withFreeSlug,
} from "./internal";
import { MAX_PEOPLE, parseNameLines, suggestPlanTitle } from "./new-plan";
import { seedExamplePlan } from "./seed";

// Creating and changing plans. Every action checks who is asking, loads the plan only if that
// person owns it (requirePlan ends in the not-found page otherwise), validates, writes, and
// refreshes the page.

export type PlanResult = ActionResult<{ planId: string }>;
export type PlanRemovedResult = ActionResult;

const titleSchema = z.string().max(120, "Use a shorter name");
const optionalDate = z.union([z.literal(""), localDateSchema]);

// --- reading the "where" and "when" fields ---------------------------------------------------------

type PlaceRead = { ok: true; place: PlaceRef | null } | { ok: false; failure: ActionFailure };

/**
 * `<name>` holds the JSON of a place chosen from a typeahead; `<name>Text` holds what was typed
 * when nothing was chosen ("Use 'Grandma's lake house' anyway").
 */
function readPlace(formData: FormData, name: string, fallbackTz: string, values: Record<string, string>): PlaceRead {
  const chosen = readPlaceField(formText(formData, name));
  if (chosen === "invalid") {
    return { ok: false, failure: fail("Choose the place from the list again.", { fieldErrors: { [name]: ["Choose the place from the list again"] }, values }) };
  }
  if (chosen) return { ok: true, place: chosen };
  const typed = formText(formData, `${name}Text`);
  if (typed.length > 200) {
    return { ok: false, failure: fail("Use a shorter name for the place.", { fieldErrors: { [name]: ["Use a shorter name for the place"] }, values }) };
  }
  return { ok: true, place: typed ? typedPlace(typed, fallbackTz) : null };
}

type DatesRead = { ok: true; startDate: string | null; endDate: string | null } | { ok: false; failure: ActionFailure };

function readDates(formData: FormData, values: Record<string, string>): DatesRead {
  const parsed = z.object({ startDate: optionalDate, endDate: optionalDate }).safeParse({
    startDate: formText(formData, "startDate"),
    endDate: formText(formData, "endDate"),
  });
  if (!parsed.success) return { ok: false, failure: invalid(parsed.error, values) };
  const { startDate, endDate } = parsed.data;
  if (!startDate && endDate) {
    return { ok: false, failure: fail("Choose the first day too.", { fieldErrors: { startDate: ["Choose the first day too"] }, values }) };
  }
  if (startDate && endDate && endDate < startDate) {
    return { ok: false, failure: fail("The last day cannot be before the first.", { fieldErrors: { endDate: ["The last day cannot be before the first"] }, values }) };
  }
  // One date means a plan of one day.
  return { ok: true, startDate: startDate || null, endDate: startDate ? endDate || startDate : null };
}

// --- create ---------------------------------------------------------------------------------------

const peopleSchema = z.coerce
  .number("Enter how many people are coming")
  .int("Enter a whole number of people")
  .min(1, "Count at least yourself")
  .max(MAX_PEOPLE, "That is more people than a plan can hold");
const workModeSchema = z.enum(WORK_MODES, "Say whether you are traveling or hosting");

// Fields left empty arrive as "" and are read as "not given" (see `given()`).
const createSchema = z
  .object({
    template: z.enum(PLAN_TEMPLATES, "Choose what you are planning"),
    workMode: workModeSchema.optional(),
    title: titleSchema,
    people: peopleSchema.optional(),
    names: z.string().max(20_000, "That is too many names for one go"),
  })
  .refine((v) => v.template !== "work" || v.workMode !== undefined, { message: "Say whether you are traveling or hosting", path: ["workMode"] });

const given = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

/**
 * Makes a plan from the three questions of the new-plan flow.
 *
 * Fields
 *   template      "family_event" | "trip" | "work"                          (what)
 *   workMode      "travel" | "event", only for work
 *   place         the JSON of the place chosen in the typeahead             (where)
 *   placeText     what was typed, when nothing was chosen
 *   origin        optional JSON of where people set out from; default: the user's home
 *   startDate, endDate   YYYY-MM-DD; both empty means "Not sure yet" (a draft)   (when)
 *   people        how many, the organizer included; default: the template's usual count  (who)
 *   names         optional, one per line; "Name <email>" is understood
 *   title         optional; default: a suggestion such as "Christmas in Orlando"
 *
 * It creates the plan; the organizer and everyone named, in their households; a "Needs you"
 * booking for each tool the template switches on; the template's tasks; a draft share page at a
 * free address; and the destination's clock on Home. Returns the new plan's id.
 */
export async function createPlan(_prev: PlanResult | null, formData: FormData): Promise<PlanResult> {
  const user = await requireUser();

  const values = {
    template: formText(formData, "template"),
    workMode: formText(formData, "workMode"),
    place: formText(formData, "place"),
    placeText: formText(formData, "placeText"),
    origin: formText(formData, "origin"),
    startDate: formText(formData, "startDate"),
    endDate: formText(formData, "endDate"),
    people: formText(formData, "people"),
    names: typeof formData.get("names") === "string" ? (formData.get("names") as string) : "",
    title: formText(formData, "title"),
  };
  const parsed = createSchema.safeParse({ ...values, workMode: given(values.workMode), people: given(values.people) });
  if (!parsed.success) return invalid(parsed.error, values);

  const originRead = readPlace(formData, "origin", user.home.tz, values);
  if (!originRead.ok) return originRead.failure;
  const origin = originRead.place ?? user.home;

  const placeRead = readPlace(formData, "place", origin.tz, values);
  if (!placeRead.ok) return placeRead.failure;
  const destination = placeRead.place;
  if (!destination) return fail("Say where it is. A city is enough.", { fieldErrors: { place: ["Say where it is"] }, values });

  const dates = readDates(formData, values);
  if (!dates.ok) return dates.failure;

  const { template } = parsed.data;
  const workMode = template === "work" ? (parsed.data.workMode ?? null) : null;
  const named = parseNameLines(parsed.data.names);
  const defaults = templateConfig({ template, workMode });
  const count = parsed.data.people ?? defaults.defaultPeopleCount;
  const now = new Date();

  const plan = {
    id: newId(),
    ownerId: user.id,
    template,
    workMode,
    title: parsed.data.title || suggestPlanTitle({ template, workMode, destination, ...dates }),
    destination,
    origin,
    startDate: dates.startDate,
    endDate: dates.endDate,
    dateStatus: dates.startDate ? ("fixed" as const) : ("undecided" as const),
    tz: destination.tz,
    expectedPeople: count,
    currency: user.currency,
    kindsInUse: defaults.kinds.on,
    replyDeadline: null as string | null,
    isExample: false,
  };
  plan.replyDeadline = defaultReplyDeadline(plan);

  const { parties, people } = startingPeople(plan, user, named, now);
  // The count asked for and the names given can disagree; the larger is the better guess.
  plan.expectedPeople = Math.max(count, people.length);

  const db = await getDb();
  await withFreeSlug(db, plan.title, (slug) =>
    db.transaction(async (tx) => {
      await tx.insert(schema.plans).values(plan);
      await tx.insert(schema.parties).values(parties);
      await tx.insert(schema.people).values(people);
      if (plan.kindsInUse.length > 0) await tx.insert(schema.bookings).values(plan.kindsInUse.map((kind) => neededBooking(plan, kind)));
      const tasks = seededTaskRows(plan);
      if (tasks.length > 0) await tx.insert(schema.tasks).values(tasks);
      await tx.insert(schema.sites).values(draftSite(plan, slug, user.name));
    }),
  );
  await syncPlanClocks(user, { now });

  refresh();
  return ok({ planId: plan.id });
}

// --- update ---------------------------------------------------------------------------------------

const updateSchema = z.object({
  title: z.string().min(1, "Give the plan a name").max(120, "Use a shorter name").optional(),
  template: z.enum(PLAN_TEMPLATES, "Choose what you are planning").optional(),
  workMode: workModeSchema.optional(),
  dateStatus: z.enum(DATE_STATUSES, "Say whether the dates are firm").optional(),
  people: peopleSchema.optional(),
  currency: currencySchema.optional(),
  replyDeadline: optionalDate.optional(),
  projectCode: z.string().max(60, "Use a shorter project code").optional(),
  purpose: z.string().max(300, "Use a shorter purpose").optional(),
});

function readKinds(value: string): BookingKind[] | null {
  const kinds = value.split(",").map((kind) => kind.trim()).filter(Boolean);
  const parsed = bookingKindListSchema.safeParse(kinds);
  // Always in the fixed order: Flights, Stay, Car, Rides, Food, Send ahead.
  return parsed.success ? BOOKING_KINDS.filter((kind) => parsed.data.includes(kind)) : null;
}

/**
 * Changes a plan. Only the fields that are sent change; a field that is left out is left alone.
 *
 * Fields: `planId`, and any of
 *   title; template (with workMode for work); people;
 *   place / placeText (send `place` empty with no `placeText` to clear the destination);
 *   origin / originText;
 *   startDate and endDate together (both empty: no dates yet, so the plan is a draft); dateStatus;
 *   currency; budget (an amount as typed, empty to clear); replyDeadline (empty to clear);
 *   projectCode; purpose (empty to clear);
 *   kindsInUse and kindsNotNeeded (booking kinds separated by commas, empty for none).
 *
 * What follows by itself: the plan's zone follows its destination; a tool switched on for the
 * first time gets its "Needs you" booking; dates the person has not touched (the reply deadline,
 * the day the page comes down, the template's task due dates) move with the plan's dates; the
 * share page's title follows the plan's while they are the same; the destination's clock on Home
 * is kept in step.
 */
export async function updatePlan(_prev: PlanResult | null, formData: FormData): Promise<PlanResult> {
  const user = await requireUser();
  const plan = await requirePlan(user, formText(formData, "planId"));

  const has = (name: string) => formData.has(name);
  const values: Record<string, string> = {};
  for (const name of ["title", "template", "workMode", "place", "placeText", "origin", "originText", "startDate", "endDate", "dateStatus", "people", "currency", "budget", "replyDeadline", "projectCode", "purpose", "kindsInUse", "kindsNotNeeded"]) {
    if (has(name)) values[name] = formText(formData, name);
  }

  const parsed = updateSchema.safeParse({
    title: values.title,
    template: values.template,
    // An empty work mode means "none", which is right for anything but work (checked below).
    workMode: given(values.workMode),
    dateStatus: values.dateStatus,
    people: values.people,
    currency: values.currency,
    replyDeadline: values.replyDeadline,
    projectCode: values.projectCode,
    purpose: values.purpose,
  });
  if (!parsed.success) return invalid(parsed.error, values);
  const input = parsed.data;

  const next: Plan = { ...plan };

  if (input.title !== undefined) next.title = input.title;
  if (input.template !== undefined) next.template = input.template;
  if (has("workMode") || input.template !== undefined) {
    const mode = has("workMode") ? (input.workMode ?? null) : plan.workMode;
    next.workMode = next.template === "work" ? mode : null;
    if (next.template === "work" && !next.workMode) {
      return fail("Say whether you are traveling or hosting.", { fieldErrors: { workMode: ["Say whether you are traveling or hosting"] }, values });
    }
  }

  if (has("origin") || has("originText")) {
    const read = readPlace(formData, "origin", plan.origin.tz, values);
    if (!read.ok) return read.failure;
    if (!read.place) return fail("Say where you are setting out from.", { fieldErrors: { origin: ["Say where you are setting out from"] }, values });
    next.origin = read.place;
  }
  if (has("place") || has("placeText")) {
    const read = readPlace(formData, "place", next.origin.tz, values);
    if (!read.ok) return read.failure;
    next.destination = read.place;
  }
  next.tz = next.destination?.tz ?? next.origin.tz;

  if (has("startDate") || has("endDate")) {
    const dates = readDates(formData, values);
    if (!dates.ok) return dates.failure;
    next.startDate = dates.startDate;
    next.endDate = dates.endDate;
    // Dates given for the first time are firm unless the person says otherwise; none means undecided.
    if (!dates.startDate) next.dateStatus = "undecided";
    else if (plan.dateStatus === "undecided") next.dateStatus = "fixed";
  }
  if (input.dateStatus !== undefined) {
    if (!next.startDate && input.dateStatus !== "undecided") {
      return fail("Choose the dates first.", { fieldErrors: { dateStatus: ["Choose the dates first"] }, values });
    }
    next.dateStatus = next.startDate && input.dateStatus === "undecided" ? next.dateStatus : input.dateStatus;
  }

  if (input.people !== undefined) next.expectedPeople = input.people;
  if (input.currency !== undefined) next.currency = input.currency;
  if (has("budget")) {
    if (values.budget === "") next.budgetTotal = null;
    else {
      const money = parseMoneyInput(values.budget, next.currency);
      if (!money || money.amount < 0) return fail("Enter the budget as an amount, such as 2,500.", { fieldErrors: { budget: ["Enter an amount, such as 2,500"] }, values });
      next.budgetTotal = money.amount;
    }
  }
  if (input.projectCode !== undefined) next.projectCode = input.projectCode || null;
  if (input.purpose !== undefined) next.purpose = input.purpose || null;

  if (has("kindsInUse")) {
    const kinds = readKinds(values.kindsInUse);
    if (!kinds) return fail("That list of tools could not be read. Try again.", { values });
    next.kindsInUse = kinds;
  }
  if (has("kindsNotNeeded")) {
    const kinds = readKinds(values.kindsNotNeeded);
    if (!kinds) return fail("That list of tools could not be read. Try again.", { values });
    next.kindsNotNeeded = kinds;
  }

  // The reply deadline: what the person sent; otherwise it keeps following the dates for as
  // long as it is still the one the app worked out (or was never set).
  const oldDefaultDeadline = defaultReplyDeadline(plan);
  if (input.replyDeadline !== undefined) next.replyDeadline = input.replyDeadline || null;
  else if (plan.replyDeadline === oldDefaultDeadline) next.replyDeadline = defaultReplyDeadline(next);

  const datesChanged = next.startDate !== plan.startDate || next.endDate !== plan.endDate;
  const newKinds = next.kindsInUse.filter((kind) => !plan.kindsInUse.includes(kind));

  const db = await getDb();
  await db.transaction(async (tx) => {
    const { id: _id, ownerId: _ownerId, createdAt: _createdAt, updatedAt: _updatedAt, isExample: _isExample, archivedAt: _archivedAt, ...changes } = next;
    void _id; void _ownerId; void _createdAt; void _updatedAt; void _isExample; void _archivedAt;
    await tx
      .update(schema.plans)
      .set(changes)
      .where(and(eq(schema.plans.id, plan.id), eq(schema.plans.ownerId, user.id)));

    // A tool switched on for the first time gets its "Needs you" booking.
    if (newKinds.length > 0) {
      const existing = await tx
        .select({ kind: schema.bookings.kind })
        .from(schema.bookings)
        .where(and(eq(schema.bookings.planId, plan.id), inArray(schema.bookings.kind, newKinds)));
      const missing = newKinds.filter((kind) => !existing.some((booking) => booking.kind === kind));
      if (missing.length > 0) await tx.insert(schema.bookings).values(missing.map((kind) => neededBooking(next, kind)));
    }

    // The share page keeps what the person changed on it and follows the plan in the rest.
    const [site] = await tx.select().from(schema.sites).where(eq(schema.sites.planId, plan.id)).limit(1);
    if (site) {
      const siteChanges: Partial<typeof schema.sites.$inferInsert> = {};
      if (site.title === plan.title && next.title !== plan.title) siteChanges.title = next.title;
      if (site.replyDeadline === plan.replyDeadline && next.replyDeadline !== plan.replyDeadline) siteChanges.replyDeadline = next.replyDeadline;
      if (datesChanged && (site.unpublishOn === null || site.unpublishOn === defaultUnpublishOn(plan))) siteChanges.unpublishOn = defaultUnpublishOn(next);
      if (Object.keys(siteChanges).length > 0) await tx.update(schema.sites).set(siteChanges).where(eq(schema.sites.id, site.id));
    }

    // The template's tasks keep the due dates the person gave them and follow the plan in the rest.
    if (datesChanged) {
      const before = new Map(seededTasksFor(plan).map((task) => [task.ruleKey, task.dueDate]));
      const after = new Map(seededTasksFor(next).map((task) => [task.ruleKey, task.dueDate]));
      const tasks = await tx
        .select({ id: schema.tasks.id, ruleKey: schema.tasks.ruleKey, dueDate: schema.tasks.dueDate })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.planId, plan.id), eq(schema.tasks.source, "template"), eq(schema.tasks.done, false)));
      for (const task of tasks) {
        if (!task.ruleKey || !after.has(task.ruleKey)) continue;
        const due = after.get(task.ruleKey) ?? null;
        if (task.dueDate === (before.get(task.ruleKey) ?? null) && task.dueDate !== due) {
          await tx.update(schema.tasks).set({ dueDate: due }).where(eq(schema.tasks.id, task.id));
        }
      }
    }
  });
  await syncPlanClocks(user);

  refresh();
  return ok({ planId: plan.id });
}

// --- duplicate ------------------------------------------------------------------------------------

/**
 * Starts a plan again ("do it again next year"). Field: `planId`.
 *
 * The copy keeps the name (with "copy"), the kind, the places, the people in their households
 * with what is known about them, the to-do list (nothing ticked off) and the share page's look,
 * sections and questions. It starts fresh in everything that belongs to one occasion: no dates
 * (so it is a draft), nobody invited and no replies, new personal links, "Needs you" bookings,
 * no schedule, no money, and a draft page at a new address.
 */
export async function duplicatePlan(_prev: PlanResult | null, formData: FormData): Promise<PlanResult> {
  const user = await requireUser();
  const source = await requirePlan(user, formText(formData, "planId"));
  const db = await getDb();

  const [parties, people, tasks, [site]] = await Promise.all([
    db.select().from(schema.parties).where(eq(schema.parties.planId, source.id)).orderBy(schema.parties.sortOrder, schema.parties.createdAt),
    db.select().from(schema.people).where(eq(schema.people.planId, source.id)).orderBy(schema.people.createdAt, schema.people.id),
    db.select().from(schema.tasks).where(eq(schema.tasks.planId, source.id)).orderBy(schema.tasks.sortOrder, schema.tasks.createdAt),
    db.select().from(schema.sites).where(eq(schema.sites.planId, source.id)).limit(1),
  ]);

  const suffix = " copy";
  const plan = {
    id: newId(),
    ownerId: user.id,
    template: source.template,
    workMode: source.workMode,
    title: `${source.title.slice(0, 120 - suffix.length)}${suffix}`,
    destination: source.destination,
    origin: source.origin,
    stops: [],
    startDate: null,
    endDate: null,
    dateStatus: "undecided" as const,
    tz: source.tz,
    expectedPeople: Math.max(source.expectedPeople, people.length),
    currency: source.currency,
    budgetTotal: source.budgetTotal,
    replyDeadline: null,
    projectCode: source.projectCode,
    purpose: source.purpose,
    kindsInUse: source.kindsInUse,
    kindsNotNeeded: source.kindsNotNeeded,
    isExample: false,
  };

  const partyIds = new Map(parties.map((party) => [party.id, newId()]));
  const personIds = new Map(people.map((person) => [person.id, newId()]));

  const newParties = parties.map((party) => ({
    id: partyIds.get(party.id)!,
    planId: plan.id,
    name: party.name,
    origin: party.origin,
    notes: party.notes,
    sortOrder: party.sortOrder,
    // guestToken: a new one by default. Last year's links must not open this year's plan.
  }));
  const newPeople: NewPerson[] = people.map((person) => ({
    id: personIds.get(person.id)!,
    planId: plan.id,
    partyId: partyIds.get(person.partyId)!,
    name: person.name,
    email: person.email,
    phone: person.phone,
    role: person.role,
    ageGroup: person.ageGroup,
    childAge: person.childAge,
    dietaryTags: person.dietaryTags,
    dietaryNote: person.dietaryNote,
    accessNote: person.accessNote,
    canDrive: person.canDrive,
    vehicleSeats: person.vehicleSeats,
    team: person.team,
    jobTitle: person.jobTitle,
    privateNotes: person.privateNotes,
    // The organizer is coming; nobody else has been asked yet.
    ...(person.role === "organizer" ? { rsvpStatus: "yes" as const, rsvpAt: new Date(), rsvpVia: "organizer" as const } : {}),
  }));
  const newTasks: NewTask[] = tasks.map((task) => ({
    id: newId(),
    planId: plan.id,
    kind: task.kind,
    title: task.title,
    notes: task.notes,
    essential: task.essential,
    // Due dates belonged to the old dates; the template's come back when the copy gets dates.
    dueDate: null,
    assigneePersonId: task.assigneePersonId ? (personIds.get(task.assigneePersonId) ?? null) : null,
    quantity: task.quantity,
    source: task.source,
    ruleKey: task.ruleKey,
    sortOrder: task.sortOrder,
  }));

  await withFreeSlug(db, plan.title, (slug) =>
    db.transaction(async (tx) => {
      await tx.insert(schema.plans).values(plan);
      if (newParties.length > 0) await tx.insert(schema.parties).values(newParties);
      if (newPeople.length > 0) await tx.insert(schema.people).values(newPeople);
      if (newTasks.length > 0) await tx.insert(schema.tasks).values(newTasks);
      const kinds = plan.kindsInUse.filter((kind) => !plan.kindsNotNeeded.includes(kind));
      if (kinds.length > 0) await tx.insert(schema.bookings).values(kinds.map((kind) => neededBooking(plan, kind)));

      const fresh = draftSite(plan, slug, null);
      await tx.insert(schema.sites).values(
        site
          ? {
              ...fresh,
              access: site.access,
              // The shared passcode is the organizer's own choice; it carries over with the page.
              passcodeHash: site.passcodeHash,
              theme: site.theme,
              accent: site.accent,
              colorScheme: site.colorScheme,
              title: site.title === source.title ? plan.title : site.title,
              subtitle: site.subtitle,
              hostLine: site.hostLine,
              repliesOpen: site.repliesOpen,
              replyByParty: site.replyByParty,
              allowMaybe: site.allowMaybe,
              whoIsComing: site.whoIsComing,
              sections: site.sections,
              rsvpQuestions: site.rsvpQuestions,
            }
          : fresh,
      );
    }),
  );
  await syncPlanClocks(user);

  refresh();
  return ok({ planId: plan.id });
}

// --- archive, restore, delete ---------------------------------------------------------------------

/**
 * Puts a plan away. Field: `planId`. It leaves the lists and its clock leaves Home; nothing is
 * deleted, and restorePlan() brings it back. The share page is not touched: it stays up until
 * its own take-down date or until the person unpublishes it.
 */
export async function archivePlan(_prev: PlanResult | null, formData: FormData): Promise<PlanResult> {
  const user = await requireUser();
  const plan = await requirePlan(user, formText(formData, "planId"));
  if (!plan.archivedAt) {
    const db = await getDb();
    await db
      .update(schema.plans)
      .set({ archivedAt: new Date() })
      .where(and(eq(schema.plans.id, plan.id), eq(schema.plans.ownerId, user.id)));
    await syncPlanClocks(user);
  }
  refresh();
  return ok({ planId: plan.id });
}

/** Brings an archived plan back. Field: `planId`. */
export async function restorePlan(_prev: PlanResult | null, formData: FormData): Promise<PlanResult> {
  const user = await requireUser();
  const plan = await requirePlan(user, formText(formData, "planId"));
  if (plan.archivedAt) {
    const db = await getDb();
    await db
      .update(schema.plans)
      .set({ archivedAt: null })
      .where(and(eq(schema.plans.id, plan.id), eq(schema.plans.ownerId, user.id)));
    await syncPlanClocks(user);
  }
  refresh();
  return ok({ planId: plan.id });
}

async function removePlan(userId: string, plan: Pick<Plan, "id" | "isExample">): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    // Everything that hangs off the plan goes with it: people, replies, bookings, schedule,
    // money, its share page and its clock (ON DELETE CASCADE).
    await tx.delete(schema.plans).where(and(eq(schema.plans.id, plan.id), eq(schema.plans.ownerId, userId)));
    // Removing the example is remembered, so it is not offered or seeded again.
    if (plan.isExample) await tx.update(schema.users).set({ exampleState: "removed" }).where(eq(schema.users.id, userId));
  });
}

/**
 * Deletes a plan for good, with its people, replies, bookings, schedule, money and share page.
 * Field: `planId`. There is no undo: ask first.
 */
export async function deletePlan(_prev: PlanRemovedResult | null, formData: FormData): Promise<PlanRemovedResult> {
  const user = await requireUser();
  const plan = await requirePlan(user, formText(formData, "planId"));
  await removePlan(user.id, plan);
  // Its clock went with it; another plan for the same place may now show its own.
  await syncPlanClocks(user);
  refresh();
  return ok();
}

/**
 * Removes the example plan in one go. No fields: a person has at most one. Succeeds when it is
 * already gone, so a double tap is harmless.
 */
export async function removeExamplePlan(_prev: PlanRemovedResult | null, _formData?: FormData): Promise<PlanRemovedResult> {
  void _formData;
  const user = await requireUser();
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.delete(schema.plans).where(and(eq(schema.plans.ownerId, user.id), eq(schema.plans.isExample, true)));
    await tx.update(schema.users).set({ exampleState: "removed" }).where(eq(schema.users.id, user.id));
  });
  await syncPlanClocks(user);
  refresh();
  return ok();
}

/**
 * Brings the example plan back for someone who removed it (the "show me the example" link on an
 * empty plans list). No fields. A person who still has the example gets that one back, not a second.
 */
export async function restoreExamplePlan(_prev: PlanResult | null, _formData?: FormData): Promise<PlanResult> {
  void _formData;
  const user = await requireUser();
  const seeded = await seedExamplePlan(user, { restore: true });
  if (!seeded.planId) return fail("We could not bring the example back. Try again in a moment.");
  refresh();
  return ok({ planId: seeded.planId });
}
