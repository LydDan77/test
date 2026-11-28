// The share page's JSON shapes: its sections (sites.sections), its reply questions
// (sites.rsvpQuestions), the pinned host note (sites.announcement) and a person's answers
// (people.rsvpAnswers). Product spec 7.6, 7.12 and 9.1.

import { z } from "zod";
import { cleanText, httpUrlSchema, idSchema, instantSchema, longText, shortText } from "./common";
import {
  RSVP_BUILT_INS,
  RSVP_QUESTION_TYPES,
  SECTION_VISIBILITIES,
  SITE_SECTION_TYPES,
  type SiteSectionType,
} from "./enums";

// --- sections -----------------------------------------------------------------------------------

/**
 * Sections that can never be shown to everyone, whatever the organizer picks (product spec 9.1:
 * Arrivals is "Guests only (cannot be made public)").
 *
 * The rule is applied in two places, and both are needed:
 *  - siteSectionSchema stores such a section as "guests" whatever was sent;
 *  - anything that decides what a visitor sees asks sectionVisibility() or sectionIsVisibleTo(),
 *    never `section.visibility` itself, so a row written some other way is still safe.
 */
export const GUESTS_ONLY_SECTION_TYPES: ReadonlySet<SiteSectionType> = new Set(["arrivals"]);

/**
 * One section of a share page. The list in sites.sections is in display order.
 * `content` holds the text and settings a person typed for that section; sections that fill
 * themselves from the plan (schedule, stay, who, weather …) usually leave it empty.
 * A section with nothing to show never renders, whatever `enabled` says.
 * A type in GUESTS_ONLY_SECTION_TYPES always comes out with visibility "guests".
 */
export const siteSectionSchema = z
  .object({
    type: z.enum(SITE_SECTION_TYPES),
    enabled: z.boolean(),
    /** "guests" = only people who opened a personal link or entered the passcode. */
    visibility: z.enum(SECTION_VISIBILITIES),
    titleOverride: shortText(80).optional(),
    content: z.record(z.string(), z.unknown()).default({}),
  })
  .overwrite((section) =>
    GUESTS_ONLY_SECTION_TYPES.has(section.type) && section.visibility !== "guests"
      ? { ...section, visibility: "guests" as const }
      : section,
  );
export type SiteSection = z.infer<typeof siteSectionSchema>;

/**
 * Who may see a section: what was stored, except that a guests-only type is "guests" whatever
 * was stored. Every public query decides with this (or sectionIsVisibleTo).
 */
export function sectionVisibility(section: Pick<SiteSection, "type" | "visibility">): SiteSection["visibility"] {
  return GUESTS_ONLY_SECTION_TYPES.has(section.type) ? "guests" : section.visibility;
}

/**
 * True when a share page shows this section to that visitor. "guest" is someone who opened a
 * personal link or entered the passcode; "everyone" is anyone with the address.
 */
export function sectionIsVisibleTo(
  section: Pick<SiteSection, "type" | "visibility" | "enabled">,
  viewer: "everyone" | "guest",
): boolean {
  if (!section.enabled) return false;
  return viewer === "guest" || sectionVisibility(section) === "everyone";
}

/** sites.sections. "notes" (a section of your own) may appear up to three times; every other type once. */
export const siteSectionsSchema = z
  .array(siteSectionSchema)
  .max(40)
  .superRefine((sections, ctx) => {
    const counts = new Map<SiteSectionType, number>();
    for (const section of sections) counts.set(section.type, (counts.get(section.type) ?? 0) + 1);
    for (const [type, count] of counts) {
      const limit = type === "notes" ? 3 : 1;
      if (count > limit) {
        ctx.addIssue({
          code: "custom",
          message: type === "notes" ? "A page can have up to three sections of your own" : `The ${type} section appears twice`,
        });
      }
    }
  });

// Content shapes for the sections a person types into. Everything is optional, so a freshly
// enabled section parses. Sections not listed here keep whatever settings their feature needs.
const linkItem = z.object({ label: shortText(120), url: httpUrlSchema });

export const sectionContentSchemas = {
  details: z.object({
    /** What to expect, what to wear, anything the host wants to say. */
    text: longText(4000).optional(),
    dressCode: shortText(200).optional(),
  }),
  getting_there: z.object({
    text: longText(2000).optional(),
    parking: longText(1000).optional(),
  }),
  faq: z.object({
    items: z.array(z.object({ question: shortText(300), answer: longText(2000) })).max(40).default([]),
  }),
  contact: z.object({
    /** Names are public. Phone numbers are shown to guests only, on tap. */
    people: z
      .array(z.object({ name: shortText(120), role: shortText(120).optional(), phone: shortText(40).optional() }))
      .max(10)
      .default([]),
  }),
  costs: z.object({ text: longText(2000).optional() }),
  links: z.object({ items: z.array(linkItem).max(30).default([]) }),
  gifts: z.object({ text: longText(1000).optional(), items: z.array(linkItem).max(10).default([]) }),
  photos: z.object({ albumUrl: httpUrlSchema.optional(), text: shortText(300).optional() }),
  notes: z.object({ title: shortText(80).optional(), text: longText(4000).optional() }),
} as const satisfies Partial<Record<SiteSectionType, z.ZodType>>;

export type TypedSectionType = keyof typeof sectionContentSchemas;
export type SectionContent<T extends TypedSectionType> = z.infer<(typeof sectionContentSchemas)[T]>;

/**
 * Reads the typed content of a section, or null when the stored content does not fit
 * (treat that as an empty section; never throw while rendering a public page).
 */
export function readSectionContent<T extends TypedSectionType>(type: T, content: unknown): SectionContent<T> | null {
  const result = sectionContentSchemas[type].safeParse(content ?? {});
  return result.success ? (result.data as SectionContent<T>) : null;
}

// --- the pinned host note -------------------------------------------------------------------------

/** sites.announcement: one pinned message with its time ("Dinner moved to 7"). */
export const announcementSchema = z.object({
  text: longText(500),
  postedAt: instantSchema,
});
export type Announcement = z.infer<typeof announcementSchema>;

// --- reply questions ------------------------------------------------------------------------------

export const rsvpQuestionSchema = z
  .object({
    /** Stable id; answers are keyed by it. Use newId(). */
    id: idSchema,
    label: shortText(200),
    type: z.enum(RSVP_QUESTION_TYPES),
    /** For "choice" (pick one) and "multi" (pick any). */
    options: z.array(shortText(120)).max(20).optional(),
    required: z.boolean().default(false),
    /** Built-in questions write to the person and arrival records instead of free answers. */
    builtIn: z.enum(RSVP_BUILT_INS).optional(),
  })
  .refine((q) => (q.type !== "choice" && q.type !== "multi") || (q.options?.length ?? 0) >= 2, {
    message: "Give at least two options to choose from",
    path: ["options"],
  })
  .refine((q) => !q.options || new Set(q.options).size === q.options.length, {
    message: "Two of the options are the same",
    path: ["options"],
  });
export type RsvpQuestion = z.infer<typeof rsvpQuestionSchema>;

/** sites.rsvpQuestions, in the order they are asked. Ids must be unique. */
export const rsvpQuestionsSchema = z
  .array(rsvpQuestionSchema)
  .max(20)
  .refine((questions) => new Set(questions.map((q) => q.id)).size === questions.length, {
    message: "Two questions share an id",
  });

/** One answer: text, a chosen option, several options, a number, or yes/no. */
export const rsvpAnswerSchema = z.union([
  z.string().max(2000),
  z.array(z.string().max(200)).max(20),
  z.number(),
  z.boolean(),
]);
export type RsvpAnswer = z.infer<typeof rsvpAnswerSchema>;

/** people.rsvpAnswers: answers keyed by question id. */
export const rsvpAnswersSchema = z.record(idSchema, rsvpAnswerSchema);
export type RsvpAnswers = z.infer<typeof rsvpAnswersSchema>;

/**
 * Checks a guest's answers against the questions asked. Unknown question ids are dropped (a
 * guest's browser cannot add questions); a missing required answer or an answer of the wrong
 * shape is an error keyed by question id.
 */
export function validateRsvpAnswers(
  questions: readonly RsvpQuestion[],
  answers: unknown,
): { ok: true; answers: RsvpAnswers } | { ok: false; errors: Record<string, string> } {
  const given = (answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {}) as Record<string, unknown>;
  const clean: RsvpAnswers = {};
  const errors: Record<string, string> = {};

  for (const q of questions) {
    // Text is cleaned and trimmed first, so an answer of only spaces is no answer.
    const raw = given[q.id];
    const value = typeof raw === "string" ? cleanText(raw).trim() : raw;
    const empty =
      value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (q.required) errors[q.id] = "Please answer this one";
      continue;
    }
    switch (q.type) {
      case "text":
        if (typeof value === "string" && value.length <= 2000) clean[q.id] = value;
        else errors[q.id] = "Please keep this shorter";
        break;
      case "choice":
        if (typeof value === "string" && q.options?.includes(value)) clean[q.id] = value;
        else errors[q.id] = "Pick one of the choices";
        break;
      case "multi":
        if (Array.isArray(value) && value.every((v) => typeof v === "string" && q.options?.includes(v))) {
          clean[q.id] = [...new Set(value as string[])];
        } else errors[q.id] = "Pick from the choices";
        break;
      case "yes_no":
        if (typeof value === "boolean") clean[q.id] = value;
        else if (value === "yes" || value === "no") clean[q.id] = value === "yes";
        else errors[q.id] = "Answer yes or no";
        break;
      case "number": {
        // Plain digits only, as a person writes a count: "2", "2.5". Not "0x10", "1e5" or " ".
        const n =
          typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
        if (Number.isFinite(n) && n >= 0 && n <= 100_000) clean[q.id] = n;
        else errors[q.id] = "Enter a number";
        break;
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, answers: clean };
}
