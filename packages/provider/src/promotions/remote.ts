import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWritePrivate, resolveBaseDir } from "../io.js";
import { BUNDLED_PROMOTIONS } from "./bundled.js";

/**
 * The shared promotional schedule lives in the repository, so a campaign can be
 * corrected once for everyone instead of in every user's config. Three layers
 * answer, in order: the cached copy fetched from the repository, and the copy
 * bundled at publish time when there is no cache yet. The user's own config is
 * merged on top by promotions.ts.
 *
 * Nothing here ever runs on the render path's critical section. A status line
 * repaints every few seconds and must not wait on the network, so a stale cache
 * only schedules a detached refresh and keeps answering from what it has.
 */
const CACHE_FILE_NAME = "promotions-cache.json";
const ATTEMPT_FILE_NAME = "promotions-attempt";
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_DOCUMENT_BYTES = 64 * 1024;

export const SHARED_PROMOTIONS_URL =
  "https://raw.githubusercontent.com/lbb00/a-hud/main/packages/provider/promotions.json";

export type SharedPromotionOrigin = "remote" | "bundled" | "off";

export interface SharedPromotionDocument {
  /** Raw parsed document; promotions.ts validates every field. */
  document: unknown;
  origin: SharedPromotionOrigin;
  /** Epoch seconds the cache was written, or null when nothing was fetched. */
  fetchedAt: number | null;
  /** The URL the cache actually came from, which outlives a changed override. */
  source: string | null;
}

export function sharedPromotionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_HUD_PROMOTIONS_URL || SHARED_PROMOTIONS_URL;
}

/** The only outbound request Agent HUD makes for promotions; opt out with 1/true. */
export function remoteFetchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.AGENT_HUD_NO_REMOTE ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Where the fetched schedule is cached; the diagnostic reports it. */
export function sharedCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveBaseDir(env), CACHE_FILE_NAME);
}

function attemptPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveBaseDir(env), ATTEMPT_FILE_NAME);
}

interface CachedSchedule {
  document: unknown;
  fetchedAt: number | null;
  /** Where the bytes came from, which is the request URL unless it redirected. */
  source: string | null;
}

/**
 * The cache file is named by the data directory alone, so the URL it was
 * fetched from is recorded inside it: a cache written for a different URL is
 * not an answer to the one configured now.
 */
/**
 * Reads an optional file on the render path. A directory, a FIFO with no writer
 * or a file far larger than any schedule would stall or balloon a repaint, so
 * anything that is not a regular file of a sane size reads as absent.
 */
export function readSmallFile(filePath: string, maxBytes: number): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readCachedSchedule(env: NodeJS.ProcessEnv): CachedSchedule | null {
  try {
    const text = readSmallFile(sharedCachePath(env), MAX_DOCUMENT_BYTES);
    if (text == null) return null;
    const parsed = JSON.parse(text) as {
      fetchedAt?: unknown;
      url?: unknown;
      source?: unknown;
      document?: unknown;
    } | null;
    if (!parsed || typeof parsed !== "object" || !parsed.document) return null;
    if (parsed.url !== sharedPromotionsUrl(env)) return null;
    return {
      document: parsed.document,
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : null,
      source: typeof parsed.source === "string" ? parsed.source : null,
    };
  } catch {
    // Nothing fetched yet, or a truncated file: the bundled copy answers.
    return null;
  }
}

/** The "YYYY-MM-DD" a schedule was last edited, "" when it carries no date. */
function documentUpdated(document: unknown): string {
  const updated = (document as { updated?: unknown } | null)?.updated;
  return typeof updated === "string" ? updated : "";
}

export function readSharedDocument(
  env: NodeJS.ProcessEnv = process.env,
): SharedPromotionDocument {
  const cached = readCachedSchedule(env);
  const bundledUpdated = documentUpdated(BUNDLED_PROMOTIONS);
  const cachedUpdated = cached ? documentUpdated(cached.document) : "";
  // An upgrade can ship a schedule newer than the last fetched one, and an
  // offline machine would otherwise keep answering from the older cache
  // forever. Both dates have to be present for the comparison to mean anything.
  const supersededByPackage = Boolean(cachedUpdated) && Boolean(bundledUpdated) &&
    bundledUpdated > cachedUpdated;
  if (cached && !supersededByPackage) {
    return {
      document: cached.document,
      origin: "remote",
      fetchedAt: cached.fetchedAt,
      source: cached.source,
    };
  }
  return {
    document: BUNDLED_PROMOTIONS,
    origin: "bundled",
    fetchedAt: null,
    source: null,
  };
}

/**
 * A failed fetch still touches the attempt marker, so an unreachable network
 * costs one request per TTL rather than one per repaint.
 */
export function sharedCacheStale(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now() / 1_000,
): boolean {
  if (remoteFetchDisabled(env)) return false;
  // A cache or an attempt made for a different URL does not count as fetched,
  // so changing the override takes effect on the next repaint instead of six
  // hours later.
  const cacheAge = readCachedSchedule(env) ? mtimeSeconds(sharedCachePath(env)) : 0;
  const attemptAge = attemptForCurrentUrl(env) ? mtimeSeconds(attemptPath(env)) : 0;
  const age = now - Math.max(cacheAge, attemptAge);
  // A clock moved backwards, or an mtime from the future, would otherwise
  // freeze the cache. The tolerance is there because a file written this
  // instant can carry an mtime a fraction of a second ahead of Date.now(), and
  // calling that cache stale would refetch on the repaint right after a fetch.
  return !(age > -CLOCK_SKEW_SECONDS && age < CACHE_TTL_SECONDS);
}

function mtimeSeconds(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs / 1_000;
  } catch {
    return 0;
  }
}

/**
 * The attempt marker carries the URL it was made for after the timestamp, so a
 * fetch of the previous URL never rate-limits the first fetch of the new one.
 * Its mtime says when; the timestamp inside is only there for a human reading
 * the data directory.
 */
function attemptForCurrentUrl(env: NodeJS.ProcessEnv): boolean {
  const text = readSmallFile(attemptPath(env), 4_096);
  if (text == null) return false;
  const fields = text.trim().split(/\s+/);
  return fields.length === 2 && fields[1] === sharedPromotionsUrl(env);
}

/**
 * Schedules a refresh when the cache is due, and reports whether one started.
 * The attempt marker is written here, before the child exists, because the
 * status line repaints again within seconds and would otherwise spawn a second
 * fetch for the same window.
 */
export async function spawnPromotionsRefresh(
  cliPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!sharedCacheStale(env)) return false;
  try {
    await atomicWritePrivate(
      attemptPath(env),
      `${Math.floor(Date.now() / 1_000)} ${sharedPromotionsUrl(env)}\n`,
    );
    const child = spawn(process.execPath, [cliPath, "refresh-promotions"], {
      detached: true,
      stdio: "ignore",
    });
    // A spawn that fails reports it asynchronously, and an unhandled 'error'
    // event would take down the status line that started it. The refresh simply
    // does not happen; the attempt marker already keeps it from retrying.
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches the repository schedule into the local cache. Runs in the detached
 * child, never in a render, and reports whether the cache was replaced.
 */
export async function refreshSharedPromotions(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (remoteFetchDisabled(env)) return false;
  const url = sharedPromotionsUrl(env);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) return false;
    const document: unknown = JSON.parse(raw);
    if (!document || typeof document !== "object") return false;
    await atomicWritePrivate(
      sharedCachePath(env),
      `${JSON.stringify({
        fetchedAt: Math.floor(Date.now() / 1_000),
        url,
        // Where the bytes actually came from: a redirect means the schedule was
        // not served by the URL that was asked for, and the diagnostic says so.
        source: typeof response.url === "string" && response.url ? response.url : url,
        document,
      })}\n`,
    );
    return true;
  } catch {
    // Offline, blocked, timed out or malformed: the previous cache still stands.
    return false;
  }
}
