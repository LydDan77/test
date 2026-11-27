import { describe, expect, it } from "vitest";
import { TRACKING_CARRIERS, TRACKING_LINKS } from "./config";
import {
  detectCarrier,
  findTrackingNumbers,
  isTrackingCarrier,
  normalizeTrackingNumber,
  trackingLink,
  trackingUrl,
} from "./tracking";
import { TRACKING_VECTORS, TRACKING_VECTOR_COUNT } from "./tracking.vectors";
import { carrierName } from "./words";

const summary = (raw: string) =>
  detectCarrier(raw).candidates.map((c) => [c.carrier, c.format, c.confidence, c.checkDigit]);

describe("the 97 published test numbers", () => {
  // The same pass rule as the reference's tracking.test.mjs.
  const expected: Record<string, string | null> = {
    ups: "ups", fedex: "fedex", usps: "usps", dhl: "dhl", amazon: "amazon", ontrac: "ontrac", s10: null,
  };

  it("has all 97 vectors", () => {
    const counted = TRACKING_VECTORS.reduce((sum, set) => sum + set.valid.length + set.invalid.length, 0);
    expect(counted).toBe(97);
    expect(TRACKING_VECTOR_COUNT).toBe(97);
  });

  for (const set of TRACKING_VECTORS) {
    const carrier = expected[set.courier];
    for (const number of set.valid) {
      it(`recognises ${set.format}: ${JSON.stringify(number)}`, () => {
        const found = detectCarrier(number);
        expect(found.best).not.toBeNull();
        expect(found.best?.checkDigit).not.toBe("fail");
        if (carrier) expect(found.candidates.map((c) => c.carrier)).toContain(carrier);
      });
    }
    for (const number of set.invalid) {
      it(`does not trust invalid ${set.format}: ${JSON.stringify(number)}`, () => {
        // An invalid number must never be accepted with high confidence for the same carrier.
        const trusted = detectCarrier(number).candidates.filter(
          (c) => c.checkDigit === "pass" && c.confidence === "high" && (!carrier || c.carrier === carrier),
        );
        expect(trusted).toEqual([]);
      });
    }
  }
});

describe("the reference's printed examples", () => {
  it("gives the same carriers, formats and confidence as tracking.test.out", () => {
    expect(summary("1Z999AA10123456784")).toEqual([["ups", "UPS 1Z", "high", "pass"]]);
    expect(summary("9400111899562537866361")).toEqual([["usps", "USPS IMpb 22", "high", "pass"]]);
    expect(summary("9400 1000 0000 0000 0000 00")).toEqual([]);
    expect(summary("RB123456785GB")[0]).toEqual(["royalmail", "UPU S10 (RB...GB)", "high", "pass"]);
    expect(summary("LK461754867HK")[0]).toEqual(["other", "UPU S10 (LK...HK)", "high", "pass"]);
    expect(summary("TBA305477112000")).toEqual([["amazon", "Amazon Logistics", "high", "none"]]);
    expect(summary("1LSCZM300293DG8")).toEqual([["ontrac", "OnTrac (LaserShip 1LS)", "high", "none"]]);
    expect(summary("C11286171075072")).toEqual([["ontrac", "OnTrac C+14", "high", "pass"]]);
    expect(summary("D10000000000000")).toEqual([["ontrac", "OnTrac D+14", "medium", "none"]]);
    expect(summary("EA123456784US")).toEqual([["usps", "UPU S10 (EA...US)", "low", "fail"]]);
    expect(summary("7316123456789012")).toEqual([["canadapost", "Canada Post 16-digit", "medium", "none"]]);
    expect(summary("1234567890")).toEqual([["dhl", "DHL Express waybill (check failed)", "low", "fail"]]);
  });

  it("builds the UPS link from a number typed with spaces and lower case", () => {
    expect(trackingUrl("ups", "1z 999 aa1 01 2345 678 4")).toBe(
      "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784",
    );
  });
});

describe("normalizeTrackingNumber", () => {
  it("upper-cases and strips everything that is not a letter or digit", () => {
    expect(normalizeTrackingNumber(" 1z 999-aa1.01 2345 678 4\n")).toBe("1Z999AA10123456784");
    expect(normalizeTrackingNumber("9400 1112 0108 0805 4830 16")).toBe("9400111201080805483016");
    expect(normalizeTrackingNumber("")).toBe("");
    expect(normalizeTrackingNumber(null)).toBe("");
    expect(normalizeTrackingNumber(undefined)).toBe("");
    expect(normalizeTrackingNumber(986578788855)).toBe("986578788855");
  });
});

describe("detectCarrier", () => {
  it("returns the normalized number, the best candidate and its link", () => {
    const found = detectCarrier("1z 999 aa1 01 2345 678 4");
    expect(found.number).toBe("1Z999AA10123456784");
    expect(found.best).toMatchObject({
      carrier: "ups", carrierName: "UPS", confidence: "high", checkDigit: "pass",
      url: "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784",
    });
    expect(found.needsConfirmation).toBe(false);
    expect(found.message).toBeNull();
    expect(found.suggestions).toEqual([]);
    expect(found.looksLikeCardNumber).toBe(false);
  });

  it("says nothing and finds nothing for an empty box", () => {
    for (const empty of ["", "   ", null, undefined, "---"]) {
      const found = detectCarrier(empty);
      expect(found.candidates).toEqual([]);
      expect(found.best).toBeNull();
      expect(found.needsConfirmation).toBe(false);
      expect(found.message).toBeNull();
    }
  });

  it("explains an unknown shape instead of guessing", () => {
    const found = detectCarrier("HELLO-WORLD-42");
    expect(found.best).toBeNull();
    expect(found.needsConfirmation).toBe(false);
    expect(found.message).toBe("No carrier uses a number shaped like this. Check it, or save it and pick the carrier yourself.");
  });

  it("refuses placeholders that pass a check digit by accident", () => {
    expect(detectCarrier("9400 1000 0000 0000 0000 00").candidates).toEqual([]);
    expect(detectCarrier("000000000000").candidates).toEqual([]);
    expect(detectCarrier("111111111111").candidates).toEqual([]);
    expect(detectCarrier("9600000000000000000001").candidates).toEqual([]);
  });

  describe("the shapes several carriers share: she confirms", () => {
    it("12 digits that pass FedEx's check: probably FedEx, still asks", () => {
      const found = detectCarrier("986578788855");
      expect(found.candidates.map((c) => c.carrier)).toEqual(["fedex", "ups", "canadapost"]);
      expect(found.best).toMatchObject({ carrier: "fedex", confidence: "high", checkDigit: "pass" });
      expect(found.needsConfirmation).toBe(true);
      expect(found.message).toBe("This looks like a FedEx number. Is that right?");
    });

    it("12 digits that fail FedEx's check: offers UPS and Canada Post", () => {
      const found = detectCarrier("996578788855");
      expect(found.candidates.map((c) => c.carrier)).toEqual(["ups", "canadapost"]);
      expect(found.needsConfirmation).toBe(true);
      expect(found.message).toBe("The number alone doesn't say who is carrying this. Is it UPS or Canada Post?");
    });

    it("10 digits: DHL only with her say-so, even when mod 7 passes", () => {
      const pass = detectCarrier("3318810025");
      expect(pass.best).toMatchObject({ carrier: "dhl", confidence: "high", checkDigit: "pass" });
      expect(pass.needsConfirmation).toBe(true);
      expect(pass.message).toBe("This looks like a DHL number. Is that right?");

      const fail = detectCarrier("3318810010");
      expect(fail.best).toMatchObject({ carrier: "dhl", confidence: "low", checkDigit: "fail" });
      expect(fail.needsConfirmation).toBe(true);
      expect(fail.message).toBe("This looks like a DHL number, but one character seems off. Check it against your receipt.");
    });

    it("a valid DHL waybill never ends in 7, 8 or 9", () => {
      for (const ending of ["7", "8", "9"]) {
        expect(detectCarrier(`331881002${ending}`).best?.checkDigit).toBe("fail");
      }
    });

    it("9 digits: UPS or DHL, a guess either way", () => {
      const found = detectCarrier("123456789");
      expect(found.candidates.map((c) => [c.carrier, c.confidence])).toEqual([["ups", "low"], ["dhl", "low"]]);
      expect(found.needsConfirmation).toBe(true);
      expect(found.message).toBe("The number alone doesn't say who is carrying this. Is it UPS or DHL?");
    });

    it("11 digits: DHL when mod 7 passes, nothing when it fails", () => {
      const pass = detectCarrier("73891051146");
      expect(pass.best).toMatchObject({ carrier: "dhl", confidence: "medium" });
      expect(pass.needsConfirmation).toBe(true);
      expect(pass.message).toBe("This could be a DHL number. Is DHL carrying it?");
      expect(detectCarrier("73891051149").candidates).toEqual([]);
    });

    it("16 digits: Canada Post, always confirmed", () => {
      const found = detectCarrier("7316123456789012");
      expect(found.best).toMatchObject({ carrier: "canadapost", confidence: "medium", checkDigit: "none" });
      expect(found.needsConfirmation).toBe(true);
      expect(found.looksLikeCardNumber).toBe(false);
    });

    it("16 digits that pass the card test: warns that it looks like a card number", () => {
      const found = detectCarrier("4111 1111 1111 1111");
      expect(found.looksLikeCardNumber).toBe(true);
      expect(found.needsConfirmation).toBe(true);
      expect(found.message).toBe("This looks like a card number, not a tracking number. Check what you pasted.");
    });
  });

  describe("20 and 22 digits: USPS or FedEx", () => {
    it("20 digits where the plain check passes is USPS", () => {
      const found = detectCarrier("0307 1790 0005 2348 3741");
      expect(found.candidates.map((c) => c.carrier)).toEqual(["usps"]);
      expect(found.needsConfirmation).toBe(false);
    });

    it("20 digits where only the 92 check passes is FedEx, and USPS tracks it as 92 + the number", () => {
      const found = detectCarrier("61299998820821171811");
      expect(found.candidates.map((c) => [c.carrier, c.confidence])).toEqual([["fedex", "high"], ["usps", "medium"]]);
      expect(found.candidates[1].number).toBe("9261299998820821171811");
      expect(found.candidates[1].url).toBe("https://tools.usps.com/go/TrackConfirmAction?tLabels=9261299998820821171811");
      expect(found.needsConfirmation).toBe(false);
    });

    it("the two 20-digit checks can never both pass", () => {
      // Prepending 92 shifts the check digit by a constant, so a number is one or the other.
      for (const body of ["0307179000052348374", "6129999882082117181", "7112345678912345678", "1234567890123456789"]) {
        const passes = [...Array(10).keys()].map((d) => detectCarrier(body + d).candidates.filter((c) => c.confidence === "high"));
        for (const high of passes) expect(high.length).toBeLessThanOrEqual(1);
      }
    });

    it("20 digits where nothing passes: a likely typo", () => {
      const found = detectCarrier("0307 1790 0005 2348 3744");
      expect(found.best).toMatchObject({ carrier: "usps", confidence: "low", checkDigit: "fail" });
      expect(found.needsConfirmation).toBe(true);
    });

    it("22 digits starting 92 default to USPS and offer FedEx", () => {
      const found = detectCarrier("9261292700768711948021");
      expect(found.candidates.map((c) => [c.carrier, c.confidence])).toEqual([["usps", "high"], ["fedex", "low"]]);
      expect(found.needsConfirmation).toBe(false);
    });

    it("22 digits: the prefix decides between FedEx Ground (96) and USPS (91 to 95)", () => {
      expect(detectCarrier("9611020987654312345672").best?.carrier).toBe("fedex");
      expect(detectCarrier("9405803699300124287899").best?.carrier).toBe("usps");
      expect(detectCarrier("9705803699300124287899").candidates).toEqual([]);
    });

    it("34 digits: 420 is USPS, anything else must pass FedEx's check", () => {
      expect(detectCarrier("4201002334249200190132607600833457").best?.carrier).toBe("usps");
      expect(detectCarrier("1001921334250001000300779017972697").best).toMatchObject({ carrier: "fedex", format: "FedEx Express 34" });
      expect(detectCarrier("9622001900000000000000776632517510").best).toMatchObject({ carrier: "fedex", format: "FedEx Ground GSN 34" });
      expect(detectCarrier("1001901781990001000300617767839438").candidates).toEqual([]);
    });
  });

  describe("UPS 1Z numbers", () => {
    it("flags a failed check digit as a typo and offers the fix", () => {
      // The real number is 1Z999AA10123456784; here the 0 was typed as the letter O.
      const found = detectCarrier("1Z999AA1O123456784");
      expect(found.best).toMatchObject({ carrier: "ups", confidence: "low", checkDigit: "fail" });
      expect(found.needsConfirmation).toBe(true);
      expect(found.suggestions).toContain("1Z999AA10123456784");
      expect(found.message).toBe("This looks like a UPS number with a typo. Did you mean 1Z999AA10123456784?");
    });

    it("has no suggestion when no single swap fixes it", () => {
      const found = detectCarrier("1Z1111111111111111");
      expect(found.best?.checkDigit).toBe("fail");
      expect(found.suggestions.every((s) => detectCarrier(s).best?.checkDigit === "pass")).toBe(true);
      if (found.suggestions.length === 0) {
        expect(found.message).toBe("This looks like a UPS number, but one character seems off. Check it against your receipt.");
      }
    });

    it("needs a digit in the last place", () => {
      expect(detectCarrier("1Z999AA1012345678A").best?.checkDigit).toBe("fail");
    });

    it("is not confused with an 18-digit FedEx SSCC number", () => {
      expect(detectCarrier("00 0123 4500 0000 0027").best).toMatchObject({ carrier: "fedex", confidence: "medium" });
      expect(detectCarrier("000000000000000001").candidates).toEqual([]);
    });
  });

  describe("international postal numbers (S10)", () => {
    it("picks the post from the country suffix", () => {
      expect(detectCarrier("RB123456785US").best).toMatchObject({ carrier: "usps", carrierName: "USPS" });
      expect(detectCarrier("RB123456785GB").best).toMatchObject({ carrier: "royalmail", carrierName: "Royal Mail" });
      expect(detectCarrier("RB123456785CA").best).toMatchObject({ carrier: "canadapost", carrierName: "Canada Post" });
    });

    it("names another country's post and cannot link to it", () => {
      const found = detectCarrier("LK461754867HK");
      expect(found.best).toMatchObject({ carrier: "other", carrierName: "Hongkong Post", url: null, postCountryCode: "HK" });
      expect(detectCarrier("RB123456785CV").best).toMatchObject({ carrier: "other", carrierName: "The post in CV" });
    });

    it("offers USPS as the second link for a foreign number heading to the US", () => {
      const found = detectCarrier("RB123456785GB");
      expect(found.candidates.map((c) => c.carrier)).toEqual(["royalmail", "usps"]);
      expect(found.candidates[1]).toMatchObject({ confidence: "medium", url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=RB123456785GB" });
      expect(detectCarrier("RB123456785GB", { destinationCountryCode: "FR" }).candidates.map((c) => c.carrier)).toEqual(["royalmail"]);
      // A US number needs no second link.
      expect(detectCarrier("RB123456785US").candidates.map((c) => c.carrier)).toEqual(["usps"]);
    });

    it("rejects a wrong check digit and a country that does not exist", () => {
      expect(detectCarrier("RB123456786US").best).toMatchObject({ confidence: "low", checkDigit: "fail" });
      expect(detectCarrier("RB123456785XX").best).toMatchObject({ confidence: "low", checkDigit: "fail" });
      expect(detectCarrier("RB123456786US").needsConfirmation).toBe(true);
    });
  });

  describe("other prefixes", () => {
    it("recognises Amazon, OnTrac, FedEx door tags, UPS T numbers and DHL piece IDs", () => {
      expect(detectCarrier("TBA502887274000").best).toMatchObject({ carrier: "amazon", confidence: "high" });
      expect(detectCarrier("TBC502887274000").best?.carrier).toBe("amazon");
      expect(detectCarrier("TBB000000000000").candidates).toEqual([]);
      expect(detectCarrier("C11031500001879").best).toMatchObject({ carrier: "ontrac", confidence: "high", checkDigit: "pass" });
      expect(detectCarrier("C11031500001889").best).toMatchObject({ carrier: "ontrac", confidence: "medium", checkDigit: "fail" });
      expect(detectCarrier("DT123456789012").best).toMatchObject({ carrier: "fedex", confidence: "high" });
      expect(detectCarrier("T9999999999").best).toMatchObject({ carrier: "ups", confidence: "medium" });
      expect(detectCarrier("JJD0099999999").best).toMatchObject({ carrier: "dhl", confidence: "medium" });
      expect(detectCarrier("JD014600003216598765").best).toMatchObject({ carrier: "dhl", confidence: "medium" });
    });

    it("asks her to confirm anything that is only a medium match", () => {
      expect(detectCarrier("T9999999999").needsConfirmation).toBe(true);
      expect(detectCarrier("T9999999999").message).toBe("This could be a UPS number. Is UPS carrying it?");
    });
  });

  describe("when she has already picked the carrier", () => {
    it("puts her carrier first and stops asking", () => {
      const found = detectCarrier("996578788855", { preferCarrier: "canadapost" });
      expect(found.best?.carrier).toBe("canadapost");
      expect(found.needsConfirmation).toBe(false);
      expect(found.message).toBeNull();
    });

    it("still asks when her carrier cannot be the one", () => {
      const found = detectCarrier("986578788855", { preferCarrier: "usps" });
      expect(found.best?.carrier).toBe("fedex");
      expect(found.needsConfirmation).toBe(true);
    });

    it("still flags a failed check digit", () => {
      const found = detectCarrier("1Z999AA1O123456784", { preferCarrier: "ups" });
      expect(found.needsConfirmation).toBe(true);
    });
  });
});

describe("trackingUrl and trackingLink", () => {
  it("has a link for each of the eight carriers", () => {
    expect(trackingUrl("ups", "1Z999AA10123456784")).toBe("https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784");
    expect(trackingUrl("fedex", "986578788855")).toBe("https://www.fedex.com/fedextrack/?trknbr=986578788855");
    expect(trackingUrl("usps", "9400 1118 9956 2537 8663 61")).toBe("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899562537866361");
    expect(trackingUrl("dhl", "3318810025")).toBe("https://www.dhl.com/us-en/home/tracking.html?tracking-id=3318810025&submit=1");
    expect(trackingUrl("amazon", "TBA305477112000")).toBe("https://track.amazon.com/tracking/TBA305477112000");
    expect(trackingUrl("ontrac", "C11286171075072")).toBe("https://www.ontrac.com/tracking/?number=C11286171075072");
    expect(trackingUrl("canadapost", "7316123456789012")).toBe("https://www.canadapost-postescanada.ca/track-reperage/en/details/7316123456789012");
    expect(trackingUrl("royalmail", "RB123456785GB")).toBe("https://www.royalmail.com/portal/rm/track?trackNumber=RB123456785GB");
  });

  it("is null for a carrier without a tracking page, or with no number", () => {
    expect(trackingUrl("lugless", "ABC123")).toBeNull();
    expect(trackingUrl("other", "ABC123")).toBeNull();
    expect(trackingUrl(null, "1Z999AA10123456784")).toBeNull();
    expect(trackingUrl(undefined, "1Z999AA10123456784")).toBeNull();
    expect(trackingUrl("ups", "")).toBeNull();
    expect(trackingUrl("ups", "  - ")).toBeNull();
    expect(trackingUrl("toString", "1Z999AA10123456784")).toBeNull();
  });

  it("cannot be made to point anywhere else by what is pasted", () => {
    const url = trackingUrl("ups", "1Z999&next=https://evil.example/?x=<script>");
    expect(url).toBe("https://www.ups.com/track?loc=en_US&tracknum=1Z999NEXTHTTPSEVILEXAMPLEXSCRIPT");
  });

  it("gives the button its words and a fallback page", () => {
    expect(trackingLink("fedex", "986578788855")).toEqual({
      url: "https://www.fedex.com/fedextrack/?trknbr=986578788855",
      label: "Track on FedEx",
      fallbackUrl: "https://www.fedex.com/fedextrack/",
    });
    expect(trackingLink("royalmail", "RB123456785GB")?.label).toBe("Track on Royal Mail");
    expect(trackingLink("send_my_bag", "X")).toBeNull();
  });

  it("every template is https, on the carrier's own site, with one {n}", () => {
    for (const carrier of TRACKING_CARRIERS) {
      const link = TRACKING_LINKS[carrier];
      expect(link.template.startsWith("https://")).toBe(true);
      expect(link.fallback.startsWith("https://")).toBe(true);
      expect(link.template.split("{n}").length).toBe(2);
      expect(new URL(link.fallback).hostname.split(".").slice(-2).join(".")).toBe(
        new URL(link.template.replace("{n}", "1")).hostname.split(".").slice(-2).join("."),
      );
    }
  });
});

describe("carrier names", () => {
  it("names every carrier and luggage service", () => {
    expect(carrierName("ups")).toBe("UPS");
    expect(carrierName("fedex")).toBe("FedEx");
    expect(carrierName("usps")).toBe("USPS");
    expect(carrierName("dhl")).toBe("DHL");
    expect(carrierName("amazon")).toBe("Amazon");
    expect(carrierName("ontrac")).toBe("OnTrac");
    expect(carrierName("canadapost")).toBe("Canada Post");
    expect(carrierName("royalmail")).toBe("Royal Mail");
    expect(carrierName("lugless")).toBe("LugLess");
    expect(carrierName("luggage_forward")).toBe("Luggage Forward");
    expect(carrierName("shipgo")).toBe("ShipGo");
    expect(carrierName("luggage_free")).toBe("Luggage Free");
    expect(carrierName("send_my_bag")).toBe("Send My Bag");
  });

  it("falls back for anything unknown, including object property names", () => {
    expect(carrierName("other")).toBe("Another carrier");
    expect(carrierName("pony express")).toBe("Another carrier");
    expect(carrierName(null)).toBe("Another carrier");
    expect(carrierName(undefined)).toBe("Another carrier");
    expect(carrierName("constructor")).toBe("Another carrier");
  });

  it("knows which values are trackable carriers", () => {
    expect(isTrackingCarrier("ups")).toBe(true);
    expect(isTrackingCarrier("lugless")).toBe(false);
    expect(isTrackingCarrier(42)).toBe(false);
  });
});

describe("findTrackingNumbers", () => {
  it("finds a UPS number in a sentence", () => {
    const found = findTrackingNumbers("Your package is on its way. Tracking number: 1Z999AA10123456784. Thanks for shipping with us.");
    expect(found.map((f) => [f.number, f.best?.carrier])).toEqual([["1Z999AA10123456784", "ups"]]);
  });

  it("reads a number written in groups as one number", () => {
    const found = findTrackingNumbers("USPS Tracking 9400 1118 9956 2537 8663 61 expected Monday");
    expect(found.map((f) => [f.number, f.best?.carrier])).toEqual([["9400111899562537866361", "usps"]]);
  });

  it("accepts a 12-digit number only when the carrier is named nearby", () => {
    expect(findTrackingNumbers("Order 986578788855 confirmed")).toEqual([]);
    const named = findTrackingNumbers("Shipped with FedEx, tracking 986578788855");
    expect(named.map((f) => [f.number, f.best?.carrier, f.needsConfirmation])).toEqual([["986578788855", "fedex", false]]);
  });

  it("ignores phone numbers and card numbers", () => {
    expect(findTrackingNumbers("Call us at 612-555-0100 or 6125550100 about your order.")).toEqual([]);
    expect(findTrackingNumbers("Paid with card 4111 1111 1111 1111 via Canada Post")).toEqual([]);
  });

  it("accepts a DHL waybill when DHL is named", () => {
    const found = findTrackingNumbers("DHL Express waybill 3318810025");
    expect(found.map((f) => f.best?.carrier)).toEqual(["dhl"]);
  });

  it("finds several numbers once each, in order", () => {
    const text = "Box 1: 1Z999AA10123456784\nBox 2: TBA305477112000\nBox 1 again: 1Z999AA10123456784";
    expect(findTrackingNumbers(text).map((f) => f.number)).toEqual(["1Z999AA10123456784", "TBA305477112000"]);
  });

  it("finds a number that follows another number-like word", () => {
    const found = findTrackingNumbers("Ref 2026 1Z999AA10123456784 UPS GROUND");
    expect(found.map((f) => f.number)).toEqual(["1Z999AA10123456784"]);
  });

  it("reads a UPS number typed in groups", () => {
    const found = findTrackingNumbers("tracking: 1Z 999 AA1 01 2345 678 4");
    expect(found.map((f) => f.number)).toEqual(["1Z999AA10123456784"]);
  });

  it("returns nothing for text with no numbers", () => {
    expect(findTrackingNumbers("")).toEqual([]);
    expect(findTrackingNumbers("See you at the lake house on Saturday.")).toEqual([]);
  });
});
