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
});
