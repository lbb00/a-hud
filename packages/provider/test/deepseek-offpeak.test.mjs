import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promotionSources, resolvePromotion } from "../dist/index.js";

/** Beijing is a fixed UTC+8 with no DST, so its wall clock is a direct offset. */
function beijingSeconds(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute) / 1_000;
}

/** The shared schedule's DeepSeek windows, read from the bundled copy with no
 * cache and no user config on top. */
async function deepseekWindows() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-ds-"));
  const sources = promotionSources({ AGENT_HUD_DATA_DIR: directory });
  assert.equal(sources.sharedOrigin, "bundled");
  return sources.shared.filter((window) =>
    window.endpoints?.includes("api.deepseek.com"),
  );
}

test("DeepSeek off-peak hours are bundled and reachable by endpoint", async () => {
  const windows = await deepseekWindows();
  assert.ok(windows.length >= 3, `expected at least three windows, got ${windows.length}`);
  for (const window of windows) {
    assert.equal(window.timezone, "Asia/Shanghai");
    assert.equal(window.label, "50%");
  }
});

test("a weekday evening is off-peak, counting down to the next morning", async () => {
  const windows = await deepseekWindows();
  // 2026-11-12 is a Thursday. 20:00 Beijing is inside the overnight window
  // that runs 18:00-09:00, so it is idle at half price until Friday 09:00.
  const status = resolvePromotion(windows, {
    platform: "pi",
    endpoint: "https://api.deepseek.com/v1",
    now: beijingSeconds(2026, 11, 12, 20, 0),
  });
  assert.equal(status.active, true);
  assert.equal(status.label, "50%");
  assert.equal(status.changesAt, beijingSeconds(2026, 11, 13, 9, 0));
});

test("a weekday morning peak opens at the noon break", async () => {
  const windows = await deepseekWindows();
  // 10:00 Beijing on a Thursday is peak; the next idle stretch is 12:00-14:00.
  const status = resolvePromotion(windows, {
    platform: "pi",
    endpoint: "https://api.deepseek.com",
    now: beijingSeconds(2026, 11, 12, 10, 0),
  });
  assert.equal(status.active, false);
  assert.equal(status.changesAt, beijingSeconds(2026, 11, 12, 12, 0));
});

test("a weekday afternoon peak opens at the evening stretch", async () => {
  const windows = await deepseekWindows();
  // 15:00 Beijing on a Thursday is peak; the noon break has ended, so the next
  // idle stretch is the overnight window at 18:00.
  const status = resolvePromotion(windows, {
    platform: "pi",
    endpoint: "https://api.deepseek.com",
    now: beijingSeconds(2026, 11, 12, 15, 0),
  });
  assert.equal(status.active, false);
  assert.equal(status.changesAt, beijingSeconds(2026, 11, 12, 18, 0));
});

test("the whole weekend is off-peak", async () => {
  const windows = await deepseekWindows();
  // 2026-11-14 is a Saturday. The all-day weekend window covers it regardless
  // of the hour.
  const status = resolvePromotion(windows, {
    platform: "pi",
    endpoint: "https://api.deepseek.com",
    now: beijingSeconds(2026, 11, 14, 10, 0),
  });
  assert.equal(status.active, true);
});

/** Monday 2026-11-16 09:00 Beijing ends the idle stretch that starts Friday
 * evening: peak resumes there. */
const MONDAY_NINE = beijingSeconds(2026, 11, 16, 9, 0);

test("a discount split across windows counts down to the end of the run", async () => {
  const windows = await deepseekWindows();
  // Each of these is idle time that continues past the end of whichever entry
  // is open. Reporting the open entry's own end tells the reader the half price
  // is about to stop while it actually keeps running for another day.
  for (const [label, now] of [
    ["Friday evening in the overnight entry", beijingSeconds(2026, 11, 13, 20, 0)],
    ["Saturday before 09:00, still in the overnight entry", beijingSeconds(2026, 11, 14, 8, 0)],
    ["Saturday daytime, in the all-day weekend entry", beijingSeconds(2026, 11, 14, 10, 0)],
    ["Sunday, in the all-day weekend entry", beijingSeconds(2026, 11, 15, 10, 0)],
  ]) {
    const status = resolvePromotion(windows, {
      platform: "pi",
      endpoint: "https://api.deepseek.com",
      now,
    });
    assert.equal(status.active, true, label);
    assert.equal(status.changesAt, MONDAY_NINE, label);
  }
});

test("the run stops where peak resumes, not at a fixed offset", async () => {
  const windows = await deepseekWindows();
  // Sunday 20:00 is inside the overnight entry, which already ends Monday
  // 09:00 on its own; the group must not extend it past that.
  assert.equal(
    resolvePromotion(windows, {
      platform: "pi",
      endpoint: "https://api.deepseek.com",
      now: beijingSeconds(2026, 11, 15, 20, 0),
    }).changesAt,
    MONDAY_NINE,
  );
  // Monday 09:00 is peak again, and the next idle stretch is the noon break.
  const peak = resolvePromotion(windows, {
    platform: "pi",
    endpoint: "https://api.deepseek.com",
    now: beijingSeconds(2026, 11, 16, 9, 0),
  });
  assert.equal(peak.active, false);
  assert.equal(peak.changesAt, beijingSeconds(2026, 11, 16, 12, 0));
});

test("windows without a shared group stay separate", () => {
  // Two entries that merely sit next to each other are not one discount: only
  // an explicit group joins them, so an unrelated campaign is never counted
  // into someone else's run.
  const early = { id: "early", label: "50%", timezone: "UTC", start: "00:00", end: "06:00" };
  const late = { id: "late", label: "50%", timezone: "UTC", start: "06:00", end: "12:00" };
  const status = resolvePromotion([early, late], { now: beijingSeconds(2026, 11, 12, 10, 0) });
  assert.equal(status.changesAt, Date.UTC(2026, 10, 12, 6) / 1_000);
});

test("a different endpoint gets no DeepSeek idle-hour badge", async () => {
  const windows = await deepseekWindows();
  // The discount belongs to api.deepseek.com; the same models through a
  // reseller are not part of it, and an unknown endpoint must not claim it.
  const status = resolvePromotion(windows, {
    platform: "pi",
    endpoint: "https://openrouter.ai/api/v1",
    now: beijingSeconds(2026, 11, 12, 20, 0),
  });
  assert.equal(status, null);
});

test("an unstated endpoint gets no DeepSeek idle-hour badge", async () => {
  const windows = await deepseekWindows();
  // A caller that cannot say which API the turn is billed on must not claim
  // the discount.
  const status = resolvePromotion(windows, {
    platform: "pi",
    now: beijingSeconds(2026, 11, 12, 20, 0),
  });
  assert.equal(status, null);
});
