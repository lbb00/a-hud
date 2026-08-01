import { eastAsianWidth } from "get-east-asian-width";

/**
 * Terminal layout is measured in cells, not JavaScript string length.
 *
 * Keep the control/grapheme logic local and use the focused Unicode EAW table
 * for code-point width. The HUD only needs three operations — measure, keep a
 * path tail, and enforce a hard right edge. Grapheme segmentation keeps
 * combining marks and ZWJ emoji intact; ANSI/OSC sequences occupy no cells.
 */

const RESET = "\u001b[0m";
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

// CSI covers SGR emitted by the HUD plus other common terminal controls. OSC
// includes hyperlinks so an injected label cannot distort width accounting.
const ESCAPE_AT_START =
  /^(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))/;
const OSC8 = /^\u001b\]8;;([^\u0007\u001b]*)(?:\u0007|\u001b\\)$/;
const OSC8_CLOSE = "\u001b]8;;\u001b\\";

type DisplayToken =
  | { type: "escape"; value: string }
  | { type: "text"; value: string };

function tokenize(text: string): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  let index = 0;
  let plainStart = 0;

  while (index < text.length) {
    if (text.charCodeAt(index) !== 0x1b) {
      index += 1;
      continue;
    }
    const match = ESCAPE_AT_START.exec(text.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    if (plainStart < index) {
      tokens.push({ type: "text", value: text.slice(plainStart, index) });
    }
    tokens.push({ type: "escape", value: match[0] });
    index += match[0].length;
    plainStart = index;
  }

  if (plainStart < text.length) {
    tokens.push({ type: "text", value: text.slice(plainStart) });
  }
  return tokens;
}

function graphemes(text: string): string[] {
  if (!text) return [];
  if (!GRAPHEME_SEGMENTER) return Array.from(text);
  return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
}

function cjkAmbiguousWidth(): boolean {
  const locale = process.env.LC_ALL ||
    process.env.LC_CTYPE ||
    process.env.LANG ||
    process.env.LANGUAGE ||
    "";
  return /(?:^|:)(?:zh|ja|ko)(?:[_\-.]|$)/i.test(locale);
}

function graphemeWidth(grapheme: string, ambiguousWide: boolean): number {
  if (!grapheme) return 0;

  // Emoji-presentation clusters, flags, keycaps, and ZWJ sequences render as
  // one glyph occupying two cells. Text-presentation symbols such as ✓ stay
  // narrow unless the terminal's CJK locale makes them ambiguous-wide.
  if (
    /\p{Emoji_Presentation}/u.test(grapheme) ||
    /[\u200d\u20e3\ufe0f]/u.test(grapheme) ||
    /[\u{1f1e6}-\u{1f1ff}]/u.test(grapheme)
  ) {
    return 2;
  }

  let width = 0;
  for (const character of grapheme) {
    if (/^\p{Mark}$/u.test(character) || character === "\u200d") continue;
    const codePoint = character.codePointAt(0);
    if (
      codePoint == null ||
      codePoint === 0 ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint < 0xa0)
    ) {
      continue;
    }
    const characterWidth = eastAsianWidth(codePoint, {
      ambiguousAsWide: ambiguousWide,
    });
    width = Math.max(width, characterWidth);
  }
  return width;
}

export function terminalWidth(text: string): number {
  const ambiguousWide = cjkAmbiguousWidth();
  let width = 0;
  for (const token of tokenize(String(text))) {
    if (token.type === "escape") continue;
    for (const grapheme of graphemes(token.value)) {
      width += graphemeWidth(grapheme, ambiguousWide);
    }
  }
  return width;
}

export function truncateLeft(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (terminalWidth(text) <= maxWidth) return text;

  // A left-truncated path is plain display data in Agent HUD. If a future
  // caller passes ANSI/OSC, discard formatting before slicing so no partial
  // escape can survive into the terminal.
  const plain = tokenize(text)
    .filter((token): token is Extract<DisplayToken, { type: "text" }> =>
      token.type === "text")
    .map((token) => token.value)
    .join("");
  const ellipsis = "…";
  const ellipsisWidth = terminalWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsisWidth <= maxWidth ? ellipsis : ".";

  const available = maxWidth - ellipsisWidth;
  const segments = graphemes(plain);
  let suffix = "";
  let width = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const segmentWidth = terminalWidth(segment);
    if (width + segmentWidth > available) break;
    suffix = segment + suffix;
    width += segmentWidth;
  }
  return `${ellipsis}${suffix}`;
}

export function truncateRight(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (terminalWidth(text) <= maxWidth) return text;

  const ellipsis = "…";
  const ellipsisWidth = terminalWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsisWidth <= maxWidth ? ellipsis : ".";

  const available = maxWidth - ellipsisWidth;
  const ambiguousWide = cjkAmbiguousWidth();
  let output = "";
  let width = 0;
  let sawEscape = false;
  let hyperlinkOpen = false;
  let full = false;

  for (const token of tokenize(text)) {
    if (token.type === "escape") {
      output += token.value;
      sawEscape = true;
      const hyperlink = OSC8.exec(token.value);
      if (hyperlink) hyperlinkOpen = hyperlink[1].length > 0;
      continue;
    }
    for (const grapheme of graphemes(token.value)) {
      const nextWidth = graphemeWidth(grapheme, ambiguousWide);
      if (width + nextWidth > available) {
        full = true;
        break;
      }
      output += grapheme;
      width += nextWidth;
    }
    if (full) break;
  }

  // Close OSC 8 before the ellipsis so the truncation marker is not clickable.
  // SGR reset follows it to prevent a cut painted field leaking into the shell.
  return `${output}${hyperlinkOpen ? OSC8_CLOSE : ""}${ellipsis}${sawEscape ? RESET : ""}`;
}
