// What must not go in the box, and what to do instead (report section 6).
//
// Two levels, in the report's words: `block` is "do not ship this way"; `warn` is "allowed, with
// conditions". Every result says what to do instead.
//
// Evidence: USPS Publication 52 (lithium 349, medication 453, alcohol, aerosols 342 to 343,
// perishables 743), FedEx and UPS shipping pages, Send My Bag's prohibited list. The luggage
// services' own lists were not all read (report section 0), so their rules are assumed to be at
// least as strict as the carriers they ride on.

import type { ContentFlag, ShipmentContent, ShipmentDestinationType } from "@/lib/domain";
import { CONTENT_FLAGS } from "@/lib/domain/booking-shipment";
import { EN_DASH } from "@/lib/time";
import { SERVICES, type ServiceKey } from "./config";
import { isStaffedProperty, isPickupPoint } from "./words";

export type ContentsWarning = {
  flag: ContentFlag;
  /** `block`: do not ship this way. `warn`: allowed, with the conditions in `text`. */
  level: "block" | "warn";
  /** A short heading: "Prescription medication". */
  title: string;
  /** What the rule is, in a plain sentence or two. */
  text: string;
  /** What to do instead, as one instruction. */
  instead: string;
  /** The descriptions of the items that raised it, for "this is about your …". */
  items: string[];
};

export type ContentsOptions = {
  /** Where it is going. Perishables are judged by whether it will sit in a package room. */
  destination?: ShipmentDestinationType | null;
  /** True when it is going to or from Alaska, Hawaii, Puerto Rico or another island by ground. */
  offshore?: boolean;
};

/** One item of the contents list. A stored ShipmentContent fits as it is. */
export type ContentsItem = Pick<ShipmentContent, "description"> & { flags?: readonly ContentFlag[] };

const LOOSE_BATTERY = /\b(power ?banks?|battery packs?|spare batter(y|ies)|loose batter(y|ies)|extra batter(y|ies)|portable chargers?|batteries)\b/i;
const DEVICE = /\b(laptop|computer|phone|tablet|ipad|camera|kindle|e-?reader|watch|headphones|speaker|drone|console|toothbrush|shaver|tools?)\b/i;
const OVER_THE_COUNTER = /\b(otc|over[- ]the[- ]counter|vitamins?|supplements?|ibuprofen|tylenol|advil|aspirin|acetaminophen|antacids?|cough drops?|allergy (pills|tablets)|bandages?|first[- ]aid)\b/i;

/** Keyword hints for each flag, for suggestContentFlags(). Deliberately short and unsurprising. */
const HINTS: Record<ContentFlag, RegExp> = {
  lithium: /\b(laptop|phone|tablet|ipad|camera|drone|power ?bank|battery|batteries|e-?bike|scooter|vape|kindle|e-?reader|headphones|portable charger|smart ?watch)\b/i,
  medication: /\b(medication|medicine|prescriptions?|pills|insulin|inhaler|epipen|antibiotics?|ibuprofen|tylenol|advil|aspirin|vitamins?)\b/i,
  alcohol: /\b(wine|beer|whisk(e)?y|bourbon|vodka|gin|rum|tequila|champagne|liquor|spirits|alcohol|cider|sake)\b(?! (glass|rack|opener|cooler|bag|stopper|key|mug|stein|koozie))/i,
  aerosol: /\b(aerosols?|hair ?spray|spray (deodorant|sunscreen|paint)|bug spray|insect repellent|perfume|cologne|nail polish|lighters?|camp(ing)? fuel|propane|butane|matches)\b/i,
  perishable: /\b(perishables?|fresh (food|fruit|flowers)|flowers|meat|cheese(?! (board|knife|grater))|seafood|fish|frozen|refrigerated|breast ?milk|dry ice|cake|chocolates?)\b/i,
  valuable: /\b(cash|jewel(le)?ry|passports?(?! (cop|holder|cover|photo))|rings?|necklace|heirloom|birth certificate|deed|gold|irreplaceable)\b/i,
};

/**
 * Guesses which warnings an item needs from how she described it: "2 bottles of wine" suggests
 * `alcohol`, "power bank" suggests `lithium`. Use it to pre-tick the checklist; she can untick.
 * contentsWarnings() itself only looks at the flags that end up stored on the item.
 */
export function suggestContentFlags(description: string): ContentFlag[] {
  return CONTENT_FLAGS.filter((flag) => HINTS[flag].test(description));
}

/**
 * The warnings for a contents list: one entry per kind of restricted thing, blocks first.
 *
 *   contentsWarnings(details.contents, details.serviceKey, details.international)
 *
 * @param items          The contents, each with its `flags` (ShipmentDetails.contents fits).
 * @param service        The service level, or null when she has not picked one yet. Air and
 *                       express services are stricter than ground; with no service chosen, the
 *                       ground rules are given and the text says to stay on the ground.
 * @param international  True when it crosses a border. An international service counts too.
 */
export function contentsWarnings(
  items: readonly ContentsItem[],
  service: ServiceKey | null | undefined,
  international: boolean,
  options: ContentsOptions = {},
): ContentsWarning[] {
  const config = service ? SERVICES[service] : null;
  const abroad = international || config?.international === true;
  const byAir = config?.air === true;
  const serviceChosen = config !== null;

  const flagged = (flag: ContentFlag) => items.filter((item) => (item.flags ?? []).includes(flag));
  const names = (list: readonly ContentsItem[]) => [...new Set(list.map((item) => item.description.trim()).filter(Boolean))];
  const warnings: ContentsWarning[] = [];

  // --- lithium batteries ---
  const lithium = flagged("lithium");
  if (lithium.length > 0) {
    const loose = lithium.filter((item) => LOOSE_BATTERY.test(item.description) && !DEVICE.test(item.description));
    const devices = lithium.filter((item) => !loose.includes(item));
    if (loose.length > 0) {
      if (abroad || byAir) {
        warnings.push({
          flag: "lithium",
          level: "block",
          title: "Loose batteries and power banks",
          text: abroad
            ? "Loose lithium batteries and power banks can't be sent abroad at all."
            : "Loose lithium batteries and power banks can't go by air or express.",
          instead: "Carry them on the plane in your hand luggage.",
          items: names(loose),
        });
      } else {
        warnings.push({
          flag: "lithium",
          level: "warn",
          title: "Loose batteries and power banks",
          text: `Loose lithium batteries and power banks can only travel by ground inside the US${serviceChosen ? "" : ", so pick a ground service"}. Tape over the contacts and pack them in a rigid box.`,
          instead: "It is simpler to carry them on the plane in your hand luggage.",
          items: names(loose),
        });
      }
    }
    if (devices.length > 0) {
      const conditions: string[] = [];
      if (abroad) {
        conditions.push("Abroad, a device may go only with its battery installed, and USPS allows at most two batteries in a box. Ask the carrier before you pay.");
      } else if (byAir) {
        conditions.push("A device with its battery inside should go by ground, not by air or express. Choose a ground service.");
      } else {
        conditions.push(`A device with its battery inside can go by ground${serviceChosen ? "" : ", so pick a ground service"}. Use a rigid box and mark it as holding a lithium battery.`);
      }
      if (options.offshore && !byAir) conditions.push("Ground parcels with lithium batteries can't go to Alaska, Hawaii, Puerto Rico or other islands.");
      conditions.push("Loose batteries and power banks are different: those can't go by air at all.");
      warnings.push({
        flag: "lithium",
        level: "warn",
        title: "Devices with lithium batteries",
        text: conditions.join(" "),
        instead: "Anything you can't be without, carry with you.",
        items: names(devices),
      });
    }
  }

  // --- medication ---
  const medication = flagged("medication");
  if (medication.length > 0) {
    const otc = medication.filter((item) => OVER_THE_COUNTER.test(item.description) && !/\bprescription|\brx\b/i.test(item.description));
    const prescription = medication.filter((item) => !otc.includes(item));
    if (prescription.length > 0) {
      warnings.push({
        flag: "medication",
        level: "block",
        title: "Prescription medication",
        text: "You can't mail prescription medication yourself. Only a pharmacy or doctor can send it to a patient.",
        instead: "Carry it with you, or ask your pharmacy to mail a refill to where you're staying.",
        items: names(prescription),
      });
    }
    if (otc.length > 0) {
      warnings.push({
        flag: "medication",
        level: "warn",
        title: "Over-the-counter medicine",
        text: "Over-the-counter medicine can go in its original packaging. Send My Bag takes no medicine at all.",
        instead: "If it matters for the trip, carry it with you.",
        items: names(otc),
      });
    }
  }

  // --- alcohol ---
  const alcohol = flagged("alcohol");
  if (alcohol.length > 0) {
    warnings.push({
      flag: "alcohol",
      level: "block",
      title: "Alcohol",
      text: "You can't ship beer, wine or spirits yourself. USPS won't carry them, and UPS and FedEx take them only from licensed sellers.",
      instead: "Have the shop or winery ship it (an adult has to sign for it), or buy it when you get there.",
      items: names(alcohol),
    });
  }

  // --- aerosols and flammables ---
  const aerosol = flagged("aerosol");
  if (aerosol.length > 0) {
    if (abroad || byAir) {
      warnings.push({
        flag: "aerosol",
        level: "block",
        title: "Aerosols and flammables",
        text: abroad
          ? "Aerosols, perfume, nail polish and lighters can't be sent abroad. Send My Bag bans all liquids and gels on international routes too."
          : "Aerosols, perfume, nail polish and lighters can't go by air or express.",
        instead: "Buy toiletries when you arrive, or have them delivered there.",
        items: names(aerosol),
      });
    } else {
      warnings.push({
        flag: "aerosol",
        level: "warn",
        title: "Aerosols and flammables",
        text: `Aerosols, perfume, nail polish and lighters can only go by ground${serviceChosen ? "" : ", so pick a ground service"}. Keep each container to 1 liter or less and ask the clerk to mark the box Limited Quantity.`,
        instead: "It is easier to buy toiletries when you arrive.",
        items: names(aerosol),
      });
    }
  }

  // --- perishables ---
  const perishable = flagged("perishable");
  if (perishable.length > 0) {
    const destination = options.destination ?? null;
    const toAHome = destination === "relative_home";
    const overnight = service === "ups_next_day_air" || service === "fedex_overnight" || service === "usps_priority_mail_express";
    if (toAHome && !abroad && (overnight || !serviceChosen)) {
      warnings.push({
        flag: "perishable",
        level: "warn",
        title: "Food and other perishables",
        text: `Perishables go at your own risk: carriers don't refrigerate and don't pay for spoilage.${overnight ? "" : " Send them overnight only."} Ship Monday to Wednesday, never just before a holiday, and make sure someone is home.`,
        instead: "Or order groceries or a meal to arrive the evening you do.",
        items: names(perishable),
      });
    } else {
      const sitting =
        destination && (isStaffedProperty(destination) || isPickupPoint(destination))
          ? "It would sit in a package room with no refrigeration, possibly for days."
          : abroad
            ? "Perishables can't be sent abroad, and dry ice is banned on international mail."
            : "It would sit unrefrigerated for days, and carriers don't pay for spoilage.";
      warnings.push({
        flag: "perishable",
        level: "block",
        title: "Food and other perishables",
        text: `Don't send perishables ahead. ${sitting}`,
        instead: "Order groceries or a meal for the evening you arrive instead.",
        items: names(perishable),
      });
    }
  }

  // --- valuables ---
  const valuable = flagged("valuable");
  if (valuable.length > 0) {
    warnings.push({
      flag: "valuable",
      level: "warn",
      title: "Valuables",
      text: `Cash, jewelry, passports and anything you can't replace are safer with you. Included cover is usually only $500${EN_DASH}$1,000 a bag, and more costs extra.`,
      instead: "Keep them in your hand luggage.",
      items: names(valuable),
    });
  }

  return warnings.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
}

/** True when anything in the list must not be shipped this way at all. */
export function hasBlockedContents(warnings: readonly ContentsWarning[]): boolean {
  return warnings.some((warning) => warning.level === "block");
}

/**
 * What to know about customs when it crosses a border, as short plain lines (report section 6).
 * Empty when it does not. Only rules confirmed on official pages are included: the EU and UK
 * duty thresholds in the report came from third parties and are left out until checked.
 */
export function customsNotes(international: boolean, destinationCountryCode?: string | null): string[] {
  if (!international) return [];
  const notes = [
    "List everything in the box: what it is, how many, what it is worth, and whether it is new or used.",
    "Be specific: \"men's cotton shirts, used\", not \"clothes\" or \"gift\". Never put a lower value than the real one.",
    "For your own used clothes, write \"used personal effects, not for resale\" and keep proof of your travel dates.",
    "Duties and taxes are usually billed to whoever receives it. A hotel won't pay them, so choose a duties-paid option or the box will be refused.",
    "USPS needs the customs form filled in online. Handwritten forms are no longer accepted.",
  ];
  if ((destinationCountryCode ?? "").toUpperCase() === "US") {
    notes.push("Into the US, a gift worth $100 or less per person per day comes in free of duty. Anything worth more is charged on the whole box.");
  }
  return notes;
}
