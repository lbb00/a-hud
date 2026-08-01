import assert from "node:assert/strict";
import test from "node:test";
import {
  patchAntigravityHooks,
  patchAntigravitySettings,
  patchClaudeSettings,
  patchCodexConfig,
  patchCursorConfig,
  patchCursorHooks,
} from "../dist/setup.js";

test("patches Codex TUI while preserving unrelated config", () => {
  const result = patchCodexConfig(`model = "gpt-test"

[tui]
animations = false
status_line = ["model"]

[features]
hooks = true
`, "balanced");
  assert.match(result, /model = "gpt-test"/);
  assert.match(result, /status_line = \["model-with-reasoning"/);
  assert.doesNotMatch(result, /five-hour-limit/);
  assert.match(
    result,
    /status_line = \["model-with-reasoning", "used-tokens", "context-used", "weekly-limit"/,
  );
  assert.match(result, /animations = false/);
  assert.match(result, /\[features\]\n hooks = true|\[features\]\nhooks = true/);
  assert.equal((result.match(/^status_line\s*=/gm) || []).length, 1);
});

test("patches Claude settings without removing existing hooks", () => {
  const result = JSON.parse(patchClaudeSettings(
    JSON.stringify({ hooks: { Stop: [] }, model: "sonnet" }),
    "/usr/bin/node",
    "/plugin/dist/cli.js",
    "linux",
  ));
  assert.equal(result.model, "sonnet");
  assert.deepEqual(result.hooks, { Stop: [] });
  assert.equal(result.statusLine.type, "command");
  assert.match(result.statusLine.command, /\/plugin\/dist\/cli\.js/);
  assert.equal(result.statusLine.refreshInterval, 5);
});

test("shell-quotes Claude statusline paths without expanding repository text", () => {
  const result = JSON.parse(patchClaudeSettings(
    "{}",
    "/tmp/node$HOME",
    "/plugin/it's `not executed`/cli.js",
    "linux",
  ));
  assert.equal(
    result.statusLine.command,
    "'/tmp/node$HOME' '/plugin/it'\"'\"'s `not executed`/cli.js' statusline",
  );
});

test("encodes Windows statusline paths outside cmd expansion", () => {
  const result = JSON.parse(patchClaudeSettings(
    "{}",
    "C:\\Program Files\\node%TEMP%&.exe",
    "C:\\plugin\\it's ^ risky|<cli>.js",
    "win32",
  ));
  assert.match(
    result.statusLine.command,
    /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /,
  );
  const encoded = result.statusLine.command.split(" ").at(-1);
  assert.equal(
    Buffer.from(encoded, "base64").toString("utf16le"),
    "& 'C:\\Program Files\\node%TEMP%&.exe' 'C:\\plugin\\it''s ^ risky|<cli>.js' statusline",
  );
  assert.doesNotMatch(result.statusLine.command, /Program Files|%TEMP%|risky/);
});

test("inserts the Codex parent TUI table before existing child tables", () => {
  const result = patchCodexConfig(`[tui.model_availability_nux]
"gpt-test" = 1
`, "compact");
  assert.ok(result.indexOf("[tui]") < result.indexOf("[tui.model_availability_nux]"));
});

test("omits the unavailable Codex five-hour item from every preset", () => {
  for (const preset of ["compact", "balanced", "full"]) {
    assert.doesNotMatch(patchCodexConfig("", preset), /five-hour-limit/);
  }
});

test("replaces a multiline Codex status array without leaving invalid fragments", () => {
  const result = patchCodexConfig(`[tui]
status_line = [
  "model",
  "context-used",
]
terminal_title = [
  "project",
]
animations = false
`, "balanced");
  assert.equal((result.match(/^status_line\s*=/gm) || []).length, 1);
  assert.equal((result.match(/^terminal_title\s*=/gm) || []).length, 1);
  assert.doesNotMatch(result, /^\s+"(?:model|context-used|project)",?$/m);
  assert.match(result, /animations = false/);
});

test("does not mistake a nested array row for the end of the tui table", () => {
  const result = patchCodexConfig(`[tui]
alert_sounds = [
  ["bell"]
]
status_line = ["old"]
animations = false

[features]
hooks = true
`, "balanced");
  assert.equal((result.match(/^status_line\s*=/gm) || []).length, 1);
  assert.match(result, /alert_sounds = \[\n  \["bell"\]\n\]/);
  assert.match(result, /animations = false/);
  assert.match(result, /\[features\]\nhooks = true/);
});

test("recognizes a whitespace-padded tui table header", () => {
  const result = patchCodexConfig(`[ tui ]
status_line = ["old"]
animations = false
`, "compact");
  assert.equal((result.match(/^\s*\[\s*tui\s*\]\s*$/gm) || []).length, 1);
  assert.equal((result.match(/^status_line\s*=/gm) || []).length, 1);
  assert.match(result, /animations = false/);
});

test("patches Cursor's native statusLine schema without losing CLI settings", () => {
  const result = JSON.parse(patchCursorConfig(
    JSON.stringify({
      version: 1,
      model: { modelId: "grok-4.5" },
      permissions: { allow: ["Shell(git)"], deny: [] },
    }),
    "/usr/bin/node",
    "/plugin/dist/cli.js",
    "linux",
  ));
  assert.equal(result.model.modelId, "grok-4.5");
  assert.deepEqual(result.permissions.allow, ["Shell(git)"]);
  assert.deepEqual(result.statusLine, {
    type: "command",
    command: "'/usr/bin/node' '/plugin/dist/cli.js' statusline",
    padding: 0,
    updateIntervalMs: 1_000,
    timeoutMs: 2_000,
  });
});

test("merges idempotent Cursor hooks while preserving existing integrations", () => {
  const original = JSON.stringify({
    version: 1,
    hooks: {
      stop: [{ command: "/opt/codeisland --event stop" }],
      preToolUse: [{ command: "./rtk.sh", matcher: "Shell" }],
    },
  });
  const once = patchCursorHooks(original, "/usr/bin/node", "/plugin/dist/cli.js", "linux");
  const twice = patchCursorHooks(once, "/usr/bin/node", "/plugin/dist/cli.js", "linux");
  const parsed = JSON.parse(twice);
  assert.ok(parsed.hooks.stop.some((hook) => hook.command.includes("codeisland")));
  assert.ok(parsed.hooks.preToolUse.some((hook) => hook.command === "./rtk.sh"));
  for (const [event, hooks] of Object.entries(parsed.hooks)) {
    if (![
      "sessionStart",
      "beforeSubmitPrompt",
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "subagentStart",
      "subagentStop",
      "stop",
      "sessionEnd",
    ].includes(event)) continue;
    assert.equal(
      hooks.filter((hook) =>
        hook.command?.includes("hook --platform cursor --event")).length,
      1,
      event,
    );
  }
});

test("patches Antigravity statusline and owns only its namespaced hooks", () => {
  const settings = JSON.parse(patchAntigravitySettings(
    JSON.stringify({ model: "Gemini", enableTelemetry: false }),
    "/usr/bin/node",
    "/plugin/dist/cli.js",
    "linux",
  ));
  assert.equal(settings.model, "Gemini");
  assert.equal(settings.enableTelemetry, false);
  assert.equal(
    settings.statusLine.command,
    "'/usr/bin/node' '/plugin/dist/cli.js' statusline",
  );

  const hooks = JSON.parse(patchAntigravityHooks(
    JSON.stringify({ codeisland: { Stop: [] } }),
    "/usr/bin/node",
    "/plugin/dist/cli.js",
    "linux",
  ));
  assert.deepEqual(hooks.codeisland, { Stop: [] });
  assert.equal(hooks["agent-hud"].PreToolUse[0].matcher, "*");
  assert.match(
    hooks["agent-hud"].Stop[0].command,
    /hook --platform antigravity --event Stop/,
  );
  assert.deepEqual(
    JSON.parse(patchAntigravityHooks(
      JSON.stringify(hooks),
      "/usr/bin/node",
      "/plugin/dist/cli.js",
      "linux",
    )),
    hooks,
  );
});
