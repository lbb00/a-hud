import assert from "node:assert/strict";
import test from "node:test";
import { renderSnapshot } from "../dist/render.js";

function snapshot(overrides = {}) {
  return {
    platform: "claude",
    observedAt: Date.now() / 1_000,
    model: "Sonnet 5 (1m context)",
    effort: "",
    project: "",
    cwd: "",
    totalInput: null,
    contextSize: null,
    turns: 0,
    context: null,
    limits: [],
    resets: [],
    git: null,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    tools: [],
    agents: [],
    plan: [],
    ...overrides,
  };
}

test("keeps context pressure and fullness as independent warning channels", () => {
  const pressure = renderSnapshot(snapshot({
    totalInput: 100_000,
    contextSize: 200_000,
    turns: 50,
    context: 69,
  }), { colors: true, activity: false });
  assert.match(pressure, /\u001b\[33m100k\u001b\[0m\/69%\u001b\[33m 50t/);

  const fullness = renderSnapshot(snapshot({
    totalInput: 100_000,
    contextSize: 200_000,
    turns: 1,
    context: 80,
  }), { colors: true, activity: false });
  assert.match(fullness, /100k\u001b\[31m\/80%\u001b\[0m 1t/);
});

test("uses the inherited effort, cost, and forced-advisor ramps", () => {
  const yellow = renderSnapshot(snapshot({
    effort: "high",
    cost: 4,
    compactAdvisor: { kind: "forced", turns: 6, full: false },
  }), { colors: true, activity: false });
  assert.match(yellow, /\u001b\[33mH\u001b\[0m/);
  assert.match(yellow, /\u001b\[33m\$4\.00\u001b\[0m/);
  assert.match(yellow, /\u001b\[33m→~6t\u001b\[0m/);

  const red = renderSnapshot(snapshot({
    effort: "xhigh",
    cost: 13,
    compactAdvisor: { kind: "forced", turns: 3, full: false },
  }), { colors: true, activity: false });
  assert.match(red, /\u001b\[31mXH\u001b\[0m/);
  assert.match(red, /\u001b\[31m\$13\.00\u001b\[0m/);
  assert.match(red, /\u001b\[31m→~3t\u001b\[0m/);
});

test("applies quota pace only to the highest-used binding window", () => {
  const now = Date.now() / 1_000;
  const nonBindingFast = renderSnapshot(snapshot({
    observedAt: now,
    limits: [
      { label: "5h", percent: 50, resetAt: now + 18_000, windowSeconds: 18_000 },
      {
        label: "7d",
        percent: 49,
        resetAt: now + 604_800 * 0.8,
        windowSeconds: 604_800,
      },
    ],
  }), { colors: true, activity: false });
  assert.doesNotMatch(nonBindingFast, /\u001b\[(?:31|33)m#50%\/49%/);

  const bindingFast = renderSnapshot(snapshot({
    observedAt: now,
    limits: [
      {
        label: "5h",
        percent: 31,
        resetAt: now + 18_000 * 0.85,
        windowSeconds: 18_000,
      },
      { label: "7d", percent: 10, resetAt: now + 604_800, windowSeconds: 604_800 },
    ],
  }), { colors: true, activity: false });
  assert.match(bindingFast, /\u001b\[31m#31%\/10%\u001b\[0m/);
});

test("renders detached Git and churn using the legacy compact suffix grammar", () => {
  const output = renderSnapshot(snapshot({
    project: "agent-hud",
    cwd: "/workspace/agent-hud",
    git: { branch: "abc123", detached: true, dirty: true, ahead: 2, behind: 1 },
    linesAdded: 128,
    linesRemoved: 17,
  }), { colors: false, activity: false });
  assert.equal(
    output,
    "Sonnet 5\nagent-hud |  @abc123*↑2↓1 | +128/-17 | /workspace/agent-hud",
  );
});

test("accepts numeric-string reset epochs for quota pace", () => {
  const now = Math.floor(Date.now() / 1_000);
  const output = renderSnapshot(snapshot({
    observedAt: now,
    limits: [{
      label: "5h",
      percent: 31,
      resetAt: String(Math.floor(now + 18_000 * 0.85)),
      windowSeconds: 18_000,
    }],
  }), { colors: true, activity: false });
  assert.match(output, /\u001b\[31m#31%\u001b\[0m/);
});
