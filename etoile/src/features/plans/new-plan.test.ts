import { describe, expect, it } from "vitest";
import { MAX_NAMES, parseNameLines, suggestPlanTitle } from "./new-plan";

describe("parseNameLines", () => {
  it("reads one name per line and skips the blank ones", () => {
    expect(parseNameLines("Rob Hartley\n\n  Theo Hartley  \r\nJune\n")).toEqual([
      { name: "Rob Hartley", email: null },
      { name: "Theo Hartley", email: null },
      { name: "June", email: null },
    ]);
    expect(parseNameLines("")).toEqual([]);
    expect(parseNameLines("   \n \n")).toEqual([]);
  });

  it("understands Name <email>, and the other ways people write the pair", () => {
    expect(parseNameLines("Dana Hartley <Dana@Example.com>")).toEqual([{ name: "Dana Hartley", email: "dana@example.com" }]);
    expect(parseNameLines("Dana Hartley, dana@example.com")).toEqual([{ name: "Dana Hartley", email: "dana@example.com" }]);
    expect(parseNameLines("Dana Hartley dana@example.com")).toEqual([{ name: "Dana Hartley", email: "dana@example.com" }]);
    expect(parseNameLines("Dana Hartley;dana@example.com")).toEqual([{ name: "Dana Hartley", email: "dana@example.com" }]);
    expect(parseNameLines('"Dana Hartley" <dana@example.com>')).toEqual([{ name: "Dana Hartley", email: "dana@example.com" }]);
    expect(parseNameLines("- Dana Hartley <dana@example.com>")).toEqual([{ name: "Dana Hartley", email: "dana@example.com" }]);
  });

  it("makes a name from an address given alone", () => {
    expect(parseNameLines("dana.hartley@example.com")).toEqual([{ name: "Dana Hartley", email: "dana.hartley@example.com" }]);
    expect(parseNameLines("<chris_okafor+family@example.com>")).toEqual([{ name: "Chris Okafor", email: "chris_okafor+family@example.com" }]);
  });

  it("keeps a line as a name when what follows is not an address", () => {
    expect(parseNameLines("Grandma Ruth (maybe)")).toEqual([{ name: "Grandma Ruth (maybe)", email: null }]);
    expect(parseNameLines("Walt <not an email>")).toEqual([{ name: "Walt <not an email>", email: null }]);
    expect(parseNameLines("Mary-Jane O'Neil")).toEqual([{ name: "Mary-Jane O'Neil", email: null }]);
  });

  it("keeps a name given twice once, and stops at the limit", () => {
    expect(parseNameLines("Rob\nrob\nROB <rob@example.com>")).toEqual([{ name: "Rob", email: null }]);
    const many = Array.from({ length: MAX_NAMES + 50 }, (_, index) => `Guest ${index}`).join("\n");
    expect(parseNameLines(many)).toHaveLength(MAX_NAMES);
    expect(parseNameLines("x".repeat(500))[0].name).toHaveLength(120);
  });
});

describe("suggestPlanTitle", () => {
  const orlando = { kind: "city" as const, name: "Orlando", countryCode: "US" };

  it("names the plan after a holiday its dates include", () => {
    expect(suggestPlanTitle({ template: "family_event", destination: orlando, startDate: "2026-12-19", endDate: "2026-12-27" })).toBe("Christmas in Orlando");
    expect(suggestPlanTitle({ template: "trip", destination: orlando, startDate: "2026-11-25", endDate: "2026-11-29" })).toBe("Thanksgiving in Orlando");
    expect(suggestPlanTitle({ template: "family_event", destination: orlando, startDate: "2026-12-30", endDate: "2027-01-02" })).toBe("New Year's in Orlando");
    expect(suggestPlanTitle({ template: "family_event", destination: orlando, startDate: "2027-07-02", endDate: "2027-07-05" })).toBe("Fourth of July in Orlando");
    expect(suggestPlanTitle({ template: "family_event", startDate: "2026-12-25", endDate: "2026-12-25" })).toBe("Christmas");
  });

  it("keeps American holidays to America, and holidays out of work", () => {
    const lisbon = { kind: "city" as const, name: "Lisbon", countryCode: "PT" };
    expect(suggestPlanTitle({ template: "trip", destination: lisbon, startDate: "2026-11-25", endDate: "2026-11-29" })).toBe("Trip to Lisbon");
    expect(suggestPlanTitle({ template: "trip", destination: lisbon, startDate: "2026-12-20", endDate: "2026-12-28" })).toBe("Christmas in Lisbon");
    expect(suggestPlanTitle({ template: "work", workMode: "travel", destination: orlando, startDate: "2026-12-20", endDate: "2026-12-28" })).toBe("Work trip to Orlando");
  });

  it("otherwise says what it is and where", () => {
    expect(suggestPlanTitle({ template: "family_event", destination: orlando, startDate: "2027-05-01", endDate: "2027-05-04" })).toBe("Family get-together in Orlando");
    expect(suggestPlanTitle({ template: "trip", destination: orlando })).toBe("Trip to Orlando");
    expect(suggestPlanTitle({ template: "work", workMode: "event", destination: { kind: "city", name: "Austin", countryCode: "US" } })).toBe("Work event in Austin");
    expect(suggestPlanTitle({ template: "work", workMode: "travel" })).toBe("Work trip");
    expect(suggestPlanTitle({ template: "family_event" })).toBe("Family get-together");
    expect(suggestPlanTitle({ template: "trip", destination: null })).toBe("Trip");
  });

  it("uses an airport's city rather than its name", () => {
    expect(suggestPlanTitle({ template: "trip", destination: { kind: "airport", name: "Orlando International Airport", locality: "Orlando", countryCode: "US" } })).toBe("Trip to Orlando");
  });
});
