import { defineConfig, devices } from "@playwright/test";

// Two ways to run the end-to-end specs:
//
//   npm run e2e                              builds, then tests a production server
//                                            (`next start` on port 3411, its own database)
//   E2E_MODE=dev npx playwright test e2e/x.spec.ts
//                                            tests the shared development server on port 3000,
//                                            the one scripts/dev-ensure.sh keeps running.
//                                            This is the mode to use while building a feature.
//
// Never `npx playwright install`: the browser is already on this machine, and @playwright/test
// is pinned to the version that matches it.
const mode = process.env.E2E_MODE === "dev" ? "dev" : "start";

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
