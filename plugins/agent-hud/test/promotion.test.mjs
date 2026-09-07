import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { snapshotFromClaude } from "../dist/adapter.js";
import { renderSnapshot } from "../dist/render.js";

const OBSERVED_AT = 1_772_000_000;

function snapshot(promotion) {
  return {
    platform: "claude",
    observedAt: OBSERVED_AT,
    model: "Opus 5",
    effort: "",
    project: "agent-hud",
    cwd: "/workspace/agent-hud",
    totalInput: null,
    contextSize: null,
    turns: 0,
    context: null,
    limits: [],
    resets: [],
    git: null,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    tools: [],
    agents: [],
    plan: [],
    promotion,
  };
}

function line1(promotion) {
  return renderSnapshot(snapshot(promotion), { colors: false, activity: false })
    .split("\n")[0];
}

test("shows nothing when no promotional window is configured", () => {
  assert.doesNotMatch(line1(null), /%/);
  assert.doesNotMatch(line1(undefined), /%/);
});

test("shows the label and remaining time while a window is open", () => {
  const rendered = line1({
    id: "offpeak",
    label: "50%",
    active: true,
    changesAt: OBSERVED_AT + 4_800,
  });
  assert.match(rendered, /%50% 1h20/);
  assert.doesNotMatch(rendered, /↑/);
});

test("shows only the label for an open window that has no end date", () => {
  const rendered = line1({ id: "always", label: "50%", active: true, changesAt: null });
  assert.match(rendered, /%50%(\s|$)/);
  assert.doesNotMatch(rendered, /%50% \d/);
  // Only an open window can lack a date; a pending one always has its start.
  assert.doesNotMatch(
    line1({ id: "always", label: "50%", active: false, changesAt: null }),
    /%/,
  );
});

test("marks a window that has not opened yet with its countdown", () => {
  assert.match(
    line1({ id: "offpeak", label: "50%", active: false, changesAt: OBSERVED_AT + 7_980 }),
    /%50% ↑2h13/,
  );
  assert.match(
    line1({ id: "offpeak", label: "", active: false, changesAt: OBSERVED_AT + 2_700 }),
    /%↑45m/,
  );
  assert.match(
    line1({ id: "offpeak", label: "2x", active: false, changesAt: OBSERVED_AT + 266_400 }),
    /%2x ↑3d2h/,
  );
});

test("turns an open window green, the HUD's only non-warning color", () => {
  const rendered = renderSnapshot(
    snapshot({ id: "offpeak", label: "50%", active: true, changesAt: OBSERVED_AT + 600 }),
    { colors: true, activity: false },
  );
  assert.match(rendered, /\u001b\[32m%50% 10m\u001b\[0m/);
});

test("leaves a window that has not opened yet uncolored", () => {
  const rendered = renderSnapshot(
    snapshot({ id: "offpeak", label: "50%", active: false, changesAt: OBSERVED_AT + 600 }),
    { colors: true, activity: false },
  );
  assert.match(rendered, /%50% \u219110m/);
  assert.doesNotMatch(rendered, /\u001b\[3\dm%/);
});

const ALL_DAY = { id: "allday", label: "50%", start: "00:00", end: "23:59" };

const CLI_PATH = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "dist",
  "cli.js",
);

async function configWorkspace(windows) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-promotions-cli-"));
  const configPath = path.join(directory, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ promotions: windows }), "utf8");
  return { directory, configPath };
}

async function runPromotions(overrides = {}, windows = [ALL_DAY], args = []) {
  const { directory, configPath } = await configWorkspace(windows);
  const result = spawnSync(process.execPath, [CLI_PATH, "promotions", ...args], {
    encoding: "utf8",
    // The data dir is pinned so the shared-schedule cache is this test's own,
    // not whatever the developer's ~/.agent-hud last fetched.
    env: {
      ...process.env,
      AGENT_HUD_CONFIG: configPath,
      AGENT_HUD_DATA_DIR: directory,
      ...overrides,
    },
  });
  return { configPath, result };
}

function withoutClaudeRouting(overrides = {}) {
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_API_BASE_URL",
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  ]) delete env[name];
  delete env.NO_COLOR;
  return { ...env, ...overrides };
}

test("the promotions command reports the config and a local switchover time", async () => {
  const { configPath, result } = await runPromotions();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  // A plain substring check: a Windows path in a RegExp would read every
  // backslash as an escape and fail to match its own output.
  assert.ok(result.stdout.includes(`config: ${configPath}`), result.stdout);
  assert.match(result.stdout, /local zone: \S+/);
  assert.match(result.stdout, /filter: platform all; endpoint not provided/);
  assert.match(result.stdout, /local  allday  50%  00:00-23:59  UTC  all hosts/);
  // The switchover instant is reported in the reader's zone, never as UTC.
  assert.match(result.stdout, /now: allday (active until|starts) \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+/);
});

test("the promotions command reports the endpoint filter it actually applied", async () => {
  const window = { ...ALL_DAY, endpoints: ["api.deepseek.com"] };
  const missing = await runPromotions({}, [window], ["--platform", "claude"]);
  assert.equal(missing.result.status, 0, missing.result.stderr);
  assert.match(
    missing.result.stdout,
    /filter: platform claude; endpoint not provided \(endpoint-scoped windows excluded\)/,
  );
  assert.match(missing.result.stdout, /now: no window active or upcoming/);

  const named = await runPromotions({}, [window], [
    "--platform",
    "claude",
    "--endpoint",
    "https://API.DeepSeek.com:443/v1",
  ]);
  assert.equal(named.result.status, 0, named.result.stderr);
  assert.match(named.result.stdout, /filter: platform claude; endpoint api\.deepseek\.com/);
  assert.match(named.result.stdout, /now: allday /);

  const invalid = await runPromotions({}, [window], ["--endpoint", "http://"]);
  assert.equal(invalid.result.status, 0, invalid.result.stderr);
  assert.match(invalid.result.stdout, /filter: platform all; endpoint invalid/);
});

test("the promotions command names the shared schedule it would fetch", async () => {
  const { result } = await runPromotions();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /shared: bundled copy, not fetched yet from https:\/\/raw\.githubusercontent\.com\/\S+/,
  );
});

test("AGENT_HUD_NO_REMOTE is reported instead of a fetch", async () => {
  const { result } = await runPromotions({ AGENT_HUD_NO_REMOTE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shared: bundled copy \(AGENT_HUD_NO_REMOTE is set\)/);
});

test("the built Claude status line matches a window to its actual API", async () => {
  const { directory, configPath } = await configWorkspace([ALL_DAY]);
  // Every other test here injects a promotion straight into the renderer, so
  // this is the only one that fails if the CLI stops reading the config at all.
  const result = spawnSync(process.execPath, [CLI_PATH, "statusline"], {
    encoding: "utf8",
    input: JSON.stringify({
      model: { display_name: "Opus 5" },
      workspace: { current_dir: directory },
    }),
    env: withoutClaudeRouting({
      AGENT_HUD_CONFIG: configPath,
      AGENT_HUD_DATA_DIR: directory,
      AGENT_HUD_NO_REMOTE: "1",
      NO_COLOR: "1",
      COLUMNS: "200",
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split("\n")[0], /%50% /);

  const endpointWindow = { ...ALL_DAY, endpoints: ["api.deepseek.com"] };
  const routed = await configWorkspace([endpointWindow]);
  const deepseek = spawnSync(process.execPath, [CLI_PATH, "statusline"], {
    encoding: "utf8",
    input: JSON.stringify({
      model: { display_name: "DeepSeek" },
      workspace: { current_dir: routed.directory },
    }),
    env: withoutClaudeRouting({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/v1",
      AGENT_HUD_CONFIG: routed.configPath,
      AGENT_HUD_DATA_DIR: routed.directory,
      AGENT_HUD_NO_REMOTE: "1",
      NO_COLOR: "1",
      COLUMNS: "200",
    }),
  });
  assert.equal(deepseek.status, 0, deepseek.stderr);
  assert.match(deepseek.stdout.split("\n")[0], /%50% /);

  const official = spawnSync(process.execPath, [CLI_PATH, "statusline"], {
    encoding: "utf8",
    input: JSON.stringify({
      model: { display_name: "Claude" },
      workspace: { current_dir: routed.directory },
    }),
    env: withoutClaudeRouting({
      AGENT_HUD_CONFIG: routed.configPath,
      AGENT_HUD_DATA_DIR: routed.directory,
      AGENT_HUD_NO_REMOTE: "1",
      NO_COLOR: "1",
      COLUMNS: "200",
    }),
  });
  assert.equal(official.status, 0, official.stderr);
  assert.doesNotMatch(official.stdout.split("\n")[0], /%50% /);

  const officialWindow = await configWorkspace([
    { ...ALL_DAY, endpoints: ["api.anthropic.com"] },
  ]);
  for (const [label, routing] of [
    ["Google Cloud", { CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1" }],
    ["gateway", { CLAUDE_CODE_USE_GATEWAY: "1" }],
    ["Bedrock yes", { CLAUDE_CODE_USE_BEDROCK: "yes" }],
    ["Bedrock on", { CLAUDE_CODE_USE_BEDROCK: "on" }],
  ]) {
    const unknown = spawnSync(process.execPath, [CLI_PATH, "statusline"], {
      encoding: "utf8",
      input: JSON.stringify({
        model: { display_name: "Claude" },
        workspace: { current_dir: officialWindow.directory },
      }),
      env: withoutClaudeRouting({
        ...routing,
        AGENT_HUD_CONFIG: officialWindow.configPath,
        AGENT_HUD_DATA_DIR: officialWindow.directory,
        AGENT_HUD_NO_REMOTE: "1",
        NO_COLOR: "1",
        COLUMNS: "200",
      }),
    });
    assert.equal(unknown.status, 0, `${label}: ${unknown.stderr}`);
    assert.doesNotMatch(
      unknown.stdout.split("\n")[0],
      /%50% /,
      `${label} must not claim an api.anthropic.com-only window`,
    );
  }

  const controlPlaneOnly = spawnSync(
    process.execPath,
    [CLI_PATH, "statusline"],
    {
      encoding: "utf8",
      input: JSON.stringify({
        model: { display_name: "Claude" },
        workspace: { current_dir: officialWindow.directory },
      }),
      env: withoutClaudeRouting({
        CLAUDE_CODE_API_BASE_URL: "https://claude-control.example",
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
        AGENT_HUD_CONFIG: officialWindow.configPath,
        AGENT_HUD_DATA_DIR: officialWindow.directory,
        AGENT_HUD_NO_REMOTE: "1",
        NO_COLOR: "1",
        COLUMNS: "200",
      }),
    },
  );
  assert.equal(controlPlaneOnly.status, 0, controlPlaneOnly.stderr);
  assert.match(controlPlaneOnly.stdout.split("\n")[0], /%50% /);
});

test("colors the model from Anthropic health only on Anthropic's API", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-health-route-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const healthCache = path.join(home, "health", "anthropic-statuspage");
  await fs.mkdir(path.dirname(healthCache), { recursive: true });
  await fs.writeFile(healthCache, "major\n");
  const now = new Date();
  await fs.utimes(healthCache, now, now);

  const run = (routing) => spawnSync(process.execPath, [CLI_PATH, "statusline"], {
    encoding: "utf8",
    input: JSON.stringify({ model: { display_name: "Claude" }, cwd: home }),
    env: withoutClaudeRouting({
      ...routing,
      HOME: home,
      AGENT_HUD_DATA_DIR: home,
      AGENT_HUD_NO_REMOTE: "1",
      COLUMNS: "200",
    }),
  });

  const official = run({});
  assert.equal(official.status, 0, official.stderr);
  assert.match(official.stdout, /\u001b\[31mClaude\u001b\[0m/);

  const proxied = run({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/v1" });
  assert.equal(proxied.status, 0, proxied.stderr);
  assert.doesNotMatch(proxied.stdout, /\u001b\[(?:31|33)mClaude/);

  for (const [label, routing] of [
    ["Google Cloud", { CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1" }],
    ["gateway", { CLAUDE_CODE_USE_GATEWAY: "1" }],
    ["Bedrock yes", { CLAUDE_CODE_USE_BEDROCK: "yes" }],
    ["Bedrock on", { CLAUDE_CODE_USE_BEDROCK: "on" }],
  ]) {
    const unknown = run(routing);
    assert.equal(unknown.status, 0, `${label}: ${unknown.stderr}`);
    assert.doesNotMatch(
      unknown.stdout,
      /\u001b\[(?:31|33)mClaude/,
      `${label} must not show Anthropic API health`,
    );
  }

  const controlPlaneOnly = run({
    CLAUDE_CODE_API_BASE_URL: "https://claude-control.example",
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  });
  assert.equal(controlPlaneOnly.status, 0, controlPlaneOnly.stderr);
  assert.match(controlPlaneOnly.stdout, /\u001b\[31mClaude\u001b\[0m/);
});

test("a window with a mistyped timezone does not abort the diagnostic", async () => {
  const { result } = await runPromotions({}, [
    { ...ALL_DAY, id: "typo", timezone: "Asia/Shanghi" },
    ALL_DAY,
  ]);
  // This command exists to explain a missing badge, so the entry that caused
  // the badge to go missing must not be the thing that stops it printing.
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /typo/);
  assert.match(result.stdout, /now: allday /);
});

test("carries the provider promotion fact through the Claude adapter", () => {
  const promotion = {
    id: "offpeak",
    label: "50%",
    active: true,
    changesAt: OBSERVED_AT + 600,
  };
  const facts = {
    platform: "claude",
    observedAt: OBSERVED_AT,
    model: "Opus 5",
    cwd: "/workspace/agent-hud",
    context: null,
    contextSize: null,
    totalInput: null,
    turns: 0,
    effort: "",
    limits: [],
    resets: [],
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    status: "idle",
    tools: [],
    agents: [],
    plan: [],
    cache: null,
    compact: {},
    apiHealthIndicator: "none",
    healthCacheStale: false,
  };
  assert.deepEqual(snapshotFromClaude(facts, null, promotion).promotion, promotion);
  assert.equal(snapshotFromClaude(facts, null).promotion, null);
});
