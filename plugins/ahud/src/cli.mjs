#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeCwd, readJsonStdin, resolveDataDir } from "./io.mjs";
import { loadState, recordHook, detectPlatform } from "./store.mjs";
import { bar, renderSnapshot } from "./render.mjs";
import { truncate, visibleLength } from "./width.mjs";
import { getGitStatus } from "./git.mjs";
import { snapshotFromClaude, snapshotFromState } from "./snapshot.mjs";
import { isPlatformEnabled, loadConfig } from "./config.mjs";
import { hostIds, findHost, setupTargetIds } from "./hosts.mjs";
import { CODEX_PRESETS } from "./setup.mjs";
import { adapterPathFor, loadAdapter, renderWithAdapter } from "./adapter.mjs";
import { runSetupWizard, shouldRunWizard } from "./wizard.mjs";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

// Flags recognized by `setup()`'s parser below. `--interactive` is handled
// earlier in setup() (before parseSetupArgs runs) and is intentionally not
// part of this table.
const SETUP_VALUE_FLAGS = new Set(["--preset", "--config"]);

// Small, dedicated option parser for `ahud setup <args>` — deliberately
// separate from valueAfter() (which renderCurrent() still relies on for
// --cwd/--width) so fixing setup()'s parsing can't regress that call site.
// Produces { target, dryRun, preset, config } or throws a clear Error.
// Rules (see cli.mjs's `setup` review notes for the bugs this closes):
//   - Recognizes exactly --dry-run (boolean), --preset/--config (value).
//   - Both `--flag value` and `--flag=value` forms are accepted for
//     value-taking flags.
//   - A `--flag value` pair whose "value" is missing, empty, or itself
//     looks like a `--`-prefixed flag is rejected (`--flag requires a
//     value`) rather than silently swallowing the next flag as a value.
//   - The first token that isn't consumed as a flag/flag-value and isn't
//     itself an unrecognized `--`-prefixed flag is the positional target
//     candidate, found regardless of where it appears among the flags.
//     Missing -> target defaults to "both". Present but not
//     claude/codex/both -> throws "Unknown setup target".
//   - An unrecognized `--something` flag always throws its own error,
//     never falls through to being treated as (or searched for) a target.
function parseSetupArgs(args) {
  let target = null;
  let dryRun = false;
  let preset = null;
  let config = null;

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];

    if (raw === "--dry-run") {
      dryRun = true;
      continue;
    }

    const isFlag = raw.startsWith("--");
    const eqIndex = isFlag ? raw.indexOf("=") : -1;
    const flagName = eqIndex >= 0 ? raw.slice(0, eqIndex) : raw;

    if (isFlag && SETUP_VALUE_FLAGS.has(flagName)) {
      let value;
      if (eqIndex >= 0) {
        value = raw.slice(eqIndex + 1);
      } else {
        const next = args[i + 1];
        if (next == null || next.startsWith("--")) {
          throw new Error(`${flagName} requires a value`);
        }
        value = next;
        i += 1;
      }
      if (value === "") throw new Error(`${flagName} requires a value`);
      if (flagName === "--preset") preset = value;
      else config = value;
      continue;
    }

    if (isFlag) {
      throw new Error(`Unknown setup flag: "${raw}"`);
    }

    if (target === null) {
      target = raw;
      continue;
    }
    // A second positional token (e.g. `setup codex claude`, or a typo like
    // `setup codex claud`) is never valid — silently keeping only the first
    // one would let a mistake configure the wrong (or only one) host
    // without any indication something was ignored.
    throw new Error(`Unexpected extra argument: "${raw}" (setup takes at most one target)`);
  }

  if (target !== null && !hostIds().includes(target) && target !== "both") {
    throw new Error(`Unknown setup target: "${target}" (expected ${hostIds().join(", ")}, or both)`);
  }
  target = target ?? "both";

  if (config != null && target === "both") {
    throw new Error("--config requires a single target (claude or codex), not both");
  }

  // Validate --preset up front, before either host's setup() runs: it's
  // only meaningful for Codex (Claude's statusLine has no presets and
  // silently ignores options.preset), and an unknown preset name is a
  // typo, not something to discover partway through writing `both` hosts'
  // configs.
  if (preset != null) {
    if (!Object.hasOwn(CODEX_PRESETS, preset)) {
      throw new Error(`Unknown Codex preset: "${preset}" (expected ${Object.keys(CODEX_PRESETS).join(", ")})`);
    }
    if (target === "claude") {
      throw new Error("--preset only applies to codex (Claude's statusLine has no presets)");
    }
  }

  return { target, dryRun, preset, config: config ?? undefined };
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
  // Per the NO_COLOR spec (https://no-color.org/), the mere PRESENCE of the
  // env var disables color, regardless of its value — `!process.env.NO_COLOR`
  // is wrong for NO_COLOR="" (empty string is falsy, which would leave
  // colors on).
  const colors = options.colors ?? !("NO_COLOR" in process.env);
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
  }, { ttl: config.ttl });
  const cwd = input.workspace?.current_dir || input.cwd || state.cwd;
  const snapshot = snapshotFromClaude(input, state, getGitStatus(cwd));
  const adapter = config.adapter.enabled ? await loadAdapter() : null;
  if (config.adapter.enabled && !adapter) warnIfAdapterFileFailedToLoad();
  process.stdout.write(`${await renderOutput(snapshot, {}, config, adapter)}\n`);
  // A timed-out adapter (see adapter.mjs's withTimeout) only makes the
  // wrapper promise settle — the underlying import()/render() call keeps
  // running, and a leaked setTimeout inside a user adapter can keep this
  // process's event loop non-empty indefinitely. Output is already written
  // by this point, so force-exit rather than let a dangling adapter timer
  // hang the process open.
  process.exit(process.exitCode ?? 0);
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
  const { config } = await loadConfig();
  const state = await loadState({ cwd }, { ttl: config.ttl });
  const snapshot = snapshotFromState(state, getGitStatus(state.cwd || cwd));
  const options = {
    // Leave colors undefined (rather than defaulting true) when --no-color
    // isn't passed, so renderOutput's `options.colors ?? !("NO_COLOR" in
    // process.env)` fallback can still see and honor NO_COLOR for watch/
    // statusline alike.
    colors: args.includes("--no-color") ? false : undefined,
    width: Number(valueAfter(args, "--width")) || undefined,
  };
  return renderOutput(snapshot, options, config, adapter);
}

async function watch(args) {
  const { config, path: configPath, warnings } = await loadConfig();
  // `watch` is the human-facing, interactively-launched path, so config
  // problems are surfaced here. `hook` and `statusline` are host-invoked
  // (Claude Code/Codex spawn them) and must stay completely silent about
  // config warnings — printing there would pollute host-owned stdout/stderr
  // contracts the user never directly sees.
  for (const warning of warnings ?? []) {
    process.stderr.write(`ahud: warning: ${warning}\n`);
  }
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
    // See the matching comment in statusline(): force-exit so a dangling
    // adapter timer/promise can't keep this one-shot process alive past
    // the point where its output has already been written.
    process.exit(process.exitCode ?? 0);
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

// Shared by both the flag-driven path and the interactive wizard path:
// applies a resolved {target, options} pair (writing config via each
// registered host's own setup() function — see hosts.mjs) and prints the
// same result/disabled-note output either way.
async function applySetupResult(target, options) {
  const targetIds = setupTargetIds(target);
  const results = [];
  for (const id of targetIds) {
    const host = findHost(id);
    if (!host) throw new Error(`setup target must be ${hostIds().join(", ")}, or both`);
    results.push([host.badge, id, await host.setup(options)]);
  }
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

  const { target, dryRun, preset, config } = parseSetupArgs(args);
  const options = { dryRun, preset, config };
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
  ahud --version                print the installed ahud version

Environment:
  AHUD_DATA_DIR         override local event storage
  NO_COLOR              disable ANSI colors
`);
}

function readVersion() {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version || "unknown";
  } catch {
    return "unknown";
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "help", ...args] = argv;
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (command === "hook") return hook();
  if (command === "statusline") return statusline();
  if (command === "watch") return watch(args);
  if (command === "setup") return setup(args);
  if (command === "demo") return demo();
  // An unrecognized command (anything other than a bare invocation or the
  // explicit "help") still prints help, but must exit nonzero — silently
  // exiting 0 on a typo'd command hides the mistake from scripts/CI.
  if (command !== "help") process.exitCode = 1;
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
