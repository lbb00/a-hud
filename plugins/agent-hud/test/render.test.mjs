import assert from "node:assert/strict";
import test from "node:test";
import {
  renderSnapshot,
  visibleLength,
} from "../dist/render.js";
import { truncateLeft } from "../dist/terminal-width.js";

test("renders a compact multi-line snapshot", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "Sonnet",
    effort: "high",
    project: "demo",
    cwd: "/workspace/demo",
    totalInput: 90_420,
    contextSize: 200_000,
    turns: 26,
    context: 45,
    limits: [{ label: "5h", percent: 25 }],
    git: { branch: "main", dirty: true },
    cost: 5.32,
    linesAdded: 128,
    linesRemoved: 17,
    tools: [{ name: "Edit", target: "auth.ts", status: "running" }],
    agents: [{ type: "reviewer", status: "running" }],
    plan: [{ text: "Fix auth", status: "in_progress" }],
  }, { colors: false, width: 120 });
  assert.match(output, /^Sonnet \| H \| 90k\/45% 26t \| #25%/);
  assert.match(output, /^\$5\.32$/m);
  assert.match(output, /^demo \|  main\* \| \+128\/-17 \| \/workspace\/demo$/m);
  assert.match(output, /Edit auth\.ts/);
  assert.match(output, /Fix auth \(0\/1\)/);
  assert.ok(output.split("\n").every((line) => visibleLength(line) <= 120));
});

test("matches the previous HUD telemetry layout", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "Sonnet 5 (1m context)",
    effort: "high",
    project: "agent-hud",
    cwd: "/workspace/agent-hud",
    totalInput: 90_420,
    contextSize: 1_000_000,
    turns: 0,
    context: 45.2,
    limits: [
      { label: "5h", percent: 15.8 },
      { label: "7d", percent: 70.2 },
    ],
    git: null,
    cost: 5.32,
    linesAdded: 128,
    linesRemoved: 17,
    tools: [],
    agents: [],
    plan: [],
  }, { colors: false, width: 160 });
  assert.equal(output, [
    "Sonnet 5 | H | 90k/45% | #15%/70%",
    "$5.32",
    "agent-hud | +128/-17 | /workspace/agent-hud",
  ].join("\n"));
});

test("keeps the compact advisor on line two and hides it on narrow panes", () => {
  const snapshot = {
    platform: "claude",
    model: "Sonnet 5",
    effort: "high",
    project: "agent-hud",
    cwd: "/a/very/deep/workspace/path/whose/useful/project/tail/must-survive",
    totalInput: 100_000,
    contextSize: 200_000,
    turns: 16,
    context: 75,
    limits: [],
    git: null,
    cost: 5.32,
    linesAdded: null,
    linesRemoved: null,
    tools: [],
    agents: [],
    plan: [],
    modelSeverity: "plain",
    cache: null,
    compactAdvisor: { kind: "forced", turns: 3, full: false },
  };

  const wide = renderSnapshot(snapshot, { colors: false, width: 100, activity: false });
  assert.match(wide, /^\$5\.32 \| →~3t$/m);
  const narrow = renderSnapshot(snapshot, { colors: false, width: 59, activity: false });
  assert.doesNotMatch(narrow, /\$5\.32|→~3t/);
  assert.match(narrow, /agent-hud \| …/);
  assert.match(narrow, /tail\/must-survive$/m);
});

test("uses color only for warning-bearing fields", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "Sonnet 5",
    effort: "medium",
    project: "agent-hud",
    cwd: "/workspace/agent-hud",
    totalInput: 100_000,
    contextSize: 200_000,
    turns: 1,
    context: 10,
    limits: [],
    git: null,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    tools: [],
    agents: [],
    plan: [],
    modelSeverity: "yellow",
    cache: { state: "cold", expiresAt: 0 },
    compactAdvisor: null,
  }, { colors: true, width: 120, activity: false });

  assert.match(output, /^\u001b\[33mSonnet 5\u001b\[0m/);
  assert.match(output, /\u001b\[31m\*cold\u001b\[0m/);
  assert.doesNotMatch(output, /\u001b\[(?:31|33)mM\u001b/);
  assert.match(output, /\u001b\[97magent-hud\u001b\[0m/);
});

test("hides an incomplete context box instead of inventing a display field", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "Sonnet 5",
    effort: "",
    project: "",
    cwd: "",
    totalInput: 90_000,
    contextSize: null,
    turns: 10,
    context: 45,
    limits: [],
    git: null,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    tools: [],
    agents: [],
    plan: [],
  }, { colors: false, width: 120, activity: false });
  assert.equal(output, "Sonnet 5");
});

test("labels a lone weekly reset with its weekday when it is not today", () => {
  const future = new Date();
  future.setDate(future.getDate() + 2);
  const output = renderSnapshot({
    platform: "claude",
    model: "Sonnet 5",
    effort: "",
    project: "",
    cwd: "",
    totalInput: null,
    contextSize: null,
    turns: 0,
    context: null,
    limits: [],
    resets: [{ label: "7d", resetAt: future.getTime() / 1_000 }],
    git: null,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    tools: [],
    agents: [],
    plan: [],
  }, { colors: false, width: 120, activity: false });
  assert.match(output, /↻(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}:\d{2}$/);
});

test("strips any trailing model parenthetical like the shell width rule", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "Claude Opus 4.5 (Preview)",
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
  }, { colors: false, activity: false });
  assert.equal(output, "Claude Opus 4.5");
});

test("renders failed tools and agents as red errors, never successes", () => {
  const output = renderSnapshot({
    platform: "codex",
    model: "Codex",
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
    tools: [{ name: "Bash", status: "error" }],
    agents: [{ type: "reviewer", status: "error" }],
    plan: [],
  }, { colors: true, width: 120 });
  assert.match(output, /\u001b\[31m!\u001b\[0m\u001b\[2m Bash/);
  assert.match(output, /\u001b\[31m!\u001b\[0m\u001b\[2m reviewer/);
  assert.doesNotMatch(output, /✓ (?:Bash|reviewer)/);
});

test("restores activity dim after nested warning markers reset ANSI", () => {
  const output = renderSnapshot(activitySnapshot({
    tools: [{ name: "Bash", target: "test.mjs", status: "running" }],
    agents: [{ type: "reviewer", status: "error" }],
  }), { colors: true, width: 200 });

  assert.match(
    output,
    /\u001b\[2m\u001b\[33m◐\u001b\[0m\u001b\[2m Bash/,
  );
  assert.match(
    output,
    /\u001b\[31m!\u001b\[0m\u001b\[2m reviewer/,
  );
});

test("surfaces waiting only in the companion activity line", () => {
  const snapshot = {
    platform: "claude",
    model: "Sonnet 5",
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
    status: "waiting",
    tools: [],
    agents: [],
    plan: [],
  };

  assert.equal(
    renderSnapshot(snapshot, { colors: false, activity: true }),
    "Sonnet 5\n? needs input",
  );
  assert.equal(
    renderSnapshot(snapshot, { colors: false, activity: false }),
    "Sonnet 5",
  );
  assert.match(
    renderSnapshot(snapshot, { colors: true, activity: true }),
    /\u001b\[33m\?\u001b\[0m\u001b\[2m needs input/,
  );
});

test("removes control bytes without collapsing valid display spacing", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "Sonnet\u001b[31m  5",
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
  }, { colors: false, activity: false });
  assert.equal(output, "Sonnet[31m  5");
  assert.doesNotMatch(output, /\u001b/);
});

test("never emits terminal controls supplied through effort", () => {
  const output = renderSnapshot({
    ...activitySnapshot(),
    model: "Claude",
    effort: "\u001b]2;PWNED\u0007",
  }, { colors: false, activity: false });
  assert.doesNotMatch(output, /[\u001b\u0007]/);
});

test("measures terminal cells across CJK, graphemes, emoji, and ANSI", () => {
  assert.equal(visibleLength("项目/e\u0301/👩‍💻/🚀"), 12);
  assert.equal(visibleLength("\u001b[31m项目👩‍💻\u001b[0m"), 6);
  assert.equal(visibleLength("👨‍👩‍👧‍👦"), 2);
});

test("follows CJK terminal width for inherited ambiguous design glyphs", () => {
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = "zh_CN.UTF-8";
  try {
    assert.equal(visibleLength("✓…│"), 5);
    assert.equal(visibleLength("αé·™"), 8);
  } finally {
    if (previous === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous;
  }
});

test("left truncation drops formatting instead of cutting an escape sequence", () => {
  const output = truncateLeft("\u001b[31m/very/long/项目\u001b[0m", 10);
  assert.doesNotMatch(output, /\u001b/);
  assert.ok(visibleLength(output) <= 10);
  assert.match(output, /项目$/);
});

test("left-ellipsizes a Unicode cwd by cells and preserves its useful tail", () => {
  const output = renderSnapshot({
    platform: "claude",
    model: "",
    effort: "",
    project: "项目",
    cwd: "/工作区/很深/e\u0301/👩‍💻/尾部",
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
  }, { colors: false, width: 28, activity: false });

  assert.match(output, /^项目 \| …/);
  assert.match(output, /é\/👩‍💻\/尾部$/u);
  assert.ok(output.split("\n").every((line) => visibleLength(line) <= 28));
});

test("never exceeds a narrow terminal and does not split ANSI or graphemes", () => {
  const output = renderSnapshot({
    platform: "codex",
    model: "GPT-5.6 👩‍💻 非常长的模型名称",
    effort: "xhigh",
    project: "非常长的项目名称👨‍👩‍👧‍👦",
    cwd: "/工作区/非常深的目录/最终目录",
    totalInput: 123_456,
    contextSize: 200_000,
    turns: 42,
    context: 83,
    limits: [{ label: "weekly", percent: 96 }],
    resets: [],
    git: { branch: "feature/非常长的分支", dirty: true },
    cost: 14.2,
    linesAdded: 1234,
    linesRemoved: 567,
    tools: [{ name: "执行工具👩‍💻", target: "组合e\u0301文件.ts", status: "running" }],
    agents: [{ type: "审查代理👨‍👩‍👧‍👦", status: "running" }],
    plan: [{ text: "完成非常长的计划项目", status: "in_progress" }],
  }, { colors: true, width: 18 });

  for (const line of output.split("\n")) {
    assert.ok(visibleLength(line) <= 18, `${visibleLength(line)} cells: ${line}`);
    assert.doesNotMatch(line, /\u001b(?!\[[0-?]*[ -/]*[@-~])/);
  }
  assert.doesNotMatch(output, /[\u200d\u0301]…/u);
  assert.match(output, /\u001b\[0m/);
});

function activitySnapshot(overrides = {}) {
  return {
    platform: "codex",
    model: "",
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

test("reports exact hidden notable tool and agent counts without color", () => {
  const output = renderSnapshot(activitySnapshot({
    tools: [
      { name: "Read", status: "running" },
      { name: "Edit", status: "error" },
      { name: "Bash", status: "running" },
      { name: "Web", status: "running" },
    ],
    agents: [
      { type: "reviewer", status: "running" },
      { type: "tester", status: "completed" },
      { type: "researcher", status: "running" },
      { type: "writer", status: "completed" },
      { type: "planner", status: "running" },
    ],
  }), { colors: false, width: 200 });

  assert.equal(output, [
    "◐ Read │ ! Edit │ +2 more",
    "◐ reviewer │ ✓ tester │ ◐ researcher │ +2 more",
  ].join(" | "));
  assert.doesNotMatch(output, /Bash|Web|writer|planner/);
});

test("counts hidden completed tool groups, not hidden invocations", () => {
  const output = renderSnapshot(activitySnapshot({
    tools: [
      { name: "Read", status: "completed" },
      { name: "Read", status: "completed" },
      { name: "Edit", status: "completed" },
      { name: "Bash", status: "completed" },
      { name: "Glob", status: "completed" },
      { name: "Web", status: "completed" },
      { name: "Web", status: "completed" },
      { name: "Web", status: "completed" },
      { name: "Task", status: "completed" },
    ],
  }), { colors: false, width: 200 });

  assert.equal(output, "✓ Read ×2 │ ✓ Edit │ ✓ Bash │ ✓ Glob │ +2 more");
  assert.doesNotMatch(output, /Web|Task/);
});

test("styles overflow counts dimly with color and emits none at exact limits", () => {
  const overflow = renderSnapshot(activitySnapshot({
    tools: [
      { name: "Read", status: "running" },
      { name: "Edit", status: "running" },
      { name: "Bash", status: "running" },
    ],
    agents: [
      { type: "reviewer", status: "running" },
      { type: "tester", status: "completed" },
      { type: "writer", status: "completed" },
      { type: "planner", status: "running" },
    ],
  }), { colors: true, width: 200 });
  assert.equal(
    [...overflow.matchAll(/\u001b\[2m\+1 more\u001b\[0m/g)].length,
    2,
  );

  const exact = renderSnapshot(activitySnapshot({
    tools: [
      { name: "Read", status: "running" },
      { name: "Edit", status: "error" },
    ],
    agents: [
      { type: "reviewer", status: "running" },
      { type: "tester", status: "completed" },
      { type: "writer", status: "completed" },
    ],
  }), { colors: false, width: 200 });
  assert.equal(
    exact,
    "◐ Read │ ! Edit | ◐ reviewer │ ✓ tester │ ✓ writer",
  );
  assert.doesNotMatch(exact, /\bmore\b/);
});
