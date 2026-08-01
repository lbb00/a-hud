import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "smol-toml";
import { CODEX_PRESETS, patchCodexConfig } from "../src/setup.mjs";

// ---------------------------------------------------------------------------
// Fixture-based regression tests: run a handful of realistic Codex
// config.toml shapes through patchCodexConfig() and confirm the output is
// (a) syntactically valid TOML per an independent parser (smol-toml, a
// small dependency-free TOML parser used here as a devDependency only —
// this project stays zero-*runtime*-dependency; smol-toml is never
// imported from src/**), and (b) the [tui] fields it wrote match the
// preset that was applied.
// ---------------------------------------------------------------------------

function assertPresetApplied(output, preset) {
  const parsed = parse(output);
  assert.deepEqual(parsed.tui.status_line, preset.status_line);
  assert.deepEqual(parsed.tui.terminal_title, preset.terminal_title);
  return parsed;
}

test("fixture: comments on/near [tui] keys are preserved and the result stays valid TOML", () => {
  const before = `# top-level comment
model = "gpt-test" # inline comment

[tui] # table comment
animations = false # keep animations off
status_line = ["model"] # old status line
status_line_use_colors = false

[features]
hooks = true
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  const parsed = assertPresetApplied(result, CODEX_PRESETS.compact);
  assert.equal(parsed.model, "gpt-test");
  assert.equal(parsed.tui.animations, false);
  assert.equal(parsed.features.hooks, true);
});

test("fixture: a pre-existing multi-line status_line array is fully replaced and the result stays valid TOML", () => {
  const before = `[tui]
status_line = [
  "model",
  "git-branch",
]
terminal_title = ["spinner"]
status_line_use_colors = true

[other]
foo = 1
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.balanced);
  const parsed = assertPresetApplied(result, CODEX_PRESETS.balanced);
  assert.equal(parsed.other.foo, 1);
});

test("fixture: a [tui.sub_table] child table survives and the result stays valid TOML", () => {
  const before = `[tui]
status_line = ["model"]

[tui.model_availability_nux]
"gpt-test" = 1

[other]
foo = 1
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.full);
  const parsed = assertPresetApplied(result, CODEX_PRESETS.full);
  assert.equal(parsed.tui.model_availability_nux["gpt-test"], 1);
  assert.equal(parsed.other.foo, 1);
});

test("fixture: a quoted [tui] table header (`[\"tui\"]`) is recognized, not duplicated, and the result stays valid TOML", () => {
  const before = `model = "gpt-test"

["tui"]
status_line = ["model"]

[other]
foo = 1
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  const parsed = assertPresetApplied(result, CODEX_PRESETS.compact);
  assert.equal(parsed.other.foo, 1);
});

test("fixture: an inline-table [tui] (`tui = { ... }`) is refused rather than producing invalid TOML with a duplicate table", () => {
  const before = `model = "gpt-test"
tui = { status_line = ["model"], terminal_title = ["project"], status_line_use_colors = false }
`;
  assert.throws(() => patchCodexConfig(before, CODEX_PRESETS.compact), /inline table/);
  // Confirm the premise: the ORIGINAL document is itself valid TOML — the
  // fix is refusing to touch a form it can't safely rewrite, not rejecting
  // malformed input.
  assert.doesNotThrow(() => parse(before));
});

test("fixture: a quoted-key inline-table root tui (`\"tui\" = { ... }`) is refused, not silently corrupted", () => {
  const before = `"tui" = { status_line = ["old"], terminal_title = ["old"] }
`;
  assert.doesNotThrow(() => parse(before), "premise: original must be valid TOML");
  assert.throws(() => patchCodexConfig(before, CODEX_PRESETS.compact), /inline table/);
});

test("fixture: a dotted-key root tui (`tui.status_line = [...]`) is refused, not silently corrupted", () => {
  const before = `tui.status_line = ["old"]
tui.terminal_title = ["old"]
`;
  assert.doesNotThrow(() => parse(before), "premise: original must be valid TOML");
  assert.throws(() => patchCodexConfig(before, CODEX_PRESETS.compact), /inline table/);
});

test("fixture: a 'tui' key nested inside an unrelated table is left alone, and a real top-level [tui] is added correctly", () => {
  const before = `[other]
tui = { keep = 1 }
`;
  assert.doesNotThrow(() => parse(before), "premise: original must be valid TOML");
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  const parsed = assertPresetApplied(result, CODEX_PRESETS.compact);
  assert.equal(parsed.other.tui.keep, 1);
});

test("fixture: a quoted table name containing ']' doesn't get swallowed into [tui]'s body", () => {
  const before = `[tui]
status_line = ["old"]

["other]table"]
status_line = ["must-survive"]
keep = 7
`;
  assert.doesNotThrow(() => parse(before), "premise: original must be valid TOML");
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  const parsed = assertPresetApplied(result, CODEX_PRESETS.compact);
  assert.deepEqual(parsed["other]table"], { status_line: ["must-survive"], keep: 7 });
});

test("fixture: CRLF line endings are preserved and the result stays valid TOML", () => {
  const before = [
    "model = \"gpt-test\"",
    "",
    "[tui]",
    "status_line = [\"model\"]",
    "status_line_use_colors = false",
    "",
    "[other]",
    "foo = 1",
    "",
  ].join("\r\n");
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assertPresetApplied(result, CODEX_PRESETS.compact);
  assert.match(result, /model = "gpt-test"/);
});
