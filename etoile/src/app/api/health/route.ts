import { sql } from "drizzle-orm";
import { getDbHandle } from "@/db";
import { BRAND } from "@/lib/brand";

// 200 with { ok: true, app: "etoile" } when the server is up and the database answers.
// scripts/dev-ensure.sh and Playwright wait on this; the first call also opens and migrates
// the local database, so tests never race the migration.
//
// Anyone can call this, signed in or not, so it says nothing else: not which database driver
// is in use, and never where the database lives (the data directory's path, or the host and
// port of a hosted Postgres). Outside a production build, `?verbose` adds the driver and how
// long the query took, for whoever is working on the machine.
//
// With Cache Components a GET handler is prerendered unless it touches request data or
// uncached I/O. Reading `request.url` pins this one to request time.
export async function GET(request: Request) {
  const verbose = process.env.NODE_ENV !== "production" && new URL(request.url).searchParams.has("verbose");
  try {
    const { db, driver } = await getDbHandle();
    const started = performance.now();
    await db.execute(sql`select 1`);
    return Response.json({
      ok: true,
      app: BRAND.ascii,
      ...(verbose ? { driver, queryMs: Math.round(performance.now() - started) } : {}),
    });
  } catch (error) {
    console.error("[health] database check failed:", error instanceof Error ? error.message : error);
    return Response.json({ ok: false, app: BRAND.ascii }, { status: 503 });
  }
}
