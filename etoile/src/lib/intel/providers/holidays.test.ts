import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDb, type TestDb } from "@/db/testing";
import { HTTP_DEFAULTS } from "../http";
import type { LongWeekend } from "../signals";
import { getPublicHolidays, getPublicHolidaysBetween, holidaysBaseUrl } from "./holidays";
import { computeLongWeekends, observedDate } from "./long-weekends";
import { empty, fixture, html, json, stubFetch } from "./test-support";

// Fixtures, all real: nager-v4-holidays-us-2026.json and -pt-2027.json (captured 2026-11-26),
// nager-v4-holidays-us-2027.json (captured 2026-11-27), the two error bodies, and the old
// version-3 long-weekend answers for the US in 2026 and 2027, which the computed long weekends
// are checked against. An unsupported country really answers 204 with no body.

let t: TestDb;
const original = { ...HTTP_DEFAULTS };
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.delete(schema.signalCache);
  HTTP_DEFAULTS.retryDelayMs = 0;
});
afterEach(() => {
  Object.assign(HTTP_DEFAULTS, original);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const NOW = new Date("2026-11-27T12:00:00Z");
const DAY = 86_400_000;

/** Serves the real captures by country and year; anything else is the real "no data" answer. */
function nager() {
  return stubFetch((url) => {
    const match = /\/api\/v4\/Holidays\/([A-Z]{2})\/(\d{4})$/.exec(url.pathname);
    const name = match ? `nager-v4-holidays-${match[1].toLowerCase()}-${match[2]}.json` : "";
    if (["nager-v4-holidays-us-2026.json", "nager-v4-holidays-us-2027.json", "nager-v4-holidays-pt-2027.json"].includes(name)) return json(fixture(name), 200, "application/json; charset=utf-8");
    return empty(204);
  });
}

/** The old API's long-weekend rows in this app's shape. */
function fromVersion3(name: string): Pick<LongWeekend, "startDate" | "endDate" | "days" | "bridgeDays">[] {
  const rows = JSON.parse(fixture(name)) as { startDate: string; endDate: string; dayCount: number; bridgeDays: string[] }[];
  return rows.map((row) => ({ startDate: row.startDate, endDate: row.endDate, days: row.dayCount, bridgeDays: row.bridgeDays }));
}
const comparable = (runs: LongWeekend[]) => runs.map(({ startDate, endDate, days, bridgeDays }) => ({ startDate, endDate, days, bridgeDays }));

describe("getPublicHolidays", () => {
  it("returns the days the whole country has off, once each, from the real US list", async () => {
    const stub = nager();
    const result = await getPublicHolidays("US", 2026, { now: NOW });
    expect(result).toMatchObject({ ok: true, stale: false, fetchedAt: NOW, data: { coverage: "covered", countryCode: "US" } });
    expect(stub.calls.map((call) => call.url.href)).toEqual(["https://date.nager.at/api/v4/Holidays/US/2026"]);
    if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");

    // Seventeen rows in the feed; ten are public holidays everywhere. Columbus Day (a bank
    // holiday nationally, public only in some states), Lincoln's Birthday (an observance),
    // Good Friday and Truman Day (some states) are not.
    expect(result.data.holidays.map((holiday) => `${holiday.date} ${holiday.name}`)).toEqual([
      "2026-01-01 New Year's Day",
      "2026-01-19 Martin Luther King, Jr. Day",
      "2026-02-16 Presidents Day",
      "2026-05-25 Memorial Day",
      "2026-06-19 Juneteenth National Independence Day",
      "2026-07-04 Independence Day",
      "2026-09-07 Labour Day",
      "2026-11-11 Veterans Day",
      "2026-11-26 Thanksgiving Day",
      "2026-12-25 Christmas Day",
    ]);
    expect(result.data.holidays[5]).toEqual({
      date: "2026-07-04", // a Saturday
      observedOn: "2026-07-03", // so the day off is the Friday
      name: "Independence Day",
      nationwide: true,
      regions: [],
      kinds: ["public", "bank"],
    });
  });

  it("computes the same long weekends the old API reported, for 2026 and 2027", async () => {
    nager();
    for (const year of [2026, 2027]) {
      const result = await getPublicHolidays("US", year, { now: NOW });
      if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");
      expect(comparable(result.data.longWeekends), String(year)).toEqual(fromVersion3(`nager-v3-longweekend-us-${year}.json`));
    }
    const result = await getPublicHolidays("US", 2026, { now: NOW });
    if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");
    expect(result.data.longWeekends.find((run) => run.startDate === "2026-11-26")).toEqual({
      startDate: "2026-11-26",
      endDate: "2026-11-29",
      days: 4,
      bridgeDays: ["2026-11-27"],
      holidays: ["Thanksgiving Day"],
    });
  });

  it("adds a region's own public holidays when the region is given", async () => {
    nager();
    const names = async (region?: string) => {
      const result = await getPublicHolidays("US", 2026, { region, now: NOW });
      if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");
      return result.data.holidays.map((holiday) => holiday.name);
    };
    const national = await names();
    // Connecticut observes Good Friday and Columbus Day as public holidays.
    for (const spelling of ["CT", "US-CT", "us-ct", " ct "]) {
      const connecticut = await names(spelling);
      expect(connecticut, spelling).toHaveLength(12);
      expect(connecticut.filter((name) => name === "Good Friday")).toHaveLength(1);
      expect(connecticut.filter((name) => name === "Columbus Day")).toHaveLength(1);
    }
    // In Texas Good Friday is only "optional", so it is not a day off; Indigenous Peoples' Day is.
    const texas = await names("TX");
    expect(texas).not.toContain("Good Friday");
    expect(texas.filter((name) => !national.includes(name))).toEqual(["Indigenous Peoples' Day"]);
    // Florida has nothing of its own in the list.
    expect(await names("FL")).toEqual(national);
    // A region name is not a code: national holidays only.
    expect(await names("Connecticut")).toEqual(national);
    expect(await names("")).toEqual(national);
  });

  it("marks a regional holiday as regional", async () => {
    nager();
    const result = await getPublicHolidays("PT", 2027, { region: "PT-30", now: NOW });
    if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");
    expect(result.data.holidays.find((holiday) => holiday.name === "Madeira Day")).toEqual({
      date: "2027-07-01", observedOn: "2027-07-01", name: "Madeira Day", nationwide: false, regions: ["PT-30"], kinds: ["public"],
    });
    expect(result.data.holidays.map((holiday) => holiday.name)).toContain("St. Stephen's Day");
    expect(result.data.holidays.map((holiday) => holiday.name)).not.toContain("Azores Day");
  });

  it("does not move weekend holidays outside the United States, or count optional days", async () => {
    nager();
    const result = await getPublicHolidays("pt", 2027, { now: NOW });
    if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");
    const { holidays, longWeekends } = result.data;
    expect(result.data.countryCode).toBe("PT");
    expect(holidays.map((holiday) => holiday.name)).not.toContain("Carnival"); // "Optional"
    expect(holidays).toHaveLength(13);
    expect(holidays.every((holiday) => holiday.observedOn === holiday.date)).toBe(true);
    // Labour Day 2027 is a Saturday in Portugal: no extra day off, no long weekend.
    expect(longWeekends.some((run) => run.holidays.includes("Labour Day"))).toBe(false);
    expect(longWeekends.map((run) => `${run.startDate} ${run.endDate} ${run.bridgeDays.join(",")}`)).toEqual([
      "2027-01-01 2027-01-03 ", // New Year's Day, a Friday
      "2027-03-26 2027-03-28 ", // Good Friday and Easter Sunday
      "2027-05-27 2027-05-30 2027-05-28", // Corpus Christi, a Thursday: take the Friday
      "2027-06-10 2027-06-13 2027-06-11", // National Day, a Thursday
      "2027-10-02 2027-10-05 2027-10-04", // Republic Day, a Tuesday: take the Monday
      "2027-10-30 2027-11-01 ", // All Saints, a Monday
    ]);
    expect(longWeekends[1].holidays).toEqual(["Good Friday", "Easter Sunday"]);
  });

  it("says 'unknown', never 'none', for a country the service has no data for (204, no body)", async () => {
    const stub = nager();
    const result = await getPublicHolidays("IN", 2027, { now: NOW });
    expect(result).toEqual({ ok: true, stale: false, fetchedAt: NOW, data: { coverage: "unknown", countryCode: "IN" } });
    // The answer is stored like any other: India is not asked about again this week.
    await getPublicHolidays("IN", 2027, { now: new Date(NOW.getTime() + DAY) });
    expect(stub.calls).toHaveLength(1);
  });

  it("says 'unknown' for a code the service does not recognise (the real 404)", async () => {
    stubFetch(() => json(fixture("nager-error-unknown-country.json"), 404, "application/problem+json"));
    expect(await getPublicHolidays("XX", 2026, { now: NOW })).toMatchObject({ ok: true, data: { coverage: "unknown", countryCode: "XX" } });
  });

  it("keeps a year for a week, then asks again", async () => {
    const stub = nager();
    await getPublicHolidays("US", 2026, { now: NOW });
    await getPublicHolidays("US", 2026, { region: "CT", now: new Date(NOW.getTime() + 6 * DAY) });
    expect(stub.calls).toHaveLength(1);
    await getPublicHolidays("US", 2026, { now: new Date(NOW.getTime() + 8 * DAY) });
    expect(stub.calls).toHaveLength(2);
  });

  describe("when the service cannot be read", () => {
    it.each([
      ["an HTML page with status 200", () => html("<!DOCTYPE html><html><body>Moved</body></html>")],
      ["a 404 that is not about the country (a wrong address)", () => html("<html><body>Not Found</body></html>", 404)],
      ["the real 'unsupported year' refusal", () => json(fixture("nager-error-unsupported-year.json"), 400, "application/problem+json")],
      ["broken JSON", () => json(`[{"date":"2026-01-01",`)],
      ["rows with an impossible date", () => json([{ date: "2026-02-30", name: "Nope", nationalHoliday: true, subdivisionCodes: null, holidayTypes: ["Public"] }])],
      ["an object where the list should be", () => json({ holidays: [] })],
      ["a server error, twice", () => html("<html>502</html>", 502)],
    ])("fails on %s, and stores nothing", async (_label, respond) => {
      stubFetch(respond);
      expect(await getPublicHolidays("US", 2026, { now: NOW })).toMatchObject({ ok: false, reason: "unavailable", lastGoodAt: null });
      const rows = await t.db.select().from(schema.signalCache);
      expect(rows.every((row) => row.payload === null)).toBe(true);
    });

    it("fails on a timeout", async () => {
      HTTP_DEFAULTS.timeoutMs = 40;
      stubFetch(() => "hang");
      expect(await getPublicHolidays("US", 2026, { now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("goes on using the last good list however old it is, marked stale: the dates do not change", async () => {
      let healthy = true;
      stubFetch((url) => (healthy ? json(fixture("nager-v4-holidays-us-2026.json")) : html(`<html>${url.host} is down</html>`, 503)));
      await getPublicHolidays("US", 2026, { now: NOW });
      healthy = false;
      const result = await getPublicHolidays("US", 2026, { now: new Date(NOW.getTime() + 90 * DAY) });
      expect(result).toMatchObject({ ok: true, stale: true, fetchedAt: NOW, data: { coverage: "covered" } });
      expect(result.ok && result.data.coverage === "covered" && result.data.holidays).toHaveLength(10);
    });
  });

  it("takes its address from configuration", async () => {
    expect(holidaysBaseUrl()).toBe("https://date.nager.at");
    vi.stubEnv("HOLIDAYS_API_BASE_URL", "https://nagerholidays.com/");
    expect(holidaysBaseUrl()).toBe("https://nagerholidays.com");
    const stub = nager();
    await getPublicHolidays("US", 2026, { now: NOW });
    expect(stub.calls[0].url.href).toBe("https://nagerholidays.com/api/v4/Holidays/US/2026");

    for (const unusable of ["not a url", "ftp://example.org", "javascript:alert(1)", "   "]) {
      vi.stubEnv("HOLIDAYS_API_BASE_URL", unusable);
      expect(holidaysBaseUrl(), unusable).toBe("https://date.nager.at");
    }
  });

  it("refuses a country that is not two letters and a year that is not a year, without a request", async () => {
    const stub = nager();
    for (const [country, year] of [["USA", 2026], ["", 2026], ["U1", 2026], ["US", 1800], ["US", 2026.5], ["US", Number.NaN], ["US", 3026]] as const) {
      expect(await getPublicHolidays(country, year, { now: NOW }), `${country} ${year}`).toMatchObject({ ok: false, reason: "invalid_input" });
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe("getPublicHolidaysBetween", () => {
  it("finds the holidays of a Christmas-to-New-Year stay across two years", async () => {
    const stub = nager();
    const result = await getPublicHolidaysBetween("US", "2026-12-19", "2027-01-02", { now: NOW });
    expect(stub.calls.map((call) => call.url.pathname)).toEqual(["/api/v4/Holidays/US/2026", "/api/v4/Holidays/US/2027"]);
    if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");
    expect(result.data.holidays.map((holiday) => `${holiday.date} ${holiday.name}`)).toEqual(["2026-12-25 Christmas Day", "2027-01-01 New Year's Day"]);
    expect(result.data.longWeekends.map((run) => `${run.startDate} ${run.endDate}`)).toEqual(["2026-12-25 2026-12-27", "2027-01-01 2027-01-03"]);
  });

  it("asks for one year when the dates sit inside it, and reports nothing for a quiet week", async () => {
    const stub = nager();
    const result = await getPublicHolidaysBetween("US", "2026-08-03", "2026-08-09", { now: NOW });
    expect(stub.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, data: { coverage: "covered", holidays: [], longWeekends: [] } });
  });

  it("includes a holiday observed inside the dates, and a long weekend the dates only touch", async () => {
    nager();
    // Friday July 3, 2026 only: the day Independence Day (Saturday the 4th) is observed.
    const result = await getPublicHolidaysBetween("US", "2026-07-03", "2026-07-03", { now: NOW });
    if (!result.ok || result.data.coverage !== "covered") throw new Error("expected holidays");
    expect(result.data.holidays.map((holiday) => holiday.name)).toEqual(["Independence Day"]);
    expect(result.data.longWeekends).toMatchObject([{ startDate: "2026-07-03", endDate: "2026-07-05", days: 3, bridgeDays: [] }]);
  });

  it("is 'unknown' when the country has no data, and a failure when a year cannot be read", async () => {
    nager();
    expect(await getPublicHolidaysBetween("TH", "2026-12-19", "2027-01-02", { now: NOW })).toMatchObject({ ok: true, data: { coverage: "unknown", countryCode: "TH" } });

    await t.db.delete(schema.signalCache);
    stubFetch((url) => (url.pathname.endsWith("/2026") ? json(fixture("nager-v4-holidays-us-2026.json")) : html("<html>503</html>", 503)));
    expect(await getPublicHolidaysBetween("US", "2026-12-19", "2027-01-02", { now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("refuses dates that are not a range, and absurdly long ones", async () => {
    const stub = nager();
    expect(await getPublicHolidaysBetween("US", "2027-01-02", "2026-12-19", { now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await getPublicHolidaysBetween("US", "2026-12-32", "2027-01-02", { now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await getPublicHolidaysBetween("US", "2026-01-01", "2031-01-01", { now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await getPublicHolidaysBetween("United States", "2026-12-19", "2027-01-02", { now: NOW })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("computeLongWeekends", () => {
  const holiday = (observedOn: string, name = "Holiday") => ({ observedOn, name });

  it("makes a three-day weekend from a Friday or a Monday", () => {
    expect(computeLongWeekends([holiday("2026-12-25", "Christmas Day")])).toEqual([
      { startDate: "2026-12-25", endDate: "2026-12-27", days: 3, bridgeDays: [], holidays: ["Christmas Day"] },
    ]);
    expect(computeLongWeekends([holiday("2026-09-07")])).toMatchObject([{ startDate: "2026-09-05", endDate: "2026-09-07", days: 3 }]);
  });

  it("offers one bridge day for a Thursday or a Tuesday, and nothing for a Wednesday", () => {
    expect(computeLongWeekends([holiday("2026-11-26")])).toMatchObject([{ startDate: "2026-11-26", endDate: "2026-11-29", days: 4, bridgeDays: ["2026-11-27"] }]);
    expect(computeLongWeekends([holiday("2027-10-05")])).toMatchObject([{ startDate: "2027-10-02", endDate: "2027-10-05", days: 4, bridgeDays: ["2027-10-04"] }]);
    expect(computeLongWeekends([holiday("2026-11-11")])).toEqual([]);
  });

  it("joins neighbouring holidays into one run and names them all", () => {
    // Thursday and Friday off: four days with no bridge.
    expect(computeLongWeekends([holiday("2026-12-24", "Christmas Eve"), holiday("2026-12-25", "Christmas Day")])).toEqual([
      { startDate: "2026-12-24", endDate: "2026-12-27", days: 4, bridgeDays: [], holidays: ["Christmas Eve", "Christmas Day"] },
    ]);
    // Three holidays midweek are a long break without any weekend.
    expect(computeLongWeekends([holiday("2027-05-04"), holiday("2027-05-05"), holiday("2027-05-06")])).toMatchObject([{ startDate: "2027-05-04", endDate: "2027-05-06", days: 3 }]);
  });

  it("gives nothing for a holiday that falls on the weekend, or for no holidays", () => {
    expect(computeLongWeekends([holiday("2027-05-01")])).toEqual([]); // a Saturday
    expect(computeLongWeekends([holiday("2027-03-28")])).toEqual([]); // a Sunday
    expect(computeLongWeekends([])).toEqual([]);
  });

  it("returns runs oldest first and lists each once", () => {
    const runs = computeLongWeekends([holiday("2026-12-25", "B"), holiday("2026-01-19", "A"), holiday("2026-12-25", "B"), holiday("2026-12-25", "C")]);
    expect(runs.map((run) => `${run.startDate} ${run.holidays.join("+")}`)).toEqual(["2026-01-17 A", "2026-12-25 B+C"]);
  });

  it("crosses a year boundary", () => {
    // Friday January 1, 2027.
    expect(computeLongWeekends([holiday("2027-01-01")])).toMatchObject([{ startDate: "2027-01-01", endDate: "2027-01-03" }]);
    // Monday January 1, 2029: the weekend before is in 2028.
    expect(computeLongWeekends([holiday("2029-01-01")])).toMatchObject([{ startDate: "2028-12-30", endDate: "2029-01-01", days: 3 }]);
  });
});

describe("observedDate", () => {
  it("moves a US weekend holiday to the nearest weekday, and leaves weekdays alone", () => {
    expect(observedDate("2026-07-04", "US")).toBe("2026-07-03"); // Saturday to Friday
    expect(observedDate("2027-07-04", "us")).toBe("2027-07-05"); // Sunday to Monday
    expect(observedDate("2026-12-25", "US")).toBe("2026-12-25");
    expect(observedDate("2028-01-01", "US")).toBe("2027-12-31"); // across the year
  });

  it("does not guess for other countries", () => {
    expect(observedDate("2027-05-01", "PT")).toBe("2027-05-01");
    expect(observedDate("2026-12-26", "GB")).toBe("2026-12-26");
  });
});
