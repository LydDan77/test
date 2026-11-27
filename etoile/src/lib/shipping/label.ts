// The label: exactly what to write on the box so it finds her, for each kind of destination.
//
// Formats are from the report's section 2.1 (synthesised from LugLess's hotel guide, Disney's
// mail services page and convention-hotel shipping sheets) and USPS Publication 28 section 26
// for General Delivery. The property's own instructions always win: pass what it said as
// `receivingAddress`.

import type { PlaceRef, ShipmentDestinationType, ShipmentKind } from "@/lib/domain";
import { formatDate, formatDateRange, type LocalDate } from "@/lib/time";
import { isPickupPoint, isStaffedProperty, labelDate, slashDate } from "./words";
import { parseUsZip } from "./zones";

/** The domain allows ten label lines (ShipmentDetails.labelLines). */
const MAX_LABEL_LINES = 10;
/** Many carrier label formats cut the second address line near here (report 2.1, unconfirmed). */
const ADDRESS_LINE_2_LIMIT = 35;

export type LabelInput = {
  destination: ShipmentDestinationType;
  /**
   * Who it is for. At a hotel this must be the name exactly as on the reservation; at a pickup
   * point, the name on the photo ID she will show.
   */
  recipientName: string;
  /** The day she gets there (the stay's check-in date). */
  arrivalDate?: LocalDate | null;
  /** The hotel, resort, venue or pickup point by name. */
  propertyName?: string | null;
  /** The rental host or the relative she is staying with: becomes "c/o {name}". */
  hostName?: string | null;
  /** The stay's confirmation number. Private: the label is hers to copy, never for a share page. */
  reservationNumber?: string | null;
  /** Where it is going: the stay's place. Only the address fields are read. */
  place?: Pick<PlaceRef, "addressLines" | "locality" | "region" | "postalCode" | "countryCode"> | null;
  /**
   * The exact receiving address the property gave (package room, receiving dock), one line per
   * line. Replaces the address from `place`.
   */
  receivingAddress?: string | null;
  /** Her own mobile number. Never the hotel's. */
  phone?: string | null;
  /** For a conference: her company, the event, and its dates. */
  companyName?: string | null;
  eventName?: string | null;
  eventStartDate?: LocalDate | null;
  eventEndDate?: LocalDate | null;
  /** "BOX 1 OF 2": which parcel this label is for, and how many there are. */
  parcelNumber?: number | null;
  parcelCount?: number | null;
  /**
   * True when it crosses a border: the country goes on the last address line. About 25 common
   * destinations are spelled out ("MEXICO"); any other shows its two-letter code, so have her
   * check that line.
   */
  international?: boolean;
  /** What is being sent. A store order gets the wording for a store's address form. */
  shipmentKind?: ShipmentKind | null;
};

export type LabelField = {
  /** The box on a carrier's or store's address form: "Recipient name", "Address line 2". */
  label: string;
  value: string;
  /** A short reason, where the choice is not obvious. */
  hint?: string;
};

export type LabelGap = {
  field: "recipientName" | "arrivalDate" | "propertyName" | "reservationNumber" | "address" | "postalCode" | "phone";
  /** What to ask her for, and why it matters. */
  ask: string;
};

export type LabelBlock = {
  /**
   * The label, one line per entry, ready to copy or write by hand. At most ten lines. Store in
   * details.labelLines. Empty for an Amazon Locker or Counter, which need no label: see `howTo`.
   */
  lines: string[];
  /** `lines` joined with line breaks, for a copy button. */
  text: string;
  /** The "HOLD FOR GUEST, ARRIVING …" line, when the destination uses one. Store in details.holdNote. */
  holdNote: string | null;
  /** The same information laid out for a carrier's online address form, field by field. */
  formFields: LabelField[];
  /** One plain sentence on how to use it. */
  howTo: string;
  /** Short reminders for this kind of destination. */
  notes: string[];
  /** What is still missing for a complete label. Empty when it is ready. */
  missing: LabelGap[];
};

const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

/** A few country names for the last line of an international label. Others show their code. */
const COUNTRY_NAMES: Record<string, string> = {
  AU: "AUSTRALIA", BS: "BAHAMAS", CA: "CANADA", CH: "SWITZERLAND", CN: "CHINA", CR: "COSTA RICA", DE: "GERMANY",
  DO: "DOMINICAN REPUBLIC", ES: "SPAIN", FR: "FRANCE", GB: "UNITED KINGDOM", GR: "GREECE", IE: "IRELAND", IN: "INDIA",
  IS: "ICELAND", IT: "ITALY", JM: "JAMAICA", JP: "JAPAN", KR: "SOUTH KOREA", MX: "MEXICO", NL: "NETHERLANDS",
  NZ: "NEW ZEALAND", PT: "PORTUGAL", SG: "SINGAPORE", TH: "THAILAND", US: "UNITED STATES",
};

function cityLine(place: LabelInput["place"]): string {
  if (!place) return "";
  const cityState = [clean(place.locality), clean(place.region)].filter(Boolean).join(", ");
  return [cityState, clean(place.postalCode)].filter(Boolean).join(" ");
}

/** The street lines and the city line, from what the property said or from the place. */
function addressOf(input: LabelInput): { street: string[]; city: string } {
  const given = (input.receivingAddress ?? "").split(/\r?\n/).map(clean).filter(Boolean);
  if (given.length > 0) {
    // A property's own address is used as written; its last line is its city line.
    return given.length === 1 ? { street: given, city: "" } : { street: given.slice(0, -1), city: given[given.length - 1] };
  }
  return { street: (input.place?.addressLines ?? []).map(clean).filter(Boolean), city: cityLine(input.place) };
}

/** "BOX 1 OF 2", or nothing when there is only one parcel. */
function boxCount(input: LabelInput): string {
  const count = input.parcelCount ?? 0;
  const number = input.parcelNumber ?? 0;
  const valid = Number.isInteger(count) && count > 1 && Number.isInteger(number) && number >= 1 && number <= count;
  return valid ? `BOX ${number} OF ${count}` : "";
}

function boxLine(input: LabelInput): string {
  const phone = clean(input.phone);
  return [boxCount(input), phone ? `PHONE ${phone}` : ""].filter(Boolean).join(", ");
}

/** Keeps the label within ten lines by joining street lines, then the hold and confirmation lines. */
function fit(head: string[], street: string[], tail: string[]): string[] {
  const streets = [...street];
  while (head.length + streets.length + tail.length > MAX_LABEL_LINES && streets.length > 1) {
    const last = streets.pop() as string;
    streets[streets.length - 1] = `${streets[streets.length - 1]}, ${last}`;
  }
  const heads = [...head];
  while (heads.length + streets.length + tail.length > MAX_LABEL_LINES && heads.length > 2) {
    const last = heads.pop() as string;
    heads[heads.length - 1] = `${heads[heads.length - 1]}, ${last}`;
  }
  return [...heads, ...streets, ...tail].map((line) => line.slice(0, 200));
}

function holdLineFor(input: LabelInput): string {
  return input.arrivalDate ? `HOLD FOR GUEST, ARRIVING ${labelDate(input.arrivalDate)}` : "HOLD FOR GUEST";
}

/** The carrier form's second address line: short enough to survive a 35-character field. */
function shortHoldLine(input: LabelInput): string {
  const arriving = input.arrivalDate ? ` ARR ${slashDate(input.arrivalDate)}` : "";
  const conf = clean(input.reservationNumber) ? ` CONF ${clean(input.reservationNumber)}` : "";
  const full = `HOLD FOR GUEST${arriving}${conf}`;
  if (full.length <= ADDRESS_LINE_2_LIMIT) return full;
  const shorter = `HOLD${arriving}${conf}`;
  if (shorter.length <= ADDRESS_LINE_2_LIMIT) return shorter;
  return `HOLD FOR GUEST${arriving}`;
}

/**
 * Writes the label for a parcel, in the form its destination needs.
 *
 *   const label = labelBlock({
 *     destination: "hotel", recipientName: "Lydia Hartley", arrivalDate: "2026-12-23",
 *     propertyName: "Grand Floridian", reservationNumber: "84412907", place: stay.place,
 *     phone: "612-555-0100", parcelNumber: 1, parcelCount: 2,
 *   });
 *   label.lines
 *   // Lydia Hartley
 *   // c/o Grand Floridian
 *   // HOLD FOR GUEST, ARRIVING DEC 23, 2026
 *   // CONF 84412907
 *   // 4401 Floridian Way
 *   // Orlando, FL 32830
 *   // BOX 1 OF 2, PHONE 612-555-0100
 *
 * Never throws. Whatever is missing is listed in `missing`, and the label is built from the rest.
 * The label carries her confirmation number and phone: it is for her to copy, never for a share page.
 */
export function labelBlock(input: LabelInput): LabelBlock {
  const destination = input.destination;
  const name = clean(input.recipientName);
  const property = clean(input.propertyName);
  const host = clean(input.hostName);
  const conf = clean(input.reservationNumber);
  const phone = clean(input.phone);
  const { street, city } = addressOf(input);
  const missing: LabelGap[] = [];
  const notes: string[] = [];
  const formFields: LabelField[] = [];
  const nameLine = name || "[Your name]";

  // Amazon delivers these itself: there is nothing to write.
  if (destination === "amazon_locker" || destination === "amazon_counter") {
    const what = destination === "amazon_locker" ? "Locker" : "Counter";
    return {
      lines: [],
      text: "",
      holdNote: null,
      formFields: [],
      howTo: `No label needed. At checkout, choose the Amazon ${what} as your delivery address.`,
      notes: [
        destination === "amazon_locker"
          ? "Amazon emails a pickup code when it arrives. You have 3 days to collect it before it goes back for a refund."
          : "Amazon emails a pickup code when it arrives. You have 7 days to collect it before it goes back for a refund.",
        destination === "amazon_locker"
          ? "It has to weigh under 10 lb and fit a locker, about 16 by 12 by 14 inches."
          : "It can weigh up to 33 lb and measure up to 36 by 24 by 24 inches. Some stores take less.",
      ],
      missing: [],
    };
  }

  if (!name) {
    missing.push({
      field: "recipientName",
      ask: isStaffedProperty(destination)
        ? "Add the name on the reservation. The front desk matches the box to it."
        : "Add the name of the person it is for.",
    });
  }

  // USPS General Delivery: three lines, capitals, the ZIP ending in -9999.
  if (destination === "usps_general_delivery") {
    const zip = parseUsZip(input.place?.postalCode);
    const cityState = [clean(input.place?.locality), clean(input.place?.region)].filter(Boolean).join(", ").toUpperCase();
    if (!cityState) missing.push({ field: "address", ask: "Add the city and state of the post office." });
    if (!zip) missing.push({ field: "postalCode", ask: "Add the post office's ZIP code. Phone it to check which ZIP it uses for General Delivery." });
    const lines = [nameLine.toUpperCase(), "GENERAL DELIVERY", [cityState, zip ? `${zip}-9999` : ""].filter(Boolean).join(" ")].filter(Boolean);
    return {
      lines,
      text: lines.join("\n"),
      holdNote: null,
      formFields: [
        { label: "Recipient name", value: nameLine.toUpperCase(), hint: "The name on your photo ID." },
        { label: "Address line 1", value: "GENERAL DELIVERY" },
        ...(lines[2] ? [{ label: "City, state and ZIP", value: lines[2], hint: "The ZIP ends in 9999 for General Delivery." }] : []),
      ],
      howTo: "Write these three lines as the address. Collect it at the post office counter with photo ID.",
      notes: [
        "Only USPS can deliver to General Delivery. UPS and FedEx cannot.",
        "Usually one post office in a city offers it. Phone to confirm before you send.",
        "The post office keeps it for up to 30 days. Bring government photo ID to collect it.",
      ],
      missing,
    };
  }

  if (street.length === 0 && !city) {
    missing.push({
      field: "address",
      ask: isPickupPoint(destination) ? "Choose the pickup point to get its address." : "Add the address it is going to.",
    });
  }

  const tail: string[] = [];
  if (city) tail.push(city);
  const countryCode = clean(input.place?.countryCode).toUpperCase();
  if (input.international && countryCode && !(input.receivingAddress ?? "").trim()) tail.push(COUNTRY_NAMES[countryCode] ?? countryCode);
  const box = boxLine(input);
  if (box) tail.push(box);

  const head: string[] = [];
  let holdNote: string | null = null;
  let howTo: string;

  if (isStaffedProperty(destination)) {
    const isVenue = destination === "conference_venue";
    const company = clean(input.companyName);
    head.push(isVenue && company ? `${nameLine}, ${company}` : nameLine);
    if (property) head.push(`c/o ${property}`);
    else missing.push({ field: "propertyName", ask: "Add the name of the place, so the carrier and the desk both know where it belongs." });
    holdNote = holdLineFor(input);
    head.push(holdNote);
    if (!input.arrivalDate) missing.push({ field: "arrivalDate", ask: "Add the day you arrive. Hotels hold a box by the guest's arrival date." });
    if (conf) head.push(`CONF ${conf}`);
    else missing.push({ field: "reservationNumber", ask: "Add your confirmation number so the front desk can match the box to your booking." });
    if (isVenue && clean(input.eventName)) {
      const when = input.eventStartDate ? `, ${formatDateRange(input.eventStartDate, input.eventEndDate)}` : "";
      head.push(`${clean(input.eventName)}${when}`);
    }
    if (!phone) missing.push({ field: "phone", ask: "Add your mobile number, so the desk or the carrier can reach you." });

    if (input.shipmentKind === "retail_order") {
      // A store's form has no hold line: the arrival date rides in the name field (report 3.2).
      const arriving = input.arrivalDate ? `, arriving ${formatDate(input.arrivalDate)}` : "";
      formFields.push({ label: "Full name", value: `${nameLine} (Guest${arriving})`, hint: "So the front desk knows whose it is and when you arrive." });
      if (street[0]) formFields.push({ label: "Address line 1", value: street[0] });
      if (property) formFields.push({ label: "Address line 2", value: `c/o ${property}` });
      if (city) formFields.push({ label: "City, state and ZIP", value: city });
      if (phone) formFields.push({ label: "Phone", value: phone, hint: "Your mobile, not the hotel's." });
      howTo = "Type it into the store's address form like this.";
      notes.push("A store can't be told which day to deliver, so order it to land inside the days the hotel will hold it.");
    } else {
      formFields.push({ label: "Recipient name", value: nameLine, hint: "Exactly as on the reservation." });
      if (property) formFields.push({ label: "Company", value: property });
      if (street[0]) formFields.push({ label: "Address line 1", value: street[0] });
      formFields.push({ label: "Address line 2", value: shortHoldLine(input), hint: "Kept short: many label forms cut this line off at about 35 characters." });
      if (city) formFields.push({ label: "City, state and ZIP", value: city });
      if (phone) formFields.push({ label: "Phone", value: phone, hint: "Your mobile, not the hotel's." });
      const reference = [input.arrivalDate ? `Guest arriving ${formatDate(input.arrivalDate)}` : "", boxCount(input)]
        .filter(Boolean)
        .join(", ");
      if (reference) formFields.push({ label: "Reference or notes", value: reference });
      howTo = "Copy these lines onto the label, or type them into the carrier's address form field by field.";
    }
    notes.push("The name has to match your reservation exactly, or the desk may turn the box away.");
    notes.push("If the property gives you a different address or wording, use theirs.");
    if (isVenue) notes.push("This is for a box sent to you as a guest. Booth freight uses the show's own label and deadlines.");
    if (destination === "cruise_precruise_hotel") notes.push("Send it to the hotel, never to the cruise terminal.");
    if (destination === "resort") notes.push("Resorts look for the word GUEST and your arrival date on the front of the box.");
  } else if (destination === "vacation_rental" || destination === "relative_home") {
    head.push(nameLine);
    if (host) head.push(`c/o ${host}`);
    formFields.push({ label: "Recipient name", value: nameLine });
    if (host) formFields.push({ label: "Company or care of", value: `c/o ${host}` });
    if (street[0]) formFields.push({ label: "Address line 1", value: street[0] });
    if (street[1]) formFields.push({ label: "Address line 2", value: street[1] });
    if (city) formFields.push({ label: "City, state and ZIP", value: city });
    if (phone) formFields.push({ label: "Phone", value: phone });
    howTo = "Copy these lines onto the label, or type them into the carrier's address form.";
    if (destination === "vacation_rental") {
      notes.push("Only send it if your host has said yes in writing.");
      notes.push("Time it to arrive on or after the day you check in.");
      if (!host) notes.push("Add your host's name as a c/o line if they ask for it.");
    } else {
      notes.push("Tell your host the tracking number so they know to look for it.");
    }
  } else {
    // UPS Access Point and FedEx Hold at Location.
    const isFedex = destination === "fedex_hold_at_location";
    head.push(nameLine);
    head.push(isFedex ? "HOLD AT LOCATION" : "HOLD FOR PICKUP");
    if (property) head.push(property);
    else missing.push({ field: "propertyName", ask: "Choose the pickup point, so its name and address can go on the label." });
    formFields.push({ label: "Recipient name", value: nameLine, hint: "The name on your photo ID." });
    if (phone) formFields.push({ label: "Phone", value: phone });
    formFields.push({
      label: "Delivery option",
      value: isFedex ? `Hold at Location${property ? `: ${property}` : ""}` : `Ship to a UPS Access Point${property ? `: ${property}` : ""}`,
    });
    howTo = isFedex
      ? "When you create the FedEx label, choose Hold at Location and pick this store. Don't type the store's address in as the recipient's address."
      : "When you create the UPS label, choose delivery to a UPS Access Point and pick this one.";
    notes.push(
      isFedex
        ? "FedEx keeps it up to 7 days at a store such as Walgreens, or 5 business days at FedEx Office, then sends it back."
        : "UPS keeps it for 7 days, then sends it back. The last pickup day shows in tracking.",
    );
    notes.push("Bring government photo ID and the tracking number to collect it.");
  }

  const lines = fit(head, street, tail);
  return { lines, text: lines.join("\n"), holdNote, formFields, howTo, notes, missing };
}
