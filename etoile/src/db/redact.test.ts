import { inspect } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation, redactQueryError } from "./errors";
import { schema } from "./index";
import { installQueryErrorRedaction, keepsQueryErrorDetails } from "./redact";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
afterEach(() => vi.unstubAllEnvs());

const home = { kind: "home" as const, name: "Chicago", tz: "America/Chicago" };
const SECRET_HASH = "scrypt$131072$8$1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5";

const failure = (promise: PromiseLike<unknown>) => Promise.resolve(promise).then(
  () => {
    throw new Error("expected the statement to fail");
  },
  (error: unknown) => error as Error & { query?: string; params?: unknown[]; cause?: Error & Record<string, unknown> },
);

/** Everything Node would print for an error: message, stack, own properties, the cause chain. */
const printed = (error: unknown) => `${inspect(error, { depth: 10, breakLength: Infinity })}\n${String((error as Error).stack)}\n${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`;

describe("a statement that fails", () => {
  it("is installed, and stays installed when asked twice", () => {
    expect(installQueryErrorRedaction()).toBe(true);
    expect(installQueryErrorRedaction()).toBe(true);
  });

  it("throws an error without the values it carried: a refused name does not put the email or the password hash in the log", async () => {
    // U+0000 is the case that was found: validation let it through, Postgres refuses it.
    const error = await failure(
      t.db.insert(schema.users).values({ email: "nul-prod@example.com", name: "Nul\u0000Name", passwordHash: SECRET_HASH, home }),
    );
    const text = printed(error);
    for (const secret of ["nul-prod@example.com", SECRET_HASH, "a2V5a2V5", "Nul", "Chicago"]) expect(text, secret).not.toContain(secret);
    expect(text).not.toMatch(/\nparams: /); // drizzle's own "params: a,b,c" line is gone from the message
    expect(error.params).toEqual([]);

    // What is left says which statement failed and why.
    expect(error.message).toMatch(/^Failed query: insert into "users" \("id", "email", /);
    expect(error.message).toMatch(/\[\d+ values not shown\]: 22021 /);
    expect(error.query).toContain('insert into "users"');
    expect(error.query).toContain("$1");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause!.code).toBe("22021");
    expect(error.stack).toContain("\n    at "); // still says where it came from
    expect(error.stack!.startsWith(`${error.name}: Failed query: insert into "users"`)).toBe(true);
  });

  it("keeps the SQLSTATE and the constraint, so a taken email is still told from a real failure", async () => {
    await t.db.insert(schema.users).values({ email: "taken@example.com", name: "First", passwordHash: SECRET_HASH, home });

    const duplicate = await failure(t.db.insert(schema.users).values({ email: "taken@example.com", name: "Second Person", passwordHash: SECRET_HASH, home }));
    expect(isUniqueViolation(duplicate)).toBe(true);
    expect(duplicate.cause).toMatchObject({ code: "23505", constraint: "users_email_unique" });
    // The driver's detail line ("Key (email)=(taken@example.com) already exists.") is gone.
    expect(duplicate.cause).not.toHaveProperty("detail");
    expect(printed(duplicate)).not.toContain("taken@example.com");
    expect(printed(duplicate)).not.toContain("Second Person");

    const upper = await failure(t.db.insert(schema.users).values({ email: "Upper@Example.com", name: "Upper Case", passwordHash: SECRET_HASH, home }));
    expect(isCheckViolation(upper)).toBe(true);
    expect(upper.cause).toMatchObject({ code: "23514", constraint: "users_email_lowercase" });
    // "Failing row contains (…)" would have been the whole row, hash included.
    expect(printed(upper)).not.toContain("Upper@Example.com");
    expect(printed(upper)).not.toContain(SECRET_HASH);

    const orphan = await failure(t.db.insert(schema.sessions).values({ tokenHash: "secret-token-hash", userId: "nobody-at-all", expiresAt: new Date() }));
    expect(isForeignKeyViolation(orphan)).toBe(true);
    expect(printed(orphan)).not.toContain("secret-token-hash");
    expect(printed(orphan)).not.toContain("nobody-at-all");
  });

  it("is cleaned inside a transaction and for db.execute as well", async () => {
    const { sql } = await import("drizzle-orm");
    const inTransaction = await failure(
      t.db.transaction(async (tx) => {
        await tx.insert(schema.users).values({ email: "tx@example.com", name: "Tx\u0000", passwordHash: SECRET_HASH, home });
      }),
    );
    expect(printed(inTransaction)).not.toContain("tx@example.com");
    expect(printed(inTransaction)).not.toContain(SECRET_HASH);
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "tx@example.com"))).toEqual([]);

    const raw = await failure(t.db.execute(sql`select ${"door code 4471"}::integer`));
    expect(printed(raw)).not.toContain("4471");
    expect(raw.cause!.code).toBe("22P02");
    expect(raw.cause!.message).toBe("invalid input syntax for type integer");
  });

  it("can be switched off for debugging, but never in a production build", () => {
    expect(keepsQueryErrorDetails()).toBe(false);
    vi.stubEnv("DB_ERROR_DETAILS", "1");
    expect(keepsQueryErrorDetails()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(keepsQueryErrorDetails()).toBe(false);
  });

  it("leaves the values in when that switch is on", async () => {
    vi.stubEnv("DB_ERROR_DETAILS", "1");
    const error = await failure(t.db.insert(schema.users).values({ email: "debug@example.com", name: "Nul\u0000", passwordHash: "x", home }));
    expect(error.params).toContain("debug@example.com");
  });
});

describe("redactQueryError", () => {
  it("returns anything that is not a failed-query error untouched", () => {
    const plain = new Error("something else");
    expect(redactQueryError(plain)).toBe(plain);
    expect(plain.message).toBe("something else");
    for (const value of [null, undefined, "text", 42]) expect(redactQueryError(value)).toBe(value);
  });

  it("cleans the shape drizzle and the Postgres drivers produce", () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint "parties_guest_token_unique"'), {
      code: "23505",
      detail: "Key (guest_token)=(Zm9yZ2VkLWd1ZXN0LXRva2Vu) already exists.",
      where: "COPY parties, line 1: \"x, Zm9yZ2VkLWd1ZXN0LXRva2Vu\"",
      constraint: "parties_guest_token_unique",
      table: "parties",
      query: "insert …",
      params: ["Zm9yZ2VkLWd1ZXN0LXRva2Vu"],
    });
    const error = Object.assign(new Error('Failed query: insert into "parties" ("id", "guest_token") values ($1, $2)\nparams: p1,Zm9yZ2VkLWd1ZXN0LXRva2Vu'), {
      query: 'insert into "parties" ("id", "guest_token") values ($1, $2)',
      params: ["p1", "Zm9yZ2VkLWd1ZXN0LXRva2Vu"],
      cause: driver,
    });
    const cleaned = redactQueryError(error) as typeof error;
    expect(cleaned).toBe(error);
    expect(printed(cleaned)).not.toContain("Zm9yZ2VkLWd1ZXN0LXRva2Vu");
    expect(cleaned.message).toBe(
      'Failed query: insert into "parties" ("id", "guest_token") values ($1, $2) [2 values not shown]: 23505 duplicate key value violates unique constraint "parties_guest_token_unique"',
    );
    expect(cleaned.cause).toMatchObject({ code: "23505", constraint: "parties_guest_token_unique", table: "parties" });
    expect(isUniqueViolation(cleaned)).toBe(true);
  });
});
