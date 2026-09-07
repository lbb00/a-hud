import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  ensurePrivateFile,
  repairPrivateDirectory,
  resolveBaseDir,
} from "../io.js";
import { PROVIDER_DEFAULTS } from "./config.js";
import type { HealthSource } from "./health-sources.js";

const HEALTH_REFRESH_LOCK_STALE_MS = 30_000;
const FETCH_TIMEOUT_MS = 4_000;
/** A status page answers with a few kilobytes; larger bodies are not parsed. */
const MAX_STATUS_BYTES = 64 * 1_024;

interface HealthRefreshLease {
  path: string;
  token: string;
}

/**
 * One directory under Agent HUD's own root, beside the promotional cache,
 * rather than inside a single host's home. The state is shared by every host
 * that reaches the same API, so it does not belong to any one of them.
 */
function healthDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(resolveBaseDir(env, home), "health");
}

export async function healthState(
  source: HealthSource,
  now: number,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  indicator: string;
  stale: boolean;
}> {
  const directory = healthDirectory(env, home);
  const filePath = path.join(directory, source.id);
  const attemptPath = path.join(directory, `${source.id}-attempt`);
  await repairPrivateDirectory(directory);
  let indicator = "";
  let mtime = 0;
  try {
    await ensurePrivateFile(filePath);
    indicator = (await fs.readFile(filePath, "utf8")).trim();
    mtime = Math.floor((await fs.stat(filePath)).mtimeMs / 1_000);
  } catch {
    // No cache yet: return no incident and request a background refresh.
  }
  try {
    await ensurePrivateFile(attemptPath);
    mtime = Math.max(
      mtime,
      Math.floor((await fs.stat(attemptPath)).mtimeMs / 1_000),
    );
  } catch {
    // No prior attempt.
  }
  return {
    indicator,
    stale: now - mtime >= PROVIDER_DEFAULTS.apiHealthTtlSeconds,
  };
}

async function acquireHealthRefreshLease(
  source: HealthSource,
  home: string,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): Promise<HealthRefreshLease | null> {
  const directory = healthDirectory(env, home);
  const lockPath = path.join(directory, `${source.id}-refresh.lock`);
  await ensurePrivateDirectory(directory);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${token}\n`);
      } finally {
        await handle.close();
      }
      return { path: lockPath, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        const before = await fs.stat(lockPath);
        if (now - before.mtimeMs < HEALTH_REFRESH_LOCK_STALE_MS) return null;
        const after = await fs.stat(lockPath);
        if (before.dev !== after.dev || before.ino !== after.ino) return null;
        await fs.unlink(lockPath);
      } catch {
        // Another renderer either recovered or replaced the stale lease.
      }
    }
  }
  return null;
}

async function releaseHealthRefreshLease(lease: HealthRefreshLease): Promise<void> {
  try {
    const before = await fs.stat(lease.path);
    if ((await fs.readFile(lease.path, "utf8")).trim() !== lease.token) return;
    const after = await fs.stat(lease.path);
    if (before.dev !== after.dev || before.ino !== after.ino) return;
    await fs.unlink(lease.path);
  } catch {
    // Lease cleanup is advisory; stale recovery handles a crashed child.
  }
}

/**
 * Start at most one detached status refresh across concurrent hosts. The lease
 * is per source, so two vendors can refresh at once while two hosts asking for
 * the same vendor produce a single request. The child releases it in finally.
 */
export async function spawnHealthRefresh(
  cliPath: string,
  source: HealthSource,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  let lease: HealthRefreshLease | null;
  try {
    lease = await acquireHealthRefreshLease(source, home, env);
  } catch {
    return false;
  }
  if (!lease) return false;
  try {
    const child = spawn(process.execPath, [
      cliPath,
      "refresh-health",
      "--source",
      source.id,
      "--home",
      home,
      "--refresh-lock",
      lease.path,
      "--refresh-token",
      lease.token,
    ], {
      detached: true,
      stdio: "ignore",
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

export async function refreshHealth(
  source: HealthSource,
  home = os.homedir(),
  lease?: HealthRefreshLease,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const directory = healthDirectory(env, home);
  const filePath = path.join(directory, source.id);
  const attemptPath = path.join(directory, `${source.id}-attempt`);
  try {
    await ensurePrivateDirectory(directory);
    await atomicWritePrivate(attemptPath, "\n");
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_STATUS_BYTES) {
      throw new Error(`${source.id}: response too large`);
    }
    const indicator = source.read(JSON.parse(raw) as unknown);
    if (!indicator) throw new Error(`${source.id}: missing indicator`);
    await atomicWritePrivate(filePath, `${indicator}\n`);
  } finally {
    if (lease) await releaseHealthRefreshLease(lease);
  }
}
