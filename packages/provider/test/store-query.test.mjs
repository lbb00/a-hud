import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyProviderState, loadState, recordHook } from "../dist/index.js";

test("skips candidate files for mismatched platforms without parsing their events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-fast-filter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "events");

  await recordHook({
    session_id: "codex-session",
    cwd: "/workspace/proj",
    hook_event_name: "SessionStart",
  }, { dataDir, platform: "codex", now: () => 1_000 });

  const state = await loadState({
    cwd: "/workspace/proj",
    platform: "antigravity",
  }, { dataDir, now: () => 2_000 });

  assert.equal(state.platform, "antigravity");
  assert.equal(state.tools.length, 0);
  assert.equal(state.status, "idle");
});

test("matches by cwd even when query transcriptPath does not match candidate file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-cwd-fallback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "events");

  await recordHook({
    session_id: "recorded-session",
    cwd: "/workspace/cwd-match",
    hook_event_name: "SessionStart",
    model: "claude-3-7-sonnet",
  }, { dataDir, platform: "claude", now: () => 1_000 });

  const state = await loadState({
    sessionId: "different-session",
    transcriptPath: "/other/transcript.jsonl",
    cwd: "/workspace/cwd-match",
    platform: "claude",
  }, { dataDir, now: () => 2_000 });

  assert.equal(state.model, "claude-3-7-sonnet");
  assert.equal(state.cwd, "/workspace/cwd-match");
});

test("emptyProviderState constructs consistent neutral fallback state", () => {
  const state = emptyProviderState({
    platform: "antigravity",
    cwd: "/workspace/demo",
    sessionId: "demo-sess",
    transcriptPath: "/tmp/transcript.jsonl",
  });
  assert.equal(state.platform, "antigravity");
  assert.equal(state.cwd, "/workspace/demo");
  assert.equal(state.sessionId, "demo-sess");
  assert.equal(state.transcriptPath, "/tmp/transcript.jsonl");
  assert.equal(state.status, "idle");
  assert.deepEqual(state.tools, []);
  assert.deepEqual(state.agents, []);
  assert.deepEqual(state.plan, []);
});

test("recordHook serializes platform as compact JSON property for fast pre-filtering", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-format-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "events");

  await recordHook({
    session_id: "format-check",
    cwd: "/workspace/test",
    hook_event_name: "SessionStart",
  }, { dataDir, platform: "antigravity" });

  const files = await fs.readdir(dataDir);
  const jsonl = files.find((f) => f.endsWith(".jsonl"));
  assert.ok(jsonl);
  const content = await fs.readFile(path.join(dataDir, jsonl), "utf8");
  assert.match(content, /"platform":"antigravity"/);
});

test("loadState respects AbortSignal and skips sweep when aborted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-abort-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "events");

  const controller = new AbortController();
  controller.abort();

  const state = await loadState(
    { cwd: "/workspace/aborted", platform: "antigravity" },
    { dataDir, signal: controller.signal },
  );
  assert.equal(state.platform, "antigravity");
  await assert.rejects(fs.stat(path.join(dataDir, ".agent-hud-hygiene.stamp")));
});

test("loadState breaks candidate scanning immediately when AbortSignal fires during iteration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-abort-mid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "events");

  // Create an older matching file that would be discovered if scanning continued
  const olderRes = await recordHook({
    session_id: "older-matching",
    cwd: "/workspace/target",
    hook_event_name: "SessionStart",
    model: "should-not-reach-this-model",
  }, { dataDir, platform: "antigravity", now: () => 1_000 });

  // Create a newer non-matching file that is scanned first
  const newerRes = await recordHook({
    session_id: "newer-unmatched",
    cwd: "/workspace/unmatched",
    hook_event_name: "SessionStart",
    model: "unmatched-model",
  }, { dataDir, platform: "antigravity", now: () => 2_000 });

  // Explicitly set filesystem mtime via utimes to guarantee deterministic candidate ordering across all filesystems
  const oldTime = new Date(1_000_000);
  const newTime = new Date(2_000_000);
  await fs.utimes(olderRes.filePath, oldTime, oldTime);
  await fs.utimes(newerRes.filePath, newTime, newTime);

  const controller = new AbortController();
  let nowCalls = 0;

  const state = await loadState(
    { cwd: "/workspace/target", platform: "antigravity" },
    {
      dataDir,
      signal: controller.signal,
      now: () => {
        nowCalls++;
        if (nowCalls === 1) controller.abort();
        return 3_000;
      },
    },
  );

  // If the loop broke on signal, it never read the older matching candidate
  assert.equal(state.model, "");
  assert.equal(controller.signal.aborted, true);
  // now() is called once in candidate iteration 1, and once when building the empty fallback state
  assert.equal(nowCalls, 2);
});
