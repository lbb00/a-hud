import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("runs when invoked through a symlinked plugin path", async (t) => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-"));
  const linkedRoot = path.join(root, "ahud");
  await fs.symlink(pluginRoot, linkedRoot, "dir");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [path.join(linkedRoot, "src", "cli.mjs"), "demo"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[Codex · gpt-5\.6-sol · high\]/);
});

// ---------------------------------------------------------------------------
// Phase 1: per-command switch gating driven by ~/.ahud/config.json.
//
// These spawn a real `node src/cli.mjs <command>` subprocess (rather than
// calling main() in-process) because hook/statusline read real stdin via
// io.mjs's readJsonStdin(process.stdin), which isn't easily mockable
// in-process. HOME is overridden per-subprocess so os.homedir() (and thus
// the eventual `loadConfig()` call inside cli.mjs, called with no args) is
// pinned to an isolated temp dir — never the real ~/.ahud.
// ---------------------------------------------------------------------------

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

async function writeAhudConfig(home, config) {
  const dir = path.join(home, ".ahud");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(config));
}

async function writeAhudAdapter(home, content) {
  const dir = path.join(home, ".ahud");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "adapter.mjs"), content, "utf8");
}

function runCli(args, { input, env }) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    input,
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
}

async function listEvents(home) {
  return fs.readdir(path.join(home, ".ahud", "events")).catch(() => []);
}

test("hook: baseline sanity — with no ~/.ahud/config.json (default enabled), the event IS recorded", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-hook-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const payload = JSON.stringify({
    session_id: "s-baseline",
    hook_event_name: "SessionStart",
    transcript_path: "/x/.claude/session.jsonl",
  });

  const result = runCli(["hook"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}\n");
  assert.equal((await listEvents(home)).length, 1);
});

test("hook: enabled:false skips recording but still exits 0 with the standard {} ack", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-hook-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { enabled: false });
  const payload = JSON.stringify({
    session_id: "s1",
    hook_event_name: "SessionStart",
    transcript_path: "/x/.claude/session.jsonl",
  });

  const result = runCli(["hook"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}\n");
  assert.deepEqual(await listEvents(home), []);
});

test("hook: platforms.claude:false skips recording a Claude-detected event while leaving the ack unchanged", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-hook-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { platforms: { claude: false } });
  const payload = JSON.stringify({
    session_id: "s2",
    hook_event_name: "SessionStart",
    transcript_path: "/x/.claude/session.jsonl",
  });

  const result = runCli(["hook"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}\n");
  assert.deepEqual(await listEvents(home), []);
});

test("hook: platforms.codex:false skips recording a Codex-detected event while leaving the ack unchanged", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-hook-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { platforms: { codex: false } });
  const payload = JSON.stringify({
    session_id: "s3",
    hook_event_name: "SessionStart",
    transcript_path: "/x/.codex/session.jsonl",
  });

  const result = runCli(["hook"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}\n");
  assert.deepEqual(await listEvents(home), []);
});

test("statusline: enabled:false produces zero stdout bytes and exits 0", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-statusline-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { enabled: false });
  const payload = JSON.stringify({
    session_id: "s1",
    model: { display_name: "Sonnet" },
    workspace: { current_dir: home },
  });

  const result = runCli(["statusline"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("statusline: platforms.claude:false produces zero stdout bytes and exits 0", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-statusline-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { platforms: { claude: false } });
  const payload = JSON.stringify({
    session_id: "s1",
    model: { display_name: "Sonnet" },
    workspace: { current_dir: home },
  });

  const result = runCli(["statusline"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("watch --once: enabled:false produces zero stdout bytes and exits 0", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-watch-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { enabled: false });

  const result = runCli(["watch", "--once"], { input: "", env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("watch --once: platform-level gating does NOT apply — platforms.codex/claude:false alone must not blank the output", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-watch-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { platforms: { codex: false, claude: false } });

  const result = runCli(["watch", "--once"], { input: "", env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout, "", "watch --once has no platform-level gating by design (only the global enabled switch applies)");
});

test("watch --once: NO_COLOR alone (without --no-color) disables ANSI colors (regression)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-watch-nocolor-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["watch", "--once"], { input: "", env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\[/);
});

test("watch --once: NO_COLOR=\'\' (present but empty) still disables ANSI colors per the NO_COLOR spec (regression)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-watch-nocolor-empty-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["watch", "--once"], { input: "", env: { ...process.env, HOME: home, NO_COLOR: "" } });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\[/);
});

// ---------------------------------------------------------------------------
// setup: bare flags (no explicit claude/codex/both target word) must not be
// mistaken for the target — regression for `ahud setup --dry-run` throwing
// "setup target must be claude, codex, or both".
// ---------------------------------------------------------------------------

test("setup --dry-run (no target word): defaults to both instead of erroring on '--dry-run' as an unknown target", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "--dry-run"], {
    input: "",
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, NO_COLOR: "1" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--- Claude:/);
  assert.match(result.stdout, /--- Codex:/);
});

test("setup both --config PATH: rejected with a clear error instead of writing Claude JSON into a Codex TOML file (or vice versa)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-both-config-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "both", "--config", path.join(home, "shared.toml"), "--dry-run"], {
    input: "",
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config requires a single target/);
});

// ---------------------------------------------------------------------------
// Dangling-adapter-promise robustness: an adapter's timeout (see
// adapter.mjs's withTimeout) only makes the *wrapper* promise settle — the
// underlying render() call keeps running. A setTimeout an adapter leaves
// pending after render() returns keeps Node's event loop non-empty, which
// would otherwise hold statusline/watch --once open long after their output
// is already written. cli.mjs now force-exits after writing output on these
// paths specifically to guard against this.
// ---------------------------------------------------------------------------

const DANGLING_ADAPTER = [
  "export function render(snapshot, context) {",
  "  // Deliberately never cleared: simulates a leaked timer inside a user",
  "  // adapter. Far longer than any reasonable test timeout, so the only way",
  "  // these tests pass is if the CLI force-exits instead of waiting it out.",
  "  setTimeout(() => {}, 5000);",
  "  return 'dangling-adapter-output';",
  "}",
].join("\n");

test("statusline: a dangling setTimeout left running inside an adapter's render() does not keep the process alive", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-dangling-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudAdapter(home, DANGLING_ADAPTER);
  const payload = JSON.stringify({
    session_id: "s-dangling",
    model: { display_name: "Sonnet" },
    workspace: { current_dir: home },
  });

  const start = Date.now();
  const result = runCli(["statusline"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });
  const elapsed = Date.now() - start;

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dangling-adapter-output/);
  assert.ok(elapsed < 2000, `expected the process to exit well before the adapter's 5000ms dangling timer, took ${elapsed}ms`);
});

test("watch --once: a dangling setTimeout left running inside an adapter's render() does not keep the process alive", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-dangling-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudAdapter(home, DANGLING_ADAPTER);

  const start = Date.now();
  const result = runCli(["watch", "--once"], { input: "", env: { ...process.env, HOME: home, NO_COLOR: "1" } });
  const elapsed = Date.now() - start;

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dangling-adapter-output/);
  assert.ok(elapsed < 2000, `expected the process to exit well before the adapter's 5000ms dangling timer, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Config warnings surfaced to stderr: only on `watch`, the human-facing
// path. `hook`/`statusline` are host-invoked and must stay silent.
// ---------------------------------------------------------------------------

test("watch --once: a malformed config.json prints a warning to stderr", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-warn-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { enabled: "not-a-boolean" });

  const result = runCli(["watch", "--once"], { input: "", env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /ahud: warning:.*"enabled"/);
});

test("hook: a malformed config.json prints nothing to stderr (host-invoked path stays silent)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-warn-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { enabled: "not-a-boolean" });
  const payload = JSON.stringify({
    session_id: "s-warn",
    hook_event_name: "SessionStart",
    transcript_path: "/x/.claude/session.jsonl",
  });

  const result = runCli(["hook"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("statusline: a malformed config.json prints nothing to stderr (host-invoked path stays silent)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-warn-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeAhudConfig(home, { enabled: "not-a-boolean" });
  const payload = JSON.stringify({
    session_id: "s-warn",
    model: { display_name: "Sonnet" },
    workspace: { current_dir: home },
  });

  const result = runCli(["statusline"], { input: payload, env: { ...process.env, HOME: home, NO_COLOR: "1" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

// ---------------------------------------------------------------------------
// setup: target/flag parsing (parseSetupArgs in cli.mjs).
//
// Every scenario here uses --dry-run (or an error path that throws before
// any write happens) plus an isolated HOME, so nothing here ever touches a
// real ~/.codex or ~/.claude file.
// ---------------------------------------------------------------------------

function setupEnv(home) {
  return { ...process.env, HOME: home, NO_COLOR: "1" };
}

test("setup: an invalid non-flag target word errors instead of silently defaulting to 'both' (--dry-run)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "claud", "--dry-run"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown setup target: "claud"/);
});

test("setup: an invalid non-flag target word errors even without --dry-run (and writes nothing)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "claud"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown setup target: "claud"/);
  await assert.rejects(fs.access(path.join(home, ".codex", "config.toml")));
  await assert.rejects(fs.access(path.join(home, ".claude", "settings.json")));
});

test("setup: a flag placed before the target word still finds the target instead of silently defaulting to 'both'", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "--preset", "compact", "codex", "--dry-run"], { input: "", env: setupEnv(home) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--- Codex:/);
  assert.doesNotMatch(result.stdout, /--- Claude:/);
});

test("setup: --preset=VALUE inline form is honored (previously silently ignored, falling back to 'balanced')", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "codex", "--preset=compact", "--dry-run"], { input: "", env: setupEnv(home) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status_line = \["model-with-reasoning", "context-used", "five-hour-limit", "git-branch", "branch-changes"\]/);
});

test("setup: --config immediately followed by another recognized flag treats the value as missing, not swallowing the flag as a path", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  // Regression check: the old bug wrote a file literally named "--preset"
  // (resolved against the CLI's cwd) instead of erroring. Run from `home`
  // as cwd so we can assert no such file was created there.
  const result = spawnSync(process.execPath, [CLI_PATH, "setup", "claude", "--config", "--preset", "compact"], {
    input: "",
    encoding: "utf8",
    env: setupEnv(home),
    cwd: home,
    timeout: 10_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config requires a value/);
  await assert.rejects(fs.access(path.join(home, "--preset")));
});

test("setup: --config with no following token at all errors instead of proceeding with no path", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "both", "--config"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config requires a value/);
});

test("setup: --config with an explicit empty string value errors", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "claude", "--config", ""], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config requires a value/);
});

test("setup: --config=EMPTY (inline form, empty value) errors the same way as the two-token form", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "claude", "--config="], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config requires a value/);
});

test("setup: --preset requires a value still errors when nothing follows (regression)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "codex", "--preset"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--preset requires a value/);
});

test("setup: --preset immediately followed by another flag treats the value as missing rather than swallowing the flag", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "claude", "--preset", "--dry-run"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--preset requires a value/);
});

test("setup: an unrecognized --flag errors clearly rather than being treated as or searched for a target", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "codex", "--bogus"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown setup flag: "--bogus"/);
});

test("setup: --config combined with target 'both' still errors (a --config path is ambiguous across two hosts)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "both", "--config", path.join(home, "custom.toml")], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config requires a single target/);
});

test("setup: bare target words (claude/codex/both) with --dry-run still work identically", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  for (const target of ["claude", "codex", "both"]) {
    const result = runCli(["setup", target, "--dry-run"], { input: "", env: setupEnv(home) });
    assert.equal(result.status, 0, `${target}: ${result.stderr}`);
  }
});

test("setup: --preset with a real value and --config with a single target still work together, with a real (non-dry-run) write", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const customConfig = path.join(home, "custom-config.toml");

  const result = runCli(["setup", "codex", "--preset", "compact", "--config", customConfig], { input: "", env: setupEnv(home) });

  assert.equal(result.status, 0, result.stderr);
  const written = await fs.readFile(customConfig, "utf8");
  assert.match(written, /status_line = \["model-with-reasoning", "context-used", "five-hour-limit", "git-branch", "branch-changes"\]/);
});

// ---------------------------------------------------------------------------
// --version and unknown-command exit code.
// ---------------------------------------------------------------------------

test("--version prints the version from package.json and exits 0", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-version-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const pkg = JSON.parse(await fs.readFile(path.resolve(path.dirname(CLI_PATH), "..", "package.json"), "utf8"));

  const result = runCli(["--version"], { input: "", env: { ...process.env, HOME: home } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("-v is a shorthand for --version", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-version-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const pkg = JSON.parse(await fs.readFile(path.resolve(path.dirname(CLI_PATH), "..", "package.json"), "utf8"));

  const result = runCli(["-v"], { input: "", env: { ...process.env, HOME: home } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("an unrecognized command prints help and exits nonzero (regression — previously exited 0)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-unknown-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["totally-not-a-command"], { input: "", env: { ...process.env, HOME: home } });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("bare invocation (no args) prints help and exits 0", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-bare-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli([], { input: "", env: { ...process.env, HOME: home } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test("explicit `ahud help` prints help and exits 0", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-help-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["help"], { input: "", env: { ...process.env, HOME: home } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

// ---------------------------------------------------------------------------
// Round-3 adversarial review regressions: extra positional targets, and
// `setup both`'s dispatch order/partial-mutation behavior.
// ---------------------------------------------------------------------------

test("setup: a second positional token errors instead of being silently dropped", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-extra-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "codex", "claude", "--dry-run"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected extra argument: "claude"/);
});

test("setup: a second positional token that's a typo also errors, not just a valid-but-extra target", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-extra-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "codex", "claud", "--dry-run"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected extra argument: "claud"/);
});

test("setup both: dispatches claude before codex, so a malformed Claude settings.json fails before Codex's config.toml is ever touched (regression)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-setup-both-order-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const claudeDir = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex-home");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, "settings.json"), "{ not valid json");

  const result = runCli(["setup", "both"], {
    input: "",
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, NO_COLOR: "1" },
  });

  assert.notEqual(result.status, 0);
  await assert.rejects(
    fs.access(path.join(codexHome, "config.toml")),
    "codex's config.toml must not have been written when claude (processed first) already failed",
  );
});

// ---------------------------------------------------------------------------
// Round-4 adversarial review regressions: --preset validated up front
// (target-applicability and unknown-preset-name), instead of being silently
// ignored for claude or discovered mid-way through a `both` dispatch.
// ---------------------------------------------------------------------------

test("setup: --preset with target claude errors instead of being silently ignored", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-preset-claude-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "claude", "--preset", "compact", "--dry-run"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--preset only applies to codex/);
});

test("setup: an unknown --preset name errors up front, before any host is written (target codex)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-preset-unknown-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = runCli(["setup", "codex", "--preset", "garbage"], { input: "", env: setupEnv(home) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown Codex preset: "garbage"/);
  await assert.rejects(fs.access(path.join(home, ".codex-home", "config.toml")));
});

test("setup both: an unknown --preset name errors before claude's config is ever written (regression)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-cli-preset-both-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const claudeDir = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex-home");

  const result = runCli(["setup", "both", "--preset", "garbage"], {
    input: "",
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, NO_COLOR: "1" },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown Codex preset: "garbage"/);
  await assert.rejects(
    fs.access(path.join(claudeDir, "settings.json")),
    "claude's settings.json must not have been written when the preset name is invalid",
  );
});
