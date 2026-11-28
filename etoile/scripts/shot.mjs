#!/usr/bin/env node
// Look at your work: four full-page screenshots of one page of the running app.
//
//   node scripts/shot.mjs <path> [--name label] [--user existing@email] [options]
//
//   node scripts/shot.mjs /                         Home, as a brand-new test account
//   node scripts/shot.mjs /plans --name plans       saves plans-<run>-desktop-light.png and three more
//   node scripts/shot.mjs /plans --user e2e-abc@example.com
//                                                   as an account an earlier run created
//   node scripts/shot.mjs /hartley-christmas --signed-out
//                                                   as a visitor with no account
//
// What it does
//   1. runs scripts/dev-ensure.sh, so the one shared development server is up;
//   2. makes a fresh test account through the real sign-up form (or signs in with --user);
//   3. opens <path> and saves
//        <label>-<run>-desktop-light.png   <label>-<run>-desktop-dark.png     1440 px wide
//        <label>-<run>-phone-light.png     <label>-<run>-phone-dark.png        390 px wide
//      as full-page screenshots, then prints the files and any errors the page logged.
//      <run> is four characters that are new on every run: several people share one folder,
//      and two of them shooting "/" must not overwrite each other. Open the paths it prints.
//
// It exits 1, after saving the screenshots, when the page answered with an error (HTTP 400 or
// above) or sent the browser somewhere else (to sign-in, for example): a picture of the wrong
// page is not a result. Pass --allow-errors when that page is what you meant to look at.
//
// Options
//   --name <label>     file name prefix (default: made from the path; "/" gives "home")
//   --exact            save as <label>-desktop-light.png …, without <run>, replacing what is there
//   --user <email>     sign in as this account instead of creating one
//   --password <text>  its password (default: the password every test account gets)
//   --signed-out       do not sign in at all
//   --allow-errors     exit 0 even when the page is an error page or a redirect
//   --tz <zone>        browser time zone (default America/Chicago)
//   --wait <ms>        extra time to wait before each screenshot (default 0)
//   --out <dir>        where to save (default: $SHOTS_DIR, or the session's shots folder)
//
// How it survives a restyle of the auth pages: it never looks for a label or a button by its
// words. It takes the form that has a password field, fills its inputs by their type (every
// password field, the email field, every other required text field, required tick boxes) and
// submits the form itself. A show-password button, a "Confirm password" field, separate first
// and last names or a "Sign in" link in the header change nothing.
// It uses the Playwright that is already installed; it never downloads a browser.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// localhost, not 127.0.0.1: see scripts/dev-ensure.sh. (SHOT_BASE_URL points the tool at another
// server; it is there for trying the tool itself on a page that is not part of the app.)
const BASE_URL = process.env.SHOT_BASE_URL ?? "http://localhost:3000";
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
  console.error("usage: node scripts/shot.mjs <path> [--name label] [--exact] [--user existing@email]");
  console.error("       [--password text] [--signed-out] [--allow-errors] [--tz zone] [--wait ms] [--out dir]");
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = { path: null, name: null, exact: false, user: null, password: TEST_PASSWORD, signedOut: false, allowErrors: false, tz: "America/Chicago", wait: 0, out: null };
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
    else if (arg === "--exact") options.exact = true;
    else if (arg === "--allow-errors") options.allowErrors = true;
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

/** The form on an auth page: the one that has a password field. */
function authForm(page) {
  return page.locator("form").filter({ has: page.locator('input[type="password"]') }).first();
}

/**
 * Fills an auth form by the kind of each input, never by its label, and submits the form
 * itself. Works for sign-in and sign-up, whatever they are restyled into.
 */
async function fillAndSubmit(page, account) {
  const form = authForm(page);
  await form.waitFor({ state: "attached", timeout: 30_000 });

  // Every password field: "Password", and "Confirm password" if there is one. Only real
  // inputs: a show-password button also carries the word, and cannot be filled.
  for (const field of await form.locator('input[type="password"]').all()) await field.fill(account.password);

  const email = form.locator('input[type="email"], input[name="email" i], input[autocomplete="email"], input[autocomplete="username"]').first();
  await email.fill(account.email);

  // Every other text field that must be filled: one "Name", or first and last name apart.
  const [first, ...rest] = (account.name ?? "Lydia Hartley").split(" ");
  const last = rest.join(" ") || first;
  const others = form.locator('input:not([type]), input[type="text"], input[type="tel"], input[type="search"]');
  for (const field of await others.all()) {
    if (!(await field.isVisible()) || !(await field.isEditable())) continue;
    if ((await field.inputValue()) !== "") continue;
    const about = (await field.evaluate((el) => `${el.name} ${el.id} ${el.autocomplete} ${el.getAttribute("aria-label") ?? ""} ${el.labels?.[0]?.textContent ?? ""}`)).toLowerCase();
    const required = await field.evaluate((el) => el.required);
    if (/last|family|surname/.test(about)) await field.fill(last);
    else if (/first|given/.test(about)) await field.fill(first);
    else if (/name/.test(about) || required) await field.fill(account.name ?? "Lydia Hartley");
  }
  // "I agree to the terms", should one appear.
  for (const box of await form.locator('input[type="checkbox"][required]').all()) await box.check();

  // Submit the form the way its own submit button would, wherever that button is and
  // whatever it says. (The page's form guard holds it until React is ready.)
  await form.evaluate((el) => el.requestSubmit());
}

async function signUp(context, account) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/sign-up`, { waitUntil: "load" });
  await fillAndSubmit(page, account);
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
  await fillAndSubmit(page, account);
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

const MAX_PAGE_HEIGHT = 20_000; // css px: a runaway page must not make a gigabyte of picture

/**
 * Makes a "full page" screenshot really show the whole page when the app scrolls INSIDE itself.
 * A phone layout with a fixed tab bar is often a 100dvh shell with one scrolling region in it:
 * the document is then exactly one screen tall, and a full-page screenshot is one screen. The
 * window is made taller by what that region still hides, so the shell grows and nothing is
 * hidden any more. A page that scrolls the document (the usual case) is left alone.
 */
async function growToFitInnerScroll(page, viewport) {
  let height = viewport.height;
  for (let attempt = 0; attempt < 4; attempt++) {
    const hidden = await page.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement;
      if (doc.scrollHeight > window.innerHeight + 1) return 0; // the document itself scrolls
      let most = 0;
      for (const el of document.querySelectorAll("body *")) {
        const extra = el.scrollHeight - el.clientHeight;
        if (extra <= 1) continue;
        const overflow = getComputedStyle(el).overflowY;
        if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") continue;
        // The main region, not a small list inside a card.
        if (el.clientWidth < window.innerWidth * 0.5 || el.clientHeight < window.innerHeight * 0.4) continue;
        most = Math.max(most, extra);
      }
      return most;
    });
    if (hidden <= 0 || height >= MAX_PAGE_HEIGHT) break;
    height = Math.min(MAX_PAGE_HEIGHT, height + Math.ceil(hidden));
    await page.setViewportSize({ width: viewport.width, height });
    await page.waitForTimeout(100);
  }
  return height;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = (options.name ?? labelFromPath(options.path)).replace(/[^a-zA-Z0-9._-]+/g, "-");
  // Four characters, new on every run: this folder is shared, and "home" is everybody's name.
  const run = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const label = options.exact ? base : `${base}-${run}`;
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
    const failures = new Set(); // the page is not the one that was asked for
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
        if (status >= 400) failures.add(`the page answered HTTP ${status}`);
        const finalUrl = new URL(page.url());
        const finalPath = finalUrl.pathname + finalUrl.search;
        const asked = new URL(options.path, BASE_URL);
        if (finalUrl.origin !== asked.origin || finalPath !== asked.pathname + asked.search) failures.add(`the browser ended at ${finalUrl.origin === asked.origin ? finalPath : finalUrl.href}, not at ${options.path}`);

        const grown = await growToFitInnerScroll(page, settings.viewport);
        if (grown !== settings.viewport.height) await settle(page, 0);
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
    if (failures.size > 0) {
      console.error("shot: this is not the page that was asked for:");
      for (const failure of failures) console.error(`  ${failure}`);
      if (!options.allowErrors) {
        console.error("shot: the screenshots above were saved all the same. Pass --allow-errors if this page is what you meant to look at.");
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`shot: ${error?.message ?? error}`);
  process.exit(1);
});
