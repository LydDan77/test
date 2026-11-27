"use server";

import { eq } from "drizzle-orm";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { seedExamplePlan } from "@/features/plans/seed";
import { fail, formText, invalid, type ActionFailure } from "@/lib/action";
import { safeNextPath } from "@/lib/auth/next-path";
import { getDummyHash, hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, deleteExpiredSessions, destroySession, type SessionUser } from "@/lib/auth/session";
import { homePlaceFromTimeZone, localeDefaults } from "@/lib/domain";
import { newId } from "@/lib/ids";
import { describeWait, pruneRateLimits, rateLimit, rateLimitKey, resetRateLimit } from "@/lib/rate-limit";
import { clientIp, platformTimeZone, refererSearchParam } from "@/lib/request";
import { isIanaTimeZone } from "@/lib/time";

/** Both forms either redirect (success) or return a failure to show. null before the first submit. */
export type AuthFormState = ActionFailure | null;

const MINUTE = 60_000;
// Each attempt costs one scrypt hash (about 0.4 s of CPU and 128 MiB), so these limits protect
// the server as well as the accounts.
const LIMITS = {
  /** New accounts from one address. */
  signUpPerIp: { limit: 20, windowMs: 60 * MINUTE },
  /** Password tries for one account from one address. */
  signInPerEmailAndIp: { limit: 8, windowMs: 15 * MINUTE },
  /** Password tries for one account from anywhere (an address can be forged). */
  signInPerEmail: { limit: 30, windowMs: 15 * MINUTE },
  /** Password tries from one address across all accounts. */
  signInPerIp: { limit: 60, windowMs: 15 * MINUTE },
} as const;

const emailSchema = z.email("Enter a valid email address").max(254, "That email address is too long");

const signUpSchema = z.object({
  name: z.string().min(1, "Enter your name").max(80, "Use a shorter name"),
  email: emailSchema,
  // Length is the only rule (NIST SP 800-63B); 256 bounds the hashing cost of a hostile input.
  password: z.string().min(10, "Use at least 10 characters").max(256, "Use a shorter password"),
});

const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

function tooManyTries(retryAfterMs: number, values: Record<string, string>): ActionFailure {
  return fail(`Too many tries. Wait ${describeWait(retryAfterMs)} and try again.`, { values });
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = {
    name: formText(formData, "name"),
    email: formText(formData, "email").toLowerCase(),
    // A password is taken exactly as typed: leading or trailing spaces are part of it.
    password: typeof formData.get("password") === "string" ? (formData.get("password") as string) : "",
  };
  const values = { name: raw.name, email: raw.email };
  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error, values);
  const { name, email, password } = parsed.data;

  const limit = await rateLimit(rateLimitKey("sign-up", await clientIp()), LIMITS.signUpPerIp);
  if (!limit.ok) return tooManyTries(limit.retryAfterMs, values);

  // The browser sends its time zone and language; the home place and the defaults come from them.
  const sentZone = formText(formData, "timeZone");
  const platformZone = await platformTimeZone();
  const tz = isIanaTimeZone(sentZone) ? sentZone : isIanaTimeZone(platformZone) ? platformZone : "UTC";
  const { units, currency } = localeDefaults(formText(formData, "locale") || null);
  const home = homePlaceFromTimeZone(tz);

  const passwordHash = await hashPassword(password);
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
    console.error("[sign-up] seedExamplePlan failed:", error);
  }

  await createSession(user.id);
  redirect("/"); // throws; must stay outside try/catch
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const raw = {
    email: formText(formData, "email").toLowerCase(),
    password: typeof formData.get("password") === "string" ? (formData.get("password") as string) : "",
  };
  const values = { email: raw.email };
  // One message for every failure, so the form never says whether an account exists.
  const failure = fail("That email or password is not right. Check them and try again.", { values });
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return failure;
  const { email, password } = parsed.data;

  // Count the attempt before doing the expensive part.
  const ip = await clientIp();
  const pairKey = rateLimitKey("sign-in", email, ip);
  const checks = await Promise.all([
    rateLimit(pairKey, LIMITS.signInPerEmailAndIp),
    rateLimit(rateLimitKey("sign-in-email", email), LIMITS.signInPerEmail),
    rateLimit(rateLimitKey("sign-in-ip", ip), LIMITS.signInPerIp),
  ]);
  const blocked = checks.filter((check) => !check.ok);
  if (blocked.length > 0) {
    return tooManyTries(Math.max(...blocked.map((check) => check.retryAfterMs)), values);
  }

  const db = await getDb();
  const [user] = await db
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  // Always run one scrypt, so an unknown email takes as long as a wrong password.
  const result = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !result.ok) return failure;

  if (result.needsRehash) {
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(schema.users.id, user.id));
  }

  // Housekeeping that should never get in the way of signing in.
  await Promise.all([resetRateLimit(pairKey), deleteExpiredSessions(), pruneRateLimits()]).catch((error) => {
    console.error("[sign-in] housekeeping failed:", error);
  });

  await createSession(user.id);
  // Where the person was headed: the form's hidden field, or (when the form was sent before
  // the page was interactive and the field is empty) the same ?next= on the page's own address.
  const next = formText(formData, "next") || (await refererSearchParam("/sign-in", "next"));
  // Only ever a path on this site: safeNextPath() turns anything else into "/".
  redirect(safeNextPath(next) as Route);
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/");
}
