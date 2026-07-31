import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bar,
  contextPercent,
  getGitStatus,
  renderSnapshot,
  truncate,
  visibleLength,
} from "../src/render.mjs";

test("uses native context percentage without changing threshold semantics", () => {
  assert.equal(contextPercent({ context_window: { used_percentage: 59.6 } }), 59.6);
  assert.match(bar(59.6), /\u001b\[32m/);
  assert.match(bar(60), /\u001b\[33m/);
});

test("falls back to input plus cache token usage", () => {
  assert.equal(contextPercent({
    context_window: {
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 20_000,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 10_000,
      },
    },
  }), 20);
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

test("getGitStatus parses the branch name correctly for a fresh repo with no commits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-git-fresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });

  const status = getGitStatus(root);
  assert.ok(status, "expected a git status for a freshly initialized repo");
  // `git status -b` on a repo with no commits yet prints a heading like
  // "## No commits yet on main" instead of the usual "## main...origin/main".
  // A naive split(" ")[0] on the post-"## " text yields the wrong word "No".
  assert.notEqual(status.branch, "No");
  assert.match(status.branch, /^(main|master)$/);
});

test("getGitStatus caches the underlying git invocation per cwd within cacheMs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-git-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });

  let calls = 0;
  const fakeExec = (...args) => {
    calls += 1;
    return execFileSync(...args);
  };
  let now = 1_000;
  const options = { exec: fakeExec, now: () => now, cacheMs: 2_000 };

  getGitStatus(root, options);
  getGitStatus(root, options);
  assert.equal(calls, 1, "second call within cacheMs should hit the cache, not re-exec git");

  now += 3_000;
  getGitStatus(root, options);
  assert.equal(calls, 2, "call after cacheMs has elapsed should re-invoke git");
});

test("getGitStatus keeps independent cache entries per cwd", async (t) => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-git-a-"));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-git-b-"));
  t.after(() => Promise.all([
    fs.rm(rootA, { recursive: true, force: true }),
    fs.rm(rootB, { recursive: true, force: true }),
  ]));
  execFileSync("git", ["-C", rootA, "init", "-q"], { encoding: "utf8" });
  execFileSync("git", ["-C", rootB, "init", "-q"], { encoding: "utf8" });

  let calls = 0;
  const fakeExec = (...args) => {
    calls += 1;
    return execFileSync(...args);
  };
  const options = { exec: fakeExec, now: () => 1_000, cacheMs: 2_000 };

  getGitStatus(rootA, options);
  getGitStatus(rootB, options);
  assert.equal(calls, 2, "different cwds must not share a cache entry");
});

test("getGitStatus still works with the old two-argument call style (no options)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-git-plain-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  assert.doesNotThrow(() => getGitStatus(root));
});

test("visibleLength counts CJK characters as display width 2", () => {
  assert.equal(visibleLength("你好"), 4);
});

test("visibleLength counts plain ASCII as width 1 per character (regression)", () => {
  assert.equal(visibleLength("ab"), 2);
});

test("visibleLength sums per-character display width for mixed CJK/ASCII text", () => {
  assert.equal(visibleLength("a你b好"), 1 + 2 + 1 + 2);
});

test("truncate keeps CJK text within the requested display width and marks truncation", () => {
  const result = truncate("你好世界你好世界", 5);
  assert.ok(visibleLength(result) <= 5, `expected visibleLength <= 5, got ${visibleLength(result)}`);
  assert.ok(result.endsWith("…"), "truncated CJK text should end with an ellipsis");
});
