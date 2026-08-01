import assert from "node:assert/strict";
import test from "node:test";
import { HUD_DESIGN } from "../dist/design.js";

test("preserves the shell HUD warning and responsive-layout design tokens", () => {
  assert.deepEqual(HUD_DESIGN.warning.contextPressure, {
    yellow: 5_000_000,
    red: 16_000_000,
  });
  assert.deepEqual(HUD_DESIGN.warning.contextFullness, { yellow: 70, red: 80 });
  assert.deepEqual(HUD_DESIGN.warning.costUsd, { yellow: 4, red: 13 });
  assert.deepEqual(HUD_DESIGN.warning.quotaUsage, { yellow: 60, red: 85 });
  assert.deepEqual(HUD_DESIGN.warning.forcedCompactTurns, { yellow: 6, red: 3 });
  assert.equal(HUD_DESIGN.cache.fallbackTtlSeconds, 3_600);
  assert.equal(HUD_DESIGN.cache.expiringWithinSeconds, 300);
  assert.equal(HUD_DESIGN.compact.summaryTokens, 17_000);
  assert.equal(HUD_DESIGN.layout.narrowColumns, 60);
  assert.equal(HUD_DESIGN.layout.cwdFallbackColumns, 36);
});
