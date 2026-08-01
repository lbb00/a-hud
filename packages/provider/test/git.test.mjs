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
