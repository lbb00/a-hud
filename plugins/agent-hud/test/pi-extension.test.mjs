import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import piExtension from "../dist/pi-extension.js";
import { setupPi } from "../dist/setup.js";

const ALL_DAY = { id: "allday", label: "50%", start: "00:00", end: "23:59" };

/**
 * pi's real API is much larger; the extension only ever touches these members,
 * so a stand-in keeps the plugin's tests independent of pi being installed.
 */
function fakePi(baseUrl) {
  const handlers = new Map();
  const painted = [];
  const ctx = {
    ui: {
      setStatus(key, text) {
        painted.push([key, text]);
      },
      theme: { fg: (color, text) => `<${color}>${text}` },
    },
    model: baseUrl ? { baseUrl } : undefined,
  };
  return {
    api: {
      on(event, handler) {
        handlers.set(event, handler);
      },
    },
    fire: (event, payload) => handlers.get(event)(payload, ctx),
    handlers,
    painted,
  };
}

async function withConfig(windows, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-pi-"));
  const configPath = path.join(directory, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ promotions: windows }), "utf8");
  const previous = {
    AGENT_HUD_CONFIG: process.env.AGENT_HUD_CONFIG,
    // Pinned so the shared cache is this test's own, not whatever the
    // developer's ~/.agent-hud last fetched.
    AGENT_HUD_DATA_DIR: process.env.AGENT_HUD_DATA_DIR,
    AGENT_HUD_NO_REMOTE: process.env.AGENT_HUD_NO_REMOTE,
  };
  process.env.AGENT_HUD_CONFIG = configPath;
  process.env.AGENT_HUD_DATA_DIR = directory;
  process.env.AGENT_HUD_NO_REMOTE = "1";
  try {
    await body(directory);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("paints an open window into pi's own footer, in pi's success color", async () => {
  await withConfig([{ ...ALL_DAY, platforms: ["pi"] }], () => {
    const pi = fakePi();
    piExtension(pi.api);
    assert.deepEqual(pi.painted, []);

    pi.fire("session_start");
    assert.equal(pi.painted.length, 1);
    const [key, text] = pi.painted[0];
    assert.equal(key, "agent-hud");
    // Same wording as the HUD's own token, so the two surfaces cannot drift.
    assert.match(text, /^<success>%50% \S+$/);
    assert.doesNotMatch(text, /↑/);

    pi.fire("turn_end");
    assert.equal(pi.painted.length, 2);
    assert.match(pi.painted[1][1], /^<success>%50% /);

    pi.fire("session_shutdown");
    assert.deepEqual(pi.painted[2], ["agent-hud", undefined]);
  });
});

test("a window belonging to another host leaves pi's footer alone", async () => {
  await withConfig([{ ...ALL_DAY, platforms: ["claude"] }], () => {
    const pi = fakePi();
    piExtension(pi.api);
    pi.fire("session_start");
    assert.deepEqual(pi.painted, [["agent-hud", undefined]]);
  });
});

test("the countdown keeps repainting a session that sits idle", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withConfig([{ ...ALL_DAY, platforms: ["pi"] }], () => {
    const pi = fakePi();
    piExtension(pi.api);
    pi.fire("session_start");

    // The segment counts down, so it goes stale without a turn to trigger it.
    t.mock.timers.tick(60_000);
    assert.equal(pi.painted.length, 2);
    assert.match(pi.painted[1][1], /^<success>%50% /);

    pi.fire("session_shutdown");
    const afterShutdown = pi.painted.length;
    t.mock.timers.tick(300_000);
    assert.equal(pi.painted.length, afterShutdown);
  });
});

test("a discount billed on one API is not claimed on another", async () => {
  await withConfig([{ ...ALL_DAY, endpoints: ["api.deepseek.com"] }], () => {
    // The same models reached through a reseller are not part of the vendor's
    // campaign, so the endpoint decides, not the model name or the host.
    const proxied = fakePi("https://openrouter.ai/api/v1");
    piExtension(proxied.api);
    proxied.fire("session_start");
    assert.deepEqual(proxied.painted, [["agent-hud", undefined]]);
    proxied.fire("session_shutdown");

    const official = fakePi("https://api.deepseek.com/v1");
    piExtension(official.api);
    official.fire("session_start");
    assert.match(official.painted[0][1], /^<success>%50% /);
    official.fire("session_shutdown");
  });
});

test("switching model switches the segment with it", async () => {
  await withConfig([{ ...ALL_DAY, endpoints: ["api.deepseek.com"] }], () => {
    const pi = fakePi("https://openrouter.ai/api/v1");
    piExtension(pi.api);
    pi.fire("session_start");
    assert.equal(pi.painted[0][1], undefined);

    pi.fire("model_select", { model: { baseUrl: "https://api.deepseek.com" } });
    assert.match(pi.painted[1][1], /^<success>%50% /);

    pi.fire("model_select", { model: { baseUrl: "https://openrouter.ai/api/v1" } });
    assert.equal(pi.painted[2][1], undefined);
    pi.fire("session_shutdown");
  });
});

test("switching to a model with no endpoint clears an endpoint-bound segment", async () => {
  await withConfig([{ ...ALL_DAY, endpoints: ["api.deepseek.com"] }], () => {
    const pi = fakePi("https://api.deepseek.com/v1");
    piExtension(pi.api);
    pi.fire("session_start");
    assert.match(pi.painted[0][1], /^<success>%50% /);

    // The event names the newly selected model. Falling back to the context's
    // previous model here would keep claiming its discount for the new one.
    pi.fire("model_select", { model: {} });
    assert.equal(pi.painted[1][1], undefined);

    pi.fire("model_select", { model: { baseUrl: "   " } });
    assert.equal(pi.painted[2][1], undefined);
    pi.fire("session_shutdown");
  });
});

/** The status file is read off the turn's critical path, so a repaint lands
 * on a later tick rather than inside `fire`. */
async function settle(pi, count) {
  for (let attempt = 0; attempt < 200 && pi.painted.length < count; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("pi reports the vendor incident for the API its own model calls", async () => {
  await withConfig([], async (directory) => {
    // Written by whichever host refreshed it last: the fact belongs to the API,
    // so a pi-only user reads the same file a Claude Code session would.
    const cache = path.join(directory, "health", "anthropic-statuspage");
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, "major\n");

    const anthropic = fakePi("https://api.anthropic.com");
    piExtension(anthropic.api);
    anthropic.fire("session_start");
    assert.equal(anthropic.painted[0][1], undefined);
    await settle(anthropic, 2);
    assert.equal(anthropic.painted.at(-1)[1], "<error>!Anthropic");
    anthropic.fire("session_shutdown");

    // A model on another API gets no signal rather than Anthropic's.
    const elsewhere = fakePi("https://api.deepseek.com");
    piExtension(elsewhere.api);
    elsewhere.fire("session_start");
    await settle(elsewhere, 2);
    assert.equal(elsewhere.painted.at(-1)[1], undefined);
    elsewhere.fire("session_shutdown");
  });
});

test("a quiet status page leaves pi's footer untouched", async () => {
  await withConfig([], async (directory) => {
    const cache = path.join(directory, "health", "anthropic-statuspage");
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, "none\n");

    const pi = fakePi("https://api.anthropic.com");
    piExtension(pi.api);
    pi.fire("session_start");
    await settle(pi, 2);
    assert.equal(pi.painted.at(-1)[1], undefined);
    pi.fire("session_shutdown");
  });
});

test("setup pi installs an extension file that re-exports the built plugin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-pi-home-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const result = await setupPi({ cliPath: path.join("/opt/agent-hud/dist/cli.js") });
    assert.equal(result.filePath, path.join(root, "extensions", "agent-hud.ts"));
    const written = await fs.readFile(result.filePath, "utf8");
    // pi discovers `.ts` files with no build step, so the installed file only
    // points at the bundle and never carries a copy of the extension.
    assert.ok(
      written.includes(
        `export { default } from ${
          JSON.stringify(path.join("/opt/agent-hud/dist", "pi-extension.js"))
        };`,
      ),
      written,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
