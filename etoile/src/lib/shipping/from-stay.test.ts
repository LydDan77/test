import { describe, expect, it } from "vitest";
import { LODGING_TYPES, SHIPMENT_DESTINATION_TYPES, lodgingDetailsSchema } from "@/lib/domain";
import { DEFAULT_SERVICE } from "./config";
import { destinationForStay, sendAheadDefaultsFromStay } from "./from-stay";
import { labelBlock } from "./label";
import { shipByPlan } from "./ship-by";

describe("destinationForStay", () => {
  it("maps each kind of stay to where a box would go", () => {
    expect(destinationForStay("hotel")).toBe("hotel");
    expect(destinationForStay("room_block")).toBe("hotel");
    expect(destinationForStay("rental")).toBe("vacation_rental");
    expect(destinationForStay("family_home")).toBe("relative_home");
    expect(destinationForStay("other")).toBeNull();
    expect(destinationForStay(undefined)).toBeNull();
    expect(destinationForStay(null)).toBeNull();
    for (const type of LODGING_TYPES) {
      const destination = destinationForStay(type);
      if (destination) expect(SHIPMENT_DESTINATION_TYPES).toContain(destination);
    }
  });
});

describe("sendAheadDefaultsFromStay", () => {
  const lakeHouse = lodgingDetailsSchema.parse({
    kind: "lodging",
    lodgingType: "rental",
    propertyName: "Lakeside House",
    place: { kind: "lodging", name: "Lakeside House", addressLines: ["12 Lakeside Ln"], locality: "Windermere", region: "FL", postalCode: "34786", countryCode: "US", tz: "America/New_York" },
    checkInDate: "2026-12-19",
    checkOutDate: "2026-12-26",
  });
  const home = { countryCode: "US", postalCode: "55401" };

  it("fills in everything the stay already says", () => {
    expect(sendAheadDefaultsFromStay(lakeHouse, home)).toEqual({
      destination: "vacation_rental",
      arrivalDate: "2026-12-19",
      departureDate: "2026-12-26",
      propertyName: "Lakeside House",
      place: lakeHouse.place,
      destinationPostalCode: "34786",
      originPostalCode: "55401",
      property: null,
      international: false,
    });
  });

  it("feeds straight into the ship-by date and the label", () => {
    const known = sendAheadDefaultsFromStay(lakeHouse, home);
    const plan = shipByPlan({
      destination: known.destination!, arrivalDate: known.arrivalDate!, service: DEFAULT_SERVICE,
      originPostalCode: known.originPostalCode, destinationPostalCode: known.destinationPostalCode,
      property: known.property, international: known.international ?? false,
    });
    expect(plan.headline).toBe("Ship by Fri, Dec 11 so it arrives Mon, Dec 21");
    const label = labelBlock({ destination: known.destination!, recipientName: "Lydia Hartley", arrivalDate: known.arrivalDate, place: known.place });
    expect(label.lines).toEqual(["Lydia Hartley", "12 Lakeside Ln", "Windermere, FL 34786"]);
  });

  it("carries what the property already said about packages", () => {
    const hotel = lodgingDetailsSchema.parse({
      kind: "lodging", lodgingType: "hotel", propertyName: "Grand Floridian", checkInDate: "2026-12-23",
      packagePolicy: { accepts: true, holdDays: 5, feePerBox: { amount: 600, currency: "USD" }, receivingAddress: "Package Room", contact: "Bell desk" },
    });
    const known = sendAheadDefaultsFromStay(hotel, home);
    expect(known.property).toEqual({ accepts: true, confirmed: true, holdDays: 5, feePerBox: { amount: 600, currency: "USD" } });
    expect(known.destination).toBe("hotel");
    expect(known.place).toBeNull();
    expect(known.international).toBeNull(); // no place, so no country to compare
    const plan = shipByPlan({ destination: "hotel", arrivalDate: known.arrivalDate!, service: DEFAULT_SERVICE, property: known.property });
    expect(plan.earliestAcceptableDate).toBe("2026-12-18");
    expect(plan.fee?.text).toBe("The hotel charges $6 a box to receive it.");
    expect(plan.warnings.map((w) => w.code)).not.toContain("ask_property_first");
  });

  it("a property that said no comes through as a no", () => {
    const hotel = lodgingDetailsSchema.parse({ kind: "lodging", lodgingType: "hotel", checkInDate: "2026-12-23", packagePolicy: { accepts: false } });
    expect(sendAheadDefaultsFromStay(hotel).property).toEqual({ accepts: false, confirmed: true });
  });

  it("knows a stay abroad is international, and never guesses what is missing", () => {
    const abroad = lodgingDetailsSchema.parse({
      kind: "lodging", lodgingType: "hotel",
      place: { kind: "lodging", name: "Hotel Xcaret", countryCode: "MX", tz: "America/Cancun" },
    });
    expect(sendAheadDefaultsFromStay(abroad, home)).toMatchObject({
      international: true, propertyName: "Hotel Xcaret", arrivalDate: null, departureDate: null, destinationPostalCode: null,
    });
    expect(sendAheadDefaultsFromStay(abroad).international).toBeNull();
    const bare = lodgingDetailsSchema.parse({ kind: "lodging" });
    expect(sendAheadDefaultsFromStay(bare, null)).toEqual({
      destination: null, arrivalDate: null, departureDate: null, propertyName: null, place: null,
      destinationPostalCode: null, originPostalCode: null, property: null, international: null,
    });
    expect(sendAheadDefaultsFromStay(lodgingDetailsSchema.parse({ kind: "lodging", packagePolicy: {} })).property).toBeNull();
  });
});
