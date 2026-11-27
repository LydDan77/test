import { describe, expect, it } from "vitest";
import { EN_DASH } from "@/lib/time";
import { DESTINATION_POLICIES } from "./config";
import { copyProblems, isSentence } from "./copy-check";
import { HOLD_MAIL_LIMITS, PICKUP_POINT_OPTIONS, USPS_MAIL_PRICES, mailOptions, pickupPointOption, pickupPointOptions } from "./pickup";

describe("pickup points", () => {
  it("lists the five, each with its hold limit, what it suits and a link", () => {
    expect(PICKUP_POINT_OPTIONS.map((option) => [option.name, option.holdDays, option.holdLimit])).toEqual([
      ["UPS Access Point", 7, "Held for 7 days, then sent back"],
      ["FedEx Hold at Location", 7, "Held up to 7 days at a store such as Walgreens, or 5 business days at FedEx Office, then sent back"],
      ["USPS General Delivery", 30, "Held for up to 30 days"],
      ["Amazon Locker", 3, "Held for 3 days, then returned for a refund"],
      ["Amazon Counter", 7, "Held for 7 days, then returned for a refund"],
    ]);
    for (const option of PICKUP_POINT_OPTIONS) {
      expect(new URL(option.url).protocol).toBe("https:");
      for (const text of [option.suits, option.rules]) {
        expect(copyProblems(text), text).toEqual([]);
        expect(isSentence(text), text).toBe(true);
      }
      expect(copyProblems(option.holdLimit)).toEqual([]);
      expect(copyProblems(option.linkLabel)).toEqual([]);
    }
  });

  it("agrees with the hold periods the date arithmetic uses", () => {
    for (const option of PICKUP_POINT_OPTIONS) {
      expect(DESTINATION_POLICIES[option.key].keptForDays, option.key).toBe(option.holdDays);
      // The planning window always leaves slack inside the hold period.
      expect(DESTINATION_POLICIES[option.key].holdDays).toBeLessThan(option.holdDays);
    }
  });

  it("says who can deliver to each", () => {
    expect(Object.fromEntries(PICKUP_POINT_OPTIONS.map((option) => [option.key, option.carrier]))).toEqual({
      ups_access_point: "ups", fedex_hold_at_location: "fedex", usps_general_delivery: "usps", amazon_locker: "amazon", amazon_counter: "amazon",
    });
    expect(pickupPointOption("usps_general_delivery").rules).toBe(
      "Free. Usually one post office in a city offers it, so phone to confirm. Bring government photo ID. UPS and FedEx can't deliver to it.",
    );
    expect(pickupPointOption("fedex_hold_at_location").url).toBe("https://www.fedex.com/en-us/shipping/hold-at-location.html");
  });

  it("offers carrier points for something she ships, and Amazon's for a store order", () => {
    expect(pickupPointOptions().map((option) => option.key)).toEqual(["ups_access_point", "fedex_hold_at_location", "usps_general_delivery"]);
    expect(pickupPointOptions({ retailOrder: false }).map((option) => option.key)).toEqual(["ups_access_point", "fedex_hold_at_location", "usps_general_delivery"]);
    expect(pickupPointOptions({ retailOrder: true }).map((option) => option.key)).toEqual(["amazon_locker", "amazon_counter"]);
  });
});

describe("mail while away", () => {
  it("without dates is a plain list of four", () => {
    const options = mailOptions();
    expect(options.map((option) => [option.key, option.name, option.limit, option.cost])).toEqual([
      ["hold_mail", "Hold your mail", `3${EN_DASH}30 days`, "Free"],
      ["premium_forwarding", "Forward your mail each week", "Billed by the week", "$26.40 to sign up online, then $29.70 a week"],
      ["general_delivery", "Have one item wait at a post office", "Held for up to 30 days", "Free"],
      ["informed_delivery", "See what is arriving at home", "No limit", "Free"],
    ]);
    for (const option of options) {
      expect(option.recommended).toBe(false);
      expect(option.forThisTrip).toBeNull();
      expect(option.remindOn).toBeNull();
      expect(new URL(option.url).hostname.endsWith("usps.com")).toBe(true);
      for (const text of [option.suits, option.how]) {
        expect(copyProblems(text), text).toEqual([]);
        expect(isSentence(text), text).toBe(true);
      }
    }
    expect(mailOptions(null)).toEqual(options);
  });

  it("a week away: hold the mail, and ask by the day before leaving", () => {
    const [hold, forwarding, generalDelivery, informed] = mailOptions({ leaveOn: "2026-12-19", returnOn: "2026-12-26", today: "2026-11-27" });
    expect(hold.recommended).toBe(true);
    expect(hold.forThisTrip).toBe(`USPS can hold your mail Dec 19${EN_DASH}25. Ask any time from Nov 27, and no later than the day before you leave.`);
    expect(hold.remindOn).toBe("2026-12-12");
    expect(forwarding.recommended).toBe(false);
    expect(forwarding.forThisTrip).toBeNull();
    expect(generalDelivery.recommended).toBe(false);
    expect(informed.forThisTrip).toBe("Worth turning on before you go: it takes about 3 days to start.");
    expect(informed.remindOn).toBe("2026-12-12");
  });

  it("requests open 30 days before leaving", () => {
    const [hold] = mailOptions({ leaveOn: "2027-03-15", returnOn: "2027-03-22", today: "2026-11-27" });
    expect(hold.forThisTrip).toBe(`USPS can hold your mail Mar 15${EN_DASH}21. Ask any time from Feb 13, and no later than the day before you leave.`);
    expect(hold.remindOn).toBe("2027-03-08");
  });

  it("the limits: 3 days is the least, 30 the most", () => {
    const at = (leaveOn: string, returnOn: string) => mailOptions({ leaveOn, returnOn })[0];
    expect(at("2027-03-01", "2027-03-03").recommended).toBe(false); // 2 days away
    expect(at("2027-03-01", "2027-03-03").forThisTrip).toBe("USPS only holds mail for 3 days or more. For a trip this short, ask a neighbor to bring it in.");
    expect(at("2027-03-01", "2027-03-04").recommended).toBe(true); // 3 days
    expect(at("2027-03-01", "2027-03-31").recommended).toBe(true); // 30 days
    expect(at("2027-03-01", "2027-04-01").recommended).toBe(false); // 31 days
    expect(at("2027-03-01", "2027-04-01").forThisTrip).toBe("USPS holds mail for 30 days at most, and you are away for 31. Use Premium Forwarding instead.");
    expect(HOLD_MAIL_LIMITS).toEqual({ minDays: 3, maxDays: 30, requestDaysAhead: 30 });
  });

  it("more than a month away: forward it, with the cost worked out", () => {
    const [hold, forwarding] = mailOptions({ leaveOn: "2027-01-10", returnOn: "2027-03-01", today: "2026-11-27" });
    expect(hold.recommended).toBe(false);
    expect(forwarding.recommended).toBe(true);
    // 50 days is 8 weekly boxes: $26.40 + 8 × $29.70 = $264.
    expect(forwarding.forThisTrip).toBe("You are away 50 days, too long for a mail hold. Forwarding for 8 weeks costs about $264.");
    expect(forwarding.remindOn).toBe("2026-12-27");
    expect(USPS_MAIL_PRICES.premiumForwardingEnrollmentOnline + 8 * USPS_MAIL_PRICES.premiumForwardingPerWeek).toBe(26400);
  });

  it("holds across the year boundary", () => {
    const [hold] = mailOptions({ leaveOn: "2026-12-28", returnOn: "2027-01-04" });
    expect(hold.forThisTrip).toBe(`USPS can hold your mail Dec 28, 2026 ${EN_DASH} Jan 3, 2027. Ask any time from Nov 28, and no later than the day before you leave.`);
  });

  it("never sets a reminder in the past", () => {
    const [hold, , , informed] = mailOptions({ leaveOn: "2026-12-19", returnOn: "2026-12-26", today: "2026-12-17" });
    expect(hold.remindOn).toBe("2026-12-17");
    expect(informed.remindOn).toBe("2026-12-17");
    expect(hold.forThisTrip).toContain("Ask any time from Dec 17");
  });

  it("treats dates the wrong way round as no dates", () => {
    const options = mailOptions({ leaveOn: "2026-12-26", returnOn: "2026-12-19" });
    expect(options.every((option) => !option.recommended && option.forThisTrip === null)).toBe(true);
  });

  it("every trip sentence follows the wording rules", () => {
    for (const [leaveOn, returnOn] of [["2026-12-19", "2026-12-20"], ["2026-12-19", "2026-12-26"], ["2026-12-19", "2027-02-26"], ["2026-12-19", "2026-12-19"]]) {
      for (const option of mailOptions({ leaveOn, returnOn, today: "2026-11-27" })) {
        if (option.forThisTrip) {
          expect(copyProblems(option.forThisTrip), option.forThisTrip).toEqual([]);
          expect(isSentence(option.forThisTrip), option.forThisTrip).toBe(true);
        }
      }
    }
  });
});
