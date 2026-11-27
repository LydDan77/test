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

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function options(N: number, r: number, p: number): ScryptOptions {
  // Node's default maxmem is 32 MiB, which rejects every N above 2^14 at r=8 with
  // ERR_CRYPTO_INVALID_SCRYPT_PARAMS ("memory limit exceeded"). scrypt needs about 128*N*r bytes.
  return { N, r, p, maxmem: 256 * N * r };
}

/** Returns `scrypt$N$r$p$<salt base64url>$<key base64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const { N, r, p } = PARAMS;
  // NFKC so the same visible password typed on different keyboards hashes identically.
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, options(N, r, p));
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export type VerifyResult = { ok: boolean; needsRehash: boolean };

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

// A real hash of a random password, computed once per process. Verifying against it when the
// e-mail is unknown makes "no such user" take as long as "wrong password".
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(24).toString("base64url")));
}
