// Sunrise and sunset from latitude and longitude, using the sunrise equation
// (https://en.wikipedia.org/wiki/Sunrise_equation). Pure arithmetic: no network, no data.
// Accurate to about two minutes at ordinary latitudes, which is what a day strip needs.
// sun.test.ts checks it against an independent implementation of NOAA's solar calculator.

import { isLocalDate } from "./dates";
import { isValidTimeZone, zonedToUtc } from "./zoned";

export type SunTimes = {
  /**
   * "normal": the sun rises and sets. "polar_day": it stays up all day (midnight sun).
   * "polar_night": it never rises.
   */
  kind: "normal" | "polar_day" | "polar_night";
  /** Null on a polar day or a polar night. */
  sunrise: Date | null;
  /** Null on a polar day or a polar night. Can fall after local midnight in a far-north summer. */
  sunset: Date | null;
  /** When the sun is highest. Always present. */
  solarNoon: Date;
  /** Minutes between sunrise and sunset: 1440 on a polar day, 0 on a polar night. */
  daylightMinutes: number;
};

const RAD = Math.PI / 180;
const J2000 = 2451545.0;
const UNIX_EPOCH_JD = 2440587.5;
const DAY_MS = 86_400_000;
/** The sun's centre is this far below the horizon at sunrise: refraction plus its radius. */
const HORIZON_DEGREES = -0.833;

const sinDeg = (deg: number) => Math.sin(deg * RAD);
const cosDeg = (deg: number) => Math.cos(deg * RAD);
const mod360 = (deg: number) => ((deg % 360) + 360) % 360;
const julianToDate = (jd: number) => new Date(Math.round((jd - UNIX_EPOCH_JD) * DAY_MS));

/**
 * Sunrise, sunset and solar noon for the local calendar `date` (`YYYY-MM-DD`) at a place.
 *
 * `tz` is the place's IANA zone. It decides which solar day belongs to `date`: the one whose
 * noon is nearest to 12:00 on the local clock. That matters where the clock runs far from the
 * sun (Kiritimati keeps UTC+14 at a longitude that suggests UTC−10.5).
 *
 * Returns instants; format them with formatClock(instant, tz).
 * Throws RangeError when latitude, longitude, date or zone is not valid.
 */
export function sunTimes(lat: number, lon: number, date: string, tz: string): SunTimes {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError(`Invalid latitude: ${lat}`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new RangeError(`Invalid longitude: ${lon}`);
  if (!isLocalDate(date)) throw new RangeError(`Invalid local date: ${date}`);
  if (!isValidTimeZone(tz)) throw new RangeError(`Invalid time zone: ${tz}`);

  // Julian date of 12:00 on the local clock that day.
  const localNoon = zonedToUtc(`${date}T12:00`, tz);
  const noonJd = localNoon.getTime() / DAY_MS + UNIX_EPOCH_JD;

  // The whole day number whose mean solar noon at this longitude is nearest to local noon.
  const n = Math.round(noonJd - J2000 + lon / 360);
  const meanSolarNoon = n - lon / 360;

  const meanAnomaly = mod360(357.5291 + 0.98560028 * meanSolarNoon);
  const center =
    1.9148 * sinDeg(meanAnomaly) + 0.02 * sinDeg(2 * meanAnomaly) + 0.0003 * sinDeg(3 * meanAnomaly);
  const eclipticLongitude = mod360(meanAnomaly + center + 180 + 102.9372);
  const transit =
    J2000 + meanSolarNoon + 0.0053 * sinDeg(meanAnomaly) - 0.0069 * sinDeg(2 * eclipticLongitude);

  const sinDeclination = sinDeg(eclipticLongitude) * sinDeg(23.4397);
  const cosDeclination = Math.sqrt(1 - sinDeclination * sinDeclination);

  // Exactly at a pole cos(latitude) is zero and the hour angle is undefined; step a hair inside.
  const latitude = Math.max(-89.9999, Math.min(89.9999, lat));
  const cosHourAngle =
    (sinDeg(HORIZON_DEGREES) - sinDeg(latitude) * sinDeclination) / (cosDeg(latitude) * cosDeclination);

  const solarNoon = julianToDate(transit);
  if (cosHourAngle >= 1) {
    return { kind: "polar_night", sunrise: null, sunset: null, solarNoon, daylightMinutes: 0 };
  }
  if (cosHourAngle <= -1) {
    return { kind: "polar_day", sunrise: null, sunset: null, solarNoon, daylightMinutes: 1440 };
  }

  const hourAngle = Math.acos(cosHourAngle) / RAD; // degrees
  const sunrise = julianToDate(transit - hourAngle / 360);
  const sunset = julianToDate(transit + hourAngle / 360);
  return {
    kind: "normal",
    sunrise,
    sunset,
    solarNoon,
    daylightMinutes: Math.round((sunset.getTime() - sunrise.getTime()) / 60_000),
  };
}
