import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeStatus } from "../dist/index.js";

const state = {
  platform: "claude",
  sessionId: "session",
  cwd: "",
  transcriptPath: "",
  model: "",
  status: "idle",
  tools: [],
  agents: [],
  plan: [],
  updatedAt: 0,
  turns: 0,
};
const derived = {
  observedAt: 1_000,
  turns: 16,
  effort: "high",
  cache: null,
  compact: { forcedTurns: null, breakEvenTurns: 12, inForcedZone: false },
  apiHealthIndicator: "none",
  healthCacheStale: false,
};

test("normalizes the complete Claude host schema before the UI boundary", () => {
  const deepTail = "tail  with  spaces";
  const cwd = `/${"segment/".repeat(60)}${deepTail}`;
  const facts = normalizeClaudeStatus({
    model: { display_name: "Sonnet 5 (Preview)" },
    cwd,
    context_window: {
      used_percentage: 75,
      context_window_size: 200_000,
      total_input_tokens: 90_420,
    },
    rate_limits: {
      five_hour: { used_percentage: 15, resets_at: 2_000 },
      seven_day: { resets_at: 3_000 },
    },
    cost: {
      total_cost_usd: 5.32,
      total_lines_added: 128,
      total_lines_removed: 17,
    },
  }, state, derived);

  assert.equal(facts.cwd, cwd);
  assert.equal(facts.model, "Sonnet 5 (Preview)");
  assert.equal(facts.context, 75);
  assert.deepEqual(facts.limits.map((limit) => limit.label), ["5h"]);
  assert.deepEqual(facts.resets, [
    { label: "5h", resetAt: 2_000 },
    { label: "7d", resetAt: 3_000 },
  ]);
  assert.equal(facts.cost, 5.32);
  assert.equal(facts.turns, 16);
});

test("preserves waiting as a provider lifecycle fact", () => {
  const facts = normalizeClaudeStatus({}, { ...state, status: "waiting" }, derived);
  assert.equal(facts.status, "waiting");
});
