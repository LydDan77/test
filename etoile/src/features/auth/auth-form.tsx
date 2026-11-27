"use client";

import { useActionState, useId, useSyncExternalStore } from "react";
import type { AuthFormState } from "./actions";

// BARE ON PURPOSE. The visual identity has not been chosen; this form only proves that
// accounts work. Whoever styles it: keep the labels ("Name", "Email", "Password") and the button
// names ("Create account", "Sign in"), because scripts/shot.mjs and e2e/auth.spec.ts find the
// controls by them.

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
/** The `?next=` target from the address bar, or "" on the server and during hydration. */
function useNextTarget(): string {
  return useSyncExternalStore(
    noSubscription,
    () => new URLSearchParams(window.location.search).get("next") ?? "",
    () => "",
  );
}

export function AuthForm({ action, mode }: { action: Action; mode: "sign-in" | "sign-up" }) {
  const [state, formAction, pending] = useActionState(action, null);
  const timeZone = useBrowserTimeZone();
  const locale = useBrowserLocale();
  const next = useNextTarget();
  const id = useId();
  const errorId = (field: string) => `${id}-${field}-error`;
  const fieldError = (field: string) => state?.fieldErrors?.[field]?.[0];

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4" noValidate={false}>
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
      {/* Where to go after signing in. The action validates it (safeNextPath) and, when this
          field is empty because the form was sent before the page was interactive, reads the
          same value from the request's Referer.
          Every field of this form is in the static shell on purpose. Never put a form field
          inside a <Suspense> boundary that streams in: until React reveals the boundary the field
          is not part of the form, and a quick submit goes without it. */}
      {mode === "sign-in" && <input type="hidden" name="next" value={next} readOnly />}
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
