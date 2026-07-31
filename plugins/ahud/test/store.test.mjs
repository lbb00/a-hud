import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { foldEvents, loadState, normalizeHookEvent, recordHook } from "../src/store.mjs";
// Imported as a namespace (rather than `import { detectPlatform }`) on
// purpose: detectPlatform is not exported yet (it's still an internal
// function), and a static named import of a missing export would throw a
// SyntaxError at module-load time, taking every other (currently passing)
// test in this file down with it. Accessing it off the namespace object
// instead means only the tests that actually call it fail.
import * as storeModule from "../src/store.mjs";
const { detectPlatform } = storeModule;

test("folds shared tool, agent, and plan hook events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-store-"));
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

test("normalizeHookEvent derives a stable tool id (independent of wall-clock now) so PreToolUse/PostToolUse pair up when tool_use_id is absent", () => {
  const base = {
    session_id: "sess_1",
    tool_name: "Bash",
    cwd: "/workspace",
  };
  const pre = normalizeHookEvent({ ...base, hook_event_name: "PreToolUse" }, {}, 1_000);
  const post = normalizeHookEvent({ ...base, hook_event_name: "PostToolUse" }, {}, 5_000);
  assert.equal(pre.tool.id, post.tool.id);
});

test("normalizeHookEvent derives a stable agent id (independent of wall-clock now) so SubagentStart/SubagentStop pair up when agent_id is absent", () => {
  const base = {
    session_id: "sess_1",
    agent_type: "reviewer",
  };
  const start = normalizeHookEvent({ ...base, hook_event_name: "SubagentStart" }, {}, 1_000);
  const stop = normalizeHookEvent({ ...base, hook_event_name: "SubagentStop" }, {}, 9_000);
  assert.equal(start.agent.id, stop.agent.id);
});

test("normalizeHookEvent still uses an explicit tool_use_id verbatim when present (regression)", () => {
  const event = normalizeHookEvent({
    session_id: "sess_1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "tool_abc",
  }, {}, 1_000);
  assert.equal(event.tool.id, "tool_abc");
});

test("normalizeHookEvent still uses an explicit agent_id verbatim when present (regression)", () => {
  const event = normalizeHookEvent({
    session_id: "sess_1",
    hook_event_name: "SubagentStart",
    agent_id: "agent_abc",
    agent_type: "reviewer",
  }, {}, 1_000);
  assert.equal(event.agent.id, "agent_abc");
});

test("normalizeHookEvent's fallback ids never contain the literal string 'undefined'", () => {
  const toolEvent = normalizeHookEvent({
    session_id: "sess_1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
  }, {}, 1_000);
  assert.ok(!toolEvent.tool.id.includes("undefined"));

  const agentEvent = normalizeHookEvent({
    session_id: "sess_1",
    hook_event_name: "SubagentStart",
    agent_type: "reviewer",
  }, {}, 1_000);
  assert.ok(!agentEvent.agent.id.includes("undefined"));
});

// ---------------------------------------------------------------------------
// detectPlatform (Phase 1: promoted from an internal function to a named
// export, with identical logic)
// ---------------------------------------------------------------------------

test("detectPlatform returns 'codex' when env.PLUGIN_ROOT is set", () => {
  assert.equal(detectPlatform({}, { PLUGIN_ROOT: "/plugin" }), "codex");
});

test("detectPlatform returns 'codex' when transcript_path contains /.codex/, even without env.PLUGIN_ROOT", () => {
  assert.equal(detectPlatform({ transcript_path: "/x/.codex/session.jsonl" }, {}), "codex");
});

test("detectPlatform returns 'claude' when env.CLAUDE_PLUGIN_ROOT is set", () => {
  assert.equal(detectPlatform({}, { CLAUDE_PLUGIN_ROOT: "/plugin" }), "claude");
});

test("detectPlatform returns 'claude' when transcript_path contains /.claude/, even without env.CLAUDE_PLUGIN_ROOT", () => {
  assert.equal(detectPlatform({ transcript_path: "/x/.claude/session.jsonl" }, {}), "claude");
});

test("detectPlatform falls back to 'agent' when nothing identifies the host", () => {
  assert.equal(detectPlatform({}, {}), "agent");
});

// ---------------------------------------------------------------------------
// foldEvents: new third `ttl` parameter (minutes), default preserves the
// current hardcoded 15/5-minute behavior
// ---------------------------------------------------------------------------

function completedToolEvents(sessionId, at) {
  const base = { session_id: sessionId, tool_name: "Bash", cwd: "/workspace" };
  return [
    normalizeHookEvent({ ...base, hook_event_name: "PreToolUse" }, {}, at),
    normalizeHookEvent({ ...base, hook_event_name: "PostToolUse" }, {}, at),
  ];
}

test("foldEvents with a custom ttl filters out a completed tool once it exceeds the custom recentMin (core behavioral difference from the 5-minute default)", () => {
  const events = completedToolEvents("sess_ttl_1", 0);
  const now = 61_000; // 61s later

  const withDefault = foldEvents(events, now);
  assert.equal(withDefault.tools.length, 1, "5-minute default TTL should NOT have expired a 61s-old completed tool yet");

  const withTightTtl = foldEvents(events, now, { activeMin: 1, recentMin: 1 });
  assert.equal(withTightTtl.tools.length, 0, "a 1-minute recentMin TTL should have expired a 61s-old completed tool");
});

test("foldEvents omitting the ttl argument matches today's hardcoded 15/5-minute behavior exactly (regression pin)", () => {
  const fourMinOld = completedToolEvents("sess_ttl_2", 0);
  const keptState = foldEvents(fourMinOld, 4 * 60 * 1000); // 4min < 5min recentMin default
  assert.equal(keptState.tools.length, 1);

  const sixMinOld = completedToolEvents("sess_ttl_3", 0);
  const expiredState = foldEvents(sixMinOld, 6 * 60 * 1000); // 6min > 5min recentMin default
  assert.equal(expiredState.tools.length, 0);
});

// ---------------------------------------------------------------------------
// loadState: new options.ttl, passed through to foldEvents
// ---------------------------------------------------------------------------

test("loadState passes options.ttl through to foldEvents so a tight ttl expires a tool that the default ttl would still show", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-store-ttl-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recordOptions = { dataDir: root, env: {}, now: () => 0 };
  const base = { session_id: "thr_ttl", cwd: "/workspace/demo", tool_name: "Bash" };

  await recordHook({ ...base, hook_event_name: "PreToolUse" }, recordOptions);
  await recordHook({ ...base, hook_event_name: "PostToolUse" }, recordOptions);

  const withDefaultTtl = await loadState({ sessionId: "thr_ttl" }, { dataDir: root, now: () => 61_000 });
  assert.equal(withDefaultTtl.tools.length, 1);

  const withTightTtl = await loadState(
    { sessionId: "thr_ttl" },
    { dataDir: root, now: () => 61_000, ttl: { activeMin: 1, recentMin: 1 } },
  );
  assert.equal(withTightTtl.tools.length, 0);
});
