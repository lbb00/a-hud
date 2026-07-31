// End-to-end tests for ahud.
//
// Unlike test/*.test.mjs (unit tests that call exported pure functions
// directly inside the test process), everything here shells out to
// `node src/cli.mjs <command>` as an independent OS subprocess, the way a
// real Claude Code / Codex host actually invokes ahud. This is the only way
// to catch bugs that only exist *between* processes — e.g. the hook writer
// and the watch/statusline reader silently resolving to two different data
// directories, which unit tests calling resolveDataDir() in-process can
// never reproduce because they never fork.
//
// Run with: npm run test:e2e  (== node test/e2e/run.mjs)
//
// Every test builds its own fs.mkdtempSync HOME/CODEX_HOME/CLAUDE_CONFIG_DIR
// and passes a minimal, explicit env to every child process, so this suite
// never reads from or writes to the real ~/.claude, ~/.codex, or ~/.ahud.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = path.join(ROOT, "src", "cli.mjs");

// Hard ceiling for any single subprocess call in this suite. Nothing here
// should legitimately take anywhere close to this long; it exists so a
// stuck child (e.g. something unexpectedly waiting on stdin, or a hung tmux
// command) fails loudly with a killed process instead of hanging the whole
// e2e run forever. spawnSync's `timeout` sends SIGTERM to the child once
// exceeded and reports it back via the `signal`/`error` fields on the result.
const SUBPROCESS_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function mkdtemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Minimal env for a child ahud process: only what a real invocation needs
// (PATH so `node`/`git`/`sh` resolve, HOME so os.homedir() lands in our temp
// tree) plus whatever the caller explicitly adds. Never spreads
// process.env wholesale, so a real ~/.ahud, AHUD_DATA_DIR, CODEX_HOME, etc.
// set on the machine running this suite can never leak in.
//
// Note on interactive-prompt safety: every subprocess this suite spawns is
// either `node src/cli.mjs ...` (this plugin's own CLI — never the real
// `claude`/`codex` host binaries), `sh -c <statusLine.command>` (which itself
// just runs the same `node src/cli.mjs statusline`), or `tmux`/`git`
// housekeeping commands. None of these are the actual Claude Code / Codex
// CLI, so there is no "trust this directory" / "upgrade available"
// interactive prompt to worry about here — that risk only exists if a test
// were to shell out to the real `claude`/`codex` binaries, which none do.
function baseEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    // node:os on some platforms also consults USERPROFILE/LOGNAME; keep it
    // simple and consistent across macOS/Linux for this suite.
    ...extra,
  };
}

// `input` defaults to "" (not undefined) so spawnSync always writes an
// immediate EOF to the child's stdin. This matters specifically for `hook`
// and `statusline`, whose readJsonStdin() in src/io.mjs blocks on
// `for await (const chunk of stream)` until stdin closes — forgetting to
// pass input here would hang that child indefinitely rather than just
// short-circuiting to "no input". The explicit `timeout` is a second,
// independent safety net on top of that.
function runCli(args, { input = "", env, cwd } = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    input,
    encoding: "utf8",
    env,
    cwd,
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (result.error?.code === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.error)) {
    throw new Error(`ahud ${args.join(" ")} timed out after ${SUBPROCESS_TIMEOUT_MS}ms (stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)})`);
  }
  return result;
}

async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// Thin wrapper around tmux spawnSync/execFileSync calls that guarantees a
// timeout on every single one, so a hung tmux server can never hang this
// suite. Throws with whatever stdout/stderr it managed to collect so a
// failure is diagnosable rather than a silent hang.
function tmuxSync(args, { allowFailure = false } = {}) {
  const result = spawnSync("tmux", args, { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`tmux ${args.join(" ")} timed out after ${SUBPROCESS_TIMEOUT_MS}ms`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (status=${result.status}): ${result.stderr}`);
  }
  return result;
}

function hasTmux() {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// A. setup full pipeline (real files, not --dry-run)
// ---------------------------------------------------------------------------

test("A. setup writes real Claude settings.json + Codex config.toml and both are usable", { timeout: 30_000 }, async (t) => {
  const home = await mkdtemp("ahud-e2e-home-");
  const codexHome = await mkdtemp("ahud-e2e-codex-");
  const claudeConfigDir = await mkdtemp("ahud-e2e-claude-");
  t.after(() => Promise.all([rmrf(home), rmrf(codexHome), rmrf(claudeConfigDir)]));

  const env = baseEnv(home, { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfigDir });

  const setupResult = runCli(["setup", "both"], { env });
  assert.equal(setupResult.status, 0, `setup both failed: ${setupResult.stderr}`);
  assert.match(setupResult.stdout, /Claude configured:/);
  assert.match(setupResult.stdout, /Codex configured:/);

  // --- settings.json ---
  const settingsPath = path.join(claudeConfigDir, "settings.json");
  const settingsRaw = await fs.readFile(settingsPath, "utf8");
  const settings = JSON.parse(settingsRaw); // throws if not valid JSON
  assert.equal(settings.statusLine.type, "command");
  assert.match(settings.statusLine.command, /cli\.mjs['"]?\s+statusline$/);
  assert.match(settings.statusLine.command, new RegExp(CLI_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Really execute the generated command string through `sh -c`, feeding it
  // a realistic Claude Code statusline payload, to prove it is not just
  // syntactically present in JSON but actually runnable end to end.
  const statuslinePayload = JSON.stringify({
    session_id: "setup-check",
    model: { display_name: "Sonnet" },
    workspace: { current_dir: home },
    context_window: { used_percentage: 12.3 },
    rate_limits: { five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 1 } },
  });
  const shResult = spawnSync("sh", ["-c", settings.statusLine.command], {
    input: statuslinePayload,
    encoding: "utf8",
    env: baseEnv(home),
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (shResult.error?.code === "ETIMEDOUT") {
    throw new Error(`statusLine.command timed out after ${SUBPROCESS_TIMEOUT_MS}ms under sh -c: ${settings.statusLine.command}`);
  }
  assert.equal(shResult.status, 0, `statusLine.command failed under sh -c: ${shResult.stderr}`);
  assert.match(shResult.stdout, /Sonnet/, `expected model name in statusline output, got: ${JSON.stringify(shResult.stdout)}`);
  assert.doesNotMatch(shResult.stderr, /syntax error/i);

  // --- config.toml (balanced preset, the setup default) ---
  const configPath = path.join(codexHome, "config.toml");
  const configRaw = await fs.readFile(configPath, "utf8");
  const balancedSection = extractTuiSection(configRaw);
  assert.equal(balancedSection.tableCount, 1, "expected exactly one [tui] table");
  assert.match(balancedSection.body, /status_line = \[.*"model-with-reasoning".*\]/);
  assert.match(balancedSection.body, /status_line = \[.*"task-progress".*\]/);

  // --- re-run with a different preset (user changes their mind) ---
  const secondResult = runCli(["setup", "codex", "--preset", "full"], { env });
  assert.equal(secondResult.status, 0, `setup codex --preset full failed: ${secondResult.stderr}`);

  const configRaw2 = await fs.readFile(configPath, "utf8");
  const fullSection = extractTuiSection(configRaw2);
  assert.equal(fullSection.tableCount, 1, "expected exactly one [tui] table after re-running setup");
  // full-only keys that were NOT present in the balanced preset must now show up.
  assert.match(fullSection.body, /"context-remaining"/);
  assert.match(fullSection.body, /"used-tokens"/);
  assert.match(fullSection.body, /"session-id"/);
  // The file must still be structurally sound: same number of top-level
  // table headers as sections we can identify, no stray leftover status_line
  // key duplicated from the previous run.
  assert.equal((configRaw2.match(/^status_line\s*=/gm) || []).length, 1, "status_line key must appear exactly once");
});

// Lightweight, dependency-free extraction of the `[tui]` table body: this is
// intentionally not a real TOML parser (the project has zero deps and wants
// to keep it that way) — it just needs to prove the section still has
// well-defined boundaries after two successive patches.
function extractTuiSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[tui\]\s*$/.test(line));
  if (start < 0) return { tableCount: 0, body: "" };
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  const tableCount = lines.filter((line) => /^\s*\[tui\]\s*$/.test(line)).length;
  return { tableCount, body: lines.slice(start, end).join("\n") };
}

// ---------------------------------------------------------------------------
// B. hook -> store -> read, entirely through independent subprocesses
// ---------------------------------------------------------------------------

test("B. independent hook/watch/statusline subprocesses agree on the default data dir with no AHUD_DATA_DIR set", { timeout: 30_000 }, async (t) => {
  const home = await mkdtemp("ahud-e2e-hookhome-");
  t.after(() => rmrf(home));

  const projectCwd = path.join(home, "project");
  await fs.mkdir(projectCwd, { recursive: true });
  // transcript_path must contain "/.claude/" so detectPlatform() in
  // store.mjs classifies these events as the "claude" platform.
  const transcriptPath = path.join(home, ".claude", "projects", "demo", "transcript.jsonl");
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

  const sessionId = "e2e-session-1";
  const env = baseEnv(home); // deliberately NO AHUD_DATA_DIR

  const basePayload = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: projectCwd,
    model: { display_name: "Sonnet" },
  };

  function hook(overrides) {
    const payload = JSON.stringify({ ...basePayload, ...overrides });
    const result = runCli(["hook"], { input: payload, env, cwd: projectCwd });
    assert.equal(result.status, 0, `hook subprocess failed for ${overrides.hook_event_name}: ${result.stderr}`);
    assert.equal(result.stdout, "{}\n", `hook subprocess produced unexpected stdout: ${result.stdout}`);
    return result;
  }

  // The real Claude Code lifecycle this bug ("hook writer and HUD reader
  // disagree on the data dir") was originally found in: each call below is
  // its own `node src/cli.mjs hook` process, sharing nothing with the others
  // except the filesystem.
  hook({ hook_event_name: "SessionStart" });
  hook({ hook_event_name: "UserPromptSubmit" });
  hook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "call-bash-1",
    tool_input: { command: "echo hi" },
  });
  hook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "call-bash-1",
    tool_input: { command: "echo hi" },
  });
  // Deliberately NO tool_use_id here: regression coverage (in a real,
  // cross-process setting) for the fallback session+tool-name pairing logic
  // in normalizeHookEvent, since unit tests only ever exercised this in a
  // single process calling normalizeHookEvent() directly.
  hook({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(projectCwd, "README.md") },
  });
  hook({
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(projectCwd, "README.md") },
  });
  hook({ hook_event_name: "SubagentStart", agent_type: "reviewer" });
  hook({ hook_event_name: "SubagentStop", agent_type: "reviewer" });
  // A failed tool call, with no matching PreToolUse — exercises the
  // render.mjs bug this e2e run found and fixed (see below).
  hook({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Write",
    tool_use_id: "call-write-1",
    tool_input: { file_path: path.join(projectCwd, "out.txt") },
  });
  hook({ hook_event_name: "Stop" });
  hook({ hook_event_name: "SessionEnd" });

  // --- independent `watch --once` subprocess, no AHUD_DATA_DIR ---
  const watchResult = runCli(["watch", "--once", "--cwd", projectCwd, "--no-color"], { env, cwd: projectCwd });
  assert.equal(watchResult.status, 0, `watch --once failed: ${watchResult.stderr}`);
  const watchOutput = watchResult.stdout;

  // This is the core assertion of this whole file: two fully independent
  // subprocesses (no shared JS memory, no AHUD_DATA_DIR override) must land
  // on the same on-disk data directory purely from HOME. If this fails, the
  // hook-writer/HUD-reader data dir split bug is back.
  assert.notEqual(watchOutput.trim(), "", "watch --once produced empty output: the reader could not find what the hook writer wrote (data dir split?)");
  assert.match(watchOutput, /Bash/, "expected the Bash tool to show up in watch output");
  assert.match(watchOutput, /Read/, "expected the Read tool to show up in watch output");
  // Both tools finished (PostToolUse arrived): neither should still show the
  // "running" spinner glyph paired with its own name.
  assert.doesNotMatch(watchOutput, /◐ Bash/, "Bash should be completed, not stuck running");
  assert.doesNotMatch(watchOutput, /◐ Read/, "Read should be completed, not stuck running");
  assert.match(watchOutput, /✓ Bash/, "expected Bash to render as completed (✓)");
  assert.match(watchOutput, /✓ Read/, "expected Read to render as completed (✓)");
  // Regression pin for the render.mjs bug found by this suite: a tool that
  // ended via PostToolUseFailure must render distinctly (red ✗), not as a
  // plain green ✓ indistinguishable from a real success.
  assert.match(watchOutput, /✗ Write/, "expected the failed Write tool to render as ✗, not a plain ✓ (this is the bug this e2e run found and fixed in src/render.mjs)");
  // status folded from hooks: SessionEnd was the last lifecycle event, so
  // the HUD should read idle, not stuck on "working".
  assert.match(watchOutput, /●/, "expected the idle status indicator (●) after SessionEnd");
  assert.match(watchOutput, /reviewer/, "expected the reviewer subagent to show up");

  t.diagnostic(`watch --once output:\n${watchOutput}`);

  // --- independent `statusline` subprocess with realistic Claude Code JSON ---
  const statuslinePayload = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    model: { display_name: "Sonnet" },
    workspace: { current_dir: projectCwd },
    cwd: projectCwd,
    context_window: { used_percentage: 33.7 },
    rate_limits: {
      five_hour: { used_percentage: 18 },
      seven_day: { used_percentage: 4 },
    },
  });
  const statuslineResult = runCli(["statusline"], { input: statuslinePayload, env, cwd: projectCwd });
  assert.equal(statuslineResult.status, 0, `statusline failed: ${statuslineResult.stderr}`);
  assert.match(statuslineResult.stdout, /Sonnet/);
  assert.match(statuslineResult.stdout, /Context/);
  assert.match(statuslineResult.stdout, /33%|34%/, `expected ~33% context usage, got: ${statuslineResult.stdout}`);

  t.diagnostic(`statusline output:\n${statuslineResult.stdout}`);
});

// ---------------------------------------------------------------------------
// C. real tmux session running `ahud watch`
// ---------------------------------------------------------------------------

test("C. `ahud watch` runs live inside a real tmux session, refreshes on new events, and exits cleanly on Ctrl-C", { timeout: 30_000 }, async (t) => {
  if (!hasTmux()) {
    t.diagnostic("tmux not available on this machine — skipping the tmux-driven live watch test.");
    t.skip("tmux not available");
    return;
  }

  const home = await mkdtemp("ahud-e2e-tmuxhome-");
  const sessionName = `ahud-e2e-${process.pid}-${Date.now()}`;
  let sessionCreated = false;

  t.after(async () => {
    // No matter whether assertions above passed, threw, or timed out, always
    // tear the tmux session down (allowFailure: it may already be gone) so a
    // failed run never leaves a stray session behind.
    if (sessionCreated) {
      tmuxSync(["kill-session", "-t", sessionName], { allowFailure: true });
    }
    await rmrf(home);
  });

  const projectCwd = path.join(home, "project");
  await fs.mkdir(projectCwd, { recursive: true });
  const transcriptPath = path.join(home, ".claude", "projects", "demo", "transcript.jsonl");
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const sessionId = "e2e-tmux-session";
  const env = baseEnv(home);

  function hook(overrides) {
    const payload = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: projectCwd,
      model: { display_name: "Sonnet" },
      ...overrides,
    });
    const result = runCli(["hook"], { input: payload, env, cwd: projectCwd });
    assert.equal(result.status, 0, `hook subprocess failed: ${result.stderr}`);
  }

  // Seed some state before watch even starts, so the first paint has content.
  hook({ hook_event_name: "SessionStart" });
  hook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "tmux-call-1",
    tool_input: { command: "echo seed" },
  });

  // Launch a real tmux session running `ahud watch` as its only command.
  // -x/-y give it a generous, fixed size so capture-pane output is stable.
  // tmux's own env for `new-session` is inherited from this test process, not
  // from `env` (tmux has no such option) — the pane's *command* is what
  // actually needs the isolated env, and node:child_process has no way to
  // set per-pane env through `tmux new-session` directly, so we instead have
  // the pane run through `env -i` to pass an explicitly scoped environment.
  const createResult = tmuxSync([
    "new-session", "-d", "-s", sessionName, "-x", "100", "-y", "20",
    "env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    process.execPath, CLI_PATH, "watch", "--cwd", projectCwd, "--no-color",
  ]);
  t.diagnostic(`tmux new-session stderr: ${JSON.stringify(createResult.stderr)}`);
  sessionCreated = true;

  // Give the watch loop a moment to render its first frame.
  await sleep(700);

  const firstCapture = capturePane(sessionName);
  t.diagnostic(`tmux capture-pane #1 (after seed events, before live update):\n${firstCapture}`);
  assert.match(firstCapture, /Claude/, "expected the Claude platform badge in the live tmux pane");
  assert.match(firstCapture, /Bash/, "expected the seeded Bash tool to show up in the live tmux pane");

  // From OUTSIDE the tmux pane, fire a brand new hook event, simulating "the
  // user is mid-session and another tool call just happened". This is the
  // scenario that proves watch's *event* reads are truly live per-frame, not
  // stuck on a stale first read.
  hook({
    hook_event_name: "PreToolUse",
    tool_name: "Grep",
    tool_use_id: "tmux-call-2",
    tool_input: { command: "grep -R TODO ." },
  });

  // The refresh interval is 350ms; wait for more than one cycle before
  // capturing again so the new frame has definitely been painted.
  await sleep(1000);

  const secondCapture = capturePane(sessionName);
  t.diagnostic(`tmux capture-pane #2 (after live hook event fired from outside the pane):\n${secondCapture}`);
  assert.match(secondCapture, /Grep/, "expected the newly-fired Grep tool to appear in the live tmux pane — watch's event reads must not be stuck/cached");

  // Ctrl-C and confirm the process actually exits.
  const sendCtrlCResult = tmuxSync(["send-keys", "-t", sessionName, "C-c"]);
  t.diagnostic(`tmux send-keys C-c stderr: ${JSON.stringify(sendCtrlCResult.stderr)}`);
  await sleep(500);

  // Best-effort: try to capture the final frame (with escape sequences, so a
  // "show cursor" [?25h can be spotted if it's still in the pane
  // scrollback) before checking whether the pane's process is actually gone.
  const finalCaptureResult = tmuxSync(["capture-pane", "-e", "-p", "-t", sessionName], { allowFailure: true });
  if (finalCaptureResult.status === 0) {
    const finalCapture = finalCaptureResult.stdout;
    t.diagnostic(`tmux capture-pane -e #3 (after Ctrl-C):\n${JSON.stringify(finalCapture)}`);
    if (finalCapture.includes("[?25h")) {
      t.diagnostic("confirmed: cursor-restore escape sequence (\\u001b[?25h) was captured in the pane before it closed.");
    } else {
      t.diagnostic("cursor-restore escape sequence was not visible in the captured scrollback (tmux may have already recycled the pane) — not treated as a failure.");
    }
  } else {
    t.diagnostic(`pane was already gone by the time of the final capture (expected once Ctrl-C fully exits): ${finalCaptureResult.stderr}`);
  }

  const panesResult = tmuxSync(["list-panes", "-t", sessionName, "-F", "#{pane_pid} #{pane_dead}"], { allowFailure: true });
  if (panesResult.status === 0) {
    t.diagnostic(`tmux list-panes after Ctrl-C: ${JSON.stringify(panesResult.stdout.trim())}`);
    // A pane whose command exited stays around as "dead" until the session
    // itself is killed (default tmux behavior for a foreground process
    // exiting) — either way, its pane_dead flag must now be 1, or the
    // session listing must fail entirely, proving watch is not still stuck
    // in its loop.
    assert.match(panesResult.stdout, /\s1\s*$/, `expected the watch pane to be dead after Ctrl-C, got: ${panesResult.stdout}`);
  } else {
    t.diagnostic("tmux list-panes failed — session is gone entirely, which also confirms watch exited.");
  }
});

function capturePane(sessionName) {
  return tmuxSync(["capture-pane", "-p", "-t", sessionName]).stdout;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// D. bare `ahud setup` (no target, no flags) must never hang on stdin
// ---------------------------------------------------------------------------
// This is the critical regression test for the interactive setup wizard
// (src/wizard.mjs, added alongside this test): both host entry points for
// this plugin (Codex CLI and Claude Code) can invoke `ahud setup` as a
// non-interactive LLM-agent tool call, with nobody available to type an
// answer. If the wizard's TTY/CI/timeout guards are ever wrong, this
// subprocess hangs forever instead of exiting.
test("D. bare `ahud setup` with immediately-closed stdin exits promptly instead of hanging on the interactive wizard", { timeout: 15_000 }, async (t) => {
  const home = await mkdtemp("ahud-e2e-wizardhome-");
  const codexHome = await mkdtemp("ahud-e2e-wizardcodex-");
  const claudeConfigDir = await mkdtemp("ahud-e2e-wizardclaude-");
  t.after(() => Promise.all([rmrf(home), rmrf(codexHome), rmrf(claudeConfigDir)]));

  const env = baseEnv(home, { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfigDir });

  // runCli() defaults `input` to "" (an immediate EOF on the child's stdin,
  // exactly like a pipe closed by an agent harness that never writes
  // anything) and separately enforces SUBPROCESS_TIMEOUT_MS (10s) via
  // spawnSync's own `timeout`, throwing a diagnostic error instead of
  // silently hanging this whole suite if the child is ever still alive when
  // that fires. Neither `stdin.isTTY` nor `stdout.isTTY` is true for a
  // spawnSync'd child by construction, so shouldRunWizard() should already
  // refuse to enter the wizard here on TTY grounds alone — but we don't
  // assert on *why* it exited promptly, only that it does; see below.
  const result = runCli(["setup"], { env });

  t.diagnostic(`bare setup (closed stdin) exit status=${result.status} signal=${result.signal}`);
  t.diagnostic(`stdout: ${JSON.stringify(result.stdout)}`);
  t.diagnostic(`stderr: ${JSON.stringify(result.stderr)}`);

  // The critical assertion is simply that the process ran to completion on
  // its own. We intentionally do not hard-assert a specific exit status:
  // depending on how the non-TTY guard lands, this may (a) skip the wizard
  // entirely and run the existing non-interactive `both` default to
  // completion (status 0), or (b) enter some interactive-looking path and
  // then fail fast on EOF/timeout while reading the first question
  // (non-zero status) — both are acceptable outcomes for this regression
  // test. `signal` being non-null would mean spawnSync had to kill it after
  // SUBPROCESS_TIMEOUT_MS, i.e. it hung; that is the only unacceptable case.
  assert.equal(result.signal, null, `process should have exited on its own, not been killed by the spawnSync timeout (signal=${result.signal})`);
});
