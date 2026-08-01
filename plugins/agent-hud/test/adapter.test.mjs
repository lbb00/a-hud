import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAntigravityStatus,
  normalizeCursorStatus,
} from "@agent-hud/provider";
import {
  snapshotFromAntigravity,
  snapshotFromClaude,
  snapshotFromCursor,
  snapshotFromState,
} from "../dist/adapter.js";

function facts(overrides = {}) {
  return {
  platform: "claude",
  observedAt: 1_000,
  model: "Sonnet 5 (1m context)",
  cwd: "/workspace/demo",
  context: 75,
  contextSize: 200_000,
  totalInput: 90_420,
  turns: 16,
  effort: "high",
  limits: [
    { label: "5h", percent: 15, windowSeconds: 18_000 },
    { label: "7d", percent: 70, windowSeconds: 604_800 },
  ],
  resets: [],
  cost: null,
  linesAdded: null,
  linesRemoved: null,
  status: "idle",
  tools: [],
  agents: [],
  plan: [],
  cache: { expiresAt: 1_250, ttlSeconds: 300 },
  compact: { forcedTurns: 3, breakEvenTurns: 10, inForcedZone: false },
  apiHealthIndicator: "minor",
  healthCacheStale: false,
  ...overrides,
  };
}

test("maps raw provider facts into the legacy UI model", () => {
  const snapshot = snapshotFromClaude(facts(), null);

  assert.equal(snapshot.modelSeverity, "yellow");
  assert.deepEqual(snapshot.cache, { state: "expiring", expiresAt: 1_250 });
  assert.deepEqual(snapshot.compactAdvisor, {
    kind: "forced",
    turns: 3,
    full: false,
  });
  assert.deepEqual(snapshot.limits.map((limit) => limit.label), ["5h", "7d"]);
  assert.equal(snapshot.contextSize, 200_000);
});

test("keeps display precedence out of the provider", () => {
  const snapshot = snapshotFromClaude(facts({
    compact: { forcedTurns: 31, breakEvenTurns: 12, inForcedZone: false },
    apiHealthIndicator: "none",
  }), null);
  assert.deepEqual(snapshot.compactAdvisor, {
    kind: "break-even",
    turns: 12,
    full: false,
  });
});

test("preserves waiting across both provider adapters", () => {
  assert.equal(snapshotFromClaude(facts({ status: "waiting" }), null).status, "waiting");
  assert.equal(snapshotFromState({
    platform: "codex",
    sessionId: "waiting",
    cwd: "/workspace/demo",
    transcriptPath: "",
    model: "gpt-test",
    status: "waiting",
    tools: [],
    agents: [],
    plan: [],
    updatedAt: 1_000,
    turns: 0,
  }, null).status, "waiting");
});

function hostState(platform) {
  return {
    platform,
    sessionId: `${platform}-session`,
    cwd: "/workspace/demo",
    transcriptPath: "",
    model: "",
    status: "working",
    tools: [{ id: "tool-1", name: "Read", status: "running" }],
    agents: [],
    plan: [],
    updatedAt: 1_000,
    turns: 2,
  };
}

test("maps Cursor's Claude-compatible live payload without transcript guesses", () => {
  const input = {
    cwd: "/workspace/demo",
    autorun: true,
    model: {
      id: "grok-4.5",
      display_name: "Cursor Grok 4.5",
      param_summary: "effort=high,fast=true",
    },
    context_window: {
      total_input_tokens: 90_000,
      context_window_size: 200_000,
      used_percentage: 45,
    },
  };
  const snapshot = snapshotFromCursor(
    normalizeCursorStatus(input, hostState("cursor"), 2_000),
    null,
  );
  assert.equal(snapshot.platform, "cursor");
  assert.equal(snapshot.effort, "high");
  assert.equal(snapshot.context, 45);
  assert.equal(snapshot.totalInput, 90_000);
  assert.deepEqual(snapshot.limits, []);
  assert.equal(snapshot.cost, null);
});

test("maps Antigravity's authoritative quota, VCS and lifecycle payload", () => {
  const input = {
    product: "antigravity",
    cwd: "/workspace/demo",
    model: {
      id: "gemini-3.5",
      display_name: "Gemini 3.5 Flash (High)",
    },
    context_window: {
      total_input_tokens: 88_244,
      context_window_size: 1_048_576,
      used_percentage: 14.24,
    },
    quota: {
      "gemini-weekly": {
        remaining_fraction: 0.9378,
        reset_time: "2026-08-06T07:50:32Z",
      },
    },
    agent_state: "tool_use",
    tool_confirmation_pending: true,
    task_count: 2,
    vcs: { type: "git", branch: "main", dirty: true },
  };
  const snapshot = snapshotFromAntigravity(
    normalizeAntigravityStatus(input, hostState("antigravity"), 2_000),
    null,
  );
  assert.equal(snapshot.platform, "antigravity");
  assert.equal(snapshot.effort, "high");
  assert.equal(snapshot.status, "waiting");
  assert.equal(snapshot.limits[0].label, "7d");
  assert.ok(Math.abs(snapshot.limits[0].percent - 6.22) < 0.001);
  assert.deepEqual(snapshot.git, {
    branch: "main",
    detached: false,
    dirty: true,
    ahead: 0,
    behind: 0,
  });
  assert.equal(snapshot.agents[0].type, "2 tasks");
});
