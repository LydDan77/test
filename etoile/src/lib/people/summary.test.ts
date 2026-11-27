import { describe, expect, it } from "vitest";
import type { Party, Person } from "@/db/schema";
import { zonedToUtc } from "@/lib/time";
import { dietaryRollup, dietaryWord, namesOf, whosComing, type PeopleWords } from "./summary";
import { makeArrival, makeParty, makePerson, makePlan, makePlanData } from "./testing";
import { asSentence, count, durationWords, firstNameOf, firstNames, listOf, weekdayName } from "./text";

const now = zonedToUtc("2026-12-01T12:00", "America/New_York");
const GUESTS: PeopleWords = { person: "guest", people: "guests", party: "household", parties: "households" };

function nine() {
  const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
  const seattle = makeParty(plan.id, "The Seattle Hartleys", { sortOrder: 0, origin: { kind: "city", name: "Seattle", tz: "America/Los_Angeles" } });
  const portland = makeParty(plan.id, "The Portland Hartleys", { sortOrder: 1 });
  const minneapolis = makeParty(plan.id, "The Minneapolis Hartleys", { sortOrder: 2 });
  const people: Person[] = [
    makePerson(seattle, "Lydia Hartley"),
    makePerson(seattle, "Mark Hartley"),
    makePerson(seattle, "Theo Hartley", { ageGroup: "child", childAge: 9 }),
    makePerson(seattle, "June Hartley", { ageGroup: "child", childAge: 6, dietaryTags: ["nut_allergy"], dietaryNote: "Carries an EpiPen" }),
    makePerson(portland, "Dana Hartley", { rsvpStatus: "invited" }),
    makePerson(portland, "Chris Hartley", { rsvpStatus: "invited" }),
    makePerson(minneapolis, "Ruth Hartley", { dietaryTags: ["vegetarian"] }),
    makePerson(minneapolis, "Dale Hartley", { accessNote: "Ground-floor bedroom, please", dietaryTags: ["vegetarian", "gluten_free"] }),
    makePerson(minneapolis, "Rob Hartley"),
  ];
  const parties: Party[] = [seattle, portland, minneapolis];
  return { plan, parties, people, seattle, portland, minneapolis };
}

describe("who's coming", () => {
  it("counts by reply, in the product's own summary line", () => {
    const { plan, parties, people, portland, minneapolis } = nine();
    const arrivals = [
      makeArrival(portland, "arrival", { mode: "flight", scheduledAt: zonedToUtc("2026-12-19T15:55", "America/New_York"), tz: "America/New_York", rideNeed: "needs_ride" }),
      makeArrival(minneapolis, "arrival", { mode: "flight", personIds: [people[8].id], scheduledAt: zonedToUtc("2026-12-19T14:20", "America/New_York"), tz: "America/New_York", rideNeed: "needs_ride" }),
    ];
    const result = whosComing(makePlanData({ plan, parties, people, arrivals }), now, GUESTS);
    expect(result.line).toBe("9 guests · 7 coming · 2 no reply · 3 need a ride");
    expect(result).toMatchObject({ total: 9, coming: 7, notComing: 0, maybe: 0, noReply: 2, notInvited: 0, replied: 7, expected: 9, adults: 7, children: 2, infants: 0, needRide: 3 });
  });

  it("counts by household", () => {
    const { plan, parties, people } = nine();
    people[7].rsvpStatus = "no";
    people[8].rsvpStatus = "maybe";
    const result = whosComing(makePlanData({ plan, parties, people }), now, GUESTS);
    expect(result.households.map((h) => [h.name, h.line, h.total, h.coming, h.from])).toEqual([
      ["The Seattle Hartleys", "4 of 4 coming", 4, 4, "Seattle"],
      ["The Portland Hartleys", "No reply yet", 2, 0, null],
      ["The Minneapolis Hartleys", "1 coming, 1 maybe, 1 not coming", 3, 1, null],
    ]);
    expect(result.households[0].people[2]).toMatchObject({ name: "Theo Hartley", reply: "yes", isChild: true });
    expect(result.line).toBe("9 guests · 5 coming · 1 maybe · 1 not coming · 2 no reply");
    expect(result.expected).toBe(8);
    expect(result.adults).toBe(6);
  });

  it("uses the template's words, and plain ones when none are given", () => {
    const { plan, parties, people } = nine();
    const data = makePlanData({ plan, parties, people });
    expect(whosComing(data, now, { person: "attendee", people: "attendees", party: "team", parties: "teams" }).line).toBe("9 attendees · 7 coming · 2 no reply");
    expect(whosComing(data, now).line).toBe("9 people · 7 coming · 2 no reply");
  });

  it("reads well with nobody, one person, people not asked yet, and forty", () => {
    expect(whosComing(makePlanData(), now, GUESTS).line).toBe("0 guests");
    const plan = makePlan();
    const me = makeParty(plan.id, "Me");
    const solo = whosComing(makePlanData({ plan, parties: [me], people: [makePerson(me, "Lydia Hartley")] }), now, { ...GUESTS, person: "traveler", people: "travelers" });
    expect(solo.line).toBe("1 traveler · 1 coming");
    expect(solo.households[0].line).toBe("Coming");

    const notAsked = makePerson(me, "Sam", { rsvpStatus: "not_invited" });
    const fresh = whosComing(makePlanData({ plan, parties: [me], people: [notAsked] }), now, GUESTS);
    expect(fresh).toMatchObject({ noReply: 1, notInvited: 1, replied: 0, expected: 1 });

    const crowd = Array.from({ length: 40 }, (_, i) => makePerson(me, `Guest ${i}`, { rsvpStatus: i % 4 === 0 ? "no" : "yes" }));
    expect(whosComing(makePlanData({ plan, parties: [me], people: crowd }), now, GUESTS).line).toBe("40 guests · 30 coming · 10 not coming");
  });

  it("lists replies the host still has to confirm", () => {
    const { plan, parties, people, portland } = nine();
    const typed = makePerson(portland, "Cousin Vinny", { needsHostConfirmation: true, rsvpVia: "site_form" });
    expect(whosComing(makePlanData({ plan, parties, people: [...people, typed] }), now).toConfirm).toEqual([{ personId: typed.id, name: "Cousin Vinny" }]);
  });
});

describe("dietary and access needs", () => {
  it("rolls everyone's needs up, allergies first", () => {
    const { people } = nine();
    const rollup = dietaryRollup({ people });
    expect(rollup.summary).toBe("1 nut allergy, 1 gluten-free, 2 vegetarian");
    expect(rollup.sentence).toBe("9 people: 1 nut allergy, 1 gluten-free, 2 vegetarian.");
    expect(rollup).toMatchObject({ headcount: 9, adults: 7, children: 2, infants: 0, noNeeds: 6 });
    expect(rollup.tags[0]).toMatchObject({ tag: "nut_allergy", label: "nut allergy", count: 1, names: ["June"] });
    expect(rollup.tags[2].names).toEqual(["Ruth", "Dale"]);
    expect(rollup.dietaryNotes).toEqual([{ personId: people[3].id, name: "June Hartley", note: "Carries an EpiPen" }]);
    expect(rollup.accessNotes).toEqual([{ personId: people[7].id, name: "Dale Hartley", note: "Ground-floor bedroom, please" }]);
  });

  it("leaves out people who said no, and can be narrowed to the people a meal is for", () => {
    const { people } = nine();
    people[6].rsvpStatus = "no"; // Ruth, vegetarian
    expect(dietaryRollup({ people }).summary).toBe("1 nut allergy, 1 gluten-free, 1 vegetarian");
    const kids = dietaryRollup({ people }, [people[2].id, people[3].id]);
    expect(kids).toMatchObject({ headcount: 2, adults: 0, children: 2, summary: "1 nut allergy" });
  });

  it("says so plainly when nobody has a need, or nobody is coming", () => {
    const { people } = nine();
    const plain = people.map((person) => ({ ...person, dietaryTags: [], dietaryNote: null }));
    expect(dietaryRollup({ people: plain })).toMatchObject({ tags: [], summary: "", sentence: "9 people, no dietary needs on record.", noNeeds: 9 });
    expect(dietaryRollup({ people: [] }).sentence).toBe("0 people, no dietary needs on record.");
    expect(dietaryRollup({ people: [plain[0]] }).sentence).toBe("1 person, no dietary needs on record.");
  });

  it("has a word for every tag", () => {
    expect(["vegetarian", "vegan", "gluten_free", "nut_allergy", "shellfish_allergy", "kosher", "halal", "other"].map((tag) => dietaryWord(tag as never))).toEqual([
      "vegetarian", "vegan", "gluten-free", "nut allergy", "shellfish allergy", "kosher", "halal", "other needs",
    ]);
  });
});

describe("the small words", () => {
  it("lists names", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["Ruth"])).toBe("Ruth");
    expect(listOf(["Ruth", "Dale"])).toBe("Ruth and Dale");
    expect(listOf(["Ruth", "Dale", "Rob"])).toBe("Ruth, Dale and Rob");
    expect(firstNameOf("  Mary Jo Kopechne ")).toBe("Mary");
    expect(firstNames([{ name: "Chris Hartley" }, { name: "Dana Hartley" }])).toEqual(["Chris", "Dana"]);
    // Two people with the same first name are told apart.
    expect(firstNames([{ name: "Chris Hartley" }, { name: "Chris Okafor" }])).toEqual(["Chris Hartley", "Chris Okafor"]);
    const { people } = nine();
    expect(namesOf([people[4].id, people[5].id, "gone"], people)).toBe("Dana and Chris");
  });

  it("counts and measures", () => {
    expect(count(1, "box", "boxes")).toBe("1 box");
    expect(count(2, "box", "boxes")).toBe("2 boxes");
    expect(count(0, "night")).toBe("0 nights");
    expect([0, 1, 45, 60, 61, 320, 1440, 1500, 2879, 4320].map(durationWords)).toEqual([
      "0 minutes", "1 minute", "45 minutes", "1 hour", "1 hour 1 minute", "5 hours 20 minutes", "1 day", "1 day 1 hour", "2 days", "3 days",
    ]);
    expect(weekdayName("2026-12-19")).toBe("Saturday");
    expect(asSentence("Hold the mail")).toBe("Hold the mail.");
    expect(asSentence("Did you call?")).toBe("Did you call?");
    expect(asSentence("  ")).toBe("");
  });
});
