#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  deriveClaudeTelemetry,
  getGitStatus,
  loadState,
  normalizeAntigravityStatus,
  normalizeClaudeStatus,
  normalizeCursorStatus,
  readJsonStdin,
  recordHook,
  refreshAnthropicHealth,
  spawnHealthRefresh,
  type AntigravityStatusInput,
  type ClaudeStatusInput,
  type CursorStatusInput,
  type GitStatus,
  type JsonObject,
  type Platform,
} from "@agent-hud/provider";
import {
  snapshotFromAntigravity,
  snapshotFromClaude,
  snapshotFromCursor,
  snapshotFromState,
} from "./adapter.js";
import { HUD_DESIGN } from "./design.js";
import { renderSnapshot } from "./render.js";
import {
  setupAntigravity,
  setupClaude,
  setupCodex,
  setupCursor,
} from "./setup.js";
import type { HudSnapshot } from "./types.js";

const CLI_PATH = fileURLToPath(import.meta.url);
const WATCH_GIT_REFRESH_MS = 5_000;

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function hookPlatform(args: string[]): Platform | undefined {
  const value = valueAfter(args, "--platform");
  return ["codex", "claude", "antigravity", "cursor", "agent"].includes(
    String(value),
  ) ? value as Platform : undefined;
}

async function hook(args: string[]): Promise<void> {
  const input = await readJsonStdin() as JsonObject | null;
  const platform = hookPlatform(args);
  const event = valueAfter(args, "--event") || undefined;
  if (input) {
    try {
      await recordHook(input, { platform, event });
    } catch {
      // HUD telemetry must never block the agent.
    }
  }
  // Antigravity's inspect-only PreToolUse and Stop hooks require a decision
  // field. An empty decision is the host's documented neutral/default path:
  // never allow, deny, ask, or continue on the user's behalf.
  const response = platform === "antigravity" &&
      (event === "PreToolUse" || event === "Stop")
    ? { decision: "" }
    : {};
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function statusline(): Promise<void> {
  const input = await readJsonStdin() as (
    ClaudeStatusInput | CursorStatusInput | AntigravityStatusInput
  ) | null;
  if (!input) return;
  const isAntigravity =
    (input as AntigravityStatusInput).product === "antigravity" ||
    typeof (input as AntigravityStatusInput).agent_state === "string";
  const isCursor = !isAntigravity && (
    typeof (input as CursorStatusInput).autorun === "boolean" ||
    Number.isFinite((input as CursorStatusInput).render_width_chars)
  );
  const state = await loadState({
    sessionId: input.session_id ||
      (input as AntigravityStatusInput).conversation_id,
    transcriptPath: input.transcript_path,
    cwd: input.workspace?.current_dir || input.cwd,
    platform: isAntigravity ? "antigravity" : isCursor ? "cursor" : "claude",
  });
  const cwd = input.workspace?.current_dir || input.cwd || state.cwd;
  if (isAntigravity) {
    const host = input as AntigravityStatusInput;
    const snapshot = snapshotFromAntigravity(
      normalizeAntigravityStatus(host, state),
      host.vcs ? null : getGitStatus(cwd),
    );
    process.stdout.write(`${renderSnapshot(snapshot, {
      activity: false,
      width: finiteWidth(host.terminal_width),
    })}\n`);
    return;
  }
  if (isCursor) {
    const host = input as CursorStatusInput;
    const snapshot = snapshotFromCursor(
      normalizeCursorStatus(host, state),
      getGitStatus(cwd),
    );
    process.stdout.write(`${renderSnapshot(snapshot, {
      activity: false,
      width: finiteWidth(host.render_width_chars),
    })}\n`);
    return;
  }
  const derived = await deriveClaudeTelemetry(input, {
    compactTargetPercent: HUD_DESIGN.warning.contextFullness.red,
    compactSummaryTokens: HUD_DESIGN.compact.summaryTokens,
    recentContextRows: HUD_DESIGN.compact.recentChangedRows,
  });
  const facts = normalizeClaudeStatus(input, state, derived);
  if (facts.healthCacheStale) await spawnHealthRefresh(CLI_PATH);
  const snapshot = snapshotFromClaude(facts, getGitStatus(cwd));
  process.stdout.write(`${renderSnapshot(snapshot, { activity: false })}\n`);
}

function finiteWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function demo(): void {
  const snapshot: HudSnapshot = {
    platform: "codex",
    observedAt: Math.floor(Date.now() / 1_000),
    model: "gpt-5.6-sol",
    effort: "high",
    totalInput: 90_420,
    contextSize: 200_000,
    turns: 26,
    project: "agent-hud",
    context: 45,
    limits: [
      { label: "7d", percent: 11 },
    ],
    resets: [],
    git: { branch: "main", detached: false, dirty: true, ahead: 0, behind: 0 },
    cwd: "/workspace/agent-hud",
    cost: 5.32,
    linesAdded: 128,
    linesRemoved: 17,
    tools: [
      { name: "apply_patch", target: "render.ts", status: "running" },
      { name: "Read", status: "completed" },
    ],
    agents: [
      { type: "reviewer", status: "running" },
    ],
    plan: [
      { text: "确定统一事件模型", status: "completed" },
      { text: "实现 Claude/Codex HUD", status: "in_progress" },
      { text: "完成验证", status: "pending" },
    ],
  };
  process.stdout.write(`${renderSnapshot(snapshot)}\n`);
}

/**
 * The companion repaints activity quickly, but Git is a deliberately slow
 * fact: `git status` and upstream divergence require several subprocesses.
 * Keep it fresh enough for a HUD without repeating that work every 350 ms.
 */
export class GitRefreshCache {
  private cwd = "";
  private value: GitStatus | null = null;
  private refreshedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly read: (cwd: string) => GitStatus | null = getGitStatus,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = WATCH_GIT_REFRESH_MS,
  ) {}

  get(cwd: string): GitStatus | null {
    const now = this.now();
    if (cwd !== this.cwd || now - this.refreshedAt >= this.ttlMs) {
      this.cwd = cwd;
      this.value = this.read(cwd);
      this.refreshedAt = now;
    }
    return this.value;
  }
}

async function currentSnapshot(
  args: string[],
  git: (cwd: string) => GitStatus | null = getGitStatus,
): Promise<HudSnapshot> {
  const cwd = valueAfter(args, "--cwd") || process.cwd();
  const state = await loadState({ cwd });
  return snapshotFromState(state, git(state.cwd || cwd));
}

async function renderCurrent(
  args: string[],
  git: (cwd: string) => GitStatus | null = getGitStatus,
): Promise<string> {
  const snapshot = await currentSnapshot(args, git);
  if (args.includes("--json")) return JSON.stringify(snapshot);
  return renderSnapshot(snapshot, {
    colors: !args.includes("--no-color") && !process.env.NO_COLOR,
    width: resolveRenderWidth(args),
  });
}

export function resolveRenderWidth(
  args: string[],
  terminalColumns = process.stdout.columns,
): number | undefined {
  const explicit = Number(valueAfter(args, "--width"));
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  if (
    typeof terminalColumns === "number" &&
    Number.isFinite(terminalColumns) &&
    terminalColumns > 0
  ) return Math.floor(terminalColumns);
  const environment = Number(process.env.COLUMNS);
  return Number.isFinite(environment) && environment > 0
    ? Math.floor(environment)
    : undefined;
}

export async function withHiddenCursor<T>(
  write: (value: string) => void,
  operation: () => Promise<T>,
): Promise<T> {
  write("\u001b[?25l");
  try {
    return await operation();
  } finally {
    write("\u001b[?25h\n");
  }
}

async function watch(args: string[]): Promise<void> {
  if (args.includes("--once") || !process.stdout.isTTY) {
    process.stdout.write(`${await renderCurrent(args)}\n`);
    return;
  }
  const git = new GitRefreshCache();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await withHiddenCursor(
      (value) => {
        process.stdout.write(value);
      },
      async () => {
        // Signal handlers mutate this guard asynchronously between frames.
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition
        while (!stopped) {
          const frame = await renderCurrent(args, (cwd) => git.get(cwd));
          process.stdout.write(`\u001b[2J\u001b[H${frame}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 350));
        }
      },
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function setup(args: string[]): Promise<void> {
  const target = args[0] || "all";
  const options = {
    dryRun: args.includes("--dry-run"),
    preset: valueAfter(args, "--preset") || "balanced",
    config: valueAfter(args, "--config") || undefined,
    hooksConfig: valueAfter(args, "--hooks-config") || undefined,
  };
  const results: Array<[string, any]> = [];
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
  if (!results.length) {
    throw new Error(
      "setup target must be claude, codex, cursor, antigravity, both, or all",
    );
  }
  for (const [label, result] of results) {
    if (options.dryRun) {
      process.stdout.write(`--- ${label}: ${result.filePath}\n${result.content}`);
    } else {
      process.stdout.write(`${label} ${result.changed ? "configured" : "already configured"}: ${result.filePath}\n`);
      if (result.backup) process.stdout.write(`backup: ${result.backup}\n`);
    }
    if (result.hooks) {
      if (options.dryRun) {
        process.stdout.write(
          `--- ${label} hooks: ${result.hooks.filePath}\n${result.hooks.content}`,
        );
      } else {
        process.stdout.write(
          `${label} hooks ${
            result.hooks.changed ? "configured" : "already configured"
          }: ${result.hooks.filePath}\n`,
        );
        if (result.hooks.backup) {
          process.stdout.write(`backup: ${result.hooks.backup}\n`);
        }
      }
    }
  }
}

async function refreshHealth(args: string[]): Promise<void> {
  const lockPath = valueAfter(args, "--refresh-lock");
  const lockToken = valueAfter(args, "--refresh-token");
  await refreshAnthropicHealth(
    valueAfter(args, "--home") || undefined,
    lockPath && lockToken ? { path: lockPath, token: lockToken } : undefined,
  );
}

function help(): void {
  process.stdout.write(`Agent HUD — one HUD for Codex, Claude Code, Cursor and Antigravity

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
  agent-hud setup both
  agent-hud setup all
  agent-hud demo

Environment:
  AGENT_HUD_DATA_DIR   override local event storage
  NO_COLOR             disable ANSI colors
`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = "help", ...args] = argv;
  if (command === "hook") return hook(args);
  if (command === "statusline") return statusline();
  if (command === "watch") return watch(args);
  if (command === "setup") return setup(args);
  if (command === "demo") return demo();
  if (command === "refresh-health") return refreshHealth(args);
  help();
}

function isMainModule(): boolean {
  const executable = process.argv[1];
  if (!executable) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(executable);
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(executable);
  }
}

if (isMainModule()) {
  main().catch((error: Error) => {
    process.stderr.write(`agent-hud: ${error.message}\n`);
    process.exitCode = 1;
  });
}
