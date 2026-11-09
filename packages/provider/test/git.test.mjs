import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { getGitStatus } from "../dist/index.js";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("reports untracked dirt and a detached raw SHA as repository facts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "hud@example.test");
  git(root, "config", "user.name", "HUD Test");
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "first");
  await fs.writeFile(path.join(root, "untracked.txt"), "two\n");

  assert.equal(getGitStatus(root).dirty, true);
  git(root, "checkout", "-q", "--detach");
  const status = getGitStatus(root);
  assert.match(status.branch, /^[0-9a-f]+$/);
  assert.equal(status.detached, true);
  assert.equal(status.dirty, true);
});

test("returns null when git fails or times out without falsely reporting clean", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-git-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "hud@example.test");
  git(root, "config", "user.name", "HUD Test");
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "first");

  assert.equal(getGitStatus(root, 0), null);

  if (process.platform === "win32") return;

  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git";
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir);
  const gitScript = path.join(binDir, "git");
  await fs.writeFile(
    gitScript,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "status" ]; then\n    exit 1\n  fi\ndone\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );

  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    assert.equal(getGitStatus(root), null);
  } finally {
    process.env.PATH = prevPath;
  }
});

test("reports dirty = true when git status buffer overflows (ENOBUFS)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-git-enobufs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "hud@example.test");
  git(root, "config", "user.name", "HUD Test");
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "first");

  if (process.platform === "win32") return;

  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git";
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir);
  const gitScript = path.join(binDir, "git");
  await fs.writeFile(
    gitScript,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "status" ]; then\n    head -c 1050000 /dev/zero\n    exit 0\n  fi\ndone\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );

  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const status = getGitStatus(root, 4_000);
    assert.ok(status);
    assert.equal(status.dirty, true);
  } finally {
    process.env.PATH = prevPath;
  }
});

test("enforces total deadline budget across multiple git invocations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-git-budget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "hud@example.test");
  git(root, "config", "user.name", "HUD Test");
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "first");

  if (process.platform === "win32") return;

  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git";
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir);
  const gitScript = path.join(binDir, "git");
  await fs.writeFile(
    gitScript,
    `#!/bin/sh\nsleep 0.15 </dev/null >/dev/null 2>&1\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );

  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const started = Date.now();
    const status = getGitStatus(root, 200);
    const duration = Date.now() - started;
    assert.equal(status, null);
    assert.ok(duration < 350, `Expected duration < 350ms, got ${duration}ms`);
  } finally {
    process.env.PATH = prevPath;
  }
});
