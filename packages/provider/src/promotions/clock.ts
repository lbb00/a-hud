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
/** How far a run that never pauses is followed. A daily all-day window with no
 * `until` has no end at all; a year out reads as open indefinitely, whereas an
 * infinite instant would make the badge vanish. */
const RUN_CAP_DAYS = 366;

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

interface WindowBounds {
  zone: string;
  startMinutes: number;
  endMinutes: number;
}

function windowBounds(window: PromotionWindow): WindowBounds | null {
  const startMinutes = clockMinutes(window.start);
  const endMinutes = clockMinutes(window.end);
  if (startMinutes == null || endMinutes == null) return null;
  return { zone: window.timezone || DEFAULT_ZONE, startMinutes, endMinutes };
}

/** Midnight UTC of today's calendar date in the window's zone: the day that
 * every offset counts from. */
function scanBase(zone: string, now: number): number {
  const today = zonedParts(zone, now);
  return Date.UTC(today.year, today.month - 1, today.day);
}

/** The window's occurrence `offset` days after `base`, or null on a day the
 * window is closed. */
function occurrenceOn(
  window: PromotionWindow,
  bounds: WindowBounds,
  base: number,
  offset: number,
): Occurrence | null {
  const civil = new Date(base + offset * 86_400_000);
  const year = civil.getUTCFullYear();
  const month = civil.getUTCMonth() + 1;
  const day = civil.getUTCDate();
  if (window.days && !window.days.includes(civil.getUTCDay())) return null;
  const key = civilDateKey(year, month, day);
  if (window.from && key < window.from) return null;
  if (window.until && key > window.until) return null;
  const startsAt = zonedEpoch(bounds.zone, year, month, day, bounds.startMinutes);
  // A same-or-earlier end time means the window runs into the next day.
  const endsAt = bounds.endMinutes > bounds.startMinutes
    ? zonedEpoch(bounds.zone, year, month, day, bounds.endMinutes)
    : zonedEpoch(bounds.zone, year, month, day + 1, bounds.endMinutes);
  return { window, startsAt, endsAt };
}

export function occurrencesFor(
  window: PromotionWindow,
  now: number,
): Occurrence[] {
  const bounds = windowBounds(window);
  if (!bounds) return [];
  const base = scanBase(bounds.zone, now);
  const occurrences: Occurrence[] = [];
  for (let offset = -SCAN_DAYS_BACK; offset <= SCAN_DAYS_FORWARD; offset += 1) {
    const occurrence = occurrenceOn(window, bounds, base, offset);
    if (occurrence) occurrences.push(occurrence);
  }
  return occurrences;
}

/**
 * A campaign that runs around the clock arrives here as one occurrence per day,
 * so reporting the end of today's would tell the reader the badge expires
 * tonight. Occurrences that touch are one run, and the run's end is the answer.
 * The scan stops eight days out, which is no answer for a month-long campaign,
 * so a run still open at the horizon is followed day by day until it pauses,
 * its `until` passes, or the cap is reached.
 */
export function runEnd(
  occurrences: Occurrence[],
  active: Occurrence,
  now: number,
): number {
  let end = active.endsAt;
  // Occurrences come out in ascending order, so one pass chains the whole run.
  for (const occurrence of occurrences) {
    if (occurrence.startsAt <= end && occurrence.endsAt > end) end = occurrence.endsAt;
  }
  const bounds = windowBounds(active.window);
  if (!bounds) return end;
  const base = scanBase(bounds.zone, now);
  for (let offset = SCAN_DAYS_FORWARD + 1; offset <= RUN_CAP_DAYS; offset += 1) {
    const next = occurrenceOn(active.window, bounds, base, offset);
    if (!next || next.startsAt > end) break;
    if (next.endsAt > end) end = next.endsAt;
  }
  return end;
}
