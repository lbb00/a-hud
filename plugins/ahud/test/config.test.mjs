// Tests for src/config.mjs (does not exist yet — this whole file is expected
// to fail to even load until that module is implemented; see AGENTS/task
// notes). Unlike setup.test.mjs/io.test.mjs's "import * as module" trick,
// there is no already-passing test in this file to protect, so a plain
// static import is used and a missing module simply fails every test here.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULTS,
  configPathFor,
  isPlatformEnabled,
  loadConfig,
  writeConfigPatch,
} from "../src/config.mjs";

async function mkHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ahud-config-"));
}

async function writeRawConfig(home, value) {
  const dir = path.join(home, ".ahud");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "config.json");
  await fs.writeFile(filePath, typeof value === "string" ? value : JSON.stringify(value));
  return filePath;
}

// ---------------------------------------------------------------------------
// configPathFor
// ---------------------------------------------------------------------------

test("configPathFor joins home with .ahud/config.json", () => {
  assert.equal(configPathFor("/home/u"), path.join("/home/u", ".ahud", "config.json"));
});

test("configPathFor defaults to os.homedir() when called with no argument", () => {
  assert.equal(configPathFor(), path.join(os.homedir(), ".ahud", "config.json"));
});

// ---------------------------------------------------------------------------
// loadConfig: missing file / invalid JSON / never throws
// ---------------------------------------------------------------------------

test("loadConfig returns a deep copy of DEFAULTS with exists:false and no warnings when the file is missing", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = await loadConfig({ home });

  assert.deepEqual(result.config, DEFAULTS);
  assert.equal(result.exists, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.path, configPathFor(home));
  // Must be a genuine deep copy: mutating the returned config must not
  // corrupt the shared DEFAULTS object for the next caller.
  result.config.platforms.codex = false;
  assert.equal(DEFAULTS.platforms.codex, true);
});

test("loadConfig never throws on invalid JSON: falls back to DEFAULTS, exists:true, one warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, "{ this is not json");

  const result = await loadConfig({ home });

  assert.deepEqual(result.config, DEFAULTS);
  assert.equal(result.exists, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(typeof result.warnings[0], "string");
});

// ---------------------------------------------------------------------------
// loadConfig: merge semantics
// ---------------------------------------------------------------------------

test("loadConfig deep-merges a partial ttl object onto DEFAULTS, leaving the sibling field untouched", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { ttl: { activeMin: 30 } });

  const { config } = await loadConfig({ home });

  assert.equal(config.ttl.activeMin, 30);
  assert.equal(config.ttl.recentMin, DEFAULTS.ttl.recentMin);
});

test("loadConfig merges platforms key-by-key: an unset platform key keeps its DEFAULTS value", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { platforms: { codex: false } });

  const { config } = await loadConfig({ home });

  assert.equal(config.platforms.codex, false);
  assert.equal(config.platforms.claude, true);
});

test("loadConfig treats codex.status_line as a whole-value replace, not an element-wise merge", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { codex: { status_line: ["x", "y"] } });

  const { config } = await loadConfig({ home });

  assert.deepEqual(config.codex.status_line, ["x", "y"]);
  assert.equal(config.codex.terminal_title, null);
});

test("loadConfig preserves unknown top-level keys verbatim, with no warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { myAdapterSetting: { nested: 1, list: [1, 2] } });

  const result = await loadConfig({ home });

  assert.deepEqual(result.config.myAdapterSetting, { nested: 1, list: [1, 2] });
  assert.deepEqual(result.warnings, []);
});

test("loadConfig preserves an unknown sub-key inside a known object (e.g. a future platforms.cursor) verbatim, with no warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { platforms: { cursor: true } });

  const result = await loadConfig({ home });

  assert.equal(result.config.platforms.cursor, true);
  assert.equal(result.config.platforms.codex, true);
  assert.equal(result.config.platforms.claude, true);
  assert.deepEqual(result.warnings, []);
});

// ---------------------------------------------------------------------------
// loadConfig: validation / clamping table
// ---------------------------------------------------------------------------

test("loadConfig: enabled must be a strict boolean; a non-boolean falls back to true with a warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { enabled: "yes" });

  const result = await loadConfig({ home });

  assert.equal(result.config.enabled, true);
  assert.equal(result.warnings.length, 1);
});

test("loadConfig: enabled:false passes through unchanged (legal value)", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { enabled: false });

  const result = await loadConfig({ home });

  assert.equal(result.config.enabled, false);
  assert.deepEqual(result.warnings, []);
});

test("loadConfig: platforms.<key> is validated independently — one invalid key falls back, a sibling valid key is untouched", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { platforms: { codex: "nope", claude: false } });

  const result = await loadConfig({ home });

  assert.equal(result.config.platforms.codex, true, "invalid platforms.codex falls back to true");
  assert.equal(result.config.platforms.claude, false, "valid platforms.claude passes through");
  assert.equal(result.warnings.length, 1);
});

test("loadConfig: adapter.enabled must be a strict boolean; a non-boolean falls back to true with a warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { adapter: { enabled: 1 } });

  const result = await loadConfig({ home });

  assert.equal(result.config.adapter.enabled, true);
  assert.equal(result.warnings.length, 1);
});

test("loadConfig: ttl.activeMin accepts the 1440 boundary and rejects 1441", async (t) => {
  const homeOk = await mkHome();
  const homeBad = await mkHome();
  t.after(() => Promise.all([
    fs.rm(homeOk, { recursive: true, force: true }),
    fs.rm(homeBad, { recursive: true, force: true }),
  ]));
  await writeRawConfig(homeOk, { ttl: { activeMin: 1440 } });
  await writeRawConfig(homeBad, { ttl: { activeMin: 1441 } });

  const ok = await loadConfig({ home: homeOk });
  const bad = await loadConfig({ home: homeBad });

  assert.equal(ok.config.ttl.activeMin, 1440);
  assert.deepEqual(ok.warnings, []);
  assert.equal(bad.config.ttl.activeMin, DEFAULTS.ttl.activeMin);
  assert.equal(bad.warnings.length, 1);
});

test("loadConfig: ttl.recentMin rejects 0, negative, non-finite, and non-number values, falling back to the default each time", async (t) => {
  for (const invalid of [0, -5, Infinity, NaN, "5", null]) {
    const home = await mkHome();
    await writeRawConfig(home, { ttl: { recentMin: invalid } });

    const result = await loadConfig({ home });

    assert.equal(result.config.ttl.recentMin, DEFAULTS.ttl.recentMin, `expected fallback for ${String(invalid)}`);
    assert.equal(result.warnings.length, 1, `expected a warning for ${String(invalid)}`);
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("loadConfig: claude.refreshInterval accepts the 1 and 300 boundaries and rejects 0 and 301", async (t) => {
  const cases = [
    [1, true], [300, true], [0, false], [301, false], [5.5, false],
  ];
  for (const [value, legal] of cases) {
    const home = await mkHome();
    await writeRawConfig(home, { claude: { refreshInterval: value } });

    const result = await loadConfig({ home });

    if (legal) {
      assert.equal(result.config.claude.refreshInterval, value, `expected ${value} to pass through`);
      assert.deepEqual(result.warnings, [], `expected no warning for ${value}`);
    } else {
      assert.equal(result.config.claude.refreshInterval, DEFAULTS.claude.refreshInterval, `expected fallback for ${value}`);
      assert.equal(result.warnings.length, 1, `expected a warning for ${value}`);
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("loadConfig: codex.status_line must be an array of non-empty strings; a non-array value falls back to null with a warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { codex: { status_line: "model" } });

  const result = await loadConfig({ home });

  assert.equal(result.config.codex.status_line, null);
  assert.equal(result.warnings.length, 1);
});

test("loadConfig: codex.terminal_title with an empty-string element is illegal and falls back to null with a warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { codex: { terminal_title: ["ok", ""] } });

  const result = await loadConfig({ home });

  assert.equal(result.config.codex.terminal_title, null);
  assert.equal(result.warnings.length, 1);
});

test("loadConfig: codex.status_line with a non-string element (number) is illegal and falls back to null with a warning", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { codex: { status_line: ["model", 5] } });

  const result = await loadConfig({ home });

  assert.equal(result.config.codex.status_line, null);
  assert.equal(result.warnings.length, 1);
});

test("loadConfig: codex.status_line does NOT validate token names — any non-empty string array passes through as-is", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { codex: { status_line: ["totally-made-up-future-token"] } });

  const result = await loadConfig({ home });

  assert.deepEqual(result.config.codex.status_line, ["totally-made-up-future-token"]);
  assert.deepEqual(result.warnings, []);
});

// ---------------------------------------------------------------------------
// writeConfigPatch
// ---------------------------------------------------------------------------

test("writeConfigPatch creates ~/.ahud (mode 0700) and config.json (mode 0600) when neither exists", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = await writeConfigPatch({ ttl: { activeMin: 20 } }, { home });

  assert.equal(result.changed, true);
  const dirStat = await fs.stat(path.join(home, ".ahud"));
  const fileStat = await fs.stat(path.join(home, ".ahud", "config.json"));
  assert.equal(dirStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);
  const onDisk = JSON.parse(await fs.readFile(path.join(home, ".ahud", "config.json"), "utf8"));
  assert.deepEqual(onDisk, { ttl: { activeMin: 20 } });
});

test("writeConfigPatch is a sparse read-modify-write: it does not materialize DEFAULTS, only the patch, on first write", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeConfigPatch({ codex: { status_line: ["a"] } }, { home });

  const onDisk = JSON.parse(await fs.readFile(path.join(home, ".ahud", "config.json"), "utf8"));
  assert.deepEqual(onDisk, { codex: { status_line: ["a"] } });
});

test("writeConfigPatch deep-merges onto an existing file: unrelated top-level keys and unrelated sub-keys survive", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, {
    foo: "bar",
    codex: { status_line: ["old1"], terminal_title: ["oldT"] },
  });

  await writeConfigPatch({ codex: { status_line: ["new1", "new2"] } }, { home });

  const onDisk = JSON.parse(await fs.readFile(path.join(home, ".ahud", "config.json"), "utf8"));
  assert.equal(onDisk.foo, "bar");
  assert.deepEqual(onDisk.codex.status_line, ["new1", "new2"]);
  assert.deepEqual(onDisk.codex.terminal_title, ["oldT"]);
});

test("writeConfigPatch does not create any .bak backup file", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, { foo: "bar" });

  await writeConfigPatch({ foo: "baz" }, { home });

  const entries = await fs.readdir(path.join(home, ".ahud"));
  assert.deepEqual(entries, ["config.json"]);
});

test("writeConfigPatch leaves no leftover temp file after an atomic write", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeConfigPatch({ foo: "bar" }, { home });

  const entries = await fs.readdir(path.join(home, ".ahud"));
  assert.deepEqual(entries, ["config.json"]);
});

test("writeConfigPatch returns changed:false and does not touch the file when the merged content is byte-identical to what's already on disk", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const first = await writeConfigPatch({ codex: { status_line: ["a"] } }, { home });
  assert.equal(first.changed, true);
  const filePath = path.join(home, ".ahud", "config.json");
  const beforeMtime = (await fs.stat(filePath)).mtimeMs;

  const second = await writeConfigPatch({ codex: { status_line: ["a"] } }, { home });

  assert.equal(second.changed, false);
  const afterMtime = (await fs.stat(filePath)).mtimeMs;
  assert.equal(afterMtime, beforeMtime);
});

test("writeConfigPatch with dryRun:true does not touch disk at all, but returns the content that would have been written", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const result = await writeConfigPatch({ codex: { status_line: ["a"] } }, { home, dryRun: true });

  await assert.rejects(fs.access(path.join(home, ".ahud", "config.json")));
  const parsed = JSON.parse(result.content);
  assert.deepEqual(parsed.codex.status_line, ["a"]);
});

test("writeConfigPatch throws an AHUD_CONFIG_INVALID error when the existing file is invalid JSON", async (t) => {
  const home = await mkHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeRawConfig(home, "{ broken");

  await assert.rejects(
    writeConfigPatch({ foo: "bar" }, { home }),
    (error) => error.code === "AHUD_CONFIG_INVALID",
  );
});

// ---------------------------------------------------------------------------
// isPlatformEnabled
// ---------------------------------------------------------------------------

test("isPlatformEnabled is false when the global enabled switch is false, regardless of the platform's own flag", () => {
  const config = { enabled: false, platforms: { codex: true } };
  assert.equal(isPlatformEnabled(config, "codex"), false);
});

test("isPlatformEnabled is false when the platform's own flag is explicitly false", () => {
  const config = { enabled: true, platforms: { claude: false } };
  assert.equal(isPlatformEnabled(config, "claude"), false);
});

test("isPlatformEnabled defaults to true for a platform key that isn't present in platforms at all (forward compatibility)", () => {
  const config = { enabled: true, platforms: { codex: true } };
  assert.equal(isPlatformEnabled(config, "cursor"), true);
});

test("isPlatformEnabled defaults to true when platforms is entirely missing from the config object", () => {
  const config = { enabled: true };
  assert.equal(isPlatformEnabled(config, "codex"), true);
});
