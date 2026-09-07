import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  ensurePrivateFile,
  repairPrivateDirectory,
  safeText,
} from "./io.js";
import type { ClaudeStatusInput } from "./types.js";
import { PROVIDER_DEFAULTS } from "./telemetry/config.js";
import {
  healthState,
  refreshHealth,
  spawnHealthRefresh,
} from "./telemetry/health.js";
import type { HealthSource } from "./telemetry/health-sources.js";
import {
  inferCacheTtl,
  readTranscriptFacts,
  transcriptTurns,
} from "./telemetry/transcript.js";

export { PROVIDER_DEFAULTS };
export { healthState, refreshHealth, spawnHealthRefresh };
export { inferCacheTtl, transcriptTurns };

export interface CacheTelemetry {
  expiresAt: number;
  ttlSeconds: number;
}

export interface CompactTelemetry {
  forcedTurns: number | null;
  breakEvenTurns: number | null;
  inForcedZone: boolean;
}

export interface ClaudeDerivedTelemetry {
  observedAt: number;
  turns: number;
  effort: string;
  cache: CacheTelemetry | null;
  compact: CompactTelemetry;
  apiHealthIndicator: string;
  healthCacheStale: boolean;
}

export interface DeriveClaudeOptions {
  home?: string;
  now?: number;
  writeLogs?: boolean;
  /**
   * Status page to read, when the API this session actually calls has one.
   * Omitted means no signal: a session routed somewhere else must not be
   * colored by a vendor whose service it never touches.
   */
  healthSource?: HealthSource | null;
  compactTargetPercent?: number;
  compactSummaryTokens?: number;
  recentContextRows?: number;
}

function floorNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function effortValue(value: unknown): string {
  if (typeof value === "string") {
    const normalized = safeText(value, 16).toLowerCase();
    return ["low", "medium", "high", "xhigh", "max"].includes(normalized)
      ? normalized
      : "";
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return effortValue(record.level) || effortValue(record.effort);
}

function metricSessionName(value: string): string {
  // Preserve ordinary Claude UUIDs for shell-HUD continuity. Anything capable
  // of changing the path gets a stable hash.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
    ? value
    : `session-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function extractEffort(input: ClaudeStatusInput): string {
  return effortValue(input.effort) ||
    effortValue(input.model?.effort) ||
    effortValue(input.reasoning_effort) ||
    effortValue(input.output_style?.effort);
}

async function effortFromSettings(cwd: string, home: string): Promise<string> {
  const candidates = [
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
    path.join(home, ".claude", "settings.json"),
  ];
  for (const candidate of candidates) {
    try {
      const settings = JSON.parse(await fs.readFile(candidate, "utf8"));
      const effort = effortValue(settings?.effortLevel);
      if (effort) return effort;
    } catch {
      // Missing or malformed settings are a fallback miss, not a HUD failure.
    }
  }
  return "";
}

async function appendMetric(filePath: string, row: string): Promise<void> {
  try {
    await ensurePrivateDirectory(path.dirname(filePath));
    await fs.appendFile(filePath, row, { encoding: "utf8", mode: 0o600 });
    await ensurePrivateFile(filePath);
  } catch {
    // Metrics are advisory. A read-only or malformed home must not hide the HUD.
  }
}

async function readMetricRows(filePath: string): Promise<string[][]> {
  try {
    await repairPrivateDirectory(path.dirname(filePath));
    await ensurePrivateFile(filePath);
    return (await fs.readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
  } catch {
    return [];
  }
}

export function compactBreakEvenTurns(
  totalInput: number | null,
  summaryTokens: number = PROVIDER_DEFAULTS.compactSummaryTokens,
): number | null {
  if (totalInput == null || totalInput <= summaryTokens * 2) return null;
  const numerator = 2 * totalInput + 125 * summaryTokens;
  const denominator = 2 * (totalInput - summaryTokens);
  return Math.max(1, Math.round(numerator / denominator));
}

async function compactTelemetry(
  input: ClaudeStatusInput,
  turns: number,
  home: string,
  now: number,
  writeLogs: boolean,
  options: DeriveClaudeOptions,
): Promise<CompactTelemetry> {
  const used = input.context_window?.used_percentage;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const totalInput = floorNumber(input.context_window?.total_input_tokens);
  const target = options.compactTargetPercent ?? PROVIDER_DEFAULTS.compactTargetPercent;
  const breakEvenTurns = compactBreakEvenTurns(
    totalInput,
    options.compactSummaryTokens ?? PROVIDER_DEFAULTS.compactSummaryTokens,
  );
  if (typeof used !== "number" || !Number.isFinite(used) || !sessionId) {
    return { forcedTurns: null, breakEvenTurns, inForcedZone: false };
  }

  const filePath = path.join(
    home,
    ".claude",
    "context-log",
    `${metricSessionName(sessionId)}.tsv`,
  );
  let rows = await readMetricRows(filePath);
  const last = rows.at(-1);
  const lastPercent = last ? Number(last[1]) : null;
  if (lastPercent == null || lastPercent !== used) {
    // A real drop starts a new post-compact segment; stale pre-reset slope must
    // not influence the next forced-compact forecast.
    if (lastPercent != null && Math.floor(lastPercent) - Math.floor(used) >= 3) {
      rows = [];
      if (writeLogs) {
        try {
          await atomicWritePrivate(filePath, "");
        } catch {
          // Continue with the in-memory post-reset segment.
        }
      }
    }
    const next = [String(now), String(used), String(turns)];
    rows.push(next);
    if (writeLogs) await appendMetric(filePath, `${next.join("\t")}\n`);
  }

  const recent = rows.slice(
    -(options.recentContextRows ?? PROVIDER_DEFAULTS.recentContextRows),
  );
  if (recent.length >= 2) {
    const first = recent[0];
    const latest = recent.at(-1)!;
    const deltaPercent = Number(latest[1]) - Number(first[1]);
    const deltaTurns = Number(latest[2]) - Number(first[2]);
    if (deltaPercent > 0 && deltaTurns > 0) {
      if (used >= target) {
        return { forcedTurns: 0, breakEvenTurns, inForcedZone: true };
      }
      return {
        forcedTurns: Math.max(
          1,
          Math.round((target - used) / (deltaPercent / deltaTurns)),
        ),
        breakEvenTurns,
        inForcedZone: false,
      };
    }
  }
  return { forcedTurns: null, breakEvenTurns, inForcedZone: false };
}

async function logCost(
  input: ClaudeStatusInput,
  home: string,
  now: number,
): Promise<void> {
  const cost = input.cost?.total_cost_usd;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId || typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
    return;
  }
  const filePath = path.join(
    home,
    ".claude",
    "cost-log",
    `${metricSessionName(sessionId)}.tsv`,
  );
  const rows = await readMetricRows(filePath);
  if (Number(rows.at(-1)?.[1]) !== cost) {
    await appendMetric(filePath, `${now}\t${cost}\n`);
  }
}

export function contextPercent(input: ClaudeStatusInput): number | null {
  const native = input.context_window?.used_percentage;
  if (typeof native === "number" && Number.isFinite(native)) {
    return Math.max(0, Math.min(100, native));
  }
  const usage = input.context_window?.current_usage;
  const size = input.context_window?.context_window_size;
  if (!usage || typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const used =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  return Math.max(0, Math.min(100, (used / size) * 100));
}

export async function deriveClaudeTelemetry(
  input: ClaudeStatusInput,
  options: DeriveClaudeOptions = {},
): Promise<ClaudeDerivedTelemetry> {
  const home = options.home || os.homedir();
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const cwd = input.workspace?.current_dir || input.cwd || "";
  const transcriptPath = input.transcript_path || "";
  const transcript = await readTranscriptFacts(transcriptPath, home);
  const turns = transcript?.turns ?? 0;
  const health = options.healthSource
    ? await healthState(options.healthSource, now, home)
    : { indicator: "", stale: false };
  const writeLogs = options.writeLogs ?? true;
  if (writeLogs) await logCost(input, home, now);
  return {
    observedAt: now,
    turns,
    effort: extractEffort(input) || await effortFromSettings(cwd, home),
    cache: transcript ? {
      expiresAt: transcript.mtimeSeconds + transcript.cacheTtlSeconds,
      ttlSeconds: transcript.cacheTtlSeconds,
    } : null,
    compact: await compactTelemetry(input, turns, home, now, writeLogs, options),
    apiHealthIndicator: health.indicator,
    healthCacheStale: health.stale,
  };
}
