import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { resolveDataDir } from "../dist/index.js";
import {
  appendJsonLine,
  atomicWritePrivate,
  maybeSweepPrivateFiles,
  readJsonStdin,
} from "../dist/io.js";

test("reads a chunked JSON host payload", async () => {
  const stream = Readable.from(['{"session_', 'id":"abc","turn":2}']);

  assert.deepEqual(await readJsonStdin(stream), {
    session_id: "abc",
    turn: 2,
  });
});

test("ignores interactive, empty, and malformed standard input", async () => {
  const interactive = Readable.from(['{"ok":true}']);
  interactive.isTTY = true;

  assert.equal(await readJsonStdin(interactive), null);
  assert.equal(await readJsonStdin(Readable.from(["  \n"])), null);
  assert.equal(await readJsonStdin(Readable.from(["{broken"])), null);
});

test("rejects host payloads larger than the bounded stdin budget", async () => {
  const oversizedAscii = `{"value":"${"x".repeat(256 * 1024)}"}`;
  const oversizedUtf8 = `{"value":"${"界".repeat(90 * 1024)}"}`;

  assert.equal(await readJsonStdin(Readable.from([oversizedAscii])), null);
  assert.equal(await readJsonStdin(Readable.from([oversizedUtf8])), null);
});

test("uses one shared event directory across Codex and Claude environments", () => {
  assert.equal(
    resolveDataDir({
      PLUGIN_DATA: "/tmp/codex-private",
      CLAUDE_PLUGIN_DATA: "/tmp/claude-private",
    }, "/Users/example"),
    path.join("/Users/example", ".agent-hud", "events"),
  );
  assert.equal(
    resolveDataDir({ AGENT_HUD_DATA_DIR: "/tmp/shared-hud" }, "/Users/example"),
    path.join("/tmp/shared-hud", "events"),
  );
});

test("repairs existing private directory and file permissions", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode assertion");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-private-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = path.join(root, "events");
  const eventFile = path.join(events, "event.jsonl");
  const cacheFile = path.join(events, "cache.json");
  await fs.mkdir(events, { mode: 0o755 });
  await fs.writeFile(eventFile, "{}\n", { mode: 0o644 });
  await fs.writeFile(cacheFile, "old", { mode: 0o644 });
  await fs.chmod(events, 0o755);
  await fs.chmod(eventFile, 0o644);
  await fs.chmod(cacheFile, 0o644);

  await appendJsonLine(eventFile, { ok: true });
  await atomicWritePrivate(cacheFile, "new");

  assert.equal((await fs.stat(events)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(eventFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(cacheFile)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(cacheFile, "utf8"), "new");
});

test("atomic private writes stay whole under concurrency and leave no temporaries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-atomic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "cache.json");
  const values = Array.from(
    { length: 24 },
    (_, index) => `${index}:${String(index).repeat(4_096)}`,
  );

  await Promise.all(values.map((value) => atomicWritePrivate(filePath, value)));

  assert.ok(values.includes(await fs.readFile(filePath, "utf8")));
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.startsWith(".agent-hud-tmp-")),
    [],
  );
});

test("sweeps only managed stale files and caps inactive survivors", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode assertion");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-sweep-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nowMs = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const names = {
    expired: "000000000000000000000001.json",
    protected: "000000000000000000000002.json",
    oldest: "000000000000000000000003.json",
    middle: "000000000000000000000004.json",
    recent: "000000000000000000000005.json",
    unmanaged: "notes.json",
    abandonedTemporary: ".agent-hud-tmp-abandoned",
  };
  await fs.chmod(root, 0o755);
  for (const name of Object.values(names)) {
    await fs.writeFile(path.join(root, name), "{}", { mode: 0o644 });
  }
  const ages = new Map([
    [names.expired, 20 * day],
    [names.protected, 5 * day],
    [names.oldest, 4 * day],
    [names.middle, 3 * day],
    [names.recent, 60 * 60 * 1000],
    [names.unmanaged, 40 * day],
    [names.abandonedTemporary, 2 * day],
  ]);
  for (const [name, age] of ages) {
    const seconds = (nowMs - age) / 1_000;
    await fs.utimes(path.join(root, name), seconds, seconds);
  }

  await maybeSweepPrivateFiles(root, {
    fileNamePattern: /^[a-f0-9]{24}\.json$/,
    maxAgeMs: 7 * day,
    maxEntries: 3,
    preserveYoungerThanMs: day,
  }, {
    nowMs,
    force: true,
    protectedPaths: [path.join(root, names.protected)],
  });

  const remaining = new Set(await fs.readdir(root));
  assert.equal(remaining.has(names.expired), false, "age expiry");
  assert.equal(remaining.has(names.oldest), false, "oldest inactive excess");
  assert.equal(remaining.has(names.protected), true, "explicitly protected session");
  assert.equal(remaining.has(names.middle), true);
  assert.equal(remaining.has(names.recent), true, "recent concurrent writer");
  assert.equal(remaining.has(names.unmanaged), true, "unmanaged files are never deleted");
  assert.equal(remaining.has(names.abandonedTemporary), false, "crash temporary");
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(root, names.middle))).mode & 0o777,
    0o600,
  );
});

test("recovers an abandoned hygiene lock without racing a replacement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-stale-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nowMs = Date.now();
  const stale = path.join(root, "222222222222222222222222.json");
  const lock = path.join(root, ".agent-hud-hygiene.lock");
  await fs.writeFile(stale, "{}");
  await fs.writeFile(lock, "abandoned");
  await fs.utimes(stale, (nowMs - 10_000) / 1_000, (nowMs - 10_000) / 1_000);
  await fs.utimes(lock, (nowMs - 10_000) / 1_000, (nowMs - 10_000) / 1_000);

  await maybeSweepPrivateFiles(root, {
    fileNamePattern: /^[a-f0-9]{24}\.json$/,
    maxAgeMs: 1_000,
    maxEntries: 10,
    preserveYoungerThanMs: 0,
    staleLockMs: 1_000,
  }, { nowMs, force: true });

  await assert.rejects(fs.stat(stale), { code: "ENOENT" });
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("uses a maintenance stamp instead of rescanning on every call", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-throttle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nowMs = Date.now();
  const interval = 60_000;
  const policy = {
    fileNamePattern: /^[a-f0-9]{24}\.json$/,
    maxAgeMs: 1_000,
    maxEntries: 10,
    preserveYoungerThanMs: 0,
    sweepIntervalMs: interval,
  };
  await maybeSweepPrivateFiles(root, policy, { nowMs, force: true });
  const stale = path.join(root, "111111111111111111111111.json");
  await fs.writeFile(stale, "{}");
  await fs.utimes(stale, (nowMs - 10_000) / 1_000, (nowMs - 10_000) / 1_000);

  await maybeSweepPrivateFiles(root, policy, { nowMs: nowMs + 1_000 });
  assert.equal(await fs.readFile(stale, "utf8"), "{}", "fresh stamp skips scan");

  await maybeSweepPrivateFiles(root, policy, { nowMs: nowMs + interval + 1 });
  await assert.rejects(fs.stat(stale), { code: "ENOENT" });
  const leftovers = (await fs.readdir(root))
    .filter((name) => name.includes("lock") || name.includes("tmp"));
  assert.deepEqual(leftovers, []);
});

test("hygiene failures remain advisory", async () => {
  await assert.doesNotReject(maybeSweepPrivateFiles(
    "/dev/null/agent-hud",
    {
      fileNamePattern: /^[a-f0-9]{24}\.json$/,
      maxAgeMs: 1,
      maxEntries: 1,
      preserveYoungerThanMs: 0,
    },
    { force: true },
  ));
});
