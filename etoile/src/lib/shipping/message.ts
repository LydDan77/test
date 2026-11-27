// The ready-written note to the hotel, venue, rental host or relative, asking whether a box can
// come ahead. Short and polite, with the questions the report says to ask (section 2.3 and 2.4).
//
// The app never sends anything itself: the text is for her to copy, or to open in her own mail.

import type { ShipmentDestinationType, ShipmentKind } from "@/lib/domain";
import { formatDate, type LocalDate } from "@/lib/time";
import { carrierName, count, dayAndDate, isPickupPoint, parcelNoun } from "./words";

export type MessageAudience = "hotel" | "venue" | "rental_host" | "relative";

export type MessageQuestionKey = "accepts" | "how_early" | "fee" | "address" | "addressee";

export type MessageQuestion = { key: MessageQuestionKey; text: string };

export type PropertyMessageInput = {
  destination: ShipmentDestinationType;
  /** Her name, as on the reservation. */
  guestName: string;
  /** The day she arrives, and the day she leaves when known. */
  arrivalDate: LocalDate;
  departureDate?: LocalDate | null;
  /** The stay's confirmation number. Goes in the message so the property can find her booking. */
  reservationNumber?: string | null;
  /** The hotel, resort or venue by name. */
  propertyName?: string | null;
  /** Who she is writing to at a rental or a home: "Marta", "Mom". */
  hostName?: string | null;
  /** How many parcels, and what kind of thing ("box", "bag"). */
  parcelCount?: number | null;
  shipmentKind?: ShipmentKind | null;
  /** A word or two on what is inside: "clothing", "gifts". */
  contentsSummary?: string | null;
  /** Roughly what each one weighs, in pounds. */
  weightEachLb?: number | null;
  /** Who is carrying it (a provider value such as "ups"), when she has chosen. */
  carrier?: string | null;
  /** When it should get there: shipByPlan(...).targetDeliveryDate. */
  targetDeliveryDate?: LocalDate | null;
  /** The label as she plans to write it: labelBlock(...).lines. Quoted in the email to a hotel or venue. */
  labelLines?: readonly string[];
  /** Her mobile, for the sign-off. */
  phone?: string | null;
  /** For a conference: the event she is attending. */
  eventName?: string | null;
};

export type PropertyMessage = {
  audience: MessageAudience;
  /** The email subject line. */
  subject: string;
  /** The full email, ready to send. */
  body: string;
  /** One short paragraph for a chat box, a text or a booking site's message field. */
  short: string;
  /** The questions the message asks, so the answers can be recorded against them. */
  questions: MessageQuestion[];
};

const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

function audienceOf(destination: ShipmentDestinationType): MessageAudience | null {
  if (isPickupPoint(destination)) return null;
  if (destination === "vacation_rental") return "rental_host";
  if (destination === "relative_home") return "relative";
  if (destination === "conference_venue") return "venue";
  return "hotel";
}

const QUESTIONS: Record<MessageAudience, MessageQuestion[]> = {
  hotel: [
    { key: "accepts", text: "Do you accept packages for guests who have not arrived yet?" },
    { key: "how_early", text: "How early can it arrive, and is there a storage charge if it comes sooner?" },
    { key: "fee", text: "Is there a handling fee per box?" },
    { key: "address", text: "What exact address should I use (front desk, package room or receiving dock)?" },
    { key: "addressee", text: "Who should I address it to, and how should the label read?" },
  ],
  venue: [
    { key: "accepts", text: "Do you accept packages for guests who have not arrived yet?" },
    { key: "how_early", text: "How early can it arrive, and is there a storage charge if it comes sooner?" },
    { key: "fee", text: "Is there a handling fee, and is it charged per box or by weight?" },
    { key: "address", text: "What exact address should I use (business center, package room or receiving dock)?" },
    { key: "addressee", text: "Who should I address it to, and how should the label read?" },
  ],
  rental_host: [
    { key: "accepts", text: "Is it all right with you to have a package delivered there?" },
    { key: "how_early", text: "How early is too early for it to arrive?" },
    { key: "fee", text: "Is there any fee?" },
    { key: "address", text: "What exact address should I use?" },
    { key: "addressee", text: "Whose name should go on the label?" },
  ],
  // Nobody asks family about a fee.
  relative: [
    { key: "accepts", text: "Is it all right to send it to your place?" },
    { key: "how_early", text: "How early is fine for it to show up?" },
    { key: "address", text: "What is the best address to use?" },
    { key: "addressee", text: "Whose name should I put on the label?" },
  ],
};

/**
 * The questions to ask for a destination, or an empty list for a pickup point, where there is
 * nobody to ask. The same questions propertyMessage() writes into the note.
 */
export function questionsToAsk(destination: ShipmentDestinationType): MessageQuestion[] {
  const audience = audienceOf(destination);
  return audience ? QUESTIONS[audience] : [];
}

/**
 * The full nine-point checklist for a hotel or venue (report 2.3), for the "what to confirm"
 * panel. The ready-written message asks the first five; the rest are worth knowing before the
 * box goes.
 */
export const PROPERTY_CHECKLIST: readonly { key: string; question: string }[] = [
  { key: "accepts", question: "Do you accept packages for guests arriving later? Any limit on size, weight or number of boxes?" },
  { key: "address", question: "What is the exact delivery address, and how should the name appear on the label?" },
  { key: "how_early", question: "How many days before check-in will you hold it, and what is the storage charge after that?" },
  { key: "fee", question: "What is the handling fee per box, and how is it charged?" },
  { key: "hours", question: "What are the receiving hours and days? Many package rooms close at weekends." },
  { key: "pickup", question: "Where and when do I collect it, and do I need ID?" },
  { key: "signature", question: "Will you sign for it, and can you confirm by email or text when it arrives?" },
  { key: "return", question: "For the way home, can I leave a prepaid, labeled box for the carrier to pick up? Is there a fee?" },
  { key: "cancelled", question: "If my reservation changes or I arrive late, what happens to the box?" },
];

function numbered(questions: MessageQuestion[]): string {
  return questions.map((question, index) => `${index + 1}. ${question.text}`).join("\n");
}

/**
 * Writes the note asking whether a box can come ahead: an email (subject and body) and a short
 * version for a chat box. Returns null for pickup points, where there is nobody to ask.
 *
 *   const note = propertyMessage({
 *     destination: "hotel", guestName: "Lydia Hartley", arrivalDate: "2026-12-23",
 *     departureDate: "2026-12-26", reservationNumber: "84412907", parcelCount: 2,
 *     targetDeliveryDate: plan.targetDeliveryDate, labelLines: label.lines,
 *   });
 *   note?.subject   // "Package for guest Lydia Hartley, arriving Dec 23 (confirmation 84412907)"
 *
 * Use mailtoUrl(note, email) for an "open in mail" button. Record the answers in the booking's
 * propertyAnswers; they then replace the usual rules in shipByPlan().
 */
export function propertyMessage(input: PropertyMessageInput): PropertyMessage | null {
  const audience = audienceOf(input.destination);
  if (!audience) return null;

  const name = clean(input.guestName) || "[Your name]";
  const conf = clean(input.reservationNumber);
  const noun = parcelNoun(input.shipmentKind);
  const howMany = Number.isInteger(input.parcelCount) && (input.parcelCount ?? 0) > 1 ? (input.parcelCount as number) : 1;
  const what = howMany === 1 ? `a ${noun.one}` : count(howMany, noun.one, noun.many);
  const it = howMany === 1 ? "it" : "they";
  const itCap = howMany === 1 ? "It" : "They";
  const arrival = dayAndDate(input.arrivalDate);
  const target = input.targetDeliveryDate ? dayAndDate(input.targetDeliveryDate) : null;
  const questions = QUESTIONS[audience];
  const phone = clean(input.phone);
  const signOff = [name, phone].filter(Boolean).join("\n");

  // "(clothing, about 20 lb each)"
  const details = [
    clean(input.contentsSummary),
    input.weightEachLb && input.weightEachLb > 0 ? `about ${Math.round(input.weightEachLb)} lb${howMany > 1 ? " each" : ""}` : "",
  ].filter(Boolean);
  const detailText = details.length > 0 ? ` (${details.join(", ")})` : "";
  const carrier = clean(input.carrier) ? ` with ${carrierName(input.carrier)}` : "";

  if (audience === "hotel" || audience === "venue") {
    const stay = input.departureDate ? `arriving ${arrival} and leaving ${dayAndDate(input.departureDate)}` : `arriving ${arrival}`;
    const event = audience === "venue" && clean(input.eventName) ? ` for ${clean(input.eventName)}` : "";
    const reaching = target ? ` ${itCap} should reach you around ${target}.` : "";
    const label = (input.labelLines ?? []).map(clean).filter(Boolean);
    const labelPart = label.length > 0 ? `\n\nI plan to address it like this:\n${label.map((line) => `  ${line}`).join("\n")}` : "";
    const body =
      `Hello,\n\n` +
      `I have a reservation under ${name}${conf ? ` (confirmation ${conf})` : ""}, ${stay}${event}. ` +
      `I'd like to send ${what} ahead${detailText}${carrier}.${reaching}\n\n` +
      `Could you let me know:\n${numbered(questions)}` +
      `${labelPart}\n\n` +
      `I'll send the tracking number once ${it === "it" ? "it ships" : "they ship"}. Thank you.\n\n${signOff}`;
    const short =
      `Hello, I'm ${name}, checking in ${arrival}${conf ? ` (confirmation ${conf})` : ""}. ` +
      `May I send ${what} ahead${target ? ` to arrive around ${target}` : ""}? ` +
      `Could you tell me whether you accept packages, how early ${it} can arrive, whether there is a fee, and the exact address and name to put on the label? ` +
      `I'll share the tracking number when ${it === "it" ? "it ships" : "they ship"}. Thank you.`;
    return {
      audience,
      subject: `Package for guest ${name}, arriving ${formatDate(input.arrivalDate)}${conf ? ` (confirmation ${conf})` : ""}`,
      body,
      short,
      questions,
    };
  }

  const greeting = clean(input.hostName) ? `Hi ${clean(input.hostName)},` : "Hi,";

  if (audience === "rental_host") {
    const when = target ? `, around ${target}` : "";
    const body =
      `${greeting}\n\n` +
      `This is ${name}. I'm checking in on ${arrival}${conf ? ` (reservation ${conf})` : ""}. ` +
      `Would it be all right if I sent ${what} ahead${detailText}${carrier}? ` +
      `${itCap} would arrive on or after check-in day${when}, so nobody needs to be there early.\n\n` +
      `Could you let me know:\n${numbered(questions)}\n\n` +
      `I'll share the tracking number when ${it === "it" ? "it ships" : "they ship"}. Thank you.\n\n${signOff}`;
    const short =
      `${greeting.replace(/,$/, "")}, this is ${name}, checking in ${arrival}${conf ? ` (reservation ${conf})` : ""}. ` +
      `Would it be all right if I sent ${what} ahead, to arrive on or after check-in day${when}? ` +
      `What address and name should I use, how early is too early, and is there any fee? ` +
      `I'll share the tracking number when ${it === "it" ? "it ships" : "they ship"}. Thank you.`;
    return { audience, subject: `Sending ${what} ahead for my stay from ${formatDate(input.arrivalDate)}`, body, short, questions };
  }

  // A relative or friend.
  const reaching = target ? ` ${itCap} should reach you around ${target}.` : "";
  const waiting = howMany === 1 ? "it's" : "they're";
  const body =
    `${greeting}\n\n` +
    `I'd like to send ${what} ahead${detailText}${carrier} so ${waiting} waiting when I get there on ${arrival}.${reaching}\n\n` +
    `Could you let me know:\n${numbered(questions)}\n\n` +
    `I'll send you the tracking number when ${it === "it" ? "it ships" : "they ship"}. Thank you.\n\n${signOff}`;
  const short =
    `${greeting.replace(/,$/, "")}, I'd like to send ${what} ahead so ${waiting} waiting when I get there on ${arrival}.` +
    `${target ? ` ${itCap} should reach you around ${target}.` : ""} ` +
    `Is that all right, and what address and name should I use? I'll send the tracking number when ${it === "it" ? "it ships" : "they ship"}. Thank you.`;
  return { audience, subject: `Sending ${what} ahead of my visit`, body, short, questions };
}

/**
 * A `mailto:` link that opens her own mail app with the note already written. `to` is the
 * property's email address when known; leave it out and she fills it in.
 */
export function mailtoUrl(message: Pick<PropertyMessage, "subject" | "body">, to?: string | null): string {
  const address = clean(to);
  // Only something shaped like an address goes before the "?": anything else could add headers.
  const recipient = /^[^\s@?&#,;:<>"]+@[^\s@?&#,;:<>"]+\.[^\s@?&#,;:<>"]+$/.test(address) ? encodeURIComponent(address).replace(/%40/g, "@") : "";
  return `mailto:${recipient}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.body)}`;
}

/**
 * The follow-up once tracking shows it was delivered: a short note asking the property or host
 * to confirm they have it (LugLess advises exactly this). Null for pickup points.
 */
export function confirmReceiptMessage(input: {
  destination: ShipmentDestinationType;
  guestName: string;
  arrivalDate: LocalDate;
  reservationNumber?: string | null;
  hostName?: string | null;
  parcelCount?: number | null;
  shipmentKind?: ShipmentKind | null;
  carrier?: string | null;
}): string | null {
  const audience = audienceOf(input.destination);
  if (!audience) return null;
  const name = clean(input.guestName) || "[Your name]";
  const conf = clean(input.reservationNumber);
  const noun = parcelNoun(input.shipmentKind);
  const howMany = Number.isInteger(input.parcelCount) && (input.parcelCount ?? 0) > 1 ? (input.parcelCount as number) : 1;
  const mine = howMany === 1 ? `my ${noun.one} was` : `my ${howMany} ${noun.many} were`;
  const them = howMany === 1 ? "it" : "them";
  const tracking = clean(input.carrier) ? `${carrierName(input.carrier)} shows` : "Tracking shows";
  if (audience === "hotel" || audience === "venue") {
    return (
      `Hello, this is ${name}, arriving ${dayAndDate(input.arrivalDate)}${conf ? ` (confirmation ${conf})` : ""}. ` +
      `${tracking} ${mine} delivered to you. Could you confirm you have ${them}? Thank you.`
    );
  }
  const greeting = clean(input.hostName) ? `Hi ${clean(input.hostName)}` : "Hi";
  return `${greeting}, this is ${name}. ${tracking} ${mine} delivered. Could you let me know ${howMany === 1 ? "it" : "they"} arrived safely? Thank you.`;
}
