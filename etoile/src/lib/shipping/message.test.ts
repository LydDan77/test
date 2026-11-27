import { describe, expect, it } from "vitest";
import { SHIPMENT_DESTINATION_TYPES } from "@/lib/domain";
import { copyProblems } from "./copy-check";
import { labelBlock } from "./label";
import {
  PROPERTY_CHECKLIST,
  confirmReceiptMessage,
  mailtoUrl,
  propertyMessage,
  questionsToAsk,
  type PropertyMessageInput,
} from "./message";

const label = labelBlock({
  destination: "hotel", recipientName: "Lydia Hartley", arrivalDate: "2026-12-23", propertyName: "Grand Floridian",
  reservationNumber: "84412907", phone: "612-555-0100", parcelNumber: 1, parcelCount: 2,
  place: { addressLines: ["4401 Floridian Way"], locality: "Orlando", region: "FL", postalCode: "32830" },
});

const hotelInput: PropertyMessageInput = {
  destination: "hotel",
  guestName: "Lydia Hartley",
  arrivalDate: "2026-12-23",
  departureDate: "2026-12-26",
  reservationNumber: "84412907",
  parcelCount: 2,
  contentsSummary: "clothing",
  weightEachLb: 20,
  carrier: "ups",
  targetDeliveryDate: "2026-12-21",
  labelLines: label.lines,
  phone: "612-555-0100",
};

describe("the note to a hotel", () => {
  const note = propertyMessage(hotelInput);

  it("is written, start to finish", () => {
    expect(note?.audience).toBe("hotel");
    expect(note?.subject).toBe("Package for guest Lydia Hartley, arriving Dec 23 (confirmation 84412907)");
    expect(note?.body).toBe(
      [
        "Hello,",
        "",
        "I have a reservation under Lydia Hartley (confirmation 84412907), arriving Wed, Dec 23 and leaving Sat, Dec 26. I'd like to send 2 boxes ahead (clothing, about 20 lb each) with UPS. They should reach you around Mon, Dec 21.",
        "",
        "Could you let me know:",
        "1. Do you accept packages for guests who have not arrived yet?",
        "2. How early can it arrive, and is there a storage charge if it comes sooner?",
        "3. Is there a handling fee per box?",
        "4. What exact address should I use (front desk, package room or receiving dock)?",
        "5. Who should I address it to, and how should the label read?",
        "",
        "I plan to address it like this:",
        "  Lydia Hartley",
        "  c/o Grand Floridian",
        "  HOLD FOR GUEST, ARRIVING DEC 23, 2026",
        "  CONF 84412907",
        "  4401 Floridian Way",
        "  Orlando, FL 32830",
        "  BOX 1 OF 2, PHONE 612-555-0100",
        "",
        "I'll send the tracking number once they ship. Thank you.",
        "",
        "Lydia Hartley",
        "612-555-0100",
      ].join("\n"),
    );
  });

  it("has a short version for a chat box", () => {
    expect(note?.short).toBe(
      "Hello, I'm Lydia Hartley, checking in Wed, Dec 23 (confirmation 84412907). May I send 2 boxes ahead to arrive around Mon, Dec 21? " +
        "Could you tell me whether you accept packages, how early they can arrive, whether there is a fee, and the exact address and name to put on the label? " +
        "I'll share the tracking number when they ship. Thank you.",
    );
    expect(note?.short).not.toContain("\n");
  });

  it("asks the five things the report says to ask", () => {
    expect(note?.questions.map((q) => q.key)).toEqual(["accepts", "how_early", "fee", "address", "addressee"]);
    for (const question of note?.questions ?? []) expect(note?.body).toContain(question.text);
  });

  it("works with only a name and a date", () => {
    const bare = propertyMessage({ destination: "hotel", guestName: "Lydia Hartley", arrivalDate: "2026-12-23" });
    expect(bare?.subject).toBe("Package for guest Lydia Hartley, arriving Dec 23");
    expect(bare?.body.split("\n")[2]).toBe("I have a reservation under Lydia Hartley, arriving Wed, Dec 23. I'd like to send a box ahead.");
    expect(bare?.body).not.toContain("I plan to address it");
    expect(bare?.body.endsWith("I'll send the tracking number once it ships. Thank you.\n\nLydia Hartley")).toBe(true);
    expect(bare?.short).toContain("May I send a box ahead?");
  });

  it("says bag for luggage and names one weight without 'each'", () => {
    const bags = propertyMessage({ ...hotelInput, shipmentKind: "luggage", parcelCount: 1, contentsSummary: null, weightEachLb: 42.4 });
    expect(bags?.body).toContain("I'd like to send a bag ahead (about 42 lb) with UPS. It should reach you around Mon, Dec 21.");
  });

  it("a resort and the hotel before a cruise get the same note", () => {
    expect(propertyMessage({ ...hotelInput, destination: "resort" })?.body).toBe(note?.body);
    expect(propertyMessage({ ...hotelInput, destination: "cruise_precruise_hotel" })?.audience).toBe("hotel");
  });

  it("never leaves a blank where her name should be", () => {
    const nameless = propertyMessage({ ...hotelInput, guestName: "  " });
    expect(nameless?.subject).toContain("[Your name]");
  });
});

describe("the note to a conference venue", () => {
  it("mentions the event and asks about fees by weight", () => {
    const note = propertyMessage({ destination: "conference_venue", guestName: "Lydia Hartley", arrivalDate: "2027-03-14", eventName: "the Marketing Summit", parcelCount: 3 });
    expect(note?.audience).toBe("venue");
    expect(note?.body.split("\n")[2]).toBe("I have a reservation under Lydia Hartley, arriving Sun, Mar 14 for the Marketing Summit. I'd like to send 3 boxes ahead.");
    expect(note?.body).toContain("3. Is there a handling fee, and is it charged per box or by weight?");
    expect(note?.body).toContain("4. What exact address should I use (business center, package room or receiving dock)?");
  });
});

describe("the note to a rental host", () => {
  const note = propertyMessage({
    destination: "vacation_rental", guestName: "Lydia Hartley", arrivalDate: "2026-12-19", hostName: "Marta",
    parcelCount: 2, shipmentKind: "gift", targetDeliveryDate: "2026-12-21",
  });

  it("asks permission first and promises nobody has to be there early", () => {
    expect(note?.audience).toBe("rental_host");
    expect(note?.subject).toBe("Sending 2 boxes ahead for my stay from Dec 19");
    expect(note?.body).toBe(
      [
        "Hi Marta,",
        "",
        "This is Lydia Hartley. I'm checking in on Sat, Dec 19. Would it be all right if I sent 2 boxes ahead? They would arrive on or after check-in day, around Mon, Dec 21, so nobody needs to be there early.",
        "",
        "Could you let me know:",
        "1. Is it all right with you to have a package delivered there?",
        "2. How early is too early for it to arrive?",
        "3. Is there any fee?",
        "4. What exact address should I use?",
        "5. Whose name should go on the label?",
        "",
        "I'll share the tracking number when they ship. Thank you.",
        "",
        "Lydia Hartley",
      ].join("\n"),
    );
    expect(note?.short).toBe(
      "Hi Marta, this is Lydia Hartley, checking in Sat, Dec 19. Would it be all right if I sent 2 boxes ahead, to arrive on or after check-in day, around Mon, Dec 21? " +
        "What address and name should I use, how early is too early, and is there any fee? I'll share the tracking number when they ship. Thank you.",
    );
  });

  it("greets plainly when the host's name is not known", () => {
    const anonymous = propertyMessage({ destination: "vacation_rental", guestName: "Lydia Hartley", arrivalDate: "2026-12-19", reservationNumber: "HMABC123" });
    expect(anonymous?.body.startsWith("Hi,\n\nThis is Lydia Hartley. I'm checking in on Sat, Dec 19 (reservation HMABC123).")).toBe(true);
    expect(anonymous?.short.startsWith("Hi, this is Lydia Hartley, checking in Sat, Dec 19 (reservation HMABC123).")).toBe(true);
  });
});

describe("the note to a relative", () => {
  const note = propertyMessage({
    destination: "relative_home", guestName: "Lydia", arrivalDate: "2026-12-24", hostName: "Mom", shipmentKind: "luggage", targetDeliveryDate: "2026-12-21",
  });

  it("is warm, and does not ask family about a fee", () => {
    expect(note?.audience).toBe("relative");
    expect(note?.subject).toBe("Sending a bag ahead of my visit");
    expect(note?.body).toBe(
      [
        "Hi Mom,",
        "",
        "I'd like to send a bag ahead so it's waiting when I get there on Thu, Dec 24. It should reach you around Mon, Dec 21.",
        "",
        "Could you let me know:",
        "1. Is it all right to send it to your place?",
        "2. How early is fine for it to show up?",
        "3. What is the best address to use?",
        "4. Whose name should I put on the label?",
        "",
        "I'll send you the tracking number when it ships. Thank you.",
        "",
        "Lydia",
      ].join("\n"),
    );
    expect(note?.questions.map((q) => q.key)).toEqual(["accepts", "how_early", "address", "addressee"]);
    expect(note?.short).toBe(
      "Hi Mom, I'd like to send a bag ahead so it's waiting when I get there on Thu, Dec 24. It should reach you around Mon, Dec 21. " +
        "Is that all right, and what address and name should I use? I'll send the tracking number when it ships. Thank you.",
    );
  });

  it("reads right with several boxes and no date yet", () => {
    const several = propertyMessage({ destination: "relative_home", guestName: "Lydia", arrivalDate: "2026-12-24", parcelCount: 3 });
    expect(several?.short).toBe(
      "Hi, I'd like to send 3 boxes ahead so they're waiting when I get there on Thu, Dec 24. " +
        "Is that all right, and what address and name should I use? I'll send the tracking number when they ship. Thank you.",
    );
  });
});

describe("where there is nobody to ask", () => {
  it("returns null for every pickup point", () => {
    for (const destination of ["ups_access_point", "fedex_hold_at_location", "usps_general_delivery", "amazon_locker", "amazon_counter"] as const) {
      expect(propertyMessage({ ...hotelInput, destination })).toBeNull();
      expect(questionsToAsk(destination)).toEqual([]);
      expect(confirmReceiptMessage({ destination, guestName: "Lydia", arrivalDate: "2026-12-23" })).toBeNull();
    }
  });

  it("gives the questions for the others", () => {
    expect(questionsToAsk("hotel")).toHaveLength(5);
    expect(questionsToAsk("vacation_rental").map((q) => q.key)).toContain("fee");
    expect(questionsToAsk("relative_home").map((q) => q.key)).not.toContain("fee");
  });
});

describe("the nine-point checklist", () => {
  it("has nine questions, each a real question", () => {
    expect(PROPERTY_CHECKLIST).toHaveLength(9);
    expect(new Set(PROPERTY_CHECKLIST.map((item) => item.key)).size).toBe(9);
    for (const item of PROPERTY_CHECKLIST) {
      expect(item.question.includes("?")).toBe(true);
      expect(copyProblems(item.question), item.question).toEqual([]);
    }
  });
});

describe("mailtoUrl", () => {
  const note = propertyMessage(hotelInput)!;

  it("opens her mail with the subject and body filled in", () => {
    const url = mailtoUrl(note, "frontdesk@example.com");
    expect(url.startsWith("mailto:frontdesk@example.com?subject=Package%20for%20guest%20Lydia%20Hartley")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("mailto:");
    expect(parsed.searchParams.get("subject")).toBe(note.subject);
    expect(parsed.searchParams.get("body")).toBe(note.body);
  });

  it("leaves the address empty when it is not known or not an address", () => {
    expect(mailtoUrl(note).startsWith("mailto:?subject=")).toBe(true);
    expect(mailtoUrl(note, null).startsWith("mailto:?subject=")).toBe(true);
    expect(mailtoUrl(note, "front desk").startsWith("mailto:?subject=")).toBe(true);
    // Nothing typed as an address can add headers of its own.
    const sneaky = mailtoUrl(note, "a@example.com?bcc=evil@example.com&body=x");
    expect(sneaky.startsWith("mailto:?subject=")).toBe(true);
    expect(sneaky).not.toContain("bcc=");
  });

  it("keeps awkward characters in the note intact", () => {
    const odd = { subject: "Box & bag: 50% \"fragile\"?", body: "Line one\nLine two & three #4" };
    const parsed = new URL(mailtoUrl(odd, "desk@example.com"));
    expect(parsed.searchParams.get("subject")).toBe(odd.subject);
    expect(parsed.searchParams.get("body")).toBe(odd.body);
  });
});

describe("confirmReceiptMessage", () => {
  it("asks the hotel to confirm it has the boxes", () => {
    expect(confirmReceiptMessage({ destination: "hotel", guestName: "Lydia Hartley", arrivalDate: "2026-12-23", reservationNumber: "84412907", carrier: "ups", parcelCount: 2 })).toBe(
      "Hello, this is Lydia Hartley, arriving Wed, Dec 23 (confirmation 84412907). UPS shows my 2 boxes were delivered to you. Could you confirm you have them? Thank you.",
    );
  });

  it("asks a relative more gently", () => {
    expect(confirmReceiptMessage({ destination: "relative_home", guestName: "Lydia", arrivalDate: "2026-12-23", hostName: "Mom" })).toBe(
      "Hi Mom, this is Lydia. Tracking shows my box was delivered. Could you let me know it arrived safely? Thank you.",
    );
    expect(confirmReceiptMessage({ destination: "vacation_rental", guestName: "Lydia", arrivalDate: "2026-12-23", parcelCount: 2, shipmentKind: "luggage", carrier: "fedex" })).toBe(
      "Hi, this is Lydia. FedEx shows my 2 bags were delivered. Could you let me know they arrived safely? Thank you.",
    );
  });
});

describe("every note", () => {
  it("follows the wording rules: polite, plain, no exclamation marks", () => {
    for (const destination of SHIPMENT_DESTINATION_TYPES) {
      for (const parcelCount of [1, 4]) {
        const note = propertyMessage({ ...hotelInput, destination, parcelCount, hostName: "Marta", eventName: "the Summit" });
        if (!note) continue;
        for (const text of [note.subject, note.short, ...note.body.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("  "))]) {
          expect(copyProblems(text.trim()), text).toEqual([]);
        }
        expect(note.body).toContain("Thank you.");
        expect(note.short.endsWith("Thank you.")).toBe(true);
        expect(note.short.length).toBeLessThan(500);
        const receipt = confirmReceiptMessage({ destination, guestName: "Lydia", arrivalDate: "2026-12-23", parcelCount });
        if (receipt) expect(copyProblems(receipt), receipt).toEqual([]);
      }
    }
  });
});
