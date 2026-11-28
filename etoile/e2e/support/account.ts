import { expect, type Locator, type Page } from "@playwright/test";

// Shared steps for end-to-end specs.
//
// Every test that needs a signed-in person starts with
//     const account = await signUpFreshAccount(page);
// which makes a brand-new account through the real form. Do not share an account between tests
// through a variable at the top of the file: after a failure Playwright starts a new worker,
// the file is evaluated again, and the variable holds a different account.
//
// These steps are what every feature's spec starts with, so they must keep working whatever
// the auth pages and Home are restyled into. They therefore lean on almost nothing:
//  - the auth form is "the visible form that has a password field";
//  - its fields are found by the KIND of input (password, email, other text), not by a label,
//    so a show-password button, a "Confirm password" field or separate first and last names
//    change nothing;
//  - it is submitted with Enter, as a person would, so the button can say and be anywhere;
//  - "signed in" and "signed out" are read from the session cookie, not from a heading or a
//    button on Home.
//
// In your own specs prefer getByRole: Next keeps the previous page mounted but hidden after a
// navigation, and getByTestId / locator() can match elements on that hidden page.

export type TestAccount = { name: string; email: string; password: string };

let counter = 0;

/** Details for an account that does not exist yet. */
export function freshAccount(name = "Lydia Hartley"): TestAccount {
  counter += 1;
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${counter}`;
  return { name, email: `e2e-${unique}@example.com`, password: "correct horse battery staple" };
}

/** The sign-in or sign-up form on the current page: the visible form that has a password field. */
export function authForm(page: Page): Locator {
  return page
    .locator("form")
    .filter({ has: page.locator('input[type="password"]') })
    .filter({ visible: true })
    .first();
}

/** The form's password inputs: one today, two if a "Confirm password" field is added. */
export function passwordFields(page: Page): Locator {
  return authForm(page).locator('input[type="password"]');
}

/** The form's email input. */
export function emailField(page: Page): Locator {
  return authForm(page).locator('input[type="email"], input[name="email" i], input[autocomplete="email"], input[autocomplete="username"]').first();
}

/** The form's other text inputs: "Name" today; first and last name if they are split. */
export function nameFields(page: Page): Locator {
  return authForm(page).locator('input:not([type]), input[type="text"]');
}

async function fillAuthForm(page: Page, account: { name?: string; email: string; password: string }): Promise<void> {
  await expect(authForm(page)).toBeVisible();
  if (account.name !== undefined) {
    const [first, ...rest] = account.name.split(" ");
    const last = rest.join(" ");
    const fields = await nameFields(page).all();
    for (const field of fields) {
      if (!(await field.isVisible())) continue;
      const about = (await field.evaluate((el: HTMLInputElement) => `${el.name} ${el.id} ${el.autocomplete} ${el.labels?.[0]?.textContent ?? ""}`)).toLowerCase();
      if (/last|family|surname/.test(about)) await field.fill(last || first);
      else if (/first|given/.test(about)) await field.fill(first);
      else await field.fill(account.name);
    }
  }
  await emailField(page).fill(account.email);
  for (const field of await passwordFields(page).all()) await field.fill(account.password);
}

/** Enter in the last password field: the form's own default button, whatever it says. */
async function submitAuthForm(page: Page): Promise<void> {
  await passwordFields(page).last().press("Enter");
}

/** Fills and submits the sign-up form on the current page. Does not assert where it lands. */
export async function submitSignUp(page: Page, account: TestAccount): Promise<void> {
  await fillAuthForm(page, account);
  await submitAuthForm(page);
}

/** Fills and submits the sign-in form on the current page. Does not assert where it lands. */
export async function submitSignIn(page: Page, account: Pick<TestAccount, "email" | "password">): Promise<void> {
  await fillAuthForm(page, account);
  await submitAuthForm(page);
}

/** True when the browser holds a session cookie. */
export async function hasSessionCookie(page: Page): Promise<boolean> {
  return (await page.context().cookies()).some((cookie) => cookie.name.endsWith("etoile_session") && cookie.value !== "");
}

/** Waits until the browser is signed in (it holds a session cookie) and the page has settled. */
export async function expectSignedIn(page: Page): Promise<void> {
  await expect.poll(() => hasSessionCookie(page), { message: "the browser should hold a session cookie" }).toBe(true);
  await page.waitForURL((url) => !/^\/sign-(in|up)(\/|$)/.test(url.pathname));
  await page.waitForLoadState("load");
}

/**
 * Creates an account through the real sign-up form and waits until the browser is signed in
 * and has left the sign-up page (today that is Home, at "/").
 */
export async function signUpFreshAccount(page: Page, name?: string): Promise<TestAccount> {
  const account = freshAccount(name);
  await page.goto("/sign-up");
  await submitSignUp(page, account);
  await expectSignedIn(page);
  return account;
}

/**
 * Signs the browser out and waits until its session cookie is gone.
 *
 * If the current page shows a "Sign out" control (a button, a menu item or a link) it is used,
 * as a person would. If it does not, wherever that control now lives, the session cookie is
 * dropped from the browser instead: the next request is a signed-out one either way. (That
 * second way leaves the session row behind; the real control is covered in e2e/auth.spec.ts.)
 */
export async function signOut(page: Page): Promise<void> {
  const name = /^(sign|log) ?out$/i;
  const control = page.getByRole("button", { name }).or(page.getByRole("menuitem", { name })).or(page.getByRole("link", { name })).first();
  if (await control.isVisible().catch(() => false)) {
    await control.click();
  } else {
    await page.context().clearCookies({ name: /etoile_session$/ });
    await page.goto("/");
  }
  await expect.poll(() => hasSessionCookie(page), { message: "the session cookie should be gone" }).toBe(false);
  await page.waitForLoadState("load");
}

/**
 * The message a form shows when its action fails. Scoped to the form on purpose: Next.js adds
 * its own role="alert" node to every page (the route announcer), so an unscoped
 * page.getByRole("alert") matches two elements. Pass the name of the form's submit button.
 */
export function formAlert(page: Page, submitButtonName: string): Locator {
  return page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: submitButtonName }) })
    .getByRole("alert");
}

/** The message the sign-in or sign-up form shows, whatever its button is called. */
export function authFormAlert(page: Page): Locator {
  return authForm(page).getByRole("alert");
}
