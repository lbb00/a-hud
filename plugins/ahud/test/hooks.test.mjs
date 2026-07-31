import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hooks.json registers PostToolUseFailure with the same shape as PostToolUse", () => {
  const raw = fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8");
  const hooks = JSON.parse(raw).hooks;

  assert.ok(hooks.PostToolUse, "expected PostToolUse to already be registered (sanity check)");
  assert.ok(
    hooks.PostToolUseFailure,
    "PostToolUseFailure must be registered so store.mjs's error-status handling is reachable",
  );

  const postToolUse = hooks.PostToolUse[0];
  const postToolUseFailure = hooks.PostToolUseFailure[0];

  assert.equal(postToolUseFailure.matcher, postToolUse.matcher);
  assert.equal(postToolUseFailure.hooks[0].type, postToolUse.hooks[0].type);
  assert.equal(postToolUseFailure.hooks[0].command, postToolUse.hooks[0].command);
  assert.equal(postToolUseFailure.hooks[0].timeout, postToolUse.hooks[0].timeout);
  assert.match(postToolUseFailure.hooks[0].command, /cli\.mjs" hook/);
});
