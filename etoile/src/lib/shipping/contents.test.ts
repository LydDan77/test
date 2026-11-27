import { describe, expect, it } from "vitest";
import { CONTENT_FLAGS, type ContentFlag } from "@/lib/domain";
import { EN_DASH } from "@/lib/time";
import { SERVICE_KEYS, type ServiceKey } from "./config";
import { contentsWarnings, customsNotes, hasBlockedContents, suggestContentFlags, type ContentsItem } from "./contents";
import { copyProblems, isSentence } from "./copy-check";

const item = (description: string, ...flags: ContentFlag[]): ContentsItem => ({ description, flags });
const one = (items: ContentsItem[], service: ServiceKey | null, international = false, options = {}) =>
  contentsWarnings(items, service, international, options);
const brief = (items: ContentsItem[], service: ServiceKey | null, international = false, options = {}) =>
  one(items, service, international, options).map((w) => `${w.level}: ${w.title}`);

describe("nothing restricted", () => {
  it("has no warnings", () => {
    expect(one([], "ups_ground")).toEqual([]);
    expect(one([item("Sweaters"), item("Wrapped gifts"), { description: "Books" }], "ups_ground")).toEqual([]);
    expect(hasBlockedContents([])).toBe(false);
  });
});

describe("prescription medication", () => {
  it("is blocked however it travels: only a pharmacy can mail it", () => {
    for (const service of ["ups_ground", "usps_priority_mail", "fedex_overnight", "fedex_intl_economy", null] as const) {
      const [warning] = one([item("Blood pressure pills", "medication")], service);
      expect(warning).toEqual({
        flag: "medication",
        level: "block",
        title: "Prescription medication",
        text: "You can't mail prescription medication yourself. Only a pharmacy or doctor can send it to a patient.",
        instead: "Carry it with you, or ask your pharmacy to mail a refill to where you're staying.",
        items: ["Blood pressure pills"],
      });
    }
  });

  it("over-the-counter medicine is allowed, with a caution", () => {
    const [warning] = one([item("Vitamins and ibuprofen", "medication")], "ups_ground");
    expect(warning).toMatchObject({
      level: "warn",
      title: "Over-the-counter medicine",
      text: "Over-the-counter medicine can go in its original packaging. Send My Bag takes no medicine at all.",
      instead: "If it matters for the trip, carry it with you.",
    });
  });

  it("anything unclear, or marked prescription, is treated as prescription", () => {
    expect(brief([item("Medicine bag", "medication")], "ups_ground")).toEqual(["block: Prescription medication"]);
    expect(brief([item("Prescription vitamins", "medication")], "ups_ground")).toEqual(["block: Prescription medication"]);
    expect(brief([item("Insulin", "medication"), item("Tylenol", "medication")], "ups_ground")).toEqual([
      "block: Prescription medication",
      "warn: Over-the-counter medicine",
    ]);
  });
});

describe("alcohol", () => {
  it("is always blocked, with the way to do it properly", () => {
    for (const service of ["ups_ground", "usps_ground_advantage", "ups_next_day_air", "ups_worldwide_express", null] as const) {
      const [warning] = one([item("2 bottles of wine", "alcohol")], service);
      expect(warning).toEqual({
        flag: "alcohol",
        level: "block",
        title: "Alcohol",
        text: "You can't ship beer, wine or spirits yourself. USPS won't carry them, and UPS and FedEx take them only from licensed sellers.",
        instead: "Have the shop or winery ship it (an adult has to sign for it), or buy it when you get there.",
        items: ["2 bottles of wine"],
      });
    }
  });
});

describe("lithium batteries", () => {
  it("loose batteries and power banks are blocked by air, express and abroad", () => {
    for (const service of ["ups_2nd_day_air", "fedex_overnight", "usps_priority_mail", "ups_3_day_select"] as const) {
      expect(one([item("Power bank", "lithium")], service)[0]).toMatchObject({
        level: "block",
        title: "Loose batteries and power banks",
        text: "Loose lithium batteries and power banks can't go by air or express.",
        instead: "Carry them on the plane in your hand luggage.",
      });
    }
    expect(one([item("Spare batteries", "lithium")], "fedex_intl_economy")[0]).toMatchObject({
      level: "block",
      text: "Loose lithium batteries and power banks can't be sent abroad at all.",
    });
    expect(one([item("Power bank", "lithium")], "ups_ground", true)[0].level).toBe("block");
  });

  it("loose batteries may go by ground within the US, with conditions", () => {
    expect(one([item("Power bank", "lithium")], "ups_ground")[0]).toEqual({
      flag: "lithium",
      level: "warn",
      title: "Loose batteries and power banks",
      text: "Loose lithium batteries and power banks can only travel by ground inside the US. Tape over the contacts and pack them in a rigid box.",
      instead: "It is simpler to carry them on the plane in your hand luggage.",
      items: ["Power bank"],
    });
    expect(one([item("Power bank", "lithium")], null)[0].text).toBe(
      "Loose lithium batteries and power banks can only travel by ground inside the US, so pick a ground service. Tape over the contacts and pack them in a rigid box.",
    );
  });

  it("a device with its battery inside is allowed by ground, and steered off air", () => {
    expect(one([item("Laptop", "lithium")], "fedex_ground")[0]).toMatchObject({
      level: "warn",
      title: "Devices with lithium batteries",
      text: "A device with its battery inside can go by ground. Use a rigid box and mark it as holding a lithium battery. Loose batteries and power banks are different: those can't go by air at all.",
      instead: "Anything you can't be without, carry with you.",
    });
    expect(one([item("Camera", "lithium")], "ups_next_day_air")[0].text).toBe(
      "A device with its battery inside should go by ground, not by air or express. Choose a ground service. Loose batteries and power banks are different: those can't go by air at all.",
    );
    expect(one([item("Camera", "lithium")], "ups_next_day_air")[0].level).toBe("warn");
  });

  it("abroad, only with the battery installed", () => {
    expect(one([item("Tablet", "lithium")], "usps_priority_mail_intl")[0].text).toBe(
      "Abroad, a device may go only with its battery installed, and USPS allows at most two batteries in a box. Ask the carrier before you pay. Loose batteries and power banks are different: those can't go by air at all.",
    );
  });

  it("by ground to Alaska, Hawaii or Puerto Rico is not allowed", () => {
    const text = one([item("Laptop", "lithium")], "ups_ground", false, { offshore: true })[0].text;
    expect(text).toContain("Ground parcels with lithium batteries can't go to Alaska, Hawaii, Puerto Rico or other islands.");
    expect(one([item("Laptop", "lithium")], "ups_ground")[0].text).not.toContain("Alaska");
  });

  it("tells a power bank from a laptop by the description, and gives both when both are there", () => {
    expect(brief([item("Laptop", "lithium"), item("Power bank", "lithium")], "ups_2nd_day_air")).toEqual([
      "block: Loose batteries and power banks",
      "warn: Devices with lithium batteries",
    ]);
    // "Camera with spare battery" is a device first.
    expect(brief([item("Camera and batteries", "lithium")], "ups_ground")).toEqual(["warn: Devices with lithium batteries"]);
    // Nothing to go on: assume a device, and the text still names the exception.
    expect(brief([item("Electronics", "lithium")], "ups_2nd_day_air")).toEqual(["warn: Devices with lithium batteries"]);
  });
});

describe("aerosols and flammables", () => {
  it("by ground within the US: allowed, limited", () => {
    expect(one([item("Hairspray", "aerosol")], "ups_ground")[0]).toEqual({
      flag: "aerosol",
      level: "warn",
      title: "Aerosols and flammables",
      text: "Aerosols, perfume, nail polish and lighters can only go by ground. Keep each container to 1 liter or less and ask the clerk to mark the box Limited Quantity.",
      instead: "It is easier to buy toiletries when you arrive.",
      items: ["Hairspray"],
    });
  });

  it("by air, express or abroad: blocked", () => {
    expect(one([item("Hairspray", "aerosol")], "usps_priority_mail")[0]).toMatchObject({
      level: "block",
      text: "Aerosols, perfume, nail polish and lighters can't go by air or express.",
      instead: "Buy toiletries when you arrive, or have them delivered there.",
    });
    expect(one([item("Perfume", "aerosol")], "luggage_forward_intl_standard")[0]).toMatchObject({
      level: "block",
      text: "Aerosols, perfume, nail polish and lighters can't be sent abroad. Send My Bag bans all liquids and gels on international routes too.",
    });
  });
});

describe("perishables", () => {
  it("are blocked to a hotel or a pickup point: nothing there is refrigerated", () => {
    for (const destination of ["hotel", "resort", "conference_venue", "ups_access_point"] as const) {
      expect(one([item("Smoked salmon", "perishable")], "ups_next_day_air", false, { destination })[0]).toEqual({
        flag: "perishable",
        level: "block",
        title: "Food and other perishables",
        text: "Don't send perishables ahead. It would sit in a package room with no refrigeration, possibly for days.",
        instead: "Order groceries or a meal for the evening you arrive instead.",
        items: ["Smoked salmon"],
      });
    }
  });

  it("to a home, overnight only, early in the week", () => {
    const overnight = one([item("Cheese", "perishable")], "fedex_overnight", false, { destination: "relative_home" })[0];
    expect(overnight).toMatchObject({
      level: "warn",
      text: "Perishables go at your own risk: carriers don't refrigerate and don't pay for spoilage. Ship Monday to Wednesday, never just before a holiday, and make sure someone is home.",
      instead: "Or order groceries or a meal to arrive the evening you do.",
    });
    const undecided = one([item("Cheese", "perishable")], null, false, { destination: "relative_home" })[0];
    expect(undecided.level).toBe("warn");
    expect(undecided.text).toContain("Send them overnight only.");
    // Ground to a home is still a no.
    expect(one([item("Cheese", "perishable")], "ups_ground", false, { destination: "relative_home" })[0]).toMatchObject({
      level: "block",
      text: "Don't send perishables ahead. It would sit unrefrigerated for days, and carriers don't pay for spoilage.",
    });
  });

  it("are blocked abroad and when the destination is not known", () => {
    expect(one([item("Cake", "perishable")], "ups_worldwide_express", true, { destination: "relative_home" })[0]).toMatchObject({
      level: "block",
      text: "Don't send perishables ahead. Perishables can't be sent abroad, and dry ice is banned on international mail.",
    });
    expect(one([item("Cake", "perishable")], "fedex_overnight")[0].level).toBe("block");
    expect(one([item("Cake", "perishable")], "fedex_overnight", false, { destination: "vacation_rental" })[0].level).toBe("block");
  });
});

describe("valuables", () => {
  it("are a caution: keep them with you", () => {
    expect(one([item("Grandma's ring", "valuable")], "ups_ground")[0]).toEqual({
      flag: "valuable",
      level: "warn",
      title: "Valuables",
      text: `Cash, jewelry, passports and anything you can't replace are safer with you. Included cover is usually only $500${EN_DASH}$1,000 a bag, and more costs extra.`,
      instead: "Keep them in your hand luggage.",
      items: ["Grandma's ring"],
    });
  });
});

describe("a whole box", () => {
  const box = [
    item("Power bank", "lithium"), item("Laptop", "lithium"), item("Blood pressure pills", "medication"), item("Vitamins", "medication"),
    item("2 bottles of wine", "alcohol"), item("Hairspray", "aerosol"), item("Smoked salmon", "perishable"), item("Grandma's ring", "valuable"),
    item("Sweaters"),
  ];

  it("lists blocks first, then cautions", () => {
    expect(brief(box, "ups_ground", false, { destination: "hotel" })).toEqual([
      "block: Prescription medication",
      "block: Alcohol",
      "block: Food and other perishables",
      "warn: Loose batteries and power banks",
      "warn: Devices with lithium batteries",
      "warn: Over-the-counter medicine",
      "warn: Aerosols and flammables",
      "warn: Valuables",
    ]);
    expect(brief(box, "ups_2nd_day_air")).toEqual([
      "block: Loose batteries and power banks",
      "block: Prescription medication",
      "block: Alcohol",
      "block: Aerosols and flammables",
      "block: Food and other perishables",
      "warn: Devices with lithium batteries",
      "warn: Over-the-counter medicine",
      "warn: Valuables",
    ]);
    expect(hasBlockedContents(one(box, "ups_ground"))).toBe(true);
    expect(hasBlockedContents(one([item("Laptop", "lithium")], "ups_ground"))).toBe(false);
  });

  it("an international service counts as international without being told", () => {
    expect(brief(box, "fedex_intl_economy", false)).toEqual(brief(box, "fedex_intl_economy", true));
    expect(brief([item("Hairspray", "aerosol")], "fedex_intl_economy", false)).toEqual(["block: Aerosols and flammables"]);
  });

  it("groups the same thing listed twice, and an item with two flags appears under both", () => {
    const warnings = one([item("Wine", "alcohol"), item("Wine", "alcohol"), item("Whisky", "alcohol"), item("Perfume gift set with lighter", "aerosol", "valuable")], "ups_ground");
    expect(warnings.find((w) => w.flag === "alcohol")?.items).toEqual(["Wine", "Whisky"]);
    expect(warnings.map((w) => w.flag)).toEqual(["alcohol", "aerosol", "valuable"]);
  });

  it("every sentence follows the wording rules, for every service", () => {
    for (const service of [...SERVICE_KEYS, null]) {
      for (const international of [false, true]) {
        for (const destination of ["hotel", "relative_home", undefined] as const) {
          for (const warning of one(box, service, international, { destination, offshore: true })) {
            for (const text of [warning.text, warning.instead]) {
              expect(copyProblems(text), text).toEqual([]);
              expect(isSentence(text), text).toBe(true);
            }
            expect(warning.items.length).toBeGreaterThan(0);
            expect(CONTENT_FLAGS).toContain(warning.flag);
          }
        }
      }
    }
  });
});

describe("suggestContentFlags", () => {
  it("guesses from how she described it", () => {
    expect(suggestContentFlags("2 bottles of wine")).toEqual(["alcohol"]);
    expect(suggestContentFlags("Power bank and charger")).toEqual(["lithium"]);
    expect(suggestContentFlags("hairspray and perfume")).toEqual(["aerosol"]);
    expect(suggestContentFlags("Insulin")).toEqual(["medication"]);
    expect(suggestContentFlags("Dad's laptop and his prescription")).toEqual(["lithium", "medication"]);
    expect(suggestContentFlags("Frozen steaks on dry ice")).toEqual(["perishable"]);
    expect(suggestContentFlags("Passports and cash")).toEqual(["valuable"]);
    expect(suggestContentFlags("Bourbon, a camera, and grandma's necklace")).toEqual(["lithium", "alcohol", "valuable"]);
  });

  it("does not jump at things that only sound risky", () => {
    for (const harmless of ["Kids' sweaters", "Wine glasses", "Wine rack", "Beer mugs", "Cheese board", "Passport holder", "Wrapped gifts", "Ski boots", ""]) {
      expect(suggestContentFlags(harmless), harmless).toEqual([]);
    }
  });
});

describe("customsNotes", () => {
  it("is empty when nothing crosses a border", () => {
    expect(customsNotes(false)).toEqual([]);
    expect(customsNotes(false, "MX")).toEqual([]);
  });

  it("gives the five things to know, plus the gift rule coming into the US", () => {
    const abroad = customsNotes(true, "MX");
    expect(abroad).toHaveLength(5);
    expect(abroad[0]).toBe("List everything in the box: what it is, how many, what it is worth, and whether it is new or used.");
    expect(abroad[3]).toBe("Duties and taxes are usually billed to whoever receives it. A hotel won't pay them, so choose a duties-paid option or the box will be refused.");
    const home = customsNotes(true, "us");
    expect(home).toHaveLength(6);
    expect(home[5]).toBe("Into the US, a gift worth $100 or less per person per day comes in free of duty. Anything worth more is charged on the whole box.");
    for (const note of home) {
      expect(copyProblems(note), note).toEqual([]);
      expect(isSentence(note), note).toBe(true);
    }
  });
});
