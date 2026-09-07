#!/usr/bin/env node

// src/cli.ts
import fs8 from "node:fs";
import path12 from "node:path";
import process2 from "node:process";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// ../../packages/provider/dist/io.js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
var MAX_STDIN_BYTES = 256 * 1024;
var HYGIENE_STAMP_NAME = ".agent-hud-hygiene.stamp";
var HYGIENE_LOCK_NAME = ".agent-hud-hygiene.lock";
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
async function acquireHygieneLock(lockPath, nowMs, staleLockMs) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 384);
      await ensurePrivateFile(lockPath);
      return handle;
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        return null;
      try {
        const before = await fs.stat(lockPath);
        if (nowMs - before.mtimeMs <= staleLockMs)
          return null;
        const current = await fs.stat(lockPath);
        if (before.dev !== current.dev || before.ino !== current.ino)
          return null;
        await fs.unlink(lockPath);
      } catch (staleError) {
        if (errorCode(staleError) !== "ENOENT")
          return null;
      }
    }
  }
  return null;
}
function matches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
async function sweepPrivateFiles(directory, policy, nowMs, protectedPaths) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const survivors = [];
  const temporaryMaxAgeMs = policy.temporaryMaxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (entry.name.startsWith(HYGIENE_TEMP_PREFIX) && nowMs - stat.mtimeMs > temporaryMaxAgeMs) {
        await fs.unlink(filePath);
        continue;
      }
      if (!matches(policy.fileNamePattern, entry.name))
        continue;
      await ensurePrivateFile(filePath);
      if (!protectedPaths.has(filePath) && nowMs - stat.mtimeMs > policy.maxAgeMs) {
        await fs.unlink(filePath);
        continue;
      }
      survivors.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
    }
  }
  let excess = Math.max(0, survivors.length - policy.maxEntries);
  if (!excess)
    return;
  survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const survivor of survivors) {
    if (!excess)
      break;
    if (protectedPaths.has(survivor.filePath) || nowMs - survivor.mtimeMs <= policy.preserveYoungerThanMs)
      continue;
    try {
      await fs.unlink(survivor.filePath);
      excess -= 1;
    } catch {
    }
  }
}
async function maybeSweepPrivateFiles(directory, policy, options = {}) {
  try {
    const managedDirectory = path.resolve(directory);
    const nowMs = options.nowMs ?? Date.now();
    const sweepIntervalMs = policy.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const stampPath = path.join(managedDirectory, HYGIENE_STAMP_NAME);
    const lockPath = path.join(managedDirectory, HYGIENE_LOCK_NAME);
    await ensurePrivateDirectory(managedDirectory);
    try {
      const stamp = await fs.stat(stampPath);
      await ensurePrivateFile(stampPath);
      if (!options.force && nowMs - stamp.mtimeMs < sweepIntervalMs)
        return;
    } catch {
    }
    const lock = await acquireHygieneLock(lockPath, nowMs, policy.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
    if (!lock)
      return;
    const ownedLock = await lock.stat().catch(() => null);
    try {
      const protectedPaths = new Set([...options.protectedPaths ?? []].map((item) => path.resolve(item)));
      await sweepPrivateFiles(managedDirectory, policy, nowMs, protectedPaths);
      await atomicWritePrivate(stampPath, `${nowMs}
`);
      const seconds = nowMs / 1e3;
      await fs.utimes(stampPath, seconds, seconds);
    } finally {
      await lock.close().catch(() => void 0);
      try {
        const currentLock = await fs.stat(lockPath);
        if (ownedLock && ownedLock.dev === currentLock.dev && ownedLock.ino === currentLock.ino) {
          await fs.unlink(lockPath);
        }
      } catch {
      }
    }
  } catch {
  }
}
async function readJsonStdin(stream = process.stdin) {
  if (stream.isTTY)
    return null;
  stream.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stream) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, "utf8") > MAX_STDIN_BYTES)
      return null;
  }
  if (!raw.trim())
    return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function resolveBaseDir(env = process.env, home = os.homedir()) {
  return env.AGENT_HUD_DATA_DIR || path.join(home, ".agent-hud");
}
function resolveDataDir(env = process.env, home = os.homedir()) {
  return path.join(resolveBaseDir(env, home), "events");
}
function eventFileFor(dataDir, sessionKey2) {
  const digest = createHash("sha256").update(sessionKey2).digest("hex").slice(0, 24);
  return path.join(dataDir, `${digest}.jsonl`);
}
async function appendJsonLine(filePath, value) {
  await ensurePrivateDirectory(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}
`, {
    encoding: "utf8",
    mode: 384
  });
  await ensurePrivateFile(filePath);
}
async function readTail(filePath, maxBytes = 384 * 1024) {
  await ensurePrivateFile(filePath);
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (stat.size > length)
      text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}
function safeText(value, max = 80) {
  if (typeof value !== "string")
    return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function safePath(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "") : "";
}

// ../../packages/provider/dist/git.js
import { execFileSync } from "node:child_process";
function getGitStatus(cwd) {
  if (!cwd)
    return null;
  try {
    const run = (args) => execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1e3,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    }).trim();
    let branch = "";
    let detached = false;
    try {
      branch = safeText(run(["symbolic-ref", "--short", "HEAD"]), 48);
    } catch {
      const sha = safeText(run(["rev-parse", "--short", "HEAD"]), 20);
      branch = sha;
      detached = true;
    }
    const dirty = Boolean(run(["status", "--porcelain"]));
    let ahead = 0;
    let behind = 0;
    if (!detached) {
      try {
        const [behindText, aheadText] = run([
          "rev-list",
          "--left-right",
          "--count",
          "@{upstream}...HEAD"
        ]).split(/\s+/);
        ahead = Number(aheadText || 0);
        behind = Number(behindText || 0);
      } catch {
      }
    }
    if (!branch)
      return null;
    return { branch, detached, dirty, ahead, behind };
  } catch {
    return null;
  }
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
var FETCH_TIMEOUT_MS = 4e3;
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
async function refreshSharedPromotions(options = {}) {
  const env = options.env ?? process.env;
  if (remoteFetchDisabled(env))
    return false;
  const url = sharedPromotionsUrl(env);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" }
    });
    if (!response.ok)
      return false;
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES)
      return false;
    const document = JSON.parse(raw);
    if (!document || typeof document !== "object")
      return false;
    await atomicWritePrivate(sharedCachePath(env), `${JSON.stringify({
      fetchedAt: Math.floor(Date.now() / 1e3),
      url,
      // Where the bytes actually came from: a redirect means the schedule was
      // not served by the URL that was asked for, and the diagnostic says so.
      source: typeof response.url === "string" && response.url ? response.url : url,
      document
    })}
`);
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
  const beyond = occurrenceOn(active.window, bounds, base, SCAN_DAYS_FORWARD + 1);
  if (!beyond || beyond.startsAt > end)
    return end;
  const until = civilDate(active.window.until);
  if (!until)
    return null;
  const last = occurrenceOn(active.window, bounds, base, Math.round((until - base) / 864e5));
  return last ? last.endsAt : end;
}
function civilDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match)
    return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
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

// ../../packages/provider/dist/claude-api.js
var ANTHROPIC_API_HOST = "api.anthropic.com";
var CLOUD_PROVIDERS = [
  {
    flag: "CLAUDE_CODE_USE_BEDROCK",
    baseUrl: "ANTHROPIC_BEDROCK_BASE_URL"
  },
  {
    flag: "CLAUDE_CODE_USE_MANTLE",
    baseUrl: "ANTHROPIC_BEDROCK_MANTLE_BASE_URL"
  },
  {
    flag: "CLAUDE_CODE_USE_VERTEX",
    baseUrl: "ANTHROPIC_VERTEX_BASE_URL"
  },
  {
    flag: "CLAUDE_CODE_USE_FOUNDRY",
    baseUrl: "ANTHROPIC_FOUNDRY_BASE_URL"
  },
  {
    flag: "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    baseUrl: "ANTHROPIC_AWS_BASE_URL"
  },
  {
    flag: "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    baseUrl: "ANTHROPIC_GOOGLE_CLOUD_BASE_URL"
  },
  // Gateway mode has no provider-specific base URL variable, so the HUD must
  // keep its destination unknown instead of borrowing the first-party default.
  { flag: "CLAUDE_CODE_USE_GATEWAY" }
];
function enabled(value) {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}
function configuredEndpoint(value) {
  if (value === void 0)
    return void 0;
  return endpointHost(value) || void 0;
}
function claudeApiEndpoint(env = process.env) {
  const activeProviders = CLOUD_PROVIDERS.filter(({ flag }) => enabled(env[flag]));
  if (activeProviders.length > 1)
    return void 0;
  if (activeProviders.length === 1) {
    const { baseUrl } = activeProviders[0];
    return baseUrl ? configuredEndpoint(env[baseUrl]) : void 0;
  }
  if (env.ANTHROPIC_BASE_URL !== void 0) {
    if (env.ANTHROPIC_BASE_URL === "")
      return ANTHROPIC_API_HOST;
    return configuredEndpoint(env.ANTHROPIC_BASE_URL);
  }
  return ANTHROPIC_API_HOST;
}

// ../../packages/provider/dist/telemetry.js
import { createHash as createHash3 } from "node:crypto";
import fs5 from "node:fs/promises";
import os3 from "node:os";
import path6 from "node:path";

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
var FETCH_TIMEOUT_MS2 = 4e3;
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
async function refreshHealth(source, home = os2.homedir(), lease, env = process.env) {
  const directory = healthDirectory(env, home);
  const filePath = path4.join(directory, source.id);
  const attemptPath2 = path4.join(directory, `${source.id}-attempt`);
  try {
    await ensurePrivateDirectory(directory);
    await atomicWritePrivate(attemptPath2, "\n");
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS2),
      headers: { accept: "application/json" }
    });
    if (!response.ok)
      throw new Error(`${source.id}: HTTP ${response.status}`);
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_STATUS_BYTES) {
      throw new Error(`${source.id}: response too large`);
    }
    const indicator = source.read(JSON.parse(raw));
    if (!indicator)
      throw new Error(`${source.id}: missing indicator`);
    await atomicWritePrivate(filePath, `${indicator}
`);
  } finally {
    if (lease)
      await releaseHealthRefreshLease(lease);
  }
}

// ../../packages/provider/dist/telemetry/transcript.js
import { createHash as createHash2 } from "node:crypto";
import { createReadStream } from "node:fs";
import fs4 from "node:fs/promises";
import path5 from "node:path";
var TRANSCRIPT_CACHE_HYGIENE = {
  fileNamePattern: /^[a-f0-9]{24}\.json$/,
  maxAgeMs: 7 * 24 * 60 * 60 * 1e3,
  maxEntries: 100,
  // Avoid racing another actively-rendering session under count pressure.
  preserveYoungerThanMs: 15 * 60 * 1e3
};
function transcriptCachePath(home, transcriptPath) {
  const key = createHash2("sha256").update(transcriptPath).digest("hex").slice(0, 24);
  return path5.join(home, ".agent-hud", "transcript-cache", `${key}.json`);
}
async function readTranscriptCache(filePath, transcriptPath) {
  try {
    await ensurePrivateFile(filePath);
    const cached = JSON.parse(await fs4.readFile(filePath, "utf8"));
    if (cached.v !== 2 || cached.transcriptPath !== transcriptPath || !Number.isFinite(cached.turns) || !Number.isFinite(cached.cacheTtlSeconds) || !Number.isFinite(cached.mtimeSeconds) || !Number.isFinite(cached.size) || !Number.isFinite(cached.mtimeMs) || !Array.isArray(cached.ids) || !cached.ids.every((id) => typeof id === "string") || !Array.isArray(cached.recentEvidence) || !cached.recentEvidence.every((item) => item === 0 || item === 1 || item === 2) || cached.endedWithNewline !== true || !Number.isFinite(cached.device) || !Number.isFinite(cached.inode) || typeof cached.tailDigest !== "string")
      return null;
    return cached;
  } catch {
    return null;
  }
}
async function writeTranscriptCache(filePath, value) {
  try {
    await atomicWritePrivate(filePath, JSON.stringify(value));
  } catch {
  }
}
async function tailDigest(filePath, size) {
  const length = Math.min(size, 4096);
  const buffer = Buffer.alloc(length);
  const handle = await fs4.open(filePath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return createHash2("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}
async function readTranscriptFacts(transcriptPath, home) {
  if (!transcriptPath)
    return null;
  try {
    const stat = await fs4.stat(transcriptPath);
    const cachePath = transcriptCachePath(home, transcriptPath);
    const cacheDirectory = path5.dirname(cachePath);
    const maintainCache = () => maybeSweepPrivateFiles(cacheDirectory, TRANSCRIPT_CACHE_HYGIENE, { protectedPaths: [cachePath] });
    await ensurePrivateDirectory(cacheDirectory);
    const cached = await readTranscriptCache(cachePath, transcriptPath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.device === stat.dev && cached.inode === stat.ino) {
      const unchanged = {
        turns: cached.turns,
        cacheTtlSeconds: cached.cacheTtlSeconds,
        mtimeSeconds: cached.mtimeSeconds
      };
      await maintainCache();
      return unchanged;
    }
    const appendCache = cached && cached.size < stat.size && cached.device === stat.dev && cached.inode === stat.ino && await tailDigest(transcriptPath, cached.size) === cached.tailDigest ? cached : null;
    const scanStart = appendCache?.size ?? 0;
    const ids = new Set(appendCache?.ids ?? []);
    const evidenceCapacity = 600;
    const recentEvidence = Array.from({ length: evidenceCapacity }, () => 0);
    let recentCount = 0;
    for (const item of appendCache?.recentEvidence ?? []) {
      recentEvidence[recentCount % evidenceCapacity] = item;
      recentCount += 1;
    }
    let overlap = "";
    let lineIds = /* @__PURE__ */ new Set();
    let lineIsSidechain = false;
    let lineIsAssistant = false;
    let lineHasMessageObject = false;
    let lineHasUsageObject = false;
    let lineSawCacheWrite = false;
    let lineSawOneHourWrite = false;
    let lineTouched = false;
    const scanSegment = (segment) => {
      lineTouched ||= segment.length > 0;
      const scan = `${overlap}${segment}`;
      lineIsAssistant ||= /"type"\s*:\s*"assistant"/.test(scan);
      lineHasMessageObject ||= /"message"\s*:\s*\{/.test(scan);
      lineHasUsageObject ||= lineHasMessageObject && /"usage"\s*:\s*\{/.test(scan);
      const fields = /"(id|isSidechain|cache_creation_input_tokens|ephemeral_1h_input_tokens)"\s*:\s*(?:"(msg_[A-Za-z0-9_]+)"|(true)|([0-9]+))/g;
      for (const match of scan.matchAll(fields)) {
        const [, name, messageId, truth, number] = match;
        if (name === "id" && messageId)
          lineIds.add(messageId);
        if (name === "isSidechain" && truth === "true")
          lineIsSidechain = true;
        if (name === "cache_creation_input_tokens" && Number(number) > 0) {
          lineSawCacheWrite = true;
        }
        if (name === "ephemeral_1h_input_tokens" && Number(number) > 0) {
          lineSawOneHourWrite = true;
        }
      }
      overlap = scan.slice(-256);
    };
    const finishLine = () => {
      if (!lineIsSidechain) {
        for (const id of lineIds)
          ids.add(id);
      }
      const lineHasCacheWrite = lineIsAssistant && lineHasMessageObject && lineHasUsageObject && lineSawCacheWrite;
      const lineHasOneHourWrite = lineHasCacheWrite && lineSawOneHourWrite;
      recentEvidence[recentCount % evidenceCapacity] = lineHasCacheWrite ? lineHasOneHourWrite ? 2 : 1 : 0;
      recentCount += 1;
      overlap = "";
      lineIds = /* @__PURE__ */ new Set();
      lineIsSidechain = false;
      lineIsAssistant = false;
      lineHasMessageObject = false;
      lineHasUsageObject = false;
      lineSawCacheWrite = false;
      lineSawOneHourWrite = false;
      lineTouched = false;
    };
    const orderedEvidence = () => {
      const length = Math.min(recentCount, evidenceCapacity);
      const evidenceStart = recentCount >= evidenceCapacity ? recentCount % evidenceCapacity : 0;
      return Array.from({ length }, (_, index) => recentEvidence[(evidenceStart + index) % evidenceCapacity]);
    };
    const ttlFor = (evidence2) => evidence2.includes(2) ? PROVIDER_DEFAULTS.cacheFallbackTtlSeconds : evidence2.includes(1) ? 300 : PROVIDER_DEFAULTS.cacheFallbackTtlSeconds;
    let endedWithNewline = scanStart === stat.size ? Boolean(appendCache?.endedWithNewline) : stat.size === 0;
    let streamedOffset = scanStart;
    let lastCompleteOffset = scanStart;
    const stream = createReadStream(transcriptPath, {
      encoding: "utf8",
      start: scanStart
    });
    for await (const chunk of stream) {
      const text = String(chunk);
      if (text)
        endedWithNewline = text.endsWith("\n");
      let start = 0;
      let completeBytes = 0;
      let newline = text.indexOf("\n", start);
      while (newline >= 0) {
        const segment = text.slice(start, newline);
        scanSegment(segment);
        finishLine();
        completeBytes += Buffer.byteLength(segment, "utf8") + 1;
        start = newline + 1;
        lastCompleteOffset = streamedOffset + completeBytes;
        newline = text.indexOf("\n", start);
      }
      scanSegment(text.slice(start));
      streamedOffset += Buffer.byteLength(text, "utf8");
    }
    const completeIds = [...ids];
    const completeEvidence = orderedEvidence();
    if (lineTouched)
      finishLine();
    const evidence = orderedEvidence();
    const cacheTtlSeconds = ttlFor(evidence);
    const after = await fs4.stat(transcriptPath);
    const result = {
      turns: ids.size,
      cacheTtlSeconds,
      mtimeSeconds: Math.floor(after.mtimeMs / 1e3)
    };
    if (after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
      const cacheSize = endedWithNewline ? after.size : lastCompleteOffset;
      const cacheIds = endedWithNewline ? [...ids] : completeIds;
      const cacheEvidence = endedWithNewline ? evidence : completeEvidence;
      await writeTranscriptCache(cachePath, {
        v: 2,
        transcriptPath,
        size: cacheSize,
        mtimeMs: after.mtimeMs,
        ids: cacheIds,
        recentEvidence: cacheEvidence,
        endedWithNewline: true,
        device: after.dev,
        inode: after.ino,
        tailDigest: await tailDigest(transcriptPath, cacheSize),
        scanStart,
        turns: cacheIds.length,
        cacheTtlSeconds: ttlFor(cacheEvidence),
        mtimeSeconds: result.mtimeSeconds
      });
    }
    await maintainCache();
    return result;
  } catch {
    return null;
  }
}

// ../../packages/provider/dist/telemetry.js
function floorNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}
function effortValue(value) {
  if (typeof value === "string") {
    const normalized = safeText(value, 16).toLowerCase();
    return ["low", "medium", "high", "xhigh", "max"].includes(normalized) ? normalized : "";
  }
  if (!value || typeof value !== "object")
    return "";
  const record = value;
  return effortValue(record.level) || effortValue(record.effort);
}
function metricSessionName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) ? value : `session-${createHash3("sha256").update(value).digest("hex").slice(0, 24)}`;
}
function extractEffort(input) {
  return effortValue(input.effort) || effortValue(input.model?.effort) || effortValue(input.reasoning_effort) || effortValue(input.output_style?.effort);
}
async function effortFromSettings(cwd, home) {
  const candidates = [
    path6.join(cwd, ".claude", "settings.local.json"),
    path6.join(cwd, ".claude", "settings.json"),
    path6.join(home, ".claude", "settings.local.json"),
    path6.join(home, ".claude", "settings.json")
  ];
  for (const candidate of candidates) {
    try {
      const settings = JSON.parse(await fs5.readFile(candidate, "utf8"));
      const effort = effortValue(settings?.effortLevel);
      if (effort)
        return effort;
    } catch {
    }
  }
  return "";
}
async function appendMetric(filePath, row) {
  try {
    await ensurePrivateDirectory(path6.dirname(filePath));
    await fs5.appendFile(filePath, row, { encoding: "utf8", mode: 384 });
    await ensurePrivateFile(filePath);
  } catch {
  }
}
async function readMetricRows(filePath) {
  try {
    await repairPrivateDirectory(path6.dirname(filePath));
    await ensurePrivateFile(filePath);
    return (await fs5.readFile(filePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => line.split("	"));
  } catch {
    return [];
  }
}
function compactBreakEvenTurns(totalInput, summaryTokens = PROVIDER_DEFAULTS.compactSummaryTokens) {
  if (totalInput == null || totalInput <= summaryTokens * 2)
    return null;
  const numerator = 2 * totalInput + 125 * summaryTokens;
  const denominator = 2 * (totalInput - summaryTokens);
  return Math.max(1, Math.round(numerator / denominator));
}
async function compactTelemetry(input, turns, home, now, writeLogs, options) {
  const used = input.context_window?.used_percentage;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const totalInput = floorNumber(input.context_window?.total_input_tokens);
  const target = options.compactTargetPercent ?? PROVIDER_DEFAULTS.compactTargetPercent;
  const breakEvenTurns = compactBreakEvenTurns(totalInput, options.compactSummaryTokens ?? PROVIDER_DEFAULTS.compactSummaryTokens);
  if (typeof used !== "number" || !Number.isFinite(used) || !sessionId) {
    return { forcedTurns: null, breakEvenTurns, inForcedZone: false };
  }
  const filePath = path6.join(home, ".claude", "context-log", `${metricSessionName(sessionId)}.tsv`);
  let rows = await readMetricRows(filePath);
  const last = rows.at(-1);
  const lastPercent = last ? Number(last[1]) : null;
  if (lastPercent == null || lastPercent !== used) {
    if (lastPercent != null && Math.floor(lastPercent) - Math.floor(used) >= 3) {
      rows = [];
      if (writeLogs) {
        try {
          await atomicWritePrivate(filePath, "");
        } catch {
        }
      }
    }
    const next = [String(now), String(used), String(turns)];
    rows.push(next);
    if (writeLogs)
      await appendMetric(filePath, `${next.join("	")}
`);
  }
  const recent = rows.slice(-(options.recentContextRows ?? PROVIDER_DEFAULTS.recentContextRows));
  if (recent.length >= 2) {
    const first = recent[0];
    const latest = recent.at(-1);
    const deltaPercent = Number(latest[1]) - Number(first[1]);
    const deltaTurns = Number(latest[2]) - Number(first[2]);
    if (deltaPercent > 0 && deltaTurns > 0) {
      if (used >= target) {
        return { forcedTurns: 0, breakEvenTurns, inForcedZone: true };
      }
      return {
        forcedTurns: Math.max(1, Math.round((target - used) / (deltaPercent / deltaTurns))),
        breakEvenTurns,
        inForcedZone: false
      };
    }
  }
  return { forcedTurns: null, breakEvenTurns, inForcedZone: false };
}
async function logCost(input, home, now) {
  const cost = input.cost?.total_cost_usd;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId || typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
    return;
  }
  const filePath = path6.join(home, ".claude", "cost-log", `${metricSessionName(sessionId)}.tsv`);
  const rows = await readMetricRows(filePath);
  if (Number(rows.at(-1)?.[1]) !== cost) {
    await appendMetric(filePath, `${now}	${cost}
`);
  }
}
function contextPercent(input) {
  const native = input.context_window?.used_percentage;
  if (typeof native === "number" && Number.isFinite(native)) {
    return Math.max(0, Math.min(100, native));
  }
  const usage = input.context_window?.current_usage;
  const size = input.context_window?.context_window_size;
  if (!usage || typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const used = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return Math.max(0, Math.min(100, used / size * 100));
}
async function deriveClaudeTelemetry(input, options = {}) {
  const home = options.home || os3.homedir();
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  const cwd = input.workspace?.current_dir || input.cwd || "";
  const transcriptPath = input.transcript_path || "";
  const transcript = await readTranscriptFacts(transcriptPath, home);
  const turns = transcript?.turns ?? 0;
  const health = options.healthSource ? await healthState(options.healthSource, now, home) : { indicator: "", stale: false };
  const writeLogs = options.writeLogs ?? true;
  if (writeLogs)
    await logCost(input, home, now);
  return {
    observedAt: now,
    turns,
    effort: extractEffort(input) || await effortFromSettings(cwd, home),
    cache: transcript ? {
      expiresAt: transcript.mtimeSeconds + transcript.cacheTtlSeconds,
      ttlSeconds: transcript.cacheTtlSeconds
    } : null,
    compact: await compactTelemetry(input, turns, home, now, writeLogs, options),
    apiHealthIndicator: health.indicator,
    healthCacheStale: health.stale
  };
}

// ../../packages/provider/dist/claude.js
var FIVE_HOUR_SECONDS = 18e3;
var SEVEN_DAY_SECONDS = 604800;
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function resetValue(value) {
  return typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value !== "";
}
function normalizeClaudeStatus(input, state, derived) {
  const model = safePath(input.model?.display_name || input.model?.id) || state.model;
  const cwd = safePath(input.workspace?.current_dir || input.cwd) || state.cwd;
  const limits = [];
  const resets = [];
  const five = input.rate_limits?.five_hour;
  const seven = input.rate_limits?.seven_day;
  if (finite(five?.used_percentage)) {
    limits.push({
      label: "5h",
      percent: five.used_percentage,
      resetAt: five.resets_at,
      windowSeconds: FIVE_HOUR_SECONDS
    });
  }
  if (finite(seven?.used_percentage)) {
    limits.push({
      label: "7d",
      percent: seven.used_percentage,
      resetAt: seven.resets_at,
      windowSeconds: SEVEN_DAY_SECONDS
    });
  }
  if (resetValue(five?.resets_at))
    resets.push({ label: "5h", resetAt: five.resets_at });
  if (resetValue(seven?.resets_at))
    resets.push({ label: "7d", resetAt: seven.resets_at });
  return {
    platform: "claude",
    observedAt: derived.observedAt,
    model,
    cwd,
    context: contextPercent(input),
    contextSize: finite(input.context_window?.context_window_size) ? input.context_window.context_window_size : null,
    totalInput: finite(input.context_window?.total_input_tokens) ? input.context_window.total_input_tokens : null,
    turns: derived.turns,
    effort: derived.effort,
    limits,
    resets,
    cost: finite(input.cost?.total_cost_usd) ? input.cost.total_cost_usd : null,
    linesAdded: finite(input.cost?.total_lines_added) ? input.cost.total_lines_added : null,
    linesRemoved: finite(input.cost?.total_lines_removed) ? input.cost.total_lines_removed : null,
    status: state.status,
    tools: state.tools,
    agents: state.agents,
    plan: state.plan,
    cache: derived.cache,
    compact: derived.compact,
    apiHealthIndicator: derived.apiHealthIndicator,
    healthCacheStale: derived.healthCacheStale
  };
}

// ../../packages/provider/dist/hosts.js
function finite2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function statusModel(input) {
  return typeof input.model === "object" ? String(input.model?.display_name || input.model?.id || "") : "";
}
function effortFromStatus(input) {
  const model = input.model || {};
  if (model.max_mode === true)
    return "max";
  const cursorSummary = typeof model.param_summary === "string" ? model.param_summary : "";
  const values = [
    cursorSummary,
    input.model?.effort,
    input.effort,
    input.reasoning_effort,
    statusModel(input).match(/\(([^()]*)\)\s*$/)?.[1]
  ];
  for (const value of values) {
    const text = typeof value === "string" ? value : typeof value === "object" && value ? value.level || value.effort || "" : "";
    const match = String(text).toLowerCase().match(/(?:effort|reasoning)\s*=\s*(low|medium|high|xhigh|max)|\b(low|medium|high|xhigh|max)\b/);
    if (match)
      return match[1] || match[2] || "";
  }
  return "";
}
function statusCwd(input) {
  return input.workspace?.current_dir || input.cwd || "";
}
function sharedFacts(platform, input, state, observedAt) {
  const cwd = statusCwd(input) || state.cwd;
  return {
    platform,
    observedAt,
    model: statusModel(input) || state.model,
    cwd,
    context: finite2(input.context_window?.used_percentage),
    contextSize: finite2(input.context_window?.context_window_size),
    totalInput: finite2(input.context_window?.total_input_tokens),
    turns: state.turns || 0,
    effort: effortFromStatus(input),
    tools: state.tools,
    plan: state.plan
  };
}
function normalizeCursorStatus(input, state, observedAt = Math.floor(Date.now() / 1e3)) {
  return {
    ...sharedFacts("cursor", input, state, observedAt),
    limits: [],
    resets: [],
    git: null,
    status: state.status,
    agents: state.agents
  };
}
function antigravityStatus(input, state) {
  if (input.tool_confirmation_pending)
    return "waiting";
  if ((finite2(input.task_count) || 0) > 0)
    return "working";
  if (input.agent_state === "idle")
    return "idle";
  if (["thinking", "working", "tool_use", "initializing"].includes(String(input.agent_state)))
    return "working";
  return state.status;
}
function antigravityQuota(input) {
  const limits = [];
  const resets = [];
  for (const [bucket, value] of Object.entries(input.quota || {})) {
    const remaining = finite2(value?.remaining_fraction);
    if (remaining == null)
      continue;
    const label = /weekly|seven.?day|7d/i.test(bucket) ? "7d" : /daily|one.?day|1d/i.test(bucket) ? "1d" : bucket;
    const resetAt = value.reset_time;
    limits.push({
      label,
      percent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
      ...resetAt == null ? {} : { resetAt }
    });
    if (resetAt != null)
      resets.push({ label, resetAt });
  }
  return { limits, resets };
}
function normalizeAntigravityStatus(input, state, observedAt = Math.floor(Date.now() / 1e3)) {
  const quota = antigravityQuota(input);
  const taskCount = Math.max(0, Math.floor(finite2(input.task_count) || 0));
  const agents = taskCount > 0 && !state.agents.some((agent) => agent.status === "running") ? [
    {
      id: "antigravity:tasks",
      type: taskCount === 1 ? "task" : `${taskCount} tasks`,
      status: "running"
    },
    ...state.agents
  ] : state.agents;
  return {
    ...sharedFacts("antigravity", input, state, observedAt),
    limits: quota.limits,
    resets: quota.resets,
    git: input.vcs?.branch ? {
      branch: input.vcs.branch,
      detached: false,
      dirty: input.vcs.dirty === true,
      ahead: 0,
      behind: 0
    } : null,
    status: antigravityStatus(input, state),
    agents
  };
}

// ../../packages/provider/dist/store.js
import fs6 from "node:fs/promises";
import path8 from "node:path";

// ../../packages/provider/dist/hooks/normalize.js
import path7 from "node:path";
var HOST_EVENT_NAMES = {
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  stop: "Stop"
};
var CODEX_COMMAND_TOOLS = /* @__PURE__ */ new Set([
  "bash",
  "exec_command",
  "shell",
  "shell_command",
  "terminal"
]);
var WAITING_NOTIFICATION_TYPES = /* @__PURE__ */ new Set([
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input"
]);
function canonicalEventName(value) {
  const event = safeText(value, 40);
  return HOST_EVENT_NAMES[event] || event || "Unknown";
}
function detectPlatform(input, env, hint) {
  if (hint)
    return hint;
  if (env.PLUGIN_ROOT || String(input.transcript_path || "").includes("/.codex/")) {
    return "codex";
  }
  if (env.CLAUDE_PLUGIN_ROOT || String(input.transcript_path || "").includes("/.claude/")) {
    return "claude";
  }
  const transcript = String(input.transcript_path || input.transcriptPath || "");
  if (transcript.includes("/.gemini/antigravity"))
    return "antigravity";
  if (transcript.includes("/.cursor/") || typeof input.cursor_version === "string")
    return "cursor";
  return "agent";
}
function sessionKey(input) {
  return safeText(input.session_id || input.conversation_id || input.conversationId, 160) || safePath(input.transcript_path || input.transcriptPath) || `${safePath(input.cwd || input.workspacePaths?.[0] || input.workspace_roots?.[0]) || "unknown"}:default`;
}
function modelName(input) {
  if (typeof input.model === "string")
    return safeText(input.model, 80);
  return safeText(input.model?.display_name || input.model?.id, 80);
}
function toolTarget(name, toolInput) {
  if (!toolInput || typeof toolInput !== "object")
    return "";
  const rawPath = toolInput.file_path || toolInput.path || toolInput.workdir || toolInput.cwd || toolInput.TargetFile || toolInput.AbsolutePath || toolInput.DirectoryPath || toolInput.Cwd;
  if (typeof rawPath === "string")
    return safeText(path7.basename(rawPath), 48);
  const command = toolInput.command || toolInput.CommandLine;
  if (["Bash", "Shell", "run_command"].includes(name) && typeof command === "string") {
    return safeText(command.trim().split(/\s+/)[0], 32);
  }
  if (name === "apply_patch")
    return "patch";
  return "";
}
function normalizePlan(name, toolInput) {
  const raw = name === "update_plan" ? toolInput?.plan : name === "TodoWrite" ? toolInput?.todos : null;
  if (!Array.isArray(raw))
    return null;
  return raw.slice(0, 40).map((item) => ({
    text: safeText(item?.step || item?.content || item?.subject, 120),
    status: ["pending", "in_progress", "completed"].includes(item?.status) ? item.status : "pending"
  })).filter((item) => item.text);
}
function hasRunningBackgroundTask(input) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, "background_tasks");
    if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) {
      return false;
    }
    return descriptor.value.some((task) => {
      if (!task || typeof task !== "object" || Array.isArray(task))
        return false;
      const status = Object.getOwnPropertyDescriptor(task, "status");
      return Boolean(status && "value" in status && status.value === "running");
    });
  } catch {
    return false;
  }
}
function nonzeroExitCode(value, depth = 0, seen = /* @__PURE__ */ new Set()) {
  if (!value || typeof value !== "object" || depth > 6)
    return false;
  if (seen.has(value))
    return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => nonzeroExitCode(item, depth + 1, seen));
  }
  for (const [key, field] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (normalized === "exitcode" && (typeof field === "number" && field !== 0 || typeof field === "string" && /^-?\d+$/.test(field) && Number(field) !== 0))
      return true;
    if (nonzeroExitCode(field, depth + 1, seen))
      return true;
  }
  return false;
}
function normalizeHookEvent(input, env = process.env, now = Date.now(), hints = {}) {
  let type = canonicalEventName(hints.event || input.hook_event_name);
  if (type === "PostToolUse" && typeof input.error === "string" && input.error.length > 0) {
    type = "PostToolUseFailure";
  }
  const name = safeText(input.tool_name || input.toolCall?.name, 80);
  const toolInput = input.tool_input || input.toolCall?.args;
  const platform = detectPlatform(input, env, hints.platform);
  const codexCommandFailed = platform === "codex" && CODEX_COMMAND_TOOLS.has(name.toLowerCase()) && nonzeroExitCode(input.tool_response);
  const event = {
    v: 1,
    at: now,
    sessionId: sessionKey(input),
    platform,
    type,
    cwd: safePath(input.cwd || input.workspacePaths?.[0] || input.workspace_roots?.[0]),
    transcriptPath: safePath(input.transcript_path || input.transcriptPath),
    model: modelName(input),
    turnId: safeText(input.turn_id || input.generation_id || input.generationId, 120)
  };
  if (type === "Stop") {
    event.backgroundTasksRunning = platform === "antigravity" ? input.fullyIdle === false : hasRunningBackgroundTask(input);
  }
  if (type === "PermissionRequest") {
    event.needsInput = true;
  } else if (type === "Notification") {
    event.needsInput = WAITING_NOTIFICATION_TYPES.has(safeText(input.notification_type, 60));
  }
  if (type === "PreToolUse" || type === "PostToolUse" || type === "PostToolUseFailure") {
    const structuralId = input.tool_use_id ?? input.toolCall?.id ?? (Number.isInteger(input.stepIdx) ? `step:${input.stepIdx}` : "");
    event.tool = {
      id: safeText(structuralId, 120) || `${name || "tool"}:${input.turn_id || input.generation_id || now}`,
      name,
      target: toolTarget(name, toolInput),
      status: type === "PreToolUse" ? "running" : type === "PostToolUseFailure" || codexCommandFailed ? "error" : "completed"
    };
    const plan = normalizePlan(name, toolInput);
    if (plan && type !== "PreToolUse")
      event.plan = plan;
  }
  if (type === "SubagentStart" || type === "SubagentStop") {
    event.agent = {
      id: safeText(input.agent_id || input.subagent_id, 120) || `agent:${input.turn_id || input.generation_id || now}`,
      type: safeText(input.agent_type || input.subagent_type, 60) || "agent",
      status: type === "SubagentStart" ? "running" : ["error", "failed"].includes(safeText(input.status, 20).toLowerCase()) ? "error" : "completed"
    };
  }
  return event;
}

// ../../packages/provider/dist/store.js
var RECENT_TTL_MS = 5 * 60 * 1e3;
var EVENT_FILE_HYGIENE = {
  fileNamePattern: /^[a-f0-9]{24}\.jsonl$/,
  maxAgeMs: 30 * 24 * 60 * 60 * 1e3,
  maxEntries: 256,
  // An idle-but-open terminal can sit for hours before its next hook. Count
  // pressure only considers sessions untouched for a full day.
  preserveYoungerThanMs: 24 * 60 * 60 * 1e3
};
async function recordHook(input, options = {}) {
  const dataDir = options.dataDir || resolveDataDir(options.env);
  const event = normalizeHookEvent(input, options.env, options.now?.() ?? Date.now(), options);
  const filePath = eventFileFor(dataDir, event.sessionId);
  await appendJsonLine(filePath, event);
  await maybeSweepPrivateFiles(dataDir, EVENT_FILE_HYGIENE, {
    protectedPaths: [filePath]
  });
  return { event, filePath };
}
function parseEvents(text) {
  const result = [];
  for (const line of text.split("\n")) {
    if (!line.trim())
      continue;
    try {
      const event = JSON.parse(line);
      if (event?.v === 1 && Number.isFinite(event.at))
        result.push(event);
    } catch {
    }
  }
  return result.sort((a, b) => a.at - b.at);
}
function foldEvents(events, now = Date.now()) {
  const state = {
    platform: "agent",
    sessionId: "",
    cwd: "",
    transcriptPath: "",
    model: "",
    status: "idle",
    tools: [],
    agents: [],
    plan: [],
    updatedAt: 0,
    turns: 0
  };
  const tools = /* @__PURE__ */ new Map();
  const agents = /* @__PURE__ */ new Map();
  const turns = /* @__PURE__ */ new Set();
  let lastSessionEndOrder = -1;
  let lastSessionStartOrder = -1;
  let lastWaitingOrder = -1;
  for (const [order, event] of events.entries()) {
    state.platform = event.platform || state.platform;
    state.sessionId = event.sessionId || state.sessionId;
    state.cwd = event.cwd || state.cwd;
    state.transcriptPath = event.transcriptPath || state.transcriptPath;
    state.model = event.model || state.model;
    state.updatedAt = Math.max(state.updatedAt, event.at);
    if (event.type === "SessionStart" || event.type === "UserPromptSubmit" || event.type === "PreToolUse" || event.type === "PostToolUse" || event.type === "PostToolUseFailure" || event.type === "SubagentStop" || event.type === "PreInvocation" || event.type === "PostInvocation") {
      state.status = "working";
    }
    if (event.type === "SessionStart") {
      lastSessionStartOrder = order;
    }
    if (event.needsInput) {
      state.status = "waiting";
      lastWaitingOrder = order;
    }
    if (event.type === "Stop") {
      state.status = event.backgroundTasksRunning ? "working" : "idle";
    }
    if (event.type === "SessionEnd") {
      state.status = "idle";
      lastSessionEndOrder = order;
    }
    if (event.type === "UserPromptSubmit")
      turns.add(event.turnId || `at:${event.at}`);
    if (event.tool) {
      const id = event.tool.id || `tool:${event.at}`;
      const previous = tools.get(id)?.activity;
      tools.set(id, {
        activity: {
          ...previous,
          ...event.tool,
          name: event.tool.name || previous?.name || "tool",
          target: event.tool.target || previous?.target,
          startedAt: previous?.startedAt || event.at,
          updatedAt: event.at
        },
        order
      });
    }
    if (event.agent) {
      const id = event.agent.id || `agent:${event.at}`;
      const previous = agents.get(id)?.activity;
      agents.set(id, {
        activity: {
          ...previous,
          ...event.agent,
          startedAt: previous?.startedAt || event.at,
          updatedAt: event.at
        },
        order
      });
    }
    if (event.plan)
      state.plan = event.plan;
  }
  const visibleTools = [...tools.values()].filter(({ activity, order }) => !(activity.status === "running" && (order < lastSessionStartOrder || order <= lastSessionEndOrder)) && (activity.status === "running" || now - (activity.updatedAt ?? 0) <= RECENT_TTL_MS)).sort((a, b) => (b.activity.updatedAt ?? 0) - (a.activity.updatedAt ?? 0));
  const visibleAgents = [...agents.values()].filter(({ activity, order }) => !(activity.status === "running" && (order < lastSessionStartOrder || order <= lastSessionEndOrder)) && (activity.status === "running" || now - (activity.updatedAt ?? 0) <= RECENT_TTL_MS)).sort((a, b) => (b.activity.updatedAt ?? 0) - (a.activity.updatedAt ?? 0));
  state.tools = visibleTools.map(({ activity }) => activity);
  state.agents = visibleAgents.map(({ activity }) => activity);
  state.turns = turns.size;
  const lastActivityBoundaryOrder = Math.max(lastSessionEndOrder, lastSessionStartOrder - 1, lastWaitingOrder);
  if (visibleTools.some(({ activity, order }) => activity.status === "running" && order > lastActivityBoundaryOrder) || visibleAgents.some(({ activity, order }) => activity.status === "running" && order > lastActivityBoundaryOrder)) {
    state.status = "working";
  }
  return state;
}
async function candidateFiles(dataDir) {
  let entries;
  try {
    entries = await fs6.readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl"))
      continue;
    const filePath = path8.join(dataDir, entry.name);
    try {
      const stat = await fs6.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 24);
}
async function canonicalPath(value) {
  try {
    return await fs6.realpath(value);
  } catch {
    return path8.resolve(value);
  }
}
async function loadState(query = {}, options = {}) {
  const dataDir = options.dataDir || resolveDataDir(options.env);
  await ensurePrivateDirectory(dataDir).catch(() => void 0);
  const finish = async (state, protectedPath) => {
    await maybeSweepPrivateFiles(dataDir, EVENT_FILE_HYGIENE, {
      protectedPaths: protectedPath ? [protectedPath] : []
    });
    return state;
  };
  const queryCwd = query.cwd ? await canonicalPath(query.cwd) : "";
  const exactKey = safeText(query.sessionId, 160);
  if (exactKey) {
    try {
      const text = await readTail(eventFileFor(dataDir, exactKey));
      const events = parseEvents(text);
      if (events.length) {
        const filePath = eventFileFor(dataDir, exactKey);
        const state = foldEvents(events, options.now?.() ?? Date.now());
        if (!query.platform || state.platform === query.platform) {
          return finish(state, filePath);
        }
      }
    } catch {
    }
  }
  const files = await candidateFiles(dataDir);
  let fallback = null;
  let fallbackPath = "";
  for (const { filePath } of files) {
    try {
      const events = parseEvents(await readTail(filePath));
      if (!events.length)
        continue;
      const state = foldEvents(events, options.now?.() ?? Date.now());
      if (query.platform && state.platform !== query.platform)
        continue;
      if (query.transcriptPath && state.transcriptPath === query.transcriptPath) {
        return finish(state, filePath);
      }
      if (queryCwd && state.cwd && await canonicalPath(state.cwd) === queryCwd) {
        return finish(state, filePath);
      }
      if (!queryCwd && !query.transcriptPath && !fallback) {
        fallback = state;
        fallbackPath = filePath;
      }
    } catch {
    }
  }
  const empty = foldEvents([], options.now?.() ?? Date.now());
  empty.cwd = query.cwd || "";
  empty.transcriptPath = query.transcriptPath || "";
  empty.sessionId = query.sessionId || "";
  empty.platform = query.platform || empty.platform;
  return finish(fallback || empty, fallback ? fallbackPath : void 0);
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
function healthSourceById(id) {
  return HEALTH_SOURCES.find((source) => source.id === id) ?? null;
}

// src/adapter.ts
import path9 from "node:path";

// src/design.ts
var HUD_DESIGN = {
  warning: {
    /**
     * The API is stateless: system + history is resent and the cached prefix is
     * read on every turn. C×N is therefore a useful action trigger: it rises
     * when either context or turn count makes continued re-reading expensive.
     *
     * These thresholds preserve the shell HUD's regression-calibrated ≈$4 and
     * ≈$13 attention points. Re-read share was intentionally rejected because
     * it stays roughly constant and cannot answer *when* to compact.
     */
    contextPressure: { yellow: 5e6, red: 16e6 },
    /**
     * Fullness is deliberately independent from pressure. It answers “should I
     * compact now?”, while C×N answers “is repeated context reading expensive?”
     */
    contextFullness: { yellow: 70, red: 80 },
    costUsd: { yellow: 4, red: 13 },
    quotaUsage: { yellow: 60, red: 85 },
    quotaPace: { yellow: 120, red: 200 },
    forcedCompactTurns: { yellow: 6, red: 3 }
  },
  cache: {
    fallbackTtlSeconds: 3600,
    expiringWithinSeconds: 300
  },
  compact: {
    /**
     * Median residual context measured after an in-session context reset in the
     * shell HUD. It drives the voluntary /compact break-even estimate.
     */
    summaryTokens: 17e3,
    /** Far-away estimates are noise; the instantaneous context box is enough. */
    forcedEtaMaxTurns: 30,
    breakEvenMaxTurns: 15,
    /** The shell used at most six changed-percentage rows for the recent slope. */
    recentChangedRows: 6
  },
  quota: {
    fiveHourSeconds: 18e3,
    sevenDaySeconds: 604800,
    paceNoiseFloorFraction: 0.1,
    paceNoiseFloorUsage: 8
  },
  layout: {
    /** Below 60 columns the optional decision-support line disappears whole. */
    narrowColumns: 60,
    cwdFallbackColumns: 36,
    cwdReservedColumns: 22,
    cwdMinimumColumns: 14
  }
};
function healthSeverity(indicator) {
  if (indicator === "major" || indicator === "critical") return "red";
  if (indicator === "minor") return "yellow";
  return "plain";
}

// src/adapter.ts
function cacheView(facts) {
  if (!facts.cache) return null;
  const remaining = facts.cache.expiresAt - facts.observedAt;
  return {
    expiresAt: facts.cache.expiresAt,
    state: remaining <= 0 ? "cold" : remaining <= HUD_DESIGN.cache.expiringWithinSeconds ? "expiring" : "warm"
  };
}
function compactAdvisor(facts) {
  const compact = facts.compact;
  if (compact.inForcedZone || compact.forcedTurns != null && compact.forcedTurns <= HUD_DESIGN.compact.forcedEtaMaxTurns) {
    return {
      kind: "forced",
      turns: compact.forcedTurns ?? 0,
      full: compact.inForcedZone || compact.forcedTurns === 0
    };
  }
  if (compact.breakEvenTurns != null && compact.breakEvenTurns <= HUD_DESIGN.compact.breakEvenMaxTurns) {
    return {
      kind: "break-even",
      turns: compact.breakEvenTurns,
      full: false
    };
  }
  return null;
}
function snapshotFromClaude(facts, git = null, promotion = null) {
  const cwd = facts.cwd;
  return {
    platform: "claude",
    observedAt: facts.observedAt,
    model: facts.model,
    cwd,
    project: cwd ? path9.basename(cwd) : "",
    context: facts.context,
    contextSize: facts.contextSize,
    totalInput: facts.totalInput,
    turns: facts.turns,
    effort: facts.effort,
    limits: facts.limits,
    resets: facts.resets,
    git,
    cost: facts.cost,
    linesAdded: facts.linesAdded,
    linesRemoved: facts.linesRemoved,
    status: facts.status,
    tools: facts.tools,
    agents: facts.agents,
    plan: facts.plan,
    modelSeverity: healthSeverity(facts.apiHealthIndicator),
    cache: cacheView(facts),
    compactAdvisor: compactAdvisor(facts),
    promotion
  };
}
function snapshotFromState(state, git = null, promotion = null) {
  const cwd = state.cwd;
  return {
    platform: state.platform,
    observedAt: 0,
    model: state.model,
    cwd,
    project: cwd ? path9.basename(cwd) : "",
    context: null,
    contextSize: null,
    totalInput: null,
    turns: state.turns || 0,
    effort: "",
    limits: [],
    resets: [],
    git,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    status: state.status,
    tools: state.tools,
    agents: state.agents,
    plan: state.plan,
    modelSeverity: "plain",
    cache: null,
    compactAdvisor: null,
    promotion
  };
}
function snapshotFromCursor(facts, git = null, promotion = null) {
  const cwd = facts.cwd;
  return {
    platform: "cursor",
    observedAt: facts.observedAt,
    model: facts.model,
    effort: facts.effort,
    project: cwd ? path9.basename(cwd) : "",
    cwd,
    context: facts.context,
    contextSize: facts.contextSize,
    totalInput: facts.totalInput,
    turns: facts.turns,
    limits: facts.limits,
    resets: facts.resets,
    git: facts.git || git,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    status: facts.status,
    tools: facts.tools,
    agents: facts.agents,
    plan: facts.plan,
    modelSeverity: "plain",
    cache: null,
    compactAdvisor: null,
    promotion
  };
}
function snapshotFromAntigravity(facts, fallbackGit = null, promotion = null) {
  const cwd = facts.cwd;
  return {
    platform: "antigravity",
    observedAt: facts.observedAt,
    model: facts.model,
    effort: facts.effort,
    project: cwd ? path9.basename(cwd) : "",
    cwd,
    context: facts.context,
    contextSize: facts.contextSize,
    totalInput: facts.totalInput,
    turns: facts.turns,
    limits: facts.limits,
    resets: facts.resets,
    git: facts.git || fallbackGit,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    status: facts.status,
    tools: facts.tools,
    agents: facts.agents,
    plan: facts.plan,
    modelSeverity: "plain",
    cache: null,
    compactAdvisor: null,
    promotion
  };
}

// src/promotions-cli.ts
function promotions(platform, endpoint) {
  const sources = promotionSources();
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.stdout.write(`config: ${resolveConfigPath()}
`);
  process.stdout.write(`cache: ${sharedCachePath()}
`);
  process.stdout.write(`local zone: ${localZone}
`);
  process.stdout.write(`shared: ${sharedSummary(sources)}
`);
  const normalizedEndpoint = endpoint === void 0 ? void 0 : endpointHost(endpoint);
  const endpointFilter = endpoint === void 0 ? "not provided (endpoint-scoped windows excluded)" : normalizedEndpoint || "invalid";
  process.stdout.write(
    `filter: platform ${platform ?? "all"}; endpoint ${endpointFilter}
`
  );
  const windows = [...sources.local, ...sources.shared];
  if (!windows.length) {
    process.stdout.write("windows: none configured\n");
  }
  for (const window of sources.local) describe(window, "local");
  for (const window of sources.shared) describe(window, "shared");
  const status = resolvePromotion(windows, { platform, endpoint });
  process.stdout.write(
    status === null ? "now: no window active or upcoming\n" : status.changesAt === null ? `now: ${status.id} active, no end date
` : `now: ${status.id} ${status.active ? "active until" : "starts"} ${localTime(status.changesAt)}
`
  );
}
function sharedSummary(sources) {
  if (sources.sharedOrigin === "off") return "off (disabled in config)";
  const frozen = remoteFetchDisabled();
  if (sources.sharedOrigin === "bundled") {
    return frozen ? "bundled copy (AGENT_HUD_NO_REMOTE is set)" : `bundled copy, not fetched yet from ${sharedPromotionsUrl()}`;
  }
  const fetched = sources.sharedFetchedAt ? localTime(sources.sharedFetchedAt) : "an unknown time";
  const refresh = frozen ? " (AGENT_HUD_NO_REMOTE is set, not refreshing)" : sources.sharedStale ? ", refresh due" : "";
  return `fetched ${fetched}${refresh} from ${sources.sharedSource ?? sharedPromotionsUrl()}`;
}
function describe(window, origin) {
  const scope = [
    window.timezone || "UTC",
    window.platforms?.join(",") || "all hosts",
    window.endpoints?.join(",") || "",
    window.days ? `days ${window.days.join(",")}` : "",
    window.from || window.until ? `${window.from || "\u2026"}..${window.until || "\u2026"}` : ""
  ].filter(Boolean).join("  ");
  process.stdout.write(
    `  ${origin}  ${window.id}  ${window.label || "-"}  ${window.start}-${window.end}  ${scope}
`
  );
}
function localTime(epochSeconds) {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(epochSeconds * 1e3));
}

// src/render.ts
import os4 from "node:os";
import path10 from "node:path";

// ../../node_modules/get-east-asian-width/lookup-data.js
var ambiguousMinimalCodePoint = 161;
var ambiguousMaximumCodePoint = 1114109;
var ambiguousRanges = [161, 161, 164, 164, 167, 168, 170, 170, 173, 174, 176, 180, 182, 186, 188, 191, 198, 198, 208, 208, 215, 216, 222, 225, 230, 230, 232, 234, 236, 237, 240, 240, 242, 243, 247, 250, 252, 252, 254, 254, 257, 257, 273, 273, 275, 275, 283, 283, 294, 295, 299, 299, 305, 307, 312, 312, 319, 322, 324, 324, 328, 331, 333, 333, 338, 339, 358, 359, 363, 363, 462, 462, 464, 464, 466, 466, 468, 468, 470, 470, 472, 472, 474, 474, 476, 476, 593, 593, 609, 609, 708, 708, 711, 711, 713, 715, 717, 717, 720, 720, 728, 731, 733, 733, 735, 735, 768, 879, 913, 929, 931, 937, 945, 961, 963, 969, 1025, 1025, 1040, 1103, 1105, 1105, 8208, 8208, 8211, 8214, 8216, 8217, 8220, 8221, 8224, 8226, 8228, 8231, 8240, 8240, 8242, 8243, 8245, 8245, 8251, 8251, 8254, 8254, 8308, 8308, 8319, 8319, 8321, 8324, 8364, 8364, 8451, 8451, 8453, 8453, 8457, 8457, 8467, 8467, 8470, 8470, 8481, 8482, 8486, 8486, 8491, 8491, 8531, 8532, 8539, 8542, 8544, 8555, 8560, 8569, 8585, 8585, 8592, 8601, 8632, 8633, 8658, 8658, 8660, 8660, 8679, 8679, 8704, 8704, 8706, 8707, 8711, 8712, 8715, 8715, 8719, 8719, 8721, 8721, 8725, 8725, 8730, 8730, 8733, 8736, 8739, 8739, 8741, 8741, 8743, 8748, 8750, 8750, 8756, 8759, 8764, 8765, 8776, 8776, 8780, 8780, 8786, 8786, 8800, 8801, 8804, 8807, 8810, 8811, 8814, 8815, 8834, 8835, 8838, 8839, 8853, 8853, 8857, 8857, 8869, 8869, 8895, 8895, 8978, 8978, 9312, 9449, 9451, 9547, 9552, 9587, 9600, 9615, 9618, 9621, 9632, 9633, 9635, 9641, 9650, 9651, 9654, 9655, 9660, 9661, 9664, 9665, 9670, 9672, 9675, 9675, 9678, 9681, 9698, 9701, 9711, 9711, 9733, 9734, 9737, 9737, 9742, 9743, 9756, 9756, 9758, 9758, 9792, 9792, 9794, 9794, 9824, 9825, 9827, 9829, 9831, 9834, 9836, 9837, 9839, 9839, 9886, 9887, 9919, 9919, 9926, 9933, 9935, 9939, 9941, 9953, 9955, 9955, 9960, 9961, 9963, 9969, 9972, 9972, 9974, 9977, 9979, 9980, 9982, 9983, 10045, 10045, 10102, 10111, 11094, 11097, 12872, 12879, 57344, 63743, 65024, 65039, 65533, 65533, 127232, 127242, 127248, 127277, 127280, 127337, 127344, 127373, 127375, 127376, 127387, 127404, 917760, 917999, 983040, 1048573, 1048576, 1114109];
var fullwidthMinimalCodePoint = 12288;
var fullwidthMaximumCodePoint = 65510;
var fullwidthRanges = [12288, 12288, 65281, 65376, 65504, 65510];
var wideMinimalCodePoint = 4352;
var wideMaximumCodePoint = 262141;
var wideRanges = [4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141];

// ../../node_modules/get-east-asian-width/utilities.js
var isInRange = (ranges, codePoint) => {
  let low = 0;
  let high = Math.floor(ranges.length / 2) - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const i = mid * 2;
    if (codePoint < ranges[i]) {
      high = mid - 1;
    } else if (codePoint > ranges[i + 1]) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
};

// ../../node_modules/get-east-asian-width/lookup.js
var commonCjkCodePoint = 19968;
var [wideFastPathStart, wideFastPathEnd] = /* @__PURE__ */ findWideFastPathRange(wideRanges);
function findWideFastPathRange(ranges) {
  let fastPathStart = ranges[0];
  let fastPathEnd = ranges[1];
  for (let index = 0; index < ranges.length; index += 2) {
    const start = ranges[index];
    const end = ranges[index + 1];
    if (commonCjkCodePoint >= start && commonCjkCodePoint <= end) {
      return [start, end];
    }
    if (end - start > fastPathEnd - fastPathStart) {
      fastPathStart = start;
      fastPathEnd = end;
    }
  }
  return [fastPathStart, fastPathEnd];
}
var isAmbiguous = (codePoint) => {
  if (codePoint < ambiguousMinimalCodePoint || codePoint > ambiguousMaximumCodePoint) {
    return false;
  }
  return isInRange(ambiguousRanges, codePoint);
};
var isFullWidth = (codePoint) => {
  if (codePoint < fullwidthMinimalCodePoint || codePoint > fullwidthMaximumCodePoint) {
    return false;
  }
  return isInRange(fullwidthRanges, codePoint);
};
var isWide = (codePoint) => {
  if (codePoint >= wideFastPathStart && codePoint <= wideFastPathEnd) {
    return true;
  }
  if (codePoint < wideMinimalCodePoint || codePoint > wideMaximumCodePoint) {
    return false;
  }
  return isInRange(wideRanges, codePoint);
};

// ../../node_modules/get-east-asian-width/index.js
function validate(codePoint) {
  if (!Number.isSafeInteger(codePoint)) {
    throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
  }
}
function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
  validate(codePoint);
  if (isFullWidth(codePoint) || isWide(codePoint) || ambiguousAsWide && isAmbiguous(codePoint)) {
    return 2;
  }
  return 1;
}

// src/terminal-width.ts
var RESET = "\x1B[0m";
var GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
var ESCAPE_AT_START = /^(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))/;
var OSC8 = /^\u001b\]8;;([^\u0007\u001b]*)(?:\u0007|\u001b\\)$/;
var OSC8_CLOSE = "\x1B]8;;\x1B\\";
function tokenize(text) {
  const tokens = [];
  let index = 0;
  let plainStart = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 27) {
      index += 1;
      continue;
    }
    const match = ESCAPE_AT_START.exec(text.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    if (plainStart < index) {
      tokens.push({ type: "text", value: text.slice(plainStart, index) });
    }
    tokens.push({ type: "escape", value: match[0] });
    index += match[0].length;
    plainStart = index;
  }
  if (plainStart < text.length) {
    tokens.push({ type: "text", value: text.slice(plainStart) });
  }
  return tokens;
}
function graphemes(text) {
  if (!text) return [];
  if (!GRAPHEME_SEGMENTER) return Array.from(text);
  return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
}
function cjkAmbiguousWidth() {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || process.env.LANGUAGE || "";
  return /(?:^|:)(?:zh|ja|ko)(?:[_\-.]|$)/i.test(locale);
}
function graphemeWidth(grapheme, ambiguousWide) {
  if (!grapheme) return 0;
  if (new RegExp("\\p{Emoji_Presentation}", "u").test(grapheme) || /[\u200d\u20e3\ufe0f]/u.test(grapheme) || /[\u{1f1e6}-\u{1f1ff}]/u.test(grapheme)) {
    return 2;
  }
  let width = 0;
  for (const character of grapheme) {
    if (new RegExp("^\\p{Mark}$", "u").test(character) || character === "\u200D") continue;
    const codePoint = character.codePointAt(0);
    if (codePoint == null || codePoint === 0 || codePoint < 32 || codePoint >= 127 && codePoint < 160) {
      continue;
    }
    const characterWidth = eastAsianWidth(codePoint, {
      ambiguousAsWide: ambiguousWide
    });
    width = Math.max(width, characterWidth);
  }
  return width;
}
function terminalWidth(text) {
  const ambiguousWide = cjkAmbiguousWidth();
  let width = 0;
  for (const token of tokenize(String(text))) {
    if (token.type === "escape") continue;
    for (const grapheme of graphemes(token.value)) {
      width += graphemeWidth(grapheme, ambiguousWide);
    }
  }
  return width;
}
function truncateLeft(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (terminalWidth(text) <= maxWidth) return text;
  const plain = tokenize(text).filter((token) => token.type === "text").map((token) => token.value).join("");
  const ellipsis = "\u2026";
  const ellipsisWidth = terminalWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsisWidth <= maxWidth ? ellipsis : ".";
  const available = maxWidth - ellipsisWidth;
  const segments = graphemes(plain);
  let suffix = "";
  let width = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const segmentWidth = terminalWidth(segment);
    if (width + segmentWidth > available) break;
    suffix = segment + suffix;
    width += segmentWidth;
  }
  return `${ellipsis}${suffix}`;
}
function truncateRight(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (terminalWidth(text) <= maxWidth) return text;
  const ellipsis = "\u2026";
  const ellipsisWidth = terminalWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsisWidth <= maxWidth ? ellipsis : ".";
  const available = maxWidth - ellipsisWidth;
  const ambiguousWide = cjkAmbiguousWidth();
  let output = "";
  let width = 0;
  let sawEscape = false;
  let hyperlinkOpen = false;
  let full = false;
  for (const token of tokenize(text)) {
    if (token.type === "escape") {
      output += token.value;
      sawEscape = true;
      const hyperlink = OSC8.exec(token.value);
      if (hyperlink) hyperlinkOpen = hyperlink[1].length > 0;
      continue;
    }
    for (const grapheme of graphemes(token.value)) {
      const nextWidth = graphemeWidth(grapheme, ambiguousWide);
      if (width + nextWidth > available) {
        full = true;
        break;
      }
      output += grapheme;
      width += nextWidth;
    }
    if (full) break;
  }
  return `${output}${hyperlinkOpen ? OSC8_CLOSE : ""}${ellipsis}${sawEscape ? RESET : ""}`;
}

// src/render.ts
var RESET2 = "\x1B[0m";
var PALETTE = {
  dim: "\x1B[2m",
  bright: "\x1B[97m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  red: "\x1B[31m"
};
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function paint(name, text, colors) {
  return colors ? `${PALETTE[name]}${text}${RESET2}` : text;
}
function dimLine(text, colors) {
  if (!colors) return text;
  return `${PALETTE.dim}${text.replaceAll(RESET2, `${RESET2}${PALETTE.dim}`)}${RESET2}`;
}
function displayText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "") : "";
}
function toneFor(value, yellowAt, redAt) {
  if (!isFiniteNumber(value)) return null;
  if (value >= redAt) return "red";
  if (value >= yellowAt) return "yellow";
  return null;
}
function signal(value, tone, colors) {
  return tone ? paint(tone, value, colors) : value;
}
function severityTone(severity) {
  return severity && severity !== "plain" ? severity : null;
}
function severityRank(severity) {
  return severity === "red" ? 2 : severity === "yellow" ? 1 : 0;
}
function worseSeverity(left, right) {
  return severityRank(right) > severityRank(left) ? right : left;
}
function toneSeverity(tone) {
  return tone || "plain";
}
function more(hidden, colors) {
  return hidden > 0 ? paint("dim", `+${hidden} more`, colors) : null;
}
function toolLine(tools, colors) {
  if (!tools.length) return null;
  const notable = tools.filter((tool) => tool.status === "running" || tool.status === "error");
  if (notable.length) {
    const visible2 = notable.slice(0, 2);
    const parts2 = visible2.map((tool) => {
      const target = tool.target ? ` ${paint("dim", tool.target, colors)}` : "";
      const marker = tool.status === "error" ? signal("!", "red", colors) : signal("\u25D0", "yellow", colors);
      return `${marker} ${tool.name}${target}`;
    });
    const overflow2 = more(notable.length - visible2.length, colors);
    if (overflow2) parts2.push(overflow2);
    return parts2.join(` ${paint("dim", "\u2502", colors)} `);
  }
  const counts = /* @__PURE__ */ new Map();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
  const grouped = [...counts.entries()];
  const visible = grouped.slice(0, 4);
  const parts = visible.map(([name, count]) => `\u2713 ${name}${count > 1 ? ` \xD7${count}` : ""}`);
  const overflow = more(grouped.length - visible.length, colors);
  if (overflow) parts.push(overflow);
  return parts.join(` ${paint("dim", "\u2502", colors)} `);
}
function agentLine(agents, colors) {
  if (!agents.length) return null;
  const visible = agents.slice(0, 3);
  const parts = visible.map((agent) => {
    const active = agent.status === "running";
    const marker = active ? signal("\u25D0", "yellow", colors) : agent.status === "error" ? signal("!", "red", colors) : "\u2713";
    return `${marker} ${agent.type}`;
  });
  const overflow = more(agents.length - visible.length, colors);
  if (overflow) parts.push(overflow);
  return parts.join(` ${paint("dim", "\u2502", colors)} `);
}
function planLine(plan, colors) {
  if (!plan.length) return null;
  const complete = plan.filter((item) => item.status === "completed").length;
  const active = plan.find((item) => item.status === "in_progress") || plan.find((item) => item.status === "pending");
  const label = active?.text ? ` ${active.text}` : "";
  return `\u25B8${label} ${paint("dim", `(${complete}/${plan.length})`, colors)}`;
}
function statusLine(status, colors) {
  return status === "waiting" ? `${signal("?", "yellow", colors)} needs input` : null;
}
function shortEffort(effort) {
  return { low: "L", medium: "M", high: "H", xhigh: "XH", max: "MAX" }[effort] || effort;
}
function toEpochSeconds(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1e10 ? numeric : numeric / 1e3;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed / 1e3 : null;
}
function formatReset(value, includeWeekday = false) {
  if (value == null || value === "") return "";
  const epoch = toEpochSeconds(value);
  if (epoch == null) return "";
  const date = new Date(epoch * 1e3);
  if (Number.isNaN(date.getTime())) return "";
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  if (!includeWeekday || date.toDateString() === (/* @__PURE__ */ new Date()).toDateString()) return hhmm;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  return `${weekday}${hhmm}`;
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
function promotionToken(snapshot, colors) {
  const promotion = snapshot.promotion;
  const now = isFiniteNumber(snapshot.observedAt) && snapshot.observedAt > 0 ? snapshot.observedAt : Date.now() / 1e3;
  const text = promotionText(promotion, now);
  if (!text) return "";
  return promotion?.active ? paint("green", text, colors) : text;
}
function promotionText(promotion, now) {
  if (!promotion) return "";
  const label = displayText(promotion.label).slice(0, 8);
  if (promotion.changesAt === null) return promotion.active ? `%${label}` : "";
  if (!isFiniteNumber(promotion.changesAt)) return "";
  const time = compactDuration(promotion.changesAt - now);
  return `%${label}${label ? " " : ""}${promotion.active ? "" : "\u2191"}${time}`;
}
function compactTokens(value) {
  if (!isFiniteNumber(value)) return "";
  return value >= 1e3 ? `${Math.floor(value / 1e3)}k` : `${Math.floor(value)}`;
}
function displayPath(cwd) {
  const home = os4.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}${path10.sep}`)) return `~/${cwd.slice(home.length + 1)}`;
  return cwd;
}
function quotaSeverity(snapshot, now = snapshot.observedAt) {
  let binding = snapshot.limits[0];
  for (const limit of snapshot.limits) {
    if (!binding || Math.floor(limit.percent) > Math.floor(binding.percent)) {
      binding = limit;
    }
  }
  if (!binding) return "plain";
  let severity = toneSeverity(toneFor(
    Math.floor(binding.percent),
    HUD_DESIGN.warning.quotaUsage.yellow,
    HUD_DESIGN.warning.quotaUsage.red
  ));
  {
    const limit = binding;
    const reset = toEpochSeconds(limit.resetAt);
    const windowSeconds = limit.windowSeconds;
    if (Math.floor(limit.percent) < HUD_DESIGN.quota.paceNoiseFloorUsage || reset == null || !windowSeconds) return severity;
    const remaining = Math.max(1, Math.min(windowSeconds, reset - now));
    const elapsed = windowSeconds - remaining;
    if (elapsed < windowSeconds * HUD_DESIGN.quota.paceNoiseFloorFraction) return severity;
    const projected = Math.floor(limit.percent) * windowSeconds / elapsed;
    const pace = toneFor(
      projected,
      HUD_DESIGN.warning.quotaPace.yellow,
      HUD_DESIGN.warning.quotaPace.red
    );
    severity = worseSeverity(severity, toneSeverity(pace));
  }
  return severity;
}
function renderSnapshot(snapshot, options = {}) {
  const colors = options.colors ?? !process.env.NO_COLOR;
  const columns = options.width || Number(process.env.COLUMNS) || 0;
  const separator = paint("dim", " | ", colors);
  const line1 = [];
  const model = displayText(snapshot.model).replace(/\s+\([^)]*\)$/, "");
  if (model) line1.push(signal(model, severityTone(snapshot.modelSeverity), colors));
  const effort = displayText(snapshot.effort).slice(0, 16);
  if (effort) {
    const effortTone = effort === "high" ? "yellow" : ["xhigh", "max"].includes(effort) ? "red" : null;
    line1.push(signal(shortEffort(effort), effortTone, colors));
  }
  if (isFiniteNumber(snapshot.totalInput) && isFiniteNumber(snapshot.contextSize) && snapshot.contextSize > 0) {
    const pressure = snapshot.totalInput * (snapshot.turns || 0);
    const pressureTone = toneFor(
      pressure,
      HUD_DESIGN.warning.contextPressure.yellow,
      HUD_DESIGN.warning.contextPressure.red
    );
    const fullnessTone = toneFor(
      snapshot.context,
      HUD_DESIGN.warning.contextFullness.yellow,
      HUD_DESIGN.warning.contextFullness.red
    );
    const token = signal(compactTokens(snapshot.totalInput), pressureTone, colors);
    const pct = isFiniteNumber(snapshot.context) ? signal(`/${Math.floor(snapshot.context)}%`, fullnessTone, colors) : "";
    const turns = snapshot.turns > 0 ? signal(` ${snapshot.turns}t`, pressureTone, colors) : "";
    line1.push(`${token}${pct}${turns}`);
  }
  if (snapshot.cache) {
    if (snapshot.cache.state === "cold") {
      line1.push(signal("*cold", "red", colors));
    } else {
      line1.push(signal(
        `*${formatReset(snapshot.cache.expiresAt)}`,
        snapshot.cache.state === "expiring" ? "yellow" : null,
        colors
      ));
    }
  }
  if (snapshot.limits.length) {
    const quota = snapshot.limits.map((limit) => `${Math.floor(limit.percent)}%`).join("/");
    line1.push(signal(`#${quota}`, severityTone(quotaSeverity(snapshot)), colors));
  }
  const resets = (snapshot.resets || []).map((reset) => formatReset(reset.resetAt, reset.label === "7d")).filter(Boolean);
  if (resets.length) {
    line1.push(`\u21BB${resets.join("/")}`);
  }
  const promotion = promotionToken(snapshot, colors);
  if (promotion) line1.push(promotion);
  const lines = [];
  if (line1.length) lines.push(line1.join(separator));
  const line2 = [];
  if (isFiniteNumber(snapshot.cost) && snapshot.cost > 0) {
    line2.push(signal(
      `$${snapshot.cost.toFixed(2)}`,
      toneFor(
        Math.floor(snapshot.cost),
        HUD_DESIGN.warning.costUsd.yellow,
        HUD_DESIGN.warning.costUsd.red
      ),
      colors
    ));
  }
  if (snapshot.compactAdvisor) {
    const advisor = snapshot.compactAdvisor;
    if (advisor.kind === "forced") {
      const label = advisor.full ? "\u2192full" : `\u2192~${advisor.turns}t`;
      const tone = advisor.full || advisor.turns <= HUD_DESIGN.warning.forcedCompactTurns.red ? "red" : advisor.turns <= HUD_DESIGN.warning.forcedCompactTurns.yellow ? "yellow" : null;
      line2.push(signal(label, tone, colors));
    } else {
      line2.push(`\u2193~${advisor.turns}t`);
    }
  }
  if ((!columns || columns >= HUD_DESIGN.layout.narrowColumns) && line2.length) {
    lines.push(line2.join(separator));
  }
  const line3 = [];
  if (snapshot.project) line3.push(paint("bright", snapshot.project, colors));
  if (snapshot.git) {
    const ref = snapshot.git.detached ? `@${snapshot.git.branch}` : snapshot.git.branch;
    const suffix = [
      snapshot.git.dirty ? "*" : "",
      snapshot.git.ahead ? `\u2191${snapshot.git.ahead}` : "",
      snapshot.git.behind ? `\u2193${snapshot.git.behind}` : ""
    ].join("");
    line3.push(paint("dim", ` ${ref}${suffix}`, colors));
  }
  const added = isFiniteNumber(snapshot.linesAdded) ? Math.floor(snapshot.linesAdded) : 0;
  const removed = isFiniteNumber(snapshot.linesRemoved) ? Math.floor(snapshot.linesRemoved) : 0;
  if (added > 0 || removed > 0) line3.push(paint("dim", `+${added}/-${removed}`, colors));
  if (snapshot.cwd) {
    const designMaximum = columns ? Math.max(
      HUD_DESIGN.layout.cwdMinimumColumns,
      columns - HUD_DESIGN.layout.cwdReservedColumns
    ) : HUD_DESIGN.layout.cwdFallbackColumns;
    const prefixWidth = line3.length ? terminalWidth(line3.join(separator)) + terminalWidth(separator) : 0;
    const available = columns ? Math.max(0, columns - prefixWidth) : designMaximum;
    const cwdMax = Math.min(designMaximum, available);
    if (cwdMax > 0) {
      line3.push(paint("dim", truncateLeft(displayPath(snapshot.cwd), cwdMax), colors));
    }
  }
  if (line3.length) lines.push(line3.join(separator));
  if (options.activity ?? true) {
    const status = statusLine(snapshot.status, colors);
    const tools = toolLine(snapshot.tools, colors);
    const agents = agentLine(snapshot.agents, colors);
    const plan = planLine(snapshot.plan, colors);
    const activity = [status, tools, agents, plan].filter(Boolean);
    if (activity.length) lines.push(dimLine(activity.join(" | "), colors));
  }
  return (columns ? lines.map((line) => truncateRight(line, columns)) : lines).join("\n");
}

// src/setup.ts
import fs7 from "node:fs/promises";
import os5 from "node:os";
import path11 from "node:path";
import { fileURLToPath } from "node:url";
var ROOT = path11.resolve(path11.dirname(fileURLToPath(import.meta.url)), "..");
var CLI_PATH = path11.join(ROOT, "dist", "cli.js");
var CODEX_PRESETS = {
  compact: {
    status_line: [
      "model-with-reasoning",
      "context-used",
      "git-branch",
      "branch-changes"
    ],
    terminal_title: ["spinner", "project", "git-branch"]
  },
  balanced: {
    status_line: [
      "model-with-reasoning",
      "used-tokens",
      "context-used",
      "weekly-limit",
      "git-branch",
      "branch-changes",
      "current-dir",
      "task-progress"
    ],
    terminal_title: ["spinner", "project", "git-branch", "model", "task-progress"]
  },
  full: {
    status_line: [
      "model-with-reasoning",
      "context-used",
      "context-remaining",
      "context-window-size",
      "weekly-limit",
      "permissions",
      "approval-mode",
      "git-branch",
      "branch-changes",
      "current-dir",
      "task-progress",
      "used-tokens",
      "session-id"
    ],
    terminal_title: ["spinner", "project", "git-branch", "model", "task-progress"]
  }
};
var TUI_KEYS = /* @__PURE__ */ new Set(["status_line", "status_line_use_colors", "terminal_title"]);
var TABLE_RE = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
function tomlValue(value) {
  return Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]` : String(value);
}
function parseJsonObject(text) {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("configuration root must be a JSON object");
  }
  return parsed;
}
function commandFor(subcommand, executable = process.execPath, cliPath = CLI_PATH, platform = process.platform) {
  const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  if (platform !== "win32") {
    return `${shellQuote(executable)} ${shellQuote(cliPath)} ${subcommand}`;
  }
  const powerShellQuote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = `& ${powerShellQuote(executable)} ${powerShellQuote(cliPath)} ${subcommand}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
function bracketDelta(value) {
  let delta = 0;
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      delta += 1;
    } else if (character === "]") {
      delta -= 1;
    } else if (character === "#") {
      break;
    }
  }
  return delta;
}
function withoutManagedTuiKeys(lines) {
  const kept = [];
  let continuationDepth = 0;
  for (const line of lines) {
    if (continuationDepth > 0) {
      continuationDepth += bracketDelta(line);
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=(.*)$/);
    if (assignment && TUI_KEYS.has(assignment[1])) {
      continuationDepth = Math.max(0, bracketDelta(assignment[2]));
      continue;
    }
    kept.push(line);
  }
  return kept;
}
function patchCodexConfig(text, presetName = "balanced") {
  const preset = CODEX_PRESETS[presetName];
  if (!preset) throw new Error(`Unknown Codex preset: ${presetName}`);
  const values = { ...preset, status_line_use_colors: true };
  const block = Object.entries(values).map(([key, value]) => `${key} = ${tomlValue(value)}`);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*\[\s*tui\s*\]\s*(?:#.*)?$/.test(line));
  if (index < 0) {
    const childIndex = lines.findIndex((line) => /^\s*\[\[?\s*tui\s*\./.test(line));
    const insertAt = childIndex >= 0 ? childIndex : lines.length;
    const before = lines.slice(0, insertAt);
    const after = lines.slice(insertAt);
    if (before.length && before.at(-1) !== "") before.push("");
    return [...before, "[tui]", ...block, "", ...after].join("\n");
  }
  let end = index + 1;
  let continuationDepth = 0;
  while (end < lines.length) {
    const line = lines[end];
    if (continuationDepth > 0) {
      continuationDepth += bracketDelta(line);
      end += 1;
      continue;
    }
    if (TABLE_RE.test(line)) break;
    const assignment = line.match(/^\s*[A-Za-z0-9_-]+\s*=(.*)$/);
    continuationDepth = assignment ? Math.max(0, bracketDelta(assignment[1])) : 0;
    end += 1;
  }
  const kept = withoutManagedTuiKeys(lines.slice(index + 1, end));
  while (kept.length && !kept[0].trim()) kept.shift();
  const section = [lines[index], ...block, ...kept.length ? ["", ...kept] : []];
  return [...lines.slice(0, index), ...section, ...lines.slice(end)].join("\n");
}
function patchClaudeSettings(text, executable = process.execPath, cliPath = CLI_PATH, platform = process.platform) {
  const parsed = parseJsonObject(text);
  parsed.statusLine = {
    type: "command",
    command: commandFor("statusline", executable, cliPath, platform),
    refreshInterval: 5
  };
  return `${JSON.stringify(parsed, null, 2)}
`;
}
function patchCursorConfig(text, executable = process.execPath, cliPath = CLI_PATH, platform = process.platform) {
  const parsed = parseJsonObject(text);
  parsed.statusLine = {
    type: "command",
    command: commandFor("statusline", executable, cliPath, platform),
    padding: 0,
    updateIntervalMs: 1e3,
    timeoutMs: 2e3
  };
  return `${JSON.stringify(parsed, null, 2)}
`;
}
var CURSOR_HOOK_EVENTS = [
  ["sessionStart", "SessionStart"],
  ["beforeSubmitPrompt", "UserPromptSubmit"],
  ["preToolUse", "PreToolUse"],
  ["postToolUse", "PostToolUse"],
  ["postToolUseFailure", "PostToolUseFailure"],
  ["subagentStart", "SubagentStart"],
  ["subagentStop", "SubagentStop"],
  ["stop", "Stop"],
  ["sessionEnd", "SessionEnd"]
];
function isManagedCursorHook(value) {
  return Boolean(
    value && typeof value === "object" && typeof value.command === "string" && /\bhook --platform cursor --event\b/.test(value.command)
  );
}
function patchCursorHooks(text, executable = process.execPath, cliPath = CLI_PATH, platform = process.platform) {
  const parsed = parseJsonObject(text);
  parsed.version = typeof parsed.version === "number" ? parsed.version : 1;
  const hooks = parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks) ? parsed.hooks : {};
  parsed.hooks = hooks;
  for (const [cursorEvent, providerEvent] of CURSOR_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[cursorEvent]) ? hooks[cursorEvent] : [];
    hooks[cursorEvent] = [
      ...existing.filter((entry) => !isManagedCursorHook(entry)),
      {
        command: commandFor(
          `hook --platform cursor --event ${providerEvent}`,
          executable,
          cliPath,
          platform
        ),
        timeout: 3
      }
    ];
  }
  return `${JSON.stringify(parsed, null, 2)}
`;
}
function patchAntigravitySettings(text, executable = process.execPath, cliPath = CLI_PATH, platform = process.platform) {
  const parsed = parseJsonObject(text);
  parsed.statusLine = {
    type: "command",
    command: commandFor("statusline", executable, cliPath, platform)
  };
  return `${JSON.stringify(parsed, null, 2)}
`;
}
function antigravityHook(event, executable, cliPath, platform) {
  return {
    type: "command",
    command: commandFor(
      `hook --platform antigravity --event ${event}`,
      executable,
      cliPath,
      platform
    ),
    timeout: 3
  };
}
function patchAntigravityHooks(text, executable = process.execPath, cliPath = CLI_PATH, platform = process.platform) {
  const parsed = parseJsonObject(text);
  parsed["agent-hud"] = {
    PreToolUse: [{
      matcher: "*",
      hooks: [antigravityHook("PreToolUse", executable, cliPath, platform)]
    }],
    PostToolUse: [{
      matcher: "*",
      hooks: [antigravityHook("PostToolUse", executable, cliPath, platform)]
    }],
    PreInvocation: [
      antigravityHook("PreInvocation", executable, cliPath, platform)
    ],
    Stop: [
      antigravityHook("Stop", executable, cliPath, platform)
    ]
  };
  return `${JSON.stringify(parsed, null, 2)}
`;
}
async function writeWithBackup(filePath, content, dryRun = false) {
  let original = "";
  try {
    original = await fs7.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (content === original) return { changed: false, backup: null, content };
  if (dryRun) return { changed: true, backup: null, content };
  await fs7.mkdir(path11.dirname(filePath), { recursive: true });
  let backup = null;
  if (original) {
    backup = `${filePath}.bak-agent-hud-${(/* @__PURE__ */ new Date()).toISOString().replace(/\D/g, "")}`;
    await fs7.copyFile(filePath, backup);
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs7.writeFile(temporary, content, { encoding: "utf8", mode: 384 });
  await fs7.rename(temporary, filePath);
  return { changed: true, backup, content };
}
async function setupCodex(options = {}) {
  const filePath = options.config || path11.join(process.env.CODEX_HOME || path11.join(os5.homedir(), ".codex"), "config.toml");
  let original = "";
  try {
    original = await fs7.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const content = patchCodexConfig(original, options.preset || "balanced");
  return { filePath, ...await writeWithBackup(filePath, content, options.dryRun) };
}
async function setupClaude(options = {}) {
  const root = process.env.CLAUDE_CONFIG_DIR || path11.join(os5.homedir(), ".claude");
  const filePath = options.config || path11.join(root, "settings.json");
  let original = "";
  try {
    original = await fs7.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const content = patchClaudeSettings(original, options.executable, options.cliPath);
  return { filePath, ...await writeWithBackup(filePath, content, options.dryRun) };
}
function piExtensionModule(cliPath = CLI_PATH) {
  const target = path11.join(path11.dirname(cliPath), "pi-extension.js");
  return `// Written by \`agent-hud setup pi\`. Edit the plugin, not this file.
export { default } from ${JSON.stringify(target)};
`;
}
async function setupPi(options = {}) {
  const root = process.env.PI_CODING_AGENT_DIR || path11.join(os5.homedir(), ".pi", "agent");
  const filePath = options.config || path11.join(root, "extensions", "agent-hud.ts");
  const content = piExtensionModule(options.cliPath);
  return {
    filePath,
    ...await writeWithBackup(filePath, content, options.dryRun)
  };
}
async function readOptional(filePath) {
  try {
    return await fs7.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
async function setupCursor(options = {}) {
  const root = process.env.CURSOR_CONFIG_DIR || path11.join(os5.homedir(), ".cursor");
  const filePath = options.config || path11.join(root, "cli-config.json");
  const hooksFilePath = options.hooksConfig || path11.join(root, "hooks.json");
  const content = patchCursorConfig(
    await readOptional(filePath),
    options.executable,
    options.cliPath
  );
  const hooksContent = patchCursorHooks(
    await readOptional(hooksFilePath),
    options.executable,
    options.cliPath
  );
  return {
    filePath,
    ...await writeWithBackup(filePath, content, options.dryRun),
    hooks: {
      filePath: hooksFilePath,
      ...await writeWithBackup(hooksFilePath, hooksContent, options.dryRun)
    }
  };
}
async function setupAntigravity(options = {}) {
  const settingsRoot = process.env.ANTIGRAVITY_CONFIG_DIR || path11.join(os5.homedir(), ".gemini", "antigravity-cli");
  const hooksRoot = process.env.GEMINI_CUSTOMIZATION_DIR || path11.join(os5.homedir(), ".gemini", "config");
  const filePath = options.config || path11.join(settingsRoot, "settings.json");
  const hooksFilePath = options.hooksConfig || path11.join(hooksRoot, "hooks.json");
  const content = patchAntigravitySettings(
    await readOptional(filePath),
    options.executable,
    options.cliPath
  );
  const hooksContent = patchAntigravityHooks(
    await readOptional(hooksFilePath),
    options.executable,
    options.cliPath
  );
  return {
    filePath,
    ...await writeWithBackup(filePath, content, options.dryRun),
    hooks: {
      filePath: hooksFilePath,
      ...await writeWithBackup(hooksFilePath, hooksContent, options.dryRun)
    }
  };
}

// src/cli.ts
var CLI_PATH2 = fileURLToPath2(import.meta.url);
var WATCH_GIT_REFRESH_MS = 5e3;
function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}
function hookPlatform(args) {
  const value = valueAfter(args, "--platform");
  return ["codex", "claude", "antigravity", "cursor", "pi", "agent"].includes(
    String(value)
  ) ? value : void 0;
}
async function hook(args) {
  const input = await readJsonStdin();
  const platform = hookPlatform(args);
  const event = valueAfter(args, "--event") || void 0;
  if (input) {
    try {
      await recordHook(input, { platform, event });
    } catch {
    }
  }
  const response = platform === "antigravity" && (event === "PreToolUse" || event === "Stop") ? { decision: "" } : {};
  process2.stdout.write(`${JSON.stringify(response)}
`);
}
async function statusline() {
  const input = await readJsonStdin();
  if (!input) return;
  await spawnPromotionsRefresh(CLI_PATH2);
  const isAntigravity = input.product === "antigravity" || typeof input.agent_state === "string";
  const isCursor = !isAntigravity && (typeof input.autorun === "boolean" || Number.isFinite(input.render_width_chars));
  const state = await loadState({
    sessionId: input.session_id || input.conversation_id,
    transcriptPath: input.transcript_path,
    cwd: input.workspace?.current_dir || input.cwd,
    platform: isAntigravity ? "antigravity" : isCursor ? "cursor" : "claude"
  });
  const cwd = input.workspace?.current_dir || input.cwd || state.cwd;
  if (isAntigravity) {
    const host = input;
    const snapshot2 = snapshotFromAntigravity(
      normalizeAntigravityStatus(host, state),
      host.vcs ? null : getGitStatus(cwd),
      currentPromotion({ platform: "antigravity" })
    );
    process2.stdout.write(`${renderSnapshot(snapshot2, {
      activity: false,
      width: finiteWidth(host.terminal_width)
    })}
`);
    return;
  }
  if (isCursor) {
    const host = input;
    const snapshot2 = snapshotFromCursor(
      normalizeCursorStatus(host, state),
      getGitStatus(cwd),
      currentPromotion({ platform: "cursor" })
    );
    process2.stdout.write(`${renderSnapshot(snapshot2, {
      activity: false,
      width: finiteWidth(host.render_width_chars)
    })}
`);
    return;
  }
  const endpoint = claudeApiEndpoint();
  const healthSource = healthSourceFor(endpoint);
  const derived = await deriveClaudeTelemetry(input, {
    compactTargetPercent: HUD_DESIGN.warning.contextFullness.red,
    compactSummaryTokens: HUD_DESIGN.compact.summaryTokens,
    recentContextRows: HUD_DESIGN.compact.recentChangedRows,
    healthSource
  });
  const facts = normalizeClaudeStatus(input, state, derived);
  if (healthSource && facts.healthCacheStale) {
    await spawnHealthRefresh(CLI_PATH2, healthSource);
  }
  const snapshot = snapshotFromClaude(
    facts,
    getGitStatus(cwd),
    currentPromotion({ platform: "claude", endpoint })
  );
  process2.stdout.write(`${renderSnapshot(snapshot, { activity: false })}
`);
}
function finiteWidth(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function demo() {
  const snapshot = {
    platform: "codex",
    observedAt: Math.floor(Date.now() / 1e3),
    model: "gpt-5.6-sol",
    effort: "high",
    totalInput: 90420,
    contextSize: 2e5,
    turns: 26,
    project: "agent-hud",
    context: 45,
    limits: [
      { label: "7d", percent: 11 }
    ],
    resets: [],
    git: { branch: "main", detached: false, dirty: true, ahead: 0, behind: 0 },
    cwd: "/workspace/agent-hud",
    cost: 5.32,
    linesAdded: 128,
    linesRemoved: 17,
    tools: [
      { name: "apply_patch", target: "render.ts", status: "running" },
      { name: "Read", status: "completed" }
    ],
    agents: [
      { type: "reviewer", status: "running" }
    ],
    plan: [
      { text: "\u786E\u5B9A\u7EDF\u4E00\u4E8B\u4EF6\u6A21\u578B", status: "completed" },
      { text: "\u5B9E\u73B0 Claude/Codex HUD", status: "in_progress" },
      { text: "\u5B8C\u6210\u9A8C\u8BC1", status: "pending" }
    ]
  };
  process2.stdout.write(`${renderSnapshot(snapshot)}
`);
}
var GitRefreshCache = class {
  constructor(read = getGitStatus, now = Date.now, ttlMs = WATCH_GIT_REFRESH_MS) {
    this.read = read;
    this.now = now;
    this.ttlMs = ttlMs;
  }
  cwd = "";
  value = null;
  refreshedAt = Number.NEGATIVE_INFINITY;
  get(cwd) {
    const now = this.now();
    if (cwd !== this.cwd || now - this.refreshedAt >= this.ttlMs) {
      this.cwd = cwd;
      this.value = this.read(cwd);
      this.refreshedAt = now;
    }
    return this.value;
  }
};
async function currentSnapshot(args, git = getGitStatus) {
  const cwd = valueAfter(args, "--cwd") || process2.cwd();
  const state = await loadState({ cwd });
  return snapshotFromState(
    state,
    git(state.cwd || cwd),
    currentPromotion({ platform: state.platform })
  );
}
async function renderCurrent(args, git = getGitStatus) {
  const snapshot = await currentSnapshot(args, git);
  if (args.includes("--json")) return JSON.stringify(snapshot);
  return renderSnapshot(snapshot, {
    colors: !args.includes("--no-color") && !process2.env.NO_COLOR,
    width: resolveRenderWidth(args)
  });
}
function resolveRenderWidth(args, terminalColumns = process2.stdout.columns) {
  const explicit = Number(valueAfter(args, "--width"));
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  if (typeof terminalColumns === "number" && Number.isFinite(terminalColumns) && terminalColumns > 0) return Math.floor(terminalColumns);
  const environment = Number(process2.env.COLUMNS);
  return Number.isFinite(environment) && environment > 0 ? Math.floor(environment) : void 0;
}
async function withHiddenCursor(write, operation) {
  write("\x1B[?25l");
  try {
    return await operation();
  } finally {
    write("\x1B[?25h\n");
  }
}
async function watch(args) {
  if (args.includes("--once") || !process2.stdout.isTTY) {
    process2.stdout.write(`${await renderCurrent(args)}
`);
    return;
  }
  const git = new GitRefreshCache();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process2.on("SIGINT", stop);
  process2.on("SIGTERM", stop);
  try {
    await withHiddenCursor(
      (value) => {
        process2.stdout.write(value);
      },
      async () => {
        while (!stopped) {
          const frame = await renderCurrent(args, (cwd) => git.get(cwd));
          process2.stdout.write(`\x1B[2J\x1B[H${frame}`);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
    );
  } finally {
    process2.off("SIGINT", stop);
    process2.off("SIGTERM", stop);
  }
}
async function setup(args) {
  const target = args[0] || "all";
  const options = {
    dryRun: args.includes("--dry-run"),
    preset: valueAfter(args, "--preset") || "balanced",
    config: valueAfter(args, "--config") || void 0,
    hooksConfig: valueAfter(args, "--hooks-config") || void 0
  };
  const results = [];
  if (target === "claude" || target === "both" || target === "all") {
    results.push(["Claude", await setupClaude(options)]);
  }
  if (target === "codex" || target === "both" || target === "all") {
    results.push(["Codex", await setupCodex(options)]);
  }
  if (target === "cursor" || target === "all") {
    results.push(["Cursor", await setupCursor(options)]);
  }
  if (target === "antigravity" || target === "all") {
    results.push(["Antigravity", await setupAntigravity(options)]);
  }
  if (target === "pi" || target === "all") {
    results.push(["pi", await setupPi(options)]);
  }
  if (!results.length) {
    throw new Error(
      "setup target must be claude, codex, cursor, antigravity, pi, both, or all"
    );
  }
  for (const [label, result] of results) {
    if (options.dryRun) {
      process2.stdout.write(`--- ${label}: ${result.filePath}
${result.content}`);
    } else {
      process2.stdout.write(`${label} ${result.changed ? "configured" : "already configured"}: ${result.filePath}
`);
      if (result.backup) process2.stdout.write(`backup: ${result.backup}
`);
    }
    if (result.hooks) {
      if (options.dryRun) {
        process2.stdout.write(
          `--- ${label} hooks: ${result.hooks.filePath}
${result.hooks.content}`
        );
      } else {
        process2.stdout.write(
          `${label} hooks ${result.hooks.changed ? "configured" : "already configured"}: ${result.hooks.filePath}
`
        );
        if (result.hooks.backup) {
          process2.stdout.write(`backup: ${result.hooks.backup}
`);
        }
      }
    }
  }
}
async function refreshHealthCommand(args) {
  const source = healthSourceById(valueAfter(args, "--source") || "");
  if (!source) return;
  const lockPath = valueAfter(args, "--refresh-lock");
  const lockToken = valueAfter(args, "--refresh-token");
  await refreshHealth(
    source,
    valueAfter(args, "--home") || void 0,
    lockPath && lockToken ? { path: lockPath, token: lockToken } : void 0
  );
}
function help() {
  process2.stdout.write(`Agent HUD \u2014 one HUD for Codex, Claude Code, Cursor and Antigravity

Usage:
  agent-hud hook                     capture a normalized host hook from stdin
  agent-hud statusline               render any supported host status payload
  agent-hud watch [--cwd PATH]       live shared activity companion
  agent-hud watch --once             print the latest activity snapshot
  agent-hud watch --once --json      print the normalized snapshot as JSON
  agent-hud setup claude             configure Claude Code statusLine
  agent-hud setup codex [--preset compact|balanced|full]
  agent-hud setup cursor             configure Cursor statusLine and hooks
  agent-hud setup antigravity        configure Antigravity statusLine and hooks
  agent-hud setup pi                 install the pi footer extension
  agent-hud setup both
  agent-hud setup all
  agent-hud demo
  agent-hud promotions [--platform claude|codex|cursor|antigravity|pi]
                       [--endpoint URL]
                                     inspect configured promotional windows

Environment:
  AGENT_HUD_DATA_DIR      override local event storage
  AGENT_HUD_CONFIG        override the promotions config file path
  AGENT_HUD_PROMOTIONS_URL  override the shared promotions schedule URL
  AGENT_HUD_NO_REMOTE     never fetch the shared schedule
  NO_COLOR                disable ANSI colors
`);
}
async function main(argv = process2.argv.slice(2)) {
  const [command = "help", ...args] = argv;
  if (command === "hook") return hook(args);
  if (command === "statusline") return statusline();
  if (command === "watch") return watch(args);
  if (command === "setup") return setup(args);
  if (command === "demo") return demo();
  if (command === "promotions") {
    return promotions(hookPlatform(args), valueAfter(args, "--endpoint") ?? void 0);
  }
  if (command === "refresh-health") return refreshHealthCommand(args);
  if (command === "refresh-promotions") {
    await refreshSharedPromotions();
    return;
  }
  help();
}
function isMainModule() {
  const executable = process2.argv[1];
  if (!executable) return false;
  try {
    return fs8.realpathSync(fileURLToPath2(import.meta.url)) === fs8.realpathSync(executable);
  } catch {
    return path12.resolve(fileURLToPath2(import.meta.url)) === path12.resolve(executable);
  }
}
if (isMainModule()) {
  main().catch((error) => {
    process2.stderr.write(`agent-hud: ${error.message}
`);
    process2.exitCode = 1;
  });
}
export {
  GitRefreshCache,
  main,
  resolveRenderWidth,
  withHiddenCursor
};
//# sourceMappingURL=cli.js.map
