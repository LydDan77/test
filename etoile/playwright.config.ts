import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Two ways to run the end-to-end specs:
//
//   E2E_MODE=dev npx playwright test e2e/x.spec.ts      (or simply: npx playwright test e2e/x.spec.ts)
//                                            tests the shared development server on port 3000,
//                                            the one scripts/dev-ensure.sh keeps running.
//                                            This is the mode to use while building a feature,
//                                            and it is the default.
//   npm run e2e                              builds, then tests a production server
//                                            (`next start` on port 3411, its own database)
//
// Which one runs: E2E_MODE=dev or E2E_MODE=start if it is set; otherwise "start" under
// `npm run e2e` and in CI, and "dev" everywhere else. The default used to be "start", which
// serves whatever build happens to be in .next: with the variable forgotten, a spec was run
// against an old build that had none of the routes it was written for.
//
// Never `npx playwright install`: the browser is already on this machine, and @playwright/test
// is pinned to the version that matches it.
function chooseMode(): "dev" | "start" {
  const asked = process.env.E2E_MODE;
  if (asked === "dev" || asked === "start") return asked;
  if (asked) throw new Error(`E2E_MODE must be "dev" or "start", not "${asked}"`);
  if (process.env.CI || process.env.npm_lifecycle_event === "e2e") return "start";
  return "dev";
}
const mode = chooseMode();
// Specs and the global setup read this (ensure-dev-server.ts, auth.spec.ts).
process.env.E2E_MODE = mode;

/** The newest change under a folder, in milliseconds since 1970. */
function newestChange(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestChange(full));
    else newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

// In start mode the server is `next start` on the build in .next. Refuse to test a build that
// is missing or older than the source: it would pass or fail for reasons that have nothing to
// do with the code in front of you. (Only checked in the main process, once.)
if (mode === "start" && !process.env.E2E_BUILD_CHECKED) {
  process.env.E2E_BUILD_CHECKED = "1";
  const buildId = path.join(__dirname, ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    throw new Error("E2E start mode needs a production build and there is none in .next. Run `npm run e2e` (it builds first), or use E2E_MODE=dev.");
  }
  const built = statSync(buildId).mtimeMs;
  const changed = Math.max(newestChange(path.join(__dirname, "src")), statSync(path.join(__dirname, "next.config.ts")).mtimeMs);
  if (changed > built) {
    throw new Error(
      `E2E start mode would test a stale build: .next was built at ${new Date(built).toISOString()} and the source changed at ` +
        `${new Date(changed).toISOString()}. Run \`npm run e2e\` (it builds first), or use E2E_MODE=dev to test the development server.`,
    );
  }
}

// E2E_PORT moves the production-mode server so several checkouts can run side by side.
// The development server is always on 3000.
const port = mode === "dev" ? 3000 : Number(process.env.E2E_PORT ?? 3411);

// Use "localhost", not 127.0.0.1: `next dev` blocks its own dev resources (/_next/*, HMR) for
// any host that is not listed in allowedDevOrigins, and the page then never hydrates.
const baseURL = `http://localhost:${port}`;

// Several people run their own spec against the development server at the same time. Playwright
// empties its output folder when a run starts, so each run gets a folder of its own.
// (Set here, in the main process; worker processes inherit it through the environment.)
const runId = (process.env.E2E_RUN_ID ??= `${Date.now().toString(36)}-${process.pid}`);

export default defineConfig({
  testDir: "./e2e",
  outputDir: mode === "dev" ? `./test-results/dev-${runId}` : "./test-results/start",
  fullyParallel: false,
  workers: 1, // one embedded database, one writer
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: mode === "dev" ? 60_000 : 30_000, // the development server compiles pages on first visit
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Development mode: make sure the one shared server is up (scripts/dev-ensure.sh) and leave
  // it running afterwards. Playwright must not start or stop a server of its own here.
  globalSetup: mode === "dev" ? "./e2e/support/ensure-dev-server.ts" : undefined,

  // Production mode: Playwright starts `next start` on the existing .next build and stops it
  // when the run ends. Run `npm run build` first (`npm run e2e` does).
  webServer:
    mode === "dev"
      ? undefined
      : {
          command: `npx next start -p ${port}`,
          url: `${baseURL}/api/health`,
          // Always a fresh server on the fresh build. Reusing one that happens to be on the
          // port would test whatever build that process loaded, with server-action ids that
          // no longer match. If the port is taken, Playwright says so and stops.
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            NEXT_TELEMETRY_DISABLED: "1",
            // A separate throwaway database for end-to-end runs; never the development one.
            PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR ?? "./.data/pglite-e2e",
            // `next start` sets NODE_ENV=production; the test server is plain http on localhost.
            SESSION_COOKIE_INSECURE: "1",
            // Every spec signs up from the same address.
            RATE_LIMIT_DISABLED: "1",
          },
        },
});
