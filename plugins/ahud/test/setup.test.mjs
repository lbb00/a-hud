import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_PRESETS, patchClaudeSettings, patchCodexConfig, setupClaude, setupCodex } from "../src/setup.mjs";
// Imported as a namespace (rather than `import { posixQuote, resolveCodexFields }`)
// on purpose: posixQuote/resolveCodexFields do not exist yet (or in
// resolveCodexFields's case, is Phase 1's new export), and a static named
// import of a missing export would throw a SyntaxError at module-load time,
// taking every other (currently passing) test in this file down with it.
// Accessing them off the namespace object instead means only the tests that
// actually call them fail.
import * as setupModule from "../src/setup.mjs";
const { posixQuote, resolveCodexFields } = setupModule;

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ahud-setup-"));
}

test("patches Codex TUI while preserving unrelated config", () => {
  const result = patchCodexConfig(`model = "gpt-test"

[tui]
animations = false
status_line = ["model"]

[features]
hooks = true
`, CODEX_PRESETS.balanced);
  assert.match(result, /model = "gpt-test"/);
  assert.match(result, /status_line = \["model-with-reasoning"/);
  assert.match(result, /animations = false/);
  assert.match(result, /\[features\]\n hooks = true|\[features\]\nhooks = true/);
  assert.equal((result.match(/^status_line\s*=/gm) || []).length, 1);
});

test("patches Claude settings without removing existing hooks", () => {
  const result = JSON.parse(patchClaudeSettings(
    JSON.stringify({ hooks: { Stop: [] }, model: "sonnet" }),
    { executable: "/usr/bin/node", cliPath: "/plugin/src/cli.mjs" },
  ));
  assert.equal(result.model, "sonnet");
  assert.deepEqual(result.hooks, { Stop: [] });
  assert.equal(result.statusLine.type, "command");
  assert.match(result.statusLine.command, /\/plugin\/src\/cli\.mjs/);
});

test("inserts the Codex parent TUI table before existing child tables", () => {
  const result = patchCodexConfig(`[tui.model_availability_nux]
"gpt-test" = 1
`, CODEX_PRESETS.compact);
  assert.ok(result.indexOf("[tui]") < result.indexOf("[tui.model_availability_nux]"));
});

// NOTE: we intentionally skip a scenario where a multi-line array item itself
// contains an escaped quote (e.g. "a\"b") — TOML string-escape-aware parsing
// of arbitrary array contents is out of scope for this line-based patcher;
// the behavioral bug we're pinning down here is about *line accounting*
// around a multi-line array, not about escaping inside string literals.

test("removes multi-line TOML array remnants when patching [tui] (trailing-comma style)", () => {
  const before = `title = "cfg"

[tui]
status_line = [
  "model",
  "git-branch",
]
status_line_use_colors = false

[other]
foo = 1
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.balanced);
  const lines = result.split("\n");
  // No orphaned continuation lines from the old multi-line array should survive.
  assert.ok(!lines.some((line) => line.trim() === `"model",`), "leftover \"model\", line");
  assert.ok(!lines.some((line) => line.trim() === `"git-branch",`), "leftover \"git-branch\", line");
  assert.ok(!lines.some((line) => line.trim() === "]"), "leftover orphaned ] line");
  // [tui] was replaced with the new preset's tool list.
  assert.match(result, /status_line = \["model-with-reasoning", "context-used"/);
  // [other] is untouched and still present exactly once.
  assert.match(result, /\[other\]\n\s*foo = 1/);
  assert.equal((result.match(/^\[tui\]$/gm) || []).length, 1);
  assert.equal((result.match(/^\[other\]$/gm) || []).length, 1);
});

test("removes multi-line TOML array remnants when patching [tui] (closing bracket on last item's line)", () => {
  const before = `[tui]
status_line = [
  "model",
  "git-branch"]
status_line_use_colors = false

[other]
foo = 1
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  const lines = result.split("\n");
  assert.ok(!lines.some((line) => line.trim() === `"model",`));
  assert.ok(!lines.some((line) => line.trim() === `"git-branch"]`));
  assert.match(result, /\[other\]\n\s*foo = 1/);
  assert.equal((result.match(/^\[tui\]$/gm) || []).length, 1);
});

test("removes remnants from multiple multi-line arrays in [tui]", () => {
  const before = `[tui]
status_line = [
  "model",
  "git-branch",
]
terminal_title = [
  "spinner",
  "project",
]
status_line_use_colors = false

[other]
foo = 1
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.balanced);
  const lines = result.split("\n");
  assert.ok(!lines.some((line) => line.trim() === `"spinner",`));
  assert.ok(!lines.some((line) => line.trim() === `"project",`));
  assert.match(result, /\[other\]\n\s*foo = 1/);
  assert.equal((result.match(/^\[tui\]$/gm) || []).length, 1);
});

test("removes a status_line line even when it carries a trailing comment containing a stray bracket (regression)", () => {
  const before = `[tui]
status_line = ["model"] # keep this short [wip]
other_setting = true

[other]
foo = 1
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.ok(!result.includes("keep this short"));
  assert.match(result, /other_setting = true/);
  assert.match(result, /\[other\]\n\s*foo = 1/);
});

test("replaces a hand-quoted status_line key instead of leaving a duplicate, invalid-TOML remnant (regression)", () => {
  const before = `[tui]
"status_line" = ["model"]
other_setting = true
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  // Exactly one status_line assignment must survive — the quoted original
  // must have been recognized and replaced, not kept alongside the new
  // unquoted one (which would produce two competing definitions of the
  // same key, invalid TOML).
  assert.equal((result.match(/status_line\s*=/g) || []).length, 1);
  assert.ok(!result.includes('"status_line" ='));
  assert.match(result, /other_setting = true/);
});

test("replaces a hand-quoted terminal_title key using single-quote (literal string) syntax too", () => {
  const before = `[tui]
'terminal_title' = ["spinner"]
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.equal((result.match(/terminal_title\s*=/g) || []).length, 1);
  assert.ok(!result.includes("'terminal_title' ="));
});

test("recognizes a quoted [tui] table header (`[\"tui\"]`) instead of appending a duplicate section (regression)", () => {
  const before = `["tui"]
status_line = ["model"]
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.equal((result.match(/^\["?tui"?\]$/gm) || []).length, 1);
});

test("recognizes a single-quoted [tui] table header (`['tui']`) too", () => {
  const before = `['tui']
status_line = ["model"]
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.equal((result.match(/^\['?tui'?\]$/gm) || []).length, 1);
});

test("refuses to rewrite an inline-table [tui] (`tui = { ... }`) instead of appending a duplicate, invalid definition (regression)", () => {
  const before = `tui = { status_line = ["model"], terminal_title = ["project"], status_line_use_colors = false }
`;
  assert.throws(() => patchCodexConfig(before, CODEX_PRESETS.compact), /inline table/);
});

test("refuses a quoted-key inline-table root tui (`\"tui\" = { ... }`) too (regression)", () => {
  const before = `"tui" = { status_line = ["old"], terminal_title = ["old"] }
`;
  assert.throws(() => patchCodexConfig(before, CODEX_PRESETS.compact), /inline table/);
});

test("refuses a dotted-key root tui (`tui.status_line = [...]`) too (regression)", () => {
  const before = `tui.status_line = ["old"]
tui.terminal_title = ["old"]
`;
  assert.throws(() => patchCodexConfig(before, CODEX_PRESETS.compact), /inline table/);
});

test("does NOT refuse when 'tui' is a key nested inside an unrelated table, e.g. [other] (regression — false-positive fix)", () => {
  const before = `[other]
tui = { keep = 1 }
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.match(result, /\[other\]/);
  assert.match(result, /tui = \{ keep = 1 \}/);
  assert.match(result, /^\[tui\]$/m);
});

test("a quoted table header whose name itself contains ']' does not get swallowed into [tui]'s body (regression)", () => {
  const before = `[tui]
status_line = ["old"]

["other]table"]
status_line = ["must-survive"]
keep = 7
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.match(result, /\["other\]table"\]/);
  assert.match(result, /status_line = \["must-survive"\]/);
  assert.match(result, /keep = 7/);
});

test("patchCodexConfig is idempotent when the input already had a multi-line array remnant", () => {
  const before = `[tui]
status_line = [
  "model",
  "git-branch",
]
status_line_use_colors = false

[other]
foo = 1
`;
  const once = patchCodexConfig(before, CODEX_PRESETS.balanced);
  const twice = patchCodexConfig(once, CODEX_PRESETS.balanced);
  assert.equal(twice, once);
  assert.equal((twice.match(/^\[tui\]$/gm) || []).length, 1);
  assert.equal((twice.match(/^\[other\]$/gm) || []).length, 1);
  assert.match(twice, /\[other\]\n\s*foo = 1/);
});

test("patchCodexConfig does not desync bracket-depth counting on a literal \"#\" string VALUE inside an array (regression)", () => {
  // `["model", "#"]` contains a literal "#" array element, not a comment.
  // A comment/quote-unaware bracket counter risks mistaking it for the
  // start of a comment (or otherwise mis-scanning it), which can desync
  // the bracket-depth counter used to detect (and skip) a multi-line array
  // continuation, corrupting/deleting unrelated following settings such as
  // `other_setting = true`.
  const before = `[tui]
status_line = ["model", "#"]
other_setting = true
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.match(result, /other_setting = true/, "an unrelated setting after the quoted \"#\" must survive");
  assert.match(result, /status_line = \["model-with-reasoning"/);
  assert.equal((result.match(/^\[tui\]$/gm) || []).length, 1);
});

test("patchCodexConfig does not desync bracket-depth counting on a stray unquoted \"[\" inside a trailing comment (regression — reproduces against the prior quote-unaware bracketDelta)", () => {
  // The array closes on this line (`["model"]`), but the trailing comment
  // itself contains an unquoted "[" with no matching "]" on the same line.
  // A bracket counter that doesn't stop scanning at the (unquoted) "#"
  // comment marker counts that stray "[" too, making net bracket depth > 0
  // after this line and wrongly treating the next line as an array
  // continuation to skip — deleting it. This exact input reproducibly
  // deletes `other_setting = true` against the prior implementation.
  const before = `[tui]
status_line = ["model"]  # e.g. [tag
other_setting = true
`;
  const result = patchCodexConfig(before, CODEX_PRESETS.compact);
  assert.match(result, /other_setting = true/, "a setting after a comment containing a stray \"[\" must survive");
  assert.equal((result.match(/^\[tui\]$/gm) || []).length, 1);
});

test("posixQuote wraps a value in single quotes, escaping embedded single quotes POSIX-style", () => {
  assert.equal(posixQuote("it's"), "'it'\\''s'");
  assert.equal(posixQuote("plain"), "'plain'");
  assert.equal(posixQuote(""), "''");
});

test("posixQuote round-trips tricky strings through a real POSIX shell unharmed", () => {
  const cases = [
    "$HOME",
    "`whoami`",
    '"double quoted"',
    "has space",
    "it's got a quote",
    "a;b",
    "$(rm -rf /)",
    "back\\slash",
  ];
  for (const value of cases) {
    const quoted = posixQuote(value);
    const output = execFileSync("sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
    assert.equal(output, value, `round-trip failed for: ${value}`);
  }
});

test("patchClaudeSettings throws on a JSON array settings file instead of silently no-oping (regression)", () => {
  // JSON.stringify drops non-index properties from an array, so setting
  // parsed.statusLine on an array would round-trip back to the exact same
  // text — writeWithBackup would then see content === original and report
  // "already configured" despite statusLine never having been set.
  assert.throws(() => patchClaudeSettings("[]"), /must be a JSON object/);
  assert.throws(() => patchClaudeSettings("[1, 2, 3]"), /must be a JSON object/);
});

test("patchClaudeSettings builds statusLine.command from posixQuote, not JSON.stringify", () => {
  const executable = "/usr/bin/node$HOME";
  const cliPath = "/plugin/src/cli.mjs";
  const result = JSON.parse(patchClaudeSettings("{}", { executable, cliPath }));
  const expected = `${posixQuote(executable)} ${posixQuote(cliPath)} statusline`;
  assert.equal(result.statusLine.command, expected);
  const oldUnsafeStyle = `${JSON.stringify(executable)} ${JSON.stringify(cliPath)} statusline`;
  assert.notEqual(result.statusLine.command, oldUnsafeStyle);
});

test("patchClaudeSettings's generated command line does not let the shell expand $HOME", () => {
  const executable = "/usr/bin/node";
  const cliPath = "$HOME/evil/cli.mjs";
  const result = JSON.parse(patchClaudeSettings("{}", { executable, cliPath }));
  const probe = `set -- ${result.statusLine.command}; printf '%s' "$2"`;
  const output = execFileSync("sh", ["-c", probe], { encoding: "utf8" });
  assert.equal(output, cliPath);
});

// ---------------------------------------------------------------------------
// Phase 1: resolveCodexFields (new export) — the three-state preset/config/
// default resolution that everything else in this section builds on.
// ---------------------------------------------------------------------------

test("resolveCodexFields: preset=null and no saved codex prefs -> source 'default', fields === CODEX_PRESETS.balanced", () => {
  const config = { codex: { status_line: null, terminal_title: null } };
  const result = resolveCodexFields(null, config);
  assert.equal(result.source, "default");
  assert.deepEqual(result.fields, CODEX_PRESETS.balanced);
});

test("resolveCodexFields: preset=null and a saved status_line -> source 'config', using the saved value and independently falling back to balanced's terminal_title", () => {
  const config = { codex: { status_line: ["custom-a", "custom-b"], terminal_title: null } };
  const result = resolveCodexFields(null, config);
  assert.equal(result.source, "config");
  assert.deepEqual(result.fields.status_line, ["custom-a", "custom-b"]);
  assert.deepEqual(result.fields.terminal_title, CODEX_PRESETS.balanced.terminal_title);
});

test("resolveCodexFields: preset=null and both codex fields saved -> source 'config', both taken from the saved config verbatim", () => {
  const config = { codex: { status_line: ["a"], terminal_title: ["b"] } };
  const result = resolveCodexFields(null, config);
  assert.equal(result.source, "config");
  assert.deepEqual(result.fields, { status_line: ["a"], terminal_title: ["b"] });
});

test("resolveCodexFields: an explicit preset name -> source 'preset', fields === CODEX_PRESETS[name], even when the config has other saved prefs", () => {
  const config = { codex: { status_line: ["ignored"], terminal_title: ["ignored"] } };
  const result = resolveCodexFields("compact", config);
  assert.equal(result.source, "preset");
  assert.deepEqual(result.fields, CODEX_PRESETS.compact);
});

test("resolveCodexFields: an unknown explicit preset name throws", () => {
  const config = { codex: { status_line: null, terminal_title: null } };
  assert.throws(
    () => resolveCodexFields("no-such-preset", config),
    /Unknown Codex preset: no-such-preset/,
  );
});

// ---------------------------------------------------------------------------
// Phase 1: patchCodexConfig / patchClaudeSettings new signatures (breaking)
// ---------------------------------------------------------------------------

test("patchCodexConfig (new signature): takes a resolved fields object directly, with no internal CODEX_PRESETS lookup", () => {
  const fields = { status_line: ["custom-token"], terminal_title: ["another-token"] };
  const result = patchCodexConfig(`[tui]\nstatus_line = ["model"]\n`, fields);
  assert.match(result, /status_line = \["custom-token"\]/);
  assert.match(result, /terminal_title = \["another-token"\]/);
});

test("patchClaudeSettings (new options-object signature): honors a custom refreshInterval", () => {
  const result = JSON.parse(patchClaudeSettings("{}", { refreshInterval: 10 }));
  assert.equal(result.statusLine.refreshInterval, 10);
});

test("patchClaudeSettings (new options-object signature): defaults refreshInterval to 5 and still honors executable/cliPath", () => {
  const result = JSON.parse(patchClaudeSettings("{}", { executable: "/usr/bin/node", cliPath: "/plugin/src/cli.mjs" }));
  assert.equal(result.statusLine.refreshInterval, 5);
  assert.match(result.statusLine.command, /\/plugin\/src\/cli\.mjs/);
});

// ---------------------------------------------------------------------------
// Phase 1: setupCodex — the preset/config/default rewrite-back contract.
// Every test uses an injected `home` (a fresh mkdtemp'd dir) and an explicit
// `config` (host file path), never the real ~/.ahud, ~/.codex, or ~/.claude.
// ---------------------------------------------------------------------------

test("setupCodex: preset=null with no saved codex prefs -> fieldsSource 'default', balanced written to host, ahud config.json untouched (not even created)", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostConfig = path.join(tmp, "config.toml");
  const home = path.join(tmp, "home");

  const result = await setupCodex({ preset: null, config: hostConfig, home });

  assert.equal(result.fieldsSource, "default");
  assert.equal(result.ahudConfig, null);
  await assert.rejects(fs.access(path.join(home, ".ahud", "config.json")));
  const written = await fs.readFile(hostConfig, "utf8");
  assert.match(written, /status_line = \["model-with-reasoning"/);
});

test("setupCodex: preset=null with a saved codex preference -> fieldsSource 'config', zero rewrite calls (ahudConfig null, file byte-identical before/after)", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostConfig = path.join(tmp, "config.toml");
  const home = path.join(tmp, "home");
  const ahudConfigPath = path.join(home, ".ahud", "config.json");
  await fs.mkdir(path.dirname(ahudConfigPath), { recursive: true });
  await fs.writeFile(ahudConfigPath, JSON.stringify({
    codex: { status_line: ["saved-token"], terminal_title: ["saved-title-token"] },
  }));
  const beforeBytes = await fs.readFile(ahudConfigPath);

  const result = await setupCodex({ preset: null, config: hostConfig, home });

  assert.equal(result.fieldsSource, "config");
  assert.equal(result.ahudConfig, null, "a bare `setup codex` must never rewrite a saved preference");
  const afterBytes = await fs.readFile(ahudConfigPath);
  assert.ok(beforeBytes.equals(afterBytes), "ahud config.json must be byte-identical after a bare `setup codex` run");
  const written = await fs.readFile(hostConfig, "utf8");
  assert.match(written, /status_line = \["saved-token"\]/);
});

test("setupCodex: an explicit --preset writes the resolved fields (arrays, not the preset name) back to ~/.ahud/config.json", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostConfig = path.join(tmp, "config.toml");
  const home = path.join(tmp, "home");

  const result = await setupCodex({ preset: "compact", config: hostConfig, home });

  assert.equal(result.fieldsSource, "preset");
  assert.ok(result.ahudConfig);
  assert.equal(result.ahudConfig.changed, true);
  const saved = JSON.parse(await fs.readFile(path.join(home, ".ahud", "config.json"), "utf8"));
  assert.deepEqual(saved.codex.status_line, CODEX_PRESETS.compact.status_line);
  assert.deepEqual(saved.codex.terminal_title, CODEX_PRESETS.compact.terminal_title);
});

test("setupCodex: the first-run rewrite of ~/.ahud/config.json is sparse — only the codex key, not the full DEFAULTS", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostConfig = path.join(tmp, "config.toml");
  const home = path.join(tmp, "home");

  await setupCodex({ preset: "compact", config: hostConfig, home });

  const saved = JSON.parse(await fs.readFile(path.join(home, ".ahud", "config.json"), "utf8"));
  assert.deepEqual(Object.keys(saved), ["codex"]);
  assert.deepEqual(Object.keys(saved.codex).sort(), ["status_line", "terminal_title"]);
});

test("setupCodex: an explicit --preset is idempotent — a second identical run reports ahudConfig.changed === false", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostConfig = path.join(tmp, "config.toml");
  const home = path.join(tmp, "home");

  const first = await setupCodex({ preset: "compact", config: hostConfig, home });
  assert.equal(first.ahudConfig.changed, true);
  const second = await setupCodex({ preset: "compact", config: hostConfig, home });
  assert.equal(second.ahudConfig.changed, false);
});

test("setupCodex: --dry-run writes neither the host config.toml nor ~/.ahud/config.json, but still reports the would-be ahudConfig.content", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostConfig = path.join(tmp, "config.toml");
  const home = path.join(tmp, "home");

  const result = await setupCodex({ preset: "compact", config: hostConfig, home, dryRun: true });

  await assert.rejects(fs.access(hostConfig));
  await assert.rejects(fs.access(path.join(home, ".ahud", "config.json")));
  assert.ok(result.ahudConfig);
  const parsed = JSON.parse(result.ahudConfig.content);
  assert.deepEqual(parsed.codex.status_line, CODEX_PRESETS.compact.status_line);
});

test("setupCodex: a pre-existing invalid ~/.ahud/config.json does not throw, is left untouched, and does not block the host config.toml write", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostConfig = path.join(tmp, "config.toml");
  const home = path.join(tmp, "home");
  const ahudConfigPath = path.join(home, ".ahud", "config.json");
  await fs.mkdir(path.dirname(ahudConfigPath), { recursive: true });
  await fs.writeFile(ahudConfigPath, "{not valid json");

  const result = await setupCodex({ preset: "compact", config: hostConfig, home });

  assert.equal(result.ahudConfig, null);
  assert.equal(await fs.readFile(ahudConfigPath, "utf8"), "{not valid json");
  const written = await fs.readFile(hostConfig, "utf8");
  assert.match(written, /status_line = \["model-with-reasoning", "context-used", "five-hour-limit", "git-branch", "branch-changes"\]/);
});

test("setupCodex: --config (host file location) does not change where the ahud rewrite lands (still home/.ahud/config.json)", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const customHostConfig = path.join(tmp, "some", "custom", "location", "config.toml");
  const home = path.join(tmp, "home");

  await setupCodex({ preset: "compact", config: customHostConfig, home });

  await assert.doesNotReject(fs.access(path.join(home, ".ahud", "config.json")));
});

// ---------------------------------------------------------------------------
// Phase 1: setupClaude — refreshInterval sourced from ~/.ahud/config.json
// ---------------------------------------------------------------------------

test("setupClaude: reads claude.refreshInterval from ~/.ahud/config.json and passes it through to statusLine.refreshInterval", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const claudeSettings = path.join(tmp, "settings.json");
  const home = path.join(tmp, "home");
  const ahudConfigPath = path.join(home, ".ahud", "config.json");
  await fs.mkdir(path.dirname(ahudConfigPath), { recursive: true });
  await fs.writeFile(ahudConfigPath, JSON.stringify({ claude: { refreshInterval: 10 } }));

  await setupClaude({ config: claudeSettings, home });

  const settings = JSON.parse(await fs.readFile(claudeSettings, "utf8"));
  assert.equal(settings.statusLine.refreshInterval, 10);
});

test("setupClaude: defaults refreshInterval to 5 when ~/.ahud/config.json has no saved preference", async (t) => {
  const tmp = await mkTmp();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const claudeSettings = path.join(tmp, "settings.json");
  const home = path.join(tmp, "home");

  await setupClaude({ config: claudeSettings, home });

  const settings = JSON.parse(await fs.readFile(claudeSettings, "utf8"));
  assert.equal(settings.statusLine.refreshInterval, 5);
});
