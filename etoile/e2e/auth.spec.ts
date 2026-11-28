import { expect, test } from "@playwright/test";
import {
  authFormAlert,
  emailField,
  freshAccount,
  hasSessionCookie,
  nameFields,
  passwordFields,
  signOut,
  signUpFreshAccount,
  submitSignIn,
  submitSignUp,
} from "./support/account";

const WRONG = "That email or password is not right. Check them and try again.";

test("landing page offers both ways in", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Étoile", level: 1 })).toBeVisible();
  await expect(page.getByText("Plan it. Share it. Know before you go.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/sign-up");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("health check answers, and says nothing about where the database is", async ({ request }) => {
  for (const path of ["/api/health", "/api/health?verbose"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const body = await response.json();
    expect(body, path).toMatchObject({ ok: true, app: "etoile" });
    // Never the data directory or the database host: this address needs no sign-in.
    // (In development ?verbose adds the driver's name and the query time, nothing more.)
    expect(body, path).not.toHaveProperty("location");
    expect(JSON.stringify(body), path).not.toMatch(/\.data|\/home|memory:|postgres(ql)?:|@|:\d{4}/i);
    expect(Object.keys(body).sort().join(), path).toMatch(/^app,(driver,)?ok(,queryMs)?$/);
  }
});

test("every response carries the security headers", async ({ request }) => {
  for (const path of ["/", "/sign-in", "/api/health", "/no-such-page-anywhere"]) {
    const headers = (await request.get(path)).headers();
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(headers["cross-origin-opener-policy"], path).toBe("same-origin");
    expect(headers["permissions-policy"], path).toContain("camera=()");
    expect(headers["permissions-policy"], path).toContain("microphone=()");
    expect(headers["permissions-policy"], path).toContain("geolocation=()");
    expect(headers["x-powered-by"], path).toBeUndefined();
    const policy = headers["content-security-policy"];
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
      expect(policy, `${path}: ${directive}`).toContain(directive);
    }
  }
});

test("the content security policy does not get in the app's own way", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  await page.goto("/");
  await page.goto("/sign-up");
  const account = freshAccount();
  await submitSignUp(page, account);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  // The theme script in <head> ran (it is inline, which the policy has to allow).
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(violations, violations.join("\n")).toEqual([]);
});

test("sign up, land on Home, sign out, sign in again; a wrong password is refused", async ({ page, context }) => {
  const account = freshAccount("Lydia Hartley");
  const sessionCookie = async () => (await context.cookies()).find((c) => c.name.endsWith("etoile_session"));

  // Sign up through the real form.
  await page.goto("/");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Create an account", level: 1 })).toBeVisible();
  await submitSignUp(page, account);

  // Land on Home, signed in, with the name showing.
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.getByText(`Signed in as ${account.name}.`)).toBeVisible();
  // The home clock was created from the browser's time zone.
  const browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const city = browserZone === "UTC" ? "UTC" : browserZone.split("/").pop()!.replace(/_/g, " ");
  await expect(page.getByText(`Home clock: ${city}.`)).toBeVisible();

  // The session cookie is httpOnly, SameSite=Lax and invisible to scripts.
  const cookie = await sessionCookie();
  expect(cookie).toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe("Lax");
  expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await page.evaluate(() => document.cookie)).not.toContain("etoile_session");

  // Still signed in after a full reload: the session is in the database, not in page state.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  // Someone who is signed in has no use for the auth pages.
  await page.goto("/sign-in");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  // Sign out with the real button: back to the landing page, cookie gone from the browser.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Home" })).toHaveCount(0);
  expect(await sessionCookie()).toBeUndefined();
  // And the token it held is dead on the server too: putting it back signs nobody in.
  await context.addCookies([{ name: cookie!.name, value: cookie!.value, url: "http://localhost" }]);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Home" })).toHaveCount(0);
  await context.clearCookies({ name: cookie!.name });

  // A wrong password is refused.
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await submitSignIn(page, { email: account.email, password: "not the password" });
  await expect(authFormAlert(page)).toHaveText(WRONG);
  await expect(page).toHaveURL("/sign-in");
  // The email is still there to correct; nobody is signed in.
  await expect(emailField(page)).toHaveValue(account.email);
  await expect(passwordFields(page)).toHaveValue("");
  expect(await sessionCookie()).toBeUndefined();

  // The right password signs in again.
  await submitSignIn(page, account);
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.getByText(`Signed in as ${account.name}.`)).toBeVisible();
  expect(await sessionCookie()).toBeDefined();
});

test("an unknown email gets the same message as a wrong password", async ({ page }) => {
  await page.goto("/sign-in");
  await submitSignIn(page, { email: freshAccount().email, password: "correct horse battery staple" });
  await expect(authFormAlert(page)).toHaveText(WRONG);
  await expect(page).toHaveURL("/sign-in");
});

test("signing up twice with one email is refused", async ({ page }) => {
  const account = await signUpFreshAccount(page);
  await signOut(page);

  await page.goto("/sign-up");
  await submitSignUp(page, { name: "Someone Else", email: account.email.toUpperCase(), password: "another long password" });
  await expect(authFormAlert(page)).toHaveText("An account with this email already exists. Sign in instead.");
  await expect(page).toHaveURL("/sign-up");
  // What was typed is still there, except the password.
  await expect(nameFields(page)).toHaveValue("Someone Else");
  await expect(passwordFields(page)).toHaveValue("");
});

test("sign-up refuses a password that is too easy to guess", async ({ page }) => {
  await page.goto("/sign-up");
  const account = freshAccount();
  await submitSignUp(page, { ...account, password: "qwertyuiop" });
  await expect(authFormAlert(page)).toHaveText("That password is too easy to guess. Try a few words together.");
  await expect(page).toHaveURL("/sign-up");
  expect(await hasSessionCookie(page)).toBe(false);
  // The same account with a real password goes through.
  await submitSignUp(page, account);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
});

test("sign-up says what is wrong with each field", async ({ page }) => {
  await page.goto("/sign-up");
  // The browser's own checks (required, type=email, minlength) come first; switch them off to
  // see what the server says, as it would for a browser without them.
  await page.locator("form").evaluate((form: HTMLFormElement) => (form.noValidate = true));
  await submitSignUp(page, { name: "Short Password", email: "not-an-email", password: "short" });
  await expect(page.getByText("Enter a valid email address")).toHaveCount(2); // beside the field and in the summary
  await expect(page.getByText("Use at least 10 characters")).toBeVisible();
  await expect(emailField(page)).toHaveAttribute("aria-invalid", "true");
  await expect(nameFields(page)).toHaveValue("Short Password");
});

test("pages that need an account send a signed-out visitor to sign-in, and back afterwards", async ({ page }) => {
  // src/proxy.ts answers before anything renders: a 307 with the original path in ?next=.
  const response = await page.request.get("/plans/0123456789ab/flights?step=2", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/sign-in?next=%2Fplans%2F0123456789ab%2Fflights%3Fstep%3D2");
  for (const path of ["/plans", "/heads-up", "/you"]) {
    const r = await page.request.get(path, { maxRedirects: 0 });
    expect(r.status(), path).toBe(307);
    expect(r.headers()["location"], path).toContain(`/sign-in?next=${encodeURIComponent(path)}`);
  }
  // Public addresses are not touched by the proxy.
  for (const path of ["/", "/sign-in", "/sign-up", "/api/health"]) {
    expect((await page.request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
  }

  const account = await signUpFreshAccount(page);
  await signOut(page);

  // Sign-in goes back to where the person was headed.
  await page.goto("/sign-in?next=%2F%3Ffrom%3Dnext%23top");
  await submitSignIn(page, account);
  await expect(page).toHaveURL("/?from=next#top");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  // Someone already signed in who opens such a link is sent straight on.
  await page.goto("/sign-in?next=%2F%3Fagain%3D1");
  await expect(page).toHaveURL("/?again=1");
});

// Each of these would take the browser to another site if it were used as written. The last
// four start with a single "/" and only turn into "//host" once the dot segment is removed.
const OFF_SITE = [
  "https://evil.example/",
  "//evil.example/",
  "/\\evil.example",
  "javascript:alert(1)",
  "/sign-in?next=/sign-in",
  "/.//evil.example/login",
  "/%2e//evil.example",
  "/plans/..//evil.example",
  "/.//127.0.0.1:3000/api/health",
];

test("the ?next= target cannot send anyone off the site", async ({ page }) => {
  const account = await signUpFreshAccount(page);

  for (const attack of OFF_SITE) {
    await signOut(page);
    await page.goto(`/sign-in?next=${encodeURIComponent(attack)}`);
    await submitSignIn(page, account);
    // Signed in, and still here: the bad target was replaced by Home.
    await expect(page.getByRole("heading", { name: "Home", level: 1 }), attack).toBeVisible();
    await expect(page, attack).toHaveURL("/");
  }
});

test("someone who is already signed in is not sent off the site by a ?next= link either", async ({ page, context }) => {
  await signUpFreshAccount(page);
  // If the browser ever asks for evil.example, answer, so that the test sees where it landed
  // instead of a network error.
  let leftTheSite = false;
  await context.route(
    (url) => url.hostname.endsWith("evil.example"),
    async (route) => {
      leftTheSite = true;
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>EVIL</title>" });
    },
  );

  for (const attack of OFF_SITE) {
    // The sign-in page itself redirects a signed-in visitor to the target, without any form.
    await page.goto(`/sign-in?next=${encodeURIComponent(attack)}`);
    await expect(page.getByRole("heading", { name: "Home", level: 1 }), attack).toBeVisible();
    const url = new URL(page.url());
    expect(url.origin, attack).toBe("http://localhost:" + url.port);
    expect(url.hostname, attack).toBe("localhost");
    expect(url.pathname, attack).toBe("/");
  }
  expect(leftTheSite).toBe(false);
  // A real path on the site still works.
  await page.goto("/sign-in?next=%2F%3Ffrom%3Dcontrol");
  await expect(page).toHaveURL("/?from=control");
});

// NOTE: in dev mode (E2E_MODE=dev, the mode this spec is run in while building) this test
// passes with or without the form guard in src/app/layout.tsx: `next dev` answers a plain POST
// with a whole document. It only proves the guard against a production build (`npm run e2e`),
// where without the guard the first half ends on a blank page. Do not read a pass in dev mode
// as "the guard works".
test("a form sent before the page's scripts have loaded still works", async ({ page }, testInfo) => {
  if (process.env.E2E_MODE === "dev") {
    testInfo.annotations.push({ type: "note", description: "dev mode: passes with or without the form guard; meaningful only against a production build" });
  }
  const account = await signUpFreshAccount(page);
  await signOut(page);

  // Hold every script back, as a slow connection would, so the form is sent as a plain POST
  // before React has made the page interactive.
  await page.route("**/_next/static/**/*.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  // A wrong password: the message appears once the page that came back is interactive.
  await page.goto("/sign-in?next=%2F%3Ffrom%3Dnext", { waitUntil: "domcontentloaded" });
  await submitSignIn(page, { email: account.email, password: "not the password" });
  await expect(authFormAlert(page)).toHaveText(WRONG);
  await expect(emailField(page)).toHaveValue(account.email);

  // The right password: signed in, and taken to where ?next= pointed.
  await page.goto("/sign-in?next=%2F%3Ffrom%3Dnext", { waitUntil: "domcontentloaded" });
  await submitSignIn(page, account);
  await expect(page).toHaveURL("/?from=next");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
});

test("a session cookie that is made up does not sign anyone in", async ({ page, context }) => {
  await context.addCookies([{ name: "etoile_session", value: "forged-forged-forged-forged-forged-forged-f", url: "http://localhost" }]);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Home" })).toHaveCount(0);
});

test("the shared steps survive a restyle of the auth form", async ({ page }) => {
  // What a designer may well do: a show-password button, a "Confirm password" field, first and
  // last name apart, and a "Sign in" button in the page header. The steps every feature spec
  // starts with must not care. The real form is rearranged in the browser, then used.
  await page.goto("/sign-up");
  await expect(passwordFields(page)).toHaveCount(1);
  // Wait until React has taken over the form: changing the page before that would be undone.
  await page.waitForFunction(() => {
    const form = document.querySelector("form:has(input[type=password])");
    return !!form && Object.keys(form).some((key) => key.startsWith("__reactProps$"));
  });
  await page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>("form:has(input[type=password])")!;
    const password = form.querySelector<HTMLInputElement>("input[type=password]")!;
    // A show-password button whose name contains "password".
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Show password");
    toggle.textContent = "Show";
    password.after(toggle);
    // A second password field. (Not sent: it has no name.)
    const confirmLabel = document.createElement("label");
    confirmLabel.textContent = "Confirm password";
    const confirm = document.createElement("input");
    confirm.type = "password";
    confirmLabel.append(confirm);
    toggle.after(confirmLabel);
    // A "Last name" beside the name field, which becomes "First name".
    const name = form.querySelector<HTMLInputElement>("input[name=name]")!;
    name.labels![0].textContent = "First name";
    const lastLabel = document.createElement("label");
    lastLabel.textContent = "Last name";
    const last = document.createElement("input");
    last.id = "restyle-last-name";
    lastLabel.htmlFor = last.id;
    name.after(lastLabel, last);
    // A header with its own "Sign in" and "Create account" buttons.
    const header = document.createElement("header");
    header.innerHTML = '<button type="button">Sign in</button> <button type="button">Create account</button>';
    document.body.prepend(header);
    // And the form's own button says something else now.
    form.querySelector<HTMLButtonElement>("button[type=submit]")!.textContent = "Get started";
  });
  await expect(passwordFields(page)).toHaveCount(2);

  const account = freshAccount("Lydia Hartley");
  await submitSignUp(page, account);
  await expect(page.getByText("Signed in as Lydia.")).toBeVisible(); // the first-name field is the one that is sent
  expect(await hasSessionCookie(page)).toBe(true);
  await expect(page.locator("#restyle-last-name")).toHaveCount(0);

  // signOut() uses the control when the page has one …
  await signOut(page);
  expect(await hasSessionCookie(page)).toBe(false);
  // … and still signs the browser out on a page that has none.
  await page.goto("/sign-in");
  await submitSignIn(page, account);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await page.evaluate(() => document.querySelectorAll("form").forEach((form) => form.remove()));
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await signOut(page);
  expect(await hasSessionCookie(page)).toBe(false);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});
