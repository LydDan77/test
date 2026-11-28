// Reading database errors without depending on a driver. Works for PGlite and node-postgres.

function sqlState(error: unknown): string | null {
  // drizzle-orm wraps driver errors (DrizzleQueryError) and keeps the original in `cause`.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True when a unique constraint was violated (SQLSTATE 23505): a taken email or slug. */
export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === "23505";
}

/** True when a foreign key was violated (SQLSTATE 23503): the row points at something that is gone. */
export function isForeignKeyViolation(error: unknown): boolean {
  return sqlState(error) === "23503";
}

/** True when a CHECK constraint was violated (SQLSTATE 23514). */
export function isCheckViolation(error: unknown): boolean {
  return sqlState(error) === "23514";
}

// --- keeping values out of the log ------------------------------------------------------------------
//
// When a statement fails, drizzle-orm throws an error whose message is the statement followed by
// every value it carried ("params: …"), with the same values again in a `params` property and,
// from the driver, in `detail` ("Key (email)=(lydia@example.com) already exists", "Failing row
// contains (…)"). An error nobody catches is printed by Next.js, so one bad statement would
// write an email address and a complete password hash to the server log; later it would be
// guest tokens, confirmation codes, private notes and door codes.
//
// redactQueryError() strips all of that from the error and keeps what a person debugging needs:
// which statement, the SQLSTATE, and the names of the constraint, table and column.
// src/db/redact.ts applies it to every query the app runs.

const KEPT_DRIVER_FIELDS = ["code", "severity", "constraint", "table", "column", "schema", "dataType", "routine"] as const;

/** The frames of a stack, without the first line (which repeats the original message). */
function framesOf(stack: unknown): string {
  if (typeof stack !== "string") return "";
  const at = stack.search(/\n\s+at /);
  return at === -1 ? "" : stack.slice(at);
}

/** A driver's message with any quoted value cut off. Identifiers (constraint, table) stay. */
function safeDriverMessage(message: unknown, code: unknown): string {
  let text = typeof message === "string" && message ? message : "database error";
  // Class 22 (data exception) messages end in the offending value:
  // `invalid input syntax for type integer: "abc"`, `invalid byte sequence for encoding "UTF8": 0x00`.
  if (typeof code === "string" && code.startsWith("22")) text = text.split(/:\s/)[0];
  text = text.split("\n")[0];
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** A copy of a driver error holding only what cannot contain a value from the statement. */
function safeDriverError(cause: unknown): Error {
  if (cause === null || typeof cause !== "object") return new Error("database error");
  const source = cause as Record<string, unknown>;
  const safe = new Error(safeDriverMessage(source.message, source.code));
  safe.name = typeof source.name === "string" ? source.name : "Error";
  safe.stack = `${safe.name}: ${safe.message}${framesOf(source.stack)}`;
  for (const field of KEPT_DRIVER_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.length <= 200) Object.defineProperty(safe, field, { value, enumerable: true, writable: true, configurable: true });
  }
  return safe;
}

/**
 * Removes from a failed-query error everything that could hold a value: the `params`, the
 * values in the message and in the stack's first line, and the driver's `detail`, `where` and
 * friends. The error object itself is kept (same class, same stack frames), `cause.code` still
 * carries the SQLSTATE, so isUniqueViolation() and the others work on the result.
 * Anything that is not a failed-query error is returned untouched.
 */
export function redactQueryError(error: unknown): unknown {
  if (error === null || typeof error !== "object") return error;
  const failed = error as { query?: unknown; params?: unknown; cause?: unknown; message?: string; stack?: string; name?: string };
  if (typeof failed.query !== "string" || !Array.isArray(failed.params)) return error;

  const cause = safeDriverError(failed.cause);
  const code = (cause as { code?: string }).code;
  const statement = failed.query.replace(/\s+/g, " ").trim();
  const summary = statement.length > 200 ? `${statement.slice(0, 200)}…` : statement;
  const message = `Failed query: ${summary} [${failed.params.length} values not shown]: ${code ? `${code} ` : ""}${cause.message}`;
  const frames = framesOf(failed.stack);

  failed.message = message;
  failed.stack = `${failed.name ?? "Error"}: ${message}${frames}`;
  failed.params = [];
  failed.cause = cause;
  return error;
}
