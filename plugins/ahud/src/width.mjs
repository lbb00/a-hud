const ANSI_RE = /\[[0-9;]*m/g;

// Ranges of codepoints that render as double-width (2 terminal columns) in
// most terminals: CJK ideographs, Hangul, Hiragana/Katakana, fullwidth
// forms, regional indicators, dingbats, and the full emoji range (Misc
// Symbols & Pictographs through Symbols & Pictographs Extended-A). Everything
// else counts as a single column. When used to classify a whole grapheme
// cluster (see clusterWidth below), only the cluster's FIRST codepoint is
// checked here — that's enough to identify the base emoji/CJK character of
// the cluster.
//
// This is a deliberately approximate range table, not a real Unicode
// East-Asian-Width/Emoji-Presentation database: a handful of characters
// inside these ranges aren't actually wide (e.g. alchemical symbols like
// U+1F700), and a few real wide characters fall outside them (e.g. mahjong
// tile U+1F004, or a keycap sequence like "1️⃣" whose first codepoint is a
// plain ASCII digit). Closing those gaps properly needs a real width
// table/dependency, which this project's zero-runtime-dependency,
// terminal-status-line use case (tool names, model IDs, git branches, plan
// text) doesn't warrant — mahjong tiles and alchemical symbols don't show
// up there in practice, and the failure mode either way is a line a column
// or two off, not corrupted output.
function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) ||
    // One continuous range covering every emoji block from Misc Symbols &
    // Pictographs through Symbols & Pictographs Extended-A (round-4 review
    // regression: an earlier rewrite split this into named sub-ranges and
    // left gaps — e.g. U+1F7E0 "🟠" — that a single bound can't miss).
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

// A grapheme cluster (e.g. "❤️", "👍🏽", "🇺🇸", "👩‍💻") is a single visual
// glyph even though it's made of multiple codepoints (base + variation
// selector / skin-tone modifier / regional indicators / ZWJ sequences). We
// segment text into grapheme clusters with Intl.Segmenter and classify each
// whole cluster by its FIRST codepoint (via isWideCodePoint above), instead
// of summing the width of every codepoint in the cluster separately — the
// old per-codepoint approach overcounted composed emoji.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text) {
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}

function clusterWidth(cluster) {
  return isWideCodePoint(cluster.codePointAt(0)) ? 2 : 1;
}

export function visibleLength(text) {
  const plain = String(text).replace(ANSI_RE, "");
  return graphemes(plain).reduce((sum, cluster) => sum + clusterWidth(cluster), 0);
}

export function truncate(text, width) {
  if (!width || visibleLength(text) <= width) return text;
  const plain = String(text).replace(ANSI_RE, "");
  const clusters = graphemes(plain);
  const budget = Math.max(1, width - 1);
  let kept = "";
  let used = 0;
  for (const cluster of clusters) {
    const clusterW = clusterWidth(cluster);
    if (used + clusterW > budget) break;
    kept += cluster;
    used += clusterW;
  }
  if (!kept && clusters.length) kept = clusters[0];
  return `${kept}…`;
}
