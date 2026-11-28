// The result every Server Action returns. Pure, so client components can import the types.
//
// An action never throws for something a person can cause (bad input, a taken name, a limit
// reached): it returns `{ ok: false, error }` and the form shows it. Throwing is for bugs.
// (redirect() and notFound() also throw; let those through, outside any try/catch.)

import type { z } from "zod";

export type ActionFailure = {
  ok: false;
  /** One plain sentence for the person. Sentence case, no exclamation mark. */
  error: string;
  /** Problems with single fields, keyed by the field's name. */
  fieldErrors?: Record<string, string[] | undefined>;
  /** What the person typed, to put back in the form (React resets a form after its action runs). */
  values?: Record<string, string>;
};

export type ActionSuccess<T extends object = Record<never, never>> = { ok: true } & T;

/** `{ ok: true, ...data } | { ok: false, error, fieldErrors? }` */
export type ActionResult<T extends object = Record<never, never>> = ActionSuccess<T> | ActionFailure;

/** State for useActionState: null before the first submit. */
export type ActionState<T extends object = Record<never, never>> = ActionResult<T> | null;

export function ok(): ActionSuccess;
export function ok<T extends object>(data: T): ActionSuccess<T>;
export function ok<T extends object>(data?: T): ActionSuccess<T> {
  return { ok: true, ...(data ?? {}) } as ActionSuccess<T>;
}

export function fail(
  error: string,
  extra: { fieldErrors?: ActionFailure["fieldErrors"]; values?: ActionFailure["values"] } = {},
): ActionFailure {
  return { ok: false, error, ...extra };
}

/** What invalid() reads: a ZodError, or anything else that carries Zod issues. */
type IssueList = { issues: readonly { path: readonly PropertyKey[]; message: string }[] };

/**
 * Turns a failed Zod parse into an ActionFailure: each field's messages under its name, and the
 * first message as the summary.
 *
 *   if (!parsed.success) return invalid(parsed.error, values);
 *
 * It also takes the issues of a domain helper that does not hand back a ZodError:
 *
 *   const details = parseBookingDetails(kind, input);
 *   if (!details.ok) return invalid({ issues: details.issues }, values);
 *
 * The messages are shown to the person as they are, so give every rule in your schema a
 * message of its own ("Enter a name"); Zod's built-in ones ("Too small: expected string to have
 * >=1 characters") are not wording for people.
 */
export function invalid(error: z.ZodError | IssueList, values?: ActionFailure["values"]): ActionFailure {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.length ? String(issue.path[0]) : "";
    if (!field) continue;
    (fieldErrors[field] ??= []).push(issue.message);
  }
  const first = error.issues[0]?.message ?? "Please check what you entered";
  return { ok: false, error: first, fieldErrors, ...(values ? { values } : {}) };
}

// Control characters other than tab and line breaks. Nobody types them, a paste or a hostile
// request can carry them, and Postgres refuses U+0000 in text outright (a failed statement,
// logged with every value it carried).
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Reads a text field from FormData: always a string, trimmed, with control characters removed
 * (tabs and line breaks stay, for multi-line fields). Files and missing fields give "".
 *
 * An input left empty gives "". The optional text fields of the domain schemas refuse "": use
 * `formText(formData, "notes") || undefined`, or withoutEmptyText() from "@/lib/domain" for a
 * whole object.
 */
export function formText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.replace(CONTROL_CHARACTERS, "").trim() : "";
}
