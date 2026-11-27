// How far a parcel is going, from two US ZIP codes, as a carrier zone (2 to 9).
//
// The report asks for ZIP centroids from the `zipcodes` npm package, which is not installed and
// dependencies are frozen. So this is deliberately coarse (H): each ZIP is placed at the middle
// of its state, or of its part of a large state, from the first three digits, and the straight
// line between the two is measured. It can be a zone out for nearby pairs; the plan's padding
// absorbs that, and shipByPlan() always offers the carrier's own calculator. Pass a known `zone`
// to shipByPlan() to bypass it.

import { zoneFromMiles } from "./calendar";
import { OFFSHORE_ZONE } from "./config";

type Region = {
  /** First three ZIP digits, inclusive range. */
  from: number;
  to: number;
  /** Where the people in this range mostly are (state or part of a large state). */
  name: string;
  lat: number;
  lon: number;
  /** Alaska, Hawaii, Puerto Rico and the territories: zone 9 from the mainland. */
  offshore?: true;
};

const r = (from: number, to: number, name: string, lat: number, lon: number, offshore?: true): Region =>
  offshore ? { from, to, name, lat, lon, offshore } : { from, to, name, lat, lon };

/** ZIP3 ranges by state (USPS's national ZIP prefix allocation). The first match wins. */
const REGIONS: readonly Region[] = [
  r(5, 5, "New York", 40.8, -73.0),
  r(6, 9, "Puerto Rico", 18.3, -66.3, true),
  r(10, 27, "Massachusetts", 42.3, -71.4),
  r(28, 29, "Rhode Island", 41.8, -71.4),
  r(30, 38, "New Hampshire", 43.2, -71.5),
  r(39, 49, "Maine", 44.4, -69.8),
  r(50, 59, "Vermont", 44.0, -72.7),
  r(60, 69, "Connecticut", 41.6, -72.7),
  r(70, 89, "New Jersey", 40.4, -74.4),
  r(100, 119, "the New York City area", 40.8, -73.9),
  r(120, 149, "upstate New York", 42.9, -76.0),
  r(150, 168, "western Pennsylvania", 40.5, -79.5),
  r(169, 196, "eastern Pennsylvania", 40.2, -75.8),
  r(197, 199, "Delaware", 39.1, -75.5),
  r(200, 205, "Washington, DC", 38.9, -77.0),
  r(206, 219, "Maryland", 39.1, -76.8),
  r(220, 246, "Virginia", 37.7, -77.8),
  r(247, 268, "West Virginia", 38.7, -80.8),
  r(270, 289, "North Carolina", 35.6, -79.6),
  r(290, 299, "South Carolina", 34.0, -81.0),
  r(300, 319, "Georgia", 33.3, -83.9),
  r(320, 329, "northern and central Florida", 28.9, -81.8),
  r(330, 339, "southern Florida", 26.3, -80.5),
  r(341, 349, "central and southwest Florida", 27.6, -81.8),
  r(350, 369, "Alabama", 32.8, -86.8),
  r(370, 385, "Tennessee", 35.8, -86.4),
  r(386, 397, "Mississippi", 32.6, -89.7),
  r(398, 399, "Georgia", 31.6, -84.2),
  r(400, 427, "Kentucky", 37.8, -85.3),
  r(430, 459, "Ohio", 40.2, -82.7),
  r(460, 479, "Indiana", 39.9, -86.2),
  r(480, 499, "Michigan", 42.9, -84.2),
  r(500, 528, "Iowa", 41.9, -93.4),
  r(530, 549, "Wisconsin", 43.8, -89.3),
  r(550, 567, "Minnesota", 45.2, -93.6),
  r(570, 577, "South Dakota", 44.0, -99.0),
  r(580, 588, "North Dakota", 47.4, -99.3),
  r(590, 599, "Montana", 46.8, -111.2),
  r(600, 629, "Illinois", 41.0, -88.6),
  r(630, 658, "Missouri", 38.4, -92.2),
  r(660, 679, "Kansas", 38.5, -97.0),
  r(680, 693, "Nebraska", 41.2, -97.4),
  r(700, 714, "Louisiana", 30.7, -91.5),
  r(716, 729, "Arkansas", 34.9, -92.4),
  r(733, 733, "central and south Texas", 30.3, -97.7), // Austin sits inside Oklahoma's range
  r(730, 749, "Oklahoma", 35.6, -97.0),
  r(750, 769, "north Texas", 32.8, -97.0),
  r(770, 779, "the Houston area", 29.8, -95.4),
  r(780, 789, "central and south Texas", 29.8, -98.2),
  r(790, 799, "west Texas", 32.5, -102.5),
  r(800, 816, "Colorado", 39.5, -105.0),
  r(820, 831, "Wyoming", 42.9, -107.0),
  r(832, 838, "Idaho", 44.0, -115.5),
  r(840, 847, "Utah", 40.6, -111.9),
  r(850, 865, "Arizona", 33.7, -111.9),
  r(870, 884, "New Mexico", 34.6, -106.3),
  r(885, 885, "west Texas", 31.8, -106.4),
  r(889, 891, "southern Nevada", 36.2, -115.2),
  r(893, 898, "northern Nevada", 39.5, -119.0),
  r(900, 935, "southern California", 34.0, -118.0),
  r(936, 961, "northern California", 37.8, -121.9),
  r(967, 968, "Hawaii", 21.3, -157.9, true),
  r(969, 969, "Guam and the Pacific territories", 13.5, 144.8, true),
  r(970, 979, "Oregon", 44.7, -122.6),
  r(980, 994, "Washington", 47.4, -121.8),
  r(995, 999, "Alaska", 61.2, -149.9, true),
];

/** The five-digit ZIP inside what was typed ("98101", "98101-1234", " 98101 "), or null. */
export function parseUsZip(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^\s*(\d{5})(?:[-\s]?\d{4})?\s*$/.exec(value);
  return match ? match[1] : null;
}

function regionOf(zip5: string): Region | null {
  const prefix = Number(zip5.slice(0, 3));
  return REGIONS.find((region) => prefix >= region.from && prefix <= region.to) ?? null;
}

const EARTH_RADIUS_MILES = 3958.8;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

// A second copy of the haversine formula on purpose: the other one lives in
// src/lib/places/airports.ts, which is server-only and loads the 886 kB airport table.
function milesBetween(a: Region, b: Region): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Assumed distance between two different ZIP3 areas of the same region: a long day's drive. */
const SAME_REGION_MILES = 200;
/** Assumed distance inside one ZIP3 area. */
const SAME_AREA_MILES = 30;

export type ZoneEstimate = {
  /** Carrier zone 2 to 8, or 9 for Alaska, Hawaii, Puerto Rico and the territories. */
  zone: number;
  /** Rough straight-line miles, rounded to the nearest 10. */
  miles: number;
  /** True when either end is Alaska, Hawaii, Puerto Rico or a territory and the other is not. */
  offshore: boolean;
  /** "Washington", "northern and central Florida": the areas the two ZIP codes fall in. */
  fromArea: string;
  toArea: string;
};

/**
 * A rough carrier zone from two US ZIP codes, or null when either is missing or is not a US ZIP
 * (a Canadian or UK postcode, a typo). Coarse on purpose: see the note at the top of the file.
 *
 *   estimateZone("98101", "32801")  ->  { zone: 8, miles: 2500, fromArea: "Washington", … }
 */
export function estimateZone(
  originPostalCode: string | null | undefined,
  destinationPostalCode: string | null | undefined,
): ZoneEstimate | null {
  const fromZip = parseUsZip(originPostalCode);
  const toZip = parseUsZip(destinationPostalCode);
  if (!fromZip || !toZip) return null;
  const from = regionOf(fromZip);
  const to = regionOf(toZip);
  if (!from || !to) return null;

  let miles: number;
  if (fromZip.slice(0, 3) === toZip.slice(0, 3)) miles = SAME_AREA_MILES;
  else if (from === to) miles = SAME_REGION_MILES;
  else miles = Math.max(milesBetween(from, to), SAME_AREA_MILES);
  miles = Math.round(miles / 10) * 10;

  const offshore = (from.offshore === true || to.offshore === true) && from !== to;
  return {
    zone: offshore ? OFFSHORE_ZONE : zoneFromMiles(miles),
    miles,
    offshore,
    fromArea: from.name,
    toArea: to.name,
  };
}

/** True when a US ZIP code is in Alaska, Hawaii, Puerto Rico or a territory. False when unknown. */
export function isOffshoreZip(postalCode: string | null | undefined): boolean {
  const zip = parseUsZip(postalCode);
  return zip ? regionOf(zip)?.offshore === true : false;
}
