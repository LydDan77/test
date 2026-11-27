import { describe, expect, it } from "vitest";
import { SHIPMENT_DESTINATION_TYPES, shipmentDetailsSchema } from "@/lib/domain";
import { EN_DASH } from "@/lib/time";
import { copyProblems, isSentence } from "./copy-check";
import { labelBlock, type LabelInput } from "./label";

const orlando = { addressLines: ["4401 Floridian Way"], locality: "Orlando", region: "FL", postalCode: "32830", countryCode: "US" };

const hotelInput: LabelInput = {
  destination: "hotel",
  recipientName: "Lydia Hartley",
  arrivalDate: "2026-12-23",
  propertyName: "Grand Floridian",
  reservationNumber: "84412907",
  place: orlando,
  phone: "612-555-0100",
  parcelNumber: 1,
  parcelCount: 2,
};

describe("a hotel label", () => {
  const label = labelBlock(hotelInput);

  it("has the guest, care of the hotel, the hold line, the confirmation number and the address", () => {
    expect(label.lines).toEqual([
      "Lydia Hartley",
      "c/o Grand Floridian",
      "HOLD FOR GUEST, ARRIVING DEC 23, 2026",
      "CONF 84412907",
      "4401 Floridian Way",
      "Orlando, FL 32830",
      "BOX 1 OF 2, PHONE 612-555-0100",
    ]);
    expect(label.text).toBe(label.lines.join("\n"));
    expect(label.holdNote).toBe("HOLD FOR GUEST, ARRIVING DEC 23, 2026");
    expect(label.missing).toEqual([]);
  });

  it("maps onto a carrier's address form, with a second line short enough to survive", () => {
    expect(label.formFields).toEqual([
      { label: "Recipient name", value: "Lydia Hartley", hint: "Exactly as on the reservation." },
      { label: "Company", value: "Grand Floridian" },
      { label: "Address line 1", value: "4401 Floridian Way" },
      { label: "Address line 2", value: "HOLD ARR 12/23 CONF 84412907", hint: "Kept short: many label forms cut this line off at about 35 characters." },
      { label: "City, state and ZIP", value: "Orlando, FL 32830" },
      { label: "Phone", value: "612-555-0100", hint: "Your mobile, not the hotel's." },
      { label: "Reference or notes", value: "Guest arriving Dec 23, BOX 1 OF 2" },
    ]);
  });

  it("keeps the full hold line when it fits in 35 characters, and drops the number when nothing else fits", () => {
    const short = labelBlock({ ...hotelInput, reservationNumber: "MX1" });
    expect(short.formFields.find((f) => f.label === "Address line 2")?.value).toBe("HOLD FOR GUEST ARR 12/23 CONF MX1");
    const long = labelBlock({ ...hotelInput, reservationNumber: "RESERVATION-2026-000123456789" });
    expect(long.formFields.find((f) => f.label === "Address line 2")?.value).toBe("HOLD FOR GUEST ARR 12/23");
    for (const block of [label, short, long]) {
      expect(block.formFields.find((f) => f.label === "Address line 2")?.value.length).toBeLessThanOrEqual(35);
    }
  });

  it("says how to use it and what to watch", () => {
    expect(label.howTo).toBe("Copy these lines onto the label, or type them into the carrier's address form field by field.");
    expect(label.notes).toEqual([
      "The name has to match your reservation exactly, or the desk may turn the box away.",
      "If the property gives you a different address or wording, use theirs.",
    ]);
  });

  it("leaves out BOX 1 OF 1, and bad box numbers", () => {
    expect(labelBlock({ ...hotelInput, parcelNumber: 1, parcelCount: 1 }).lines.at(-1)).toBe("PHONE 612-555-0100");
    expect(labelBlock({ ...hotelInput, parcelNumber: 3, parcelCount: 2 }).lines.at(-1)).toBe("PHONE 612-555-0100");
    expect(labelBlock({ ...hotelInput, parcelNumber: null, parcelCount: null, phone: null }).lines.at(-1)).toBe("Orlando, FL 32830");
    expect(labelBlock({ ...hotelInput, parcelNumber: 2, parcelCount: 2, phone: "" }).lines.at(-1)).toBe("BOX 2 OF 2");
  });

  it("uses the receiving address the property gave instead of the street address", () => {
    const withDock = labelBlock({ ...hotelInput, receivingAddress: "Package Room\n4401 Floridian Way, Dock B\nOrlando, FL 32830" });
    expect(withDock.lines).toEqual([
      "Lydia Hartley",
      "c/o Grand Floridian",
      "HOLD FOR GUEST, ARRIVING DEC 23, 2026",
      "CONF 84412907",
      "Package Room",
      "4401 Floridian Way, Dock B",
      "Orlando, FL 32830",
      "BOX 1 OF 2, PHONE 612-555-0100",
    ]);
    const oneLine = labelBlock({ ...hotelInput, receivingAddress: "  Receiving Dock, 4401 Floridian Way, Orlando FL 32830  " });
    expect(oneLine.lines[4]).toBe("Receiving Dock, 4401 Floridian Way, Orlando FL 32830");
    expect(oneLine.missing).toEqual([]);
  });

  it("lists what is missing and still writes what it can", () => {
    const bare = labelBlock({ destination: "hotel", recipientName: "  " });
    expect(bare.lines).toEqual(["[Your name]", "HOLD FOR GUEST"]);
    expect(bare.holdNote).toBe("HOLD FOR GUEST");
    expect(bare.missing.map((gap) => gap.field)).toEqual(["recipientName", "address", "propertyName", "arrivalDate", "reservationNumber", "phone"]);
    expect(bare.missing[0].ask).toBe("Add the name on the reservation. The front desk matches the box to it.");
    expect(bare.missing[4].ask).toBe("Add your confirmation number so the front desk can match the box to your booking.");
  });

  it("tidies stray spaces and line breaks in what she typed", () => {
    const messy = labelBlock({ ...hotelInput, recipientName: "  Lydia   Hartley\n", propertyName: " Grand\tFloridian " });
    expect(messy.lines.slice(0, 2)).toEqual(["Lydia Hartley", "c/o Grand Floridian"]);
  });

  it("adds the country on the last address line when it crosses a border", () => {
    const abroad = labelBlock({
      destination: "hotel", recipientName: "Lydia Hartley", arrivalDate: "2027-02-20", propertyName: "Hotel Xcaret", reservationNumber: "MX1",
      place: { addressLines: ["Carretera Chetumal km 282"], locality: "Playa del Carmen", region: "Q.R.", postalCode: "77710", countryCode: "MX" },
      international: true,
    });
    expect(abroad.lines.slice(-2)).toEqual(["Playa del Carmen, Q.R. 77710", "MEXICO"]);
    const unknownCountry = labelBlock({ ...hotelInput, international: true, place: { ...orlando, countryCode: "ZZ" } });
    expect(unknownCountry.lines).toContain("ZZ");
    // Not international: no country line.
    expect(labelBlock(hotelInput).lines).not.toContain("UNITED STATES");
  });
});

describe("other staffed places", () => {
  it("a resort reminds her that Disney-style resorts look for GUEST and the date", () => {
    const resort = labelBlock({ ...hotelInput, destination: "resort" });
    expect(resort.lines).toEqual(labelBlock(hotelInput).lines);
    expect(resort.notes).toContain("Resorts look for the word GUEST and your arrival date on the front of the box.");
  });

  it("the hotel before a cruise warns against the terminal", () => {
    const cruise = labelBlock({ ...hotelInput, destination: "cruise_precruise_hotel" });
    expect(cruise.lines[2]).toBe("HOLD FOR GUEST, ARRIVING DEC 23, 2026");
    expect(cruise.notes).toContain("Send it to the hotel, never to the cruise terminal.");
  });

  it("a conference label carries the company and the event, and stays within ten lines", () => {
    const venue = labelBlock({
      destination: "conference_venue", recipientName: "Lydia Hartley", companyName: "Northwind Co.", arrivalDate: "2027-03-14",
      propertyName: "Hilton Netherland Plaza", reservationNumber: "HX99", eventName: "Marketing Summit",
      eventStartDate: "2027-03-15", eventEndDate: "2027-03-17",
      place: { addressLines: ["35 W 5th St", "Attn: Business Center", "Dock 2", "Floor 1"], locality: "Cincinnati", region: "OH", postalCode: "45202" },
      phone: "612-555-0100", parcelNumber: 2, parcelCount: 3,
    });
    expect(venue.lines).toEqual([
      "Lydia Hartley, Northwind Co.",
      "c/o Hilton Netherland Plaza",
      "HOLD FOR GUEST, ARRIVING MAR 14, 2027",
      "CONF HX99",
      `Marketing Summit, Mar 15${EN_DASH}17`,
      "35 W 5th St",
      "Attn: Business Center",
      "Dock 2, Floor 1",
      "Cincinnati, OH 45202",
      "BOX 2 OF 3, PHONE 612-555-0100",
    ]);
    expect(venue.lines).toHaveLength(10);
    expect(venue.notes).toContain("This is for a box sent to you as a guest. Booth freight uses the show's own label and deadlines.");
    expect(venue.formFields[0]).toEqual({ label: "Recipient name", value: "Lydia Hartley", hint: "Exactly as on the reservation." });
  });

  it("an order from a store uses the name field for the arrival date", () => {
    const order = labelBlock({ ...hotelInput, shipmentKind: "retail_order" });
    expect(order.formFields).toEqual([
      { label: "Full name", value: "Lydia Hartley (Guest, arriving Dec 23)", hint: "So the front desk knows whose it is and when you arrive." },
      { label: "Address line 1", value: "4401 Floridian Way" },
      { label: "Address line 2", value: "c/o Grand Floridian" },
      { label: "City, state and ZIP", value: "Orlando, FL 32830" },
      { label: "Phone", value: "612-555-0100", hint: "Your mobile, not the hotel's." },
    ]);
    expect(order.howTo).toBe("Type it into the store's address form like this.");
    expect(order.notes[0]).toBe("A store can't be told which day to deliver, so order it to land inside the days the hotel will hold it.");
  });
});

describe("homes and rentals", () => {
  it("a rental label is the guest, care of the host, and the address: no hold line", () => {
    const rental = labelBlock({
      destination: "vacation_rental", recipientName: "Lydia Hartley", hostName: "Marta Ruiz", arrivalDate: "2026-12-19",
      place: { addressLines: ["12 Lakeside Ln"], locality: "Windermere", region: "FL", postalCode: "34786" },
      parcelNumber: 1, parcelCount: 2,
    });
    expect(rental.lines).toEqual(["Lydia Hartley", "c/o Marta Ruiz", "12 Lakeside Ln", "Windermere, FL 34786", "BOX 1 OF 2"]);
    expect(rental.holdNote).toBeNull();
    expect(rental.notes).toEqual(["Only send it if your host has said yes in writing.", "Time it to arrive on or after the day you check in."]);
    expect(rental.missing).toEqual([]);
  });

  it("without a host name, suggests adding one if asked", () => {
    const rental = labelBlock({ destination: "vacation_rental", recipientName: "Lydia Hartley", place: { addressLines: ["12 Lakeside Ln"], locality: "Windermere", region: "FL", postalCode: "34786" } });
    expect(rental.lines).toEqual(["Lydia Hartley", "12 Lakeside Ln", "Windermere, FL 34786"]);
    expect(rental.notes).toContain("Add your host's name as a c/o line if they ask for it.");
  });

  it("a relative's home is care of the relative", () => {
    const home = labelBlock({
      destination: "relative_home", recipientName: "Lydia Hartley", hostName: "Ruth Hartley",
      place: { addressLines: ["88 Birch St", "Apt 2"], locality: "Duluth", region: "MN", postalCode: "55802" },
    });
    expect(home.lines).toEqual(["Lydia Hartley", "c/o Ruth Hartley", "88 Birch St", "Apt 2", "Duluth, MN 55802"]);
    expect(home.formFields.map((f) => f.label)).toEqual(["Recipient name", "Company or care of", "Address line 1", "Address line 2", "City, state and ZIP"]);
    expect(home.notes).toEqual(["Tell your host the tracking number so they know to look for it."]);
  });
});

describe("pickup points", () => {
  it("USPS General Delivery: three lines in capitals, the ZIP ending in 9999", () => {
    const label = labelBlock({ destination: "usps_general_delivery", recipientName: "Lydia Hartley", place: { locality: "Moab", region: "UT", postalCode: "84532" } });
    expect(label.lines).toEqual(["LYDIA HARTLEY", "GENERAL DELIVERY", "MOAB, UT 84532-9999"]);
    expect(label.howTo).toBe("Write these three lines as the address. Collect it at the post office counter with photo ID.");
    expect(label.notes).toEqual([
      "Only USPS can deliver to General Delivery. UPS and FedEx cannot.",
      "Usually one post office in a city offers it. Phone to confirm before you send.",
      "The post office keeps it for up to 30 days. Bring government photo ID to collect it.",
    ]);
    expect(label.missing).toEqual([]);
    // A ZIP+4 is cut back to five digits before 9999 is added.
    expect(labelBlock({ destination: "usps_general_delivery", recipientName: "Lydia Hartley", place: { locality: "Moab", region: "UT", postalCode: "84532-1234" } }).lines[2]).toBe("MOAB, UT 84532-9999");
  });

  it("General Delivery without a ZIP asks for it", () => {
    const label = labelBlock({ destination: "usps_general_delivery", recipientName: "Lydia Hartley", place: { locality: "Moab", region: "UT" } });
    expect(label.lines).toEqual(["LYDIA HARTLEY", "GENERAL DELIVERY", "MOAB, UT"]);
    expect(label.missing).toEqual([{ field: "postalCode", ask: "Add the post office's ZIP code. Phone it to check which ZIP it uses for General Delivery." }]);
    const nothing = labelBlock({ destination: "usps_general_delivery", recipientName: "" });
    expect(nothing.lines).toEqual(["[YOUR NAME]", "GENERAL DELIVERY"]);
    expect(nothing.missing.map((gap) => gap.field)).toEqual(["recipientName", "address", "postalCode"]);
  });

  it("a UPS Access Point is chosen in the UPS flow", () => {
    const label = labelBlock({
      destination: "ups_access_point", recipientName: "Lydia Hartley", propertyName: "The UPS Store 4412",
      place: { addressLines: ["7600 Dr Phillips Blvd"], locality: "Orlando", region: "FL", postalCode: "32819" }, phone: "612-555-0100",
    });
    expect(label.lines).toEqual(["Lydia Hartley", "HOLD FOR PICKUP", "The UPS Store 4412", "7600 Dr Phillips Blvd", "Orlando, FL 32819", "PHONE 612-555-0100"]);
    expect(label.howTo).toBe("When you create the UPS label, choose delivery to a UPS Access Point and pick this one.");
    expect(label.formFields.at(-1)).toEqual({ label: "Delivery option", value: "Ship to a UPS Access Point: The UPS Store 4412" });
    expect(label.notes[0]).toBe("UPS keeps it for 7 days, then sends it back. The last pickup day shows in tracking.");
  });

  it("FedEx Hold at Location: never the store's address as the recipient's", () => {
    const label = labelBlock({
      destination: "fedex_hold_at_location", recipientName: "Lydia Hartley", propertyName: "Walgreens",
      place: { addressLines: ["7650 W Sand Lake Rd"], locality: "Orlando", region: "FL", postalCode: "32819" },
    });
    expect(label.lines).toEqual(["Lydia Hartley", "HOLD AT LOCATION", "Walgreens", "7650 W Sand Lake Rd", "Orlando, FL 32819"]);
    expect(label.howTo).toBe("When you create the FedEx label, choose Hold at Location and pick this store. Don't type the store's address in as the recipient's address.");
    expect(label.formFields.map((f) => f.label)).not.toContain("Address line 1");
    const unchosen = labelBlock({ destination: "fedex_hold_at_location", recipientName: "Lydia Hartley" });
    expect(unchosen.missing.map((gap) => gap.field)).toEqual(["address", "propertyName"]);
    expect(unchosen.missing[0].ask).toBe("Choose the pickup point to get its address.");
  });

  it("an Amazon Locker or Counter needs no label at all", () => {
    const locker = labelBlock({ destination: "amazon_locker", recipientName: "Lydia Hartley" });
    expect(locker.lines).toEqual([]);
    expect(locker.text).toBe("");
    expect(locker.howTo).toBe("No label needed. At checkout, choose the Amazon Locker as your delivery address.");
    expect(locker.notes[0]).toBe("Amazon emails a pickup code when it arrives. You have 3 days to collect it before it goes back for a refund.");
    const counter = labelBlock({ destination: "amazon_counter", recipientName: "" });
    expect(counter.howTo).toBe("No label needed. At checkout, choose the Amazon Counter as your delivery address.");
    expect(counter.notes[0]).toContain("7 days");
    expect(counter.missing).toEqual([]);
  });
});

describe("every destination", () => {
  it("fits the stored label fields, never throws, and reads properly", () => {
    const places = [orlando, null, { addressLines: ["1", "2", "3", "4"], locality: "A", region: "B", postalCode: "12345", countryCode: "CA" }];
    for (const destination of SHIPMENT_DESTINATION_TYPES) {
      for (const place of places) {
        for (const extras of [{}, { eventName: "Summit", eventStartDate: "2027-03-15", companyName: "Co", hostName: "Marta", international: true, shipmentKind: "retail_order" as const }]) {
          const label = labelBlock({ ...hotelInput, destination, place, ...extras });
          expect(label.lines.length).toBeLessThanOrEqual(10);
          expect(label.text).toBe(label.lines.join("\n"));
          const parsed = shipmentDetailsSchema.safeParse({
            kind: "shipment", labelLines: label.lines, ...(label.holdNote ? { holdNote: label.holdNote } : {}),
          });
          expect(parsed.success, `${destination}: ${JSON.stringify(label.lines)}`).toBe(true);
          for (const text of [label.howTo, ...label.notes, ...label.missing.map((gap) => gap.ask), ...label.formFields.flatMap((f) => (f.hint ? [f.hint] : []))]) {
            expect(copyProblems(text), text).toEqual([]);
            expect(isSentence(text), text).toBe(true);
          }
          for (const line of label.lines) expect(line.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("builds the dates from the stored local date, whatever the server's clock says", () => {
    // Dec 31 must not slide to Dec 30 or Jan 1.
    expect(labelBlock({ ...hotelInput, arrivalDate: "2026-12-31" }).holdNote).toBe("HOLD FOR GUEST, ARRIVING DEC 31, 2026");
    expect(labelBlock({ ...hotelInput, arrivalDate: "2027-01-01" }).holdNote).toBe("HOLD FOR GUEST, ARRIVING JAN 1, 2027");
    expect(labelBlock({ ...hotelInput, arrivalDate: "2027-01-01", reservationNumber: "A1" }).formFields[3].value).toBe("HOLD FOR GUEST ARR 01/01 CONF A1");
  });
});
