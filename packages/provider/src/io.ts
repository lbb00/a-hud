import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_STDIN_BYTES = 256 * 1024;
const HYGIENE_STAMP_NAME = ".agent-hud-hygiene.stamp";
const HYGIENE_LOCK_NAME = ".agent-hud-hygiene.lock";
const HYGIENE_TEMP_PREFIX = ".agent-hud-tmp-";
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
const DEFAULT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PrivateFileHygienePolicy {
  /** Only files matching this pattern are ever considered for deletion. */
  fileNamePattern: RegExp;
  maxAgeMs: number;
  maxEntries: number;
  /**
   * Count pressure never removes a recently touched file. This is the
   * concurrency guard for another live HUD/session writing the same directory.
   */
  preserveYoungerThanMs: number;
  sweepIntervalMs?: number;
  staleLockMs?: number;
  temporaryMaxAgeMs?: number;
}

export interface PrivateFileHygieneOptions {
  nowMs?: number;
  protectedPaths?: Iterable<string>;
  /** Deterministic maintenance/tests may bypass the interval stamp. */
  force?: boolean;
}

export async function repairPrivateDirectory(directory: string): Promise<void> {
  try {
    await fs.chmod(directory, 0o700);
  } catch {
    // Missing directories and filesystems without POSIX modes are harmless.
  }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies on first creation. Repair directories created by
  // older Agent HUD versions or a permissive umask as they are touched.
  await repairPrivateDirectory(directory);
}

export async function ensurePrivateFile(filePath: string): Promise<void> {
  try {
    // writeFile/appendFile mode also applies only on first creation.
    await fs.chmod(filePath, 0o600);
  } catch {
    // A missing file or unsupported chmod is not a HUD failure.
  }
}

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 20;

// Windows can transiently deny a rename onto a destination another concurrent
// writer's own rename is momentarily holding open (EPERM/EBUSY), even though
// POSIX rename() is atomic and never does this. Retry a few times before
// surfacing the error.
async function renameWithRetry(temporary: string, filePath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(temporary, filePath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= RENAME_RETRY_ATTEMPTS || (code !== "EPERM" && code !== "EBUSY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    }
  }
}

export async function atomicWritePrivate(
  filePath: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `${HYGIENE_TEMP_PREFIX}${path.basename(filePath)}-${process.pid}-${randomUUID()}`,
  );
  await ensurePrivateDirectory(directory);
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await ensurePrivateFile(temporary);
    await renameWithRetry(temporary, filePath);
    await ensurePrivateFile(filePath);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
      // The original write error is authoritative.
    }
    throw error;
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

async function acquireHygieneLock(
  lockPath: string,
  nowMs: number,
  staleLockMs: number,
): Promise<Awaited<ReturnType<typeof fs.open>> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await ensurePrivateFile(lockPath);
      return handle;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return null;
      try {
        const before = await fs.stat(lockPath);
        if (nowMs - before.mtimeMs <= staleLockMs) return null;
        // Compare identity immediately before unlinking. This avoids deleting a
        // new process's lock after another contender replaced a stale one.
        const current = await fs.stat(lockPath);
        if (before.dev !== current.dev || before.ino !== current.ino) return null;
        await fs.unlink(lockPath);
      } catch (staleError) {
        if (errorCode(staleError) !== "ENOENT") return null;
      }
    }
  }
  return null;
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

async function sweepPrivateFiles(
  directory: string,
  policy: PrivateFileHygienePolicy,
  nowMs: number,
  protectedPaths: Set<string>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const survivors: Array<{ filePath: string; mtimeMs: number }> = [];
  const temporaryMaxAgeMs = policy.temporaryMaxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (
        entry.name.startsWith(HYGIENE_TEMP_PREFIX) &&
        nowMs - stat.mtimeMs > temporaryMaxAgeMs
      ) {
        await fs.unlink(filePath);
        continue;
      }
      if (!matches(policy.fileNamePattern, entry.name)) continue;
      await ensurePrivateFile(filePath);
      if (
        !protectedPaths.has(filePath) &&
        nowMs - stat.mtimeMs > policy.maxAgeMs
      ) {
        await fs.unlink(filePath);
        continue;
      }
      survivors.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // A concurrent writer/sweeper may replace or remove an entry.
    }
  }

  let excess = Math.max(0, survivors.length - policy.maxEntries);
  if (!excess) return;
  survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const survivor of survivors) {
    if (!excess) break;
    if (
      protectedPaths.has(survivor.filePath) ||
      nowMs - survivor.mtimeMs <= policy.preserveYoungerThanMs
    ) continue;
    try {
      await fs.unlink(survivor.filePath);
      excess -= 1;
    } catch {
      // Advisory cleanup never takes the HUD down.
    }
  }
}

/**
 * Opportunistically repair permissions and bound a private cache directory.
 *
 * A timestamp file makes the common path one stat instead of one readdir. An
 * O_EXCL lock coalesces concurrent Claude/Codex processes; an inode check makes
 * stale-lock recovery safe against replacing another process's new lock.
 */
export async function maybeSweepPrivateFiles(
  directory: string,
  policy: PrivateFileHygienePolicy,
  options: PrivateFileHygieneOptions = {},
): Promise<void> {
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
      if (!options.force && nowMs - stamp.mtimeMs < sweepIntervalMs) return;
    } catch {
      // A missing/malformed stamp requests maintenance.
    }

    const lock = await acquireHygieneLock(
      lockPath,
      nowMs,
      policy.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    );
    if (!lock) return;
    const ownedLock = await lock.stat().catch(() => null);
    try {
      const protectedPaths = new Set(
        [...(options.protectedPaths ?? [])].map((item) => path.resolve(item)),
      );
      await sweepPrivateFiles(managedDirectory, policy, nowMs, protectedPaths);
      await atomicWritePrivate(stampPath, `${nowMs}\n`);
      const seconds = nowMs / 1_000;
      await fs.utimes(stampPath, seconds, seconds);
    } finally {
      await lock.close().catch(() => undefined);
      try {
        const currentLock = await fs.stat(lockPath);
        if (
          ownedLock &&
          ownedLock.dev === currentLock.dev &&
          ownedLock.ino === currentLock.ino
        ) {
          await fs.unlink(lockPath);
        }
      } catch {
        // A stale-lock contender may already have removed it.
      }
    }
  } catch {
    // Hygiene is advisory. Read-only homes and transient races keep rendering.
  }
}

export async function readJsonStdin(stream: NodeJS.ReadStream = process.stdin): Promise<unknown | null> {
  if (stream.isTTY) return null;
  stream.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stream) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, "utf8") > MAX_STDIN_BYTES) return null;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const base = env.AGENT_HUD_DATA_DIR || path.join(home, ".agent-hud");
  return path.join(base, "events");
}

export function eventFileFor(dataDir: string, sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return path.join(dataDir, `${digest}.jsonl`);
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await ensurePrivateFile(filePath);
}

export async function readTail(filePath: string, maxBytes = 384 * 1024): Promise<string> {
  await ensurePrivateFile(filePath);
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (stat.size > length) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}

export function safeText(value: unknown, max = 80): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Paths are data, not prose: preserve their length and significant whitespace.
 * Only terminal/control bytes are unsafe to carry into the event store.
 */
export function safePath(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "")
    : "";
}
