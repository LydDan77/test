import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { io } from "next/cache";
import * as schema from "./schema";

export { schema };

/**
 * One database type for the whole app. Both drivers extend PgDatabase, so the query builder,
 * relational queries (`db.query.*`) and `db.transaction` are typed identically. Do not use
 * driver-specific members (`$client`, the raw shape returned by `db.execute`) outside this file.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle = {
  db: Db;
  driver: "pglite" | "node-postgres";
  /** Where the data lives, for diagnostics. Never contains credentials. */
  location: string;
  close: () => Promise<void>;
};

/** drizzle-kit writes here; both migrators read from here. */
const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** Arbitrary constant: serialises concurrent `migrate()` calls from parallel cold starts. */
const MIGRATION_LOCK_ID = 727_274_001;

// `next dev` re-evaluates modules on every edit. Anything kept in module scope would be
// re-created (and PGlite would open the same data directory twice), so the handle lives on
// globalThis, which survives hot reload.
const globalForDb = globalThis as typeof globalThis & {
  __etoileDb?: Promise<DbHandle>;
};

function pgliteDataDir(): string {
  const configured = process.env.PGLITE_DATA_DIR;
  if (configured) return configured; // "memory://" gives a throwaway in-memory database
  return path.join(process.cwd(), ".data", "pglite");
}

async function openPglite(): Promise<DbHandle> {
  if (process.env.VERCEL) {
    throw new Error(
      "DATABASE_URL is not set. The embedded PGlite database is for local development only: " +
        "a Vercel function has a read-only, per-instance file system.",
    );
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  const dataDir = pgliteDataDir();
  if (!dataDir.includes("://")) mkdirSync(dataDir, { recursive: true });

  const client = await PGlite.create(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    driver: "pglite",
    location: dataDir,
    close: () => client.close(),
  };
}

/**
 * Hosted Postgres: migrate when the first query arrives?
 *  - local and CI Postgres: yes (same zero-setup behaviour as PGlite);
 *  - Vercel: no. Run `drizzle-kit migrate` in the build step against the direct (un-pooled)
 *    connection instead, so a deploy fails before it goes live if a migration fails.
 * DB_MIGRATE_ON_BOOT=1 or =0 overrides either default.
 */
function migrateOnBoot(): boolean {
  const flag = process.env.DB_MIGRATE_ON_BOOT;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !process.env.VERCEL;
}

async function openPostgres(connectionString: string): Promise<DbHandle> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");

  const pool = new Pool({
    connectionString,
    // A serverless instance handles few requests at once; keep the pool small so many
    // instances do not exhaust the server's connection limit. Use the provider's pooled
    // (PgBouncer) connection string in production.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // Without a listener an idle-client error (server restart, network drop) crashes the process.
  pool.on("error", (err) => console.error("[db] idle client error", err));

  if (process.env.VERCEL) {
    // From the @vercel/functions docs: "ensures that the current function instance stays alive
    // long enough for idle database connections to be removed from the pool".
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  }

  const db = drizzle(pool, { schema });

  if (migrateOnBoot()) {
    // drizzle's migrator is not safe to run concurrently, so take a session-level advisory
    // lock on one dedicated connection and migrate through that same connection.
    // A session lock needs a direct connection: behind a transaction-mode pooler (PgBouncer,
    // the "pooled" URL of Neon or Supabase) it can be acquired and released on different
    // server connections. That is why this is off by default on Vercel.
    const client = await pool.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      await migrate(drizzle(client, { schema }), {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    } finally {
      await client
        .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
        .catch(() => {});
      client.release();
    }
  }

  let host = "postgres";
  try {
    host = new URL(connectionString).host;
  } catch {
    // keep the placeholder; never echo an unparseable connection string
  }

  return {
    db,
    driver: "node-postgres",
    location: host,
    close: () => pool.end(),
  };
}

/** Opens the database once per process (and once per dev server, across hot reloads). */
export function getDbHandle(): Promise<DbHandle> {
  if (!globalForDb.__etoileDb) {
    const url = process.env.DATABASE_URL;
    const opening = url ? openPostgres(url) : openPglite();
    globalForDb.__etoileDb = opening;
    // Do not cache a failure: the next call should try again.
    opening.catch(() => {
      if (globalForDb.__etoileDb === opening) {
        globalForDb.__etoileDb = undefined;
      }
    });
  }
  return globalForDb.__etoileDb;
}

/**
 * The one way application code reaches the database.
 *
 * `await io()` tells Next.js (Cache Components) that what follows is live I/O:
 *  - while prerendering (next build, the dev-time validation render, link prefetches) it
 *    suspends here, so the database is never opened by `next build` and no query result or
 *    `new Date()` that follows can be frozen into a static shell;
 *  - at request time, inside "use cache", and outside Next.js (Vitest) it resolves immediately.
 * The consequence: every component that calls getDb() outside "use cache" must be inside <Suspense>.
 */
export async function getDb(): Promise<Db> {
  await io();
  return (await getDbHandle()).db;
}

/**
 * Replaces the process-wide database handle. For src/db/testing.ts only: createTestDb() uses it
 * so that code under test, which calls getDb(), reaches the test database. Never call it from
 * application code.
 */
export function replaceDbHandle(handle: DbHandle | null): void {
  globalForDb.__etoileDb = handle ? Promise.resolve(handle) : undefined;
}
