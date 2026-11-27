import { describe, expect, it } from "vitest";
import { ALPHA3_BY_ALPHA2, alpha3Of } from "./countries";
import { fixture } from "./test-support";

describe("the country code table", () => {
  const pairs = Object.entries(ALPHA3_BY_ALPHA2);

  it("holds all 249 ISO 3166-1 countries, each code once", () => {
    expect(pairs).toHaveLength(249);
    expect(new Set(pairs.map(([, alpha3]) => alpha3)).size).toBe(249);
    for (const [alpha2, alpha3] of pairs) {
      expect(alpha2).toMatch(/^[A-Z]{2}$/);
      expect(alpha3).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("uses only two-letter codes the runtime knows as countries", () => {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const unknown = pairs.map(([alpha2]) => alpha2).filter((alpha2) => names.of(alpha2) === alpha2);
    expect(unknown).toEqual([]);
  });

  it("pairs the codes correctly: the names agree with the 218 items of a real advisory feed", () => {
    const index = JSON.parse(fixture("state-advisories.index.derived.json")) as { items: { name: string; iso3FromLink: string | null }[] };
    const alpha2ByAlpha3 = new Map(pairs.map(([alpha2, alpha3]) => [alpha3, alpha2]));
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const simplify = (name: string) =>
      name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u00a0/g, " ").toLowerCase().replace(/^the /, "").replace(/[^a-z ]/g, "").trim();

    const notInTable: string[] = [];
    const differentName: string[] = [];
    let sameName = 0;
    for (const item of index.items) {
      if (!item.iso3FromLink) continue;
      const alpha2 = alpha2ByAlpha3.get(item.iso3FromLink);
      if (!alpha2) notInTable.push(item.iso3FromLink);
      else if (simplify(names.of(alpha2) ?? "") === simplify(item.name)) sameName++;
      else differentName.push(`${alpha2}=${item.iso3FromLink}`);
    }
    // The Department's own codes for Gaza, the West Bank, Kosovo, and Saba and Sint Eustatius.
    expect(notInTable.sort()).toEqual(["XGZ", "XKS", "XQX", "XWB"]);
    expect(sameName).toBe(191);
    // The same countries under another spelling ("Burma" / "Myanmar (Burma)", "Turkey" /
    // "Türkiye", "Saint Lucia" / "St. Lucia", "… and …" / "… & …"). Checked by eye, pinned here.
    expect(differentName.sort()).toEqual([
      "AG=ATG", "BA=BIH", "BL=BLM", "BQ=BES", "CD=COD", "CG=COG", "CV=CPV", "FM=FSM", "HK=HKG", "KG=KGZ", "KN=KNA",
      "LC=LCA", "MF=MAF", "MM=MMR", "MO=MAC", "NR=NRU", "ST=STP", "TC=TCA", "TR=TUR", "TT=TTO", "VC=VCT",
    ]);
  });

  it("looks up in either case and returns undefined for anything else", () => {
    expect(alpha3Of("PT")).toBe("PRT");
    expect(alpha3Of(" gb ")).toBe("GBR");
    expect(alpha3Of("CH")).toBe("CHE");
    expect(alpha3Of("CN")).toBe("CHN");
    expect(alpha3Of("AU")).toBe("AUS");
    expect(alpha3Of("AT")).toBe("AUT");
    expect(alpha3Of("UK")).toBeUndefined();
    expect(alpha3Of("XK")).toBeUndefined();
    expect(alpha3Of("")).toBeUndefined();
  });
});
