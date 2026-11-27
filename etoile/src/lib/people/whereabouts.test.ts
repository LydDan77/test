import { describe, expect, it } from "vitest";
import type { Arrival, Party, Person } from "@/db/schema";
import { zonedToUtc } from "@/lib/time";
import { makeArrival, makeBooking, makeParty, makePerson, makePlan, makePlanData, seg } from "./testing";
import { travelStatus } from "./travel-status";
import { whereIsEverybody } from "./whereabouts";

const NY = "America/New_York";
const t = (local: string) => zonedToUtc(local, NY);

/** Travel day, Sat Dec 19: nine people in four households, at various distances from the door. */
function travelDayScene() {
  const plan = makePlan({ startDate: "2026-12-19", endDate: "2026-12-27" });
  const mk = (name: string, members: string[], order: number) => {
    const party = makeParty(plan.id, name, { sortOrder: order });
    return { party, people: members.map((m) => makePerson(party, m)) };
  };
  const seattle = mk("The Seattle Hartleys", ["Lydia Hartley", "Mark Hartley", "Theo Hartley", "June Hartley"], 0);
  const grand = mk("Ruth and Dale", ["Ruth Hartley", "Dale Hartley"], 1);
  const portland = mk("The Portland Hartleys", ["Dana Hartley", "Chris Hartley"], 2);
  const rob = mk("Rob", ["Rob Hartley"], 3);
  const portlandFlight = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("AS 772", "PDX", "2026-12-19T07:40", "MCO", "2026-12-19T15:55")] }, { personIds: portland.people.map((p) => p.id) });
  const parties: Party[] = [seattle.party, grand.party, portland.party, rob.party];
  const people: Person[] = [...seattle.people, ...grand.people, ...portland.people, ...rob.people];
  const arrivals: Arrival[] = [
    makeArrival(seattle.party, "arrival", { mode: "drive", scheduledAt: t("2026-12-19T13:00"), tz: NY, status: "arrived", statusAt: t("2026-12-19T13:20") }),
    makeArrival(grand.party, "arrival", { mode: "drive", scheduledAt: t("2026-12-19T15:12"), tz: NY }),
    makeArrival(portland.party, "arrival", { bookingId: portlandFlight.id, segmentIndex: 0 }),
  ];
  return { data: makePlanData({ plan, parties, people, arrivals, bookings: [portlandFlight] }), seattle, grand, portland, rob };
}

describe("where is everybody", () => {
  it("writes the one sentence for the top of the screen", () => {
    const { data } = travelDayScene();
    const result = whereIsEverybody(data, t("2026-12-19T15:00"));
    expect(result.sentence).toBe("4 of 9 are here. Ruth and Dale are next, about 12 minutes away.");
    expect(result).toMatchObject({ total: 9, here: 4 });
    expect(result.next).toMatchObject({ who: "Ruth and Dale", state: "on_the_way", minutesAway: 12, line: "About 12 minutes away" });
  });

  it("lists each household with how far they are from the door, soonest first", () => {
    const { data } = travelDayScene();
    const result = whereIsEverybody(data, t("2026-12-19T15:00"));
    expect(result.households.map((h) => [h.who, h.state, h.minutesAway, h.line])).toEqual([
      ["Ruth and Dale", "on_the_way", 12, "About 12 minutes away"],
      // Lands 3:55 PM, plus an hour for bags and the drive.
      ["Dana and Chris", "on_the_way", 115, "Lands 3:55 PM, here about 4:55 PM"],
      ["Rob", "no_travel", null, "No arrival on record"],
      ["The Seattle Hartleys", "here", 0, "Here"],
    ]);
    expect(result.households[1].doorAt).toEqual({ at: t("2026-12-19T16:55").toISOString(), tz: NY });
  });

  it("uses the drive time it is given instead of the default hour", () => {
    const { data } = travelDayScene();
    const result = whereIsEverybody(data, t("2026-12-19T15:00"), { landingToDoorMinutes: 35 });
    expect(result.households[1].line).toBe("Lands 3:55 PM, here about 4:30 PM");
    expect(result.households[1].minutesAway).toBe(90);
  });

  it("follows what people tap: landed, picked up, arrived", () => {
    const { data, portland } = travelDayScene();
    const set = (status: Arrival["status"], at: string) =>
      data.arrivals.map((a) => (a.partyId === portland.party.id ? { ...a, status, statusAt: t(at) } : a));
    const landed = whereIsEverybody({ ...data, arrivals: set("landed", "2026-12-19T16:02") }, t("2026-12-19T16:10"));
    expect(landed.households.find((h) => h.who === "Dana and Chris")).toMatchObject({ state: "on_the_way", minutesAway: 52, line: "Landed, about 50 minutes away" });
    const pickedUp = whereIsEverybody({ ...data, arrivals: set("picked_up", "2026-12-19T16:30") }, t("2026-12-19T16:40"));
    expect(pickedUp.households.find((h) => h.who === "Dana and Chris")).toMatchObject({ minutesAway: 20, line: "Picked up, about 20 minutes away" });
    const arrived = whereIsEverybody({ ...data, arrivals: set("arrived", "2026-12-19T17:05") }, t("2026-12-19T17:10"));
    expect(arrived.here).toBe(6);
  });

  it("says someone should be here by now rather than guessing they are", () => {
    const { data } = travelDayScene();
    const result = whereIsEverybody(data, t("2026-12-19T15:30"));
    expect(result.next).toMatchObject({ who: "Ruth and Dale", state: "due", minutesAway: 0, line: "Should be here by now" });
    expect(result.sentence).toBe("4 of 9 are here. Ruth and Dale should be here by now.");
    expect(result.here).toBe(4);
  });

  it("counts people who live there as here, and says when everyone is", () => {
    const { data, rob } = travelDayScene();
    const local = makeArrival(rob.party, "arrival", { mode: "local" });
    const allIn = data.arrivals.map((a) => ({ ...a, status: "arrived" as const }));
    const result = whereIsEverybody({ ...data, arrivals: [...allIn, local] }, t("2026-12-19T18:00"));
    expect(result).toMatchObject({ total: 9, here: 9, next: null, sentence: "All 9 are here." });
  });

  it("speaks in days when the next arrival is far off, and in hours when it is hours", () => {
    const { data } = travelDayScene();
    expect(whereIsEverybody(data, t("2026-12-10T09:00")).sentence).toBe("4 of 9 are here. Ruth and Dale are next, on Sat, Dec 19 at about 3:12 PM.");
    const noneHere = { ...data, arrivals: data.arrivals.map((a) => ({ ...a, status: "unknown" as const })) };
    expect(whereIsEverybody(noneHere, t("2026-12-19T11:00")).sentence).toBe("0 of 9 are here. The Seattle Hartleys are next, about 2 hours away.");
    expect(whereIsEverybody(noneHere, t("2026-12-19T12:59:30")).next?.line).toBe("About a minute away");
    expect(whereIsEverybody(data, t("2026-12-19T15:00"), { wording: { style: "24h" } }).households[1].line).toBe("Lands 1555, here about 1655");
  });

  it("handles one person, nobody, and people with no times", () => {
    expect(whereIsEverybody(makePlanData(), t("2026-12-19T15:00")).sentence).toBe("Nobody is on the list yet.");
    const plan = makePlan();
    const me = makeParty(plan.id, "Me");
    const lydia = makePerson(me, "Lydia Hartley");
    const solo = makePlanData({ plan, parties: [me], people: [lydia] });
    expect(whereIsEverybody(solo, t("2026-12-19T15:00")).sentence).toBe("No arrival time yet.");
    const driving = { ...solo, arrivals: [makeArrival(me, "arrival", { mode: "drive", scheduledAt: t("2026-12-19T17:00"), tz: NY })] };
    expect(whereIsEverybody(driving, t("2026-12-19T15:00")).sentence).toBe("You are about 2 hours away.");
    expect(whereIsEverybody(driving, t("2026-12-19T17:30")).sentence).toBe("You should be there by now.");
    expect(whereIsEverybody(driving, t("2026-12-12T17:30")).sentence).toBe("You arrive on Sat, Dec 19 at about 5:00 PM.");
    const here = { ...solo, arrivals: [makeArrival(me, "arrival", { mode: "drive", status: "arrived" })] };
    expect(whereIsEverybody(here, t("2026-12-19T15:00")).sentence).toBe("You are here.");
    const noTime = { ...solo, arrivals: [makeArrival(me, "arrival", { mode: "flight" })] };
    expect(whereIsEverybody(noTime, t("2026-12-19T15:00")).households[0]).toMatchObject({ state: "no_time", line: "No time yet", minutesAway: null });
  });
});

describe("travel status per attendee", () => {
  /** A work offsite in Austin, Jan 12 to 15, 2027. */
  function offsite() {
    const austin = { kind: "city" as const, name: "Austin", tz: "America/Chicago" };
    const plan = makePlan({ template: "work", workMode: "event", destination: austin, tz: austin.tz, startDate: "2027-01-12", endDate: "2027-01-15" });
    const team = (name: string, order: number) => makeParty(plan.id, name, { sortOrder: order });
    const product = team("Product", 0);
    const sales = team("Sales", 1);
    const local = team("Austin office", 2);
    const priya = makePerson(product, "Priya Nair", { dietaryTags: ["vegetarian"], dietaryNote: "No mushrooms", jobTitle: "Design lead" });
    const omar = makePerson(product, "Omar Haddad");
    const jules = makePerson(sales, "Jules Martin", { rsvpStatus: "invited", team: "Field sales" });
    const kenji = makePerson(sales, "Kenji Sato", { rsvpStatus: "no" });
    const tess = makePerson(local, "Tess Alvarez", { accessNote: "Step-free access" });
    const wen = makePerson(sales, "Wen Li", { rsvpStatus: "maybe" });
    const hotel = makeBooking(plan.id, "lodging", { lodgingType: "hotel", propertyName: "Hotel Ella", checkInDate: "2027-01-12", checkOutDate: "2027-01-15" }, { personIds: [priya.id, omar.id] });
    const priyaFlight = makeBooking(
      plan.id,
      "flight",
      { tripType: "round_trip", segments: [seg("AS 580", "SEA", "2027-01-12T08:00", "AUS", "2027-01-12T14:10"), seg("AS 581", "AUS", "2027-01-15T16:00", "SEA", "2027-01-15T18:25")] },
      { personIds: [priya.id] },
    );
    const omarOut = makeBooking(plan.id, "flight", { tripType: "one_way", segments: [seg("UA 2210", "ORD", "2027-01-12T09:15", "AUS", "2027-01-12T12:05")] }, { personIds: [omar.id] });
    const arrivals = [
      makeArrival(product, "arrival", { personIds: [priya.id], bookingId: priyaFlight.id, segmentIndex: 0, rideNeed: "needs_ride" }),
      makeArrival(local, "arrival", { mode: "local" }),
      makeArrival(sales, "arrival", { personIds: [wen.id], mode: "drive", scheduledAt: zonedToUtc("2027-01-12T10:00", austin.tz), tz: austin.tz }),
      makeArrival(sales, "departure", { personIds: [wen.id], mode: "drive" }),
    ];
    const data = makePlanData({ plan, parties: [product, sales, local], people: [priya, omar, jules, kenji, tess, wen], bookings: [hotel, priyaFlight, omarOut], arrivals });
    return { data, priya };
  }
  const now = zonedToUtc("2027-01-02T12:00", "America/Chicago");

  it("fills in a row for each attendee", () => {
    const { data } = offsite();
    const status = travelStatus(data, now);
    const cells = status.rows.map((r) => [r.name, r.team, r.registered.label, r.arrival.label, r.lodging.label, r.ride.label, r.departure.label, r.overall.label]);
    expect(cells).toEqual([
      ["Priya Nair", "Product", "Yes", "AS 580, Tue 2:10 PM", "Hotel Ella, 3 nights", "Needs a ride", "AS 581, Fri 4:00 PM", "Ready"],
      ["Omar Haddad", "Product", "Yes", "UA 2210, Tue 12:05 PM", "Hotel Ella, 3 nights", "Not known yet", "Missing", "Missing departure"],
      ["Jules Martin", "Field sales", "No reply", "Missing", "Missing", "", "Missing", "No reply"],
      ["Kenji Sato", "Sales", "No", "", "", "", "", "Not coming"],
      ["Tess Alvarez", "Austin office", "Yes", "Local", "Lives nearby", "Covered", "Missing", "Missing departure"],
      ["Wen Li", "Sales", "Maybe", "Driving", "Missing", "Covered", "Driving", "Missing stay"],
    ]);
  });

  it("keeps every missing thing, the needs, and the counts the filters use", () => {
    const { data } = offsite();
    const status = travelStatus(data, now);
    const byName = Object.fromEntries(status.rows.map((r) => [r.name, r]));
    expect(byName["Jules Martin"].missing).toEqual(["reply", "arrival", "lodging", "departure"]);
    expect(byName["Kenji Sato"].missing).toEqual([]);
    expect(byName["Priya Nair"]).toMatchObject({ dietary: ["vegetarian", "No mushrooms"], access: null, jobTitle: "Design lead", ride: { needsRide: true } });
    expect(byName["Tess Alvarez"].access).toBe("Step-free access");
    expect(status.counts).toEqual({ total: 6, ready: 1, missingSomething: 4, missingArrival: 1, missingLodging: 2, missingDeparture: 3, noReply: 1, notComing: 1 });
    expect(status.homeLine).toBe("1 arrival still unbooked");
  });

  it("is the trip sheet for someone travelling alone for work", () => {
    const { data, priya } = offsite();
    const soloParty = data.parties[0];
    const solo = { ...data, parties: [soloParty], people: [priya], arrivals: data.arrivals.filter((a) => a.personIds.includes(priya.id)) };
    const status = travelStatus(solo, now);
    expect(status.rows).toHaveLength(1);
    expect(status.rows[0].overall.label).toBe("Ready");
    expect(status.homeLine).toBeNull();
    expect(status.counts.missingSomething).toBe(0);
  });

  it("is empty for an empty plan, and says how many arrivals are missing for a new list", () => {
    expect(travelStatus(makePlanData(), now)).toMatchObject({ rows: [], homeLine: null, counts: { total: 0, ready: 0 } });
    const { data } = offsite();
    const fresh = travelStatus({ ...data, arrivals: [], bookings: [] }, now);
    expect(fresh.homeLine).toBe("5 arrivals still unbooked");
    expect(fresh.rows[0]).toMatchObject({ arrival: { label: "Missing", missing: true }, lodging: { label: "Missing", missing: true }, overall: { label: "Missing arrival" } });
  });
});
