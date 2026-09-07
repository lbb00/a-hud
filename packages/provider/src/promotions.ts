import path from "node:path";
import { resolveBaseDir, safeText } from "./io.js";
import {
  readSharedDocument,
  readSmallFile,
  sharedCacheStale,
  type SharedPromotionOrigin,
} from "./promotions/remote.js";
import {
  clockMinutes,
  knownZone,
  occurrencesFor,
  type Occurrence,
  runEnd,
} from "./promotions/clock.js";
import type { Platform } from "./types.js";

/**
 * Promotional usage windows are vendor campaigns: they start, change and end
 * without notice, and no host reports them through any status payload. The
 * provider measures nothing here — it reads two schedules and answers two
 * factual questions: is a window open right now, and when does that change.
 *
 * The schedules are the shared one maintained in the repository (fetched into a
 * local cache, falling back to the copy bundled at publish time) and the user's
 * own config file, which wins wherever the two disagree.
 *
 * Window boundaries are absolute epoch seconds. Config hours default to UTC so
 * they can be copied from a vendor announcement unchanged, and every consumer
 * renders them in the reader's own zone.
 */
export interface PromotionWindow {
  id: string;
  /** Short user-chosen badge text, e.g. "50%". */
  label: string;
  /** Hosts this window applies to. Omitted means every host. */
  platforms?: Platform[];
  /**
   * API endpoint host names this window applies to, e.g. "api.deepseek.com".
   *
   * Off-peak pricing belongs to the API a request is billed on, not to the
   * host program running it: the same host reaches a discounted endpoint with
   * one model and an undiscounted one with the next, and a proxy or reseller
   * in front of the same models is not covered by the vendor's campaign.
   * Unlike `platforms`, a window naming endpoints stays hidden whenever the
   * caller cannot say which endpoint is in use, because a host that cannot
   * tell must not claim the discount.
   */
  endpoints?: string[];
  /**
   * IANA zone the clock times are written in. Omitted means UTC, which is how
   * vendors publish campaign hours; the HUD converts to the reader's own zone.
   */
  timezone?: string;
  /** Weekdays the window starts on, 0 = Sunday. Omitted means every day. */
  days?: number[];
  /** "HH:MM" local start. */
  start: string;
  /** "HH:MM" local end; an end at or before the start crosses midnight. */
  end: string;
  /** Inclusive "YYYY-MM-DD" campaign bounds. */
  from?: string;
  until?: string;
}

export interface PromotionStatus {
  id: string;
  label: string;
  /** True when the window is open at the observed time. */
  active: boolean;
  /** Epoch seconds when an open window closes, or a pending window opens.
   * Null for an open window with no end date, which has nothing to count
   * down to. */
  changesAt: number | null;
}

const CONFIG_FILE_NAME = "config.json";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_WINDOWS = 64;
const MAX_ENDPOINT_LENGTH = 200;
/** Sixty-four windows of JSON is a few kilobytes; past this the file is not a config. */
const MAX_CONFIG_BYTES = 64 * 1024;
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.AGENT_HUD_CONFIG ||
    path.join(resolveBaseDir(env), CONFIG_FILE_NAME);
}

/**
 * Every field is coerced by type, never by `String()`: the schedule is data
 * other people edit, and `String()` on a deeply nested array from a fetched
 * document throws before any of this can reject it.
 */
function normalizeDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = value
    .map((entry) => {
      if (typeof entry === "number") {
        return Number.isInteger(entry) && entry >= 0 && entry <= 6 ? entry : -1;
      }
      if (typeof entry !== "string") return -1;
      return WEEKDAY_NAMES.indexOf(entry.slice(0, 3).toLowerCase());
    })
    .filter((day) => day >= 0);
  return days.length ? [...new Set(days)] : undefined;
}

function dateBound(value: unknown): string | null {
  return typeof value === "string" && DATE_PATTERN.test(value) ? value : null;
}

/**
 * The host part of an API base URL, which is what a window can be matched on.
 * Callers pass whatever their host hands them — a full base URL with a path,
 * or a bare host — and both sides of the comparison go through here.
 */
export function endpointHost(value: unknown): string {
  const text = safeText(value, MAX_ENDPOINT_LENGTH + 1);
  if (!text || text.length > MAX_ENDPOINT_LENGTH) return "";
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `https://${text}`,
    );
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      return "";
    }
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * A field that narrows a window — the hosts, the endpoints, the weekdays, the
 * campaign dates, the zone — is dropped along with its window when it is
 * present but unusable.
 * Reading it as "not set" would do the opposite of what it was written for and
 * show the badge everywhere, every day.
 */
function normalizeWindow(value: unknown, index: number): PromotionWindow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.enabled === false) return null;
  if (clockMinutes(raw.start) == null || clockMinutes(raw.end) == null) return null;
  const window: PromotionWindow = {
    id: safeText(raw.id, 64) || `promotion-${index + 1}`,
    label: safeText(raw.label, 8),
    start: raw.start as string,
    end: raw.end as string,
  };
  if (raw.timezone !== undefined) {
    const timezone = safeText(raw.timezone, 64);
    if (!timezone || !knownZone(timezone)) return null;
    window.timezone = timezone;
  }
  if (raw.platforms !== undefined) {
    if (!Array.isArray(raw.platforms)) return null;
    const platforms = raw.platforms
      .map((entry) => safeText(entry, 16))
      .filter(Boolean) as Platform[];
    if (!platforms.length) return null;
    window.platforms = platforms;
  }
  if (raw.endpoints !== undefined) {
    if (!Array.isArray(raw.endpoints)) return null;
    const endpoints = raw.endpoints.map(endpointHost).filter(Boolean);
    if (!endpoints.length) return null;
    window.endpoints = endpoints;
  }
  if (raw.days !== undefined) {
    const days = normalizeDays(raw.days);
    if (!days) return null;
    window.days = days;
  }
  for (const field of ["from", "until"] as const) {
    if (raw[field] === undefined) continue;
    const bound = dateBound(raw[field]);
    if (!bound) return null;
    window[field] = bound;
  }
  return window;
}

function promotionEntries(document: unknown): unknown[] {
  const list = Array.isArray(document)
    ? document
    : (document as Record<string, unknown> | null)?.promotions;
  if (!Array.isArray(list)) return [];
  // Resolving one window converts a dozen wall-clock times, and the HUD
  // repaints every few seconds. A schedule longer than this is a mistake or a
  // hostile file; either way the repaint stays bounded.
  return list.slice(0, MAX_WINDOWS);
}

function windowsFromDocument(document: unknown): PromotionWindow[] {
  return promotionEntries(document)
    .map((entry, index) => normalizeWindow(entry, index))
    .filter((window): window is PromotionWindow => window != null);
}

/**
 * A local entry switched off with `"enabled": false` stops being a window, so
 * it can no longer shadow the shared one it was copied from. Its id still
 * carries the user's answer, and the shared window has to stay hidden.
 */
function switchedOffIds(document: unknown): string[] {
  return promotionEntries(document)
    .map((entry) => {
      const raw = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
      return raw?.enabled === false ? safeText(raw.id, 64) : "";
    })
    .filter(Boolean);
}

interface UserConfig {
  windows: PromotionWindow[];
  /** `"shared": false` opts out of the repository schedule entirely. */
  shared: boolean;
  /** Ids from the shared schedule to hide, without editing it. */
  disabled: Set<string>;
}

/**
 * Reads the user config. A missing, unreadable or malformed file is not an
 * error: the HUD renders every turn and must never fail on optional config.
 */
function readUserConfig(env: NodeJS.ProcessEnv): UserConfig {
  const empty: UserConfig = { windows: [], shared: true, disabled: new Set() };
  let parsed: unknown;
  try {
    const text = readSmallFile(resolveConfigPath(env), MAX_CONFIG_BYTES);
    if (text == null) return empty;
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  const record = (Array.isArray(parsed) ? null : parsed as Record<string, unknown> | null) ?? {};
  // Ids are read through the same sanitizer the windows use, so an id copied
  // out of the schedule still matches the window it names.
  const disabled = new Set(
    Array.isArray(record.disabled)
      ? record.disabled.map((id) => safeText(id, 64)).filter(Boolean)
      : [],
  );
  for (const id of switchedOffIds(parsed)) disabled.add(id);
  return {
    windows: windowsFromDocument(parsed),
    shared: record.shared !== false,
    disabled,
  };
}

export interface PromotionSources {
  /** Windows from the user's own config file. */
  local: PromotionWindow[];
  /** Windows from the shared schedule, minus the ones the user turned off. */
  shared: PromotionWindow[];
  sharedOrigin: SharedPromotionOrigin;
  /** Epoch seconds the shared schedule was fetched, null when never fetched. */
  sharedFetchedAt: number | null;
  /** The URL the cached schedule came from, null when nothing was fetched. */
  sharedSource: string | null;
  sharedStale: boolean;
}

/**
 * The two schedules kept apart, for diagnostics that have to explain where a
 * window came from. A local window shadows a shared one with the same id, so a
 * user can correct a campaign without waiting for the repository to catch up.
 */
export function promotionSources(
  env: NodeJS.ProcessEnv = process.env,
): PromotionSources {
  const config = readUserConfig(env);
  if (!config.shared) {
    return {
      local: config.windows,
      shared: [],
      sharedOrigin: "off",
      sharedFetchedAt: null,
      sharedSource: null,
      sharedStale: false,
    };
  }
  const document = readSharedDocument(env);
  const localIds = new Set(config.windows.map((window) => window.id));
  return {
    local: config.windows,
    shared: windowsFromDocument(document.document).filter(
      (window) => !config.disabled.has(window.id) && !localIds.has(window.id),
    ),
    sharedOrigin: document.origin,
    sharedFetchedAt: document.fetchedAt,
    sharedSource: document.source,
    sharedStale: sharedCacheStale(env),
  };
}

/**
 * Every window in effect, user config first so it wins the tie-breaks in
 * resolvePromotion.
 */
export function readPromotionWindows(
  env: NodeJS.ProcessEnv = process.env,
): PromotionWindow[] {
  const sources = promotionSources(env);
  return [...sources.local, ...sources.shared];
}

/**
 * Resolves the window that matters right now. An open window always wins over
 * a pending one; among several open windows the first configured one wins, so
 * the displayed badge stays predictable when campaigns overlap.
 */
export function resolvePromotion(
  windows: PromotionWindow[],
  options: { platform?: Platform; endpoint?: string; now?: number } = {},
): PromotionStatus | null {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const endpoint = endpointHost(options.endpoint);
  const applicable = windows.filter((window) =>
    (!window.platforms?.length || !options.platform ||
      window.platforms.includes(options.platform)) &&
    // An unstated platform is a caller that did not narrow the question; an
    // unstated endpoint is a caller that cannot tell which API it is billed
    // on, and that is the one case a per-endpoint campaign must not survive.
    (!window.endpoints?.length ||
      (endpoint !== "" && window.endpoints.includes(endpoint)))
  );
  let pending: Occurrence | null = null;
  for (const window of applicable) {
    const occurrences = occurrencesFor(window, now);
    for (const occurrence of occurrences) {
      if (occurrence.startsAt <= now && now < occurrence.endsAt) {
        return {
          id: window.id,
          label: window.label,
          active: true,
          changesAt: runEnd(occurrences, occurrence, now),
        };
      }
      if (
        occurrence.startsAt > now &&
        (!pending || occurrence.startsAt < pending.startsAt)
      ) {
        pending = occurrence;
      }
    }
  }
  if (!pending) return null;
  return {
    id: pending.window.id,
    label: pending.window.label,
    active: false,
    changesAt: pending.startsAt,
  };
}

export function currentPromotion(
  options: {
    platform?: Platform;
    endpoint?: string;
    now?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): PromotionStatus | null {
  try {
    return resolvePromotion(readPromotionWindows(options.env), options);
  } catch {
    return null;
  }
}
