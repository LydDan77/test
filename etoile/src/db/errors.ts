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
