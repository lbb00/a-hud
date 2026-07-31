import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adapterPathFor, loadAdapter, renderWithAdapter } from "../src/adapter.mjs";
import { bar, truncate, visibleLength } from "../src/render.mjs";

// --- fixtures -----------------------------------------------------------
// Minimal but shape-complete snapshot/context, per the frozen contract in
// the Phase 2 task brief. Individual tests only override what they need.

const SNAPSHOT = {
  platform: "claude",
  model: "Sonnet",
  cwd: "/home/u/project",
  project: "project",
  context: 42,
  limits: [{ label: "5h", percent: 10 }],
  git: { branch: "main", dirty: false },
  status: "idle",
  tools: [],
  agents: [],
  plan: [],
};

function makeContext(overrides = {}) {
  return {
    apiVersion: 1,
    config: {
      enabled: true,
      platforms: { claude: true, codex: true },
      adapter: { enabled: true },
      ttl: {},
      claude: {},
      codex: {},
    },
    width: 120,
    colors: true,
    utils: { visibleLength, truncate, bar },
    ...overrides,
  };
}

// Writes (or omits) ~/.ahud/adapter.mjs under a fresh temp "home" directory
// so each test gets an isolated dynamic-import URL (no module-cache bleed
// between tests that reuse the filename "adapter.mjs").
async function makeHome(t, content) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ahud-adapter-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  if (content !== null) {
    await fs.mkdir(path.join(home, ".ahud"), { recursive: true });
    await fs.writeFile(path.join(home, ".ahud", "adapter.mjs"), content, "utf8");
  }
  return home;
}

// --- adapterPathFor -------------------------------------------------------

test("adapterPathFor joins the given home with .ahud/adapter.mjs", () => {
  assert.equal(adapterPathFor("/home/u"), path.join("/home/u", ".ahud", "adapter.mjs"));
});

test("adapterPathFor defaults to os.homedir() when no home is given", () => {
  assert.equal(adapterPathFor(), path.join(os.homedir(), ".ahud", "adapter.mjs"));
});

// --- loadAdapter: fault matrix --------------------------------------------

test("loadAdapter returns null when ~/.ahud/adapter.mjs does not exist (the common case, not an error)", async (t) => {
  const home = await makeHome(t, null);
  const adapter = await loadAdapter({ home });
  assert.equal(adapter, null);
});

test("loadAdapter returns null (does not throw) when adapter.mjs has a syntax error", async (t) => {
  const home = await makeHome(t, "export function render( {{{ broken");
  const adapter = await loadAdapter({ home });
  assert.equal(adapter, null);
});

test("loadAdapter returns null when the module exports neither `render` nor `default`", async (t) => {
  const home = await makeHome(t, "export const foo = 1;\n");
  const adapter = await loadAdapter({ home });
  assert.equal(adapter, null);
});

test("loadAdapter returns null when the exported `render` is not a function", async (t) => {
  const home = await makeHome(t, 'export const render = "not a function";\n');
  const adapter = await loadAdapter({ home });
  assert.equal(adapter, null);
});

test("loadAdapter returns null when only a non-function `default` is exported", async (t) => {
  const home = await makeHome(t, "export default 42;\n");
  const adapter = await loadAdapter({ home });
  assert.equal(adapter, null);
});

test("loadAdapter times out (returns null quickly) when the module's top-level await never resolves", async (t) => {
  const home = await makeHome(
    t,
    [
      "await new Promise(() => {});",
      'export function render() { return "unreachable"; }',
    ].join("\n"),
  );
  const start = Date.now();
  const adapter = await loadAdapter({ home, timeoutMs: 20 });
  assert.equal(adapter, null);
  assert.ok(Date.now() - start < 500, "loadAdapter must not wait for a hung import()");
});

// --- loadAdapter: resolution rules ----------------------------------------

test("loadAdapter resolves a named `render` export", async (t) => {
  const home = await makeHome(t, 'export function render(snapshot, context) { return "named-export"; }\n');
  const adapter = await loadAdapter({ home });
  assert.ok(adapter, "expected a non-null adapter");
  assert.equal(typeof adapter.render, "function");
  assert.equal(adapter.render(), "named-export");
});

test("loadAdapter resolves a `default` export when there is no named `render`", async (t) => {
  const home = await makeHome(t, 'export default function render(snapshot, context) { return "default-export"; }\n');
  const adapter = await loadAdapter({ home });
  assert.ok(adapter, "expected a non-null adapter");
  assert.equal(adapter.render(), "default-export");
});

test("loadAdapter prefers the named `render` export over `default` when both exist", async (t) => {
  const home = await makeHome(
    t,
    [
      'export function render() { return "named"; }',
      'export default function() { return "default"; }',
    ].join("\n"),
  );
  const adapter = await loadAdapter({ home });
  assert.ok(adapter, "expected a non-null adapter");
  assert.equal(adapter.render(), "named");
});

// --- renderWithAdapter: fault matrix ---------------------------------------

test("renderWithAdapter returns { ok: false } when render throws synchronously", async () => {
  const adapter = { render: () => { throw new Error("boom"); } };
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext());
  assert.equal(result.ok, false);
});

test("renderWithAdapter returns { ok: false } when an async render rejects", async () => {
  const adapter = { render: async () => { throw new Error("boom-async"); } };
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext());
  assert.equal(result.ok, false);
});

test("renderWithAdapter returns { ok: false } when render returns a non-string value", async () => {
  for (const value of [undefined, 42, null, {}, ["a"], true]) {
    const adapter = { render: () => value };
    const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext());
    assert.equal(result.ok, false, `expected ok:false for return value ${JSON.stringify(value)}`);
  }
});

test("renderWithAdapter returns { ok: false } when an async render returns a non-string value", async () => {
  const adapter = { render: async () => 42 };
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext());
  assert.equal(result.ok, false);
});

test("renderWithAdapter times out and returns { ok: false } for a slow async render, without the test itself waiting", async () => {
  // The render function "wants" to take far longer than the timeout. It
  // must not hold the process open past the timeout: the pending timer is
  // unref'd so this test (and the whole suite) still finishes in tens of
  // milliseconds instead of actually waiting out the delay.
  const adapter = {
    render: () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve("too late"), 5000);
      timer.unref?.();
    }),
  };
  const start = Date.now();
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext(), { timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - start < 500, "renderWithAdapter must not wait for the full render delay");
});

// --- renderWithAdapter: success paths ---------------------------------------

test("renderWithAdapter returns { ok: true, text } for a synchronous render returning a string", async () => {
  const adapter = { render: () => "hello sync" };
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext());
  assert.deepEqual(result, { ok: true, text: "hello sync" });
});

test("renderWithAdapter returns { ok: true, text } for an async render that resolves in time", async () => {
  const adapter = {
    render: () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve("hello async"), 10);
      timer.unref?.();
    }),
  };
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext(), { timeoutMs: 200 });
  assert.deepEqual(result, { ok: true, text: "hello async" });
});

// --- renderWithAdapter: parameters are passed through untouched -------------

test("renderWithAdapter passes snapshot, config, width, colors and utils through to render unmodified", async () => {
  let receivedSnapshot;
  let receivedContext;
  const marker = "adapter-context-marker-xyz";
  const context = makeContext({
    config: { enabled: true, marker, platforms: {}, adapter: { enabled: true }, ttl: {}, claude: {}, codex: {} },
    width: 87,
    colors: false,
  });
  const adapter = {
    render(snapshot, ctx) {
      receivedSnapshot = snapshot;
      receivedContext = ctx;
      return `ok:${ctx.config.marker}:${ctx.width}:${ctx.colors}`;
    },
  };
  const result = await renderWithAdapter(adapter, SNAPSHOT, context);
  assert.equal(result.ok, true);
  assert.equal(result.text, `ok:${marker}:87:false`);
  assert.equal(receivedSnapshot, SNAPSHOT);
  assert.equal(receivedContext.apiVersion, 1);
  // utils must be the *actual* render.mjs functions, not adapter-fabricated
  // stand-ins, so the adapter can genuinely reuse ahud's own width-aware
  // truncation/coloring logic.
  assert.equal(receivedContext.utils.visibleLength, visibleLength);
  assert.equal(receivedContext.utils.truncate, truncate);
  assert.equal(receivedContext.utils.bar, bar);
});

// --- end-to-end: a real file loaded via loadAdapter, then executed ---------

test("a real adapter.mjs loaded via loadAdapter can be executed via renderWithAdapter successfully", async (t) => {
  const home = await makeHome(
    t,
    [
      "export function render(snapshot, context) {",
      "  return `${snapshot.platform}:${context.width}`;",
      "}",
    ].join("\n"),
  );
  const adapter = await loadAdapter({ home });
  assert.ok(adapter, "expected a non-null adapter");
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext({ width: 99 }));
  assert.deepEqual(result, { ok: true, text: "claude:99" });
});

test("a real adapter.mjs loaded via loadAdapter degrades to ok:false when its render throws", async (t) => {
  const home = await makeHome(
    t,
    [
      "export function render() {",
      '  throw new Error("adapter blew up");',
      "}",
    ].join("\n"),
  );
  const adapter = await loadAdapter({ home });
  assert.ok(adapter, "expected a non-null adapter");
  const result = await renderWithAdapter(adapter, SNAPSHOT, makeContext());
  assert.equal(result.ok, false);
});
