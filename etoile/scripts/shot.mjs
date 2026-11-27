#!/usr/bin/env node
// Look at your work: four full-page screenshots of one page of the running app.
//
//   node scripts/shot.mjs <path> [--name label] [--user existing@email] [options]
//
//   node scripts/shot.mjs /                         Home, as a brand-new test account
//   node scripts/shot.mjs /plans --name plans       saves plans-desktop-light.png and three more
//   node scripts/shot.mjs /plans --user e2e-abc@example.com
//                                                   as an account an earlier run created
//   node scripts/shot.mjs /hartley-christmas --signed-out
//                                                   as a visitor with no account
//
// What it does
//   1. runs scripts/dev-ensure.sh, so the one shared development server is up;
//   2. makes a fresh test account through the real sign-up form (or signs in with --user);
//   3. opens <path> and saves
//        <label>-desktop-light.png   <label>-desktop-dark.png     1440 px wide
//        <label>-phone-light.png     <label>-phone-dark.png        390 px wide
//      as full-page screenshots, then prints the files and any errors the page logged.
//
// Options
//   --name <label>     file name prefix (default: made from the path; "/" gives "home")
//   --user <email>     sign in as this account instead of creating one
//   --password <text>  its password (default: the password every test account gets)
//   --signed-out       do not sign in at all
//   --tz <zone>        browser time zone (default America/Chicago)
//   --wait <ms>        extra time to wait before each screenshot (default 0)
//   --out <dir>        where to save (default: $SHOTS_DIR, or the session's shots folder)
//
// The forms are found by role and label ("Name", "Email", "Password", "Create account",
// "Sign in"), never by CSS or test ids, so restyling the pages does not break this tool.
// It uses the Playwright that is already installed; it never downloads a browser.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "http://localhost:3000"; // localhost, not 127.0.0.1: see scripts/dev-ensure.sh
const TEST_PASSWORD = "correct horse battery staple";
const SESSION_SHOTS = "/tmp/claude-0/-home-user-test/43fcb38d-b333-5865-9305-e92730c64f27/scratchpad/shots";

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
};
const SCHEMES = ["light", "dark"];

function usage(message) {
  if (message) console.error(`shot: ${message}\n`);
  console.error("usage: node scripts/shot.mjs <path> [--name label] [--user existing@email]");
  console.error("       [--password text] [--signed-out] [--tz zone] [--wait ms] [--out dir]");
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = { path: null, name: null, user: null, password: TEST_PASSWORD, signedOut: false, tz: "America/Chicago", wait: 0, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) usage(`${arg} needs a value`);
      return next;
    };
    if (arg === "-h" || arg === "--help") usage();
    else if (arg === "--name") options.name = value();
    else if (arg === "--user") options.user = value();
    else if (arg === "--password") options.password = value();
    else if (arg === "--signed-out") options.signedOut = true;
    else if (arg === "--tz") options.tz = value();
    else if (arg === "--wait") options.wait = Number(value());
    else if (arg === "--out") options.out = value();
    else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else if (options.path === null) options.path = arg;
    else usage(`unexpected argument ${arg}`);
  }
  if (!options.path) usage("give the path to open, for example /");
  if (!options.path.startsWith("/")) usage(`the path must start with "/": ${options.path}`);
  if (!Number.isFinite(options.wait) || options.wait < 0) usage("--wait needs a number of milliseconds");
  if (options.user && options.signedOut) usage("--user and --signed-out cannot be used together");
  return options;
}

/** "/" -> "home", "/plans/abc/flights?step=2" -> "plans-abc-flights". */
function labelFromPath(target) {
  const clean = target.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  const label = clean.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return label || "home";
}

function outputDir(option) {
  if (option) return path.resolve(option);
  if (process.env.SHOTS_DIR) return path.resolve(process.env.SHOTS_DIR);
  // The session's shared shots folder when its scratchpad exists, otherwise ./.shots.
  return existsSync(path.dirname(SESSION_SHOTS)) ? SESSION_SHOTS : path.join(ROOT, ".shots");
}

async function hasSession(context) {
  return (await context.cookies(BASE_URL)).some((cookie) => cookie.name.endsWith("etoile_session"));
}

async function waitForSession(context, what) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await hasSession(context)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what} did not sign in within 30 s`);
}

/** The text of the form's own error message, if it is showing one. */
async function formError(page) {
  const alerts = page.locator("form").getByRole("alert");
  return (await alerts.count()) > 0 ? (await alerts.first().innerText()).trim() : null;
}

async function fillPasswords(page, password) {
  // One field today; a "confirm password" field later would be a second one.
  for (const field of await page.getByLabel(/password/i).all()) await field.fill(password);
}

async function signUp(context, account) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/sign-up`, { waitUntil: "load" });
  await page.getByRole("textbox", { name: /name/i }).first().fill(account.name);
  await page.getByRole("textbox", { name: /e-?mail/i }).fill(account.email);
  await fillPasswords(page, account.password);
  await page.getByRole("button", { name: /create (an )?account|sign up|get started/i }).click();
  try {
    await waitForSession(context, "Sign-up");
  } catch (error) {
    const shown = await formError(page);
    throw new Error(shown ? `Sign-up was refused: "${shown}"` : error.message);
  }
  await page.close();
}

async function signIn(context, account) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/sign-in`, { waitUntil: "load" });
  await page.getByRole("textbox", { name: /e-?mail/i }).fill(account.email);
  await fillPasswords(page, account.password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  try {
    await waitForSession(context, "Sign-in");
  } catch (error) {
    const shown = await formError(page);
    throw new Error(shown ? `Sign-in as ${account.email} was refused: "${shown}"` : error.message);
  }
  await page.close();
}

async function settle(page, extraWait) {
  // The document finishes loading when every streamed <Suspense> boundary has arrived.
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  // Let hydration and any first effect paint.
  await page.waitForTimeout(250 + extraWait);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const label = (options.name ?? labelFromPath(options.path)).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const outDir = outputDir(options.out);
  mkdirSync(outDir, { recursive: true });

  // 1. One shared development server.
  execFileSync("bash", [path.join(ROOT, "scripts", "dev-ensure.sh")], { stdio: "inherit" });

  const browser = await chromium.launch();
  try {
    const common = { baseURL: BASE_URL, locale: "en-US", timezoneId: options.tz };

    // 2. Sign in once; the four screenshots reuse the session.
    let storageState;
    if (!options.signedOut) {
      const setup = await browser.newContext({ ...common, ...VIEWPORTS.desktop, colorScheme: "light" });
      if (options.user) {
        await signIn(setup, { email: options.user, password: options.password });
        console.log(`shot: signed in as ${options.user}`);
      } else {
        const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const account = { name: "Lydia Hartley", email: `shot-${unique}@example.com`, password: options.password };
        await signUp(setup, account);
        console.log(`shot: created test account ${account.email} (reuse it with --user ${account.email})`);
      }
      storageState = await setup.storageState();
      await setup.close();
    }

    // 3. Four screenshots.
    const saved = [];
    const problems = new Set();
    for (const [device, settings] of Object.entries(VIEWPORTS)) {
      for (const colorScheme of SCHEMES) {
        const context = await browser.newContext({ ...common, ...settings, colorScheme, storageState });
        const page = await context.newPage();
        page.on("pageerror", (error) => problems.add(`page error: ${error.message}`));
        page.on("console", (message) => {
          if (message.type() === "error") problems.add(`console error: ${message.text()}`);
        });
        const response = await page.goto(`${BASE_URL}${options.path}`, { waitUntil: "load" });
        await settle(page, options.wait);
        const status = response?.status() ?? 0;
        if (status >= 400) problems.add(`the page answered HTTP ${status}`);
        const finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
        if (finalPath !== options.path) problems.add(`redirected to ${finalPath}`);

        const file = path.join(outDir, `${label}-${device}-${colorScheme}.png`);
        await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
        saved.push(file);
        await context.close();
      }
    }

    console.log(`shot: ${options.path}`);
    for (const file of saved) console.log(`  ${file}`);
    if (problems.size > 0) {
      console.log("shot: the page reported:");
      for (const problem of problems) console.log(`  ${problem}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`shot: ${error?.message ?? error}`);
  process.exit(1);
});
