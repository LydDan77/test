// Clock formatting: one instant, shown the way the product shows every time.
// 12-hour time first. On the world clock the 24-hour "military" time sits smaller beneath it
// with the zone abbreviation (`1441 PST`); everywhere else that line appears only for a person
// who turned on "24-hour time everywhere" (product spec 3.4, users.show24hEverywhere).
// Pure. No React here: components take these strings and lay them out.

import { MINUS } from "./symbols";
import { offsetMinutes, toEpochMs, utcToZoned, type InstantInput } from "./zoned";

/** users.timeStyle */
export type TimeStyle = "12h_with_24h" | "12h" | "24h";
/** users.militaryStyle: four digits with no colon, or with one. */
export type MilitaryStyle = "1441" | "14:41";

/**
 * Where a time is shown.
 *  - "clock": a world clock (Home, the clock on a share page). The 24-hour line is always on.
 *  - "elsewhere": a schedule row, the arrivals board, a booking, anything else. The 24-hour line
 *    is on only when the person asked for it everywhere.
 */
export type ClockContext = "clock" | "elsewhere";

export type ClockOptions = {
  /** Default "12h_with_24h". */
  style?: TimeStyle;
  /** Default "1441". */
  militaryStyle?: MilitaryStyle;
  /** Default "elsewhere": the 24-hour line is NOT shown unless `show24hEverywhere` is true. */
  context?: ClockContext;
  /** users.show24hEverywhere. Default false. */
  show24hEverywhere?: boolean;
};

/**
 * The options for formatClock from the signed-in person's settings, so no screen has to
 * remember the rule about the 24-hour line:
 *
 *   formatClock(arrival.at, arrival.tz, clockOptionsFor(user, "elsewhere")).secondary   // null unless they asked
 *   formatClock(now, clock.place.tz, clockOptionsFor(user, "clock")).secondary          // "1441 PST"
 *
 * Pass `null` for a visitor with no account (a share page): the defaults apply.
 */
export function clockOptionsFor(
  user: { timeStyle: TimeStyle; militaryStyle: MilitaryStyle; show24hEverywhere: boolean } | null | undefined,
  context: ClockContext,
): ClockOptions {
  if (!user) return { context };
  return { style: user.timeStyle, militaryStyle: user.militaryStyle, show24hEverywhere: user.show24hEverywhere, context };
}

export type ClockReading = {
  /** The 12-hour parts. `text` is "2:41 PM" (a normal space; set `white-space: nowrap`). */
  h12: { hour: number; minute: number; period: "AM" | "PM"; time: string; text: string };
  /** The 24-hour time in both military styles: "1441" and "14:41". Midnight is 0000, never 2400. */
  h24: { hour: number; minute: number; compact: string; colon: string };
  second: number;
  /** Zone abbreviation at that instant: "PST", "CEST", "GMT+5:45" when the zone has none. */
  zone: string;
  /** Local calendar date at that instant, `YYYY-MM-DD`. */
  date: string;
  /** Offset from UTC in minutes, east positive. */
  offsetMinutes: number;
  /** The line to show largest, per `style`: "2:41 PM", or "14:41" / "1441" in 24-hour style. */
  primary: string;
  /**
   * The smaller line beneath: "1441 PST" (or "14:41 PST"). Null when there is none to show:
   * the style has no second line, or this is not a world clock and the person has not turned
   * on 24-hour time everywhere (see ClockContext). Show it whenever it is not null.
   */
  secondary: string | null;
  /** The 24-hour line with its zone regardless of style: "1441 PST". A UTC clock reads "1441Z". */
  military: string;
};

const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Zulu", "Zulu", "Etc/UCT", "UCT"]);

// ICU only abbreviates a zone in locales where the abbreviation is in everyday use: en-US knows
// PST and EST but prints London's summer time as "GMT+1"; en-GB knows BST and CET; en-AU knows
// AEDT. So ask a few English locales in turn and take the first real abbreviation.
const ABBREVIATION_LOCALES = ["en-US", "en-CA", "en-GB", "en-AU", "en-IN", "en-ZA", "en-SG", "ja-JP"];
const REAL_ABBREVIATION = /^[A-Z]{2,5}$/;

const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneNameFormatter(locale: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  let f = zoneNameFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" });
    zoneNameFormatters.set(key, f);
  }
  return f;
}

const abbreviationCache = new Map<string, string>();

/**
 * The abbreviation people use for `tz` at `instant`: "PST" / "PDT", "GMT" / "BST", "CET" / "CEST",
 * "AEDT", "IST", "JST". Zones with no abbreviation in common use give their offset instead,
 * with a real minus sign: "GMT+7", "GMT+5:45", "GMT−3". UTC gives "UTC".
 */
export function zoneAbbreviation(instant: InstantInput, tz: string): string {
  if (UTC_ZONES.has(tz)) return "UTC";
  const ms = toEpochMs(instant);
  // Offsets change on quarter-hour boundaries, so one answer per zone per quarter hour is enough.
  const key = `${tz}|${Math.floor(ms / 900_000)}`;
  const cached = abbreviationCache.get(key);
  if (cached !== undefined) return cached;

  let result: string | undefined;
  for (const locale of ABBREVIATION_LOCALES) {
    const name = zoneNameFormatter(locale, tz)
      .formatToParts(ms)
      .find((part) => part.type === "timeZoneName")?.value;
    if (name && REAL_ABBREVIATION.test(name)) {
      result = name;
      break;
    }
  }
  result ??= offsetLabel(offsetMinutes(ms, tz));

  if (abbreviationCache.size > 2000) abbreviationCache.clear();
  abbreviationCache.set(key, result);
  return result;
}

/** "GMT+7", "GMT+5:45", "GMT−3", "GMT" for an offset in minutes. */
function offsetLabel(minutes: number): string {
  if (minutes === 0) return "GMT";
  const abs = Math.abs(minutes);
  const m = abs % 60;
  return `GMT${minutes > 0 ? "+" : MINUS}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Everything needed to show `instant` on the clocks of `tz`.
 *
 *   const c = formatClock("2026-12-19T22:41:00Z", "America/Los_Angeles");
 *   c.h12.text   // "2:41 PM"
 *   c.h24.compact // "1441"      c.h24.colon // "14:41"
 *   c.zone       // "PST"
 *   c.primary    // "2:41 PM"    c.secondary // null: not a world clock
 *   formatClock(at, tz, { context: "clock" }).secondary // "1441 PST"
 *
 * The options come from the signed-in user: build them with clockOptionsFor(user, context).
 * They only choose what `primary` and `secondary` say; the parts are always all there.
 */
export function formatClock(
  instant: InstantInput,
  tz: string,
  options: ClockOptions = {},
): ClockReading {
  const style = options.style ?? "12h_with_24h";
  const militaryStyle = options.militaryStyle ?? "1441";
  const show24h = (options.context ?? "elsewhere") === "clock" || options.show24hEverywhere === true;
  const z = utcToZoned(instant, tz);

  const period = z.hour < 12 ? "AM" : "PM";
  const hour12 = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const time12 = `${hour12}:${pad2(z.minute)}`;
  const compact = `${pad2(z.hour)}${pad2(z.minute)}`;
  const colon = `${pad2(z.hour)}:${pad2(z.minute)}`;
  const zone = zoneAbbreviation(instant, tz);

  const digits = militaryStyle === "1441" ? compact : colon;
  // Aviation and military writing put Z straight after the digits for UTC: 1441Z.
  const military = zone === "UTC" ? `${digits}Z` : `${digits} ${zone}`;

  return {
    h12: { hour: hour12, minute: z.minute, period, time: time12, text: `${time12} ${period}` },
    h24: { hour: z.hour, minute: z.minute, compact, colon },
    second: z.second,
    zone,
    date: z.date,
    offsetMinutes: z.offsetMinutes,
    primary: style === "24h" ? digits : `${time12} ${period}`,
    secondary: style === "12h_with_24h" && show24h ? military : null,
    military,
  };
}

/** "2h 5m", "45m", "3h", "1d 2h" for a length of time in minutes (rounded to the minute). */
export function formatDuration(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < 60) return `${minutes}m`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (rest) parts.push(`${rest}m`);
  return parts.join(" ");
}
