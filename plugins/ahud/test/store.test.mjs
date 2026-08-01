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

// ---------------------------------------------------------------------------
// loadState: an unmatched cwd/transcriptPath filter must not leak another
// project's activity (regression — previously fell back to the most
// recently active session across ALL projects).
// ---------------------------------------------------------------------------

test("loadState does not leak another project's tools when the requested cwd matches no session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-store-crossproject-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recordOptions = { dataDir: root, env: {}, now: () => 0 };

  await recordHook({
    session_id: "thr_other_project",
    cwd: "/workspace/other-project",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
  }, recordOptions);

  const state = await loadState(
    { cwd: "/workspace/my-new-project" },
    { dataDir: root, now: () => 1_000 },
  );
  assert.equal(state.tools.length, 0);
  assert.equal(state.cwd, "");
});

test("loadState still falls back to the most recent session when no cwd/transcriptPath filter is given at all", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-store-nofilter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recordOptions = { dataDir: root, env: {}, now: () => 0 };

  await recordHook({
    session_id: "thr_only_session",
    cwd: "/workspace/only-project",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
  }, recordOptions);

  const state = await loadState({}, { dataDir: root, now: () => 1_000 });
  assert.equal(state.tools.length, 1);
});

// loadState: hasFilter must also treat a lone query.sessionId as a filter
// (cross-project leak regression — see the existing "brand new session"
// scenario this mirrors: loadState({ sessionId }) whose exact-match file
// doesn't exist yet must not fall through to returning an unrelated
// session's state just because cwd/transcriptPath weren't passed either).
// ---------------------------------------------------------------------------

test("loadState: a sessionId with no matching file and no cwd/transcriptPath returns idle state, not an unrelated session's state (cross-project leak regression)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-store-leak-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { dataDir: root, env: {}, now: () => 1_000 };

  // An unrelated, already-active session in the same data dir.
  await recordHook({
    session_id: "unrelated-session",
    hook_event_name: "SessionStart",
    cwd: "/workspace/other-project",
    transcript_path: "/tmp/other-session.jsonl",
    model: "gpt-other",
  }, options);

  // A brand-new session with no events yet: its own exact-match file
  // doesn't exist, and no cwd/transcriptPath was given to match against.
  const state = await loadState({ sessionId: "brand-new-session" }, { dataDir: root, now: () => 2_000 });

  assert.equal(state.status, "idle");
  assert.equal(state.sessionId, "");
  assert.equal(state.cwd, "");
  assert.notEqual(state.model, "gpt-other", "must not leak the unrelated session's state");
});

// ---------------------------------------------------------------------------
// recordHook: opportunistic event storage garbage collection (Task 3).
//
// GC is gated by a stamp file written one directory above `dataDir` (see
// collectGarbage()'s comment in store.mjs) so these tests set up
// `<root>/events` as dataDir and inspect `<root>/.gc-stamp`.
// ---------------------------------------------------------------------------

const GC_STAMP_FILE = ".gc-stamp";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

async function gcTestDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-store-gc-"));
  const dataDir = path.join(root, "events");
  await fs.mkdir(dataDir, { recursive: true });
  return { root, dataDir };
}

async function writeAgedEventFile(dataDir, name, ageMs, now) {
  const filePath = path.join(dataDir, name);
  await fs.writeFile(filePath, `${JSON.stringify({ v: 1, at: now - ageMs, sessionId: name })}\n`);
  const mtime = new Date(now - ageMs);
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

test("recordHook GC: a .jsonl file older than 7 days is removed once the stamp-file gate is forced open (missing stamp)", async (t) => {
  const { root, dataDir } = await gcTestDirs();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = 100_000_000;
  const oldFile = await writeAgedEventFile(dataDir, "old-session.jsonl", SEVEN_DAYS_MS + 60_000, now);

  await recordHook({
    session_id: "fresh-session",
    hook_event_name: "SessionStart",
    cwd: "/workspace/demo",
  }, { dataDir, env: {}, now: () => now });

  await assert.rejects(fs.access(oldFile), "a .jsonl file older than 7 days should have been deleted");
  await assert.doesNotReject(fs.access(path.join(root, GC_STAMP_FILE)), "the gc stamp file should have been (re)written");
});

test("recordHook GC: a .jsonl file within 7 days survives the sweep", async (t) => {
  const { root, dataDir } = await gcTestDirs();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = 100_000_000;
  const recentFile = await writeAgedEventFile(dataDir, "recent-session.jsonl", SEVEN_DAYS_MS - 60_000, now);

  await recordHook({
    session_id: "fresh-session",
    hook_event_name: "SessionStart",
    cwd: "/workspace/demo",
  }, { dataDir, env: {}, now: () => now });

  await assert.doesNotReject(fs.access(recentFile), "a .jsonl file within 7 days must survive");
});

test("recordHook GC: once more than 100 files survive the age pass, the oldest-mtime ones are evicted down to 100 (LRU cap)", async (t) => {
  const { root, dataDir } = await gcTestDirs();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = 100_000_000;
  // 105 files, all well within the 7-day age cutoff, but with distinct
  // mtimes (oldest = index 0) so eviction order is unambiguous.
  const files = [];
  for (let i = 0; i < 105; i += 1) {
    // Newer index -> smaller age -> newer mtime, so index 0 is oldest.
    const ageMs = (105 - i) * 1_000;
    files.push(await writeAgedEventFile(dataDir, `session-${i}.jsonl`, ageMs, now));
  }

  await recordHook({
    session_id: "fresh-session",
    hook_event_name: "SessionStart",
    cwd: "/workspace/demo",
  }, { dataDir, env: {}, now: () => now });

  const remaining = await fs.readdir(dataDir);
  // 105 pre-existing + 1 just-written fresh-session file = 106 candidates,
  // capped down to 100.
  assert.equal(remaining.length, 100);
  await assert.rejects(fs.access(files[0]), "the single oldest file must have been evicted first");
  await assert.doesNotReject(fs.access(files[104]), "the newest of the pre-existing files must survive");
});

test("recordHook GC: at or under 100 files, none are evicted by the count cap", async (t) => {
  const { root, dataDir } = await gcTestDirs();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = 100_000_000;
  const files = [];
  for (let i = 0; i < 99; i += 1) {
    files.push(await writeAgedEventFile(dataDir, `session-${i}.jsonl`, (99 - i) * 1_000, now));
  }

  await recordHook({
    session_id: "fresh-session",
    hook_event_name: "SessionStart",
    cwd: "/workspace/demo",
  }, { dataDir, env: {}, now: () => now });

  // 99 pre-existing + 1 fresh = 100, exactly at the cap.
  const remaining = await fs.readdir(dataDir);
  assert.equal(remaining.length, 100);
  for (const filePath of files) {
    await assert.doesNotReject(fs.access(filePath));
  }
});

test("recordHook GC: a recent stamp file (< 24h old) keeps the gate closed — no sweep runs at all, even against a >7-day-old file", async (t) => {
  const { root, dataDir } = await gcTestDirs();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = 100_000_000;
  const oldFile = await writeAgedEventFile(dataDir, "old-session.jsonl", SEVEN_DAYS_MS + 60_000, now);

  const stampPath = path.join(root, GC_STAMP_FILE);
  await fs.writeFile(stampPath, "seed");
  const recentStamp = new Date(now - (TWENTY_FOUR_HOURS_MS - 60_000));
  await fs.utimes(stampPath, recentStamp, recentStamp);
  const stampMtimeBefore = (await fs.stat(stampPath)).mtimeMs;

  await recordHook({
    session_id: "fresh-session",
    hook_event_name: "SessionStart",
    cwd: "/workspace/demo",
  }, { dataDir, env: {}, now: () => now });

  await assert.doesNotReject(fs.access(oldFile), "gate should stay closed: the >7-day-old file must survive untouched");
  const stampMtimeAfter = (await fs.stat(stampPath)).mtimeMs;
  assert.equal(stampMtimeAfter, stampMtimeBefore, "the stamp file itself must not be rewritten while the gate is closed");
});
