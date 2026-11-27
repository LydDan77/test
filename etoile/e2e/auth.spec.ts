import { expect, test } from "@playwright/test";
import { formAlert, freshAccount, signOut, signUpFreshAccount, submitSignIn, submitSignUp } from "./support/account";

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

test("health check answers", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, app: "etoile" });
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

  // Sign out: back to the landing page, cookie gone.
  await signOut(page);
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Home" })).toHaveCount(0);
  expect(await sessionCookie()).toBeUndefined();

  // A wrong password is refused.
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await submitSignIn(page, { email: account.email, password: "not the password" });
  await expect(formAlert(page, "Sign in")).toHaveText(WRONG);
  await expect(page).toHaveURL("/sign-in");
  // The email is still there to correct; nobody is signed in.
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(account.email);
  await expect(page.getByLabel("Password")).toHaveValue("");
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
  await expect(formAlert(page, "Sign in")).toHaveText(WRONG);
  await expect(page).toHaveURL("/sign-in");
});

test("signing up twice with one email is refused", async ({ page }) => {
  const account = await signUpFreshAccount(page);
  await signOut(page);

  await page.goto("/sign-up");
  await submitSignUp(page, { name: "Someone Else", email: account.email.toUpperCase(), password: "another long password" });
  await expect(formAlert(page, "Create account")).toHaveText("An account with this email already exists. Sign in instead.");
  await expect(page).toHaveURL("/sign-up");
  // What was typed is still there, except the password.
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Someone Else");
  await expect(page.getByLabel("Password")).toHaveValue("");
});

test("sign-up says what is wrong with each field", async ({ page }) => {
  await page.goto("/sign-up");
  // The browser's own checks (required, type=email, minlength) come first; switch them off to
  // see what the server says, as it would for a browser without them.
  await page.locator("form").evaluate((form: HTMLFormElement) => (form.noValidate = true));
  await submitSignUp(page, { name: "Short Password", email: "not-an-email", password: "short" });
  await expect(page.getByText("Enter a valid email address")).toHaveCount(2); // beside the field and in the summary
  await expect(page.getByText("Use at least 10 characters")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Short Password");
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

test("the ?next= target cannot send anyone off the site", async ({ page }) => {
  const account = await signUpFreshAccount(page);

  for (const attack of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "/sign-in?next=/sign-in"]) {
    await signOut(page);
    await page.goto(`/sign-in?next=${encodeURIComponent(attack)}`);
    await submitSignIn(page, account);
    // Signed in, and still here: the bad target was replaced by Home.
    await expect(page.getByRole("heading", { name: "Home", level: 1 }), attack).toBeVisible();
    await expect(page, attack).toHaveURL("/");
  }
});

test("the forms work as plain posts, before the page is interactive", async ({ browser }) => {
  // With JavaScript off, a form is sent the way it would be if someone were quicker than the
  // page: as an ordinary POST. (Streamed parts of a page need JavaScript to appear, so this
  // test reads the address and the cookie, not the page.)
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const account = freshAccount("No Script");
  const sessionCookie = async () => (await context.cookies()).find((c) => c.name.endsWith("etoile_session"));

  await page.goto("/sign-up");
  await submitSignUp(page, account);
  await expect(page).toHaveURL("/");
  expect(await sessionCookie()).toBeDefined();

  // The target of ?next= survives without the script that fills the hidden field.
  await context.clearCookies();
  await page.goto("/sign-in?next=%2F%3Ffrom%3Dnext");
  await submitSignIn(page, account);
  await expect(page).toHaveURL("/?from=next");
  expect(await sessionCookie()).toBeDefined();

  // A wrong password comes back to the form with the message and the email still in place.
  await context.clearCookies();
  await page.goto("/sign-in");
  await submitSignIn(page, { email: account.email, password: "not the password" });
  await expect(formAlert(page, "Sign in")).toHaveText(WRONG);
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(account.email);
  expect(await sessionCookie()).toBeUndefined();
  await context.close();
});

test("a session cookie that is made up does not sign anyone in", async ({ page, context }) => {
  await context.addCookies([{ name: "etoile_session", value: "forged-forged-forged-forged-forged-forged-f", url: "http://localhost" }]);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Home" })).toHaveCount(0);
});
