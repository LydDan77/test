// Wall clock in a zone <-> UTC instant, built on Intl.DateTimeFormat only (no library, no tz
// database to ship). Pure: safe in Server and Client Components and in tests.
// Node 22 has no global Temporal, so this module is the app's one place for zone arithmetic;
// zoned.test.ts checks it against temporal-polyfill (a dev-only oracle).

/** A wall-clock reading with no zone attached: what a ticket or a hotel confirmation prints. */
export type LocalDateTime = {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second?: number;
};

/** An instant in any of the forms the app passes around: Date, epoch milliseconds, ISO string. */
export type InstantInput = Date | number | string;

/** What the clocks in one zone show at one instant. */
export type ZonedDateTime = Required<LocalDateTime> & {
  /** The IANA zone this reading belongs to, exactly as it was passed in. */
  tz: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Local time of day, `HH:mm` (24-hour). */
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Offset from UTC in minutes, east positive (Tokyo 540, New York in winter -300). */
  offsetMinutes: number;
};

/** How to resolve a wall-clock reading that happens twice or never (see zonedToUtc). */
export type Disambiguation = "compatible" | "earlier" | "later" | "reject";

const DAY_MS = 86_400_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/**
 * True for any id Intl accepts ("Asia/Kolkata", "UTC", "+05:30"). Do not test against
 * Intl.supportedValuesOf("timeZone"): it lists legacy names (Asia/Calcutta) and omits UTC.
 */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * True for a zone id fit to STORE: a region/city id such as "America/Chicago", or "UTC".
 * Stricter than isValidTimeZone on purpose. Intl also accepts abbreviations such as "EST" and
 * "PST", but "EST" is a fixed UTC-5 with no daylight saving: saved with a place, it would show
 * the wrong time all summer. Zones come from places (the airport table, the browser), which
 * always give region/city ids.
 */
export function isIanaTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string") return false;
  if (timeZone !== "UTC" && !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(timeZone)) return false;
  return isValidTimeZone(timeZone);
}

/** Epoch milliseconds for any InstantInput. Throws RangeError on an unparseable value. */
export function toEpochMs(instant: InstantInput): number {
  const ms =
    typeof instant === "number"
      ? instant
      : typeof instant === "string"
        ? Date.parse(instant)
        : instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid instant: ${String(instant)}`);
  return ms;
}

/** A Date for any InstantInput. Throws RangeError on an unparseable value. */
export function toDate(instant: InstantInput): Date {
  return new Date(toEpochMs(instant));
}

function wallParts(ms: number, timeZone: string): Required<LocalDateTime> {
  const out: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function asUtcMs(l: LocalDateTime): number {
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second ?? 0);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad4 = (n: number) => String(n).padStart(4, "0");

/** Offset from UTC in minutes at `instant` (east positive: Tokyo = 540, New York in winter = -300). */
export function offsetMinutes(instant: InstantInput, timeZone: string): number {
  const ms = toEpochMs(instant);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return (asUtcMs(wallParts(wholeSecond, timeZone)) - wholeSecond) / 60_000;
}

/** The wall clock shown in `tz` at `instant`, with the local date, weekday and offset. */
export function utcToZoned(instant: InstantInput, tz: string): ZonedDateTime {
  const ms = toEpochMs(instant);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  const parts = wallParts(wholeSecond, tz);
  const wallMs = asUtcMs(parts);
  return {
    ...parts,
    tz,
    date: `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`,
    time: `${pad2(parts.hour)}:${pad2(parts.minute)}`,
    weekday: new Date(wallMs).getUTCDay(),
    offsetMinutes: (wallMs - wholeSecond) / 60_000,
  };
}

/**
 * "2026-12-01T09:30" (what <input type="datetime-local"> produces), with optional seconds and a
 * space instead of the T, to a LocalDateTime. Returns null for anything else, including dates
 * that do not exist (2026-02-30) and times past 23:59:59.
 */
export function parseLocalDateTime(value: string): LocalDateTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const local = { year, month, day, hour, minute, second };
  if (!isRealLocalDateTime(local)) return null;
  return local;
}

function isRealLocalDateTime(l: LocalDateTime): boolean {
  const second = l.second ?? 0;
  if (![l.year, l.month, l.day, l.hour, l.minute, second].every(Number.isInteger)) return false;
  if (l.hour < 0 || l.hour > 23 || l.minute < 0 || l.minute > 59 || second < 0 || second > 59) {
    return false;
  }
  // Date.UTC silently rolls 2026-02-30 over to March; reject it instead.
  const check = new Date(Date.UTC(l.year, l.month - 1, l.day));
  return (
    check.getUTCFullYear() === l.year &&
    check.getUTCMonth() + 1 === l.month &&
    check.getUTCDate() === l.day
  );
}

/** LocalDateTime to "2026-12-01T09:30" (seconds are added only when they are not zero). */
export function formatLocalDateTime(l: LocalDateTime): string {
  const base = `${pad4(l.year)}-${pad2(l.month)}-${pad2(l.day)}T${pad2(l.hour)}:${pad2(l.minute)}`;
  return l.second ? `${base}:${pad2(l.second)}` : base;
}

function toLocalDateTime(local: LocalDateTime | string): LocalDateTime {
  if (typeof local !== "string") {
    if (!isRealLocalDateTime(local)) {
      throw new RangeError(`Not a real local date-time: ${JSON.stringify(local)}`);
    }
    return local;
  }
  const parsed = parseLocalDateTime(local);
  if (!parsed) throw new RangeError(`Not a local date-time (YYYY-MM-DDTHH:mm): ${local}`);
  return parsed;
}

/** The instants (zero, one or two, earliest first) at which the clocks in `tz` read `local`. */
function instantsFor(local: LocalDateTime, tz: string): { matches: number[]; before: number } {
  const wall = asUtcMs(local);
  // Offsets a day either side. A zone changes its offset at most once in that window, so the
  // two values are the offsets before and after any transition near this reading.
  const before = offsetMinutes(wall - DAY_MS, tz) * 60_000;
  const after = offsetMinutes(wall + DAY_MS, tz) * 60_000;
  const candidates = before === after ? [wall - before] : [wall - before, wall - after];
  const matches = candidates
    .filter((t) => asUtcMs(wallParts(t, tz)) === wall)
    .sort((a, b) => a - b);
  return { matches, before };
}

/**
 * Whether a wall-clock reading in `tz` is ordinary, happens twice (clocks went back) or never
 * happens (clocks went forward). Use it to warn a person before saving such a time.
 */
export function localTimeKind(
  local: LocalDateTime | string,
  tz: string,
): "valid" | "ambiguous" | "gap" {
  const { matches } = instantsFor(toLocalDateTime(local), tz);
  return matches.length === 0 ? "gap" : matches.length === 1 ? "valid" : "ambiguous";
}

/**
 * The instant at which the clocks in `tz` read `local`.
 *
 * Twice a year that question has no single answer. The default follows Temporal's "compatible"
 * rule, which is what calendars and airlines do:
 *  - the reading occurs twice (clocks go back): the first occurrence;
 *  - the reading never occurs (clocks go forward): the same distance after the gap
 *    (02:30 on a spring-forward night becomes 03:30).
 * "earlier" and "later" pick a side in both cases; "reject" throws a RangeError instead.
 *
 * `local` may be a LocalDateTime or a string such as "2026-12-01T09:30". Throws RangeError on a
 * reading that is not a real date and time, or a zone Intl does not know.
 */
export function zonedToUtc(
  local: LocalDateTime | string,
  tz: string,
  options: { disambiguation?: Disambiguation } = {},
): Date {
  const reading = toLocalDateTime(local);
  const mode = options.disambiguation ?? "compatible";
  const wall = asUtcMs(reading);
  const { matches, before } = instantsFor(reading, tz);

  if (matches.length === 1) return new Date(matches[0]);
  if (mode === "reject") {
    throw new RangeError(
      `${formatLocalDateTime(reading)} ${matches.length === 0 ? "does not exist" : "happens twice"} in ${tz}`,
    );
  }
  if (matches.length === 2) {
    return new Date(mode === "later" ? matches[1] : matches[0]);
  }
  // In a gap. Reading the wall time with the offset from before the change lands after the gap
  // (02:30 -> 03:30); with the offset from after the change it lands before it (02:30 -> 01:30).
  const after = offsetMinutes(wall + DAY_MS, tz) * 60_000;
  return new Date(mode === "earlier" ? wall - after : wall - before);
}

/**
 * Whole calendar days from the date shown in zoneA at `a` to the date shown in zoneB at `b`.
 * A flight leaving Sydney on the 3rd and landing in Los Angeles on the 3rd gives 0; one landing
 * the next morning gives 1. The "+1" beside an arrival time uses this.
 */
export function calendarDayDifference(
  a: InstantInput,
  zoneA: string,
  b: InstantInput,
  zoneB: string,
): number {
  const la = utcToZoned(a, zoneA);
  const lb = utcToZoned(b, zoneB);
  return Math.round(
    (Date.UTC(lb.year, lb.month - 1, lb.day) - Date.UTC(la.year, la.month - 1, la.day)) / DAY_MS,
  );
}

const LEGACY_CITY_NAMES: Record<string, string> = {
  Calcutta: "Kolkata",
  Saigon: "Ho Chi Minh City",
  Ho_Chi_Minh: "Ho Chi Minh City",
  Kiev: "Kyiv",
  Rangoon: "Yangon",
  Katmandu: "Kathmandu",
  Godthab: "Nuuk",
  Faeroe: "Faroe Islands",
  Faroe: "Faroe Islands",
  Truk: "Chuuk",
  Ponape: "Pohnpei",
  Asmera: "Asmara",
  Thimbu: "Thimphu",
  Ujung_Pandang: "Makassar",
  Macao: "Macau",
  St_Johns: "St. John's",
  St_Kitts: "St. Kitts",
  St_Lucia: "St. Lucia",
  St_Thomas: "St. Thomas",
  St_Vincent: "St. Vincent",
  St_Helena: "St. Helena",
  DumontDUrville: "Dumont d'Urville",
};

/**
 * A readable place name for a zone id: "America/Los_Angeles" gives "Los Angeles",
 * "America/Argentina/Buenos_Aires" gives "Buenos Aires", "Asia/Calcutta" gives "Kolkata".
 * Only a starting point (a zone covers many cities); the person can rename it.
 */
export function zoneCityName(tz: string): string {
  if (tz === "UTC" || tz === "Etc/UTC" || tz === "Etc/GMT" || tz === "GMT") return "UTC";
  const last = tz.split("/").pop() ?? tz;
  return LEGACY_CITY_NAMES[last] ?? last.replace(/_/g, " ");
}
