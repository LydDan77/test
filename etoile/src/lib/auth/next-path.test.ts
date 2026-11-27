import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("keeps paths on this site, with their query and hash", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/plans")).toBe("/plans");
    expect(safeNextPath("/plans/0123456789ab/flights")).toBe("/plans/0123456789ab/flights");
    expect(safeNextPath("/plans?tab=past&x=1")).toBe("/plans?tab=past&x=1");
    expect(safeNextPath("/heads-up#weather")).toBe("/heads-up#weather");
    expect(safeNextPath("/hartley-christmas")).toBe("/hartley-christmas");
  });

  it("refuses anything that could leave the site", () => {
    const attacks = [
      "https://evil.example",
      "http://evil.example/plans",
      "//evil.example",
      "//evil.example/plans",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/plans\\..\\..//evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "evil.example",
      "plans",
      " /plans",
      "/\u0000plans",
      "///evil.example",
      "/%09/evil.example".replace("%09", "\t"),
    ];
    for (const value of attacks) expect(safeNextPath(value), JSON.stringify(value)).toBe("/");
  });

  it("refuses values that are not a usable string", () => {
    for (const value of [undefined, null, "", 42, {}, ["/plans"], "/" + "a".repeat(2001)]) {
      expect(safeNextPath(value)).toBe("/");
    }
  });

  it("does not send someone back to an auth page", () => {
    expect(safeNextPath("/sign-in")).toBe("/");
    expect(safeNextPath("/sign-in?next=/plans")).toBe("/");
    expect(safeNextPath("/sign-up")).toBe("/");
    expect(safeNextPath("/sign-up/")).toBe("/");
    expect(safeNextPath("/sign-in-help")).toBe("/sign-in-help");
  });

  it("normalises dot segments instead of trusting them", () => {
    expect(safeNextPath("/plans/../you")).toBe("/you");
    expect(safeNextPath("/a/./b")).toBe("/a/b");
  });

  it("refuses a path whose dot segments collapse into an address on another site", () => {
    // Each of these starts with one "/" and looks local; the URL parser turns it into "//evil.example".
    const attacks = [
      "/.//evil.example",
      "/%2e//evil.example",
      "/a/..//evil.example",
      "/..//evil.example",
      "/plans/..//evil.example",
      "/.//evil.example/login",
      "/%2E%2E//evil.example",
      "/././/evil.example",
      "/.//127.0.0.1:3000/api/health",
      "/a/../..//evil.example?x=1#y",
    ];
    for (const value of attacks) expect(safeNextPath(value), JSON.stringify(value)).toBe("/");
    // An empty segment further in is refused too: it is never one of our paths.
    expect(safeNextPath("/plans//abc")).toBe("/");
    // "//" in the query or the hash is not a path segment and stays.
    expect(safeNextPath("/plans?from=https://example.com//x")).toBe("/plans?from=https://example.com//x");
  });

  it("never returns anything but a path on this site, whatever it is given", () => {
    // Every string of up to five of these pieces: 111,110 values.
    const pieces = ["/", ".", "..", "\\", "%2e", "%2f", "%5c", "evil.example", "?", "#"];
    const escapes: string[] = [];
    let checked = 0;
    const visit = (value: string, depth: number) => {
      if (depth > 0) {
        checked++;
        const result = safeNextPath(value);
        const url = new URL(result, "https://etoile.example");
        const local =
          result.startsWith("/") &&
          !result.startsWith("//") &&
          !result.startsWith("/\\") &&
          url.origin === "https://etoile.example" &&
          // What the browser would request is what was returned: nothing left to normalise.
          `${url.pathname}${url.search}${url.hash}` === result;
        if (!local) escapes.push(`${JSON.stringify(value)} -> ${JSON.stringify(result)}`);
      }
      if (depth === 5) return;
      for (const piece of pieces) visit(value + piece, depth + 1);
    };
    visit("", 0);
    expect(checked).toBe(111_110);
    expect(escapes.slice(0, 10)).toEqual([]);
  });
});
