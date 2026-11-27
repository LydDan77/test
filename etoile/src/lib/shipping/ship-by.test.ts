import { describe, expect, it } from "vitest";
import { SHIPMENT_DESTINATION_TYPES, shipmentDetailsSchema, type ShipmentDestinationType } from "@/lib/domain";
import { addDays, compareDates, EN_DASH } from "@/lib/time";
import { isDeliveryDay, isShipDay } from "./calendar";
import { PUBLISHED_LAST_SHIP_DATES, SERVICES, SERVICE_KEYS, type ServiceKey } from "./config";
import { copyProblems, isSentence } from "./copy-check";
import {
  handlingFeeEstimate,
  returnPlan,
  servicesOf,
  shipByFieldsToStore,
  shipByOptions,
  shipByPlan,
  transitDaysFor,
  type ShipByInput,
  type ShipByPlan,
} from "./ship-by";
import { SHIP_BY_VECTORS, SHIP_BY_VECTOR_COUNT } from "./ship-by.vectors";

const dates = (plan: ShipByPlan) => [plan.targetDeliveryDate, plan.shipByDate, plan.latestRiskyDate];
const codes = (plan: ShipByPlan) => plan.warnings.map((warning) => warning.code);
const step = (plan: ShipByPlan, key: string) => plan.steps.find((s) => s.key === key)?.text;

describe("the product spec's example: a box of gifts to a rental house", () => {
  // Product spec 5.8 and 6.4: Seattle to Orlando, check-in Sat Dec 19, 2026.
  const input: ShipByInput = {
    destination: "vacation_rental",
    arrivalDate: "2026-12-19",
    service: "ups_ground",
    originPostalCode: "98101",
    destinationPostalCode: "32801",
    shipmentKind: "gift",
    today: "2026-11-27",
  };
  const plan = shipByPlan(input);

  it("arrives Dec 21, ship by Dec 10, cutting it close Dec 15", () => {
    expect(plan.targetDeliveryDate).toBe("2026-12-21");
    expect(plan.shipByDate).toBe("2026-12-10");
    expect(plan.latestRiskyDate).toBe("2026-12-15");
    expect(plan.earliestAcceptableDate).toBe("2026-12-19");
  });

  it("says so in the spec's own words", () => {
    expect(plan.headline).toBe("Ship by Thu, Dec 10 so it arrives Mon, Dec 21");
    expect(plan.summary).toBe(
      "UPS Ground, 5 business days plus 2 for peak season. Arrives Mon, Dec 21, the first delivery day after you check in on Sat, Dec 19.",
    );
    expect(plan.cuttingItClose).toBe("Cutting it close: Tue, Dec 15");
  });

  it("shows every step of the arithmetic", () => {
    expect(plan.steps).toEqual([
      { key: "arrival", text: "You check in on Sat, Dec 19." },
      { key: "window", text: "A rental has nobody to take in a box before you check in, so it should arrive on or after Sat, Dec 19." },
      { key: "target", text: "The first delivery day on or after that is Mon, Dec 21." },
      { key: "transit", text: "UPS Ground takes about 5 business days from Washington to northern and central Florida. That is an estimate, not a promise." },
      { key: "padding", text: "Add 2 business days for peak season, when the holidays slow every carrier down." },
      { key: "count_back", text: "Counting back 7 business days from Mon, Dec 21 gives Thu, Dec 10." },
      { key: "cutting_close", text: "Cutting it close: sent by Tue, Dec 15, it can still arrive by Mon, Dec 21 if nothing goes wrong." },
      { key: "drop_off", text: "Hand it over before about 3 pm. Later than that, or in a drop box, it leaves the next day." },
    ]);
  });

  it("warns that a rental needs the host's yes, and that peak padding is in", () => {
    expect(plan.warnings).toEqual([
      { code: "host_consent_needed", level: "caution", text: "Only send it to a rental if the host says yes in writing. If they say no, use a pickup point nearby." },
      { code: "peak_season", level: "info", text: "Peak season: 2 extra business days are built in, because carriers run slow from mid-November to early January." },
    ]);
  });

  it("gives the numbers behind it, the reminders and the carrier's calculator", () => {
    expect(plan.transit).toEqual({
      planDays: 5, bestDays: 4, paddingDays: 2, customsDays: 0, peakDays: 2, weatherDays: 0, zone: 8, zoneBasis: "postal_codes",
    });
    expect(plan.reminders).toEqual({ askPropertyOn: "2026-12-05", packOn: "2026-12-09", checkArrivedOn: "2026-12-22" });
    expect(plan.fee).toBeNull();
    expect(plan.fasterOption).toBeNull();
    expect(plan.calculatorUrl).toBe("https://www.ups.com/ctc");
    expect(plan.serviceName).toBe("UPS Ground");
  });

  it("offers each speed: UPS Ground by Dec 10, 2nd Day Air by Dec 16", () => {
    const options = shipByOptions({ destination: "vacation_rental", arrivalDate: "2026-12-19", today: "2026-11-27" });
    expect(options.map((option) => option.line)).toEqual([
      "UPS Ground: ship by Thu, Dec 10",
      "UPS 3 Day Select: ship by Tue, Dec 15",
      "UPS 2nd Day Air: ship by Wed, Dec 16",
      "UPS Next Day Air: ship by Thu, Dec 17",
    ]);
    expect(options.every((option) => option.stillPossible)).toBe(true);
    expect(options.every((option) => option.plan.targetDeliveryDate === "2026-12-21")).toBe(true);
  });

  it("the same box to a hotel aims two business days before arrival instead", () => {
    const hotel = shipByPlan({ ...input, destination: "hotel" });
    expect(dates(hotel)).toEqual(["2026-12-17", "2026-12-08", "2026-12-14"]);
    expect(step(hotel, "window")).toBe(`Hotels usually hold a box for 3 days, so it should arrive Dec 16${EN_DASH}18.`);
    expect(step(hotel, "target")).toBe(
      "Aim for Thu, Dec 17: 2 business days before you check in, so there is time to sort things out if it runs late.",
    );
  });
});

describe("the report's worked examples (today is 2026-11-26)", () => {
  const today = "2026-11-26";
  // [label, input, target, shipBy, risky, plan, padding, warnings the reference raised]
  const examples: [string, Omit<ShipByInput, "today">, string, string, string, number, number, string[]][] = [
    ["hotel, arrive Wed Dec 23, UPS Ground zone 8",
      { destination: "hotel", arrivalDate: "2026-12-23", service: "ups_ground", zone: 8 },
      "2026-12-21", "2026-12-10", "2026-12-16", 5, 2, ["peak_season"]],
    ["hotel, arrive Wed Dec 23, UPS 2nd Day Air",
      { destination: "hotel", arrivalDate: "2026-12-23", service: "ups_2nd_day_air" },
      "2026-12-21", "2026-12-16", "2026-12-18", 2, 1, ["peak_season"]],
    ["hotel, arrive Mon Nov 30, FedEx Ground zone 5",
      { destination: "hotel", arrivalDate: "2026-11-30", service: "fedex_ground", zone: 5 },
      "2026-11-27", "2026-11-19", "2026-11-24", 3, 2, ["peak_season", "ship_by_passed"]],
    ["hotel, arrive Mon Nov 30, FedEx overnight",
      { destination: "hotel", arrivalDate: "2026-11-30", service: "fedex_overnight" },
      "2026-11-27", "2026-11-24", "2026-11-24", 1, 1, ["peak_season", "ship_by_passed"]],
    ["relative, arrive Thu Dec 24, USPS Ground Advantage zone 8",
      { destination: "relative_home", arrivalDate: "2026-12-24", service: "usps_ground_advantage", zone: 8 },
      "2026-12-21", "2026-12-12", "2026-12-18", 5, 2, ["peak_season"]],
    ["hotel, arrive Mon Mar 15 2027, UPS Ground zone 4",
      { destination: "hotel", arrivalDate: "2027-03-15", service: "ups_ground", zone: 4 },
      "2027-03-12", "2027-03-09", "2027-03-10", 3, 0, ["calendar_projected"]],
    ["hotel, arrive Tue Jul 6 2027, USPS Priority Mail zone 5",
      { destination: "hotel", arrivalDate: "2027-07-06", service: "usps_priority_mail", zone: 5 },
      "2027-07-03", "2027-06-30", "2027-07-01", 3, 0, []],
    ["resort abroad, arrive Sat Feb 20 2027, FedEx International Economy",
      { destination: "resort", arrivalDate: "2027-02-20", service: "fedex_intl_economy" },
      "2027-02-16", "2027-02-05", "2027-02-16", 5, 2, ["calendar_projected"]],
    ["UPS Access Point, arrive Fri Apr 9 2027, UPS Ground zone 6",
      { destination: "ups_access_point", arrivalDate: "2027-04-09", service: "ups_ground", zone: 6 },
      "2027-04-08", "2027-04-02", "2027-04-05", 4, 0, ["calendar_projected"]],
    ["vacation rental, check-in Sat May 1 2027, UPS Ground zone 3",
      { destination: "vacation_rental", arrivalDate: "2027-05-01", service: "ups_ground", zone: 3 },
      "2027-05-03", "2027-04-29", "2027-04-30", 2, 0, ["calendar_projected"]],
  ];

  for (const [label, input, target, shipBy, risky, planDays, padding, referenceWarnings] of examples) {
    it(label, () => {
      const plan = shipByPlan({ ...input, today });
      expect(dates(plan)).toEqual([target, shipBy, risky]);
      expect(plan.transit.planDays).toBe(planDays);
      expect(plan.transit.paddingDays).toBe(padding);
      const tracked = ["peak_season", "ship_by_passed", "calendar_projected", "no_delivery_day_in_window"];
      expect(codes(plan).filter((code) => tracked.includes(code)).sort()).toEqual([...referenceWarnings].sort());
    });
  }

  it("the Thanksgiving example explains the closed day it stepped over", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2026-11-30", service: "fedex_ground", zone: 5, today });
    expect(step(plan, "window")).toBe(`Hotels usually hold a box for 3 days, so it should arrive Nov 27${EN_DASH}29.`);
    expect(step(plan, "target")).toBe("Aim for Fri, Nov 27, the first delivery day inside that window.");
    expect(step(plan, "count_back")).toBe(
      "Counting back 5 business days from Fri, Nov 27 gives Thu, Nov 19. That skips Thanksgiving, when FedEx is closed.",
    );
    expect(plan.warnings[0]).toEqual({
      code: "ship_by_passed",
      level: "alert",
      text: "The safe day to send this by FedEx Ground was Thu, Nov 19. Nothing gets it to the hotel in time now. Send it to a pickup point near where you're staying, or buy it there.",
    });
  });

  it("the USPS example names USPS's own last day, as the report's note does", () => {
    const plan = shipByPlan({ destination: "relative_home", arrivalDate: "2026-12-24", service: "usps_ground_advantage", zone: 8, shipmentKind: "luggage" });
    expect(step(plan, "window")).toBe(`A bag can wait at someone's home for about 3 weeks, so it should arrive Dec 3${EN_DASH}23.`);
    expect(step(plan, "cutting_close")).toBe(
      "Cutting it close: sent by Fri, Dec 18, it can still arrive by Wed, Dec 23 if nothing goes wrong. USPS's own last day to ship this way for Christmas is Thu, Dec 17.",
    );
    expect(step(plan, "count_back")).toBe("Counting back 7 delivery days from Mon, Dec 21 gives Sat, Dec 12.");
  });

  it("the international example explains customs twice: in the buffer and in the padding", () => {
    const plan = shipByPlan({ destination: "resort", arrivalDate: "2027-02-20", service: "fedex_intl_economy" });
    expect(plan.summary).toBe(
      "FedEx International Economy, 5 business days plus 2 for customs. Arrives Tue, Feb 16, 4 business days before you check in on Sat, Feb 20.",
    );
    expect(step(plan, "target")).toBe(
      "Aim for Tue, Feb 16: 4 business days before you check in, 2 of them because customs can hold things up, so there is time to sort things out if it runs late.",
    );
    expect(step(plan, "transit")).toBe(`FedEx International Economy takes 2${EN_DASH}5 business days. This plan allows 5. That is an estimate, not a promise.`);
    expect(step(plan, "padding")).toBe("Add 2 business days for customs.");
    expect(plan.transit).toMatchObject({ customsDays: 2, peakDays: 0, zone: null, zoneBasis: "not_used" });
  });
});

describe("7,160 reference outputs around every carrier holiday, 2026 to 2027", () => {
  type Cell = { arrival: string; target: string; shipBy: string; risky: string; noDeliveryDay: boolean; peak: boolean };
  const rows = SHIP_BY_VECTORS.map(([destination, service, zone, firstArrival, cells]) => ({
    destination: destination as ShipmentDestinationType,
    service: service as ServiceKey,
    zone,
    cells: cells.split("|").map((cell, index): Cell => {
      const [target, shipBy, risky, flags = ""] = cell.split(" ");
      const arrival = addDays(firstArrival, index);
      return {
        arrival,
        target: addDays(arrival, Number(target)),
        shipBy: addDays(arrival, Number(shipBy)),
        risky: addDays(arrival, Number(risky)),
        noDeliveryDay: flags.includes("n"),
        peak: flags.includes("p"),
      };
    }),
  }));

  it("holds all the vectors, for known destinations and services", () => {
    expect(rows.reduce((sum, row) => sum + row.cells.length, 0)).toBe(SHIP_BY_VECTOR_COUNT);
    expect(SHIP_BY_VECTOR_COUNT).toBe(7160);
    for (const row of rows) {
      expect(SHIPMENT_DESTINATION_TYPES).toContain(row.destination);
      expect(SERVICE_KEYS).toContain(row.service);
    }
  });

  it("matches the reference on the delivery date, the ship-by date and the cutting-it-close date", () => {
    const publishedCutoffs = new Set(PUBLISHED_LAST_SHIP_DATES.map((cutoff) => cutoff.lastShip));
    let compared = 0;
    let cappedByCarrier = 0;
    let riskyRaised = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      for (const cell of row.cells) {
        const plan = shipByPlan({ destination: row.destination, arrivalDate: cell.arrival, service: row.service, zone: row.zone });
        const id = `${row.destination} ${row.service} zone ${row.zone} arriving ${cell.arrival}`;
        compared++;
        if (plan.targetDeliveryDate !== cell.target) mismatches.push(`${id}: target ${plan.targetDeliveryDate}, reference ${cell.target}`);

        // Documented difference 1: the carrier's own published last day to ship wins when earlier.
        if (plan.shipByDate !== cell.shipBy) {
          const capped =
            plan.steps.some((s) => s.key === "carrier_cutoff") &&
            compareDates(plan.shipByDate, cell.shipBy) < 0 &&
            publishedCutoffs.has(plan.shipByDate);
          if (capped) cappedByCarrier++;
          else mismatches.push(`${id}: ship by ${plan.shipByDate}, reference ${cell.shipBy}`);
        }

        // Documented difference 2: "cutting it close" is never earlier than the ship-by date.
        const expectedRisky = compareDates(cell.risky, plan.shipByDate) < 0 ? plan.shipByDate : cell.risky;
        if (expectedRisky !== cell.risky) riskyRaised++;
        if (plan.latestRiskyDate !== expectedRisky) mismatches.push(`${id}: risky ${plan.latestRiskyDate}, reference ${cell.risky}`);

        if (codes(plan).includes("no_delivery_day_in_window") !== cell.noDeliveryDay) mismatches.push(`${id}: no-delivery-day warning differs`);
        if (codes(plan).includes("peak_season") !== cell.peak) mismatches.push(`${id}: peak padding differs`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(7160);
    // The two documented differences are rare, and are exercised on purpose further down.
    expect(cappedByCarrier).toBeGreaterThan(0);
    expect(cappedByCarrier).toBeLessThan(60);
    expect(riskyRaised).toBeLessThan(120);
  });

  it("always lands on real working days, in order", () => {
    for (const row of rows) {
      for (const cell of row.cells) {
        const plan = shipByPlan({ destination: row.destination, arrivalDate: cell.arrival, service: row.service, zone: row.zone });
        const id = `${row.destination} ${row.service} arriving ${cell.arrival}`;
        expect(isDeliveryDay(row.service, plan.targetDeliveryDate), `${id}: target is a delivery day`).toBe(true);
        expect(isShipDay(row.service, plan.shipByDate), `${id}: ship-by is a ship day`).toBe(true);
        expect(isShipDay(row.service, plan.latestRiskyDate), `${id}: cutting-close is a ship day`).toBe(true);
        expect(compareDates(plan.shipByDate, plan.targetDeliveryDate), `${id}: ships before it arrives`).toBe(-1);
        expect(compareDates(plan.shipByDate, plan.latestRiskyDate), `${id}: safe date is not after the risky one`).toBeLessThanOrEqual(0);
        expect(compareDates(plan.latestRiskyDate, plan.targetDeliveryDate) <= 0 || row.destination !== "vacation_rental", id).toBe(true);
      }
    }
  });
});

describe("around the holidays, in words", () => {
  it("Christmas Eve: UPS delivers but does not pick up, so ship a day earlier", () => {
    const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-29", service: "ups_next_day_air" });
    expect(dates(plan)).toEqual(["2026-12-29", "2026-12-23", "2026-12-28"]);
    expect(step(plan, "target")).toBe("UPS delivers that day, so that is the day to aim for.");
    expect(step(plan, "count_back")).toBe(
      "Counting back 2 business days from Tue, Dec 29 gives Thu, Dec 24. That skips Christmas Day, when UPS is closed. UPS doesn't pick up on Christmas Eve, so ship by Wed, Dec 23 instead.",
    );
    expect(plan.summary).toBe("UPS Next Day Air, 1 business day plus 1 for peak season. Arrives Tue, Dec 29, the day you check in.");
  });

  it("the day after Thanksgiving: FedEx closes early, so ship before the holiday", () => {
    const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-02", service: "fedex_express_saver" });
    // Target Wed Dec 2; 3 days + 1 peak back: Dec 1, Nov 30, Nov 27, Nov 25 (Thanksgiving closed).
    expect(plan.targetDeliveryDate).toBe("2026-12-02");
    expect(plan.shipByDate).toBe("2026-11-24");
    expect(step(plan, "count_back")).toBe(
      "Counting back 4 business days from Wed, Dec 2 gives Wed, Nov 25. That skips Thanksgiving, when FedEx is closed. FedEx closes early on the day before Thanksgiving, so ship by Tue, Nov 24 instead.",
    );
  });

  it("New Year's Eve: UPS Ground does not move, UPS air does", () => {
    const ground = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-01-04", service: "ups_ground", zone: 2 });
    // 1 day + 2 peak back from Mon Jan 4: Dec 30, Dec 29, Dec 28 (Dec 31 air only, Jan 1 closed).
    expect(dates(ground)).toEqual(["2027-01-04", "2026-12-28", "2026-12-30"]);
    expect(step(ground, "count_back")).toBe(
      "Counting back 3 business days from Mon, Jan 4 gives Mon, Dec 28. That skips New Year's Eve and New Year's Day, when UPS isn't moving ground parcels.",
    );
    const air = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-01-04", service: "ups_next_day_air" });
    // 1 day + 1 peak: Dec 31 counts for air, Dec 30.
    expect(dates(air)).toEqual(["2027-01-04", "2026-12-30", "2026-12-31"]);
    expect(step(air, "count_back")).toBe(
      "Counting back 2 business days from Mon, Jan 4 gives Wed, Dec 30. That skips New Year's Day, when UPS is closed.",
    );
  });

  it("across the year boundary with USPS, which works the Saturday after New Year's Day", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-01-06", service: "usps_priority_mail", zone: 5 });
    expect(dates(plan)).toEqual(["2027-01-04", "2026-12-29", "2027-01-02"]);
    expect(step(plan, "count_back")).toBe(
      "Counting back 4 delivery days from Mon, Jan 4 gives Tue, Dec 29. That skips New Year's Day, when USPS is closed.",
    );
    expect(step(plan, "transit")).toBe(`USPS Priority Mail takes 2${EN_DASH}3 delivery days. This plan allows 3.`);
    expect(codes(plan)).toEqual(["peak_season", "ask_property_first"]);
  });

  it("peak padding ends after January 8", () => {
    const inside = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-01-08", service: "ups_2nd_day_air" });
    expect(inside.transit.peakDays).toBe(1);
    // Target Mon Jan 18 would be MLK Day (UPS closed, projected), so Tue Jan 19; ship Jan 15: outside peak.
    const outside = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-01-16", service: "ups_2nd_day_air" });
    expect(outside.transit.peakDays).toBe(0);
    expect(dates(outside)).toEqual(["2027-01-19", "2027-01-14", "2027-01-14"]);
    expect(codes(outside)).toContain("calendar_projected");
  });

  it("a ship date inside peak pads even when the delivery date is outside it", () => {
    // Arrive Fri Jan 15, 2027 at a hotel: target Wed Jan 13 (outside), ship date in early January (inside).
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-01-15", service: "ups_ground", zone: 8 });
    expect(plan.targetDeliveryDate).toBe("2027-01-13");
    expect(plan.transit.peakDays).toBe(2);
    expect(plan.shipByDate).toBe("2027-01-04");
  });

  it("Martin Luther King Jr. Day 2027: UPS closed (projected), FedEx only on modified service", () => {
    const ups = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-01-18", service: "ups_ground", zone: 2 });
    expect(ups.targetDeliveryDate).toBe("2027-01-19");
    const fedex = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-01-18", service: "fedex_ground", zone: 2 });
    expect(fedex.targetDeliveryDate).toBe("2027-01-18");
    expect(fedex.shipByDate).toBe("2027-01-15");
    expect(codes(fedex)).toContain("calendar_projected");
  });

  it("Independence Day 2027 falls on a Sunday: USPS skips Monday July 5", () => {
    const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-07-04", service: "usps_priority_mail", zone: 5 });
    expect(plan.targetDeliveryDate).toBe("2027-07-06");
    expect(step(plan, "target")).toBe("The first delivery day on or after that is Tue, Jul 6.");
    expect(step(plan, "count_back")).toBe(
      "Counting back 3 delivery days from Tue, Jul 6 gives Thu, Jul 1. That skips the Independence Day holiday, when USPS is closed.",
    );
    // USPS has published 2027, so nothing is projected.
    expect(codes(plan)).not.toContain("calendar_projected");
  });

  it("Juneteenth: USPS closed, UPS open", () => {
    const usps = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-06-19", service: "usps_ground_advantage", zone: 2 });
    expect(usps.targetDeliveryDate).toBe("2026-06-20");
    const ups = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-06-19", service: "ups_ground", zone: 2 });
    expect(ups.targetDeliveryDate).toBe("2026-06-19");
  });

  it("Thanksgiving 2027 and Christmas 2027 use projected UPS and FedEx dates and say so", () => {
    const thanksgiving = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-11-25", service: "ups_ground", zone: 2 });
    expect(thanksgiving.targetDeliveryDate).toBe("2027-11-26");
    expect(thanksgiving.warnings.find((w) => w.code === "calendar_projected")?.text).toBe(
      "UPS has not published a holiday schedule that far ahead, so this follows last year's pattern. Check again closer to the day.",
    );
    const christmas = shipByPlan({ destination: "vacation_rental", arrivalDate: "2027-12-25", service: "usps_priority_mail", zone: 5 });
    // Christmas 2027 is a Saturday: USPS is closed, so Monday December 27.
    expect(christmas.targetDeliveryDate).toBe("2027-12-27");
    expect(codes(christmas)).not.toContain("calendar_projected");
  });

  it("past the end of every calendar, says holidays are not counted", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2028-03-15", service: "ups_ground" });
    expect(plan.warnings[0]).toEqual({
      code: "calendar_not_covered",
      level: "caution",
      text: "Carrier holidays that far ahead aren't known yet, so this date ignores them. Check again closer to the day.",
    });
    expect(codes(plan)).not.toContain("calendar_projected");
  });

  it("DHL and the luggage services never plan a delivery for Christmas Day", () => {
    for (const service of ["dhl_express_worldwide", "luggage_forward_intl_standard", "luggage_free_intl"] as const) {
      const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-25", service });
      expect(plan.targetDeliveryDate, service).toBe("2026-12-28");
    }
    const lugless = shipByPlan({ destination: "hotel", arrivalDate: "2026-12-23", service: "lugless_ground", shipmentKind: "luggage" });
    expect(dates(lugless)).toEqual(["2026-12-21", "2026-12-09", "2026-12-18"]);
    expect(step(lugless, "window")).toBe(`Hotels usually hold a bag for 3 days, so it should arrive Dec 20${EN_DASH}22.`);
    expect(lugless.calculatorUrl).toBeNull();
  });
});

describe("the carriers' own last days to ship for Christmas", () => {
  it("USPS Ground Advantage: Dec 17 wins over a later computed date", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2026-12-26", service: "usps_ground_advantage", zone: 2 });
    // The arithmetic alone gives Fri Dec 18 for a Wed Dec 23 delivery.
    expect(plan.targetDeliveryDate).toBe("2026-12-23");
    expect(plan.shipByDate).toBe("2026-12-17");
    expect(step(plan, "count_back")).toBe("Counting back 4 delivery days from Wed, Dec 23 gives Fri, Dec 18.");
    expect(step(plan, "carrier_cutoff")).toBe(
      "USPS itself says Thu, Dec 17 is the last day to ship this way for Christmas, so that is the date to go by.",
    );
    expect(plan.headline).toBe("Ship by Thu, Dec 17 so it arrives Wed, Dec 23");
  });

  it("uses the Alaska and Hawaii date when the box is going offshore", () => {
    const mainland = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-24", service: "usps_ground_advantage", zone: 2 });
    expect(mainland.shipByDate).toBe("2026-12-17");
    // Zone 9 plans 8 days, so the arithmetic is already earlier than USPS's Dec 16.
    const offshore = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-24", service: "usps_ground_advantage", zone: 9 });
    expect(compareDates(offshore.shipByDate, "2026-12-16")).toBeLessThanOrEqual(0);
    expect(step(offshore, "carrier_cutoff")).toBeUndefined();
  });

  it("does nothing when the arithmetic is already earlier, or the delivery is not in Christmas week", () => {
    const early = shipByPlan({ destination: "hotel", arrivalDate: "2026-12-23", service: "ups_2nd_day_air" });
    expect(early.shipByDate).toBe("2026-12-16");
    expect(step(early, "carrier_cutoff")).toBeUndefined();
    const january = shipByPlan({ destination: "hotel", arrivalDate: "2027-01-20", service: "usps_ground_advantage", zone: 2 });
    expect(step(january, "carrier_cutoff")).toBeUndefined();
    const november = shipByPlan({ destination: "hotel", arrivalDate: "2026-12-01", service: "usps_ground_advantage", zone: 2 });
    expect(step(november, "carrier_cutoff")).toBeUndefined();
  });

  it("FedEx Ground uses the cutoff for its lane", () => {
    // A 1-day lane (zone 2) delivering Thu Dec 24: FedEx's last day is Wed Dec 23, the arithmetic says Dec 21.
    const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-24", service: "fedex_ground", zone: 2 });
    expect(plan.targetDeliveryDate).toBe("2026-12-24");
    expect(plan.shipByDate).toBe("2026-12-21");
    expect(step(plan, "carrier_cutoff")).toBeUndefined();
  });
});

describe("what the property confirmed replaces the usual rules", () => {
  it("a longer hold window widens the days it may arrive", () => {
    const plan = shipByPlan({
      destination: "hotel", arrivalDate: "2026-12-23", service: "ups_2nd_day_air",
      property: { confirmed: true, holdDays: 5, feePerBox: { amount: 1500, currency: "USD" } },
    });
    expect(plan.earliestAcceptableDate).toBe("2026-12-18");
    expect(step(plan, "window")).toBe(`The hotel said it can hold a box for 5 days, so it should arrive Dec 18${EN_DASH}22.`);
    expect(plan.fee).toEqual({
      source: "property", perBox: { amount: 1500, currency: "USD" }, low: null, high: null,
      text: "The hotel charges $15 a box to receive it.",
    });
    expect(codes(plan)).not.toContain("ask_property_first");
  });

  it("a shorter hold window pulls the delivery date later", () => {
    // The usual hotel rule for a Wed Mar 17 arrival gives Mon Mar 15. A 1-day hold cannot take that.
    const usual = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", zone: 4 });
    expect(usual.targetDeliveryDate).toBe("2027-03-15");
    const tight = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", zone: 4, property: { holdDays: 1 } });
    expect(tight.targetDeliveryDate).toBe("2027-03-16");
    expect(tight.earliestAcceptableDate).toBe("2027-03-16");
    expect(tight.shipByDate).toBe(addDays(usual.shipByDate, 1));
    expect(step(tight, "window")).toBe("The hotel said it can hold a box for 1 day, so it should arrive Mar 16.");
    expect(step(tight, "target")).toBe("Aim for Tue, Mar 16, the first delivery day inside that window.");
  });

  it("no hold at all means delivery on arrival day", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-16", service: "ups_ground", zone: 4, property: { confirmed: true, holdDays: 0 } });
    expect(plan.targetDeliveryDate).toBe("2027-03-16");
    expect(step(plan, "window")).toBe("The hotel said it can't hold a box before you check in, so it should arrive on Tue, Mar 16, the day you check in.");
    expect(step(plan, "target")).toBe("Aim for Tue, Mar 16, the day you check in.");
    expect(plan.summary).toBe("UPS Ground, 3 business days. Arrives Tue, Mar 16, the day you check in.");
    // The cutting-it-close date is never earlier than the safe date.
    expect(plan.latestRiskyDate).toBe(plan.shipByDate);
    expect(plan.cuttingItClose).toBeNull();
    expect(step(plan, "cutting_close")).toBeUndefined();
  });

  it("warns when no delivery day falls inside the window", () => {
    // Arrival on a Sunday and the hotel will not hold anything early.
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-14", service: "ups_ground", zone: 4, property: { confirmed: true, holdDays: 0 } });
    expect(plan.targetDeliveryDate).toBe("2027-03-11");
    expect(step(plan, "target")).toBe("No delivery day falls inside that window. The closest one before it is Thu, Mar 11.");
    expect(plan.warnings[0]).toEqual({
      code: "no_delivery_day_in_window",
      level: "caution",
      text: "No delivery day falls inside the days the hotel will hold a box. Ask the front desk whether Thu, Mar 11 is all right, or use a pickup point.",
    });
  });

  it("a rental host who will hold a box makes the rental work like a hotel", () => {
    const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-19", service: "ups_ground", property: { confirmed: true, holdDays: 3 } });
    expect(dates(plan)).toEqual(["2026-12-17", "2026-12-08", "2026-12-14"]);
    expect(step(plan, "window")).toBe(`Your host said they can hold a box for 3 days, so it should arrive Dec 16${EN_DASH}18.`);
    expect(codes(plan)).not.toContain("host_consent_needed");
    expect(plan.fee).toBeNull();
  });

  it("a rental host who says yes without a hold window keeps delivery on or after check-in", () => {
    const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-19", service: "ups_ground", property: { confirmed: true } });
    expect(plan.targetDeliveryDate).toBe("2026-12-21");
    expect(codes(plan)).not.toContain("host_consent_needed");
    const viaStay = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-12-19", service: "ups_ground", property: { accepts: true } });
    expect(codes(viaStay)).not.toContain("host_consent_needed");
  });

  it("a property that said no is an alert, with the way out", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-16", service: "ups_ground", property: { accepts: false } });
    expect(plan.warnings[0]).toEqual({
      code: "property_declined",
      level: "alert",
      text: "The hotel said it won't accept packages. Send it to a pickup point nearby instead.",
    });
    expect(codes(plan)).not.toContain("ask_property_first");
  });

  it("accepts a stay's package policy or a shipment's property answers as they are stored", () => {
    const packagePolicy = { accepts: true, holdDays: 7, feePerBox: { amount: 0, currency: "USD" }, receivingAddress: "Dock B", contact: "Sam" };
    const plan = shipByPlan({ destination: "resort", arrivalDate: "2027-03-16", service: "ups_ground", property: packagePolicy });
    expect(plan.earliestAcceptableDate).toBe("2027-03-09");
    expect(plan.fee?.text).toBe("The resort doesn't charge to receive a box.");
  });

  it("ignores a nonsense hold window", () => {
    const usual = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-16", service: "ups_ground" });
    const bad = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-16", service: "ups_ground", property: { holdDays: -4 } });
    expect(dates(bad)).toEqual(dates(usual));
  });

  it("takes an explicit buffer", () => {
    const plan = shipByPlan({ destination: "relative_home", arrivalDate: "2027-03-16", service: "ups_ground", zone: 4, bufferDays: 1 });
    expect(plan.targetDeliveryDate).toBe("2027-03-15");
  });
});

describe("how far it is going", () => {
  it("uses the postal codes when both are US ZIP codes", () => {
    const near = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", originPostalCode: "55401", destinationPostalCode: "55105" });
    expect(near.transit).toMatchObject({ zone: 3, zoneBasis: "postal_codes", planDays: 2 });
    expect(step(near, "transit")).toBe("UPS Ground takes about 2 business days within Minnesota. That is an estimate, not a promise.");
    const far = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", originPostalCode: "55401", destinationPostalCode: "32801" });
    expect(far.transit).toMatchObject({ zone: 6, zoneBasis: "postal_codes", planDays: 4 });
    expect(step(far, "transit")).toBe("UPS Ground takes about 4 business days from Minnesota to northern and central Florida. That is an estimate, not a promise.");
  });

  it("an explicit zone wins over the postal codes", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", zone: 2, originPostalCode: "98101", destinationPostalCode: "32801" });
    expect(plan.transit).toMatchObject({ zone: 2, zoneBasis: "given", planDays: 1 });
    expect(step(plan, "transit")).toBe("UPS Ground takes about 1 business day over this distance. That is an estimate, not a promise.");
  });

  it("plans for coast to coast when it does not know, and says so", () => {
    for (const input of [{}, { originPostalCode: "98101" }, { originPostalCode: "K1A 0B1", destinationPostalCode: "32801" }, { zone: 12 }, { zone: 2.5 }]) {
      const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", ...input });
      expect(plan.transit).toMatchObject({ zone: 8, zoneBasis: "assumed", planDays: 5 });
      expect(step(plan, "transit")).toBe(
        "UPS Ground can take up to 5 business days coast to coast. Add both ZIP codes for a closer estimate. That is an estimate, not a promise.",
      );
    }
  });

  it("Alaska, Hawaii and Puerto Rico take longer, by ground and by Priority Mail", () => {
    const ground = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "fedex_ground", originPostalCode: "55401", destinationPostalCode: "99501" });
    expect(ground.transit).toMatchObject({ zone: 9, planDays: 7, bestDays: 5 });
    expect(step(ground, "transit")).toBe("FedEx Ground takes about 7 business days from Minnesota to Alaska. That is an estimate, not a promise.");
    const priority = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-15", service: "usps_priority_mail", originPostalCode: "55401", destinationPostalCode: "96815" });
    expect(priority.transit).toMatchObject({ zone: 9, planDays: 5, bestDays: 3, zoneBasis: "postal_codes" });
    expect(step(priority, "transit")).toBe("USPS Priority Mail takes about 5 delivery days from Minnesota to Hawaii.");
    // Only the destination known, and it is offshore.
    const oneEnd = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", destinationPostalCode: "00901" });
    expect(oneEnd.transit).toMatchObject({ zone: 9, planDays: 7 });
    expect(step(oneEnd, "transit")).toBe("UPS Ground takes about 7 business days to or from Alaska, Hawaii and the islands. That is an estimate, not a promise.");
  });

  it("services that do not depend on distance ignore the zone", () => {
    const a = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_2nd_day_air", zone: 2 });
    const b = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_2nd_day_air", zone: 8 });
    expect(dates(a)).toEqual(dates(b));
    expect(a.transit).toMatchObject({ zone: null, zoneBasis: "not_used" });
    expect(step(a, "transit")).toBe("UPS 2nd Day Air takes 2 business days.");
  });

  it("looks up transit days directly", () => {
    expect(transitDaysFor("ups_ground", 8)).toEqual({ best: 4, plan: 5 });
    expect(transitDaysFor("ups_ground")).toEqual({ best: 4, plan: 5 });
    expect(transitDaysFor("usps_ground_advantage", 9)).toEqual({ best: 5, plan: 8 });
    expect(transitDaysFor("usps_priority_mail", 9)).toEqual({ best: 3, plan: 5 });
    expect(transitDaysFor("usps_priority_mail", 5)).toEqual({ best: 2, plan: 3 });
    expect(transitDaysFor("fedex_overnight", 9)).toEqual({ best: 1, plan: 1 });
    expect(transitDaysFor("ups_ground", 42)).toEqual({ best: 4, plan: 5 });
  });
});

describe("international", () => {
  it("adds 2 days of arrival buffer and customs padding by service", () => {
    const express = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_worldwide_express" });
    expect(express.transit).toMatchObject({ customsDays: 1, planDays: 3, bestDays: 1 });
    const postal = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "usps_priority_mail_intl" });
    expect(postal.transit).toMatchObject({ customsDays: 2, planDays: 10 });
    // Hotel: 2 + 2 business days before a Wed arrival would be Thu Mar 11, earlier than the 3-day window.
    expect(express.targetDeliveryDate).toBe("2027-03-15");
  });

  it("in peak season pads 2 days even for express, because nothing international is quick then", () => {
    const plan = shipByPlan({ destination: "resort", arrivalDate: "2026-12-21", service: "ups_worldwide_express" });
    expect(plan.transit).toMatchObject({ customsDays: 1, peakDays: 2 });
    expect(step(plan, "padding")).toBe("Add 1 business day for customs and 2 for peak season, when the holidays slow every carrier down.");
    expect(plan.summary.startsWith("UPS Worldwide Express, 3 business days plus 1 for customs and 2 for peak season.")).toBe(true);
  });

  it("treats an international service as international without being told", () => {
    const told = shipByPlan({ destination: "resort", arrivalDate: "2027-02-20", service: "fedex_intl_economy", international: true });
    const notTold = shipByPlan({ destination: "resort", arrivalDate: "2027-02-20", service: "fedex_intl_economy", international: false });
    expect(dates(told)).toEqual(dates(notTold));
  });

  it("warns when a domestic service is chosen for a trip abroad, and pads anyway", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-15", service: "ups_ground", international: true });
    expect(plan.transit.customsDays).toBe(2);
    expect(plan.warnings.find((w) => w.code === "service_not_international")).toEqual({
      code: "service_not_international",
      level: "caution",
      text: "UPS Ground doesn't cross borders. Pick an international service to get dates you can rely on.",
    });
  });
});

describe("today", () => {
  const base: ShipByInput = { destination: "hotel", arrivalDate: "2026-12-19", service: "fedex_ground", zone: 8 };

  it("says nothing about today when today is not given", () => {
    const plan = shipByPlan(base);
    expect(codes(plan)).not.toContain("ship_by_passed");
    expect(codes(plan)).not.toContain("ship_by_today");
    expect(plan.fasterOption).toBeNull();
  });

  it("on the ship-by date itself: a nudge to go today", () => {
    const plan = shipByPlan({ ...base, today: "2026-12-08" });
    expect(plan.shipByDate).toBe("2026-12-08");
    expect(plan.warnings[0]).toEqual({
      code: "ship_by_today",
      level: "caution",
      text: "Today is the last safe day to send this by FedEx Ground. Hand it over before about 3 pm.",
    });
  });

  it("after the ship-by date: the next faster service that still works", () => {
    const plan = shipByPlan({ ...base, today: "2026-12-14" });
    expect(plan.fasterOption).toEqual({
      service: "fedex_2day", serviceName: "FedEx 2Day", shipByDate: "2026-12-14", targetDeliveryDate: "2026-12-17",
    });
    expect(plan.warnings[0]).toEqual({
      code: "ship_by_passed",
      level: "alert",
      text: "The safe day to send this by FedEx Ground was Tue, Dec 8. FedEx 2Day still works if you ship by Mon, Dec 14.",
    });
    // The dates themselves do not move because today moved.
    expect(dates(plan)).toEqual(dates(shipByPlan(base)));
  });

  it("looks at other carriers when its own has nothing left", () => {
    // Wed Nov 25, a rental check-in on Mon Nov 30. FedEx is on modified service on the 25th, so
    // its overnight needed Tue Nov 24. UPS still picks up today.
    const plan = shipByPlan({ destination: "vacation_rental", arrivalDate: "2026-11-30", service: "fedex_overnight", today: "2026-11-25" });
    expect(plan.shipByDate).toBe("2026-11-24");
    expect(plan.fasterOption).toEqual({
      service: "ups_next_day_air", serviceName: "UPS Next Day Air", shipByDate: "2026-11-25", targetDeliveryDate: "2026-11-30",
    });
    expect(plan.warnings[0].text).toBe(
      "The safe day to send this by FedEx Standard Overnight was Tue, Nov 24. UPS Next Day Air still works if you ship by Wed, Nov 25.",
    );
  });

  it("never suggests another carrier for a pickup point that only takes its own", () => {
    const plan = shipByPlan({ destination: "fedex_hold_at_location", arrivalDate: "2026-12-01", service: "fedex_overnight", today: "2026-11-25" });
    expect(compareDates(plan.shipByDate, "2026-11-25")).toBe(-1);
    expect(plan.fasterOption === null || SERVICES[plan.fasterOption.service].provider === "fedex").toBe(true);
  });

  it("after the safe date but before the cutting-it-close date, with nothing faster: says it might still make it", () => {
    // UPS Next Day Air to a hotel arriving Wed Dec 23: safe Thu Dec 17, cutting close Mon Dec 21.
    const plan = shipByPlan({ destination: "ups_access_point", arrivalDate: "2026-12-23", service: "ups_next_day_air", today: "2026-12-21" });
    expect(plan.shipByDate).toBe("2026-12-18");
    expect(plan.latestRiskyDate).toBe("2026-12-21");
    expect(plan.fasterOption).toBeNull();
    expect(plan.warnings[0].text).toBe(
      "The safe day to send this by UPS Next Day Air was Fri, Dec 18. Sent by Mon, Dec 21, it can still make it if nothing goes wrong.",
    );
  });

  it("when nothing can make it: a pickup point, or buy it there", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2026-11-30", service: "ups_ground", today: "2026-11-29" });
    expect(plan.fasterOption).toBeNull();
    expect(plan.warnings[0].text).toBe(
      "The safe day to send this by UPS Ground was Tue, Nov 17. Nothing gets it to the hotel in time now. Send it to a pickup point near where you're staying, or buy it there.",
    );
  });

  it("moves the ask-the-property reminder to today when five days before has passed", () => {
    expect(shipByPlan({ ...base, today: "2026-11-27" }).reminders.askPropertyOn).toBe("2026-12-03");
    expect(shipByPlan({ ...base, today: "2026-12-06" }).reminders.askPropertyOn).toBe("2026-12-06");
    expect(shipByPlan(base).reminders).toEqual({ askPropertyOn: "2026-12-03", packOn: "2026-12-07", checkArrivedOn: "2026-12-18" });
  });
});

describe("warnings for where it is going", () => {
  it("a cruise goes to the hotel the night before, never the terminal", () => {
    const plan = shipByPlan({ destination: "cruise_precruise_hotel", arrivalDate: "2027-03-10", service: "ups_ground", zone: 5 });
    expect(dates(plan)).toEqual(["2027-03-08", "2027-03-03", "2027-03-05"]);
    expect(plan.warnings.find((w) => w.code === "cruise_terminal")).toEqual({
      code: "cruise_terminal",
      level: "info",
      text: "Never send anything to the cruise terminal: it has nowhere to keep it. This goes to your hotel the night before. To have bags waiting in your cabin, use a luggage service that delivers to the ship.",
    });
  });

  it("a conference venue charges by weight and may refuse a heavy box", () => {
    const plan = shipByPlan({
      destination: "conference_venue", arrivalDate: "2027-03-15", service: "fedex_ground", zone: 4,
      parcels: [{ weight: { value: 60, unit: "lb" } }, { weight: { value: 12, unit: "lb" } }],
    });
    expect(plan.warnings[0]).toEqual({
      code: "heavy_box",
      level: "caution",
      text: "Over 50 lb, conference hotels and venues often charge more or turn the box away. Split it in two if you can.",
    });
    expect(plan.fee?.text).toBe("Conference hotels and venues usually charge by weight, about $1.35 a pound, with a $10 minimum: about $81 for a 60 lb box.");
    expect(plan.fee?.perBox).toEqual({ amount: 8100, currency: "USD" });
    expect(step(plan, "window")).toBe(`Conference hotels and venues usually hold a box for 3 days, so it should arrive Mar 12${EN_DASH}14.`);
  });

  it("weighs kilograms too, and does not warn at exactly 50 lb", () => {
    const heavy = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-15", service: "ups_ground", parcels: [{ weight: { value: 25, unit: "kg" } }] });
    expect(codes(heavy)).toContain("heavy_box");
    const fine = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-15", service: "ups_ground", parcels: [{ weight: { value: 50, unit: "lb" } }, {}] });
    expect(codes(fine)).not.toContain("heavy_box");
    // A home does not mind a heavy box.
    const home = shipByPlan({ destination: "relative_home", arrivalDate: "2027-03-15", service: "ups_ground", parcels: [{ weight: { value: 70, unit: "lb" } }] });
    expect(codes(home)).not.toContain("heavy_box");
  });

  it("pickup points only take their own carrier", () => {
    const generalDelivery = shipByPlan({ destination: "usps_general_delivery", arrivalDate: "2027-06-10", service: "ups_ground" });
    expect(generalDelivery.warnings[0]).toEqual({ code: "carrier_mismatch", level: "caution", text: "Only USPS delivers to General Delivery. Pick a USPS service." });
    expect(step(generalDelivery, "window")).toBe(
      `Post offices keep General Delivery mail for up to 30 days. To leave room, it should arrive May 20 ${EN_DASH} Jun 9.`,
    );
    const accessPoint = shipByPlan({ destination: "ups_access_point", arrivalDate: "2027-06-10", service: "fedex_ground" });
    expect(accessPoint.warnings[0].text).toBe("Only UPS delivers to a UPS Access Point. Pick a UPS service.");
    const fedex = shipByPlan({ destination: "fedex_hold_at_location", arrivalDate: "2027-06-10", service: "usps_priority_mail" });
    expect(fedex.warnings[0].text).toBe("Only FedEx delivers to a FedEx location. Pick a FedEx service.");
    expect(step(fedex, "window")).toBe(`FedEx locations keep a package for 7 days, then send it back. To leave room, it should arrive Jun 6${EN_DASH}9.`);
    const right = shipByPlan({ destination: "ups_access_point", arrivalDate: "2027-04-09", service: "ups_ground", zone: 6 });
    expect(codes(right)).not.toContain("carrier_mismatch");
    expect(step(right, "window")).toBe(`UPS Access Points keep a package for 7 days, then send it back. To leave room, it should arrive Apr 4${EN_DASH}8.`);
    expect(right.reminders.askPropertyOn).toBeNull();
    expect(right.fee).toBeNull();
  });

  it("an Amazon Locker is only for Amazon orders, and holds for just 3 days", () => {
    const plan = shipByPlan({ destination: "amazon_locker", arrivalDate: "2027-06-10", service: "ups_ground" });
    expect(plan.targetDeliveryDate).toBe("2027-06-10");
    expect(plan.earliestAcceptableDate).toBe("2027-06-09");
    expect(step(plan, "window")).toBe(`Amazon Lockers keep a package for 3 days, then send it back. To leave room, it should arrive Jun 9${EN_DASH}10.`);
    expect(step(plan, "target")).toBe("Aim for Thu, Jun 10, the day you arrive.");
    expect(plan.warnings.find((w) => w.code === "amazon_orders_only")?.text).toBe(
      "Only Amazon orders can go to an Amazon Locker. Choose it as the delivery address when you order.",
    );
    const counter = shipByPlan({ destination: "amazon_counter", arrivalDate: "2027-06-10", service: "ups_ground" });
    expect(counter.warnings.find((w) => w.code === "amazon_orders_only")?.text).toBe(
      "Only Amazon orders can go to an Amazon Counter. Choose it as the delivery address when you order.",
    );
  });

  it("asks her to confirm a hotel's rules until she has", () => {
    const plan = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-16", service: "ups_ground" });
    expect(plan.warnings.find((w) => w.code === "ask_property_first")).toEqual({
      code: "ask_property_first",
      level: "info",
      text: "This uses what hotels usually allow. Ask the front desk to confirm before you ship.",
    });
    const confirmed = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-16", service: "ups_ground", property: { confirmed: true } });
    expect(codes(confirmed)).not.toContain("ask_property_first");
    const home = shipByPlan({ destination: "relative_home", arrivalDate: "2027-03-16", service: "ups_ground" });
    expect(codes(home)).not.toContain("ask_property_first");
  });

  it("puts the most serious warning first", () => {
    const plan = shipByPlan({
      destination: "hotel", arrivalDate: "2026-12-19", service: "fedex_ground", today: "2026-12-14",
      parcels: [{ weight: { value: 80, unit: "lb" } }],
    });
    expect(plan.warnings.map((w) => w.level)).toEqual(["alert", "caution", "info", "info"]);
    expect(codes(plan)).toEqual(["ship_by_passed", "heavy_box", "peak_season", "ask_property_first"]);
  });

  it("allows an extra day when bad weather is forecast", () => {
    const calm = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", zone: 4 });
    const storm = shipByPlan({ destination: "hotel", arrivalDate: "2027-03-17", service: "ups_ground", zone: 4, severeWeather: true });
    expect(calm.shipByDate).toBe("2027-03-10");
    expect(storm.shipByDate).toBe("2027-03-09");
    expect(storm.transit).toMatchObject({ weatherDays: 1, paddingDays: 1 });
    expect(step(storm, "padding")).toBe("Add 1 business day for bad weather.");
    expect(storm.summary).toBe("UPS Ground, 3 business days plus 1 for bad weather. Arrives Mon, Mar 15, 2 business days before you check in on Wed, Mar 17.");
  });
});

describe("handling fees", () => {
  it("hotels, resorts and the hotel before a cruise: about $10 a box", () => {
    for (const destination of ["hotel", "resort", "cruise_precruise_hotel"] as const) {
      const fee = handlingFeeEstimate(destination);
      expect(fee).toMatchObject({
        source: "typical",
        perBox: { amount: 1000, currency: "USD" },
        low: { amount: 0, currency: "USD" },
        high: { amount: 2500, currency: "USD" },
      });
    }
    expect(handlingFeeEstimate("hotel")?.text).toBe(
      "Hotels often charge about $10 a box to receive it, anywhere from nothing to $25. If it arrives before they are ready to hold it, storage can run about $25 a day.",
    );
    expect(handlingFeeEstimate("resort", { shipmentKind: "luggage" })?.text.startsWith("Resorts often charge about $10 a bag")).toBe(true);
  });

  it("conference venues: $1.35 a pound, at least $10, at most $135", () => {
    expect(handlingFeeEstimate("conference_venue")).toMatchObject({ perBox: null, low: { amount: 1000 }, high: { amount: 13500 } });
    expect(handlingFeeEstimate("conference_venue")?.text).toBe("Conference hotels and venues usually charge by weight, about $1.35 a pound, with a $10 minimum.");
    const light = handlingFeeEstimate("conference_venue", { parcels: [{ weight: { value: 5, unit: "lb" } }] });
    expect(light?.perBox).toEqual({ amount: 1000, currency: "USD" });
    const middling = handlingFeeEstimate("conference_venue", { parcels: [{ weight: { value: 20, unit: "lb" } }] });
    expect(middling?.perBox).toEqual({ amount: 2700, currency: "USD" });
    const huge = handlingFeeEstimate("conference_venue", { parcels: [{ weight: { value: 150, unit: "lb" } }] });
    expect(huge?.perBox).toEqual({ amount: 13500, currency: "USD" });
    const metric = handlingFeeEstimate("conference_venue", { parcels: [{ weight: { value: 10, unit: "kg" } }] });
    expect(metric?.perBox).toEqual({ amount: 2976, currency: "USD" });
    expect(metric?.text).toBe("Conference hotels and venues usually charge by weight, about $1.35 a pound, with a $10 minimum: about $29.76 for a 22 lb box.");
  });

  it("homes, rentals and pickup points charge nothing, unless she was told otherwise", () => {
    for (const destination of ["relative_home", "vacation_rental", "ups_access_point", "fedex_hold_at_location", "usps_general_delivery", "amazon_locker", "amazon_counter"] as const) {
      expect(handlingFeeEstimate(destination), destination).toBeNull();
    }
    expect(handlingFeeEstimate("vacation_rental", { property: { feePerBox: { amount: 500, currency: "USD" } } })?.text).toBe(
      "Your host charges $5 a box to receive it.",
    );
  });
});

describe("each speed, and what to store", () => {
  it("lists a carrier's services slowest first", () => {
    expect(servicesOf("ups")).toEqual(["ups_ground", "ups_3_day_select", "ups_2nd_day_air", "ups_next_day_air"]);
    expect(servicesOf("fedex")).toEqual(["fedex_ground", "fedex_express_saver", "fedex_2day", "fedex_overnight"]);
    expect(servicesOf("usps")).toEqual(["usps_ground_advantage", "usps_priority_mail", "usps_priority_mail_express"]);
    expect(servicesOf("ups", { international: true })).toEqual(["ups_worldwide_expedited", "ups_worldwide_express"]);
    expect(servicesOf("dhl")).toEqual([]);
    expect(servicesOf("dhl", { international: true })).toEqual(["dhl_express_worldwide"]);
    expect(servicesOf("lugless")).toEqual(["lugless_ground", "lugless_express"]);
    // To a home, FedEx Ground goes by its residential name.
    expect(servicesOf("fedex", { destination: "relative_home" })[0]).toBe("fedex_home_delivery");
    expect(servicesOf("fedex", { destination: "hotel" })[0]).toBe("fedex_ground");
    for (const provider of ["ups", "fedex", "usps", "dhl", "lugless", "luggage_forward", "luggage_free"] as const) {
      for (const international of [false, true]) {
        for (const service of servicesOf(provider, { international })) {
          expect(SERVICES[service].provider).toBe(provider);
          expect(SERVICES[service].international).toBe(international);
        }
      }
    }
  });

  it("marks the speeds that are already too late", () => {
    const options = shipByOptions({ destination: "hotel", arrivalDate: "2026-12-19", today: "2026-12-14" }, "fedex");
    expect(options.map((option) => [option.line, option.stillPossible])).toEqual([
      ["FedEx Ground: ship by Tue, Dec 8", false],
      ["FedEx Express Saver: ship by Fri, Dec 11", false],
      ["FedEx 2Day: ship by Mon, Dec 14", true],
      ["FedEx Standard Overnight: ship by Tue, Dec 15", true],
    ]);
  });

  it("defaults to the carrier the pickup point needs", () => {
    expect(shipByOptions({ destination: "usps_general_delivery", arrivalDate: "2027-06-10" }).map((o) => o.service)).toEqual([
      "usps_ground_advantage", "usps_priority_mail", "usps_priority_mail_express",
    ]);
    expect(shipByOptions({ destination: "fedex_hold_at_location", arrivalDate: "2027-06-10" })[0].service).toBe("fedex_ground");
    expect(shipByOptions({ destination: "hotel", arrivalDate: "2027-06-10", international: true }).map((o) => o.service)).toEqual([
      "ups_worldwide_expedited", "ups_worldwide_express",
    ]);
  });

  it("gives the stored fields in the shape the shipment details expect", () => {
    const plan = shipByPlan({
      destination: "vacation_rental", arrivalDate: "2026-12-19", service: "ups_ground",
      originPostalCode: "98101", destinationPostalCode: "32801", today: "2026-12-11",
    });
    const stored = shipByFieldsToStore(plan);
    expect(stored).toEqual({
      serviceKey: "ups_ground",
      targetDeliveryDate: "2026-12-21",
      shipByDate: "2026-12-10",
      latestRiskyDate: "2026-12-15",
      // "The ship-by date has passed" is left out: it would be stale tomorrow.
      warnings: [
        "Only send it to a rental if the host says yes in writing. If they say no, use a pickup point nearby.",
        "Peak season: 2 extra business days are built in, because carriers run slow from mid-November to early January.",
      ],
    });
    const parsed = shipmentDetailsSchema.safeParse({ kind: "shipment", destinationType: "vacation_rental", arrivalDate: "2026-12-19", ...stored });
    expect(parsed.success).toBe(true);
  });
});

describe("bad input", () => {
  it("throws a RangeError for a date that is not a date", () => {
    expect(() => shipByPlan({ destination: "hotel", arrivalDate: "next week", service: "ups_ground" })).toThrow(RangeError);
    expect(() => shipByPlan({ destination: "hotel", arrivalDate: "2026-02-30", service: "ups_ground" })).toThrow(RangeError);
    expect(() => shipByPlan({ destination: "hotel", arrivalDate: "2026-12-19", service: "ups_ground", today: "today" })).toThrow(RangeError);
  });
});

describe("every sentence, for every destination and service", () => {
  it("follows the wording rules and fits the stored fields", () => {
    const arrivals = ["2026-12-19", "2026-12-28", "2027-01-04", "2027-03-14", "2027-07-06", "2028-02-02"];
    const variants: Partial<ShipByInput>[] = [
      {},
      { today: "2026-12-20", shipmentKind: "luggage" },
      { property: { confirmed: true, holdDays: 0 } },
      { property: { accepts: false, holdDays: 4, feePerBox: { amount: 1250, currency: "USD" } }, severeWeather: true },
      { international: true, originPostalCode: "98101", destinationPostalCode: "96815", parcels: [{ weight: { value: 61, unit: "lb" } }] },
    ];
    let checked = 0;
    for (const destination of SHIPMENT_DESTINATION_TYPES) {
      for (const service of SERVICE_KEYS) {
        for (const arrivalDate of arrivals) {
          for (const variant of variants) {
            const plan = shipByPlan({ destination, arrivalDate, service, ...variant });
            const sentences = [
              ...plan.steps.map((s) => s.text),
              ...plan.warnings.map((w) => w.text),
              plan.summary,
              ...(plan.fee ? [plan.fee.text] : []),
            ];
            for (const text of sentences) {
              expect(copyProblems(text), text).toEqual([]);
              expect(isSentence(text), text).toBe(true);
              checked++;
            }
            for (const text of [plan.headline, ...(plan.cuttingItClose ? [plan.cuttingItClose] : [])]) {
              expect(copyProblems(text), text).toEqual([]);
            }
            expect(plan.steps.map((s) => s.key).slice(0, 4)).toEqual(["arrival", "window", "target", "transit"]);
            expect(plan.steps[plan.steps.length - 1].key).toBe("drop_off");
            const stored = shipByFieldsToStore(plan);
            expect(stored.warnings.length).toBeLessThanOrEqual(30);
            for (const warning of plan.warnings) expect(warning.text.length, warning.text).toBeLessThanOrEqual(300);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
  });
});

describe("the way home", () => {
  it("sends it on check-out day when the carrier collects that day", () => {
    const plan = returnPlan({ checkoutDate: "2027-03-19", service: "ups_2nd_day_air" });
    expect(plan).toEqual({
      service: "ups_2nd_day_air",
      serviceName: "UPS 2nd Day Air",
      shipOnDate: "2027-03-19",
      arrivesByDate: "2027-03-23",
      headline: "Send it home on Fri, Mar 19. Expect it by Tue, Mar 23",
      steps: [
        { key: "ship_on", text: "You check out on Fri, Mar 19, and UPS collects that day." },
        { key: "transit", text: "UPS 2nd Day Air takes about 2 business days." },
        { key: "arrives", text: "Counting forward from Fri, Mar 19, it should be home by Tue, Mar 23." },
      ],
    });
  });

  it("after Christmas, waits for the first pickup day and counts across New Year", () => {
    // Check out Sat Dec 26, Orlando back to Seattle by UPS Ground: 5 days + 2 for peak season.
    const plan = returnPlan({ checkoutDate: "2026-12-26", service: "ups_ground", originPostalCode: "32801", destinationPostalCode: "98101", shipmentKind: "gift" });
    expect(plan.shipOnDate).toBe("2026-12-28");
    // Dec 29, 30, then Dec 31 (air only) and Jan 1 (closed) are skipped: Jan 4, 5, 6, 7, 8.
    expect(plan.arrivesByDate).toBe("2027-01-08");
    expect(plan.steps.map((s) => s.text)).toEqual([
      "You check out on Sat, Dec 26. The first day UPS collects after that is Mon, Dec 28, so leave the box labeled and ready.",
      "UPS Ground takes about 5 business days, plus 2 for peak season.",
      "Counting forward from Mon, Dec 28, it should be home by Fri, Jan 8.",
    ]);
  });

  it("knows UPS will not pick up on Christmas Eve", () => {
    const plan = returnPlan({ checkoutDate: "2026-12-24", service: "ups_ground", zone: 2 });
    expect(plan.shipOnDate).toBe("2026-12-28");
    expect(plan.steps[0].text).toBe(
      "You check out on Thu, Dec 24 (Christmas Eve). The first day UPS collects after that is Mon, Dec 28, so leave the box labeled and ready.",
    );
  });

  it("USPS collects on a Saturday", () => {
    const plan = returnPlan({ checkoutDate: "2026-12-26", service: "usps_priority_mail" });
    expect(plan.shipOnDate).toBe("2026-12-26");
    // 3 days + 1 for peak season: Dec 28, 29, 30, 31.
    expect(plan.arrivesByDate).toBe("2026-12-31");
    expect(plan.steps[1].text).toBe("USPS Priority Mail takes about 3 delivery days, plus 1 for peak season.");
  });

  it("adds customs coming home from abroad", () => {
    const plan = returnPlan({ checkoutDate: "2027-02-26", service: "fedex_intl_economy" });
    expect(plan.shipOnDate).toBe("2027-02-26");
    // 5 days + 2 for customs from Fri Feb 26: Mar 1, 2, 3, 4, 5, 8, 9.
    expect(plan.arrivesByDate).toBe("2027-03-09");
    expect(plan.steps[1].text).toBe("FedEx International Economy takes about 5 business days, plus 2 for customs.");
  });

  it("always ships on a ship day and arrives on a delivery day, for every service", () => {
    for (const service of SERVICE_KEYS) {
      for (const checkoutDate of ["2026-11-25", "2026-11-26", "2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01", "2027-07-04", "2027-09-06"]) {
        const plan = returnPlan({ checkoutDate, service });
        expect(isShipDay(service, plan.shipOnDate), `${service} ${checkoutDate}`).toBe(true);
        expect(isDeliveryDay(service, plan.arrivesByDate), `${service} ${checkoutDate}`).toBe(true);
        expect(compareDates(plan.shipOnDate, checkoutDate)).toBeGreaterThanOrEqual(0);
        expect(compareDates(plan.arrivesByDate, plan.shipOnDate)).toBe(1);
        for (const sentence of plan.steps) {
          expect(copyProblems(sentence.text), sentence.text).toEqual([]);
          expect(isSentence(sentence.text), sentence.text).toBe(true);
        }
        expect(copyProblems(plan.headline)).toEqual([]);
      }
    }
  });
});
