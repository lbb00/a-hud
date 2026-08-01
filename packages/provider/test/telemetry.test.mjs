import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  contextPercent,
  deriveClaudeTelemetry,
  extractEffort,
  refreshAnthropicHealth,
  spawnHealthRefresh,
} from "../dist/index.js";

test("derives raw turns, cache, effort, health, and compact measurements", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-telemetry-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, "project");
  const transcript = path.join(home, "session.jsonl");
  await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".claude", "settings.json"),
    JSON.stringify({ effortLevel: "high" }),
  );

  const messages = Array.from({ length: 16 }, (_, index) => JSON.stringify({
    type: "assistant",
    message: {
      id: `msg_${index}`,
      usage: index === 15 ? {
        cache_creation_input_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 1 },
      } : {},
    },
  }));
  messages.push(JSON.stringify({
    type: "assistant",
    isSidechain: true,
    message: { id: "msg_sidechain" },
  }));
  await fs.writeFile(transcript, `${messages.join("\n")}\n`);

  const now = 2_000_000_000;
  await fs.utimes(transcript, now - 100, now - 100);
  const contextLog = path.join(home, ".claude", "context-log", "session.tsv");
  await fs.mkdir(path.dirname(contextLog), { recursive: true });
  await fs.writeFile(contextLog, [
    `${now - 10}\t50\t10`,
    `${now - 5}\t70\t15`,
  ].join("\n"));
  const healthCache = path.join(home, ".claude", "status-cache", "anthropic");
  await fs.mkdir(path.dirname(healthCache), { recursive: true });
  await fs.writeFile(healthCache, "minor\n");
  await fs.utimes(healthCache, now - 10, now - 10);

  const derived = await deriveClaudeTelemetry({
    session_id: "session",
    transcript_path: transcript,
    cwd,
    context_window: {
      used_percentage: 75,
      total_input_tokens: 100_000,
    },
  }, { home, now, writeLogs: false });

  assert.equal(derived.observedAt, now);
  assert.equal(derived.turns, 16);
  assert.equal(derived.effort, "high");
  assert.deepEqual(derived.cache, {
    expiresAt: now + 3_500,
    ttlSeconds: 3_600,
  });
  assert.deepEqual(derived.compact, {
    forcedTurns: 1,
    breakEvenTurns: 14,
    inForcedZone: false,
  });
  assert.equal(derived.apiHealthIndicator, "minor");
  assert.equal(derived.healthCacheStale, false);
  assert.equal("modelSeverity" in derived, false);
  assert.equal("compactAdvisor" in derived, false);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.dirname(contextLog))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(contextLog)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(healthCache))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(healthCache)).mode & 0o777, 0o600);
  }
});

test("preserves the legacy effort fallback order including object forms", () => {
  assert.equal(extractEffort({
    effort: { effort: "max" },
    model: { effort: "high" },
    reasoning_effort: "medium",
  }), "max");
  assert.equal(extractEffort({
    model: { effort: { level: "xhigh" } },
    reasoning_effort: "medium",
  }), "xhigh");
  assert.equal(extractEffort({
    output_style: { effort: { effort: "low" } },
  }), "low");
  assert.equal(extractEffort({
    effort: "\u001b]2;PWNED\u0007",
  }), "");
  assert.equal(extractEffort({
    effort: { level: "\u001b]2;PWNED\u0007", effort: "ultra" },
  }), "");
});

test("rejects terminal control and unknown effort values from project settings", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-effort-safe-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, "project");
  await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".claude", "settings.json"),
    JSON.stringify({ effortLevel: "\u001b]2;PWNED\u0007" }),
  );

  const derived = await deriveClaudeTelemetry({ cwd }, {
    home,
    now: 2_000_000_000,
    writeLogs: false,
  });
  assert.equal(derived.effort, "");
});

test("computes context from native percentage or token components", () => {
  assert.equal(contextPercent({ context_window: { used_percentage: 59.6 } }), 59.6);
  assert.equal(contextPercent({
    context_window: {
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 20_000,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 10_000,
      },
    },
  }), 20);
});

test("coalesces concurrent detached health refreshes with a private lease", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-health-lease-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const fixture = path.join(home, "refresh-fixture.mjs");
  await fs.writeFile(fixture, "setTimeout(() => {}, 25);\n");

  const spawned = await Promise.all(
    Array.from({ length: 16 }, () => spawnHealthRefresh(fixture, home)),
  );
  assert.equal(spawned.filter(Boolean).length, 1);
  const lockPath = path.join(
    home,
    ".claude",
    "status-cache",
    "anthropic-refresh.lock",
  );
  assert.ok((await fs.readFile(lockPath, "utf8")).trim());
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o600);
  }
  await fs.utimes(lockPath, 0, 0);
  assert.equal(
    await spawnHealthRefresh(fixture, home),
    true,
    "a crashed child lease must be recoverable after its stale margin",
  );
});

test("health refresh startup is fail-soft for an unwritable home", async (t) => {
  if (process.platform === "win32") return t.skip("/dev/null is not an unwritable path on Windows");
  assert.equal(
    await spawnHealthRefresh("/missing/agent-hud-cli.js", "/dev/null"),
    false,
  );
});

test("keeps the last-good health indicator when a refresh fails", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-health-failure-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, ".claude", "status-cache");
  const indicator = path.join(directory, "anthropic");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(indicator, "minor\n");
  const lockPath = path.join(directory, "anthropic-refresh.lock");
  await fs.writeFile(lockPath, "lease-token\n");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({ ok: false, status: 503 });

  await assert.rejects(
    refreshAnthropicHealth(home, { path: lockPath, token: "lease-token" }),
    /HTTP 503/,
  );
  assert.equal(await fs.readFile(indicator, "utf8"), "minor\n");
  assert.equal(
    await fs.readFile(path.join(directory, "anthropic-attempt"), "utf8"),
    "\n",
  );
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
});

test("metric write failures degrade to partial facts instead of rejecting", async () => {
  const result = await deriveClaudeTelemetry({
    session_id: "read-only",
    context_window: {
      used_percentage: 50,
      total_input_tokens: 100_000,
    },
    cost: { total_cost_usd: 2 },
  }, {
    home: "/dev/null",
    now: 2_000_000_000,
    writeLogs: true,
  });
  assert.equal(result.turns, 0);
  assert.equal(result.compact.breakEvenTurns, 14);
});

test("hashes unsafe session ids before using them as metric filenames", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-metric-path-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await deriveClaudeTelemetry({
    session_id: "../../escaped",
    context_window: {
      used_percentage: 50,
      total_input_tokens: 100_000,
    },
    cost: { total_cost_usd: 2 },
  }, {
    home,
    now: 2_000_000_000,
    writeLogs: true,
  });

  await assert.rejects(fs.stat(path.join(home, "escaped.tsv")), { code: "ENOENT" });
  for (const directory of ["context-log", "cost-log"]) {
    const names = await fs.readdir(path.join(home, ".claude", directory));
    assert.equal(names.length, 1);
    assert.match(names[0], /^session-[a-f0-9]{24}\.tsv$/);
  }
});

test("ignores non-string session ids instead of failing the statusline", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-session-type-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const result = await deriveClaudeTelemetry({
    session_id: { malformed: true },
    context_window: {
      used_percentage: 50,
      total_input_tokens: 100_000,
    },
    cost: { total_cost_usd: 2 },
  }, {
    home,
    now: 2_000_000_000,
    writeLogs: true,
  });

  assert.equal(result.turns, 0);
  await assert.rejects(
    fs.stat(path.join(home, ".claude", "context-log")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    fs.stat(path.join(home, ".claude", "cost-log")),
    { code: "ENOENT" },
  );
});

test("matches shell behavior by requiring a rising segment before showing full", async () => {
  const result = await deriveClaudeTelemetry({
    session_id: "already-full",
    context_window: {
      used_percentage: 82,
      total_input_tokens: 120_000,
    },
  }, {
    home: "/dev/null",
    now: 2_000_000_000,
    writeLogs: false,
  });
  assert.equal(result.compact.inForcedZone, false);
  assert.equal(result.compact.forcedTurns, null);
  assert.equal(result.compact.breakEvenTurns, 11);
});

test("caches unchanged transcript scans and invalidates after append", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-scan-cache-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const transcript = path.join(home, "session.jsonl");
  await fs.writeFile(transcript, `${JSON.stringify({
    message: { id: "msg_one" },
  })}\n`);
  const input = { transcript_path: transcript };

  const first = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  const firstSize = (await fs.stat(transcript)).size;
  const cacheDir = path.join(home, ".agent-hud", "transcript-cache");
  const [cacheName] = (await fs.readdir(cacheDir))
    .filter((name) => /^[a-f0-9]{24}\.json$/.test(name));
  assert.ok(cacheName);
  const second = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  assert.equal(first.turns, 1);
  assert.equal(second.turns, 1);

  await fs.appendFile(transcript, `${JSON.stringify({
    message: { id: "msg_two" },
  })}\n`);
  const changed = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  assert.equal(changed.turns, 2);
  const cache = JSON.parse(await fs.readFile(path.join(cacheDir, cacheName), "utf8"));
  assert.equal(cache.v, 2);
  assert.equal(cache.scanStart, firstSize, "append refresh must start at the old EOF");
  assert.deepEqual(new Set(cache.ids), new Set(["msg_one", "msg_two"]));

  await fs.writeFile(transcript, `${JSON.stringify({
    message: { id: "msg_replacement", payload: "x".repeat(512) },
  })}\n`);
  const replaced = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  assert.equal(replaced.turns, 1, "truncate-and-regrow must discard the append cache");
  const replacedCache = JSON.parse(await fs.readFile(path.join(cacheDir, cacheName), "utf8"));
  assert.equal(replacedCache.scanStart, 0);
  assert.deepEqual(replacedCache.ids, ["msg_replacement"]);
});

test("ignores cache-like tool payloads and survives partial and concurrent appends", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-scan-edges-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const transcript = path.join(home, "session.jsonl");
  await fs.writeFile(transcript, `${JSON.stringify({
    type: "user",
    toolUseResult: { cache_creation_input_tokens: 123 },
  })}\n${JSON.stringify({
    type: "assistant",
    message: { id: "msg_one", usage: {} },
  })}\n`);
  const input = { transcript_path: transcript };

  const first = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  assert.equal(first.turns, 1);
  assert.equal(first.cache.ttlSeconds, 3_600);

  await fs.appendFile(transcript, JSON.stringify({
    type: "assistant",
    message: { id: "msg_two", usage: {} },
  }));
  const partial = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  assert.equal(partial.turns, 2);
  await fs.appendFile(transcript, "\n");

  const concurrent = await Promise.all(Array.from(
    { length: 12 },
    () => deriveClaudeTelemetry(input, { home, writeLogs: false }),
  ));
  assert.ok(concurrent.every((result) => result.turns === 2));
  const cacheDir = path.join(home, ".agent-hud", "transcript-cache");
  const [cacheName] = (await fs.readdir(cacheDir))
    .filter((name) => /^[a-f0-9]{24}\.json$/.test(name));
  const cache = JSON.parse(await fs.readFile(path.join(cacheDir, cacheName), "utf8"));
  assert.deepEqual(new Set(cache.ids), new Set(["msg_one", "msg_two"]));
});

test("caches the complete prefix when the first scan catches a partial final line", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-partial-prefix-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const transcript = path.join(home, "session.jsonl");
  const completeLine = `${JSON.stringify({
    type: "assistant",
    message: { id: "msg_one", usage: {} },
  })}\n`;
  const partialLine = JSON.stringify({
    type: "assistant",
    message: { id: "msg_two", usage: {} },
  });
  await fs.writeFile(transcript, `${completeLine}${partialLine}`);
  const input = { transcript_path: transcript };

  const first = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  assert.equal(first.turns, 2);
  const cacheDir = path.join(home, ".agent-hud", "transcript-cache");
  const [cacheName] = (await fs.readdir(cacheDir))
    .filter((name) => /^[a-f0-9]{24}\.json$/.test(name));
  const firstCache = JSON.parse(await fs.readFile(path.join(cacheDir, cacheName), "utf8"));
  assert.equal(firstCache.size, Buffer.byteLength(completeLine));
  assert.deepEqual(firstCache.ids, ["msg_one"]);

  const second = await deriveClaudeTelemetry(input, { home, writeLogs: false });
  assert.equal(second.turns, 2);
  const secondCache = JSON.parse(await fs.readFile(path.join(cacheDir, cacheName), "utf8"));
  assert.equal(
    secondCache.scanStart,
    Buffer.byteLength(completeLine),
    "the second refresh must resume at the last complete newline",
  );
});

test("transcript maintenance repairs cache permissions and removes stale entries", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode assertion");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-cache-hygiene-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const transcript = path.join(home, "session.jsonl");
  const cacheDir = path.join(home, ".agent-hud", "transcript-cache");
  const stale = path.join(cacheDir, "000000000000000000000000.json");
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o755 });
  await fs.writeFile(stale, "{}", { mode: 0o644 });
  const old = Date.now() / 1_000 - 8 * 24 * 60 * 60;
  await fs.utimes(stale, old, old);
  await fs.chmod(cacheDir, 0o755);
  await fs.writeFile(transcript, `${JSON.stringify({
    type: "assistant",
    message: { id: "msg_private", usage: {} },
  })}\n`);

  const result = await deriveClaudeTelemetry(
    { transcript_path: transcript },
    { home, writeLogs: false },
  );

  assert.equal(result.turns, 1);
  await assert.rejects(fs.stat(stale), { code: "ENOENT" });
  const cacheNames = (await fs.readdir(cacheDir))
    .filter((name) => /^[a-f0-9]{24}\.json$/.test(name));
  assert.equal(cacheNames.length, 1);
  assert.equal((await fs.stat(cacheDir)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(cacheDir, cacheNames[0]))).mode & 0o777,
    0o600,
  );
});
