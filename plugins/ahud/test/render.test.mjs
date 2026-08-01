import assert from "node:assert/strict";
import test from "node:test";
import { bar, renderSnapshot } from "../src/render.mjs";
import { visibleLength } from "../src/width.mjs";

test("bar renders green below 60%, yellow at/above 60%", () => {
  assert.match(bar(59.6), /\[32m/);
  assert.match(bar(60), /\[33m/);
});

test("renders a compact multi-line snapshot", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "Sonnet",
    project: "demo",
    context: 45,
    limits: [{ label: "5h", percent: 25 }],
    git: { branch: "main", dirty: true },
    tools: [{ name: "Edit", target: "auth.ts", status: "running" }],
    agents: [{ type: "reviewer", status: "running" }],
    plan: [{ text: "Fix auth", status: "in_progress" }],
  }, { colors: false, width: 120 });
  assert.match(output, /\[Claude · Sonnet\]/);
  assert.match(output, /Context/);
  assert.match(output, /Edit auth\.ts/);
  assert.match(output, /Fix auth \(0\/1\)/);
  assert.ok(output.split("\n").every((line) => visibleLength(line) <= 120));
});

// Per the NO_COLOR spec (https://no-color.org/), the mere PRESENCE of the
// env var disables color, regardless of its value. NO_COLOR="" is falsy in
// JS, so a `!process.env.NO_COLOR` truthiness check would wrongly leave
// colors on; renderSnapshot must instead check `"NO_COLOR" in process.env`.
test("renderSnapshot disables color when NO_COLOR is set to an empty string (presence, not truthiness)", () => {
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "";
  try {
    const output = renderSnapshot({
      platform: "claude",
      model: "Sonnet",
      project: "demo",
      context: 45,
      limits: [],
      git: null,
      tools: [],
      agents: [],
      plan: [],
    });
    assert.doesNotMatch(output, /\[/, "NO_COLOR=\"\" must still disable ANSI color output");
  } finally {
    if (hadOwnProperty) {
      process.env.NO_COLOR = previous;
    } else {
      delete process.env.NO_COLOR;
    }
  }
});
