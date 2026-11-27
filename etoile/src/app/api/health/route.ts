import { sql } from "drizzle-orm";
import { getDbHandle } from "@/db";
import { BRAND } from "@/lib/brand";

// 200 with { ok: true, app: "etoile" } when the server is up and the database answers.
// scripts/dev-ensure.sh and Playwright wait on this; the first call also opens and migrates
// the local database, so tests never race the migration.
//
// With Cache Components a GET handler is prerendered unless it touches request data or
// uncached I/O. Reading `request.url` pins this one to request time.
export async function GET(request: Request) {
  const verbose = new URL(request.url).searchParams.has("verbose");
  try {
    const { db, driver, location } = await getDbHandle();
    const started = performance.now();
    await db.execute(sql`select 1`);
    return Response.json({
      ok: true,
      app: BRAND.ascii,
      driver,
      ...(verbose ? { location } : {}),
      queryMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json({ ok: false, app: BRAND.ascii }, { status: 503 });
  }
}
