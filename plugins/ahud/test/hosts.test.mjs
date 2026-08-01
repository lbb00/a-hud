import assert from "node:assert/strict";
import test from "node:test";
import { HOSTS, badgeFor, detectHost, findHost, hostIds, setupTargetIds } from "../src/hosts.mjs";

test("hostIds returns every registered host's id, codex before claude", () => {
  assert.deepEqual(hostIds(), ["codex", "claude"]);
});

test("findHost returns the matching descriptor, or null for an unknown id", () => {
  assert.equal(findHost("codex")?.badge, "Codex");
  assert.equal(findHost("claude")?.badge, "Claude");
  assert.equal(findHost("nonexistent"), null);
});

test("detectHost returns 'codex' when PLUGIN_ROOT is set, even without a matching transcript_path", () => {
  assert.equal(detectHost({}, { PLUGIN_ROOT: "/plugin" }), "codex");
});

test("detectHost returns 'codex' when transcript_path contains /.codex/, even without PLUGIN_ROOT", () => {
  assert.equal(detectHost({ transcript_path: "/x/.codex/session.jsonl" }, {}), "codex");
});

test("detectHost returns 'claude' when CLAUDE_PLUGIN_ROOT is set", () => {
  assert.equal(detectHost({}, { CLAUDE_PLUGIN_ROOT: "/plugin" }), "claude");
});

test("detectHost returns 'claude' when transcript_path contains /.claude/", () => {
  assert.equal(detectHost({ transcript_path: "/x/.claude/session.jsonl" }, {}), "claude");
});

test("detectHost falls back to 'agent' when nothing identifies the host", () => {
  assert.equal(detectHost({}, {}), "agent");
});

test("detectHost prefers codex when both hosts' signals are present (registry order, first match wins)", () => {
  assert.equal(detectHost({}, { PLUGIN_ROOT: "/plugin", CLAUDE_PLUGIN_ROOT: "/plugin" }), "codex");
});

test("badgeFor returns each registered host's badge, and 'Agent' for an unknown/unregistered platform id", () => {
  assert.equal(badgeFor("codex"), "Codex");
  assert.equal(badgeFor("claude"), "Claude");
  assert.equal(badgeFor("agent"), "Agent");
  assert.equal(badgeFor("nonexistent"), "Agent");
});

test("every registered host exposes a callable setup() function", () => {
  for (const host of HOSTS) {
    assert.equal(typeof host.setup, "function");
  }
});

// setupTargetIds: "both" dispatches claude-before-codex (the pre-registry
// order `ahud setup both` has always used), independent of hostIds()'s own
// codex-before-claude detection order (regression — round 3 adversarial
// review found the registry had silently swapped this order and mislabeled
// it as cosmetic, when it actually determines which host's config is left
// mutated if the other host's config is malformed).
test("setupTargetIds('both') dispatches claude before codex, independent of hostIds()'s detection order", () => {
  assert.deepEqual(setupTargetIds("both"), ["claude", "codex"]);
  assert.notDeepEqual(setupTargetIds("both"), hostIds(), "setup order must not just mirror detection order");
});

test("setupTargetIds returns a single-element array for a specific target", () => {
  assert.deepEqual(setupTargetIds("claude"), ["claude"]);
  assert.deepEqual(setupTargetIds("codex"), ["codex"]);
});
