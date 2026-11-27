import { expect, type Locator, type Page } from "@playwright/test";

// Shared steps for end-to-end specs.
//
// Every test that needs a signed-in person starts with
//     const account = await signUpFreshAccount(page);
// which makes a brand-new account through the real form. Do not share an account between tests
// through a variable at the top of the file: after a failure Playwright starts a new worker,
// the file is evaluated again, and the variable holds a different account.
//
// Controls are found by role and label, never by test id or CSS, so a restyle cannot break them.
// Prefer getByRole in your own specs too: Next keeps the previous page mounted but hidden after
// a navigation, and getByTestId / locator() can match elements on that hidden page.

export type TestAccount = { name: string; email: string; password: string };

let counter = 0;

/** Details for an account that does not exist yet. */
export function freshAccount(name = "Lydia Hartley"): TestAccount {
  counter += 1;
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${counter}`;
  return { name, email: `e2e-${unique}@example.com`, password: "correct horse battery staple" };
}

/** Fills and submits the sign-up form on the current page. Does not assert where it lands. */
export async function submitSignUp(page: Page, account: TestAccount): Promise<void> {
  await page.getByRole("textbox", { name: "Name" }).fill(account.name);
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** Fills and submits the sign-in form on the current page. Does not assert where it lands. */
export async function submitSignIn(page: Page, account: Pick<TestAccount, "email" | "password">): Promise<void> {
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Creates an account through the real sign-up form and lands on Home, signed in. */
export async function signUpFreshAccount(page: Page, name?: string): Promise<TestAccount> {
  const account = freshAccount(name);
  await page.goto("/sign-up");
  await submitSignUp(page, account);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  return account;
}

/** Signs out from Home and waits for the landing page. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}

/**
 * The message a form shows when its action fails. Scoped to the form on purpose: Next.js adds
 * its own role="alert" node to every page (the route announcer), so an unscoped
 * page.getByRole("alert") matches two elements.
 */
export function formAlert(page: Page, submitButtonName: string): Locator {
  return page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: submitButtonName }) })
    .getByRole("alert");
}
