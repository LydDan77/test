// Test helper. Import only from *.test.ts files.
//
//   import { afterAll, beforeAll } from "vitest";
//   import { createTestDb, type TestDb } from "@/db/testing";
//
//   let t: TestDb;
//   beforeAll(async () => { t = await createTestDb(); });
//   afterAll(() => t.close());
//
// createTestDb() opens a brand-new in-memory Postgres (PGlite), applies the real migrations
// from drizzle/, and makes it THE database for this test file: code under test that calls
// getDb() (queries, actions, the cache, the rate limiter) reaches the same database as `t.db`.
// Vitest runs each test file in its own worker, so files never see each other's rows.
// It never touches ./.data, which belongs to the development server.

import path from "node:path";
import { currentDbHandle, replaceDbHandle, schema, type Db, type DbHandle } from "./index";

export type TestDb = {
  db: Db;
  /** Closes the database. Call it in afterAll. */
  close: () => Promise<void>;
};

export async function createTestDb(): Promise<TestDb> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  const client = await PGlite.create("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

  let closed = false;
  const handle: DbHandle = {
    db,
    driver: "pglite",
    location: "memory://",
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
  replaceDbHandle(handle);

  return {
    db,
    close: async () => {
      // Only clear the process-wide handle if it is still this database.
      const current = await currentDbHandle()?.catch(() => null);
      if (current === handle) replaceDbHandle(null);
      await handle.close();
    },
  };
}
