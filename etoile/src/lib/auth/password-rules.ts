// What makes a password too easy to guess. Pure: no hashing, no database.
//
// Length stays the main rule (NIST SP 800-63B: no forced symbols, no forced mixes). On top of
// it, the handful of passwords that everybody tries first are refused, because the sign-in
// limits allow thousands of guesses a day against one account and these would fall in minutes.

export const PASSWORD_MIN_LENGTH = 10;
/** Bounds the hashing cost of a hostile input. */
export const PASSWORD_MAX_LENGTH = 256;

// The most used passwords of ten or more characters, lower case. Kept short on purpose: the
// patterns below catch the families (digits in a row, keyboard rows, a common word with digits).
const COMMON = new Set([
  "1234567890", "12345678910", "123456789a", "a123456789", "1234567891", "0123456789", "0987654321", "9876543210",
  "1234512345", "1122334455", "1111111111", "0000000000", "1234554321", "123123123123", "123456123456", "abcdefghij",
  "abcdefghijk", "abc1234567", "abcd123456", "abcde12345", "qwertyuiop", "qwertyuiop123", "qwerty12345", "qwerty123456",
  "1q2w3e4r5t", "1q2w3e4r5t6y", "q1w2e3r4t5", "q1w2e3r4t5y6", "1qaz2wsx3edc", "qazwsxedcrfv", "1qazxsw23edc", "zaq12wsxcde3",
  "asdfghjkl1", "asdfghjkl123", "asdfghjkl;'", "zxcvbnm123", "zxcvbnm1234", "qwer1234asdf", "1234qwerasdf", "qweasdzxc123",
  "passwordpassword", "password123", "password1234", "password12345", "password12", "passw0rd123", "p@ssw0rd123", "p@ssword123",
  "iloveyou12", "iloveyou123", "iloveyou1234", "letmein123", "letmein1234", "welcome123", "welcome1234", "changeme123",
  "admin12345", "admin123456", "administrator", "football123", "baseball123", "basketball", "superman123", "sunshine123",
  "princess123", "trustno1234", "whatever123", "starwars123", "monkey12345", "dragon12345", "master12345", "computer123",
  "internet123", "liverpool123", "chocolate1", "chocolate123", "butterfly1", "butterfly123", "jesuschrist", "blink182182",
]);

// Words that are a password to nobody once a few digits or signs are stuck on the end.
const COMMON_WORDS = new Set([
  "password", "passwort", "qwerty", "qwertyuiop", "iloveyou", "welcome", "letmein", "changeme", "sunshine", "princess",
  "football", "baseball", "superman", "trustno", "admin", "administrator", "login", "secret", "abcdef", "abcdefgh",
]);

const ROWS = ["1234567890", "0987654321", "qwertyuiop", "poiuytrewq", "asdfghjkl", "lkjhgfdsa", "zxcvbnm", "mnbvcxz", "abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba"];

/** True when the text is one run along a keyboard row or the alphabet ("3456789012", "ghijklmnop"). */
function isOneRun(text: string): boolean {
  return ROWS.some((row) => (row + row).includes(text));
}

/** The text with spaces and punctuation removed, lower case: how a name or an email is compared. */
const bare = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export type PasswordContext = {
  /** The account's email: a password may not be it, or the part before the @. */
  email?: string | null;
  /** The person's name: a password may not be it. */
  name?: string | null;
};

/**
 * Why a new password is not acceptable, as a sentence for the person, or null when it is fine.
 * Call it when a password is SET (sign-up, password change), never when one is checked.
 */
export function passwordProblem(password: string, context: PasswordContext = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return "Use a shorter password";

  const lower = password.normalize("NFKC").toLowerCase();
  const tooEasy = "That password is too easy to guess. Try a few words together";
  if (lower.trim().length === 0) return tooEasy; // only spaces
  // One character over and over, or two or three taking turns ("aaaaaaaaaa", "1212121212").
  if (new Set(lower).size < 4) return tooEasy;
  if (COMMON.has(lower) || isOneRun(lower)) return tooEasy;
  // A common word with digits and signs around it: "Password2026!", "qwerty!!!!123".
  const letters = lower.replace(/[^a-z]/g, "");
  if (COMMON_WORDS.has(letters)) return tooEasy;
  // The same short piece repeated: "abcabcabcabc", "hellohello".
  for (let size = 1; size <= lower.length / 2; size++) {
    if (lower.length % size === 0 && lower.slice(0, size).repeat(lower.length / size) === lower && size <= 6) return tooEasy;
  }

  const mine = bare(password);
  const own = "Do not use your own name or email address as the password";
  const email = (context.email ?? "").trim().toLowerCase();
  if (email) {
    if (lower === email || mine === bare(email)) return own;
    const local = bare(email.split("@")[0] ?? "");
    if (local.length >= 4 && (mine === local || mine.replace(/\d+$/, "") === local)) return own;
  }
  const name = bare(context.name ?? "");
  if (name.length >= 4 && (mine === name || mine.replace(/\d+$/, "") === name)) return own;

  return null;
}
