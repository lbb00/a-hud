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
} from "../io.js";
import { PROVIDER_DEFAULTS } from "./config.js";

const HEALTH_REFRESH_LOCK_STALE_MS = 30_000;

interface HealthRefreshLease {
  path: string;
  token: string;
}

export async function healthState(home: string, now: number): Promise<{
  indicator: string;
  stale: boolean;
}> {
  const filePath = path.join(home, ".claude", "status-cache", "anthropic");
  const attemptPath = path.join(home, ".claude", "status-cache", "anthropic-attempt");
  await repairPrivateDirectory(path.dirname(filePath));
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
  home: string,
  now = Date.now(),
): Promise<HealthRefreshLease | null> {
  const directory = path.join(home, ".claude", "status-cache");
  const lockPath = path.join(directory, "anthropic-refresh.lock");
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
 * Start at most one detached status refresh across concurrent statusline
 * renderers. The child owns a short lease and releases it in finally.
 */
export async function spawnHealthRefresh(
  cliPath: string,
  home = os.homedir(),
): Promise<boolean> {
  let lease: HealthRefreshLease | null;
  try {
    lease = await acquireHealthRefreshLease(home);
  } catch {
    return false;
  }
  if (!lease) return false;
  try {
    const child = spawn(process.execPath, [
      cliPath,
      "refresh-health",
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

export async function refreshAnthropicHealth(
  home = os.homedir(),
  lease?: HealthRefreshLease,
): Promise<void> {
  const directory = path.join(home, ".claude", "status-cache");
  const filePath = path.join(directory, "anthropic");
  const attemptPath = path.join(directory, "anthropic-attempt");
  try {
    await ensurePrivateDirectory(directory);
    await atomicWritePrivate(attemptPath, "\n");
    const response = await fetch("https://status.claude.com/api/v2/status.json", {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`Anthropic status: HTTP ${response.status}`);
    const body = await response.json() as { status?: { indicator?: string } };
    const indicator = body.status?.indicator;
    if (!indicator) throw new Error("Anthropic status: missing indicator");
    await atomicWritePrivate(filePath, `${indicator}\n`);
  } finally {
    if (lease) await releaseHealthRefreshLease(lease);
  }
}
