import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// legacy-statusline-command.sh was authored and empirically tuned against this
// machine's macOS bash/jq/date/stat behavior only; it has no verified GNU
// coreutils or Git-Bash-on-Windows parity, so these tests are macOS-only.
const skipOffMacos = process.platform === "darwin" ? false : "legacy-statusline-command.sh has no verified non-macOS parity";
const legacyHud = path.join(
  pluginRoot,
  "test",
  "fixtures",
  "legacy-statusline-command.sh",
);
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function visualStyles(value) {
  let tone = "plain";
  let cursor = 0;
  const result = [];
  for (const match of value.matchAll(/\u001b\[([0-9;]*)m/g)) {
    for (const character of value.slice(cursor, match.index)) {
      result.push(`${tone}:${character}`);
    }
    const code = match[1];
    tone = code === "2" ? "dim" :
      code === "97" ? "bright" :
      code === "33" ? "yellow" :
      code === "31" ? "red" : "plain";
    cursor = match.index + match[0].length;
  }
  for (const character of value.slice(cursor)) result.push(`${tone}:${character}`);
  return result;
}

async function prepareHome(root, name, transcript, now) {
  const home = path.join(root, name);
  const claude = path.join(home, ".claude");
  await fs.mkdir(path.join(claude, "context-log"), { recursive: true });
  await fs.mkdir(path.join(claude, "status-cache"), { recursive: true });
  await fs.writeFile(path.join(claude, "context-log", "parity.tsv"), [
    `${now - 20}\t50\t10`,
    `${now - 10}\t70\t15`,
  ].join("\n") + "\n");
  const health = path.join(claude, "status-cache", "anthropic");
  await fs.writeFile(health, "none\n");
  await fs.utimes(health, now, now);
  const transcriptPath = path.join(home, "transcript.jsonl");
  await fs.writeFile(transcriptPath, transcript);
  await fs.utimes(transcriptPath, now - 100, now - 100);
  return { home, transcriptPath };
}

test("matches the authoritative shell HUD for the same full telemetry fixture", { skip: skipOffMacos }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-parity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const now = Math.floor(Date.now() / 1_000);
  const transcript = `${Array.from({ length: 16 }, (_, index) => JSON.stringify({
    type: "assistant",
    message: {
      id: `msg_${index}`,
      usage: index === 15 ? {
        cache_creation_input_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 1 },
      } : {},
    },
  })).join("\n")}\n`;
  const shellFixture = await prepareHome(root, "shell-home", transcript, now);
  const tsFixture = await prepareHome(root, "ts-home", transcript, now);
  const base = {
    session_id: "parity",
    cwd: project,
    workspace: { current_dir: project },
    model: { display_name: "Sonnet 5 (1m context)" },
    effort: "high",
    context_window: {
      used_percentage: 75,
      context_window_size: 1_000_000,
      total_input_tokens: 90_420,
    },
    rate_limits: {
      five_hour: {
        used_percentage: 15.8,
        resets_at: now + 3_600,
      },
      seven_day: {
        used_percentage: 70.2,
        resets_at: now + 2 * 86_400,
      },
    },
    cost: {
      total_cost_usd: 5.32,
      total_lines_added: 128,
      total_lines_removed: 17,
    },
  };

  const run = (command, args, fixture) => spawnSync(command, args, {
    encoding: "utf8",
    input: JSON.stringify({ ...base, transcript_path: fixture.transcriptPath }),
    env: {
      ...process.env,
      HOME: fixture.home,
      AGENT_HUD_DATA_DIR: path.join(fixture.home, ".agent-hud"),
      COLUMNS: "160",
      NO_COLOR: "",
    },
  });
  const legacy = run("bash", [legacyHud], shellFixture);
  const current = run(
    process.execPath,
    [path.join(pluginRoot, "dist", "cli.js"), "statusline"],
    tsFixture,
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(
    current.stdout.replace(ANSI_RE, ""),
    legacy.stdout.replace(ANSI_RE, ""),
  );
  assert.deepEqual(
    visualStyles(current.stdout),
    visualStyles(legacy.stdout),
    "visible characters must carry the same dim/bright/yellow/red semantics",
  );
});

test("matches partial reset-only telemetry, numeric strings, and generic model suffixes", { skip: skipOffMacos }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-partial-parity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const now = Math.floor(Date.now() / 1_000);
  const shellFixture = await prepareHome(root, "shell-home", "", now);
  const tsFixture = await prepareHome(root, "ts-home", "", now);
  const inputFor = (fixture) => ({
    session_id: "partial",
    transcript_path: fixture.transcriptPath,
    cwd: project,
    model: { display_name: "Claude Opus 4.5 (Preview)" },
    rate_limits: {
      five_hour: { resets_at: String(now + 3_600) },
      seven_day: { resets_at: String(now + 2 * 86_400) },
    },
  });
  const run = (command, args, fixture) => spawnSync(command, args, {
    encoding: "utf8",
    input: JSON.stringify(inputFor(fixture)),
    env: {
      ...process.env,
      HOME: fixture.home,
      AGENT_HUD_DATA_DIR: path.join(fixture.home, ".agent-hud"),
      COLUMNS: "59",
      NO_COLOR: "",
    },
  });
  const legacy = run("bash", [legacyHud], shellFixture);
  const current = run(
    process.execPath,
    [path.join(pluginRoot, "dist", "cli.js"), "statusline"],
    tsFixture,
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.stdout.replace(ANSI_RE, ""), legacy.stdout.replace(ANSI_RE, ""));
  assert.deepEqual(visualStyles(current.stdout), visualStyles(legacy.stdout));
});

test("matches the shell HUD Git branch spacer, dirty marker, and churn styling", { skip: skipOffMacos }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-git-parity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  await fs.mkdir(project);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Agent HUD test");
  git("config", "user.email", "agent-hud@example.invalid");
  await fs.writeFile(path.join(project, "tracked.txt"), "first\n");
  git("add", "tracked.txt");
  git("commit", "-q", "-m", "fixture");
  await fs.appendFile(path.join(project, "tracked.txt"), "second\n");

  const now = Math.floor(Date.now() / 1_000);
  const shellFixture = await prepareHome(root, "shell-home", "", now);
  const tsFixture = await prepareHome(root, "ts-home", "", now);
  const inputFor = (fixture) => ({
    session_id: "git-parity",
    transcript_path: fixture.transcriptPath,
    cwd: project,
    workspace: { current_dir: project },
    model: { display_name: "Sonnet 5" },
    cost: { total_lines_added: 1, total_lines_removed: 0 },
  });
  const run = (command, args, fixture) => spawnSync(command, args, {
    encoding: "utf8",
    input: JSON.stringify(inputFor(fixture)),
    env: {
      ...process.env,
      HOME: fixture.home,
      AGENT_HUD_DATA_DIR: path.join(fixture.home, ".agent-hud"),
      COLUMNS: "160",
      NO_COLOR: "",
    },
  });
  const legacy = run("bash", [legacyHud], shellFixture);
  const current = run(
    process.execPath,
    [path.join(pluginRoot, "dist", "cli.js"), "statusline"],
    tsFixture,
  );

  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(current.status, 0, current.stderr);
  assert.match(legacy.stdout.replace(ANSI_RE, ""), /project \|  main\* \| \+1\/-0/);
  assert.equal(current.stdout.replace(ANSI_RE, ""), legacy.stdout.replace(ANSI_RE, ""));
  assert.deepEqual(visualStyles(current.stdout), visualStyles(legacy.stdout));
});
