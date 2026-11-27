import { describe, expect, it } from "vitest";
import { PARCEL_STATUSES, SHIPMENT_DESTINATION_TYPES, parcelSchema, type Parcel, type ParcelStatus } from "@/lib/domain";
import { copyProblems, isSentence } from "./copy-check";
import { shipmentStatus, withParcelStatus, withTrackingNumber, type ShipmentStatusInput } from "./status";

/** A box of gifts to a hotel: ship by Thu Dec 10, due Mon Dec 21, she arrives Wed Dec 23. */
const base: Omit<ShipmentStatusInput, "parcels" | "today"> = {
  shipmentKind: "box",
  destination: "hotel",
  shipByDate: "2026-12-10",
  targetDeliveryDate: "2026-12-21",
  arrivalDate: "2026-12-23",
};
const parcels = (...statuses: ParcelStatus[]) => statuses.map((status) => ({ status, trackingNumber: "1Z999AA10123456784" }));
const at = (today: string, list: ShipmentStatusInput["parcels"], extra: Partial<ShipmentStatusInput> = {}) =>
  shipmentStatus({ ...base, parcels: list, today, ...extra });

describe("the tile line", () => {
  it("says what the brief says: 1 box on its way, arrives Dec 21", () => {
    expect(at("2026-12-12", parcels("shipped")).line).toBe("1 box on its way, arrives Dec 21");
  });

  it("counts parcels and uses the right noun", () => {
    expect(at("2026-12-12", parcels("shipped", "shipped")).line).toBe("2 boxes on their way, arrives Dec 21");
    expect(at("2026-12-12", parcels("shipped"), { shipmentKind: "luggage" }).line).toBe("1 bag on its way, arrives Dec 21");
    expect(at("2026-12-12", parcels("shipped", "shipped"), { shipmentKind: "gear" }).line).toBe("2 bags on their way, arrives Dec 21");
    expect(at("2026-12-12", parcels("shipped"), { shipmentKind: "mail" }).line).toBe("1 package on its way, arrives Dec 21");
    expect(at("2026-12-12", parcels("shipped"), { shipmentKind: "retail_order" }).line).toBe("1 order on its way, arrives Dec 21");
    expect(at("2026-12-12", parcels("shipped"), { shipmentKind: null }).line).toBe("1 box on its way, arrives Dec 21");
  });

  it("follows each status", () => {
    expect(at("2026-11-27", []).line).toBe("1 box to send, ship by Thu, Dec 10");
    expect(at("2026-11-27", parcels("planned", "planned")).line).toBe("2 boxes to send, ship by Thu, Dec 10");
    expect(at("2026-12-05", parcels("packed")).line).toBe("1 box packed, ship by Thu, Dec 10");
    expect(at("2026-12-21", parcels("delivered", "delivered")).line).toBe("2 boxes delivered");
    expect(at("2026-12-23", parcels("picked_up")).line).toBe("1 box picked up");
    expect(at("2026-12-20", parcels("problem")).line).toBe("1 box has a problem");
    expect(at("2026-12-20", parcels("problem", "problem")).line).toBe("2 boxes have a problem");
  });

  it("combines mixed parcels, most advanced first, problems before all", () => {
    expect(at("2026-12-20", parcels("delivered", "shipped")).line).toBe("1 box delivered, 1 on its way, arrives Dec 21");
    expect(at("2026-12-08", parcels("shipped", "packed", "planned")).line).toBe("1 box on its way, 1 packed, 1 to send, ship by Thu, Dec 10");
    expect(at("2026-12-20", parcels("problem", "shipped")).line).toBe("1 box has a problem, 1 on its way, arrives Dec 21");
    expect(at("2026-12-23", parcels("picked_up", "delivered")).line).toBe("1 box picked up, 1 delivered");
  });

  it("says 'due' once the day has passed, and leaves dates out when it has none", () => {
    expect(at("2026-12-22", parcels("shipped")).line).toBe("1 box on its way, due Dec 21");
    expect(at("2026-12-21", parcels("shipped")).line).toBe("1 box on its way, arrives Dec 21");
    expect(shipmentStatus({ parcels: parcels("shipped"), today: "2026-12-12" }).line).toBe("1 box on its way");
    expect(shipmentStatus({ parcels: [], today: "2026-12-12" }).line).toBe("1 box to send");
  });
});

describe("the next nudge", () => {
  it("before anything: ask the hotel", () => {
    const status = at("2026-11-27", []);
    expect(status).toMatchObject({
      stage: "planned",
      nudge: "Ask the hotel whether it will accept a box.",
      level: "info",
      action: { key: "message_property", label: "Message the hotel" },
    });
  });

  it("five days before the ship-by date, asking stops being optional", () => {
    expect(at("2026-12-04", parcels("planned")).level).toBe("info");
    expect(at("2026-12-05", parcels("planned")).level).toBe("caution");
    expect(at("2026-12-05", parcels("planned")).nudge).toBe("Ask the hotel whether it will accept a box.");
  });

  it("once the hotel has answered: choose how to send it", () => {
    expect(at("2026-11-27", parcels("planned", "planned"), { propertyConfirmed: true })).toMatchObject({
      nudge: "Choose how to send them, then pack and ship by Thu, Dec 10.",
      level: "info",
      action: { key: "choose_how_to_send", label: "Choose how to send" },
    });
  });

  it("the day before: pack and label it, ship by tomorrow", () => {
    expect(at("2026-12-09", parcels("planned"))).toMatchObject({
      nudge: "Pack and label it. Ship by tomorrow.",
      level: "caution",
      action: { key: "mark_packed", label: "Mark as packed" },
    });
    expect(at("2026-12-09", parcels("packed"))).toMatchObject({ nudge: "Ship it by tomorrow.", action: { key: "record_tracking", label: "Mark as shipped" } });
  });

  it("on the day: ship today, before the afternoon cutoff", () => {
    expect(at("2026-12-10", parcels("planned"))).toMatchObject({ nudge: "Pack and label it, and ship today before about 3 pm.", level: "caution" });
    expect(at("2026-12-10", parcels("packed"))).toMatchObject({ nudge: "Ship it today, before about 3 pm.", level: "caution" });
  });

  it("after the day: an alert, with the way out", () => {
    for (const status of ["planned", "packed"] as const) {
      expect(at("2026-12-12", parcels(status))).toMatchObject({
        nudge: "The safe day to ship was Thu, Dec 10. Send it today, or pick a faster service.",
        level: "alert",
        action: { key: "see_faster_options", label: "See faster options" },
      });
    }
  });

  it("packed and in good time: drop it off by the date", () => {
    expect(at("2026-12-05", parcels("packed"), { propertyConfirmed: true })).toMatchObject({
      stage: "packed",
      nudge: "Drop it off by Thu, Dec 10.",
      level: "info",
      action: { key: "record_tracking", label: "Mark as shipped" },
    });
  });

  it("shipped without a tracking number: add it", () => {
    expect(at("2026-12-12", [{ status: "shipped" }])).toMatchObject({
      nudge: "Add the tracking number so you can follow it.",
      level: "info",
      action: { key: "record_tracking", label: "Add tracking number" },
    });
    expect(at("2026-12-12", [{ status: "shipped", trackingNumber: "   " }]).action?.key).toBe("record_tracking");
  });

  it("shipped and on its way: nothing to do yet", () => {
    expect(at("2026-12-12", parcels("shipped"))).toMatchObject({ stage: "shipped", nudge: null, level: null, action: { key: "mark_delivered", label: "Mark as arrived" } });
    expect(at("2026-12-21", parcels("shipped"))).toMatchObject({ nudge: "It should arrive today.", level: "info" });
  });

  it("the day after it was due: did it arrive? Ask the front desk", () => {
    expect(at("2026-12-22", parcels("shipped"))).toMatchObject({
      nudge: "Did it arrive? Ask the front desk.",
      level: "caution",
      action: { key: "mark_delivered", label: "Mark as arrived" },
    });
    // Who to ask depends on where it went.
    expect(at("2026-12-22", parcels("shipped"), { destination: "conference_venue" }).nudge).toBe("Did it arrive? Ask the business center or front desk.");
    expect(at("2026-12-22", parcels("shipped"), { destination: "vacation_rental" }).nudge).toBe("Did it arrive? Ask your host.");
    expect(at("2026-12-22", parcels("shipped"), { destination: "relative_home" }).nudge).toBe("Did it arrive? Ask your host.");
    expect(at("2026-12-22", parcels("shipped"), { destination: "ups_access_point" }).nudge).toBe("Did it arrive? Check the tracking page.");
    expect(at("2026-12-22", parcels("shipped"), { destination: null }).nudge).toBe("Did it arrive? Ask the place it was sent to.");
    // Still asked when one of two has come.
    expect(at("2026-12-22", parcels("delivered", "shipped")).nudge).toBe("Did it arrive? Ask the front desk.");
  });

  it("delivered before she arrives: ask them to confirm they have it", () => {
    expect(at("2026-12-21", parcels("delivered", "delivered"))).toMatchObject({
      stage: "delivered",
      nudge: "They arrived. Ask the front desk to confirm they have them.",
      level: "info",
      action: { key: "mark_picked_up", label: "Mark as picked up" },
    });
    expect(at("2026-12-21", parcels("delivered"), { destination: "relative_home" }).nudge).toBe("It arrived. Ask your host to confirm they have it.");
  });

  it("delivered and she is there: pick it up", () => {
    expect(at("2026-12-23", parcels("delivered")).nudge).toBe("It arrived. Pick it up from the front desk.");
    expect(at("2026-12-24", parcels("delivered"), { destination: "vacation_rental" }).nudge).toBe("It arrived and should be waiting for you.");
  });

  it("delivered to a pickup point: collect it before it goes back", () => {
    expect(at("2026-12-22", parcels("delivered"), { destination: "ups_access_point" })).toMatchObject({
      nudge: "It arrived. Collect it within 7 days, with photo ID.",
      level: "caution",
    });
    expect(at("2026-12-22", parcels("delivered"), { destination: "amazon_locker" }).nudge).toBe("It arrived. Collect it within 3 days, with your pickup code.");
    expect(at("2026-12-22", parcels("delivered"), { destination: "usps_general_delivery" }).nudge).toBe("It arrived. Collect it within 30 days, with photo ID.");
  });

  it("picked up: all done, nothing to nudge", () => {
    expect(at("2026-12-23", parcels("picked_up", "picked_up"))).toMatchObject({ stage: "picked_up", nudge: null, level: null, action: null });
  });

  it("a problem comes first, whatever else is true", () => {
    expect(at("2026-12-20", parcels("problem", "delivered"))).toMatchObject({
      stage: "problem",
      nudge: "Open the tracking page to see what happened, then call the carrier.",
      level: "alert",
      action: { key: "check_tracking", label: "Check tracking" },
    });
  });

  it("without a ship-by date: finish planning", () => {
    expect(shipmentStatus({ parcels: [], today: "2026-12-12" })).toMatchObject({
      stage: "planned",
      nudge: "Add where it is going and the day you arrive to see when to ship.",
      action: { key: "finish_planning", label: "Finish planning" },
    });
  });

  it("asks a rental host and a relative in their own words, and nobody at a pickup point", () => {
    expect(at("2026-11-27", parcels("planned"), { destination: "vacation_rental" })).toMatchObject({
      nudge: "Ask your host whether they will accept a box.",
      action: { key: "message_property", label: "Message your host" },
    });
    expect(at("2026-11-27", parcels("planned"), { destination: "relative_home", shipmentKind: "luggage" }).nudge).toBe("Ask your host whether it is all right to send a bag.");
    expect(at("2026-11-27", parcels("planned"), { destination: "ups_access_point" })).toMatchObject({
      nudge: "Choose how to send it, then pack and ship by Thu, Dec 10.",
      action: { key: "choose_how_to_send" },
    });
  });
});

describe("the stage and the counts", () => {
  it("is the least advanced parcel, and problem beats everything", () => {
    expect(at("2026-12-12", parcels("shipped", "delivered", "picked_up")).stage).toBe("shipped");
    expect(at("2026-12-12", parcels("planned", "picked_up")).stage).toBe("planned");
    expect(at("2026-12-12", parcels("packed", "shipped")).stage).toBe("packed");
    expect(at("2026-12-12", parcels("delivered", "picked_up")).stage).toBe("delivered");
    expect(at("2026-12-12", parcels("picked_up", "problem")).stage).toBe("problem");
    expect(at("2026-12-12", []).stage).toBe("planned");
  });

  it("counts every status", () => {
    expect(at("2026-12-12", parcels("shipped", "shipped", "delivered", "problem")).counts).toEqual({
      planned: 0, packed: 0, shipped: 2, delivered: 1, picked_up: 0, problem: 1,
    });
    expect(at("2026-12-12", []).counts.planned).toBe(1);
  });
});

describe("the status track", () => {
  const marks = (status: ReturnType<typeof shipmentStatus>) =>
    status.track.map((step) => `${step.label}${step.done ? " ✓" : ""}${step.current ? " ←" : ""}`);

  it("walks Planned, Hotel confirmed, Packed, Shipped, Delivered, Picked up", () => {
    expect(marks(at("2026-11-27", []))).toEqual(["Planned ✓", "Hotel confirmed ←", "Packed", "Shipped", "Delivered", "Picked up"]);
    expect(marks(at("2026-11-27", [], { propertyConfirmed: true }))).toEqual(["Planned ✓", "Hotel confirmed ✓", "Packed ←", "Shipped", "Delivered", "Picked up"]);
    expect(marks(at("2026-12-05", parcels("packed"), { propertyConfirmed: true }))).toEqual(["Planned ✓", "Hotel confirmed ✓", "Packed ✓", "Shipped ←", "Delivered", "Picked up"]);
    expect(marks(at("2026-12-12", parcels("shipped")))).toEqual(["Planned ✓", "Hotel confirmed ✓", "Packed ✓", "Shipped ✓", "Delivered ←", "Picked up"]);
    expect(marks(at("2026-12-21", parcels("delivered")))).toEqual(["Planned ✓", "Hotel confirmed ✓", "Packed ✓", "Shipped ✓", "Delivered ✓", "Picked up ←"]);
    expect(marks(at("2026-12-23", parcels("picked_up")))).toEqual(["Planned ✓", "Hotel confirmed ✓", "Packed ✓", "Shipped ✓", "Delivered ✓", "Picked up ✓"]);
  });

  it("packed before the hotel answered: the answer is still the open step", () => {
    expect(marks(at("2026-12-05", parcels("packed")))).toEqual(["Planned ✓", "Hotel confirmed ←", "Packed ✓", "Shipped", "Delivered", "Picked up"]);
  });

  it("names the confirming step for the place, and drops it for pickup points", () => {
    const label = (destination: ShipmentStatusInput["destination"]) =>
      at("2026-11-27", [], { destination }).track.find((step) => step.key === "property_confirmed")?.label;
    expect(label("hotel")).toBe("Hotel confirmed");
    expect(label("cruise_precruise_hotel")).toBe("Hotel confirmed");
    expect(label("resort")).toBe("Resort confirmed");
    expect(label("conference_venue")).toBe("Venue confirmed");
    expect(label("vacation_rental")).toBe("Host confirmed");
    expect(label("relative_home")).toBe("Host confirmed");
    expect(label(null)).toBe("Place confirmed");
    for (const destination of ["ups_access_point", "fedex_hold_at_location", "usps_general_delivery", "amazon_locker", "amazon_counter"] as const) {
      expect(label(destination)).toBeUndefined();
      expect(at("2026-11-27", [], { destination }).track.map((step) => step.key)).toEqual(["planned", "packed", "shipped", "delivered", "picked_up"]);
    }
  });

  it("with a problem, shows how far things had got", () => {
    expect(marks(at("2026-12-20", parcels("problem")))).toEqual(["Planned ✓", "Hotel confirmed ✓", "Packed ✓", "Shipped ✓", "Delivered ←", "Picked up"]);
    expect(marks(at("2026-12-20", parcels("problem", "delivered")))).toEqual(["Planned ✓", "Hotel confirmed ✓", "Packed ✓", "Shipped ✓", "Delivered ✓", "Picked up ←"]);
  });
});

describe("every combination", () => {
  it("reads properly and always has at most one current step", () => {
    const days = ["2026-11-27", "2026-12-05", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-21", "2026-12-22", "2026-12-23", "2026-12-30"];
    for (const destination of [...SHIPMENT_DESTINATION_TYPES, null]) {
      for (const status of PARCEL_STATUSES) {
        for (const today of days) {
          for (const count of [1, 2]) {
            for (const propertyConfirmed of [false, true]) {
              const result = at(today, parcels(...Array<ParcelStatus>(count).fill(status)), { destination, propertyConfirmed });
              expect(copyProblems(result.line), result.line).toEqual([]);
              expect(result.line.endsWith(".")).toBe(false);
              if (result.nudge) {
                expect(copyProblems(result.nudge), result.nudge).toEqual([]);
                expect(isSentence(result.nudge), result.nudge).toBe(true);
                expect(result.level).not.toBeNull();
              } else {
                expect(result.level).toBeNull();
              }
              if (result.action) expect(copyProblems(result.action.label)).toEqual([]);
              expect(result.track.filter((step) => step.current).length).toBeLessThanOrEqual(1);
              expect(result.track[0]).toMatchObject({ key: "planned", done: true });
              expect(result.stage).toBe(status);
            }
          }
        }
      }
    }
  });
});

describe("withParcelStatus", () => {
  it("sets the status and when, without touching the rest", () => {
    const parcel: Parcel = { status: "shipped", trackingNumber: "1Z999AA10123456784", carrierDetected: "ups", weight: { value: 20, unit: "lb" } };
    const now = new Date("2026-12-21T19:45:00Z");
    const delivered = withParcelStatus(parcel, "delivered", now);
    expect(delivered).toEqual({ ...parcel, status: "delivered", statusAt: "2026-12-21T19:45:00.000Z" });
    expect(parcel.status).toBe("shipped"); // the original is not changed
    expect(parcelSchema.safeParse(delivered).success).toBe(true);
  });
});

describe("withTrackingNumber", () => {
  const now = new Date("2026-12-10T21:10:00Z");

  it("stores the number tidied, names the carrier and marks it shipped", () => {
    const { parcel, detection } = withTrackingNumber({ status: "packed" }, "1z 999 aa1 01 2345 678 4", now);
    expect(parcel).toEqual({ status: "shipped", statusAt: "2026-12-10T21:10:00.000Z", trackingNumber: "1Z999AA10123456784", carrierDetected: "ups" });
    expect(detection.needsConfirmation).toBe(false);
    expect(parcelSchema.safeParse(parcel).success).toBe(true);
  });

  it("does not move a parcel backwards", () => {
    for (const status of ["shipped", "delivered", "picked_up", "problem"] as const) {
      const before: Parcel = { status, statusAt: "2026-12-01T00:00:00Z" };
      const { parcel } = withTrackingNumber(before, "TBA305477112000", now);
      expect(parcel).toEqual({ status, statusAt: "2026-12-01T00:00:00Z", trackingNumber: "TBA305477112000", carrierDetected: "amazon" });
    }
  });

  it("keeps a number it does not recognise, with no carrier", () => {
    const { parcel, detection } = withTrackingNumber({ status: "planned", carrierDetected: "ups" }, "LUGLESS-ORDER-77", now);
    expect(parcel).toEqual({ status: "shipped", statusAt: "2026-12-10T21:10:00.000Z", trackingNumber: "LUGLESSORDER77" });
    expect(detection.best).toBeNull();
  });

  it("passes on the question when the carrier needs confirming, and honours her choice", () => {
    const asked = withTrackingNumber({ status: "packed" }, "986578788855", now);
    expect(asked.parcel.carrierDetected).toBe("fedex");
    expect(asked.detection.needsConfirmation).toBe(true);
    const chosen = withTrackingNumber({ status: "packed" }, "996578788855", now, { preferCarrier: "canadapost" });
    expect(chosen.parcel.carrierDetected).toBe("canadapost");
    expect(chosen.detection.needsConfirmation).toBe(false);
  });

  it("stores another country's post as 'other'", () => {
    expect(withTrackingNumber({ status: "planned" }, "LK461754867HK", now).parcel.carrierDetected).toBe("other");
  });

  it("clears the number when the box is emptied", () => {
    const before: Parcel = { status: "shipped", trackingNumber: "1Z999AA10123456784", carrierDetected: "ups", statusAt: "2026-12-10T21:10:00Z" };
    expect(withTrackingNumber(before, "  ", now).parcel).toEqual({ status: "shipped", statusAt: "2026-12-10T21:10:00Z" });
  });

  it("will not store what looks like a card number until she says it is right", () => {
    const before: Parcel = { status: "packed" };
    const refused = withTrackingNumber(before, "4111 1111 1111 1111", now);
    expect(refused.parcel).toBe(before);
    expect(refused.detection.looksLikeCardNumber).toBe(true);
    const accepted = withTrackingNumber(before, "4111 1111 1111 1111", now, { storeCardLikeNumber: true });
    expect(accepted.parcel.trackingNumber).toBe("4111111111111111");
    expect(accepted.parcel.status).toBe("shipped");
  });

  it("never stores more than the field allows", () => {
    const { parcel } = withTrackingNumber({ status: "planned" }, "A1".repeat(80), now);
    expect(parcel.trackingNumber).toHaveLength(60);
    expect(parcelSchema.safeParse(parcel).success).toBe(true);
  });
});
