import { describe, expect, it } from "vitest";
import { LINK_GRADES, SHIPMENT_KINDS, SHIPMENT_PROVIDERS } from "@/lib/domain";
import { EN_DASH } from "@/lib/time";
import { SERVICES } from "./config";
import { copyProblems, isSentence } from "./copy-check";
import { labelBlock } from "./label";
import { copyTripDetails, recommendProviders, type ProviderSituation } from "./providers";

const names = (situation: ProviderSituation) => recommendProviders(situation).providers.map((p) => p.name);

describe("recommendProviders: the report's order", () => {
  it("a bag within the US: LugLess, ShipGo, then the premium two", () => {
    expect(names({ shipmentKind: "luggage", international: false })).toEqual(["LugLess", "ShipGo", "Luggage Forward", "Luggage Free"]);
    expect(names({ shipmentKind: "gear", international: false })).toEqual(["LugLess", "ShipGo", "Luggage Forward", "Luggage Free"]);
  });

  it("to a cruise ship: Luggage Forward, then Luggage Free, never LugLess", () => {
    for (const international of [false, true]) {
      const result = recommendProviders({ shipmentKind: "luggage", international, toCruiseShip: true });
      expect(result.providers.map((p) => p.name)).toEqual(["Luggage Forward", "Luggage Free"]);
      expect(result.note).toBe("Never send anything to the cruise terminal itself. LugLess does not deliver to ships.");
    }
    // A cruise wins over everything else, even for a box.
    expect(names({ shipmentKind: "box", international: true, toCruiseShip: true })).toEqual(["Luggage Forward", "Luggage Free"]);
  });

  it("abroad: Send My Bag, Luggage Forward, ShipGo, Luggage Free, and never LugLess", () => {
    const result = recommendProviders({ shipmentKind: "luggage", international: true });
    expect(result.providers.map((p) => p.name)).toEqual(["Send My Bag", "Luggage Forward", "ShipGo", "Luggage Free"]);
    expect(result.note).toBe("LugLess only ships within the US and within Canada.");
  });

  it("a box abroad adds the carriers after the luggage services", () => {
    expect(names({ shipmentKind: "gift", international: true })).toEqual([
      "Send My Bag", "Luggage Forward", "ShipGo", "Luggage Free", "UPS", "FedEx", "DHL", "USPS",
    ]);
  });

  it("a box within the US: UPS, FedEx, USPS, then the luggage services' box products", () => {
    for (const shipmentKind of ["box", "gift"] as const) {
      expect(names({ shipmentKind, international: false })).toEqual(["UPS", "FedEx", "USPS", "LugLess", "ShipGo"]);
    }
    expect(recommendProviders({ shipmentKind: "box", international: false }).note).toBeNull();
  });

  it("mail goes to USPS first", () => {
    expect(names({ shipmentKind: "mail", international: false })).toEqual(["USPS", "UPS", "FedEx", "LugLess", "ShipGo"]);
  });

  it("an order from a store has nobody to choose: the store ships it", () => {
    expect(recommendProviders({ shipmentKind: "retail_order", international: false })).toEqual({
      providers: [],
      note: "The store ships this one. Have it sent to arrive inside the days the place will hold it, or to a pickup point nearby.",
    });
  });
});

describe("recommendProviders: each option", () => {
  it("has one plain line, a link to open and what the button says", () => {
    const [lugless, shipgo, forward, free] = recommendProviders({ shipmentKind: "luggage", international: false }).providers;
    expect(lugless).toEqual({
      provider: "lugless",
      name: "LugLess",
      line: "Usually the cheapest for a bag within the US, from about $25. You drop it at a UPS or FedEx counter, or pay for pickup.",
      url: "https://www.lugless.com/",
      linkLabel: "Get a quote on LugLess",
      grade: "observed",
      services: ["lugless_ground", "lugless_express"],
    });
    expect(shipgo.line).toBe("From about $35 a bag. Drop-off is free, or pickup at your door is $4.99.");
    expect(shipgo.services).toEqual([]); // ShipGo publishes no transit days
    expect(forward.line).toBe("Door to door, with a packing kit sent to you first. From about $99 a bag.");
    expect(free.line).toBe("Door-to-door courier priced by the pound. Ask for a quote first: it publishes no prices.");
  });

  it("uses the report's start pages for each situation", () => {
    const url = (situation: ProviderSituation, provider: string) =>
      recommendProviders(situation).providers.find((p) => p.provider === provider)?.url;
    expect(url({ shipmentKind: "luggage", international: false, toCruiseShip: true }, "luggage_forward")).toBe("https://www.luggageforward.com/cruise-luggage-shipping/");
    expect(url({ shipmentKind: "luggage", international: true }, "luggage_forward")).toBe("https://www.luggageforward.com/ship-luggage-internationally/");
    expect(url({ shipmentKind: "luggage", international: true }, "send_my_bag")).toBe("https://www.sendmybag.com/quote/");
    expect(url({ shipmentKind: "luggage", international: true }, "shipgo")).toBe("https://www.shipgo.com/ship-luggage-internationally");
    expect(url({ shipmentKind: "box", international: false }, "lugless")).toBe("https://www.lugless.com/ship-boxes/");
    expect(url({ shipmentKind: "box", international: false }, "shipgo")).toBe("https://www.shipgo.com/ship-boxes");
    expect(url({ shipmentKind: "box", international: false }, "ups")).toBe("https://www.ups.com/ctc");
    expect(url({ shipmentKind: "box", international: false }, "usps")).toBe("https://postcalc.usps.com/");
  });

  it("gives the cruise and international timings the report gives", () => {
    const cruise = recommendProviders({ shipmentKind: "luggage", international: false, toCruiseShip: true }).providers[0];
    expect(cruise.line).toBe(`Delivers to your cabin on the ship, from about $139 a bag. Hand your bags over 7${EN_DASH}10 days before you sail.`);
    const cruiseAbroad = recommendProviders({ shipmentKind: "luggage", international: true, toCruiseShip: true }).providers[0];
    expect(cruiseAbroad.line).toBe(`Delivers to your cabin on the ship. Hand your bags over 10${EN_DASH}14 days before you sail.`);
    expect(cruiseAbroad.services).toEqual(["luggage_forward_intl_standard", "luggage_forward_intl_express"]);
    const sendMyBag = recommendProviders({ shipmentKind: "luggage", international: true }).providers[0];
    expect(sendMyBag.line).toBe("Door to door abroad, priced per bag. It takes no liquids, aerosols or medicine, and its dates are estimates: add 3 working days.");
    expect(sendMyBag.services).toEqual([]);
  });

  it("is well formed in every situation", () => {
    for (const shipmentKind of SHIPMENT_KINDS) {
      for (const international of [false, true]) {
        for (const toCruiseShip of [false, true]) {
          const result = recommendProviders({ shipmentKind, international, toCruiseShip });
          const seen = new Set<string>();
          for (const option of result.providers) {
            expect(SHIPMENT_PROVIDERS).toContain(option.provider);
            expect(seen.has(option.provider), `${option.provider} listed twice`).toBe(false);
            seen.add(option.provider);
            expect(LINK_GRADES).toContain(option.grade);
            const url = new URL(option.url);
            expect(url.protocol).toBe("https:");
            expect(url.search).toBe(""); // nothing is prefilled
            expect(copyProblems(option.line), option.line).toEqual([]);
            expect(isSentence(option.line), option.line).toBe(true);
            expect(copyProblems(option.linkLabel)).toEqual([]);
            // The button says where it goes.
            expect(option.linkLabel).toContain(option.name);
            for (const service of option.services) {
              expect(SERVICES[service].provider).toBe(option.provider);
              expect(SERVICES[service].international).toBe(international);
            }
          }
          if (result.note) {
            expect(copyProblems(result.note), result.note).toEqual([]);
            expect(isSentence(result.note)).toBe(true);
          }
          if (shipmentKind !== "retail_order") expect(result.providers.length).toBeGreaterThan(0);
          if (international || toCruiseShip) expect(seen.has("lugless")).toBe(false);
        }
      }
    }
  });
});

describe("copyTripDetails", () => {
  const label = labelBlock({
    destination: "hotel", recipientName: "Lydia Hartley", arrivalDate: "2026-12-23", propertyName: "Grand Floridian",
    reservationNumber: "84412907", phone: "612-555-0100", parcelNumber: 1, parcelCount: 2,
    place: { addressLines: ["4401 Floridian Way"], locality: "Orlando", region: "FL", postalCode: "32830" },
  });

  it("writes everything a quote form asks for, in one block", () => {
    const details = copyTripDetails({
      originAddress: "214 Elm St, Minneapolis, MN 55401",
      labelLines: label.lines,
      sendDate: "2026-12-10",
      targetDeliveryDate: "2026-12-21",
      parcels: [
        { weight: { value: 42, unit: "lb" }, dimensions: { length: 28, width: 18, height: 12, unit: "in" } },
        { weight: { value: 38, unit: "lb" } },
      ],
      shipmentKind: "luggage",
      contactName: "Lydia Hartley",
      phone: "612-555-0100",
      email: "lydia@example.com",
    });
    expect(details.text).toBe(
      [
        "Name: Lydia Hartley",
        "Phone: 612-555-0100",
        "Email: lydia@example.com",
        "Collect from: 214 Elm St, Minneapolis, MN 55401",
        "Deliver to:",
        "Lydia Hartley",
        "c/o Grand Floridian",
        "HOLD FOR GUEST, ARRIVING DEC 23, 2026",
        "CONF 84412907",
        "4401 Floridian Way",
        "Orlando, FL 32830",
        "BOX 1 OF 2, PHONE 612-555-0100",
        "Send on: Thu, Dec 10, 2026",
        "Deliver by: Mon, Dec 21, 2026",
        "Number of bags: 2",
        "Bag 1: 42 lb, 28 × 18 × 12 in",
        "Bag 2: 38 lb",
      ].join("\n"),
    );
    expect(details.fields.map((field) => field.label)).toEqual([
      "Name", "Phone", "Email", "Collect from", "Deliver to", "Send on", "Deliver by", "Number of bags", "Bag 1", "Bag 2",
    ]);
    expect(details.fields.find((field) => field.label === "Send on")?.value).toBe("Thu, Dec 10, 2026");
  });

  it("includes only what is known", () => {
    expect(copyTripDetails({})).toEqual({ text: "", fields: [] });
    const some = copyTripDetails({ sendDate: "2026-12-31", parcels: [{}], shipmentKind: "box", contactName: "  " });
    expect(some.fields).toEqual([
      { label: "Send on", value: "Thu, Dec 31, 2026" },
      { label: "Number of boxes", value: "1" },
    ]);
  });

  it("writes metric parcels as they were entered, and one parcel without a number", () => {
    const details = copyTripDetails({
      parcels: [{ weight: { value: 18.5, unit: "kg" }, dimensions: { length: 70, width: 45, height: 30, unit: "cm" } }],
      shipmentKind: "gift",
    });
    expect(details.fields).toEqual([
      { label: "Number of boxes", value: "1" },
      { label: "Box", value: "18.5 kg, 70 × 45 × 30 cm" },
    ]);
  });

  it("keeps the year on dates across New Year", () => {
    const details = copyTripDetails({ sendDate: "2026-12-29", targetDeliveryDate: "2027-01-04" });
    expect(details.text).toBe("Send on: Tue, Dec 29, 2026\nDeliver by: Mon, Jan 4, 2027");
  });
});
