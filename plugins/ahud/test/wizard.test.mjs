// Unit tests for the interactive `ahud setup` wizard (src/wizard.mjs).
//
// src/wizard.mjs does not exist yet — this file is written ahead of the
// implementation (TDD). Every test below is expected to fail right now,
// starting with a module-load failure ("Cannot find module
// '../src/wizard.mjs'"), which is expected and will take down every test in
// this file simultaneously until the module exists. That is fine: unlike
// setup.test.mjs (which uses a namespace import to isolate missing-export
// failures because setup.mjs already exists), there is nothing to isolate
// here — the whole module is new.
//
// Context/scope note: src/config.mjs and src/adapter.mjs (Phase 1/2 of this
// three-way parallel effort) may not exist yet either. This file never
// imports them. Wherever the wizard needs config data (the Q2 "does the user
// already have a saved custom Codex preset?" question), it goes through an
// injectable `options.loadConfig` function on runSetupWizard — see the
// "Q2" describe block below and the contract summary in the final report
// for the exact shape of that injection point.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runSetupWizard, shouldRunWizard } from "../src/wizard.mjs";

// ---------------------------------------------------------------------------
// shouldRunWizard(args, env, stdin, stdout)
// ---------------------------------------------------------------------------
// This is the safety gate: it decides whether the CLI is allowed to block on
// interactive input at all. Every test here is really a test of "does a
// non-interactive LLM-agent invocation correctly avoid the wizard" — the
// single most important property of this whole feature.

function tty(isTTY) {
  return { isTTY };
}

test("shouldRunWizard: true only for bare `setup` in a real interactive terminal with no CI flag", () => {
  assert.equal(shouldRunWizard([], {}, tty(true), tty(true)), true);
});

test("shouldRunWizard: false when a positional target is given (setup claude)", () => {
  assert.equal(shouldRunWizard(["claude"], {}, tty(true), tty(true)), false);
});

test("shouldRunWizard: false when a positional target is given (setup codex)", () => {
  assert.equal(shouldRunWizard(["codex"], {}, tty(true), tty(true)), false);
});

test("shouldRunWizard: false when a positional target is given (setup both)", () => {
  assert.equal(shouldRunWizard(["both"], {}, tty(true), tty(true)), false);
});

test("shouldRunWizard: false when any flag is present even with no target (setup --dry-run)", () => {
  // args.length !== 0 here (it's ["--dry-run"]), so per the spec this must
  // NOT enter the wizard — the existing non-interactive flag-driven setup()
  // path handles it instead, and --dry-run must still take effect there.
  assert.equal(shouldRunWizard(["--dry-run"], {}, tty(true), tty(true)), false);
});

test("shouldRunWizard: false when a preset flag is present with no target (setup --preset balanced)", () => {
  assert.equal(shouldRunWizard(["--preset", "balanced"], {}, tty(true), tty(true)), false);
});

test("shouldRunWizard: false when stdin is not a TTY", () => {
  assert.equal(shouldRunWizard([], {}, tty(false), tty(true)), false);
});

test("shouldRunWizard: false when stdin.isTTY is undefined (piped/redirected stdin)", () => {
  assert.equal(shouldRunWizard([], {}, tty(undefined), tty(true)), false);
});

test("shouldRunWizard: false when stdout is not a TTY", () => {
  assert.equal(shouldRunWizard([], {}, tty(true), tty(false)), false);
});

test("shouldRunWizard: false when both stdin and stdout are non-TTY", () => {
  assert.equal(shouldRunWizard([], {}, tty(false), tty(false)), false);
});

test("shouldRunWizard: false when env.CI is truthy (\"true\")", () => {
  assert.equal(shouldRunWizard([], { CI: "true" }, tty(true), tty(true)), false);
});

test("shouldRunWizard: false when env.CI is truthy (\"1\")", () => {
  assert.equal(shouldRunWizard([], { CI: "1" }, tty(true), tty(true)), false);
});

test("shouldRunWizard: false when env.CI is the string \"false\" (still JS-truthy — must not be treated as a real boolean)", () => {
  // A naive `env.CI === "true"` guard would wrongly let this through. CI
  // systems set CI as an env var (always a string), and per the contract
  // "env.CI 不为真值" means plain JS truthiness, so the non-empty string
  // "false" must still veto the wizard.
  assert.equal(shouldRunWizard([], { CI: "false" }, tty(true), tty(true)), false);
});

test("shouldRunWizard: true when env.CI is an empty string (falsy)", () => {
  assert.equal(shouldRunWizard([], { CI: "" }, tty(true), tty(true)), true);
});

test("shouldRunWizard: true when env.CI is undefined", () => {
  assert.equal(shouldRunWizard([], {}, tty(true), tty(true)), true);
});

test("shouldRunWizard: false when a target AND non-TTY both apply (belt and suspenders)", () => {
  assert.equal(shouldRunWizard(["claude"], { CI: "1" }, tty(false), tty(false)), false);
});

// ---------------------------------------------------------------------------
// runSetupWizard(options) — Q&A flow
// ---------------------------------------------------------------------------
// We never touch a real TTY: `input`/`output` are injected PassThrough
// streams, fully pre-buffered with every line the fake "user" will ever
// type, `end()`-ed immediately. Because the wizard is expected to consume
// its questions one at a time via readline, this is a deterministic,
// non-flaky way to drive multi-question flows without any real waiting.

// Builds a fake input stream from an ordered list of "typed lines". Extra
// trailing blank lines are harmless padding: if a later question in the
// flow (Q2, Q3) isn't reached for a given scenario, those lines are simply
// never consumed.
function fakeInput(lines) {
  const input = new PassThrough();
  input.end(`${lines.join("\n")}\n`);
  return input;
}

function fakeOutput() {
  const output = new PassThrough();
  output.resume(); // drain and discard whatever the wizard writes
  return output;
}

// No saved custom Codex preferences: config.codex has neither status_line
// nor terminal_title. Used as the default loadConfig mock so Q2 (when
// reached) starts from the "no custom preset saved" branch (default option:
// balanced) rather than the "keep existing" branch, unless a test
// deliberately overrides loadConfig to exercise that branch.
async function loadConfigNoCustom() {
  return { config: { codex: {} } };
}

const FAST_TIMEOUT_MS = 2_000;

async function runWizard(lines, overrides = {}) {
  return runSetupWizard({
    input: fakeInput(lines),
    output: fakeOutput(),
    questionTimeoutMs: FAST_TIMEOUT_MS,
    loadConfig: loadConfigNoCustom,
    ...overrides,
  });
}

// --- Q1: platform selection -------------------------------------------------
// Every case below pads with two extra blank lines ("", "") so that
// whichever of Q2/Q3 follow, they get their own default answer regardless of
// whether Q2 ends up being asked for that particular target.

const Q1_CASES = [
  { name: "empty input (bare enter) defaults to both", answer: "", expected: "both" },
  { name: "\"1\" selects codex only", answer: "1", expected: "codex" },
  { name: "\"2\" selects claude only", answer: "2", expected: "claude" },
  { name: "\"2,1\" (reverse order) selects both", answer: "2,1", expected: "both" },
  { name: "\"1, 2\" (space after comma) selects both", answer: "1, 2", expected: "both" },
  { name: "\"1,,2\" (empty middle segment) selects both", answer: "1,,2", expected: "both" },
  { name: "\"1,1\" (duplicate) dedupes to codex only", answer: "1,1", expected: "codex" },
];

for (const { name, answer, expected } of Q1_CASES) {
  test(`runSetupWizard Q1: ${name}`, { timeout: 5_000 }, async () => {
    const result = await runWizard([answer, "", ""]);
    assert.notEqual(result, null, "wizard should have completed (default Y at the final confirm), not been cancelled");
    assert.equal(result.target, expected);
  });
}

test("runSetupWizard Q1: one illegal answer (\"3\") then a legal one (\"1\") re-asks once and uses the legal answer", { timeout: 5_000 }, async () => {
  const result = await runWizard(["3", "1", "", ""]);
  assert.notEqual(result, null);
  assert.equal(result.target, "codex");
});

test("runSetupWizard Q1: an out-of-range number mixed with a valid one (\"1,3\") is rejected as a WHOLE answer, not partially accepted", { timeout: 5_000 }, async () => {
  // "1,3" must be treated as entirely illegal (re-asked), never silently
  // collapsed down to just "1". We prove this by having the *next* line be
  // "2" (claude) — if the buggy behavior of "keep the valid part" were in
  // effect, the first line alone would already resolve to target "codex"
  // and "2" would never be consumed as the re-ask answer, so the final
  // target would wrongly be "codex" instead of "claude".
  const result = await runWizard(["1,3", "2", "", ""]);
  assert.notEqual(result, null);
  assert.equal(result.target, "claude");
});

test("runSetupWizard Q1: non-numeric garbage (\"codex\") is rejected and re-asked", { timeout: 5_000 }, async () => {
  const result = await runWizard(["codex", "2", "", ""]);
  assert.notEqual(result, null);
  assert.equal(result.target, "claude");
});

test("runSetupWizard Q1: an answer that parses to an empty set (\",\") is rejected and re-asked", { timeout: 5_000 }, async () => {
  const result = await runWizard([",", "1", "", ""]);
  assert.notEqual(result, null);
  assert.equal(result.target, "codex");
});

test("runSetupWizard Q1: 4 consecutive illegal answers fall back to the default (\"both\") without hanging or asking a 5th time", { timeout: 5_000 }, async () => {
  // 1 initial ask + 3 re-asks = 4 total asks allowed. All 4 are illegal here,
  // so the wizard must give up and proceed with the default rather than
  // asking indefinitely. The two trailing "" lines are for Q2 (default) and
  // Q3 (default confirm) since target "both" triggers Q2.
  const result = await runWizard(["1,3", "x", ",", "?", "", ""]);
  assert.notEqual(result, null, "wizard should still complete via the fallback default, not hang or abort");
  assert.equal(result.target, "both");
});

// --- Q2: Codex preset selection ---------------------------------------------
// Only asked when target includes "codex" (i.e. target is "codex" or
// "both"). Mapping designed for this feature (see final report for the full
// write-up handed to the implementer):
//   - No saved custom preset:      [1] balanced  [2] compact  [3] full   (default 1)
//   - Saved custom preset exists:  [1] keep existing  [2] balanced  [3] compact  [4] full  (default 1)

test("runSetupWizard Q2: skipped entirely when target is claude-only — preset is null", { timeout: 5_000 }, async () => {
  const result = await runWizard(["2", "unused-because-q2-is-skipped", ""], {
    // If Q2 were (incorrectly) asked here, this loadConfig would be queried;
    // make it throw so an accidental Q2 call fails the test loudly instead
    // of silently consuming the "unused-because-q2-is-skipped" line as an
    // (invalid) Q2 answer and masking the bug.
    loadConfig: async () => {
      throw new Error("loadConfig must not be called when Q2 is skipped (target=claude)");
    },
  });
  assert.notEqual(result, null);
  assert.equal(result.target, "claude");
  assert.equal(result.options.preset, null);
});

test("runSetupWizard Q2: no saved custom preset — default (bare enter) resolves to \"balanced\"", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1", "", ""], { loadConfig: loadConfigNoCustom });
  assert.notEqual(result, null);
  assert.equal(result.target, "codex");
  assert.equal(result.options.preset, "balanced");
});

test("runSetupWizard Q2: no saved custom preset — explicit \"2\" resolves to \"compact\"", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1", "2", ""], { loadConfig: loadConfigNoCustom });
  assert.notEqual(result, null);
  assert.equal(result.options.preset, "compact");
});

test("runSetupWizard Q2: no saved custom preset — explicit \"3\" resolves to \"full\"", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1", "3", ""], { loadConfig: loadConfigNoCustom });
  assert.notEqual(result, null);
  assert.equal(result.options.preset, "full");
});

test("runSetupWizard Q2: saved custom preset (status_line) present — default (bare enter) means \"keep existing\" (preset: null)", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1", "", ""], {
    loadConfig: async () => ({ config: { codex: { status_line: ["model"] } } }),
  });
  assert.notEqual(result, null);
  assert.equal(result.target, "codex");
  assert.equal(result.options.preset, null, "keeping the existing custom preset must mean preset:null, not a preset name");
});

test("runSetupWizard Q2: saved custom preset (terminal_title) present also triggers the \"keep existing\" default branch", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1", "", ""], {
    loadConfig: async () => ({ config: { codex: { terminal_title: ["spinner"] } } }),
  });
  assert.notEqual(result, null);
  assert.equal(result.options.preset, null);
});

test("runSetupWizard Q2: saved custom preset present but user explicitly picks \"3\" (compact) — overrides the keep-existing default", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1", "3", ""], {
    loadConfig: async () => ({ config: { codex: { status_line: ["model"] } } }),
  });
  assert.notEqual(result, null);
  assert.equal(result.options.preset, "compact");
});

test("runSetupWizard Q2: saved custom preset present, user picks \"2\" (balanced) — overrides the keep-existing default", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1", "2", ""], {
    loadConfig: async () => ({ config: { codex: { status_line: ["model"] } } }),
  });
  assert.notEqual(result, null);
  assert.equal(result.options.preset, "balanced");
});

test("runSetupWizard Q2: target both also triggers Q2 (not just target codex)", { timeout: 5_000 }, async () => {
  const result = await runWizard(["", "2", ""], { loadConfig: loadConfigNoCustom });
  assert.notEqual(result, null);
  assert.equal(result.target, "both");
  assert.equal(result.options.preset, "compact");
});

test("runSetupWizard: loadConfig is invoked with the injected home", { timeout: 5_000 }, async () => {
  const seenArgs = [];
  const result = await runWizard(["1", "", ""], {
    home: "/fake/home/for/wizard/test",
    loadConfig: async (args) => {
      seenArgs.push(args);
      return { config: { codex: {} } };
    },
  });
  assert.notEqual(result, null);
  assert.equal(seenArgs.length, 1);
  assert.equal(seenArgs[0].home, "/fake/home/for/wizard/test");
});

// --- Q3: final confirmation -------------------------------------------------

test("runSetupWizard Q3: bare enter (default Y) proceeds and returns {target, options}", { timeout: 5_000 }, async () => {
  const result = await runWizard(["2", ""]); // target=claude, Q2 skipped, Q3 default
  assert.notEqual(result, null);
  assert.equal(result.target, "claude");
  assert.equal(typeof result.options, "object");
});

test("runSetupWizard Q3: explicit \"y\" proceeds", { timeout: 5_000 }, async () => {
  const result = await runWizard(["2", "y"]);
  assert.notEqual(result, null);
  assert.equal(result.target, "claude");
});

test("runSetupWizard Q3: explicit \"Y\" (uppercase) proceeds", { timeout: 5_000 }, async () => {
  const result = await runWizard(["2", "Y"]);
  assert.notEqual(result, null);
});

test("runSetupWizard Q3: \"n\" cancels — returns null", { timeout: 5_000 }, async () => {
  const result = await runWizard(["2", "n"]);
  assert.equal(result, null);
});

test("runSetupWizard Q3: \"N\" (uppercase) cancels — returns null", { timeout: 5_000 }, async () => {
  const result = await runWizard(["2", "N"]);
  assert.equal(result, null);
});

// --- overall return shape ----------------------------------------------------

test("runSetupWizard: successful run returns the exact documented shape (dryRun:false, config:undefined, home passed through)", { timeout: 5_000 }, async () => {
  const result = await runWizard(["1,2", "1", ""], { home: "/h" });
  assert.notEqual(result, null);
  assert.deepEqual(result, {
    target: "both",
    options: { dryRun: false, preset: "balanced", config: undefined, home: "/h" },
  });
});

// ---------------------------------------------------------------------------
// Timeout / abort behavior
// ---------------------------------------------------------------------------
// A wizard question must never wait forever. If nothing is ever written to
// `input` (and it's never closed), the wizard must give up on its own after
// questionTimeoutMs and reject with an identifiable timeout error — this is
// the in-process unit-level counterpart to the e2e "must never hang" test in
// test/e2e/run.mjs.

test("runSetupWizard: a question that never receives input rejects with an AbortError after questionTimeoutMs, instead of hanging", { timeout: 3_000 }, async () => {
  const neverEndingInput = new PassThrough(); // never written to, never end()-ed
  await assert.rejects(
    runSetupWizard({
      input: neverEndingInput,
      output: fakeOutput(),
      questionTimeoutMs: 30,
      loadConfig: loadConfigNoCustom,
    }),
    (error) => {
      assert.equal(error.name, "AbortError", `expected error.name "AbortError", got "${error.name}": ${error.message}`);
      return true;
    },
  );
});

test("runSetupWizard: the timeout is per-question — a slow-but-eventually-answered Q1 does not doom a fast Q3", { timeout: 3_000 }, async () => {
  // This is a weaker, best-effort test of "per question, not one global
  // deadline": Q1 is answered immediately (well within a 200ms budget), so
  // even with a fairly tight questionTimeoutMs the whole flow should still
  // complete rather than accumulating elapsed time across questions and
  // timing out later on Q3 despite Q3 itself also being answered promptly.
  const result = await runSetupWizard({
    input: fakeInput(["2", ""]), // target=claude (skips Q2), then Q3 default
    output: fakeOutput(),
    questionTimeoutMs: 200,
    loadConfig: loadConfigNoCustom,
  });
  assert.notEqual(result, null);
  assert.equal(result.target, "claude");
});

// ---------------------------------------------------------------------------
// SIGINT
// ---------------------------------------------------------------------------
// Deliberately NOT unit-tested here: actually delivering SIGINT to this
// process would tear down the `node --test` runner itself, so there is no
// safe way to exercise real signal delivery at this layer. The behavioral
// requirement ("Ctrl-C during the wizard exits cleanly, does not hang") is
// covered at the process level instead — see the bare `ahud setup` e2e
// regression test added to test/e2e/run.mjs, and test C in that same file
// (which already proves `ahud watch`'s SIGINT handling end-to-end and is the
// established pattern this project uses for signal-handling coverage).
