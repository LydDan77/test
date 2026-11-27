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

/**
 * Turns a failed Zod parse into an ActionFailure: each field's messages under its name, and the
 * first message as the summary.
 */
export function invalid(error: z.ZodError, values?: ActionFailure["values"]): ActionFailure {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.length ? String(issue.path[0]) : "";
    if (!field) continue;
    (fieldErrors[field] ??= []).push(issue.message);
  }
  const first = error.issues[0]?.message ?? "Please check what you entered";
  return { ok: false, error: first, fieldErrors, ...(values ? { values } : {}) };
}

/** Reads a text field from FormData: always a string, trimmed. Files and missing fields give "". */
export function formText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}
