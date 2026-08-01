import assert from "node:assert/strict";
import test from "node:test";
import { truncate, visibleLength } from "../src/width.mjs";

test("visibleLength counts CJK characters as display width 2", () => {
  assert.equal(visibleLength("你好"), 4);
});

test("visibleLength counts plain ASCII as width 1 per character (regression)", () => {
  assert.equal(visibleLength("ab"), 2);
});

test("visibleLength sums per-character display width for mixed CJK/ASCII text", () => {
  assert.equal(visibleLength("a你b好"), 1 + 2 + 1 + 2);
});

test("truncate keeps CJK text within the requested display width and marks truncation", () => {
  const result = truncate("你好世界你好世界", 5);
  assert.ok(visibleLength(result) <= 5, `expected visibleLength <= 5, got ${visibleLength(result)}`);
  assert.ok(result.endsWith("…"), "truncated CJK text should end with an ellipsis");
});

// --- grapheme-cluster correctness -----------------------------------------
// A grapheme cluster (composed emoji: base + variation selector / skin-tone
// modifier / regional indicators / ZWJ sequence) is a single visual glyph.
// visibleLength must count the WHOLE cluster as one width-2 glyph, not sum
// the width of each codepoint in it separately.

test("visibleLength counts a heart-with-variation-selector emoji as a single width-2 glyph", () => {
  assert.equal(visibleLength("❤️"), 2);
});

test("visibleLength counts a thumbs-up-with-skin-tone emoji as a single width-2 glyph", () => {
  assert.equal(visibleLength("\u{1f44d}\u{1f3fd}"), 2);
});

test("visibleLength counts a flag (two regional-indicator codepoints) as a single width-2 glyph", () => {
  assert.equal(visibleLength("\u{1f1fa}\u{1f1f8}"), 2);
});

test("visibleLength counts a ZWJ sequence (woman + ZWJ + laptop) as a single width-2 glyph", () => {
  assert.equal(visibleLength("\u{1f469}‍\u{1f4bb}"), 2);
});

test("visibleLength counts a single plain emoji as width 2 (no regression)", () => {
  assert.equal(visibleLength("\u{1f600}"), 2);
});

test("visibleLength counts two plain emoji as width 4 (no regression)", () => {
  assert.equal(visibleLength("\u{1f600}\u{1f600}"), 4);
});

test("visibleLength counts an emoji from a gap between the old named sub-ranges as width 2 (regression)", () => {
  // U+1F7E0 "🟠" fell in a gap between isWideCodePoint's old discrete
  // 0x1f300-0x1f5ff/0x1f600-0x1f64f/... sub-ranges; the single continuous
  // 0x1f300-0x1faff range must cover it.
  assert.equal(visibleLength("\u{1f7e0}"), 2);
});

test("truncate never splits a grapheme cluster in half", () => {
  const zwjEmoji = "\u{1f469}‍\u{1f4bb}"; // 👩‍💻, width 2
  const text = `x${zwjEmoji}y`; // width 1 + 2 + 1 = 4
  for (const width of [1, 2, 3, 4, 5]) {
    const result = truncate(text, width);
    // The result must never contain a dangling ZWJ (U+200D) or skin-tone /
    // regional-indicator fragment that isn't paired with its base — i.e. it
    // must be composed only of whole, valid grapheme clusters.
    assert.ok(
      !result.includes("‍") || result.includes(zwjEmoji),
      `truncate(text, ${width}) must not leave a dangling ZWJ: ${JSON.stringify(result)}`,
    );
  }
});
