// src/pi-extension.ts
import { fileURLToPath } from "node:url";

// ../../packages/provider/dist/io.js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
var MAX_STDIN_BYTES = 256 * 1024;
var HYGIENE_TEMP_PREFIX = ".agent-hud-tmp-";
var DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1e3;
var DEFAULT_STALE_LOCK_MS = 5 * 60 * 1e3;
var DEFAULT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
async function repairPrivateDirectory(directory) {
  try {
    await fs.chmod(directory, 448);
  } catch {
  }
}
async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 448 });
  await repairPrivateDirectory(directory);
}
async function ensurePrivateFile(filePath) {
  try {
    await fs.chmod(filePath, 384);
  } catch {
  }
}
var RENAME_RETRY_ATTEMPTS = 5;
var RENAME_RETRY_DELAY_MS = 20;
async function renameWithRetry(temporary, filePath) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(temporary, filePath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= RENAME_RETRY_ATTEMPTS || code !== "EPERM" && code !== "EBUSY") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    }
  }
}
async function atomicWritePrivate(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `${HYGIENE_TEMP_PREFIX}${path.basename(filePath)}-${process.pid}-${randomUUID()}`);
  await ensurePrivateDirectory(directory);
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 384 });
    await ensurePrivateFile(temporary);
    await renameWithRetry(temporary, filePath);
    await ensurePrivateFile(filePath);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
    }
    throw error;
  }
}
function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}
function resolveBaseDir(env = process.env, home = os.homedir()) {
  return env.AGENT_HUD_DATA_DIR || path.join(home, ".agent-hud");
}
function safeText(value, max = 80) {
  if (typeof value !== "string")
    return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// ../../packages/provider/dist/promotions.js
import path3 from "node:path";

// ../../packages/provider/dist/promotions/remote.js
import { spawn } from "node:child_process";
import fs2 from "node:fs";
import path2 from "node:path";

// ../../packages/provider/dist/promotions/bundled.js
var BUNDLED_PROMOTIONS = {
  "version": 1,
  "updated": "2026-09-04",
  "notes": `Shared promotional windows. Vendor campaigns appear in no host's status payload and change without notice, so they are maintained here by pull request instead of being hardcoded in the runtime. Clock times are UTC unless a window sets "timezone". This list ships empty on purpose: an unverified window is worse than no badge. See the README for the field reference.`,
  "promotions": []
};

// ../../packages/provider/dist/promotions/remote.js
var CACHE_FILE_NAME = "promotions-cache.json";
var ATTEMPT_FILE_NAME = "promotions-attempt";
var CACHE_TTL_SECONDS = 6 * 60 * 60;
var CLOCK_SKEW_SECONDS = 5;
var MAX_DOCUMENT_BYTES = 64 * 1024;
var SHARED_PROMOTIONS_URL = "https://raw.githubusercontent.com/lbb00/a-hud/main/packages/provider/promotions.json";
function sharedPromotionsUrl(env = process.env) {
  return env.AGENT_HUD_PROMOTIONS_URL || SHARED_PROMOTIONS_URL;
}
function remoteFetchDisabled(env = process.env) {
  const value = String(env.AGENT_HUD_NO_REMOTE ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}
function sharedCachePath(env = process.env) {
  return path2.join(resolveBaseDir(env), CACHE_FILE_NAME);
}
function attemptPath(env) {
  return path2.join(resolveBaseDir(env), ATTEMPT_FILE_NAME);
}
function readSmallFile(filePath, maxBytes) {
  try {
    const stats = fs2.statSync(filePath);
    if (!stats.isFile() || stats.size > maxBytes)
      return null;
    return fs2.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
function readCachedSchedule(env) {
  try {
    const text = readSmallFile(sharedCachePath(env), MAX_DOCUMENT_BYTES);
    if (text == null)
      return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.document)
      return null;
    if (parsed.url !== sharedPromotionsUrl(env))
      return null;
    return {
      document: parsed.document,
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : null,
      source: typeof parsed.source === "string" ? parsed.source : null
    };
  } catch {
    return null;
  }
}
function documentUpdated(document) {
  const updated = document?.updated;
  return typeof updated === "string" ? updated : "";
}
function readSharedDocument(env = process.env) {
  const cached = readCachedSchedule(env);
  const bundledUpdated = documentUpdated(BUNDLED_PROMOTIONS);
  const cachedUpdated = cached ? documentUpdated(cached.document) : "";
  const supersededByPackage = Boolean(cachedUpdated) && Boolean(bundledUpdated) && bundledUpdated > cachedUpdated;
  if (cached && !supersededByPackage) {
    return {
      document: cached.document,
      origin: "remote",
      fetchedAt: cached.fetchedAt,
      source: cached.source
    };
  }
  return {
    document: BUNDLED_PROMOTIONS,
    origin: "bundled",
    fetchedAt: null,
    source: null
  };
}
function sharedCacheStale(env = process.env, now = Date.now() / 1e3) {
  if (remoteFetchDisabled(env))
    return false;
  const cacheAge = readCachedSchedule(env) ? mtimeSeconds(sharedCachePath(env)) : 0;
  const attemptAge = attemptForCurrentUrl(env) ? mtimeSeconds(attemptPath(env)) : 0;
  const age = now - Math.max(cacheAge, attemptAge);
  return !(age > -CLOCK_SKEW_SECONDS && age < CACHE_TTL_SECONDS);
}
function mtimeSeconds(filePath) {
  try {
    return fs2.statSync(filePath).mtimeMs / 1e3;
  } catch {
    return 0;
  }
}
function attemptForCurrentUrl(env) {
  const text = readSmallFile(attemptPath(env), 4096);
  if (text == null)
    return false;
  const fields = text.trim().split(/\s+/);
  return fields.length === 2 && fields[1] === sharedPromotionsUrl(env);
}
async function spawnPromotionsRefresh(cliPath, env = process.env) {
  if (!sharedCacheStale(env))
    return false;
  try {
    await atomicWritePrivate(attemptPath(env), `${Math.floor(Date.now() / 1e3)} ${sharedPromotionsUrl(env)}
`);
    const child = spawn(process.execPath, [cliPath, "refresh-promotions"], {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", () => void 0);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ../../packages/provider/dist/promotions/clock.js
var CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
var DEFAULT_ZONE = "UTC";
var SCAN_DAYS_BACK = 1;
var SCAN_DAYS_FORWARD = 8;
var RUN_CAP_DAYS = 366;
function clockMinutes(value) {
  if (typeof value !== "string")
    return null;
  const match = CLOCK_PATTERN.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function knownZone(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}
function zonedParts(timeZone, epochSeconds) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(epochSeconds * 1e3));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
}
function zoneOffsetSeconds(timeZone, epochSeconds) {
  const parts = zonedParts(timeZone, epochSeconds);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1e3;
  return asUtc - Math.floor(epochSeconds);
}
function zonedEpoch(timeZone, year, month, day, minutes) {
  const naive = Date.UTC(year, month - 1, day, 0, minutes) / 1e3;
  const first = naive - zoneOffsetSeconds(timeZone, naive);
  const second = naive - zoneOffsetSeconds(timeZone, first);
  if (second === first)
    return second;
  return zoneOffsetSeconds(timeZone, second) === zoneOffsetSeconds(timeZone, first) ? second : first;
}
function civilDateKey(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function windowBounds(window) {
  const startMinutes = clockMinutes(window.start);
  const endMinutes = clockMinutes(window.end);
  if (startMinutes == null || endMinutes == null)
    return null;
  return { zone: window.timezone || DEFAULT_ZONE, startMinutes, endMinutes };
}
function scanBase(zone, now) {
  const today = zonedParts(zone, now);
  return Date.UTC(today.year, today.month - 1, today.day);
}
function occurrenceOn(window, bounds, base, offset) {
  const civil = new Date(base + offset * 864e5);
  const year = civil.getUTCFullYear();
  const month = civil.getUTCMonth() + 1;
  const day = civil.getUTCDate();
  if (window.days && !window.days.includes(civil.getUTCDay()))
    return null;
  const key = civilDateKey(year, month, day);
  if (window.from && key < window.from)
    return null;
  if (window.until && key > window.until)
    return null;
  const startsAt = zonedEpoch(bounds.zone, year, month, day, bounds.startMinutes);
  const endsAt = bounds.endMinutes > bounds.startMinutes ? zonedEpoch(bounds.zone, year, month, day, bounds.endMinutes) : zonedEpoch(bounds.zone, year, month, day + 1, bounds.endMinutes);
  return { window, startsAt, endsAt };
}
function occurrencesFor(window, now) {
  const bounds = windowBounds(window);
  if (!bounds)
    return [];
  const base = scanBase(bounds.zone, now);
  const occurrences = [];
  for (let offset = -SCAN_DAYS_BACK; offset <= SCAN_DAYS_FORWARD; offset += 1) {
    const occurrence = occurrenceOn(window, bounds, base, offset);
    if (occurrence)
      occurrences.push(occurrence);
  }
  return occurrences;
}
function runEnd(occurrences, active, now) {
  let end = active.endsAt;
  for (const occurrence of occurrences) {
    if (occurrence.startsAt <= end && occurrence.endsAt > end)
      end = occurrence.endsAt;
  }
  const bounds = windowBounds(active.window);
  if (!bounds)
    return end;
  const base = scanBase(bounds.zone, now);
  for (let offset = SCAN_DAYS_FORWARD + 1; offset <= RUN_CAP_DAYS; offset += 1) {
    const next = occurrenceOn(active.window, bounds, base, offset);
    if (!next || next.startsAt > end)
      break;
    if (next.endsAt > end)
      end = next.endsAt;
  }
  return end;
}

// ../../packages/provider/dist/promotions.js
var CONFIG_FILE_NAME = "config.json";
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
var MAX_WINDOWS = 64;
var MAX_ENDPOINT_LENGTH = 200;
var MAX_CONFIG_BYTES = 64 * 1024;
function resolveConfigPath(env = process.env) {
  return env.AGENT_HUD_CONFIG || path3.join(resolveBaseDir(env), CONFIG_FILE_NAME);
}
function normalizeDays(value) {
  if (!Array.isArray(value))
    return void 0;
  const days = value.map((entry) => {
    if (typeof entry === "number") {
      return Number.isInteger(entry) && entry >= 0 && entry <= 6 ? entry : -1;
    }
    if (typeof entry !== "string")
      return -1;
    return WEEKDAY_NAMES.indexOf(entry.slice(0, 3).toLowerCase());
  }).filter((day) => day >= 0);
  return days.length ? [...new Set(days)] : void 0;
}
function dateBound(value) {
  return typeof value === "string" && DATE_PATTERN.test(value) ? value : null;
}
function endpointHost(value) {
  const text = safeText(value, MAX_ENDPOINT_LENGTH + 1);
  if (!text || text.length > MAX_ENDPOINT_LENGTH)
    return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      return "";
    }
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}
function normalizeWindow(value, index) {
  if (!value || typeof value !== "object")
    return null;
  const raw = value;
  if (raw.enabled === false)
    return null;
  if (clockMinutes(raw.start) == null || clockMinutes(raw.end) == null)
    return null;
  const window = {
    id: safeText(raw.id, 64) || `promotion-${index + 1}`,
    label: safeText(raw.label, 8),
    start: raw.start,
    end: raw.end
  };
  if (raw.timezone !== void 0) {
    const timezone = safeText(raw.timezone, 64);
    if (!timezone || !knownZone(timezone))
      return null;
    window.timezone = timezone;
  }
  if (raw.platforms !== void 0) {
    if (!Array.isArray(raw.platforms))
      return null;
    const platforms = raw.platforms.map((entry) => safeText(entry, 16)).filter(Boolean);
    if (!platforms.length)
      return null;
    window.platforms = platforms;
  }
  if (raw.endpoints !== void 0) {
    if (!Array.isArray(raw.endpoints))
      return null;
    const endpoints = raw.endpoints.map(endpointHost).filter(Boolean);
    if (!endpoints.length)
      return null;
    window.endpoints = endpoints;
  }
  if (raw.days !== void 0) {
    const days = normalizeDays(raw.days);
    if (!days)
      return null;
    window.days = days;
  }
  for (const field of ["from", "until"]) {
    if (raw[field] === void 0)
      continue;
    const bound = dateBound(raw[field]);
    if (!bound)
      return null;
    window[field] = bound;
  }
  return window;
}
function promotionEntries(document) {
  const list = Array.isArray(document) ? document : document?.promotions;
  if (!Array.isArray(list))
    return [];
  return list.slice(0, MAX_WINDOWS);
}
function windowsFromDocument(document) {
  return promotionEntries(document).map((entry, index) => normalizeWindow(entry, index)).filter((window) => window != null);
}
function switchedOffIds(document) {
  return promotionEntries(document).map((entry) => {
    const raw = entry && typeof entry === "object" ? entry : null;
    return raw?.enabled === false ? safeText(raw.id, 64) : "";
  }).filter(Boolean);
}
function readUserConfig(env) {
  const empty = { windows: [], shared: true, disabled: /* @__PURE__ */ new Set() };
  let parsed;
  try {
    const text = readSmallFile(resolveConfigPath(env), MAX_CONFIG_BYTES);
    if (text == null)
      return empty;
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  const record = (Array.isArray(parsed) ? null : parsed) ?? {};
  const disabled = new Set(Array.isArray(record.disabled) ? record.disabled.map((id) => safeText(id, 64)).filter(Boolean) : []);
  for (const id of switchedOffIds(parsed))
    disabled.add(id);
  return {
    windows: windowsFromDocument(parsed),
    shared: record.shared !== false,
    disabled
  };
}
function promotionSources(env = process.env) {
  const config = readUserConfig(env);
  if (!config.shared) {
    return {
      local: config.windows,
      shared: [],
      sharedOrigin: "off",
      sharedFetchedAt: null,
      sharedSource: null,
      sharedStale: false
    };
  }
  const document = readSharedDocument(env);
  const localIds = new Set(config.windows.map((window) => window.id));
  return {
    local: config.windows,
    shared: windowsFromDocument(document.document).filter((window) => !config.disabled.has(window.id) && !localIds.has(window.id)),
    sharedOrigin: document.origin,
    sharedFetchedAt: document.fetchedAt,
    sharedSource: document.source,
    sharedStale: sharedCacheStale(env)
  };
}
function readPromotionWindows(env = process.env) {
  const sources = promotionSources(env);
  return [...sources.local, ...sources.shared];
}
function resolvePromotion(windows, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  const endpoint = endpointHost(options.endpoint);
  const applicable = windows.filter((window) => (!window.platforms?.length || !options.platform || window.platforms.includes(options.platform)) && // An unstated platform is a caller that did not narrow the question; an
  // unstated endpoint is a caller that cannot tell which API it is billed
  // on, and that is the one case a per-endpoint campaign must not survive.
  (!window.endpoints?.length || endpoint !== "" && window.endpoints.includes(endpoint)));
  let pending = null;
  for (const window of applicable) {
    const occurrences = occurrencesFor(window, now);
    for (const occurrence of occurrences) {
      if (occurrence.startsAt <= now && now < occurrence.endsAt) {
        return {
          id: window.id,
          label: window.label,
          active: true,
          changesAt: runEnd(occurrences, occurrence, now)
        };
      }
      if (occurrence.startsAt > now && (!pending || occurrence.startsAt < pending.startsAt)) {
        pending = occurrence;
      }
    }
  }
  if (!pending)
    return null;
  return {
    id: pending.window.id,
    label: pending.window.label,
    active: false,
    changesAt: pending.startsAt
  };
}
function currentPromotion(options = {}) {
  try {
    return resolvePromotion(readPromotionWindows(options.env), options);
  } catch {
    return null;
  }
}

// ../../packages/provider/dist/telemetry/config.js
var PROVIDER_DEFAULTS = {
  cacheFallbackTtlSeconds: 3600,
  compactTargetPercent: 80,
  compactSummaryTokens: 17e3,
  recentContextRows: 6,
  apiHealthTtlSeconds: 300
};

// ../../packages/provider/dist/telemetry/health.js
import { spawn as spawn2 } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
import fs3 from "node:fs/promises";
import os2 from "node:os";
import path4 from "node:path";
var HEALTH_REFRESH_LOCK_STALE_MS = 3e4;
var MAX_STATUS_BYTES = 64 * 1024;
function healthDirectory(env, home) {
  return path4.join(resolveBaseDir(env, home), "health");
}
async function healthState(source, now, home = os2.homedir(), env = process.env) {
  const directory = healthDirectory(env, home);
  const filePath = path4.join(directory, source.id);
  const attemptPath2 = path4.join(directory, `${source.id}-attempt`);
  await repairPrivateDirectory(directory);
  let indicator = "";
  let mtime = 0;
  try {
    await ensurePrivateFile(filePath);
    indicator = (await fs3.readFile(filePath, "utf8")).trim();
    mtime = Math.floor((await fs3.stat(filePath)).mtimeMs / 1e3);
  } catch {
  }
  try {
    await ensurePrivateFile(attemptPath2);
    mtime = Math.max(mtime, Math.floor((await fs3.stat(attemptPath2)).mtimeMs / 1e3));
  } catch {
  }
  return {
    indicator,
    stale: now - mtime >= PROVIDER_DEFAULTS.apiHealthTtlSeconds
  };
}
async function acquireHealthRefreshLease(source, home, env, now = Date.now()) {
  const directory = healthDirectory(env, home);
  const lockPath = path4.join(directory, `${source.id}-refresh.lock`);
  await ensurePrivateDirectory(directory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID2();
    try {
      const handle = await fs3.open(lockPath, "wx", 384);
      try {
        await handle.writeFile(`${token}
`);
      } finally {
        await handle.close();
      }
      return { path: lockPath, token };
    } catch (error) {
      if (error.code !== "EEXIST")
        return null;
      try {
        const before = await fs3.stat(lockPath);
        if (now - before.mtimeMs < HEALTH_REFRESH_LOCK_STALE_MS)
          return null;
        const after = await fs3.stat(lockPath);
        if (before.dev !== after.dev || before.ino !== after.ino)
          return null;
        await fs3.unlink(lockPath);
      } catch {
      }
    }
  }
  return null;
}
async function releaseHealthRefreshLease(lease) {
  try {
    const before = await fs3.stat(lease.path);
    if ((await fs3.readFile(lease.path, "utf8")).trim() !== lease.token)
      return;
    const after = await fs3.stat(lease.path);
    if (before.dev !== after.dev || before.ino !== after.ino)
      return;
    await fs3.unlink(lease.path);
  } catch {
  }
}
async function spawnHealthRefresh(cliPath, source, home = os2.homedir(), env = process.env) {
  let lease;
  try {
    lease = await acquireHealthRefreshLease(source, home, env);
  } catch {
    return false;
  }
  if (!lease)
    return false;
  try {
    const child = spawn2(process.execPath, [
      cliPath,
      "refresh-health",
      "--source",
      source.id,
      "--home",
      home,
      "--refresh-lock",
      lease.path,
      "--refresh-token",
      lease.token
    ], {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", () => {
      void releaseHealthRefreshLease(lease);
    });
    child.unref();
    return true;
  } catch {
    await releaseHealthRefreshLease(lease);
    return false;
  }
}

// ../../packages/provider/dist/telemetry/health-sources.js
var HEALTH_SOURCES = [
  {
    id: "anthropic-statuspage",
    label: "Anthropic",
    endpoints: ["api.anthropic.com"],
    url: "https://status.claude.com/api/v2/status.json",
    read(body) {
      const status = body?.status;
      return typeof status?.indicator === "string" ? status.indicator : "";
    }
  }
];
function healthSourceFor(endpoint) {
  const host = endpointHost(endpoint);
  if (!host)
    return null;
  return HEALTH_SOURCES.find((source) => source.endpoints.includes(host)) ?? null;
}

// src/design.ts
function healthSeverity(indicator) {
  if (indicator === "major" || indicator === "critical") return "red";
  if (indicator === "minor") return "yellow";
  return "plain";
}

// src/terminal-width.ts
var GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;

// src/render.ts
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function displayText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "") : "";
}
function compactDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total % 86400 / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  if (days) return hours ? `${days}d${hours}h` : `${days}d`;
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}`;
  return `${minutes}m`;
}
function promotionText(promotion, now) {
  if (!promotion || !isFiniteNumber(promotion.changesAt)) return "";
  const label = displayText(promotion.label).slice(0, 8);
  const time = compactDuration(promotion.changesAt - now);
  return `%${label}${label ? " " : ""}${promotion.active ? "" : "\u2191"}${time}`;
}
function incidentText(indicator, label) {
  if (healthSeverity(indicator) === "plain") return "";
  return `!${displayText(label).slice(0, 12)}`;
}

// src/pi-extension.ts
var STATUS_KEY = "agent-hud";
var REFRESH_MS = 6e4;
var CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
function pi_extension_default(pi) {
  let timer;
  let latest;
  let latestEndpoint;
  let indicator = "";
  let indicatorLabel = "";
  let indicatorEndpoint;
  const tint = (ctx, color, text) => {
    try {
      return ctx.ui.theme.fg(color, text);
    } catch {
      return text;
    }
  };
  const render = (ctx, endpoint) => {
    let promotion = null;
    try {
      promotion = currentPromotion({ platform: "pi", endpoint });
    } catch {
    }
    const health = indicatorEndpoint === endpoint ? indicator : "";
    const incident = incidentText(health, indicatorLabel);
    const promotionLabel = promotionText(promotion, Date.now() / 1e3);
    const parts = [
      incident ? tint(ctx, healthSeverity(health) === "red" ? "error" : "warning", incident) : "",
      promotionLabel ? tint(ctx, promotion?.active ? "success" : "dim", promotionLabel) : ""
    ].filter(Boolean);
    ctx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(" ") : void 0);
  };
  const readHealth = async (endpoint) => {
    const source = healthSourceFor(endpoint);
    if (!source) {
      indicator = "";
      indicatorLabel = "";
      indicatorEndpoint = endpoint;
      return;
    }
    const state = await healthState(source, Math.floor(Date.now() / 1e3));
    indicator = state.indicator;
    indicatorLabel = source.label;
    indicatorEndpoint = endpoint;
    if (state.stale) await spawnHealthRefresh(CLI_PATH, source);
  };
  const paint = (ctx, endpoint) => {
    latest = ctx;
    latestEndpoint = endpoint;
    render(ctx, endpoint);
    void (async () => {
      try {
        await spawnPromotionsRefresh(CLI_PATH);
        await readHealth(endpoint);
      } catch {
      }
      if (latest && latestEndpoint === endpoint) render(latest, endpoint);
    })();
  };
  const track = (event) => {
    pi.on(event, (_event, ctx) => {
      paint(ctx, ctx.model?.baseUrl);
      if (timer) return;
      timer = setInterval(() => {
        if (latest) paint(latest, latestEndpoint);
      }, REFRESH_MS);
      timer.unref?.();
    });
  };
  track("session_start");
  track("turn_end");
  pi.on("model_select", (event, ctx) => {
    const selected = event?.model;
    paint(ctx, selected?.baseUrl);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = void 0;
    latest = void 0;
    latestEndpoint = void 0;
    indicator = "";
    indicatorLabel = "";
    indicatorEndpoint = void 0;
    ctx.ui.setStatus(STATUS_KEY, void 0);
  });
}
export {
  pi_extension_default as default
};
//# sourceMappingURL=pi-extension.js.map
