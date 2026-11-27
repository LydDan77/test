// Slugs for public share pages, which live at the root of the site: `/[slug]`.
// Pure and import-free, so client components may use isValidSlug() for instant feedback.

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 60;

/**
 * Words a share page may never take, because `/[slug]` shares the root with the app.
 * Add a word here BEFORE adding a new top-level route under src/app.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // app routes that exist or are planned (BUILD-SPEC 4.1)
  "plans", "plan", "heads-up", "you", "sign-in", "sign-up", "sign-out", "api", "home", "new",
  "flights", "stay", "car", "rides", "food", "send-ahead", "people", "schedule", "money", "page",
  "settings", "print", "briefing", "clock", "clocks", "sites", "site", "share", "example",
  // public page sub-routes and guest links
  "rsvp", "agenda", "g", "guest", "guests", "invite", "calendar", "ics", "passcode", "unlock",
  // other spellings people try for accounts
  "signin", "signup", "signout", "login", "logout", "log-in", "log-out", "register", "join",
  "account", "accounts", "profile", "me", "user", "users", "auth", "session", "password",
  "reset", "forgot", "verify", "confirm", "welcome", "onboarding", "dashboard",
  // framework and static files
  "_next", "next", "static", "public", "assets", "images", "img", "fonts", "media", "files",
  "favicon", "favicon-ico", "robots", "robots-txt", "sitemap", "sitemap-xml", "manifest",
  "icon", "apple-icon", "opengraph-image", "twitter-image", "well-known", "not-found", "error",
  "404", "500", "index", "null", "undefined", "true", "false",
  // system and company words
  "admin", "administrator", "root", "system", "internal", "staff", "team", "support", "help",
  "contact", "about", "blog", "news", "press", "careers", "jobs", "legal", "terms", "privacy",
  "security", "status", "health", "docs", "developer", "developers", "app", "apps", "www", "web",
  "mail", "email", "ftp", "cdn", "billing", "pricing", "plans-and-pricing", "upgrade", "pro",
  "search", "explore", "discover", "feed", "notifications", "messages", "inbox", "test", "demo",
  // the brand
  "etoile", "etoile-app", "meridian", "official",
]);

/**
 * Turns any text into slug form: "Hartley Family Christmas!" becomes "hartley-family-christmas",
 * "Étoile à Montréal" becomes "etoile-a-montreal". May return "" (nothing usable) or a reserved
 * or too-short word; check the result with isValidSlug() or pass it to findFreeSlug().
 */
export function slugify(text: string): string {
  const base = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining marks left by NFKD: é -> e
    .replace(/ß/g, "ss")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[đĐ]/g, "d")
    .replace(/[łŁ]/g, "l")
    .replace(/['’‘`]/g, "") // "Lydia's" -> "lydias", not "lydia-s"
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= SLUG_MAX_LENGTH) return base;
  // Cut at the limit, then drop a hyphen the cut may have left at the end.
  return base.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SlugProblem = "empty" | "too_short" | "too_long" | "characters" | "reserved";

/** Why a slug is not acceptable, or null when it is. Wording for people is the caller's job. */
export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length === 0) return "empty";
  if (slug.length < SLUG_MIN_LENGTH) return "too_short";
  if (slug.length > SLUG_MAX_LENGTH) return "too_long";
  // Lower-case letters, digits and single hyphens between them. No leading or trailing hyphen.
  if (!SLUG_PATTERN.test(slug)) return "characters";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return null;
}

/** True when `slug` can be the address of a share page (shape and reserved words; not "is it free"). */
export function isValidSlug(slug: string): boolean {
  return slugProblem(slug) === null;
}

/**
 * Finds a free slug starting from any text. Tries the slugified text, then `-2`, `-3` … `-20`,
 * then a short random suffix. `isTaken` is the uniqueness check, usually a query on sites.slug:
 *
 *   const slug = await findFreeSlug(plan.title, async (s) =>
 *     (await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, s)).limit(1)).length > 0);
 *
 * The unique index on sites.slug is still the final word: two people can race for the same
 * slug, so catch isUniqueViolation() on insert and call this again.
 */
export async function findFreeSlug(
  text: string,
  isTaken: (slug: string) => boolean | Promise<boolean>,
  fallback = "my-plan",
): Promise<string> {
  let base = slugify(text);
  // "Car", "a", "" or "Sign in": pad with the fallback so there is always something valid.
  if (!isValidSlug(base)) {
    const padded = slugify(base ? `${base}-${fallback}` : fallback);
    base = isValidSlug(padded) ? padded : "my-plan";
  }
  if (!(await isTaken(base))) return base;

  const withSuffix = (suffix: string) =>
    `${base.slice(0, SLUG_MAX_LENGTH - suffix.length - 1).replace(/-+$/, "")}-${suffix}`;

  for (let n = 2; n <= 20; n++) {
    const candidate = withSuffix(String(n));
    if (!(await isTaken(candidate))) return candidate;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = withSuffix(randomSuffix());
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error("Could not find a free slug");
}

function randomSuffix(): string {
  const alphabet = "abcdefghjkmnpqrstvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}
