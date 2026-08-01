import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataDir } from "../src/io.mjs";
// Imported as a namespace on purpose: normalizeCwd does not exist yet, and a
// static named import of a missing export throws a SyntaxError at
// module-load time, which would take the (currently passing) resolveDataDir
// tests in this same file down with it. Accessing it off the namespace
// object means only the normalizeCwd tests themselves fail.
import * as ioModule from "../src/io.mjs";
const { normalizeCwd } = ioModule;

test("resolveDataDir defaults to ~/.ahud/events when nothing is set", () => {
  assert.equal(resolveDataDir({}, "/home/u"), path.join("/home/u", ".ahud", "events"));
});

test("resolveDataDir ignores host-injected PLUGIN_DATA/CLAUDE_PLUGIN_DATA so hook writer and watch reader agree on the same directory", () => {
  // The hook writer (running inside a Claude Code / Codex tool call) and the
  // statusline/watch reader (running as an independent process) do not
  // reliably see the same PLUGIN_DATA/CLAUDE_PLUGIN_DATA env value injected
  // by the host — trusting it causes the two sides to disagree on where
  // events live. The fixed default `~/.ahud` must win regardless.
  assert.equal(
    resolveDataDir({ PLUGIN_DATA: "/plugin/data", CLAUDE_PLUGIN_DATA: "/other" }, "/home/u"),
    path.join("/home/u", ".ahud", "events"),
  );
});

test("resolveDataDir honors an explicit AHUD_DATA_DIR override", () => {
  assert.equal(resolveDataDir({ AHUD_DATA_DIR: "/custom" }, "/home/u"), path.join("/custom", "events"));
});

test("resolveDataDir's explicit AHUD_DATA_DIR wins even when PLUGIN_DATA is also set", () => {
  assert.equal(
    resolveDataDir({ AHUD_DATA_DIR: "/custom", PLUGIN_DATA: "/plugin" }, "/home/u"),
    path.join("/custom", "events"),
  );
});

test("resolveDataDir resolves a relative AHUD_DATA_DIR against home, not the caller's cwd (regression)", () => {
  // A hook subprocess and an independently-launched watch/statusline process
  // never share a cwd; resolving a relative override against each caller's
  // own cwd would split writers from readers. It must anchor to `home`.
  assert.equal(
    resolveDataDir({ AHUD_DATA_DIR: ".cache/ahud" }, "/home/u"),
    path.join("/home/u", ".cache/ahud", "events"),
  );
});

test("normalizeCwd resolves a symlink to the same value as its real target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ahud-io-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  const link = path.join(root, "link");
  fs.symlinkSync(real, link, "dir");

  assert.equal(normalizeCwd(link), normalizeCwd(real));
});

test("normalizeCwd strips a trailing slash", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ahud-io-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(normalizeCwd(`${root}/`), normalizeCwd(root));
});

test("normalizeCwd does not throw for a non-existent path and falls back to path.resolve", () => {
  const missing = "/definitely/does/not/exist/ahud-normalize-cwd-test";
  assert.doesNotThrow(() => normalizeCwd(missing));
  assert.equal(normalizeCwd(missing), path.resolve(missing));
});

test("normalizeCwd resolves a relative path against process.cwd()", () => {
  assert.equal(normalizeCwd("."), normalizeCwd(process.cwd()));
});
