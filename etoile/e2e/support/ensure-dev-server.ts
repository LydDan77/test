import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// Playwright global setup for E2E_MODE=dev.
//
// 1. Makes sure the shared development server is running. scripts/dev-ensure.sh holds a lock,
//    so several test runs starting together still share one server, and nobody stops it.
// 2. Keeps test-results/ tidy. Every dev-mode run writes to a folder of its own (see
//    playwright.config.ts), because several people run specs at the same time. Folders left by
//    earlier runs are cleared here: at once when they hold no failure artefacts, after a day
//    when they do.

const ROOT = path.join(__dirname, "..", "..");
const RESULTS = path.join(ROOT, "test-results");
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function removeOldRuns(): void {
  if (!existsSync(RESULTS)) return;
  for (const entry of readdirSync(RESULTS)) {
    if (!entry.startsWith("dev-")) continue;
    const dir = path.join(RESULTS, entry);
    try {
      const age = Date.now() - statSync(dir).mtimeMs;
      // A passing run leaves only Playwright's own .last-run.json.
      const clean = readdirSync(dir).every((file) => file === ".last-run.json");
      // Ten minutes' grace so a run that is still going is never touched.
      if ((clean && age > 10 * MINUTE_MS) || age > DAY_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another run may be removing the same folder; nothing to do.
    }
  }
}

export default function ensureDevServer(): void {
  execFileSync("bash", [path.join(ROOT, "scripts", "dev-ensure.sh")], { stdio: "inherit" });
  removeOldRuns();
}
