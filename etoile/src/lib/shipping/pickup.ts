// Pickup points (somewhere a parcel can wait when the place she is staying cannot take it) and
// what to do about her own mail while she is away. Report section 3.
//
// Every figure here is the provider's own published rule unless marked. Links go to the
// provider's own page for the service.

import type { ShipmentDestinationType } from "@/lib/domain";
import { addDays, compareDates, diffDays, formatDate, formatDateRange, EN_DASH, type LocalDate } from "@/lib/time";
import { plainMoney } from "./words";

export type PickupPointKey = Extract<
  ShipmentDestinationType,
  "ups_access_point" | "fedex_hold_at_location" | "usps_general_delivery" | "amazon_locker" | "amazon_counter"
>;

export type PickupPointOption = {
  /** The destination kind to store on the booking when she chooses it. */
  key: PickupPointKey;
  /** "UPS Access Point". */
  name: string;
  /** Who can deliver there. Only that carrier's services make sense for it. */
  carrier: "ups" | "fedex" | "usps" | "amazon";
  /** How long it waits, as a number of calendar days for sorting and arithmetic. */
  holdDays: number;
  /** The hold limit in words: "Held for 7 days, then sent back". */
  holdLimit: string;
  /** What it suits, in one plain line. */
  suits: string;
  /** Size, weight and pickup rules worth knowing before choosing it. */
  rules: string;
  url: string;
  /** What the button says. */
  linkLabel: string;
};

/**
 * The five pickup points, in the order to offer them. Use one when a rental host says no, a
 * hotel will not take packages, or the trip has no fixed address.
 */
export const PICKUP_POINT_OPTIONS: readonly PickupPointOption[] = [
  {
    key: "ups_access_point",
    name: "UPS Access Point",
    carrier: "ups",
    holdDays: 7,
    holdLimit: "Held for 7 days, then sent back",
    suits: "A box or bag sent by UPS when the place you're staying can't receive it.",
    rules: "Bring government photo ID and the tracking number. Size and weight limits vary by location, so check before you send anything large.",
    url: "https://www.ups.com/us/en/business-solutions/expand-your-online-business/ups-access-point",
    linkLabel: "See UPS Access Point",
  },
  {
    key: "fedex_hold_at_location",
    name: "FedEx Hold at Location",
    carrier: "fedex",
    holdDays: 7,
    holdLimit: `Held up to 7 days at a store such as Walgreens, or 5 business days at FedEx Office, then sent back`,
    suits: "A box sent by FedEx to a store near where you're staying, to collect when you arrive.",
    rules: "Bring government photo ID. At Walgreens a box must be under 55 lb and 48 by 25 by 25 inches. Choose Hold at Location when you create the label, not the store's address.",
    url: "https://www.fedex.com/en-us/shipping/hold-at-location.html",
    linkLabel: "See FedEx Hold at Location",
  },
  {
    key: "usps_general_delivery",
    name: "USPS General Delivery",
    carrier: "usps",
    holdDays: 30,
    holdLimit: "Held for up to 30 days",
    suits: "One letter or parcel sent by USPS to a town where you have no address, such as on a road trip.",
    rules: "Free. Usually one post office in a city offers it, so phone to confirm. Bring government photo ID. UPS and FedEx can't deliver to it.",
    url: "https://faq.usps.com/s/article/What-is-General-Delivery",
    linkLabel: "Read about General Delivery on USPS",
  },
  {
    key: "amazon_locker",
    name: "Amazon Locker",
    carrier: "amazon",
    holdDays: 3,
    holdLimit: "Held for 3 days, then returned for a refund",
    suits: "A small Amazon order timed to land just before you arrive.",
    rules: "Under 10 lb and about 16 by 12 by 14 inches. Amazon emails a pickup code. Only Amazon orders can go to a locker.",
    url: "https://www.amazon.com/ulp/view",
    linkLabel: "Find an Amazon Locker",
  },
  {
    key: "amazon_counter",
    name: "Amazon Counter",
    carrier: "amazon",
    holdDays: 7,
    holdLimit: "Held for 7 days, then returned for a refund",
    suits: "A larger Amazon order collected from a staffed counter in a partner store.",
    rules: "Up to 33 lb and 36 by 24 by 24 inches, though some stores take less. Amazon emails a pickup code.",
    url: "https://www.amazon.com/ulp/view",
    linkLabel: "Find an Amazon Counter",
  },
];

/** The option for one pickup-point destination kind. */
export function pickupPointOption(key: PickupPointKey): PickupPointOption {
  return PICKUP_POINT_OPTIONS.find((option) => option.key === key) as PickupPointOption;
}

/**
 * The pickup points that fit what she is sending, in the order to offer them. A store order can
 * use Amazon's own points; anything she ships herself cannot.
 */
export function pickupPointOptions(situation: { retailOrder?: boolean } = {}): PickupPointOption[] {
  return PICKUP_POINT_OPTIONS.filter((option) => (option.carrier === "amazon") === (situation.retailOrder === true));
}

// --- her own mail while she is away ----------------------------------------------------------------

/** USPS prices from Notice 123 (January and July 2026), in US cents. Re-check each January and July. */
export const USPS_MAIL_PRICES = {
  currency: "USD",
  premiumForwardingEnrollmentOnline: 2640,
  premiumForwardingEnrollmentAtPostOffice: 2870,
  premiumForwardingPerWeek: 2970,
} as const;

/** USPS Hold Mail lasts at least 3 days and at most 30, and can be requested up to 30 days ahead. */
export const HOLD_MAIL_LIMITS = { minDays: 3, maxDays: 30, requestDaysAhead: 30 } as const;

export type MailOptionKey = "hold_mail" | "premium_forwarding" | "general_delivery" | "informed_delivery";

export type MailOption = {
  key: MailOptionKey;
  /** "Hold your mail". */
  name: string;
  /** The limit in words: "3–30 days", "Held for up to 30 days". */
  limit: string;
  /** What it suits, in one plain line. */
  suits: string;
  /** What it costs, in words. */
  cost: string;
  /** How it works, in a sentence or two. */
  how: string;
  url: string;
  linkLabel: string;
  /** True when this is the one to do for the trip dates given. Always false without dates. */
  recommended: boolean;
  /** With trip dates: what to do and by when, in one sentence. Null without dates. */
  forThisTrip: string | null;
  /** With trip dates: a day to remind her to arrange it. Null when there is nothing to arrange. */
  remindOn: LocalDate | null;
};

export type MailTrip = {
  /** The day she leaves home and the day she is back, as local dates at home. */
  leaveOn: LocalDate;
  returnOn: LocalDate;
  /** Today at home: `localDateOf(now, user.home.tz)`. Keeps reminders from landing in the past. */
  today?: LocalDate;
};

const usd = (amount: number) => plainMoney({ amount, currency: USPS_MAIL_PRICES.currency });

/**
 * The ways to look after her own mail while she is away: hold it, forward it, have one item wait
 * at a post office, and see what is arriving at home.
 *
 * With trip dates, one option is marked `recommended` and each says what to do for this trip:
 * Hold Mail for 3 to 30 days away, Premium Forwarding for longer. Without dates it is a plain
 * list, each with its limit, what it suits and a link.
 */
export function mailOptions(trip?: MailTrip | null): MailOption[] {
  const { minDays, maxDays, requestDaysAhead } = HOLD_MAIL_LIMITS;
  const ordered = trip && compareDates(trip.returnOn, trip.leaveOn) >= 0 ? trip : null;
  // Days with nobody home: the day she leaves up to the day before she is back.
  const daysAway = ordered ? Math.max(1, diffDays(ordered.leaveOn, ordered.returnOn)) : null;
  const lastDayAway = ordered ? (daysAway === 1 ? ordered.leaveOn : addDays(ordered.returnOn, -1)) : null;
  const clamp = (date: LocalDate): LocalDate => (ordered?.today && compareDates(date, ordered.today) < 0 ? ordered.today : date);

  const holdFits = daysAway !== null && daysAway >= minDays && daysAway <= maxDays;
  const needsForwarding = daysAway !== null && daysAway > maxDays;
  const weeks = daysAway !== null ? Math.ceil(daysAway / 7) : null;
  const forwardingCost =
    weeks !== null ? USPS_MAIL_PRICES.premiumForwardingEnrollmentOnline + USPS_MAIL_PRICES.premiumForwardingPerWeek * weeks : null;

  let holdForTrip: string | null = null;
  let holdRemindOn: LocalDate | null = null;
  if (ordered && daysAway !== null && lastDayAway) {
    if (holdFits) {
      const opens = clamp(addDays(ordered.leaveOn, -requestDaysAhead));
      holdForTrip = `USPS can hold your mail ${formatDateRange(ordered.leaveOn, lastDayAway)}. Ask any time from ${formatDate(opens)}, and no later than the day before you leave.`;
      holdRemindOn = clamp(addDays(ordered.leaveOn, -7));
    } else if (daysAway < minDays) {
      holdForTrip = `USPS only holds mail for ${minDays} days or more. For a trip this short, ask a neighbor to bring it in.`;
    } else {
      holdForTrip = `USPS holds mail for ${maxDays} days at most, and you are away for ${daysAway}. Use Premium Forwarding instead.`;
    }
  }

  return [
    {
      key: "hold_mail",
      name: "Hold your mail",
      limit: `${minDays}${EN_DASH}${maxDays} days`,
      suits: "A trip of up to a month when nobody is collecting the mail.",
      cost: "Free",
      how: `USPS keeps your mail at the post office and delivers it all when you are back. Ask up to ${requestDaysAhead} days ahead with a USPS.com account, or fill in a form at the post office.`,
      url: "https://www.usps.com/manage/hold-mail.htm",
      linkLabel: "Ask USPS to hold your mail",
      recommended: holdFits,
      forThisTrip: holdForTrip,
      remindOn: holdRemindOn,
    },
    {
      key: "premium_forwarding",
      name: "Forward your mail each week",
      limit: "Billed by the week",
      suits: "More than a month away, when you want your mail sent on to you.",
      cost: `${usd(USPS_MAIL_PRICES.premiumForwardingEnrollmentOnline)} to sign up online, then ${usd(USPS_MAIL_PRICES.premiumForwardingPerWeek)} a week`,
      how: "USPS boxes up all your mail every Wednesday and sends it to you by Priority Mail.",
      url: "https://www.usps.com/manage/forward-premium.htm",
      linkLabel: "See Premium Forwarding on USPS",
      recommended: needsForwarding,
      forThisTrip:
        needsForwarding && weeks !== null && forwardingCost !== null
          ? `You are away ${daysAway} days, too long for a mail hold. Forwarding for ${weeks} weeks costs about ${usd(forwardingCost)}.`
          : null,
      remindOn: needsForwarding && ordered ? clamp(addDays(ordered.leaveOn, -14)) : null,
    },
    {
      key: "general_delivery",
      name: "Have one item wait at a post office",
      limit: "Held for up to 30 days",
      suits: "A letter or parcel that has to reach you somewhere you have no address.",
      cost: "Free",
      how: `The sender addresses it to you at General Delivery in that town, and you collect it with photo ID. It has to come by USPS.`,
      url: "https://faq.usps.com/s/article/What-is-General-Delivery",
      linkLabel: "Read about General Delivery on USPS",
      recommended: false,
      forThisTrip: null,
      remindOn: null,
    },
    {
      key: "informed_delivery",
      name: "See what is arriving at home",
      limit: "No limit",
      suits: "Any trip: a morning email shows the letters and parcels heading to your address.",
      cost: "Free",
      how: `USPS emails pictures of your letters each morning it has mail for you, Monday to Saturday. Parcels show as status updates. It starts about 3 days after you sign up.`,
      url: "https://www.usps.com/manage/informed-delivery.htm",
      linkLabel: "Sign up for Informed Delivery on USPS",
      recommended: false,
      forThisTrip: ordered ? "Worth turning on before you go: it takes about 3 days to start." : null,
      remindOn: ordered ? clamp(addDays(ordered.leaveOn, -7)) : null,
    },
  ];
}
