import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  promotionSources,
  readPromotionWindows,
  refreshSharedPromotions,
  remoteFetchDisabled,
  SHARED_PROMOTIONS_URL,
  sharedPromotionsUrl,
} from "../dist/index.js";

const FETCHED_AT = 1_772_000_000;

/**
 * Every case pins AGENT_HUD_DATA_DIR: without it the shared-schedule cache
 * would be the developer's own `~/.agent-hud`, and the assertions would depend
 * on whatever this machine last fetched.
 */
async function workspace(files = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-shared-"));
  for (const [name, value] of Object.entries(files)) {
    await fs.writeFile(
      path.join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  }
  return { directory, env: { AGENT_HUD_DATA_DIR: directory } };
}

/**
 * `url` is what the cache answers for; `source` is where the bytes came from,
 * which differs only when the request redirected.
 */
function cacheFile(promotions, extra = {}) {
  return {
    fetchedAt: FETCHED_AT,
    url: SHARED_PROMOTIONS_URL,
    source: "test",
    document: { promotions },
    ...extra,
  };
}

function window(id, extra = {}) {
  return { id, label: id, start: "01:00", end: "02:00", ...extra };
}

test("falls back to the copy bundled with the package before anything is fetched", async () => {
  const { env } = await workspace();
  const sources = promotionSources(env);
  assert.equal(sources.sharedOrigin, "bundled");
  assert.equal(sources.sharedFetchedAt, null);
  assert.deepEqual(sources.local, []);
  // The published schedule is deliberately empty; only its shape is a contract.
  assert.ok(Array.isArray(sources.shared));
  assert.equal(sources.sharedStale, true);
});

test("reads the schedule fetched from the repository", async () => {
  const { env } = await workspace({
    "promotions-cache.json": cacheFile([window("shared-one")]),
  });
  const sources = promotionSources(env);
  assert.equal(sources.sharedOrigin, "remote");
  assert.equal(sources.sharedFetchedAt, FETCHED_AT);
  assert.deepEqual(sources.shared.map((entry) => entry.id), ["shared-one"]);
  assert.equal(sources.sharedStale, false);
  // Diagnostics report where the cache came from, not the URL configured now.
  assert.equal(sources.sharedSource, "test");
});

test("a cache older than the refresh interval asks for a refresh", async () => {
  const { directory, env } = await workspace({
    "promotions-cache.json": cacheFile([window("shared-one")]),
  });
  const stale = Date.now() / 1_000 - 7 * 60 * 60;
  await fs.utimes(path.join(directory, "promotions-cache.json"), stale, stale);
  assert.equal(promotionSources(env).sharedStale, true);
});

test("a malformed cache keeps rendering from the bundled copy", async () => {
  const { env } = await workspace({ "promotions-cache.json": "{ not json" });
  assert.equal(promotionSources(env).sharedOrigin, "bundled");
});

test("a local window shadows the shared one with the same id", async () => {
  const { env } = await workspace({
    "config.json": { promotions: [window("offpeak", { label: "mine" })] },
    "promotions-cache.json": cacheFile([window("offpeak"), window("other")]),
  });
  const sources = promotionSources(env);
  assert.deepEqual(sources.local.map((entry) => entry.label), ["mine"]);
  assert.deepEqual(sources.shared.map((entry) => entry.id), ["other"]);
  // Local first, so it also wins resolvePromotion's tie-breaks.
  assert.deepEqual(readPromotionWindows(env).map((entry) => entry.label), [
    "mine",
    "other",
  ]);
});

test("`disabled` hides one shared window without editing the schedule", async () => {
  const { env } = await workspace({
    "config.json": { disabled: ["offpeak"] },
    "promotions-cache.json": cacheFile([window("offpeak"), window("other")]),
  });
  assert.deepEqual(
    promotionSources(env).shared.map((entry) => entry.id),
    ["other"],
  );
});

test("a local entry switched off also hides the shared window it names", async () => {
  const { env } = await workspace({
    "config.json": { promotions: [window("offpeak", { enabled: false })] },
    "promotions-cache.json": cacheFile([window("offpeak"), window("other")]),
  });
  // `enabled: false` stops being a window, so it can no longer shadow the shared
  // one it was copied from — the answer the user wrote has to survive that.
  const sources = promotionSources(env);
  assert.deepEqual(sources.local, []);
  assert.deepEqual(sources.shared.map((entry) => entry.id), ["other"]);
});

test("`disabled` matches a shared id that the sanitizer had to truncate", async () => {
  const longId = "o".repeat(100);
  const { env } = await workspace({
    "config.json": { disabled: [longId] },
    "promotions-cache.json": cacheFile([window(longId), window("other")]),
  });
  // The id is capped at 64 characters when the window is read; comparing the
  // config's raw copy against it would silently never match.
  assert.deepEqual(promotionSources(env).shared.map((entry) => entry.id), ["other"]);
});

test("`shared: false` opts out of the repository schedule entirely", async () => {
  const { env } = await workspace({
    "config.json": { shared: false, promotions: [window("mine")] },
    "promotions-cache.json": cacheFile([window("offpeak")]),
  });
  const sources = promotionSources(env);
  assert.equal(sources.sharedOrigin, "off");
  assert.deepEqual(sources.shared, []);
  assert.equal(sources.sharedStale, false);
  assert.deepEqual(readPromotionWindows(env).map((entry) => entry.id), ["mine"]);
});

test("a fetch replaces the cache and is read back as the shared schedule", async () => {
  const { env } = await workspace();
  const fetched = await refreshSharedPromotions({
    env,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ promotions: [window("from-remote")] }),
    }),
  });
  assert.equal(fetched, true);
  const sources = promotionSources(env);
  assert.equal(sources.sharedOrigin, "remote");
  assert.deepEqual(sources.shared.map((entry) => entry.id), ["from-remote"]);
  assert.equal(sources.sharedStale, false);
});

test("a failed fetch leaves the previous cache in place", async () => {
  const { env } = await workspace({
    "promotions-cache.json": cacheFile([window("shared-one")]),
  });
  for (
    const fetchImpl of [
      async () => {
        throw new Error("offline");
      },
      async () => ({ ok: false, text: async () => "" }),
      async () => ({ ok: true, text: async () => "{ not json" }),
    ]
  ) {
    assert.equal(await refreshSharedPromotions({ env, fetchImpl }), false);
    assert.deepEqual(
      promotionSources(env).shared.map((entry) => entry.id),
      ["shared-one"],
    );
  }
});

test("AGENT_HUD_NO_REMOTE stops the request and the staleness that triggers it", async () => {
  const { env } = await workspace();
  const offline = { ...env, AGENT_HUD_NO_REMOTE: "1" };
  let called = false;
  const fetched = await refreshSharedPromotions({
    env: offline,
    fetchImpl: async () => {
      called = true;
      return { ok: true, text: async () => "{}" };
    },
  });
  assert.equal(fetched, false);
  assert.equal(called, false);
  assert.equal(remoteFetchDisabled(offline), true);
  assert.equal(promotionSources(offline).sharedStale, false);
});

test("a cache fetched from another URL is not an answer for this one", async () => {
  const { env } = await workspace({
    "promotions-cache.json": cacheFile([window("elsewhere")], {
      url: "https://example.test/p.json",
    }),
  });
  const sources = promotionSources(env);
  assert.equal(sources.sharedOrigin, "bundled");
  assert.deepEqual(sources.shared.map((entry) => entry.id), []);
  // Changing the override has to take effect now, not when the TTL expires.
  assert.equal(sources.sharedStale, true);
});

test("a schedule shipped with a newer package supersedes an older cache", async () => {
  const { env } = await workspace({
    "promotions-cache.json": cacheFile([], {
      document: { updated: "2000-01-01", promotions: [window("last-year")] },
    }),
  });
  // Upgrading while offline must not keep answering from the older schedule.
  assert.equal(promotionSources(env).sharedOrigin, "bundled");

  const { env: fresher } = await workspace({
    "promotions-cache.json": cacheFile([], {
      document: { updated: "2999-01-01", promotions: [window("from-remote")] },
    }),
  });
  assert.equal(promotionSources(fresher).sharedOrigin, "remote");
});

test("a cache stamped in the future is refreshed instead of trusted", async () => {
  const { directory, env } = await workspace({
    "promotions-cache.json": cacheFile([window("shared-one")]),
  });
  const future = Date.now() / 1_000 + 48 * 60 * 60;
  await fs.utimes(path.join(directory, "promotions-cache.json"), future, future);
  // A clock moved backwards would otherwise freeze the cache for two days.
  assert.equal(promotionSources(env).sharedStale, true);
});

test("a cache written this instant is not mistaken for one from the future", async () => {
  const { directory, env } = await workspace({
    "promotions-cache.json": cacheFile([window("shared-one")]),
  });
  // A file written now can carry an mtime a fraction of a second ahead of
  // Date.now(), and calling that stale means refetching on the very next
  // repaint after a successful fetch.
  const justAhead = Date.now() / 1_000 + 0.5;
  await fs.utimes(path.join(directory, "promotions-cache.json"), justAhead, justAhead);
  assert.equal(promotionSources(env).sharedStale, false);
});

test("the schedule URL points at the repository and stays overridable", () => {
  assert.match(
    SHARED_PROMOTIONS_URL,
    /^https:\/\/raw\.githubusercontent\.com\/.+\/promotions\.json$/,
  );
  assert.equal(sharedPromotionsUrl({}), SHARED_PROMOTIONS_URL);
  assert.equal(
    sharedPromotionsUrl({ AGENT_HUD_PROMOTIONS_URL: "https://example.test/p.json" }),
    "https://example.test/p.json",
  );
});
