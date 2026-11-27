// The whole Send ahead flow through the folder's public door, the way a screen would use it:
// the product spec's "shipping a box of gifts ahead" (section 6.4), step by step.

import { describe, expect, it } from "vitest";
import { parseBookingDetails, type ShipmentDetails } from "@/lib/domain";
import { localDateOf } from "@/lib/time";
import * as shipping from "./index";
import {
  DEFAULT_SERVICE,
  contentsWarnings,
  copyTripDetails,
  detectCarrier,
  isServiceKey,
  labelBlock,
  mailOptions,
  pickupPointOptions,
  propertyMessage,
  recommendProviders,
  shipByFieldsToStore,
  shipByOptions,
  shipByPlan,
  shipmentStatus,
  suggestContentFlags,
  trackingLink,
  withParcelStatus,
  withTrackingNumber,
} from "./index";

describe("a box of gifts to the lake house, from first question to picked up", () => {
  // Friday Nov 27, 2026, late evening in Minneapolis: already Saturday in UTC.
  const now = new Date("2026-11-28T04:30:00Z");
  const today = localDateOf(now, "America/Chicago");
  const lakeHouse = { addressLines: ["12 Lakeside Ln"], locality: "Windermere", region: "FL", postalCode: "34786", countryCode: "US" };

  it("uses today where she is, not on the server", () => {
    expect(today).toBe("2026-11-27");
  });

  it("walks the whole flow", () => {
    // 1. What: two boxes of gifts, nothing risky inside.
    const contents = [
      { description: "Wrapped gifts", quantity: 6, flags: suggestContentFlags("Wrapped gifts") },
      { description: "Kids' sweaters", quantity: 3, flags: suggestContentFlags("Kids' sweaters") },
    ];
    expect(contentsWarnings(contents, DEFAULT_SERVICE, false, { destination: "vacation_rental" })).toEqual([]);

    // 2. Where: the lake house, a rental. 3. When: each speed.
    const where = { destination: "vacation_rental" as const, arrivalDate: "2026-12-19", originPostalCode: "55401", destinationPostalCode: "34786", today, shipmentKind: "gift" as const };
    const speeds = shipByOptions(where);
    expect(speeds.map((option) => option.line)).toEqual([
      "UPS Ground: ship by Fri, Dec 11",
      "UPS 3 Day Select: ship by Tue, Dec 15",
      "UPS 2nd Day Air: ship by Wed, Dec 16",
      "UPS Next Day Air: ship by Thu, Dec 17",
    ]);
    const plan = shipByPlan({ ...where, service: DEFAULT_SERVICE });
    expect(plan.headline).toBe("Ship by Fri, Dec 11 so it arrives Mon, Dec 21");
    expect(plan.warnings.map((warning) => warning.code)).toEqual(["host_consent_needed", "peak_season"]);
    // The rental needs the host's yes, so a pickup point is offered as the way round it.
    expect(pickupPointOptions().map((option) => option.name)).toEqual(["UPS Access Point", "FedEx Hold at Location", "USPS General Delivery"]);

    // 4. The label and the note to the host.
    const label = labelBlock({ destination: "vacation_rental", recipientName: "Lydia Hartley", hostName: "Marta Ruiz", arrivalDate: "2026-12-19", place: lakeHouse, parcelNumber: 1, parcelCount: 2 });
    expect(label.lines).toEqual(["Lydia Hartley", "c/o Marta Ruiz", "12 Lakeside Ln", "Windermere, FL 34786", "BOX 1 OF 2"]);
    const note = propertyMessage({ destination: "vacation_rental", guestName: "Lydia Hartley", arrivalDate: "2026-12-19", hostName: "Marta", parcelCount: 2, shipmentKind: "gift", targetDeliveryDate: plan.targetDeliveryDate });
    expect(note?.short).toContain("around Mon, Dec 21");

    // 5. Who to ship with, and the details to paste into their form.
    const who = recommendProviders({ shipmentKind: "gift", international: false });
    expect(who.providers.map((provider) => provider.name).slice(0, 3)).toEqual(["UPS", "FedEx", "USPS"]);
    const pasted = copyTripDetails({ labelLines: label.lines, sendDate: plan.shipByDate, targetDeliveryDate: plan.targetDeliveryDate, parcels: [{}, {}], shipmentKind: "gift" });
    expect(pasted.text).toContain("Send on: Fri, Dec 11, 2026");

    // Everything fits the booking's details as they are stored.
    const parsed = parseBookingDetails("shipment", {
      shipmentKind: "gift",
      destinationType: "vacation_rental",
      recipientName: "Lydia Hartley",
      arrivalDate: "2026-12-19",
      originPostal: "55401",
      destinationPostal: "34786",
      labelLines: label.lines,
      contents,
      parcels: [{ status: "planned" }, { status: "planned" }],
      propertyAnswers: { confirmed: true },
      ...shipByFieldsToStore(plan),
    });
    expect(parsed.ok).toBe(true);
    let details = (parsed as { ok: true; details: ShipmentDetails }).details;
    expect(isServiceKey(details.serviceKey)).toBe(true);

    const statusOf = (on: string) =>
      shipmentStatus({
        parcels: details.parcels, today: on, shipmentKind: details.shipmentKind, destination: details.destinationType,
        shipByDate: details.shipByDate, targetDeliveryDate: details.targetDeliveryDate, arrivalDate: details.arrivalDate,
        propertyConfirmed: details.propertyAnswers?.confirmed,
      });
    expect(statusOf(today).line).toBe("2 boxes to send, ship by Fri, Dec 11");
    // The day before ship-by: the reminder the product spec asks for.
    expect(statusOf("2026-12-10").nudge).toBe("Pack and label them. Ship by tomorrow.");

    // 6. After shipping: she pastes the tracking numbers.
    const shippedAt = new Date("2026-12-11T20:05:00Z");
    const first = withTrackingNumber(details.parcels[0], "1Z 999 AA1 01 2345 678 4", shippedAt);
    const second = withTrackingNumber(details.parcels[1], "1Z5R89390357567127", shippedAt);
    details = { ...details, parcels: [first.parcel, second.parcel] };
    expect(first.detection.best?.carrierName).toBe("UPS");
    expect(details.parcels.map((parcel) => [parcel.status, parcel.carrierDetected])).toEqual([["shipped", "ups"], ["shipped", "ups"]]);
    expect(trackingLink(details.parcels[0].carrierDetected, details.parcels[0].trackingNumber)).toEqual({
      url: "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784",
      label: "Track on UPS",
      fallbackUrl: "https://www.ups.com/track",
    });
    expect(statusOf("2026-12-12")).toMatchObject({ stage: "shipped", line: "2 boxes on their way, arrives Dec 21", nudge: null });

    // 7. The day after the target date, not yet marked delivered.
    expect(statusOf("2026-12-22").nudge).toBe("Did it arrive? Ask your host.");

    // She marks them delivered, then picked up.
    details = { ...details, parcels: details.parcels.map((parcel) => withParcelStatus(parcel, "delivered", new Date("2026-12-22T15:00:00Z"))) };
    expect(statusOf("2026-12-22")).toMatchObject({ stage: "delivered", line: "2 boxes delivered" });
    details = { ...details, parcels: details.parcels.map((parcel) => withParcelStatus(parcel, "picked_up", new Date("2026-12-23T01:00:00Z"))) };
    expect(statusOf("2026-12-23")).toMatchObject({ stage: "picked_up", line: "2 boxes picked up", nudge: null, action: null });
    expect(parseBookingDetails("shipment", details).ok).toBe(true);
  });

  it("recognises a carrier from a pasted confirmation, and suggests holding the mail for the week away", () => {
    expect(detectCarrier("9400 1118 9956 2537 8663 61").best?.carrier).toBe("usps");
    const mail = mailOptions({ leaveOn: "2026-12-19", returnOn: "2026-12-26", today });
    expect(mail.find((option) => option.recommended)?.name).toBe("Hold your mail");
  });
});

describe("the folder's public door", () => {
  it("exports what the screens need by name", () => {
    for (const name of [
      "detectCarrier", "trackingUrl", "trackingLink", "findTrackingNumbers", "normalizeTrackingNumber", "carrierName",
      "shipByPlan", "shipByOptions", "shipByFieldsToStore", "returnPlan", "handlingFeeEstimate", "servicesOf", "isServiceKey",
      "labelBlock", "propertyMessage", "mailtoUrl", "questionsToAsk", "confirmReceiptMessage",
      "contentsWarnings", "suggestContentFlags", "hasBlockedContents", "customsNotes",
      "recommendProviders", "copyTripDetails", "pickupPointOptions", "pickupPointOption", "mailOptions",
      "shipmentStatus", "withParcelStatus", "withTrackingNumber", "estimateZone", "isDeliveryDay", "isShipDay",
    ]) {
      expect(typeof (shipping as Record<string, unknown>)[name], name).toBe("function");
    }
    for (const name of ["SERVICES", "CARRIER_CALENDAR", "DESTINATION_POLICIES", "TRACKING_LINKS", "PROVIDER_NAMES", "DESTINATION_WORDS", "PROPERTY_CHECKLIST", "PICKUP_POINT_OPTIONS", "DEFAULT_SERVICE"]) {
      expect((shipping as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("keeps its internal word helpers to itself", () => {
    for (const name of ["count", "listOf", "sentenceCase", "plainMoney", "copyProblems"]) {
      expect((shipping as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
