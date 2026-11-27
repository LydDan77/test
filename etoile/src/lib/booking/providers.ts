// The provider registry: every site the app hands off to, in one file. Names, home pages, the
// words on the button, one honest line on why you might pick each, and a switch.
//
// To switch a provider's prefilled link off (their site changed and the link lands on an error
// page), set `disabled: true` here. The provider still appears, but its button opens the home
// page and the sheet lists everything to copy. Nothing else needs to change.
//
// No provider pays for its place. The order people see is chosen in links.ts from the situation.

import type { BookingKind } from "@/lib/domain";

export const PROVIDER_IDS = [
  "google_flights",
  "kayak",
  "skyscanner",
  "expedia",
  "booking",
  "airbnb",
  "vrbo",
  "hotels",
  "turo",
  "uber",
  "lyft",
  "google_maps",
  "apple_maps",
  "doordash",
  "uber_eats",
  "grubhub",
  "instacart",
  "ezcater",
] as const;

/** The id stored in handoffs.provider and bookings.provider. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

type HandoffKind = Exclude<BookingKind, "shipment">;

export type ProviderInfo = {
  id: ProviderId;
  /** The name as the company writes it. */
  name: string;
  /** Where the button goes when nothing can be prefilled. */
  homeUrl: string;
  /** A better starting page for one kind, when the provider has one. */
  homeUrlByKind?: Partial<Record<HandoffKind, string>>;
  /** The kinds this provider is offered for, with the words on its button and a one-line reason to pick it. */
  kinds: Partial<Record<HandoffKind, { actionLabel: string; blurb: string }>>;
  /** True switches the prefilled link off: the button opens the home page instead. */
  disabled: boolean;
};

export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
  google_flights: {
    id: "google_flights",
    name: "Google Flights",
    homeUrl: "https://www.google.com/travel/flights",
    kinds: {
      flight: {
        actionLabel: "See flights on Google Flights",
        blurb: "Shows most airlines at once, with a calendar of cheaper days.",
      },
    },
    disabled: false,
  },
  kayak: {
    id: "kayak",
    name: "Kayak",
    homeUrl: "https://www.kayak.com/",
    homeUrlByKind: { flight: "https://www.kayak.com/flights", car: "https://www.kayak.com/cars" },
    kinds: {
      flight: { actionLabel: "See flights on Kayak", blurb: "Compares prices from many booking sites side by side." },
      car: { actionLabel: "See cars on Kayak", blurb: "Compares the rental companies at the airport side by side." },
    },
    disabled: false,
  },
  skyscanner: {
    id: "skyscanner",
    name: "Skyscanner",
    homeUrl: "https://www.skyscanner.com/",
    kinds: {
      flight: { actionLabel: "See flights on Skyscanner", blurb: "Good at finding the cheapest day and nearby airports." },
    },
    disabled: false,
  },
  expedia: {
    id: "expedia",
    name: "Expedia",
    homeUrl: "https://www.expedia.com/",
    kinds: {
      flight: { actionLabel: "See flights on Expedia", blurb: "You can add a hotel or a car to the same booking." },
      lodging: { actionLabel: "See hotels on Expedia", blurb: "Hotels, with flights or a car added to the same trip if you like." },
      car: { actionLabel: "See cars on Expedia", blurb: "Opens with your pick-up and return times already set." },
    },
    disabled: false,
  },
  booking: {
    id: "booking",
    name: "Booking.com",
    homeUrl: "https://www.booking.com/",
    kinds: {
      lodging: {
        actionLabel: "See places to stay on Booking.com",
        blurb: "A very wide choice of hotels, and it takes everyone's ages.",
      },
    },
    disabled: false,
  },
  airbnb: {
    id: "airbnb",
    name: "Airbnb",
    homeUrl: "https://www.airbnb.com/",
    kinds: {
      lodging: { actionLabel: "See homes on Airbnb", blurb: "Whole homes with a kitchen, good for a group staying together." },
    },
    disabled: false,
  },
  vrbo: {
    id: "vrbo",
    name: "Vrbo",
    homeUrl: "https://www.vrbo.com/",
    kinds: {
      lodging: { actionLabel: "See homes on Vrbo", blurb: "Whole houses only, good for a big family under one roof." },
    },
    disabled: false,
  },
  hotels: {
    id: "hotels",
    name: "Hotels.com",
    homeUrl: "https://www.hotels.com/",
    kinds: {
      lodging: { actionLabel: "See hotels on Hotels.com", blurb: "Hotels only, easy to compare by price and area." },
    },
    disabled: false,
  },
  turo: {
    id: "turo",
    name: "Turo",
    homeUrl: "https://turo.com/",
    kinds: {
      car: { actionLabel: "See cars on Turo", blurb: "Rent from a local owner, with more large vehicles to choose from." },
    },
    disabled: false,
  },
  uber: {
    id: "uber",
    name: "Uber",
    homeUrl: "https://m.uber.com/",
    kinds: {
      ride: { actionLabel: "Get a ride with Uber", blurb: "A ride when you need it, or reserved ahead in the app." },
    },
    disabled: false,
  },
  lyft: {
    id: "lyft",
    name: "Lyft",
    homeUrl: "https://www.lyft.com/",
    kinds: {
      ride: { actionLabel: "Get a ride with Lyft", blurb: "A ride when you need it, or scheduled ahead in the app." },
    },
    disabled: false,
  },
  google_maps: {
    id: "google_maps",
    name: "Google Maps",
    homeUrl: "https://www.google.com/maps",
    kinds: {
      ride: { actionLabel: "Directions in Google Maps", blurb: "See the route and how long the drive takes." },
    },
    disabled: false,
  },
  apple_maps: {
    id: "apple_maps",
    name: "Apple Maps",
    homeUrl: "https://maps.apple.com/",
    kinds: {
      ride: { actionLabel: "Directions in Apple Maps", blurb: "The same route in Apple Maps, on iPhone and Mac." },
    },
    disabled: false,
  },
  doordash: {
    id: "doordash",
    name: "DoorDash",
    homeUrl: "https://www.doordash.com/",
    kinds: {
      meal: { actionLabel: "Order on DoorDash", blurb: "Restaurant delivery from most local places." },
    },
    disabled: false,
  },
  uber_eats: {
    id: "uber_eats",
    name: "Uber Eats",
    homeUrl: "https://www.ubereats.com/",
    kinds: {
      meal: { actionLabel: "Order on Uber Eats", blurb: "Restaurant delivery you can schedule up to a week ahead." },
    },
    disabled: false,
  },
  grubhub: {
    id: "grubhub",
    name: "Grubhub",
    homeUrl: "https://www.grubhub.com/",
    kinds: {
      meal: { actionLabel: "Order on Grubhub", blurb: "Restaurant delivery, ordered up to four days ahead." },
    },
    disabled: false,
  },
  instacart: {
    id: "instacart",
    name: "Instacart",
    homeUrl: "https://www.instacart.com/",
    kinds: {
      meal: { actionLabel: "Shop on Instacart", blurb: "Groceries delivered from stores near where you're staying." },
    },
    disabled: false,
  },
  ezcater: {
    id: "ezcater",
    name: "ezCater",
    homeUrl: "https://www.ezcater.com/",
    kinds: {
      meal: { actionLabel: "See caterers on ezCater", blurb: "Catering for a group, ordered days ahead." },
    },
    disabled: false,
  },
};

/** The registry row for an id, or null for an id the registry does not know (an old handoffs row). */
export function providerInfo(id: string): ProviderInfo | null {
  return (PROVIDERS as Record<string, ProviderInfo | undefined>)[id] ?? null;
}

/** The provider's name for people: providerName("uber_eats") is "Uber Eats". Unknown ids come back as they are. */
export function providerName(id: string): string {
  return providerInfo(id)?.name ?? id;
}

/** The page to open when nothing can be prefilled. */
export function providerHomeUrl(id: ProviderId, kind?: HandoffKind): string {
  const info = PROVIDERS[id];
  return (kind && info.homeUrlByKind?.[kind]) || info.homeUrl;
}

// --- ordering windows -----------------------------------------------------------------------------
// How far ahead each food provider takes an order (product spec 5.7, from research/booking-links.md).
// Instacart's real limit depends on the store (some take orders 14 days ahead); 5 is the safe one.

export const FOOD_ORDER_WINDOW_DAYS: Readonly<Record<"doordash" | "uber_eats" | "grubhub" | "instacart" | "ezcater", number | null>> = {
  uber_eats: 7,
  doordash: 4,
  grubhub: 4,
  instacart: 5,
  /** ezCater takes orders any time; two days' notice is what caterers ask for. */
  ezcater: null,
};

/** Uber Reserve and Lyft scheduled rides both open this many days before the ride. */
export const RIDE_RESERVATION_WINDOW_DAYS = 90;
/** The notice caterers ask for, and the last day to order catering. */
export const CATERING_NOTICE_DAYS = 2;
