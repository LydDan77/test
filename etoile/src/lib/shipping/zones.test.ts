import { describe, expect, it } from "vitest";
import { estimateZone, isOffshoreZip, parseUsZip } from "./zones";

describe("parseUsZip", () => {
  it("reads a five-digit ZIP, with or without the extra four", () => {
    expect(parseUsZip("98101")).toBe("98101");
    expect(parseUsZip(" 98101 ")).toBe("98101");
    expect(parseUsZip("98101-1234")).toBe("98101");
    expect(parseUsZip("981011234")).toBe("98101");
    expect(parseUsZip("98101 1234")).toBe("98101");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "9810", "981012", "K1A 0B1", "SW1A 1AA", "ninety", "98101-12", null, undefined]) {
      expect(parseUsZip(bad), String(bad)).toBeNull();
    }
  });
});

describe("estimateZone", () => {
  it("places well-known ZIP codes in the right state", () => {
    const area = (zip: string) => estimateZone(zip, zip)?.fromArea;
    const expected: [string, string][] = [
      ["98101", "Washington"], ["97201", "Oregon"], ["94102", "northern California"], ["90210", "southern California"],
      ["89101", "southern Nevada"], ["89501", "northern Nevada"], ["85001", "Arizona"], ["84101", "Utah"], ["83702", "Idaho"],
      ["82001", "Wyoming"], ["80202", "Colorado"], ["87101", "New Mexico"], ["59601", "Montana"], ["58102", "North Dakota"],
      ["57104", "South Dakota"], ["68102", "Nebraska"], ["66101", "Kansas"], ["73102", "Oklahoma"], ["75201", "north Texas"],
      ["77001", "the Houston area"], ["78701", "central and south Texas"], ["73301", "central and south Texas"],
      ["79901", "west Texas"], ["88510", "west Texas"], ["55401", "Minnesota"], ["50309", "Iowa"], ["63101", "Missouri"],
      ["72201", "Arkansas"], ["70112", "Louisiana"], ["53202", "Wisconsin"], ["60601", "Illinois"], ["46204", "Indiana"],
      ["48201", "Michigan"], ["43215", "Ohio"], ["40202", "Kentucky"], ["37201", "Tennessee"], ["38103", "Tennessee"],
      ["39201", "Mississippi"], ["35203", "Alabama"], ["30301", "Georgia"], ["32801", "northern and central Florida"],
      ["33101", "southern Florida"], ["34102", "central and southwest Florida"], ["29401", "South Carolina"],
      ["27601", "North Carolina"], ["23219", "Virginia"], ["25301", "West Virginia"], ["20001", "Washington, DC"],
      ["21201", "Maryland"], ["19901", "Delaware"], ["19103", "eastern Pennsylvania"], ["15222", "western Pennsylvania"],
      ["07102", "New Jersey"], ["10001", "the New York City area"], ["14201", "upstate New York"], ["06103", "Connecticut"],
      ["02903", "Rhode Island"], ["02108", "Massachusetts"], ["03101", "New Hampshire"], ["05401", "Vermont"],
      ["04101", "Maine"], ["99501", "Alaska"], ["96815", "Hawaii"], ["00901", "Puerto Rico"],
    ];
    for (const [zip, name] of expected) expect(area(zip), zip).toBe(name);
  });

  it("gives the carrier zone for some familiar trips", () => {
    // Seattle to Orlando: the product spec's example, coast to coast.
    expect(estimateZone("98101", "32801")).toEqual({
      zone: 8, miles: 2480, offshore: false, fromArea: "Washington", toArea: "northern and central Florida",
    });
    expect(estimateZone("10001", "19103")?.zone).toBe(2); // New York to Philadelphia
    expect(estimateZone("60601", "53202")?.zone).toBe(3); // Chicago to Milwaukee
    expect(estimateZone("90001", "94102")?.zone).toBe(4); // Los Angeles to San Francisco
    expect(estimateZone("55401", "60601")?.zone).toBe(4); // Minneapolis to Chicago
    expect(estimateZone("55401", "32801")?.zone).toBe(6); // Minneapolis to Orlando
    expect(estimateZone("10001", "90210")?.zone).toBe(8); // New York to Los Angeles
    expect(estimateZone("02108", "33101")?.zone).toBe(6); // Boston to Miami
  });

  it("is the same in both directions", () => {
    for (const [a, b] of [["98101", "32801"], ["55401", "60601"], ["10001", "90210"], ["99501", "98101"]]) {
      expect(estimateZone(a, b)?.zone).toBe(estimateZone(b, a)?.zone);
      expect(estimateZone(a, b)?.miles).toBe(estimateZone(b, a)?.miles);
    }
  });

  it("treats the same ZIP area as local and the same state as a day's drive", () => {
    expect(estimateZone("55401", "55402")).toMatchObject({ zone: 2, miles: 30 });
    expect(estimateZone("55401", "55105")).toMatchObject({ zone: 3, miles: 200, fromArea: "Minnesota", toArea: "Minnesota" });
    expect(estimateZone("98101", "99201")).toMatchObject({ zone: 3, miles: 200 }); // Seattle to Spokane
  });

  it("puts Alaska, Hawaii and Puerto Rico in zone 9 from the mainland", () => {
    expect(estimateZone("98101", "99501")).toMatchObject({ zone: 9, offshore: true, toArea: "Alaska" });
    expect(estimateZone("96815", "55401")).toMatchObject({ zone: 9, offshore: true, fromArea: "Hawaii" });
    expect(estimateZone("00901", "33101")).toMatchObject({ zone: 9, offshore: true });
    expect(estimateZone("96815", "99501")).toMatchObject({ zone: 9, offshore: true }); // island to island
    // Within Alaska it is an ordinary distance.
    expect(estimateZone("99501", "99701")).toMatchObject({ zone: 3, offshore: false });
  });

  it("returns null when it cannot tell", () => {
    expect(estimateZone("98101", null)).toBeNull();
    expect(estimateZone(undefined, "32801")).toBeNull();
    expect(estimateZone("K1A 0B1", "32801")).toBeNull(); // a Canadian postcode
    expect(estimateZone("98101", "SW1A 1AA")).toBeNull();
    expect(estimateZone("09001", "32801")).toBeNull(); // military mail has no place on the map
    expect(estimateZone("", "")).toBeNull();
  });

  it("knows an offshore ZIP on its own", () => {
    expect(isOffshoreZip("99501")).toBe(true);
    expect(isOffshoreZip("96815-1234")).toBe(true);
    expect(isOffshoreZip("00901")).toBe(true);
    expect(isOffshoreZip("96910")).toBe(true); // Guam
    expect(isOffshoreZip("98101")).toBe(false);
    expect(isOffshoreZip("K1A 0B1")).toBe(false);
    expect(isOffshoreZip(null)).toBe(false);
  });
});
