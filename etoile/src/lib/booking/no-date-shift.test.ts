// No date may ever move because of the zone the machine is in. Every expected value below is a
// literal, so the same file passing under TZ=Pacific/Kiritimati (UTC+14), TZ=America/Los_Angeles
// (UTC-8) and TZ=UTC is the proof. Run:
//   TZ=Pacific/Kiritimati npx vitest run src/lib/booking src/lib/calendar
//   TZ=America/Los_Angeles npx vitest run src/lib/booking src/lib/calendar

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calendarLinks, icsForItems } from "@/lib/calendar";
import type { PlaceRef } from "@/lib/domain";
import { actByFor } from "./act-by";
import { bookingDetailsFromQuery } from "./details";
import { AIRPORTS, contextFor, hartley, makePlan, planData } from "./fixtures/plan";
import { flightStatusLinks, handoffLinks } from "./links";
import { suggestNextSteps } from "./next-steps";
import { parseConfirmation } from "./parse";
import { proposeSearch } from "./propose";
import { expediaCarsLink, kayakCarsLink, turoLink } from "./providers/car";
import { expediaFlightsLink, googleFlightsLink, kayakFlightsLink, skyscannerFlightsLink } from "./providers/flights";
import { airbnbLink, bookingComLink, expediaStayLink, hotelsComLink, vrboLink } from "./providers/stay";
import type { CarQuery, FlightQuery, StayQuery } from "./types";

// Days where a careless Date would slip: New Year either side, a leap day, and the days US
// clocks change (Mar 8 and Nov 1, 2026).
const EDGE_DAYS: Array<[out: string, back: string]> = [
  ["2026-12-31", "2027-01-01"],
  ["2027-01-01", "2027-01-02"],
  ["2028-02-28", "2028-02-29"],
  ["2028-02-29", "2028-03-01"],
  ["2026-03-07", "2026-03-08"],
  ["2026-03-08", "2026-03-09"],
  ["2026-10-31", "2026-11-01"],
  ["2026-11-01", "2026-11-02"],
];

const us = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
const usPlain = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}/${date.slice(0, 4)}`;
const yymmdd = (date: string) => `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}`;
const compact = (date: string) => date.replace(/-/g, "");

const ORLANDO: PlaceRef = { kind: "city", name: "Orlando", tz: "America/New_York" };

describe("link dates are the stored local dates, digit for digit", () => {
  it.each(EDGE_DAYS)("flights %s to %s", (out, back) => {
    const q: FlightQuery = { kind: "flight", tripType: "round_trip", cabin: "economy", originIata: "SEA", destinationIata: "MCO", departDate: out, returnDate: back, adults: 1, children: 0, infants: 0 };
    expect(decodeURIComponent(googleFlightsLink(q).url)).toContain(`on ${out} through ${back}`);
    expect(kayakFlightsLink(q).url).toBe(`https://www.kayak.com/flights/SEA-MCO/${out}/${back}?sort=bestflight_a`);
    expect(skyscannerFlightsLink(q).url).toContain(`/sea/mco/${yymmdd(out)}/${yymmdd(back)}/?`);
    expect(expediaFlightsLink(q).url).toContain(`/Roundtrip/${out}/${back}?`);
    expect(expediaFlightsLink({ ...q, cabin: "first" }).url).toContain(`departure:${us(out)}TANYT&leg2=from:MCO,to:SEA,departure:${us(back)}TANYT`);
  });

  it.each(EDGE_DAYS)("stays %s to %s", (checkIn, checkOut) => {
    const q: StayQuery = { kind: "lodging", lodgingType: "hotel", place: ORLANDO, checkInDate: checkIn, checkOutDate: checkOut, adults: 2, children: 0, infants: 0, childAges: [], rooms: 1 };
    expect(bookingComLink(q).url).toContain(`checkin=${checkIn}&checkout=${checkOut}&`);
    expect(airbnbLink(q).url).toContain(`checkin=${checkIn}&checkout=${checkOut}&`);
    expect(vrboLink(q).url).toContain(`startDate=${checkIn}&endDate=${checkOut}&`);
    expect(hotelsComLink(q).url).toContain(`startDate=${checkIn}&endDate=${checkOut}&`);
    expect(expediaStayLink(q).url).toContain(`/Destination/${checkIn}/${checkOut}?`);
  });

  it.each(EDGE_DAYS)("cars %s to %s", (pickup, back) => {
    const q: CarQuery = { kind: "car", pickupPlace: AIRPORTS.MCO, pickupDate: pickup, pickupTime: "00:30", returnDate: back, returnTime: "23:30", seats: 2, childSeats: 0 };
    expect(kayakCarsLink(q).url).toBe(`https://www.kayak.com/cars/MCO/${pickup}/${back}?sort=price_a`);
    expect(expediaCarsLink(q).url).toContain(`date1=${usPlain(pickup)}&date2=${usPlain(back)}&time1=1230AM&time2=1130PM`);
    expect(decodeURIComponent(turoLink(q).url)).toContain(`startDate=${us(pickup)}&startTime=00:30&endDate=${us(back)}&endTime=23:30`);
    expect(expediaCarsLink({ ...q, pickupTime: "00:00", returnTime: "23:00" }).url).toContain(`/Airport/${pickup}/${back}?PickUpLoc=mco&DiffDropLoc=0&PickUpTime=12AM&DropTime=11PM`);
  });

  it.each(EDGE_DAYS)("calendar entries %s to %s", (first, last) => {
    const item = { id: "x", title: "Stay", allDay: true, localDate: first, endDate: first };
    const ics = icsForItems([item, { id: "y", title: "Two days", allDay: true, localDate: first, endDate: last }], { now: "2026-01-01T00:00:00Z" });
    expect(ics).toContain(`DTSTART;VALUE=DATE:${compact(first)}\r\nDTEND;VALUE=DATE:${compact(last)}`);
    const [google, outlook] = calendarLinks(item);
    expect(google.url).toContain(`dates=${compact(first)}/${compact(last)}`);
    expect(outlook.url).toContain(`startdt=${first}&enddt=${last}&allday=true`);
  });
});

describe("times near midnight stay on their own day, in the place's zone", () => {
  // A flight landing in Orlando at 11:40 PM on New Year's Eve: 04:40 UTC on Jan 1.
  const lateFlight = {
    ...hartley().bookings[0],
    details: {
      kind: "flight" as const,
      segments: [
        { airlineIata: "AS", flightNumber: "1054", originIata: "SEA", destinationIata: "MCO", departsAt: "2026-12-31T23:05:00Z", originTz: "America/Los_Angeles", arrivesAt: "2027-01-01T04:40:00Z", destinationTz: "America/New_York" },
        { airlineIata: "AS", flightNumber: "1055", originIata: "MCO", destinationIata: "SEA", departsAt: "2027-01-08T05:30:00Z", originTz: "America/New_York", arrivesAt: "2027-01-08T11:45:00Z", destinationTz: "America/Los_Angeles" },
      ],
    },
  };
  const data = hartley({ plan: makePlan({ startDate: "2026-12-31", endDate: "2027-01-08" }), bookings: [lateFlight], arrivals: [] });
  const ctx = contextFor(data, { now: new Date("2026-12-01T12:00:00Z") });

  it("proposes the stay from the day the flight lands in Orlando, not the UTC day", () => {
    const [stay] = proposeSearch("lodging", ctx);
    expect(stay.query).toMatchObject({ checkInDate: "2026-12-31", checkOutDate: "2027-01-08" });
  });

  it("times the ride and the car on Orlando's clock, rolling into the new year when they should", () => {
    const [ride] = proposeSearch("ride", ctx);
    // Lands 11:40 PM Dec 31; 30 minutes later is 12:10 AM on Jan 1.
    expect(ride.query).toMatchObject({ pickupDate: "2027-01-01", pickupTime: "00:10" });
    const [car] = proposeSearch("car", ctx);
    // 45 minutes after landing is 12:25 AM, so 12:30 AM on Jan 1; the flight home leaves 12:30 AM on Jan 8.
    expect(car.query).toMatchObject({ pickupDate: "2027-01-01", pickupTime: "00:30", returnDate: "2027-01-07", returnTime: "22:00" });
    expect(handoffLinks(car, ctx)[0].url).toBe("https://www.kayak.com/cars/MCO/2027-01-01/2027-01-07?sort=price_a");
  });

  it("stores instants that read back as the same local time", () => {
    const [car] = proposeSearch("car", ctx);
    expect(bookingDetailsFromQuery(car.query).pickupAt).toEqual({ at: "2027-01-01T05:30:00.000Z", tz: "America/New_York" });
  });

  it("dates the flight tracker search and the check-in reminder by the departure airport's day", () => {
    // Leaves Seattle at 3:05 PM on Dec 31 (23:05 UTC).
    expect(flightStatusLinks(lateFlight.details.segments[0])[2].url).toBe("https://www.google.com/search?q=AS1054+flight+status+Dec+31");
    // The flight home leaves Orlando at 12:30 AM on Jan 8 (05:30 UTC): check-in opens 12:30 AM on Jan 7.
    const steps = suggestNextSteps(data, new Date("2026-12-01T12:00:00Z"));
    expect(steps.filter((s) => s.ruleKey.startsWith("flight:check-in")).map((s) => s.dueDate)).toEqual(["2026-12-30", "2027-01-07"]);
  });

  it("works out act-by dates on the calendar, not on the clock", () => {
    const quiet = planData({ plan: makePlan({ startDate: "2027-03-15", endDate: "2027-03-20" }) });
    // Either side of midnight UTC, and either side of the day US clocks change (Mar 14, 2027).
    for (const now of ["2027-01-10T00:30:00Z", "2027-01-10T23:30:00Z", "2027-03-14T06:59:00Z", "2027-03-14T07:01:00Z"]) {
      expect(actByFor("flight", quiet, null, new Date(now))).toMatchObject({ recommended: "2027-01-29", hard: "2027-03-01" });
    }
  });

  it("reads printed dates as printed", () => {
    const parsed = parseConfirmation("Hotel: The Westin Seattle\nCheck-in: Dec 31, 2026\nCheck-out: Jan 1, 2027\nConfirmation number: 4471220");
    expect(parsed.fields).toMatchObject({ checkInDate: "2026-12-31", checkOutDate: "2027-01-01" });
  });
});

describe("the code never asks the machine what zone it is in", () => {
  const roots = ["src/lib/booking", "src/lib/calendar", "src/lib/airlines"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) files.push(path);
    }
  };
  roots.forEach(walk);

  /** The code of a file without its comment lines, so a comment may say what is avoided. */
  const code = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it("uses no Date method that reads local time, and no locale formatting without a zone", () => {
    const forbidden = /\.(getDate|getDay|getMonth|getFullYear|getHours|getMinutes|getSeconds|getTimezoneOffset|setDate|setHours|setMonth|setFullYear|toLocaleDateString|toLocaleTimeString|toLocaleString|toDateString|toTimeString)\(/;
    for (const file of files) {
      const offending = code(file).split("\n").filter((line) => forbidden.test(line));
      expect(offending, file).toEqual([]);
    }
  });

  it("never builds a date for a link or a calendar file through toISOString()", () => {
    const linkAndFileCode = files.filter((file) => /providers|links\.ts|fields\.ts|wording\.ts|calendar|holiday-periods|act-by/.test(file));
    expect(linkAndFileCode.length).toBeGreaterThan(10);
    for (const file of linkAndFileCode) {
      expect(code(file).split("\n").filter((line) => /toISOString\(/.test(line)), file).toEqual([]);
    }
  });

  it("reads no clock: `new Date()` and Date.now() appear nowhere", () => {
    for (const file of files) {
      const offending = code(file).split("\n").filter((line) => /new Date\(\s*\)|Date\.now\(/.test(line));
      expect(offending, file).toEqual([]);
    }
  });
});
