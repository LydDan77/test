import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt cost parameters. N=2^17, r=8, p=1 is the OWASP Password Storage Cheat Sheet's first
// choice for scrypt (128 MiB per hash, about 0.35 s on a 2026 server core).
// The parameters are stored inside each hash, so they can be raised later without a migration:
// verifyPassword() reports `needsRehash` and the login action re-hashes on the next sign-in.
const PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// Upper bounds accepted from a stored hash, so a tampered row cannot make the server allocate
// gigabytes or spin for minutes.
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 16;

/**
 * How much hashing may go on at once. One hash takes about 130 MiB and 0.4 s, and Node runs
 * scrypt on its four-thread pool, the same pool that reads files and resolves names. Left
 * unbounded, a burst of sign-ins (or someone sending junk on purpose) fills that pool and the
 * memory, and everything else the server does waits behind it.
 *
 * So: at most `concurrent` hashes run; up to `queue` more wait their turn for at most `waitMs`;
 * beyond that the caller gets a PasswordBusyError straight away and tells the person to try
 * again in a moment. (An object so that tests can lower the numbers.)
 */
export const HASH_LIMITS = { concurrent: 2, queue: 32, waitMs: 5_000 };

/** Thrown by hashPassword() and verifyPassword() when too many hashes are already waiting. */
export class PasswordBusyError extends Error {
  constructor() {
    super("Too many passwords are being checked at once");
    this.name = "PasswordBusyError";
  }
}

/** True for the error that means "busy, ask the person to try again", not a bug. */
export function isPasswordBusy(error: unknown): error is PasswordBusyError {
  return error instanceof PasswordBusyError;
}

let running = 0;
const waiting: { start: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

/** How many hashes are running and waiting right now. For tests and diagnostics. */
export function hashingLoad(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running < HASH_LIMITS.concurrent) running++;
  else {
    if (waiting.length >= HASH_LIMITS.queue) throw new PasswordBusyError();
    // Wait to be handed a slot by a hash that finishes (the count of running hashes stays as it is).
    await new Promise<void>((resolve, reject) => {
      const entry = {
        start: resolve,
        timer: setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(new PasswordBusyError());
        }, HASH_LIMITS.waitMs),
      };
      waiting.push(entry);
    });
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.start();
    } else running--;
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return withHashSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
      }),
  );
}

function options(N: number, r: number, p: number): ScryptOptions {
  // Node's default maxmem is 32 MiB, which rejects every N above 2^14 at r=8 with
  // ERR_CRYPTO_INVALID_SCRYPT_PARAMS ("memory limit exceeded"). scrypt needs about 128*N*r bytes.
  return { N, r, p, maxmem: 256 * N * r };
}

/**
 * Returns `scrypt$N$r$p$<salt base64url>$<key base64url>`.
 * Throws PasswordBusyError when the server is already hashing as much as it allows itself to
 * (see HASH_LIMITS): catch it with isPasswordBusy() and ask the person to try again.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const { N, r, p } = PARAMS;
  // NFKC so the same visible password typed on different keyboards hashes identically.
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, options(N, r, p));
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

// A share page's passcode is a short word many people know ("lakehouse"). Hashing it as hard as
// an account password would protect nothing (a leaked hash of a short word is guessed offline
// whatever the cost) and would make every guess at a public page cost the server 130 MiB. So a
// passcode gets a lighter setting: 16 MiB and a few hundredths of a second. What protects it is
// the limit on tries (src/lib/guest/passcode.ts), not the hash.
const PASSCODE_PARAMS = { N: 2 ** 14, r: 8, p: 1 } as const;

/**
 * The hash to store for a share page's passcode (sites.passcodeHash). Same format as
 * hashPassword(), lighter settings; check it with verifyPassword() and ignore `needsRehash`.
 * Use the helpers in src/lib/guest, which also limit the number of tries.
 */
export async function hashPasscode(passcode: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const { N, r, p } = PASSCODE_PARAMS;
  const key = await scryptAsync(passcode.normalize("NFKC"), salt, KEY_LENGTH, options(N, r, p));
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export type VerifyResult = { ok: boolean; needsRehash: boolean };

/** Checks a password against a stored hash. Throws PasswordBusyError like hashPassword(). */
export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return { ok: false, needsRehash: false };
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0 ||
    !Number.isInteger(r) || r < 1 || r > MAX_R ||
    !Number.isInteger(p) || p < 1 || p > MAX_P
  ) {
    return { ok: false, needsRehash: false };
  }
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) return { ok: false, needsRehash: false };

  const actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, options(N, r, p));
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  const needsRehash =
    ok && (N !== PARAMS.N || r !== PARAMS.r || p !== PARAMS.p || expected.length !== KEY_LENGTH);
  return { ok, needsRehash };
}

// A real hash, at the current cost, of a random password nobody ever knew. Verifying against it
// when the email is unknown makes "no such user" take as long as "wrong password".
// It is a constant, not computed when first needed: computing it took a whole extra hash, so in
// a freshly started process the first sign-in for an unknown email took twice as long as one for
// a known email, which told the two apart. Nothing can sign in with it: it belongs to no account.
// When PARAMS change, make a new one with the same settings (password.test.ts checks they match).
const DUMMY_HASH =
  "scrypt$131072$8$1$eF9wQQbpB81KVMztWCpUlw$lcu-EgXSr1t7-kpbA-izOAEbG0y5nByLl9bqrWNgTV5yr4IAOKCoiCkJbvszu_XSVAdh_OTakEoh5mTWyMI2Ow";

/** The hash to verify against when there is no such account. Resolves at once. */
export function getDummyHash(): Promise<string> {
  return Promise.resolve(DUMMY_HASH);
}
