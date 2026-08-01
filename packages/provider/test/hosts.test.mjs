import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAntigravityStatus,
  normalizeCursorStatus,
} from "../dist/index.js";

const state = {
  platform: "agent",
  sessionId: "session",
  cwd: "/fallback",
  transcriptPath: "",
  model: "",
  status: "idle",
  tools: [{ name: "Read", status: "completed" }],
  agents: [],
  plan: [],
  updatedAt: 0,
  turns: 0,
};

test("normalizes Cursor's documented live status fields without invented quota", () => {
  const facts = normalizeCursorStatus({
    cwd: "/cursor",
    model: {
      id: "cursor-model",
      display_name: "Composer 2",
      param_summary: "reasoning=high",
    },
    context_window: {
      used_percentage: 42,
      context_window_size: 200_000,
      total_input_tokens: 84_000,
    },
    autorun: true,
  }, { ...state, platform: "cursor", status: "working" }, 1_000);

  assert.equal(facts.platform, "cursor");
  assert.equal(facts.model, "Composer 2");
  assert.equal(facts.effort, "high");
  assert.equal(facts.context, 42);
  assert.equal(facts.status, "working");
  assert.deepEqual(facts.limits, []);
  assert.deepEqual(facts.resets, []);
});

test("normalizes Antigravity quota, VCS and live lifecycle", () => {
  const facts = normalizeAntigravityStatus({
    product: "antigravity",
    workspace: { current_dir: "/antigravity" },
    model: { display_name: "Gemini 3.5 Flash (High)" },
    context_window: {
      used_percentage: 14.24,
      context_window_size: 1_048_576,
      total_input_tokens: 88_244,
    },
    quota: {
      "gemini-weekly": {
        remaining_fraction: 0.9378,
        reset_time: "2026-08-04T07:50:32Z",
      },
    },
    agent_state: "tool_use",
    vcs: { type: "git", branch: "main", dirty: true },
    task_count: 2,
  }, { ...state, platform: "antigravity" }, 2_000);

  assert.equal(facts.platform, "antigravity");
  assert.equal(facts.effort, "high");
  assert.equal(facts.status, "working");
  assert.equal(facts.limits[0].label, "7d");
  assert.equal(Math.round(facts.limits[0].percent * 100), 622);
  assert.equal(facts.git.branch, "main");
  assert.equal(facts.git.dirty, true);
  assert.equal(facts.agents[0].type, "2 tasks");
});
