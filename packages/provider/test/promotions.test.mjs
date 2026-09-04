import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readPromotionWindows,
  resolveConfigPath,
  resolvePromotion,
} from "../dist/index.js";

async function configEnv(contents) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-promotions-"));
  const filePath = path.join(directory, "config.json");
  if (contents != null) await fs.writeFile(filePath, contents, "utf8");
  return { AGENT_HUD_CONFIG: filePath };
}

function utcSeconds(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) / 1_000;
}

test("resolves the config path from the data directory or an explicit override", () => {
  assert.equal(
    resolveConfigPath({ AGENT_HUD_CONFIG: "/tmp/custom.json" }),
    "/tmp/custom.json",
  );
  assert.equal(
    resolveConfigPath({ AGENT_HUD_DATA_DIR: "/tmp/data" }),
    path.join("/tmp/data", "config.json"),
  );
});

test("treats a missing or malformed config as no configured windows", async () => {
  assert.deepEqual(readPromotionWindows(await configEnv(null)), []);
  assert.deepEqual(readPromotionWindows(await configEnv("{ not json")), []);
  assert.deepEqual(readPromotionWindows(await configEnv('{"promotions":"nope"}')), []);
});

test("accepts both config shapes and drops unusable entries", async () => {
  const env = await configEnv(JSON.stringify({
    promotions: [
      { label: "50%", start: "23:00", end: "07:00" },
      { id: "bad-clock", start: "25:00", end: "07:00" },
      { id: "disabled", enabled: false, start: "01:00", end: "02:00" },
      { id: "named-days", start: "09:00", end: "18:00", days: ["Sat", "sun", 9] },
    ],
  }));
  const windows = readPromotionWindows(env);
  assert.deepEqual(windows.map((window) => window.id), ["promotion-1", "named-days"]);
  assert.deepEqual(windows[1].days, [6, 0]);

  const bare = readPromotionWindows(
    await configEnv(JSON.stringify([{ id: "x", start: "01:00", end: "02:00" }])),
  );
  assert.deepEqual(bare.map((window) => window.id), ["x"]);
});

test("a mistyped timezone drops only its own window", async () => {
  const env = await configEnv(JSON.stringify({
    promotions: [
      { id: "typo", label: "50%", start: "00:00", end: "23:59", timezone: "Asia/Shanghi" },
      { id: "good", label: "OK", start: "00:00", end: "23:59" },
    ],
  }));
  const windows = readPromotionWindows(env);
  assert.deepEqual(windows.map((window) => window.id), ["good"]);
  // Intl throws on an unknown zone, which used to hide every other window and
  // abort the diagnostic that was supposed to explain the missing badge.
  assert.equal(
    resolvePromotion(windows, { now: utcSeconds(2026, 9, 4, 12) }).id,
    "good",
  );
});

test("strips control sequences and unbounded text from schedule fields", async () => {
  const env = await configEnv(JSON.stringify({
    promotions: [{
      id: `boom\u001b[2Jcleared${"x".repeat(200)}`,
      label: "\u001b[31m50%",
      platforms: ["claude\u001b[0m", `cursor${"y".repeat(200)}`],
      start: "01:00",
      end: "02:00",
    }],
  }));
  const [window] = readPromotionWindows(env);
  // The shared schedule arrives over the network, so nothing from it may reach
  // a terminal as an escape sequence or an unbounded string.
  const text = window.id + window.label + window.platforms.join("");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), JSON.stringify(text));
  assert.ok(window.id.length <= 64, window.id);
  assert.ok(window.label.length <= 8, window.label);
  for (const platform of window.platforms) {
    assert.ok(platform.length <= 16, platform);
  }
});

test("a config that is not a readable small file reads as no windows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-promotions-"));
  // A directory or a FIFO at the config path would throw or block a repaint.
  const asDirectory = path.join(directory, "config.json");
  await fs.mkdir(asDirectory);
  assert.deepEqual(readPromotionWindows({ AGENT_HUD_CONFIG: asDirectory }), []);

  const entry = { id: "kept", label: "50%", start: "01:00", end: "02:00" };
  const huge = { promotions: [entry], note: "x".repeat(70 * 1024) };
  assert.deepEqual(readPromotionWindows(await configEnv(JSON.stringify(huge))), []);
  // The same schedule under the cap still reads, so the cap is what dropped it.
  assert.deepEqual(
    readPromotionWindows(await configEnv(JSON.stringify({ promotions: [entry] }))),
    [entry],
  );
});

test("drops a window whose narrowing fields are unusable", async () => {
  const env = await configEnv(JSON.stringify({
    promotions: [
      // Each of these used to be read as "not set", which shows the badge on
      // every host, every day, or in the wrong zone — the opposite of the ask.
      { id: "host", start: "00:00", end: "23:59", platforms: "claude" },
      { id: "weekday", start: "00:00", end: "23:59", days: [7] },
      { id: "zone", start: "00:00", end: "23:59", timezone: 8 },
      { id: "campaign", start: "00:00", end: "23:59", until: "yesterday" },
      { id: "kept", start: "00:00", end: "23:59", platforms: ["claude"], days: [4] },
    ],
  }));
  assert.deepEqual(readPromotionWindows(env).map((window) => window.id), ["kept"]);
});

test("never coerces schedule values that could throw on the render path", async () => {
  const nested = `${"[".repeat(2_000)}${"]".repeat(2_000)}`;
  const env = await configEnv(
    `{"promotions":[{"id":"deep","start":${nested},"end":"00:00"},` +
      `{"id":"days","start":"01:00","end":"02:00","days":[${nested}]}]}`,
  );
  // String() on a deeply nested array overflows the stack, which used to take
  // out every other window with it.
  assert.deepEqual(readPromotionWindows(env), []);
});

test("caps how many windows one schedule can contribute", async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    id: `w${index}`,
    start: "01:00",
    end: "02:00",
  }));
  const env = await configEnv(JSON.stringify({ promotions: many }));
  // Each window costs a dozen zone conversions per repaint.
  assert.equal(readPromotionWindows(env).length, 64);
});

test("reads config hours as UTC when no timezone is given", () => {
  const windows = [{ id: "offpeak", label: "50%", start: "23:00", end: "07:00" }];
  const status = resolvePromotion(windows, { now: utcSeconds(2026, 9, 3, 1, 30) });
  assert.equal(status.active, true);
  assert.equal(status.changesAt, utcSeconds(2026, 9, 3, 7, 0));

  const outside = resolvePromotion(windows, { now: utcSeconds(2026, 9, 3, 12, 0) });
  assert.equal(outside.active, false);
  assert.equal(outside.changesAt, utcSeconds(2026, 9, 3, 23, 0));
});

test("reports an open window and when it closes", () => {
  const windows = [{
    id: "offpeak",
    label: "50%",
    timezone: "UTC",
    start: "23:00",
    end: "07:00",
  }];
  const status = resolvePromotion(windows, { now: utcSeconds(2026, 9, 3, 1, 30) });
  assert.deepEqual(status, {
    id: "offpeak",
    label: "50%",
    active: true,
    changesAt: utcSeconds(2026, 9, 3, 7, 0),
  });
});

test("reports the next opening when no window is open", () => {
  const windows = [{
    id: "offpeak",
    label: "50%",
    timezone: "UTC",
    start: "23:00",
    end: "07:00",
  }];
  const status = resolvePromotion(windows, { now: utcSeconds(2026, 9, 3, 12, 0) });
  assert.equal(status.active, false);
  assert.equal(status.changesAt, utcSeconds(2026, 9, 3, 23, 0));
});

test("a start time inside the hour a spring-forward skips waits for the real clock", () => {
  // 2026-03-08 is the US spring-forward Sunday: 02:30 America/New_York never
  // happens. Opening at 01:30 EST instead would light the badge an hour early.
  const window = {
    id: "gap",
    label: "2x",
    timezone: "America/New_York",
    start: "02:30",
    end: "04:00",
    from: "2026-03-08",
    until: "2026-03-08",
  };
  const before = resolvePromotion([window], { now: utcSeconds(2026, 3, 8, 6, 40) });
  assert.equal(before.active, false);
  assert.equal(before.changesAt, utcSeconds(2026, 3, 8, 7, 30));
  assert.equal(resolvePromotion([window], { now: utcSeconds(2026, 3, 8, 7, 40) }).active, true);
});

test("an around-the-clock campaign counts down to its last day, not to tonight", () => {
  // A flat multi-day boost is written as an all-day window: 00:00 to 00:00 is
  // one occurrence per day, and the badge must not read as expiring at midnight.
  const campaign = {
    id: "boost",
    label: "+50%",
    timezone: "UTC",
    start: "00:00",
    end: "00:00",
    until: "2026-09-06",
  };
  const status = resolvePromotion([campaign], { now: utcSeconds(2026, 9, 3, 12, 0) });
  assert.equal(status.active, true);
  assert.equal(status.changesAt, utcSeconds(2026, 9, 7, 0, 0));

  // A window with a real gap between days still ends when today's does.
  const nightly = { ...campaign, start: "22:00", end: "02:00" };
  assert.equal(
    resolvePromotion([nightly], { now: utcSeconds(2026, 9, 3, 23, 0) }).changesAt,
    utcSeconds(2026, 9, 4, 2, 0),
  );
});

test("honors weekday, campaign-date and host filters", () => {
  // 2026-09-05 is a Saturday; 2026-09-03 is a Thursday.
  const weekend = {
    id: "weekend",
    label: "2x",
    timezone: "UTC",
    days: [6],
    start: "09:00",
    end: "18:00",
  };
  const thursdayNoon = utcSeconds(2026, 9, 3, 12, 0);
  assert.equal(resolvePromotion([weekend], { now: thursdayNoon }).active, false);
  assert.equal(
    resolvePromotion([weekend], { now: thursdayNoon }).changesAt,
    utcSeconds(2026, 9, 5, 9, 0),
  );
  assert.equal(
    resolvePromotion([weekend], { now: utcSeconds(2026, 9, 5, 10, 0) }).active,
    true,
  );

  const expired = { ...weekend, until: "2026-08-01" };
  assert.equal(resolvePromotion([expired], { now: thursdayNoon }), null);

  const notStarted = { ...weekend, from: "2027-01-01" };
  assert.equal(resolvePromotion([notStarted], { now: thursdayNoon }), null);

  const cursorOnly = { ...weekend, platforms: ["cursor"] };
  assert.equal(
    resolvePromotion([cursorOnly], { now: thursdayNoon, platform: "claude" }),
    null,
  );
  assert.equal(
    resolvePromotion([cursorOnly], { now: thursdayNoon, platform: "cursor" }).id,
    "weekend",
  );
});

test("keeps wall-clock boundaries correct across a DST transition", () => {
  // US DST starts 2026-03-08 02:00 local, so 23:00→07:00 lasts seven hours.
  const windows = [{
    id: "offpeak",
    label: "50%",
    timezone: "America/New_York",
    start: "23:00",
    end: "07:00",
  }];
  const status = resolvePromotion(windows, { now: utcSeconds(2026, 3, 8, 5, 0) });
  assert.equal(status.active, true);
  assert.equal(status.changesAt, utcSeconds(2026, 3, 8, 11, 0));
});

const OFFPEAK = {
  id: "offpeak",
  label: "50%",
  timezone: "UTC",
  start: "00:00",
  end: "23:59",
  endpoints: ["api.deepseek.com"],
};

test("a window bound to an API endpoint stays hidden until the caller names one", () => {
  const now = utcSeconds(2026, 9, 3, 12, 0);
  // A vendor's off-peak pricing is billed on its own API. A host that cannot
  // say which API it is calling must not show the badge on the chance it is.
  assert.equal(resolvePromotion([OFFPEAK], { now }), null);
  assert.equal(
    resolvePromotion([OFFPEAK], { now, endpoint: "https://openrouter.ai/api/v1" }),
    null,
  );
  assert.equal(
    resolvePromotion([OFFPEAK], { now, endpoint: "https://api.deepseek.com/v1" })?.active,
    true,
  );
  // Callers hand over whatever their host holds: a base URL, a bare host, a
  // port, mixed case.
  for (const endpoint of ["api.deepseek.com", "API.DeepSeek.com:443", "https://api.deepseek.com/beta"]) {
    assert.equal(resolvePromotion([OFFPEAK], { now, endpoint })?.id, "offpeak", endpoint);
  }
});

test("an endpoint list that cannot narrow anything drops its window", async () => {
  const kept = { id: "kept", label: "50%", start: "01:00", end: "02:00" };
  for (const endpoints of [[], "api.deepseek.com", [""], [{}]]) {
    const env = await configEnv(
      JSON.stringify({ promotions: [{ ...kept, id: "bad", endpoints }, kept] }),
    );
    assert.deepEqual(
      readPromotionWindows(env).map((window) => window.id),
      ["kept"],
      JSON.stringify(endpoints),
    );
  }

  const env = await configEnv(
    JSON.stringify({ promotions: [{ ...kept, endpoints: ["HTTPS://Api.DeepSeek.com/v1"] }] }),
  );
  assert.deepEqual(readPromotionWindows(env)[0].endpoints, ["api.deepseek.com"]);
});

test("prefers an open window over a pending one, in configured order", () => {
  const open = { id: "open", label: "a", timezone: "UTC", start: "00:00", end: "23:59" };
  const later = { id: "later", label: "b", timezone: "UTC", start: "22:00", end: "23:00" };
  const now = utcSeconds(2026, 9, 3, 12, 0);
  assert.equal(resolvePromotion([later, open], { now }).id, "open");
});
