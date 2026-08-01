import assert from "node:assert/strict";
import test from "node:test";
import { contextPercent } from "../src/snapshot.mjs";

test("uses native context percentage without changing threshold semantics", () => {
  assert.equal(contextPercent({ context_window: { used_percentage: 59.6 } }), 59.6);
});

test("falls back to input plus cache token usage", () => {
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
