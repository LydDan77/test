import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` never connects to a database, so it works with no env at all.
// `drizzle-kit migrate | push | studio` connect: to hosted Postgres when DATABASE_URL is set,
// otherwise to the same embedded PGlite directory the app uses. PGlite allows one process at a
// time, so stop `next dev` before running those against the local database.
// Migrations want a direct connection; providers that give a pooled DATABASE_URL usually also
// give an un-pooled one.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const pgliteDir = process.env.PGLITE_DATA_DIR ?? "./.data/pglite";
// PGlite creates its own directory but not the parents.
if (!url && !pgliteDir.includes("://")) mkdirSync(path.dirname(pgliteDir), { recursive: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  ...(url
    ? { dbCredentials: { url } }
    : { driver: "pglite" as const, dbCredentials: { url: pgliteDir } }),
});
