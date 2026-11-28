import { PgPreparedQuery } from "drizzle-orm/pg-core";
import { redactQueryError } from "./errors";

// Applies redactQueryError() to every statement the app runs, in one place.
//
// drizzle-orm builds its "Failed query … params: …" error inside PgPreparedQuery.queryWithCache,
// which both drivers (PGlite and node-postgres) go through for every query, db.execute() and
// the statements of a transaction. That one method is wrapped here, once per process, so the
// error is cleaned before any caller, or any log, can see it. There is no public hook for this;
// src/db/redact.test.ts fails loudly if a drizzle upgrade moves the method.
//
// DB_ERROR_DETAILS=1 switches the cleaning off, for debugging on a development machine. It is
// ignored in a production build.

type QueryWithCache = (queryString: string, params: unknown[], query: () => Promise<unknown>) => Promise<unknown>;
type Patchable = { queryWithCache?: QueryWithCache; __etoileRedacts?: boolean };

/** True when failed-query errors are left as drizzle made them (development only). */
export function keepsQueryErrorDetails(): boolean {
  return process.env.DB_ERROR_DETAILS === "1" && process.env.NODE_ENV !== "production";
}

/** Returns true when the wrapper is in place (now or from an earlier call). */
export function installQueryErrorRedaction(): boolean {
  const prototype = PgPreparedQuery.prototype as unknown as Patchable;
  if (prototype.__etoileRedacts) return true;
  const original = prototype.queryWithCache;
  if (typeof original !== "function") {
    console.error("[db] could not install query-error redaction: drizzle-orm no longer has PgPreparedQuery.queryWithCache. Failed statements may log their values.");
    return false;
  }
  prototype.queryWithCache = async function (this: unknown, queryString, params, query) {
    try {
      return await original.call(this, queryString, params, query);
    } catch (error) {
      throw keepsQueryErrorDetails() ? error : redactQueryError(error);
    }
  };
  Object.defineProperty(prototype, "__etoileRedacts", { value: true, enumerable: false });
  return true;
}
