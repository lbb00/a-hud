/**
 * Turning a window's wall-clock fields into absolute instants.
 *
 * A window is written the way a vendor announces it — "16:30 to 00:30", in some
 * zone, on some weekdays — and every consumer needs the opposite: the epoch
 * seconds it opens and closes around a given moment. That conversion is all
 * this file does. It never reads a file, and it decides nothing about which
 * window applies.
 */
import type { PromotionWindow } from "../promotions.js";

export interface Occurrence {
  window: PromotionWindow;
  startsAt: number;
  endsAt: number;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_ZONE = "UTC";
/** One day back covers a window that started yesterday and crosses midnight;
 * eight days forward always reaches the next occurrence of a weekly schedule. */
const SCAN_DAYS_BACK = 1;
const SCAN_DAYS_FORWARD = 8;

/** Minutes past midnight, or null for anything that is not an "HH:MM" string. */
export function clockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = CLOCK_PATTERN.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * A zone name `Intl` does not know is a typo, not a preference. Reading it as
 * UTC would show hours that are simply wrong, and passing it through throws
 * later, deep inside the window math.
 */
export function knownZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
      .timeZone.length > 0;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(timeZone: string, epochSeconds: number): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1_000));
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function zoneOffsetSeconds(timeZone: string, epochSeconds: number): number {
  const parts = zonedParts(timeZone, epochSeconds);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) / 1_000;
  return asUtc - Math.floor(epochSeconds);
}

/**
 * Converts a wall-clock time in `timeZone` to epoch seconds. The offset is
 * resolved twice because the offset at the reference instant can differ from
 * the offset at the target instant across a DST transition.
 */
function zonedEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  minutes: number,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, minutes) / 1_000;
  const first = naive - zoneOffsetSeconds(timeZone, naive);
  const second = naive - zoneOffsetSeconds(timeZone, first);
  if (second === first) return second;
  // The hour a spring-forward skips is a wall-clock time that never happens, so
  // the second pass lands back before the transition and the window would open
  // an hour early. Shifting forward is what every other clock does with it.
  return zoneOffsetSeconds(timeZone, second) === zoneOffsetSeconds(timeZone, first)
    ? second
    : first;
}

function civilDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
}

export function occurrencesFor(
  window: PromotionWindow,
  now: number,
): Occurrence[] {
  const startMinutes = clockMinutes(window.start);
  const endMinutes = clockMinutes(window.end);
  if (startMinutes == null || endMinutes == null) return [];
  const zone = window.timezone || DEFAULT_ZONE;
  const today = zonedParts(zone, now);
  const base = Date.UTC(today.year, today.month - 1, today.day);
  const occurrences: Occurrence[] = [];
  for (let offset = -SCAN_DAYS_BACK; offset <= SCAN_DAYS_FORWARD; offset += 1) {
    const civil = new Date(base + offset * 86_400_000);
    const year = civil.getUTCFullYear();
    const month = civil.getUTCMonth() + 1;
    const day = civil.getUTCDate();
    if (window.days && !window.days.includes(civil.getUTCDay())) continue;
    const key = civilDateKey(year, month, day);
    if (window.from && key < window.from) continue;
    if (window.until && key > window.until) continue;
    const startsAt = zonedEpoch(zone, year, month, day, startMinutes);
    // A same-or-earlier end time means the window runs into the next day.
    const endsAt = endMinutes > startMinutes
      ? zonedEpoch(zone, year, month, day, endMinutes)
      : zonedEpoch(zone, year, month, day + 1, endMinutes);
    occurrences.push({ window, startsAt, endsAt });
  }
  return occurrences;
}

/**
 * A campaign that runs around the clock arrives here as one occurrence per day,
 * so reporting the end of today's would tell the reader the badge expires
 * tonight. Occurrences that touch are one run, and the run's end is the answer.
 * The scan horizon bounds how far ahead this can see, which understates a long
 * campaign's end rather than inventing one.
 */
export function runEnd(occurrences: Occurrence[], active: Occurrence): number {
  let end = active.endsAt;
  // Occurrences come out in ascending order, so one pass chains the whole run.
  for (const occurrence of occurrences) {
    if (occurrence.startsAt <= end && occurrence.endsAt > end) end = occurrence.endsAt;
  }
  return end;
}
