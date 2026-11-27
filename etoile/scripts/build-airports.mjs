// Generates src/data/airports.json from the `airport-data-js` npm package (data licence: CC BY 4.0).
// Run with `npm run data:airports` after bumping airport-data-js; commit the result.
//
// Why generate instead of importing the package at runtime:
//  - its time-zone column is wrong for about 1.7% of IATA airports (checked against the
//    coordinates), so the zone is re-derived here from latitude/longitude with geo-tz;
//  - the app needs 8 fields, not 21, and no tracker URLs;
//  - the output is plain JSON with no runtime dependency.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { findAirports } from "airport-data-js/lite"; // every airport that has an IATA code
import { find } from "geo-tz/all"; // IANA zone(s) whose boundary contains a coordinate. "/all" = no zones merged

const require = createRequire(import.meta.url);
const version = require("airport-data-js/package.json").version;
const airports = await findAirports({}); // empty filter = all 10k rows

const probes = [new Date("2026-01-15T12:00:00Z"), new Date("2026-07-15T12:00:00Z")];
const formatters = new Map();
function offset(timeZone, date) {
  let f = formatters.get(timeZone);
  if (!f) formatters.set(timeZone, (f = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })));
  return f.formatToParts(date).find((p) => p.type === "timeZoneName").value;
}
const sameClock = (a, b) => probes.every((d) => offset(a, d) === offset(b, d));

// CLDR's list of zones per country, via Intl. Node 22 has the `timeZones` accessor; newer
// engines have getTimeZones(). Both sides are canonicalised the same way before comparing
// (Node 22 reports Asia/Kolkata as "Asia/Calcutta").
const canonical = (z) => new Intl.DateTimeFormat("en", { timeZone: z }).resolvedOptions().timeZone;
const zoneCache = new Map();
function zonesOf(country) {
  let set = zoneCache.get(country);
  if (!set) {
    const locale = new Intl.Locale(`und-${country}`);
    const zones = locale.getTimeZones?.() ?? locale.timeZones ?? [];
    zoneCache.set(country, (set = new Set(zones.map(canonical))));
  }
  return set;
}

const rank = { large_airport: 3, medium_airport: 2, small_airport: 1 };
const rows = [];
const corrected = [];
const suspicious = [];

for (const a of airports) {
  const iata = a.iata;
  if (!/^[A-Z0-9]{3}$/.test(iata ?? "")) continue;
  const lat = a.latitude;
  const lon = a.longitude;
  let tz = a.time;

  // geo-tz returns every zone whose boundary contains the point (more than one on a border).
  const byPosition = find(lat, lon).filter((z) => !z.startsWith("Etc/"));
  if (byPosition.length === 0) {
    // Open sea according to the boundaries: an islet or bad coordinates. Keep the source zone.
    suspicious.push(`${iata} ${a.airport} (${a.country_code}): no land zone at ${lat},${lon}; kept ${tz}`);
  } else if (!byPosition.some((z) => z === tz || sameClock(z, tz))) {
    // The source zone keeps a different wall clock than the place the airport stands on.
    // Trust the coordinates only if they point at a zone of the airport's own country;
    // otherwise the coordinates are the likelier error (border airports, typos).
    const local = byPosition.find((z) => zonesOf(a.country_code).has(canonical(z)));
    if (local) {
      corrected.push(`${iata} ${a.airport} (${a.country_code}): ${tz} -> ${local}`);
      tz = local;
    } else {
      suspicious.push(`${iata} ${a.airport} (${a.country_code}): coordinates fall in ${byPosition.join("/")}; kept ${tz}`);
    }
  }

  const scheduled = a.scheduled_service === "TRUE";
  rows.push([
    iata,
    a.airport,
    a.city || "",
    a.country_code,
    lat,
    lon,
    tz,
    // 0..7: size in the upper bits, scheduled passenger service in the lowest. Used to order search results.
    (rank[a.type] ?? 0) * 2 + (scheduled ? 1 : 0),
    // IATA metropolitan-area code shared by a city's airports (NYC for JFK/LGA/EWR, LON, TYO…).
    a.city_code && a.city_code !== iata ? a.city_code : "",
  ]);
}

rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
const out = {
  source: `airport-data-js@${version} (CC BY 4.0), time zones re-derived with geo-tz`,
  generatedAt: new Date().toISOString().slice(0, 10),
  fields: ["iata", "name", "city", "country", "lat", "lon", "timeZone", "rank", "metro"],
  rows,
};
const file = new URL("../src/data/airports.json", import.meta.url);
writeFileSync(file, JSON.stringify(out));
console.log(`${rows.length} airports written to src/data/airports.json`);
console.log(`scheduled service: ${rows.filter((r) => r[7] % 2 === 1).length}; large: ${rows.filter((r) => r[7] >= 6).length}; without city: ${rows.filter((r) => !r[2]).length}`);
console.log(`time zone corrected from coordinates: ${corrected.length}`);
console.log(`left as-is, coordinates look wrong or offshore: ${suspicious.length}`);
if (process.argv.includes("--verbose")) console.log([...corrected, ...suspicious].join("\n"));
