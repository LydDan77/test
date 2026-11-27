// Who to ship with: the luggage services and carriers, in the order the report recommends for
// the situation (section 1.3), each with one plain line and the page to open.
//
// None of the luggage services accepts prefilled details in a link (report 1.2), so every option
// opens the provider's own start page, and copyTripDetails() gives her the text to paste in.

import type { LinkGrade, Parcel, ShipmentKind, ShipmentProvider } from "@/lib/domain";
import { formatDate, EN_DASH, type LocalDate } from "@/lib/time";
import type { ServiceKey } from "./config";
import { servicesOf } from "./ship-by";
import { PROVIDER_NAMES, parcelNoun } from "./words";

export type ProviderSituation = {
  /** What is being sent. Bags and gear go to luggage services; boxes, gifts and mail to carriers. */
  shipmentKind: ShipmentKind;
  /** True when it crosses a border. */
  international: boolean;
  /** True when it should be waiting on the cruise ship itself, in the cabin. */
  toCruiseShip?: boolean;
};

export type ProviderOption = {
  /** Goes in bookings.provider when she books with them. */
  provider: ShipmentProvider;
  /** "LugLess". */
  name: string;
  /** One plain line on why, and what it costs. Prices are the providers' own "from" figures. */
  line: string;
  /** The page to open. A start page: nothing can be prefilled. */
  url: string;
  /** What the button says: where it goes. */
  linkLabel: string;
  /** Always "observed": no provider documents a link format (the same grade a handoff row stores). */
  grade: LinkGrade;
  /**
   * Service levels to pass to shipByPlan() for this provider's dates, slowest first. Empty when
   * the provider publishes no transit times: use the delivery date it quotes at booking.
   */
  services: ServiceKey[];
};

export type ProviderRecommendation = {
  /** Best first. */
  providers: ProviderOption[];
  /** A plain sentence that applies to the whole list, or null. */
  note: string | null;
};

const option = (provider: ShipmentProvider, line: string, url: string, linkLabel: string, services: ServiceKey[]): ProviderOption => ({
  provider, name: PROVIDER_NAMES[provider], line, url, linkLabel, grade: "observed", services,
});

/**
 * Who to send it with, best first, for this situation.
 *
 *   recommendProviders({ shipmentKind: "luggage", international: false }).providers.map((p) => p.name)
 *     -> ["LugLess", "ShipGo", "Luggage Forward", "Luggage Free"]
 *
 * The order is the report's: to a cruise ship, Luggage Forward then Luggage Free; abroad, Send My
 * Bag, Luggage Forward, ShipGo, Luggage Free (then the carriers, for a box); a bag within the US,
 * LugLess, ShipGo, then the premium two; a box within the US, UPS, FedEx, USPS, then the box
 * products of LugLess and ShipGo.
 *
 * After she opens one, show copyTripDetails() beside it, then ask "Did you book it?" and record
 * the provider, order number, tracking numbers, price, pickup date and promised delivery date.
 */
export function recommendProviders(situation: ProviderSituation): ProviderRecommendation {
  const { shipmentKind, international } = situation;
  const isBag = shipmentKind === "luggage" || shipmentKind === "gear";
  const abroad = { international: true };

  if (shipmentKind === "retail_order") {
    return {
      providers: [],
      note: "The store ships this one. Have it sent to arrive inside the days the place will hold it, or to a pickup point nearby.",
    };
  }

  if (situation.toCruiseShip) {
    return {
      providers: [
        option(
          "luggage_forward",
          international
            ? `Delivers to your cabin on the ship. Hand your bags over 10${EN_DASH}14 days before you sail.`
            : `Delivers to your cabin on the ship, from about $139 a bag. Hand your bags over 7${EN_DASH}10 days before you sail.`,
          "https://www.luggageforward.com/cruise-luggage-shipping/",
          "See cruise delivery on Luggage Forward",
          servicesOf("luggage_forward", international ? abroad : {}),
        ),
        option(
          "luggage_free",
          "Also delivers to cruise ships, priced by the pound. Ask for a quote first: it publishes no prices.",
          "https://www.luggagefree.com/",
          "Get a quote on Luggage Free",
          servicesOf("luggage_free", international ? abroad : {}),
        ),
      ],
      note: "Never send anything to the cruise terminal itself. LugLess does not deliver to ships.",
    };
  }

  if (international) {
    const providers = [
      option(
        "send_my_bag",
        "Door to door abroad, priced per bag. It takes no liquids, aerosols or medicine, and its dates are estimates: add 3 working days.",
        "https://www.sendmybag.com/quote/",
        "Get a quote on Send My Bag",
        [],
      ),
      option(
        "luggage_forward",
        `Door to door with the customs paperwork done for you. A 50 lb bag runs about $354${EN_DASH}$679 and takes 7${EN_DASH}11 business days.`,
        "https://www.luggageforward.com/ship-luggage-internationally/",
        "See international delivery on Luggage Forward",
        servicesOf("luggage_forward", abroad),
      ),
      option(
        "shipgo",
        "Ships bags abroad with pickup or drop-off. It gives you the delivery date when you book.",
        "https://www.shipgo.com/ship-luggage-internationally",
        "See international delivery on ShipGo",
        [],
      ),
      option(
        "luggage_free",
        `Door to door nearly anywhere, in 1${EN_DASH}7 business days. Ask for a quote first: it publishes no prices.`,
        "https://www.luggagefree.com/",
        "Get a quote on Luggage Free",
        servicesOf("luggage_free", abroad),
      ),
    ];
    if (!isBag) {
      providers.push(
        option("ups", `For a box abroad: UPS Worldwide, 1${EN_DASH}5 business days depending on the service.`, "https://www.ups.com/ctc", "Check price and time on UPS", servicesOf("ups", abroad)),
        option("fedex", `For a box abroad: FedEx International, 1${EN_DASH}5 business days depending on the service.`, "https://www.fedex.com/", "Open FedEx", servicesOf("fedex", abroad)),
        option("dhl", `For a box abroad: DHL Express Worldwide, usually 1${EN_DASH}3 business days.`, "https://www.dhl.com/", "Open DHL", servicesOf("dhl", abroad)),
        option(
          "usps",
          `For a box abroad: USPS Priority Mail International, 6${EN_DASH}10 business days and longer if customs is slow.`,
          "https://www.usps.com/international/mail-shipping-services.htm",
          "See international mail on USPS",
          servicesOf("usps", abroad),
        ),
      );
    }
    return { providers, note: "LugLess only ships within the US and within Canada." };
  }

  if (isBag) {
    return {
      providers: [
        option(
          "lugless",
          "Usually the cheapest for a bag within the US, from about $25. You drop it at a UPS or FedEx counter, or pay for pickup.",
          "https://www.lugless.com/",
          "Get a quote on LugLess",
          servicesOf("lugless"),
        ),
        option(
          "shipgo",
          shipmentKind === "gear"
            ? "Ships sports gear too: skis and snowboards from about $45. Drop-off is free, or pickup at your door is $4.99."
            : "From about $35 a bag. Drop-off is free, or pickup at your door is $4.99.",
          "https://www.shipgo.com/",
          "Get a quote on ShipGo",
          [],
        ),
        option(
          "luggage_forward",
          "Door to door, with a packing kit sent to you first. From about $99 a bag.",
          "https://www.luggageforward.com/",
          "Get a quote on Luggage Forward",
          servicesOf("luggage_forward"),
        ),
        option(
          "luggage_free",
          "Door-to-door courier priced by the pound. Ask for a quote first: it publishes no prices.",
          "https://www.luggagefree.com/",
          "Get a quote on Luggage Free",
          servicesOf("luggage_free"),
        ),
      ],
      note: "A bag over 75 lb costs extra with LugLess. Weigh it before you book.",
    };
  }

  // A box, a gift or mail within the US: the carriers, then the luggage services' box products.
  const carriers = [
    option("ups", `UPS Ground takes 1${EN_DASH}5 business days. Check the price and time, then drop it off or book a pickup.`, "https://www.ups.com/ctc", "Check price and time on UPS", servicesOf("ups")),
    option("fedex", `FedEx Ground takes 1${EN_DASH}5 business days, and Home Delivery brings a box to a house at weekends too.`, "https://www.fedex.com/en-us/shipping/ground.html", "See FedEx Ground", servicesOf("fedex")),
    option("usps", `USPS Ground Advantage takes 2${EN_DASH}5 days, and the mail comes on Saturdays too.`, "https://postcalc.usps.com/", "Check the price on USPS", servicesOf("usps")),
  ];
  if (shipmentKind === "mail") carriers.unshift(...carriers.splice(2, 1));
  return {
    providers: [
      ...carriers,
      option("lugless", "Also ships boxes, on UPS and FedEx labels.", "https://www.lugless.com/ship-boxes/", "See boxes on LugLess", servicesOf("lugless")),
      option("shipgo", "Also ships boxes, with pickup at your door for $4.99.", "https://www.shipgo.com/ship-boxes", "See boxes on ShipGo", []),
    ],
    note: null,
  };
}

// --- "copy trip details" ---------------------------------------------------------------------------

export type TripDetailsInput = {
  /** Where it is collected from: her home address, as she would type it. */
  originAddress?: string | null;
  /** Where it is going: labelBlock(...).lines. */
  labelLines?: readonly string[];
  /** The day she will hand it over or have it picked up: plan.shipByDate, or earlier. */
  sendDate?: LocalDate | null;
  /** When it should arrive: plan.targetDeliveryDate. */
  targetDeliveryDate?: LocalDate | null;
  /** Each bag or box. Weight and dimensions are read. */
  parcels?: readonly Pick<Parcel, "weight" | "dimensions">[];
  shipmentKind?: ShipmentKind | null;
  /** Her name, phone and email, which every quote form asks for. */
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
};

export type TripDetails = {
  /** Everything in one block, for a single copy button. */
  text: string;
  /** The same, value by value, each with its own copy button. */
  fields: { label: string; value: string }[];
};

const tidy = (value: string | null | undefined): string => (value ?? "").trim();

function describeParcel(parcel: Pick<Parcel, "weight" | "dimensions">): string {
  const parts: string[] = [];
  if (parcel.weight) parts.push(`${parcel.weight.value} ${parcel.weight.unit}`);
  if (parcel.dimensions) {
    const { length, width, height, unit } = parcel.dimensions;
    parts.push(`${length} × ${width} × ${height} ${unit}`);
  }
  return parts.join(", ");
}

/**
 * The details a provider's quote form will ask for, ready to paste: where from, where to, when,
 * how many, how heavy. No provider accepts them in a link, so she copies them across.
 *
 * Dates are written out in full ("Thu, Dec 10, 2026") straight from the stored local dates.
 * Only what is known is included; nothing is invented.
 */
export function copyTripDetails(input: TripDetailsInput): TripDetails {
  const fields: { label: string; value: string }[] = [];
  const add = (label: string, value: string) => {
    if (value) fields.push({ label, value });
  };
  const noun = parcelNoun(input.shipmentKind);
  const parcels = input.parcels ?? [];
  const fullDate = (date: LocalDate) => formatDate(date, { weekday: true, year: true });

  add("Name", tidy(input.contactName));
  add("Phone", tidy(input.phone));
  add("Email", tidy(input.email));
  add("Collect from", tidy(input.originAddress));
  add("Deliver to", (input.labelLines ?? []).map(tidy).filter(Boolean).join("\n"));
  if (input.sendDate) add("Send on", fullDate(input.sendDate));
  if (input.targetDeliveryDate) add("Deliver by", fullDate(input.targetDeliveryDate));
  if (parcels.length > 0) add(`Number of ${noun.many}`, String(parcels.length));
  parcels.forEach((parcel, index) => {
    const label = `${noun.one.charAt(0).toUpperCase()}${noun.one.slice(1)}${parcels.length > 1 ? ` ${index + 1}` : ""}`;
    add(label, describeParcel(parcel));
  });

  const text = fields
    .map((field) => (field.value.includes("\n") ? `${field.label}:\n${field.value}` : `${field.label}: ${field.value}`))
    .join("\n");
  return { text, fields };
}
