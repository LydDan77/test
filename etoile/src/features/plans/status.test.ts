import { describe, expect, it } from "vitest";
import { PLAN_STATUS_LABELS, PLAN_STATUS_ORDER, daysToGo, headcount, planStatus } from "./status";

const plan = (fields: Partial<Parameters<typeof planStatus>[0]> = {}) => ({
  startDate: "2026-12-19",
  endDate: "2026-12-27",
  archivedAt: null,
  tz: "America/New_York",
  ...fields,
});

describe("planStatus", () => {
  it("is a draft until the plan has dates", () => {
    expect(planStatus(plan({ startDate: null, endDate: null }), "2026-11-26T12:00:00Z")).toBe("draft");
  });

  it("is upcoming before the first day, in progress on its days and past after the last", () => {
    expect(planStatus(plan(), "2026-11-26T12:00:00Z")).toBe("upcoming");
    expect(planStatus(plan(), "2026-12-19T12:00:00Z")).toBe("in_progress");
    expect(planStatus(plan(), "2026-12-23T12:00:00Z")).toBe("in_progress");
    expect(planStatus(plan(), "2026-12-27T12:00:00Z")).toBe("in_progress");
    expect(planStatus(plan(), "2026-12-29T12:00:00Z")).toBe("past");
  });

  it("turns over at midnight at the plan's place, not at the server's", () => {
    // 04:59 UTC is 11:59 PM on the 18th in Orlando; 05:00 UTC is midnight on the 19th.
    expect(planStatus(plan(), "2026-12-19T04:59:00Z")).toBe("upcoming");
    expect(planStatus(plan(), "2026-12-19T05:00:00Z")).toBe("in_progress");
    // The last day lasts until midnight there too.
    expect(planStatus(plan(), "2026-12-28T04:59:00Z")).toBe("in_progress");
    expect(planStatus(plan(), "2026-12-28T05:00:00Z")).toBe("past");
    // The same dates in Tokyo begin fourteen hours earlier.
    expect(planStatus(plan({ tz: "Asia/Tokyo" }), "2026-12-18T15:00:00Z")).toBe("in_progress");
  });

  it("treats a plan with one date as a plan of one day", () => {
    const oneDay = plan({ endDate: null });
    expect(planStatus(oneDay, "2026-12-19T15:00:00Z")).toBe("in_progress");
    expect(planStatus(oneDay, "2026-12-20T15:00:00Z")).toBe("past");
  });

  it("is archived whenever the person put it away, whatever its dates", () => {
    const archivedAt = new Date("2026-11-01T00:00:00Z");
    expect(planStatus(plan({ archivedAt }), "2026-12-23T12:00:00Z")).toBe("archived");
    expect(planStatus(plan({ archivedAt, startDate: null, endDate: null }), "2026-12-23T12:00:00Z")).toBe("archived");
  });
});

describe("daysToGo", () => {
  it("counts whole days at the plan's place", () => {
    expect(daysToGo(plan(), "2026-11-26T21:30:00Z")).toBe(23);
    expect(daysToGo(plan(), "2026-12-19T12:00:00Z")).toBe(0);
    expect(daysToGo(plan(), "2026-12-21T12:00:00Z")).toBe(-2);
    expect(daysToGo(plan({ startDate: null }), "2026-11-26T21:30:00Z")).toBeNull();
    // Late evening in Orlando is still the same day there, though UTC has moved on.
    expect(daysToGo(plan(), "2026-11-27T04:30:00Z")).toBe(23);
    expect(daysToGo(plan(), "2026-11-27T05:30:00Z")).toBe(22);
  });
});

describe("headcount", () => {
  it("is the count the person gave until more people than that have been added", () => {
    expect(headcount({ expectedPeople: 9 }, 1)).toBe(9);
    expect(headcount({ expectedPeople: 9 }, 9)).toBe(9);
    expect(headcount({ expectedPeople: 9 }, 11)).toBe(11);
    expect(headcount({ expectedPeople: 1 }, 0)).toBe(1);
  });
});

describe("list order and labels", () => {
  it("shows what is happening now first and what was put away last", () => {
    const order = Object.entries(PLAN_STATUS_ORDER).sort((a, b) => a[1] - b[1]).map(([status]) => status);
    expect(order).toEqual(["in_progress", "upcoming", "draft", "past", "archived"]);
    expect(Object.keys(PLAN_STATUS_LABELS).sort()).toEqual([...order].sort());
  });
});
