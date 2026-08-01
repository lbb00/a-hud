import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { foldEvents, loadState, normalizeHookEvent, recordHook } from "../dist/index.js";

test("folds shared tool, agent, and plan hook events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const options = { dataDir: root, env: { PLUGIN_ROOT: "/plugin" }, now: () => now++ };
  const base = {
    session_id: "thr_test",
    cwd: "/workspace/demo",
    transcript_path: "/tmp/session.jsonl",
    model: "gpt-test",
  };

  await recordHook({ ...base, hook_event_name: "SessionStart" }, options);
  await recordHook({
    ...base,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_use_id: "tool_1",
    tool_input: { command: "*** Begin Patch" },
  }, options);
  await recordHook({
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "update_plan",
    tool_use_id: "tool_2",
    tool_input: { plan: [
      { step: "Build HUD", status: "in_progress" },
      { step: "Test HUD", status: "pending" },
    ] },
  }, options);
  await recordHook({
    ...base,
    hook_event_name: "SubagentStart",
    agent_id: "agent_1",
    agent_type: "reviewer",
  }, options);

  const state = await loadState({ sessionId: "thr_test" }, { dataDir: root, now: () => 2_000 });
  assert.equal(state.platform, "codex");
  assert.equal(state.model, "gpt-test");
  assert.equal(state.tools.find((tool) => tool.id === "tool_1").status, "running");
  assert.equal(state.agents[0].type, "reviewer");
  assert.equal(state.plan[0].text, "Build HUD");
  assert.equal(state.status, "working");
});

test("matches a session cwd through a symlink instead of using an unrelated fallback", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-symlink-"));
  const dataDir = path.join(root, "events");
  const realProject = path.join(root, "real-project");
  const linkedProject = path.join(root, "linked-project");
  await fs.mkdir(realProject);
  await fs.symlink(realProject, linkedProject, "dir");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await recordHook({
    session_id: "target",
    cwd: realProject,
    hook_event_name: "SessionStart",
    model: "target-model",
  }, { dataDir, now: () => 1_000 });
  await recordHook({
    session_id: "newer-but-unrelated",
    cwd: path.join(root, "other-project"),
    hook_event_name: "SessionStart",
    model: "wrong-model",
  }, { dataDir, now: () => 2_000 });

  const state = await loadState({ cwd: linkedProject }, { dataDir, now: () => 3_000 });
  assert.equal(state.model, "target-model");
  assert.equal(state.cwd, realProject);
});

test("detects Codex when only the compatibility root and a Codex transcript are present", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-codex-hook-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await recordHook({
    session_id: "codex-compat",
    transcript_path: "/tmp/.codex/session.jsonl",
    hook_event_name: "SessionStart",
  }, {
    dataDir: root,
    env: { CLAUDE_PLUGIN_ROOT: "/plugin" },
    now: () => 1_000,
  });
  const state = await loadState({ sessionId: "codex-compat" }, { dataDir: root });
  assert.equal(state.platform, "codex");
});

test("maps structural Codex PostToolUse failures without guessing from output text", () => {
  const base = {
    hook_event_name: "PostToolUse",
    tool_name: "exec_command",
    tool_use_id: "tool_failure",
  };
  const failed = normalizeHookEvent({
    ...base,
    tool_response: { metadata: { exit_code: 7 } },
  }, { PLUGIN_ROOT: "/plugin" }, 1_000);
  const completed = normalizeHookEvent({
    ...base,
    tool_response: { output: "the word failed is ordinary output", exit_code: 0 },
  }, { PLUGIN_ROOT: "/plugin" }, 1_001);
  const explicit = normalizeHookEvent({
    ...base,
    tool_name: "fetch_record",
    tool_response: { data: { status: "failed", success: false } },
  }, { PLUGIN_ROOT: "/plugin" }, 1_002);
  const stringExit = normalizeHookEvent({
    ...base,
    tool_response: { exitCode: "2" },
  }, { PLUGIN_ROOT: "/plugin" }, 1_003);

  assert.equal(failed.tool.status, "error");
  assert.equal(completed.tool.status, "completed");
  assert.equal(explicit.tool.status, "completed");
  assert.equal(stringExit.tool.status, "error");
});

test("normalizes Cursor camelCase hooks into the shared event model", () => {
  const event = normalizeHookEvent({
    hook_event_name: "preToolUse",
    conversation_id: "cursor-chat",
    generation_id: "cursor-turn",
    cursor_version: "2026.07.23",
    workspace_roots: ["/workspace/cursor"],
    transcript_path: "/tmp/.cursor/chat.jsonl",
    model: "grok-4.5",
    tool_name: "Shell",
    tool_use_id: "cursor-tool",
    tool_input: { command: "npm test" },
  }, {}, 1_000);
  assert.equal(event.platform, "cursor");
  assert.equal(event.type, "PreToolUse");
  assert.equal(event.sessionId, "cursor-chat");
  assert.equal(event.turnId, "cursor-turn");
  assert.equal(event.cwd, "/workspace/cursor");
  assert.deepEqual(event.tool, {
    id: "cursor-tool",
    name: "Shell",
    target: "npm",
    status: "running",
  });
});

test("pairs Antigravity tool hooks by step and preserves the pre-tool name", () => {
  const pre = normalizeHookEvent({
    conversationId: "agy-chat",
    workspacePaths: ["/workspace/agy"],
    transcriptPath: "/tmp/.gemini/antigravity-cli/chat.jsonl",
    stepIdx: 7,
    toolCall: {
      name: "run_command",
      args: { CommandLine: "npm test", Cwd: "/workspace/agy" },
    },
  }, {}, 1_000, { platform: "antigravity", event: "PreToolUse" });
  const post = normalizeHookEvent({
    conversationId: "agy-chat",
    workspacePaths: ["/workspace/agy"],
    transcriptPath: "/tmp/.gemini/antigravity-cli/chat.jsonl",
    stepIdx: 7,
    error: "exit status 1",
  }, {}, 2_000, { platform: "antigravity", event: "PostToolUse" });
  const state = foldEvents([pre, post], 2_001);
  assert.equal(pre.tool.id, "step:7");
  assert.equal(pre.tool.name, "run_command");
  assert.equal(post.type, "PostToolUseFailure");
  assert.equal(state.tools[0].name, "run_command");
  assert.equal(state.tools[0].status, "error");
  assert.equal(state.platform, "antigravity");
});

test("scopes cwd fallback state to the requested host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-host-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await recordHook({
    session_id: "codex-same-cwd",
    cwd: "/workspace/shared",
    hook_event_name: "UserPromptSubmit",
    turn_id: "codex-turn",
  }, { dataDir: root, platform: "codex", now: () => 1_000 });

  const cursor = await loadState({
    sessionId: "cursor-missing",
    cwd: "/workspace/shared",
    platform: "cursor",
  }, { dataDir: root, now: () => 2_000 });
  assert.equal(cursor.platform, "cursor");
  assert.equal(cursor.turns, 0);
  assert.deepEqual(cursor.tools, []);
});

test("preserves a long hook cwd and its significant spaces for UI tail clipping", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-long-cwd-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const longCwd = `/workspace/${"wide section  ".repeat(40)}useful tail`;
  await recordHook({
    session_id: "long-path",
    cwd: longCwd,
    transcript_path: `${longCwd}/session.jsonl`,
    hook_event_name: "SessionStart",
  }, { dataDir: root, now: () => 1_000 });

  const state = await loadState({ sessionId: "long-path" }, { dataDir: root });
  assert.equal(state.cwd, longCwd);
  assert.equal(state.transcriptPath, `${longCwd}/session.jsonl`);
  assert.ok(state.cwd.length > 320);
});

test("event maintenance repairs permissions and removes stale sessions", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode assertion");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-event-hygiene-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stale = path.join(root, "000000000000000000000000.jsonl");
  await fs.writeFile(stale, "{}\n", { mode: 0o644 });
  const old = Date.now() / 1_000 - 31 * 24 * 60 * 60;
  await fs.utimes(stale, old, old);
  await fs.chmod(root, 0o755);

  const { filePath } = await recordHook({
    session_id: "active-session",
    hook_event_name: "SessionStart",
  }, { dataDir: root });

  await assert.rejects(fs.stat(stale), { code: "ENOENT" });
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.ok((await fs.readFile(filePath, "utf8")).includes("active-session"));
});

test("normalizes only exact running background task facts from Stop payloads", () => {
  const stop = (backgroundTasks) => normalizeHookEvent({
    hook_event_name: "Stop",
    ...(backgroundTasks === undefined ? {} : { background_tasks: backgroundTasks }),
  }, { CLAUDE_PLUGIN_ROOT: "/plugin" }, 1_000);

  assert.equal(stop(undefined).backgroundTasksRunning, false);
  assert.equal(stop([]).backgroundTasksRunning, false);
  assert.equal(stop([{ status: "completed" }]).backgroundTasksRunning, false);
  assert.equal(stop([{ status: "running" }]).backgroundTasksRunning, true);
  assert.equal(stop([{ status: "completed" }, { status: "running" }]).backgroundTasksRunning, true);

  for (const malformed of [
    null,
    "running",
    { status: "running" },
    [{ status: "RUNNING" }],
    [{ nested: { status: "running" } }],
    [null, "running", ["running"]],
  ]) {
    assert.equal(stop(malformed).backgroundTasksRunning, false);
  }

  const accessorTask = {};
  Object.defineProperty(accessorTask, "status", {
    get() {
      throw new Error("must not execute hook payload accessors");
    },
  });
  assert.equal(stop([accessorTask]).backgroundTasksRunning, false);

  const accessorPayload = { hook_event_name: "Stop" };
  Object.defineProperty(accessorPayload, "background_tasks", {
    get() {
      throw new Error("must not execute hook payload accessors");
    },
  });
  assert.equal(
    normalizeHookEvent(accessorPayload, { CLAUDE_PLUGIN_ROOT: "/plugin" }, 1_000)
      .backgroundTasksRunning,
    false,
  );
});

test("keeps a Stop working only while a reported background task is running", () => {
  const base = {
    v: 1,
    sessionId: "background",
    platform: "claude",
    cwd: "",
    transcriptPath: "",
    model: "",
    turnId: "",
  };
  const running = foldEvents([
    { ...base, at: 1_000, type: "SessionStart" },
    { ...base, at: 2_000, type: "Stop", backgroundTasksRunning: true },
  ], 3_000);
  assert.equal(running.status, "working");

  const completed = foldEvents([
    { ...base, at: 1_000, type: "SessionStart" },
    { ...base, at: 2_000, type: "Stop", backgroundTasksRunning: true },
    { ...base, at: 3_000, type: "Stop", backgroundTasksRunning: false },
  ], 4_000);
  assert.equal(completed.status, "idle");
});

test("running tools and subagents beat Stop, but not a later SessionEnd", () => {
  const base = {
    v: 1,
    sessionId: "precedence",
    platform: "claude",
    cwd: "",
    transcriptPath: "",
    model: "",
    turnId: "",
  };
  const activeEvents = [
    {
      ...base,
      at: 1_000,
      type: "PreToolUse",
      tool: { id: "tool_1", name: "Bash", status: "running" },
    },
    {
      ...base,
      at: 1_100,
      type: "SubagentStart",
      agent: { id: "agent_1", type: "reviewer", status: "running" },
    },
    { ...base, at: 1_200, type: "Stop", backgroundTasksRunning: false },
  ];

  assert.equal(foldEvents(activeEvents, 2_000).status, "working");
  const ended = foldEvents([
    ...activeEvents,
    { ...base, at: 1_300, type: "SessionEnd" },
  ], 2_000);
  assert.equal(ended.status, "idle");
  assert.equal(ended.tools.some((tool) => tool.status === "running"), false);
  assert.equal(ended.agents.some((agent) => agent.status === "running"), false);
});

test("keeps hour-long activity until a real lifecycle boundary", () => {
  const base = {
    v: 1,
    sessionId: "long-running",
    platform: "claude",
    cwd: "",
    transcriptPath: "",
    model: "",
    turnId: "",
  };
  const events = [
    { ...base, at: 1_000, type: "SessionStart" },
    {
      ...base,
      at: 2_000,
      type: "PreToolUse",
      tool: { id: "long-tool", name: "Bash", status: "running" },
    },
    {
      ...base,
      at: 3_000,
      type: "SubagentStart",
      agent: { id: "long-agent", type: "reviewer", status: "running" },
    },
  ];
  const afterTwoHours = foldEvents(events, 2 * 60 * 60 * 1_000);
  assert.equal(afterTwoHours.status, "working");
  assert.equal(afterTwoHours.tools[0].status, "running");
  assert.equal(afterTwoHours.agents[0].status, "running");

  const resumed = foldEvents([
    ...events,
    { ...base, at: 4_000, type: "SessionStart" },
  ], 2 * 60 * 60 * 1_000);
  assert.equal(resumed.tools.some((tool) => tool.status === "running"), false);
  assert.equal(resumed.agents.some((agent) => agent.status === "running"), false);
});

test("uses only structured permission and notification facts for waiting", () => {
  const event = (input, at) => normalizeHookEvent({
    session_id: "waiting",
    ...input,
  }, { CLAUDE_PLUGIN_ROOT: "/plugin" }, at);

  for (const notificationType of [
    "permission_prompt",
    "idle_prompt",
    "agent_needs_input",
  ]) {
    assert.equal(event({
      hook_event_name: "Notification",
      notification_type: notificationType,
    }, 1_000).needsInput, true);
  }
  for (const input of [
    { hook_event_name: "Notification" },
    { hook_event_name: "Notification", notification_type: "agent_completed" },
    { hook_event_name: "Notification", notification_type: "PERMISSION_PROMPT" },
    { hook_event_name: "Notification", notification_type: { status: "permission_prompt" } },
    { hook_event_name: "Notification", message: "permission_prompt agent needs input" },
  ]) {
    assert.equal(event(input, 1_000).needsInput, false);
  }
  assert.equal(event({ hook_event_name: "PermissionRequest" }, 1_000).needsInput, true);
});

test("waiting is cleared only by structured lifecycle events", () => {
  const event = (input, at) => normalizeHookEvent({
    session_id: "waiting-lifecycle",
    ...input,
  }, { CLAUDE_PLUGIN_ROOT: "/plugin" }, at);
  const waitingAfterTool = [
    event({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "permission-tool",
    }, 1_000),
    event({ hook_event_name: "PermissionRequest" }, 1_100),
  ];
  assert.equal(foldEvents(waitingAfterTool, 2_000).status, "waiting");

  assert.equal(foldEvents([
    ...waitingAfterTool,
    event({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "after-permission",
    }, 1_200),
  ], 2_000).status, "working");
  assert.equal(foldEvents([
    ...waitingAfterTool,
    event({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "permission-tool",
    }, 1_200),
  ], 2_000).status, "working");
  assert.equal(foldEvents([
    ...waitingAfterTool,
    event({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "permission-tool",
    }, 1_200),
  ], 2_000).status, "working");
  assert.equal(foldEvents([
    ...waitingAfterTool,
    event({
      hook_event_name: "SubagentStop",
      agent_id: "waiting-agent",
    }, 1_200),
  ], 2_000).status, "working");
  assert.equal(foldEvents([
    ...waitingAfterTool,
    event({ hook_event_name: "UserPromptSubmit", turn_id: "turn-after-wait" }, 1_200),
  ], 2_000).status, "working");
  assert.equal(foldEvents([
    ...waitingAfterTool,
    event({ hook_event_name: "Stop" }, 1_200),
  ], 2_000).status, "idle");
  assert.equal(foldEvents([
    ...waitingAfterTool,
    event({ hook_event_name: "SessionEnd" }, 1_200),
  ], 2_000).status, "idle");
});
