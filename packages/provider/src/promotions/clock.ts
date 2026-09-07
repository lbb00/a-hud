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
 *
 * The scan stops eight days out, which is no answer for a month-long campaign.
 * A run still open past the horizon can only be a window whose end equals its
 * start, since any other shape leaves a gap between one day and the next, and
 * such a window is open every day it is allowed on: its run ends with its last
 * allowed day, `until`, and with no `until` it has no end at all. That case is
 * null, never a date, because any date would be an invention.
 */
export function runEnd(
  occurrences: Occurrence[],
  active: Occurrence,
  now: number,
): number | null {
  let end = active.endsAt;
  // Occurrences come out in ascending order, so one pass chains the whole run.
  for (const occurrence of occurrences) {
    if (occurrence.startsAt <= end && occurrence.endsAt > end) end = occurrence.endsAt;
  }
  const bounds = windowBounds(active.window);
  if (!bounds) return end;
  const base = scanBase(bounds.zone, now);
  // The scan covers every weekday, so a run that reaches the day past the
  // horizon has no `days` gap to run into; only `until` can still stop it.
  const beyond = occurrenceOn(active.window, bounds, base, SCAN_DAYS_FORWARD + 1);
  if (!beyond || beyond.startsAt > end) return end;
  const until = civilDate(active.window.until);
  if (!until) return null;
  const last = occurrenceOn(
    active.window,
    bounds,
    base,
    Math.round((until - base) / 86_400_000),
  );
  return last ? last.endsAt : end;
}

/** Midnight UTC of a "YYYY-MM-DD" bound, or null for anything else. */
function civilDate(value: string | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
