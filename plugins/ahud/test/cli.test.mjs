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
