"use client";

import { useActionState, useId, useSyncExternalStore } from "react";
import type { AuthFormState } from "./actions";

// BARE ON PURPOSE. The visual identity has not been chosen; this form only proves that
// accounts work. Whoever styles it is free to: scripts/shot.mjs and the shared steps in
// e2e/support/account.ts find this form by its password field and its inputs by their type
// (password, email, text), not by labels or button names. Keep it ONE <form> that contains the
// password input(s), an email input (type="email") and the name as text input(s), submitted by
// Enter; a show-password button must be type="button". Then nothing else needs to change.

type Action = (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;

const noSubscription = () => () => {};
/** The browser's IANA time zone, or "" on the server and during hydration. */
function useBrowserTimeZone(): string {
  return useSyncExternalStore(
    noSubscription,
    () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
      } catch {
        return "";
      }
    },
    () => "",
  );
}
function useBrowserLocale(): string {
  return useSyncExternalStore(
    noSubscription,
    () => navigator.language ?? "",
    () => "",
  );
}

export function AuthForm({
  action,
  mode,
  next,
}: {
  action: Action;
  mode: "sign-in" | "sign-up";
  /** Sign-in only: the path to go to afterwards, already validated by the page. */
  next?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const timeZone = useBrowserTimeZone();
  const locale = useBrowserLocale();
  const id = useId();
  const errorId = (field: string) => `${id}-${field}-error`;
  const fieldError = (field: string) => state?.fieldErrors?.[field]?.[0];

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
      {mode === "sign-up" && (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-name`}>Name</label>
            <input
              id={`${id}-name`}
              name="name"
              required
              maxLength={80}
              autoComplete="name"
              defaultValue={state?.values?.name}
              aria-invalid={fieldError("name") ? true : undefined}
              aria-describedby={fieldError("name") ? errorId("name") : undefined}
              className="rounded border px-3 py-2"
            />
            {fieldError("name") && <p id={errorId("name")}>{fieldError("name")}</p>}
          </div>
          {/* Sent so the account starts with the right home clock, units and currency. */}
          <input type="hidden" name="timeZone" value={timeZone} readOnly />
          <input type="hidden" name="locale" value={locale} readOnly />
        </>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-email`}>Email</label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          required
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={state?.values?.email}
          aria-invalid={fieldError("email") ? true : undefined}
          aria-describedby={fieldError("email") ? errorId("email") : undefined}
          className="rounded border px-3 py-2"
        />
        {fieldError("email") && <p id={errorId("email")}>{fieldError("email")}</p>}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-password`}>Password</label>
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          required
          minLength={mode === "sign-up" ? 10 : undefined}
          maxLength={256}
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          aria-invalid={fieldError("password") ? true : undefined}
          aria-describedby={
            fieldError("password") ? errorId("password") : mode === "sign-up" ? `${id}-password-hint` : undefined
          }
          className="rounded border px-3 py-2"
        />
        {mode === "sign-up" && !fieldError("password") && (
          <p id={`${id}-password-hint`} className="text-sm">
            At least 10 characters.
          </p>
        )}
        {fieldError("password") && <p id={errorId("password")}>{fieldError("password")}</p>}
      </div>
      {/* Where to go after signing in. The action validates it again (safeNextPath). */}
      {mode === "sign-in" && <input type="hidden" name="next" value={next ?? "/"} readOnly />}
      {/* role="alert" announces the message when it appears. */}
      {state && !state.ok && (
        <p role="alert" className="font-medium">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="rounded border px-4 py-2 font-medium disabled:opacity-60">
        {mode === "sign-up" ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}
