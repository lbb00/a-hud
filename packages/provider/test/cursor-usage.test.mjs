import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cursorPlanUsageFromBody,
  readCursorPlanUsage,
  refreshCursorPlanUsage,
} from "../dist/index.js";

const BODY = {
  billingCycleStart: "1792123051000",
  billingCycleEnd: "1794801451000",
  planUsage: {
    autoPercentUsed: 0.71,
    apiPercentUsed: 100,
    totalPercentUsed: 8.35,
  },
};

function unsignedJwt(sub) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("reads auto and api percents and caps a pool at 100", () => {
  assert.deepEqual(cursorPlanUsageFromBody(BODY), {
    autoPercent: 0.71,
    apiPercent: 100,
  });
  assert.equal(cursorPlanUsageFromBody({
    planUsage: { apiPercentUsed: 100.4 },
  }).apiPercent, 100);
  assert.equal(cursorPlanUsageFromBody({
    billingCycleStart: "1792123051000",
    billingCycleEnd: "1794801451000",
    planUsage: { autoPercentUsed: 1 },
  }).cycleEnd, undefined);
});

test("does not invent zero when a pool is absent", () => {
  const usage = cursorPlanUsageFromBody({
    planUsage: { apiPercentUsed: 100 },
  });
  assert.equal(usage.autoPercent, null);
  assert.equal(usage.apiPercent, 100);
  assert.equal(cursorPlanUsageFromBody({}), null);
  assert.equal(cursorPlanUsageFromBody({ planUsage: { autoPercentUsed: "nope" } }), null);
});

test("caches plan usage without storing the access token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hud-cursor-"));
  const config = path.join(home, "cursor-config");
  await fs.mkdir(config);
  await fs.writeFile(path.join(config, "auth.json"), JSON.stringify({
    accessToken: "test-token-value",
  }));
  const env = {
    AGENT_HUD_DATA_DIR: path.join(home, "data"),
    CURSOR_CONFIG_DIR: config,
  };
  let authorization = "";
  await refreshCursorPlanUsage({
    home,
    env,
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init.headers).get("authorization") || "";
      return new Response(JSON.stringify(BODY), { status: 200 });
    },
  });

  assert.equal(authorization, "Bearer test-token-value");
  const cachePath = path.join(home, "data", "cursor", "plan-usage.json");
  const cache = await fs.readFile(cachePath, "utf8");
  assert.doesNotMatch(cache, /test-token-value/);
  const read = await readCursorPlanUsage(Math.floor(Date.now() / 1000), home, env);
  assert.equal(read.stale, false);
  assert.equal(read.usage.autoPercent, 0.71);
  assert.equal(read.usage.apiPercent, 100);

  await refreshCursorPlanUsage({
    home,
    env,
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  const afterFailure = await readCursorPlanUsage(Math.floor(Date.now() / 1000), home, env);
  assert.equal(afterFailure.usage.apiPercent, 100);
  assert.doesNotMatch(cache, /billingCycle|cycleStart|cycleEnd/);
});

test("hides a cached plan when the signed-in account changes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hud-cursor-"));
  const config = path.join(home, "cursor-config");
  await fs.mkdir(config);
  const auth = path.join(config, "auth.json");
  const env = {
    AGENT_HUD_DATA_DIR: path.join(home, "data"),
    CURSOR_CONFIG_DIR: config,
  };
  await fs.writeFile(auth, JSON.stringify({ accessToken: unsignedJwt("user-a") }));
  await refreshCursorPlanUsage({
    home,
    env,
    fetchImpl: async () => new Response(JSON.stringify(BODY), { status: 200 }),
  });
  const sameUser = await readCursorPlanUsage(Math.floor(Date.now() / 1000), home, env);
  assert.equal(sameUser.usage.apiPercent, 100);

  await fs.writeFile(auth, JSON.stringify({ accessToken: unsignedJwt("user-a") + "other" }));
  const refreshedToken = await readCursorPlanUsage(Math.floor(Date.now() / 1000), home, env);
  assert.equal(refreshedToken.usage.apiPercent, 100);

  await fs.writeFile(auth, JSON.stringify({ accessToken: unsignedJwt("user-b") }));
  const switched = await readCursorPlanUsage(Math.floor(Date.now() / 1000), home, env);
  assert.equal(switched.usage, null);
  assert.equal(switched.stale, true);
  const stored = await fs.readFile(path.join(home, "data", "cursor", "plan-usage.json"), "utf8");
  assert.doesNotMatch(stored, /user-a|user-b/);
});
