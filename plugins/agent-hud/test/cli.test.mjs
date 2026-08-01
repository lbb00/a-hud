import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GitRefreshCache,
  resolveRenderWidth,
  withHiddenCursor,
} from "../dist/cli.js";

test("refreshes expensive Git facts on a slow cadence and on cwd changes", () => {
  let now = 1_000;
  const reads = [];
  const cache = new GitRefreshCache(
    (cwd) => {
      reads.push(cwd);
      return {
        branch: path.basename(cwd),
        detached: false,
        dirty: false,
        ahead: 0,
        behind: 0,
      };
    },
    () => now,
    5_000,
  );

  assert.equal(cache.get("/workspace/one").branch, "one");
  now += 4_999;
  assert.equal(cache.get("/workspace/one").branch, "one");
  assert.deepEqual(reads, ["/workspace/one"]);

  assert.equal(cache.get("/workspace/two").branch, "two");
  now += 5_000;
  assert.equal(cache.get("/workspace/two").branch, "two");
  assert.deepEqual(reads, [
    "/workspace/one",
    "/workspace/two",
    "/workspace/two",
  ]);
});

test("runs when invoked through a symlinked plugin path", async (t) => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-cli-"));
  const linkedRoot = path.join(root, "agent-hud");
  await fs.symlink(pluginRoot, linkedRoot, "dir");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [path.join(linkedRoot, "dist", "cli.js"), "demo"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^gpt-5\.6-sol \| H \| 90k\/45% 26t/);
  assert.match(result.stdout, /#11%/);
  assert.doesNotMatch(result.stdout, /#\d+%\/\d+%/);
});

test("prefers explicit width, then live TTY columns, then environment", () => {
  const previous = process.env.COLUMNS;
  process.env.COLUMNS = "72";
  try {
    assert.equal(resolveRenderWidth(["--width", "41"], 90), 41);
    assert.equal(resolveRenderWidth([], 90), 90);
    assert.equal(resolveRenderWidth([], undefined), 72);
  } finally {
    if (previous === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = previous;
  }
});

test("restores the cursor when interactive rendering throws", async () => {
  let output = "";
  await assert.rejects(
    withHiddenCursor(
      (value) => {
        output += value;
      },
      async () => {
        throw new Error("render failed");
      },
    ),
    /render failed/,
  );
  assert.equal(output, "\u001b[?25l\u001b[?25h\n");
});

test("records a Codex hook event through the compiled CLI", async (t) => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-hook-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [path.join(pluginRoot, "dist", "cli.js"), "hook"], {
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "codex-test",
      cwd: "/workspace/demo",
      transcript_path: "/tmp/.codex/session.jsonl",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-test",
      turn_id: "turn-1",
    }),
    env: {
      ...process.env,
      AGENT_HUD_DATA_DIR: dataRoot,
      PLUGIN_ROOT: pluginRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}\n");
  const eventFiles = (await fs.readdir(path.join(dataRoot, "events")))
    .filter((name) => /^[a-f0-9]{24}\.jsonl$/.test(name));
  assert.equal(eventFiles.length, 1);
  const event = JSON.parse(
    (await fs.readFile(path.join(dataRoot, "events", eventFiles[0]), "utf8")).trim(),
  );
  assert.equal(event.platform, "codex");
  assert.equal(event.type, "UserPromptSubmit");
});

test("prints a machine-readable normalized snapshot", async (t) => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-json-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    path.join(pluginRoot, "dist", "cli.js"),
    "watch",
    "--once",
    "--json",
    "--cwd",
    "/workspace/demo",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_HUD_DATA_DIR: dataRoot,
      NO_COLOR: "1",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.cwd, "/workspace/demo");
  assert.equal(snapshot.platform, "agent");
  assert.deepEqual(snapshot.tools, []);
  assert.deepEqual(snapshot.agents, []);
});

test("honors NO_COLOR in companion snapshots", async (t) => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-no-color-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    path.join(pluginRoot, "dist", "cli.js"),
    "watch",
    "--once",
    "--width",
    "40",
    "--cwd",
    "/workspace/demo",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_HUD_DATA_DIR: dataRoot,
      NO_COLOR: "1",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\u001b/);
});

test("keeps the Claude statusline visible when its home is read-only", () => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "dist", "cli.js"), "statusline"],
    {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "read-only-home",
        cwd: "/tmp",
        model: { display_name: "Claude" },
      }),
      env: {
        ...process.env,
        HOME: "/dev/null",
        NO_COLOR: "1",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Claude/);
});

test("renders Cursor and Antigravity through the shared statusline entrypoint", async (t) => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-host-lines-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const run = (input) => spawnSync(
    process.execPath,
    [path.join(pluginRoot, "dist", "cli.js"), "statusline"],
    {
      encoding: "utf8",
      input: JSON.stringify(input),
      env: { ...process.env, AGENT_HUD_DATA_DIR: dataRoot, NO_COLOR: "1" },
    },
  );

  const cursor = run({
    session_id: "cursor-line",
    cwd: "/workspace/cursor-demo",
    autorun: true,
    render_width_chars: 100,
    model: {
      id: "grok-4.5",
      display_name: "Cursor Grok 4.5",
      param_summary: "effort=high",
    },
    context_window: {
      total_input_tokens: 90_000,
      context_window_size: 200_000,
      used_percentage: 45,
    },
  });
  assert.equal(cursor.status, 0, cursor.stderr);
  assert.match(cursor.stdout, /^Cursor Grok 4\.5 \| H \| 90k\/45%/);
  assert.match(cursor.stdout, /cursor-demo/);

  const antigravity = run({
    product: "antigravity",
    session_id: "agy-line",
    conversation_id: "agy-line",
    cwd: "/workspace/agy-demo",
    terminal_width: 100,
    model: { display_name: "Gemini 3.5 Flash (High)" },
    context_window: {
      total_input_tokens: 88_244,
      context_window_size: 1_048_576,
      used_percentage: 14.24,
    },
    quota: {
      "gemini-weekly": { remaining_fraction: 0.9378 },
    },
    agent_state: "idle",
    vcs: { type: "git", branch: "main", dirty: true },
  });
  assert.equal(antigravity.status, 0, antigravity.stderr);
  assert.match(antigravity.stdout, /^Gemini 3\.5 Flash \| H \| 88k\/14% \| #6%/);
  assert.match(antigravity.stdout, /agy-demo \|  main\*/);
});

test("returns neutral Antigravity hook decisions without changing permissions", async (t) => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-agy-hook-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    path.join(pluginRoot, "dist", "cli.js"),
    "hook",
    "--platform",
    "antigravity",
    "--event",
    "PreToolUse",
  ], {
    encoding: "utf8",
    input: JSON.stringify({
      conversationId: "agy-hook",
      workspacePaths: ["/workspace/agy"],
      stepIdx: 3,
      toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
    }),
    env: { ...process.env, AGENT_HUD_DATA_DIR: dataRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { decision: "" });
});
