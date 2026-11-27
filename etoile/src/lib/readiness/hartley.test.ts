// Product spec 11.5: "This table doubles as a test: seed data with these states must compute to 68."

import { describe, expect, it } from "vitest";
import { bookingDetailsSchemas, expenseSplitSchema, placeRefSchema } from "@/lib/domain";
import { computeReadiness, toolStates } from "./readiness";
import { hartleyConfig, hartleyExample } from "./hartley-example";

const example = hartleyExample("2026-11-26");
const config = hartleyConfig("2026-11-26");
const readiness = computeReadiness(example.data, config, example.now);
const row = (component: string) => readiness.breakdown.find((r) => r.component === component)!;

describe("the Hartley family Christmas, 23 days out", () => {
  it("uses the spec's own dates", () => {
    expect(example.start).toBe("2026-12-19");
    expect(example.end).toBe("2026-12-27");
    expect(example.data.people).toHaveLength(9);
  });

  it("is made of rows the database would accept", () => {
    for (const booking of example.data.bookings) {
      expect(bookingDetailsSchemas[booking.kind].safeParse(booking.details).success, booking.title).toBe(true);
      expect(booking.details.kind).toBe(booking.kind);
    }
    for (const expense of example.data.expenses) expect(expenseSplitSchema.safeParse(expense.split).success).toBe(true);
    expect(placeRefSchema.safeParse(example.data.plan.destination).success).toBe(true);
    for (const arrival of example.data.arrivals) {
      expect(example.data.bookings.some((b) => b.id === arrival.bookingId)).toBe(true);
    }
  });

  it("computes to exactly 68", () => {
    expect(readiness.score).toBe(68);
  });

  it("has the stated credit and points for every component", () => {
    const table: [string, number, number, number][] = [
      // component, weight, credit, points
      ["gettingThere", 15, 1, 15],
      ["lodging", 15, 1, 15],
      ["car", 10, 0, 0],
      ["rides", 5, 0.25, 1.25],
      ["meals", 10, 0.83, 8.33],
      ["shipAhead", 5, 0.75, 3.75],
      ["people", 15, 0.78, 11.67],
      ["schedule", 10, 0.4, 4],
      ["site", 5, 1, 5],
      ["tasks", 10, 0.4, 4],
    ];
    for (const [component, weight, credit, points] of table) {
      expect(row(component), component).toMatchObject({ weight, credit, points });
    }
    expect(readiness.leftOut).toEqual([]);
    const total = readiness.breakdown.reduce((sum, r) => sum + r.points, 0);
    expect(total).toBeCloseTo(68, 1);
    expect(readiness.breakdown.reduce((sum, r) => sum + r.weight, 0)).toBe(100);
  });

  it("lists the breakdown largest gain first, as the spec does", () => {
    const gains = readiness.breakdown.filter((r) => r.pointsAvailable > 0).map((r) => [r.component, r.pointsAvailable]);
    expect(gains).toEqual([
      ["car", 10],
      ["schedule", 6],
      ["tasks", 6],
      ["rides", 3.75],
      ["people", 3.33],
      ["meals", 1.67],
      ["shipAhead", 1.25],
    ]);
  });

  it("describes each component's state in plain words", () => {
    expect(row("gettingThere").state).toBe("9 of 9 seats booked, both ways");
    expect(row("lodging").state).toBe("Lakeside house, 8 nights, all 9");
    expect(row("car").state).toBe("Needs you");
    expect(row("rides").state).toBe("0 of 1 ride sorted");
    expect(row("meals").state).toBe("2 of 3 orders placed");
    expect(row("shipAhead").state).toBe("1 box in transit");
    expect(row("people").state).toBe("7 of 9 replied");
    expect(row("schedule").state).toBe("2 of 5 key moments have a time and place");
    expect(row("site").state).toBe("Live");
    expect(row("tasks").state).toBe("2 of 5 essential to-dos done");
  });

  it("reads 'needs attention': the car is past its holiday date and not yet at its last day", () => {
    expect(readiness.pace).toBe("needs_attention");
    expect(readiness.paceLabel).toBe("Needs attention");
    expect(readiness.paceReason).toBe("Find the minivan.");
    expect(row("car").urgency).toBe(2);
  });

  it("makes the rental car the next action, in the words the hub shows", () => {
    expect(readiness.nextAction).toMatchObject({
      key: `car:${example.ids.car}`,
      kind: "car",
      component: "car",
      sentence: "Find the minivan.",
      detail: "Book by Dec 5. Holiday rentals sell out.",
      actionLabel: "Find a minivan",
      dueBy: "2026-12-05",
      urgency: 2,
      waiting: false,
      gain: 10,
      target: { tool: "car", href: "/plans/hartley/car", bookingId: example.ids.car },
    });
  });

  it("lists everything left as plain sentences, most worth doing first, waiting things last", () => {
    expect(readiness.thingsLeft.map((t) => [t.sentence, t.detail, t.actionLabel])).toEqual([
      ["Find the minivan.", "Book by Dec 5. Holiday rentals sell out.", "Find a minivan"],
      ["3 key moments need a time and a place.", "Lake picnic, Christmas Eve dinner and Farewell brunch.", "Finish the schedule"],
      ["Confirm who cooks what.", "Due Dec 10.", "Mark done"],
      ["Arrange airport pickups.", "Due Dec 12.", "Mark done"],
      ["Hold the mail.", "Due Dec 16.", "Mark done"],
      ["Dana and Chris have not replied.", "Replies are due Nov 28.", "Send a nudge"],
      ["Reserve the airport pickup.", "Planned for Sat, Dec 19 at 2:50 PM. Reserve by Dec 17.", "Reserve the ride"],
      ["The groceries can be ordered from Dec 14.", "Planned for Sat, Dec 19. The order window is not open yet.", "See the plan"],
      ["1 box is on its way.", "It should arrive Dec 21.", "Track it"],
    ]);
    expect(readiness.thingsLeft.filter((t) => t.waiting).map((t) => t.kind)).toEqual(["food", "send-ahead"]);
    expect(readiness.thingsLeftCount).toBe(7);
    expect(readiness.headline).toBe("7 things left");
  });

  it("shares each component's missing points among its things", () => {
    const gainOf = (component: string) =>
      readiness.thingsLeft.filter((t) => t.component === component).reduce((sum, t) => sum + t.gain, 0);
    expect(gainOf("car")).toBe(10);
    expect(gainOf("tasks")).toBe(6);
    expect(gainOf("people")).toBe(3.33);
    expect(gainOf("rides")).toBe(3.75);
  });

  it("never writes an exclamation mark, and ends every sentence", () => {
    for (const thing of readiness.thingsLeft) {
      expect(thing.sentence).not.toMatch(/!/);
      expect(thing.sentence).toMatch(/[.?]$/);
      if (thing.detail) expect(thing.detail).toMatch(/[.?]$/);
      expect(thing.actionLabel).not.toMatch(/[.!]$/);
      expect(thing.actionLabel[0]).toBe(thing.actionLabel[0].toUpperCase());
    }
  });

  it("gives each of the ten tools its line", () => {
    const tools = toolStates(example.data, config, example.now);
    expect(tools.map((t) => [t.tool, t.label, t.state])).toEqual([
      ["flights", "Flights", "All 9 booked"],
      ["stay", "Stay", "Booked: Lakeside house"],
      ["car", "Car", "Needs you"],
      ["rides", "Rides", "Airport pickup planned"],
      ["food", "Food", "2 deliveries set"],
      ["send-ahead", "Send ahead", "1 box on its way, arrives Dec 21"],
      ["people", "Who's coming", "7 of 9"],
      ["schedule", "Schedule", "5 things planned"],
      ["money", "Money", "$4,280 so far"],
      ["page", "Share page", "Live"],
    ]);
    expect(tools.map((t) => t.href)[0]).toBe("/plans/hartley/flights");
    expect(Object.fromEntries(tools.map((t) => [t.tool, t.tone]))).toMatchObject({
      flights: "done",
      stay: "done",
      car: "needs_you",
      rides: "underway",
      food: "waiting",
      "send-ahead": "waiting",
      page: "done",
    });
    expect(tools.find((t) => t.tool === "food")?.note).toBe("1 more planned");
    expect(tools.find((t) => t.tool === "people")?.note).toBe("2 have not replied");
    expect(tools.find((t) => t.tool === "money")?.note).toBe("$160 left of $7,000");
  });

  it("stays at 68 whatever day the account is created: the example is relative to today", () => {
    for (const today of ["2026-02-06", "2026-07-04", "2027-01-01", "2028-02-29"]) {
      const later = hartleyExample(today);
      const result = computeReadiness(later.data, hartleyConfig(today), later.now);
      expect(result.score, today).toBe(68);
      expect(result.pace, today).toBe("needs_attention");
      expect(result.nextAction?.sentence, today).toBe("Find the minivan.");
    }
  });
});
