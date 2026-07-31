#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeCwd, readJsonStdin, resolveDataDir } from "./io.mjs";
import { loadState, recordHook, detectPlatform } from "./store.mjs";
import {
  bar,
  getGitStatus,
  renderSnapshot,
  snapshotFromClaude,
  snapshotFromState,
  truncate,
  visibleLength,
} from "./render.mjs";
import { setupClaude, setupCodex } from "./setup.mjs";
import { isPlatformEnabled, loadConfig } from "./config.mjs";
import { adapterPathFor, loadAdapter, renderWithAdapter } from "./adapter.mjs";
import { runSetupWizard, shouldRunWizard } from "./wizard.mjs";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

// Adapter failures (load or render) are silently downgraded to the
// built-in renderer, but we still want to tell the user once per process
// so a broken adapter doesn't fail invisibly forever.
let adapterWarned = false;
function warnAdapterFailure(reason) {
  if (adapterWarned) return;
  adapterWarned = true;
  process.stderr.write(`ahud: adapter failed (${reason}), using built-in renderer\n`);
}

// loadAdapter() returning null is expected and silent when there simply is
// no ~/.ahud/adapter.mjs (per adapter.mjs's own contract) — that must NOT
// trigger a warning. It only means something actually went wrong (syntax
// error, no valid render export, hung import) when the file exists but
// loadAdapter still came back empty-handed.
function warnIfAdapterFileFailedToLoad(home = os.homedir()) {
  if (fs.existsSync(adapterPathFor(home))) {
    warnAdapterFailure("could not load ~/.ahud/adapter.mjs");
  }
}

async function renderOutput(snapshot, options, config, adapter) {
  const width = options.width || Number(process.env.COLUMNS) || 120;
  const colors = options.colors ?? !process.env.NO_COLOR;
  const resolvedOptions = { width, colors };
  if (adapter) {
    const context = {
      apiVersion: 1,
      config,
      width,
      colors,
      utils: { visibleLength, truncate, bar },
    };
    const result = await renderWithAdapter(adapter, snapshot, context);
    if (result.ok) return result.text;
    warnAdapterFailure(result.error);
  }
  return renderSnapshot(snapshot, resolvedOptions);
}

async function hook() {
  const input = await readJsonStdin();
  if (input) {
    try {
      const { config } = await loadConfig();
      const platform = detectPlatform(input, process.env);
      if (isPlatformEnabled(config, platform)) {
        await recordHook(input);
      }
    } catch {
      // HUD telemetry must never block the agent.
    }
  }
  process.stdout.write("{}\n");
}

async function statusline() {
  const { config } = await loadConfig();
  if (!isPlatformEnabled(config, "claude")) return;
  const input = await readJsonStdin();
  if (!input) return;
  const state = await loadState({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.workspace?.current_dir || input.cwd,
  });
  const cwd = input.workspace?.current_dir || input.cwd || state.cwd;
  const snapshot = snapshotFromClaude(input, state, getGitStatus(cwd));
  const adapter = config.adapter.enabled ? await loadAdapter() : null;
  if (config.adapter.enabled && !adapter) warnIfAdapterFileFailedToLoad();
  process.stdout.write(`${await renderOutput(snapshot, {}, config, adapter)}\n`);
}

function demo() {
  const snapshot = {
    platform: "codex",
    model: "gpt-5.6-sol · high",
    project: "ahud",
    context: 45,
    limits: [
      { label: "5h", percent: 25 },
      { label: "7d", percent: 11 },
    ],
    git: { branch: "main", dirty: true },
    tools: [
      { name: "apply_patch", target: "render.mjs", status: "running" },
      { name: "Read", status: "completed" },
    ],
    agents: [
      { type: "reviewer", status: "running" },
    ],
    plan: [
      { text: "Design the shared event model", status: "completed" },
      { text: "Implement Claude/Codex HUD", status: "in_progress" },
      { text: "Verify end to end", status: "pending" },
    ],
  };
  process.stdout.write(`${renderSnapshot(snapshot)}\n`);
}

async function renderCurrent(args, adapter = null) {
  const cwd = normalizeCwd(valueAfter(args, "--cwd") || process.cwd());
  const state = await loadState({ cwd });
  const snapshot = snapshotFromState(state, getGitStatus(state.cwd || cwd));
  const { config } = await loadConfig();
  const options = {
    colors: !args.includes("--no-color"),
    width: Number(valueAfter(args, "--width")) || undefined,
  };
  return renderOutput(snapshot, options, config, adapter);
}

async function watch(args) {
  const { config, path: configPath } = await loadConfig();
  const once = args.includes("--once") || !process.stdout.isTTY;
  if (!config.enabled) {
    if (once) return;
    process.stdout.write(`ahud is disabled (${configPath})\n`);
    return;
  }
  const adapter = config.adapter.enabled ? await loadAdapter() : null;
  if (config.adapter.enabled && !adapter) warnIfAdapterFileFailedToLoad();
  if (once) {
    process.stdout.write(`${await renderCurrent(args, adapter)}\n`);
    return;
  }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.stdout.write("\u001b[?25h\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write("\u001b[?25l");
  while (!stopped) {
    const frame = await renderCurrent(args, adapter);
    process.stdout.write(`\u001b[2J\u001b[H${frame}`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

// Shared by both the flag-driven path and the interactive wizard path: applies
// a resolved {target, options} pair (writing config via setupClaude/
// setupCodex) and prints the same result/disabled-note output either way.
async function applySetupResult(target, options) {
  const results = [];
  if (target === "claude" || target === "both") results.push(["Claude", "claude", await setupClaude(options)]);
  if (target === "codex" || target === "both") results.push(["Codex", "codex", await setupCodex(options)]);
  if (!results.length) throw new Error("setup target must be claude, codex, or both");
  for (const [label, , result] of results) {
    if (options.dryRun) {
      process.stdout.write(`--- ${label}: ${result.filePath}\n${result.content}`);
    } else {
      process.stdout.write(`${label} ${result.changed ? "configured" : "already configured"}: ${result.filePath}\n`);
      if (result.backup) process.stdout.write(`backup: ${result.backup}\n`);
    }
  }

  const { config, path: configPath } = await loadConfig();
  if (config.enabled === false) {
    process.stdout.write(`note: ahud is currently disabled in ${configPath}\n`);
  }
  for (const [, platformKey] of results) {
    if (config.platforms?.[platformKey] === false) {
      process.stdout.write(`note: ${platformKey} HUD is disabled in ${configPath}\n`);
    }
  }
}

async function setup(args) {
  if (args.includes("--interactive")) {
    if (args.length > 1) throw new Error("--interactive cannot be combined with other arguments");
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive setup requires a TTY");
    const result = await runSetupWizard({});
    if (result === null) {
      process.stdout.write("nothing written\n");
      return;
    }
    return applySetupResult(result.target, result.options);
  }
  if (shouldRunWizard(args)) {
    const result = await runSetupWizard({});
    if (result === null) {
      process.stdout.write("nothing written\n");
      return;
    }
    return applySetupResult(result.target, result.options);
  }

  const target = args[0] || "both";
  const presetArg = valueAfter(args, "--preset");
  if (args.includes("--preset") && presetArg == null) {
    throw new Error("--preset requires a value");
  }
  const options = {
    dryRun: args.includes("--dry-run"),
    preset: presetArg,
    config: valueAfter(args, "--config") || undefined,
  };
  return applySetupResult(target, options);
}

function help() {
  process.stdout.write(`ahud — one HUD for Codex and Claude Code

Usage:
  ahud hook                     capture a hook event from stdin
  ahud statusline               render Claude Code statusline JSON from stdin
  ahud watch [--cwd PATH]       live companion HUD for Codex or Claude
  ahud watch --once             print the latest activity snapshot
  ahud setup                    bare setup: launches an interactive wizard in a real terminal
                                 (use --interactive to force it, --dry-run/--preset/etc. to skip it)
  ahud setup claude             configure Claude Code statusLine
  ahud setup codex [--preset compact|balanced|full]
  ahud setup both
  ahud demo

Environment:
  AHUD_DATA_DIR         override local event storage
  NO_COLOR              disable ANSI colors
`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "help", ...args] = argv;
  if (command === "hook") return hook();
  if (command === "statusline") return statusline();
  if (command === "watch") return watch(args);
  if (command === "setup") return setup(args);
  if (command === "demo") return demo();
  help();
}

function isMainModule() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
  }
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`ahud: ${error.message}\n`);
    process.exitCode = 1;
  });
}
