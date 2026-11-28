"use server";

import { eq } from "drizzle-orm";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { seedExamplePlan } from "@/features/plans/seed";
import { fail, formText, invalid, ok, type ActionFailure, type ActionResult } from "@/lib/action";
import { knownDeviceId, rememberDevice } from "@/lib/auth/device";
import { safeNextPath } from "@/lib/auth/next-path";
import { getDummyHash, hashPassword, isPasswordBusy, verifyPassword } from "@/lib/auth/password";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from "@/lib/auth/password-rules";
import { requireUser } from "@/lib/auth/require";
import {
  createSession,
  deleteAllSessionsForUser,
  deleteExpiredSessions,
  destroySession,
  type SessionUser,
} from "@/lib/auth/session";
import { pruneCached } from "@/lib/cache";
import { homePlaceFromTimeZone, localeDefaults } from "@/lib/domain";
import { newId } from "@/lib/ids";
import { describeWait, pruneRateLimits, rateLimit, rateLimitKey, resetRateLimit } from "@/lib/rate-limit";
import { UNKNOWN_ADDRESS, clientIp, platformTimeZone } from "@/lib/request";
import { canonicalTimeZone } from "@/lib/time";

/** Both forms either redirect (success) or return a failure to show. null before the first submit. */
export type AuthFormState = ActionFailure | null;
/** The password form stays on its page: `{ ok: true }` when the password was changed. */
export type ChangePasswordState = ActionResult | null;

const MINUTE = 60_000;

/** New accounts the whole site creates in an hour, whoever asks. SIGN_UP_MAX_PER_HOUR overrides it. */
function signUpsPerHour(): number {
  const configured = Number(process.env.SIGN_UP_MAX_PER_HOUR);
  return Number.isInteger(configured) && configured >= 1 ? configured : 200;
}

// Each attempt costs one scrypt hash (about 0.4 s of CPU and 130 MiB), so these limits protect
// the server as well as the accounts. Hashing itself is also bounded: src/lib/auth/password.ts
// runs two hashes at a time and turns callers away when its short queue is full.
//
// A limit keyed by address only exists when the address is known (clientIp() says "unknown"
// when no platform or proxy vouches for it). The limits that do not depend on an address are
// always applied: per account for sign-in, site-wide for sign-up.
const LIMITS = {
  /** New accounts from one address. */
  signUpPerIp: { limit: 20, windowMs: 60 * MINUTE },
  /** Password tries for one account from one address. */
  signInPerEmailAndIp: { limit: 8, windowMs: 15 * MINUTE },
  /** Password tries for one account from anywhere. Counts only tries that reach the password check. */
  signInPerEmail: { limit: 30, windowMs: 15 * MINUTE },
  /** Password tries from one address across all accounts. */
  signInPerIp: { limit: 60, windowMs: 15 * MINUTE },
  /** Tries from a browser that has signed in to the account before, once signInPerEmail is used up. */
  signInPerKnownDevice: { limit: 5, windowMs: 15 * MINUTE },
  /** Password changes for one account. */
  changePasswordPerUser: { limit: 10, windowMs: 15 * MINUTE },
} as const;

const emailSchema = z.email("Enter a valid email address").max(254, "That email address is too long");

const signUpSchema = z.object({
  name: z
    .string()
    .min(1, "Enter your name")
    .max(80, "Use a shorter name")
    .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, "Write your name on one line"),
  email: emailSchema,
  // Length is the main rule (NIST SP 800-63B); the upper bound limits the hashing cost of a
  // hostile input. passwordProblem() adds the passwords everybody tries first.
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, "Use a shorter password"),
});

const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

function tooManyTries(retryAfterMs: number, values?: Record<string, string>): ActionFailure {
  return fail(`Too many tries. Wait ${describeWait(retryAfterMs)} and try again.`, values ? { values } : {});
}

/** For when hashing is at its limit: nothing is wrong with what the person typed. */
function busy(values?: Record<string, string>): ActionFailure {
  return fail("We are busy right now. Wait a moment and try again.", values ? { values } : {});
}

/** A password field is taken exactly as typed: leading or trailing spaces are part of it. */
function rawPassword(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = {
    name: formText(formData, "name"),
    email: formText(formData, "email").toLowerCase(),
    password: rawPassword(formData, "password"),
  };
  const values = { name: raw.name, email: raw.email };
  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error, values);
  const { name, email, password } = parsed.data;

  const weak = passwordProblem(password, { email, name });
  if (weak) return fail(`${weak}.`, { fieldErrors: { password: [weak] }, values });

  const ip = await clientIp();
  if (ip !== UNKNOWN_ADDRESS) {
    const limit = await rateLimit(rateLimitKey("sign-up", ip), LIMITS.signUpPerIp);
    if (!limit.ok) return tooManyTries(limit.retryAfterMs, values);
  }
  // The ceiling for everyone together. It is the one limit on new accounts (and on the hash
  // each one costs) that many addresses cannot get around.
  const siteWide = await rateLimit(rateLimitKey("sign-up-all"), { limit: signUpsPerHour(), windowMs: 60 * MINUTE });
  if (!siteWide.ok) {
    return fail(`We cannot create new accounts right now. Try again in ${describeWait(siteWide.retryAfterMs)}.`, { values });
  }

  // The browser sends its time zone and language; the home place and the defaults come from them.
  const tz = canonicalTimeZone(formText(formData, "timeZone")) ?? canonicalTimeZone(await platformTimeZone()) ?? "UTC";
  const { units, currency } = localeDefaults(formText(formData, "locale") || null);
  const home = homePlaceFromTimeZone(tz);

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    if (isPasswordBusy(error)) return busy(values);
    throw error;
  }
  const db = await getDb();

  let user: SessionUser;
  try {
    user = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.users)
        .values({ id: newId(), email, name, passwordHash, home, units, currency })
        .returning();
      // Everyone has exactly one home clock from the start.
      await tx.insert(schema.clocks).values({ id: newId(), userId: row.id, place: home, isHome: true, sortOrder: 0 });
      const { passwordHash: _hash, ...rest } = row;
      void _hash;
      return rest;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // This tells whoever asks that the address has an account. It is deliberate for now:
      // the app cannot send email yet, so there is no "check your inbox" to answer with
      // instead. The limits above bound how fast addresses can be tried.
      return fail("An account with this email already exists. Sign in instead.", {
        fieldErrors: { email: ["An account with this email already exists"] },
        values,
      });
    }
    throw error;
  }

  try {
    await seedExamplePlan(user);
  } catch (error) {
    // The account exists; a broken example must not stop the person getting in.
    console.error("[sign-up] seedExamplePlan failed:", error instanceof Error ? error.message : error);
  }

  await createSession(user.id);
  await rememberDevice({ id: user.id, passwordHash });
  redirect("/"); // throws; must stay outside try/catch
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = {
    email: formText(formData, "email").toLowerCase(),
    password: rawPassword(formData, "password"),
  };
  const values = { email: raw.email };
  // One message for every failure, so the form never says whether an account exists.
  const failure = fail("That email or password is not right. Check them and try again.", { values });
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return failure;
  const { email, password } = parsed.data;

  // Count the attempt before doing the expensive part.
  //
  // The limits keyed by address come first, one at a time, and a try that one of them refuses
  // stops here. It is never counted against the account: otherwise one address, already being
  // refused, could run the account-wide count past its limit and lock the owner out everywhere.
  const ip = await clientIp();
  const pairKey = rateLimitKey("sign-in", email, ip);
  if (ip !== UNKNOWN_ADDRESS) {
    const byIp = await rateLimit(rateLimitKey("sign-in-ip", ip), LIMITS.signInPerIp);
    if (!byIp.ok) return tooManyTries(byIp.retryAfterMs, values);
    const byPair = await rateLimit(pairKey, LIMITS.signInPerEmailAndIp);
    if (!byPair.ok) return tooManyTries(byPair.retryAfterMs, values);
  }

  const db = await getDb();
  const [user] = await db
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  // The account-wide limit counts only tries that get as far as a password check. Several
  // addresses together can still use it up, so a browser that has signed in to this account
  // before keeps a small allowance of its own (src/lib/auth/device.ts).
  const emailKey = rateLimitKey("sign-in-email", email);
  const byEmail = await rateLimit(emailKey, LIMITS.signInPerEmail);
  if (!byEmail.ok) {
    const deviceId = user ? await knownDeviceId(user) : null;
    if (!deviceId) return tooManyTries(byEmail.retryAfterMs, values);
    const byDevice = await rateLimit(rateLimitKey("sign-in-device", email, deviceId), LIMITS.signInPerKnownDevice);
    if (!byDevice.ok) return tooManyTries(byDevice.retryAfterMs, values);
  }

  // Always run one scrypt, so an unknown email takes as long as a wrong password.
  let result: Awaited<ReturnType<typeof verifyPassword>>;
  try {
    result = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  } catch (error) {
    if (isPasswordBusy(error)) return busy(values);
    throw error;
  }
  if (!user || !result.ok) return failure;

  let passwordHash = user.passwordHash;
  if (result.needsRehash) {
    try {
      passwordHash = await hashPassword(password);
      await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id));
    } catch (error) {
      // The upgrade can wait for the next sign-in; the password was right.
      passwordHash = user.passwordHash;
      if (!isPasswordBusy(error)) console.error("[sign-in] could not upgrade the password hash:", error instanceof Error ? error.message : error);
    }
  }

  // Housekeeping that should never get in the way of signing in. The right password clears the
  // failed tries for this account, from this address and from everywhere.
  await Promise.all([
    resetRateLimit(pairKey),
    resetRateLimit(emailKey),
    deleteExpiredSessions(),
    pruneRateLimits(),
    pruneCached(),
  ]).catch((error) => {
    console.error("[sign-in] housekeeping failed:", error instanceof Error ? error.message : error);
  });

  await createSession(user.id);
  await rememberDevice({ id: user.id, passwordHash });
  // Only ever a path on this site: safeNextPath() turns anything else into "/".
  redirect(safeNextPath(formData.get("next")) as Route);
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/");
}

/**
 * Signs the person out on every device, this one included: for "I left it signed in somewhere".
 * Every session of the account stops working at once.
 */
export async function signOutEverywhere(): Promise<void> {
  const user = await requireUser();
  await deleteAllSessionsForUser(user.id);
  await destroySession(); // removes this browser's cookie
  redirect("/");
}

/**
 * Changes the signed-in person's password. Fields: `currentPassword`, `newPassword`.
 * Every other device is signed out; this one gets a fresh session and stays signed in.
 */
export async function changePassword(_prev: ChangePasswordState, formData: FormData): Promise<ChangePasswordState> {
  const user = await requireUser();
  const current = rawPassword(formData, "currentPassword");
  const next = rawPassword(formData, "newPassword");

  if (current.length === 0 || current.length > PASSWORD_MAX_LENGTH) {
    return fail("Enter your current password.", { fieldErrors: { currentPassword: ["Enter your current password"] } });
  }
  const weak = passwordProblem(next, { email: user.email, name: user.name });
  if (weak) return fail(`${weak}.`, { fieldErrors: { newPassword: [weak] } });
  if (next === current) {
    return fail("Choose a password that is different from the one you have now.", { fieldErrors: { newPassword: ["Choose a different password"] } });
  }

  const limit = await rateLimit(rateLimitKey("change-password", user.id), LIMITS.changePasswordPerUser);
  if (!limit.ok) return tooManyTries(limit.retryAfterMs);

  const db = await getDb();
  const [account] = await db
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  if (!account) redirect("/sign-in");

  let passwordHash: string;
  try {
    const check = await verifyPassword(current, account.passwordHash);
    if (!check.ok) {
      return fail("That is not your current password. Check it and try again.", { fieldErrors: { currentPassword: ["That is not your current password"] } });
    }
    passwordHash = await hashPassword(next);
  } catch (error) {
    if (isPasswordBusy(error)) return busy();
    throw error;
  }

  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, account.id));
  // Whoever else holds a session for this account is out, wherever they are.
  await deleteAllSessionsForUser(account.id);
  await createSession(account.id);
  await rememberDevice({ id: account.id, passwordHash });
  await resetRateLimit(rateLimitKey("sign-in-email", user.email)).catch(() => {});
  return ok();
}
