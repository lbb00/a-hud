import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getGitStatus } from "../src/git.mjs";

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

test("getGitStatus labels a detached HEAD as 'detached', not the ambiguous literal 'HEAD'", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-git-detached-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  // -c user.email/user.name scope the identity to just this invocation —
  // a CI runner with no global git identity configured would otherwise
  // fail this commit ("Please tell me who you are").
  execFileSync("git", [
    "-C", root, "-c", "user.email=ahud-test@example.com", "-c", "user.name=ahud test",
    "commit", "--allow-empty", "-qm", "init",
  ], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "checkout", "-q", "--detach", "HEAD"], { encoding: "utf8" });

  const status = getGitStatus(root);
  assert.equal(status.branch, "detached");
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
