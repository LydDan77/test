import { describe, expect, it } from "vitest";
import data from "@/data/airports.json";
import { placeRefSchema } from "@/lib/domain";
import { isIanaTimeZone } from "@/lib/time";
import {
  airportByIata,
  airportPlace,
  airportsSource,
  distanceKm,
  hasScheduledService,
  nearestAirports,
  searchAirports,
} from "./airports";

const codes = (query: string, limit?: number) => searchAirports(query, limit).map((airport) => airport.iata);

describe("the airport table", () => {
  it("holds every airport with a code, each with a country, coordinates and a zone the app can store", () => {
    expect(data.fields).toEqual(["iata", "name", "city", "country", "lat", "lon", "timeZone", "rank", "metro"]);
    expect(data.rows.length).toBeGreaterThan(10_000);
    const zones = new Set<string>();
    const seen = new Set<string>();
    for (const row of data.rows as [string, string, string, string, number, number, string, number, string][]) {
      const [iata, name, , country, lat, lon, timeZone, rank] = row;
      expect(iata).toMatch(/^[A-Z0-9]{3}$/);
      expect(seen.has(iata), `${iata} appears twice`).toBe(false);
      seen.add(iata);
      expect(name.length).toBeGreaterThan(0);
      expect(country, iata).toMatch(/^[A-Z]{2}$/);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThanOrEqual(7);
      zones.add(timeZone);
    }
    for (const zone of zones) expect(isIanaTimeZone(zone), zone).toBe(true);
  });

  it("credits its source", () => {
    expect(airportsSource).toContain("airport-data-js");
    expect(airportsSource).toContain("CC BY 4.0");
  });
});

describe("airportByIata", () => {
  it("finds an airport by code, whatever the capitals or spaces", () => {
    expect(airportByIata("MCO")).toMatchObject({ iata: "MCO", name: "Orlando International Airport", city: "Orlando", country: "US", timeZone: "America/New_York" });
    expect(airportByIata(" msp ")?.name).toBe("Minneapolis-St. Paul International Airport");
    expect(airportByIata("lhr")?.timeZone).toBe("Europe/London");
  });

  it("answers undefined for a code nobody uses, and for junk", () => {
    expect(airportByIata("XQX")).toBeUndefined();
    expect(airportByIata("")).toBeUndefined();
    expect(airportByIata("ORLANDO")).toBeUndefined();
  });

  it("has the zones the generator corrected from the coordinates", () => {
    // The source package puts Pasco, Washington in New York's zone and Chihuahua in Mazatlán's.
    expect(airportByIata("PSC")?.timeZone).toBe("America/Los_Angeles");
    expect(airportByIata("CUU")?.timeZone).toBe("America/Chihuahua");
  });
});

describe("searchAirports", () => {
  it("puts an exact code first", () => {
    expect(codes("MCO")[0]).toBe("MCO");
    expect(codes("sea")[0]).toBe("SEA");
  });

  it("finds a city's airports, the big ones first, and a metro area's through its shared code", () => {
    expect(codes("orlando").slice(0, 2).sort()).toEqual(["MCO", "SFB"]);
    const newYork = codes("new york");
    for (const code of ["JFK", "LGA", "EWR"]) expect(newYork).toContain(code);
    expect(codes("LON")).toContain("LHR");
  });

  it("finds by part of a name, without caring about accents or capitals", () => {
    expect(codes("heathrow")).toContain("LHR");
    expect(codes("ZURICH")[0]).toBe("ZRH");
    expect(codes("zürich")[0]).toBe("ZRH");
    expect(codes("sao paulo")).toContain("GRU");
  });

  it("honours the limit, and answers nothing for under two characters or no match", () => {
    expect(searchAirports("san", 5)).toHaveLength(5);
    expect(searchAirports("san")).toHaveLength(8);
    expect(searchAirports("s")).toEqual([]);
    expect(searchAirports("   ")).toEqual([]);
    expect(searchAirports("zzzzqqqxj")).toEqual([]);
    expect(searchAirports("orlando", 0)).toEqual([]);
  });
});

describe("nearestAirports", () => {
  const orlando = { lat: 28.53834, lon: -81.37924 };

  it("gives the closest airports a person can buy a ticket to, nearest first", () => {
    const near = nearestAirports(orlando.lat, orlando.lon, 3);
    expect(near.map((airport) => airport.iata).slice(0, 2)).toEqual(["MCO", "SFB"]);
    expect(near).toHaveLength(3);
    expect(near.every(hasScheduledService)).toBe(true);
    expect(near[0].distanceKm).toBeGreaterThan(5);
    expect(near[0].distanceKm).toBeLessThan(20);
    expect(near.map((airport) => airport.distanceKm)).toEqual([...near.map((airport) => airport.distanceKm)].sort((a, b) => a - b));
  });

  it("counts airstrips too when asked for every airport", () => {
    // Orlando Executive is closer to downtown than MCO but has no scheduled flights.
    expect(nearestAirports(orlando.lat, orlando.lon, 1, { service: "all" })[0].iata).toBe("ORL");
    expect(nearestAirports(orlando.lat, orlando.lon, 1)[0].iata).toBe("MCO");
  });

  it("can be kept to a radius, and answers nothing for nonsense", () => {
    expect(nearestAirports(orlando.lat, orlando.lon, 10, { withinKm: 20 }).map((airport) => airport.iata)).toEqual(["MCO"]);
    // The middle of the South Pacific.
    expect(nearestAirports(-48.9, -123.4, 3, { withinKm: 500 })).toEqual([]);
    expect(nearestAirports(Number.NaN, 0, 3)).toEqual([]);
    expect(nearestAirports(0, 0, 0)).toEqual([]);
  });

  it("measures great-circle distance", () => {
    const msp = airportByIata("MSP")!;
    const mco = airportByIata("MCO")!;
    // 1,310 statute miles, give or take.
    expect(distanceKm(msp.lat, msp.lon, mco.lat, mco.lon)).toBeGreaterThan(2_080);
    expect(distanceKm(msp.lat, msp.lon, mco.lat, mco.lon)).toBeLessThan(2_130);
    expect(distanceKm(10, 20, 10, 20)).toBe(0);
  });
});

describe("airportPlace", () => {
  it("turns an airport into a place the database accepts", () => {
    const place = airportPlace(airportByIata("MCO")!);
    expect(place).toEqual({
      kind: "airport",
      name: "Orlando International Airport",
      locality: "Orlando",
      countryCode: "US",
      lat: 28.4322,
      lon: -81.3083,
      tz: "America/New_York",
      iata: "MCO",
    });
    expect(placeRefSchema.safeParse(place).success).toBe(true);
    // An airport with no city in the source simply has no locality.
    const noCity = airportPlace({ ...airportByIata("MCO")!, city: "" });
    expect("locality" in noCity).toBe(false);
    expect(placeRefSchema.safeParse(noCity).success).toBe(true);
  });
});
