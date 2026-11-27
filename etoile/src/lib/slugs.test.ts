import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  findFreeSlug,
  isValidSlug,
  slugProblem,
  slugify,
} from "./slugs";

describe("slugify", () => {
  it("makes readable lower-case slugs", () => {
    expect(slugify("Hartley Family Christmas")).toBe("hartley-family-christmas");
    expect(slugify("  Hartley   Christmas!  ")).toBe("hartley-christmas");
    expect(slugify("Team Offsite 2027 (Q1)")).toBe("team-offsite-2027-q1");
    expect(slugify("Mom & Dad's 40th")).toBe("mom-and-dads-40th");
    expect(slugify("already-a-slug")).toBe("already-a-slug");
    expect(slugify("under_scores and.dots")).toBe("under-scores-and-dots");
  });

  it("drops accents instead of dropping letters", () => {
    expect(slugify("Étoile à Montréal")).toBe("etoile-a-montreal");
    expect(slugify("Zürich & São Paulo")).toBe("zurich-and-sao-paulo");
    expect(slugify("Straße Łódź Ærø Øst")).toBe("strasse-lodz-aero-ost");
  });

  it("returns nothing when there is nothing usable", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("🎄🎄🎄")).toBe("");
    expect(slugify("日本")).toBe("");
  });

  it("cuts long text without leaving a trailing hyphen", () => {
    const slug = slugify("a".repeat(SLUG_MAX_LENGTH - 1) + " and more words after the limit");
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });
});

describe("isValidSlug", () => {
  it("accepts ordinary slugs", () => {
    for (const slug of ["hartley-christmas", "abc", "offsite-2027", "2027", "a1b"]) {
      expect(isValidSlug(slug), slug).toBe(true);
    }
  });

  it("rejects bad shapes, and says why", () => {
    expect(slugProblem("")).toBe("empty");
    expect(slugProblem("ab")).toBe("too_short");
    expect(slugProblem("a".repeat(SLUG_MAX_LENGTH + 1))).toBe("too_long");
    for (const slug of ["Hartley", "hartley christmas", "-hartley", "hartley-", "hart--ley", "hart_ley", "hart.ley", "hartley/x", "étoile", "a%20b"]) {
      expect(slugProblem(slug), slug).toBe("characters");
    }
    expect(slugProblem("hartley-christmas")).toBeNull();
  });

  it("rejects every reserved word", () => {
    for (const word of ["plans", "heads-up", "you", "sign-in", "sign-up", "api", "admin", "settings", "login", "etoile", "_next", "help", "www"]) {
      expect(RESERVED_SLUGS.has(word), word).toBe(true);
      expect(isValidSlug(word), word).toBe(false);
    }
    expect(slugProblem("plans")).toBe("reserved");
  });

  it("reserves every top-level route that exists under src/app", () => {
    const appDir = path.join(process.cwd(), "src", "app");
    const segments: string[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (!statSync(full).isDirectory()) continue;
        // Route groups "(name)" do not appear in the URL; look inside them at the same depth.
        if (entry.startsWith("(")) walk(full, depth);
        else if (depth === 0 && !entry.startsWith("[") && !entry.startsWith("_") && !entry.startsWith("@")) segments.push(entry);
      }
    };
    walk(appDir, 0);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(RESERVED_SLUGS.has(segment), `"${segment}" is a route under src/app but is not in RESERVED_SLUGS`).toBe(true);
    }
  });

  it("reserves every route the build spec plans", () => {
    const planned = ["plans", "heads-up", "you", "sign-in", "sign-up", "api", "flights", "stay", "car", "rides", "food", "send-ahead", "people", "schedule", "money", "page", "settings", "print", "new"];
    for (const word of planned) expect(RESERVED_SLUGS.has(word), word).toBe(true);
  });
});

describe("findFreeSlug", () => {
  const takenFrom = (taken: string[]) => (slug: string) => taken.includes(slug);

  it("uses the plain slug when it is free", async () => {
    expect(await findFreeSlug("Hartley Christmas", () => false)).toBe("hartley-christmas");
  });

  it("adds -2, -3 … when the slug is taken", async () => {
    expect(await findFreeSlug("Hartley Christmas", takenFrom(["hartley-christmas"]))).toBe("hartley-christmas-2");
    expect(await findFreeSlug("Hartley Christmas", takenFrom(["hartley-christmas", "hartley-christmas-2", "hartley-christmas-3"]))).toBe("hartley-christmas-4");
  });

  it("works with an asynchronous check", async () => {
    const taken = new Set(["reunion"]);
    expect(await findFreeSlug("Reunion", async (slug) => taken.has(slug))).toBe("reunion-2");
  });

  it("never returns a reserved, short or empty slug", async () => {
    for (const title of ["Plans", "Sign in", "API", "Car", "a", "", "!!!", "🎄", "You", "Settings"]) {
      const slug = await findFreeSlug(title, () => false);
      expect(isValidSlug(slug), `${title} -> ${slug}`).toBe(true);
    }
    expect(await findFreeSlug("", () => false)).toBe("my-plan");
    expect(await findFreeSlug("Car", () => false)).toBe("car-my-plan");
    expect(await findFreeSlug("", () => false, "hartley family")).toBe("hartley-family");
  });

  it("keeps the suffix inside the length limit", async () => {
    const long = "x".repeat(SLUG_MAX_LENGTH);
    const slug = await findFreeSlug(long, takenFrom([long]));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith("-2")).toBe(true);
    expect(isValidSlug(slug)).toBe(true);
  });

  it("falls back to a random suffix when the numbered ones are gone, and gives up cleanly", async () => {
    const numbered = new Set(["trip", ...Array.from({ length: 19 }, (_, i) => `trip-${i + 2}`)]);
    const slug = await findFreeSlug("Trip", (s) => numbered.has(s));
    expect(slug).toMatch(/^trip-[a-z0-9]{5}$/);
    expect(isValidSlug(slug)).toBe(true);
    await expect(findFreeSlug("Trip", () => true)).rejects.toThrow("Could not find a free slug");
  });
});
