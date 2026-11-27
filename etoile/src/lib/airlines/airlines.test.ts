import { describe, expect, it } from "vitest";
import airlineCodesSeed from "airline-codes/airlines.json";
import { airlineIcao, airlineMentions, airlineName, AIRLINE_NAME_OVERRIDES, airlinesNamedIn, flightNumbersByShortName, IATA_TO_ICAO, isKnownAirlineCode } from "./index";

describe("airlineName", () => {
  it("names the airlines travelers book", () => {
    expect(airlineName("AS")).toBe("Alaska Airlines");
    expect(airlineName("DL")).toBe("Delta Air Lines");
    expect(airlineName("B6")).toBe("JetBlue Airways");
    expect(airlineName("WN")).toBe("Southwest Airlines");
  });

  it("knows the new carriers the older datasets get wrong", () => {
    expect(airlineName("XP")).toBe("Avelo Airlines");
    expect(airlineName("MX")).toBe("Breeze Airways");
    expect(airlineName("N0")).toBe("Norse Atlantic Airways");
  });

  it("ignores case and spaces", () => {
    expect(airlineName(" as ")).toBe("Alaska Airlines");
  });

  it("returns null for anything that is not a known two-character code", () => {
    expect(airlineName("ZZ")).toBeNull();
    expect(airlineName("")).toBeNull();
    expect(airlineName("ASA")).toBeNull();
    expect(airlineName("A")).toBeNull();
    expect(airlineName(null)).toBeNull();
    expect(airlineName(undefined)).toBeNull();
    expect(airlineName("A$")).toBeNull();
  });

  it("lets the override map win over the package", () => {
    expect(AIRLINE_NAME_OVERRIDES.OH).toBe("PSA Airlines");
    expect(airlineName("OH")).toBe("PSA Airlines");
    expect(airlineName("LY")).toBe("El Al");
  });
});

describe("airlineIcao and the reviewed table", () => {
  it("gives the ICAO code flight trackers want", () => {
    expect(airlineIcao("AS")).toBe("ASA");
    expect(airlineIcao("UA")).toBe("UAL");
    expect(airlineIcao("ua")).toBe("UAL");
    expect(airlineIcao("B6")).toBe("JBU");
    expect(airlineIcao("XP")).toBe("VXP");
  });

  it("returns null when the table has no row, so callers fall back to the IATA code", () => {
    expect(airlineIcao("ZZ")).toBeNull();
    expect(airlineIcao(null)).toBeNull();
    expect(airlineIcao("toolong")).toBeNull();
  });

  it("holds only well-formed codes, each ICAO code once", () => {
    const rows = Object.entries(IATA_TO_ICAO);
    expect(rows.length).toBeGreaterThanOrEqual(120);
    for (const [iata, row] of rows) {
      expect(iata).toMatch(/^[A-Z0-9]{2}$/);
      expect(row.icao).toMatch(/^[A-Z]{3}$/);
    }
    const icaos = rows.map(([, row]) => row.icao);
    expect(new Set(icaos).size).toBe(icaos.length);
  });

  it("has a name for every carrier in the table", () => {
    for (const iata of Object.keys(IATA_TO_ICAO)) expect(airlineName(iata), iata).toBeTruthy();
  });

  it("agrees with the airline-codes package on every row marked as seeded from it", () => {
    type SeedRow = { iata: string; icao: string; active: string };
    const active = (airlineCodesSeed as SeedRow[]).filter((row) => row.active === "Y");
    for (const [iata, row] of Object.entries(IATA_TO_ICAO)) {
      if (row.source !== "seed") continue;
      const match = active.some((seed) => seed.iata === iata && seed.icao === row.icao);
      expect(match, `${iata} -> ${row.icao}`).toBe(true);
    }
  });

  it("differs from the package on every row marked as corrected by hand", () => {
    type SeedRow = { iata: string; icao: string; active: string };
    const active = (airlineCodesSeed as SeedRow[]).filter((row) => row.active === "Y");
    for (const [iata, row] of Object.entries(IATA_TO_ICAO)) {
      if (row.source !== "hand") continue;
      const match = active.some((seed) => seed.iata === iata && seed.icao === row.icao);
      expect(match, `${iata} is marked "hand" but the seed already agrees`).toBe(false);
    }
  });
});

describe("finding airlines in text", () => {
  it("finds an airline by its full name", () => {
    expect(airlinesNamedIn("Thanks for flying Alaska Airlines")).toEqual(["AS"]);
    expect(airlinesNamedIn("DELTA AIR LINES e-ticket receipt")).toEqual(["DL"]);
  });

  it("lists airlines in the order they first appear", () => {
    expect(airlinesNamedIn("United Airlines flight operated by Lufthansa")).toEqual(["UA", "LH"]);
  });

  it("does not mistake everyday words for airlines", () => {
    expect(airlinesNamedIn("Paid with American Express in the United States")).toEqual([]);
    expect(airlinesNamedIn("2 lb peaches, Swiss cheese, and a condor poster")).toEqual([]);
    expect(airlinesNamedIn("Deltaville marina")).toEqual([]);
    expect(airlinesNamedIn("Delta Hotels by Marriott, Southwest Florida")).toEqual([]);
  });

  it("keeps the longer name where two overlap", () => {
    const mentions = airlineMentions("Delta Air Lines");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ iata: "DL", index: 0, end: 15 });
  });

  it("reads a flight number after a one-word airline name", () => {
    expect(flightNumbersByShortName("Flight 1 of 2: Alaska 1054")).toEqual([{ iata: "AS", number: "1054", index: 15, end: 26 }]);
    expect(flightNumbersByShortName("UNITED 437 to Orlando")[0]).toMatchObject({ iata: "UA", number: "437" });
    expect(flightNumbersByShortName("Delta flight 1423")[0]).toMatchObject({ iata: "DL", number: "1423" });
  });

  it("does not read a year, a time or a price as a flight number", () => {
    expect(flightNumbersByShortName("Anchorage, Alaska 99501")).toEqual([]);
    expect(flightNumbersByShortName("United 12:30 departure")).toEqual([]);
    expect(flightNumbersByShortName("the American way")).toEqual([]);
  });

  it("says whether a code is in the reviewed table", () => {
    expect(isKnownAirlineCode("AS")).toBe(true);
    expect(isKnownAirlineCode("ZZ")).toBe(false);
    expect(isKnownAirlineCode(undefined)).toBe(false);
  });
});
