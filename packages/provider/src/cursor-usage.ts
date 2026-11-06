import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  resolveBaseDir,
} from "./io.js";
import { PROVIDER_DEFAULTS } from "./telemetry/config.js";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const FETCH_TIMEOUT_MS = 4_000;
const MAX_USAGE_BYTES = 64 * 1024;
const REFRESH_LOCK_STALE_MS = 30_000;

/**
 * Auto and API are separate included pools on the signed-in Cursor account.
 * Percents are the account's own 0–100 figures. Null means that pool was
 * absent; it is not the same as zero used.
 */
export interface CursorPlanUsage {
  autoPercent: number | null;
  apiPercent: number | null;
}

export interface CursorUsageRefreshOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  lease?: { path: string; token: string };
}

interface RefreshLease {
  path: string;
  token: string;
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

function accountKey(token: string): string {
  const payload = token.split(".")[1];
  let identity = token;
  if (payload) {
    try {
      const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        sub?: unknown;
      };
      if (typeof json.sub === "string" && json.sub) identity = json.sub;
    } catch {
      // Opaque tokens are keyed as themselves.
    }
  }
  return createHash("sha256").update(identity).digest("hex");
}

export function cursorPlanUsageFromBody(body: unknown): CursorPlanUsage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const plan = record.planUsage;
  if (!plan || typeof plan !== "object") return null;
  const planRecord = plan as Record<string, unknown>;
  const autoPercent = percent(planRecord.autoPercentUsed);
  const apiPercent = percent(planRecord.apiPercentUsed);
  if (autoPercent == null && apiPercent == null) return null;
  return { autoPercent, apiPercent };
}

function cursorUsageDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(resolveBaseDir(env, home), "cursor");
}


async function currentAccount(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string | null> {
  const token = await readAccessToken(env, home);
  return token ? accountKey(token) : null;
}

export async function readCursorPlanUsage(
  now = Math.floor(Date.now() / 1_000),
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ usage: CursorPlanUsage | null; stale: boolean }> {
  const account = await currentAccount(env, home);
  const directory = cursorUsageDirectory(env, home);
  const filePath = path.join(directory, "plan-usage.json");
  const attemptPath = path.join(directory, "plan-usage-attempt");
  let usage: CursorPlanUsage | null = null;
  let cacheAccount: string | null = null;
  let mtime = 0;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    cacheAccount = typeof parsed.account === "string" ? parsed.account : null;
    if (parsed.v === 1 && account && cacheAccount === account) {
      usage = cursorPlanUsageFromBody({
        planUsage: {
          autoPercentUsed: parsed.autoPercent,
          apiPercentUsed: parsed.apiPercent,
        },
      });
    }
    mtime = Math.floor((await fs.stat(filePath)).mtimeMs / 1_000);
  } catch {
    // No readable cache yet.
  }
  try {
    mtime = Math.max(mtime, Math.floor((await fs.stat(attemptPath)).mtimeMs / 1_000));
  } catch {
    // No prior attempt.
  }
  if (account && cacheAccount !== account) return { usage: null, stale: true };
  return {
    usage,
    stale: mtime === 0 || now - mtime >= PROVIDER_DEFAULTS.cursorUsageTtlSeconds,
  };
}

async function readAccessToken(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string | null> {
  const root = env.CURSOR_CONFIG_DIR || path.join(home, ".cursor");
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, "auth.json"), "utf8")) as {
      accessToken?: unknown;
    };
    return typeof parsed.accessToken === "string" && parsed.accessToken
      ? parsed.accessToken
      : null;
  } catch {
    return null;
  }
}

async function releaseLease(lease: RefreshLease): Promise<void> {
  try {
    const before = await fs.stat(lease.path);
    if ((await fs.readFile(lease.path, "utf8")).trim() !== lease.token) return;
    const after = await fs.stat(lease.path);
    if (before.dev !== after.dev || before.ino !== after.ino) return;
    await fs.unlink(lease.path);
  } catch {
    // A crashed child is recovered when the lock goes stale.
  }
}

async function acquireLease(
  env: NodeJS.ProcessEnv,
  home: string,
  now = Date.now(),
): Promise<RefreshLease | null> {
  const directory = cursorUsageDirectory(env, home);
  const lockPath = path.join(directory, "plan-usage-refresh.lock");
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
        if (now - before.mtimeMs < REFRESH_LOCK_STALE_MS) return null;
        const after = await fs.stat(lockPath);
        if (before.dev !== after.dev || before.ino !== after.ino) return null;
        await fs.unlink(lockPath);
      } catch {
        // Another renderer recovered the stale lease.
      }
    }
  }
  return null;
}

/**
 * Read the signed-in account's current period and cache only the pool
 * percents. The access token stays in the auth file and is never written here.
 * A failed read leaves the previous cache in place.
 */
export async function refreshCursorPlanUsage(
  options: CursorUsageRefreshOptions = {},
): Promise<void> {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const directory = cursorUsageDirectory(env, home);
  const fetchImpl = options.fetchImpl || fetch;
  try {
    await ensurePrivateDirectory(directory);
    await atomicWritePrivate(path.join(directory, "plan-usage-attempt"), "\n");
    const token = await readAccessToken(env, home);
    if (!token) return;
    const response = await fetchImpl(USAGE_URL, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
      body: "{}",
    });
    if (!response.ok) return;
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_USAGE_BYTES) return;
    const usage = cursorPlanUsageFromBody(JSON.parse(raw) as unknown);
    if (!usage) return;
    await atomicWritePrivate(path.join(directory, "plan-usage.json"), `${JSON.stringify({
      v: 1,
      account: accountKey(token),
      autoPercent: usage.autoPercent,
      apiPercent: usage.apiPercent,
    })}\n`);
  } catch {
    // Account and transport failures stay off the status line.
  } finally {
    if (options.lease) await releaseLease(options.lease);
  }
}

export async function spawnCursorUsageRefresh(
  cliPath: string,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  let lease: RefreshLease | null;
  try {
    lease = await acquireLease(env, home);
  } catch {
    return false;
  }
  if (!lease) return false;
  try {
    const child = spawn(process.execPath, [
      cliPath,
      "refresh-cursor-usage",
      "--home",
      home,
      "--refresh-lock",
      lease.path,
      "--refresh-token",
      lease.token,
    ], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.once("error", () => {
      void releaseLease(lease);
    });
    child.unref();
    return true;
  } catch {
    await releaseLease(lease);
    return false;
  }
}
