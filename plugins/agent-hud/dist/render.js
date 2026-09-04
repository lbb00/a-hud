// src/render.ts
import os from "node:os";
import path from "node:path";

// src/design.ts
var HUD_DESIGN = {
  warning: {
    /**
     * The API is stateless: system + history is resent and the cached prefix is
     * read on every turn. C×N is therefore a useful action trigger: it rises
     * when either context or turn count makes continued re-reading expensive.
     *
     * These thresholds preserve the shell HUD's regression-calibrated ≈$4 and
     * ≈$13 attention points. Re-read share was intentionally rejected because
     * it stays roughly constant and cannot answer *when* to compact.
     */
    contextPressure: { yellow: 5e6, red: 16e6 },
    /**
     * Fullness is deliberately independent from pressure. It answers “should I
     * compact now?”, while C×N answers “is repeated context reading expensive?”
     */
    contextFullness: { yellow: 70, red: 80 },
    costUsd: { yellow: 4, red: 13 },
    quotaUsage: { yellow: 60, red: 85 },
    quotaPace: { yellow: 120, red: 200 },
    forcedCompactTurns: { yellow: 6, red: 3 }
  },
  cache: {
    fallbackTtlSeconds: 3600,
    expiringWithinSeconds: 300
  },
  compact: {
    /**
     * Median residual context measured after an in-session context reset in the
     * shell HUD. It drives the voluntary /compact break-even estimate.
     */
    summaryTokens: 17e3,
    /** Far-away estimates are noise; the instantaneous context box is enough. */
    forcedEtaMaxTurns: 30,
    breakEvenMaxTurns: 15,
    /** The shell used at most six changed-percentage rows for the recent slope. */
    recentChangedRows: 6
  },
  quota: {
    fiveHourSeconds: 18e3,
    sevenDaySeconds: 604800,
    paceNoiseFloorFraction: 0.1,
    paceNoiseFloorUsage: 8
  },
  layout: {
    /** Below 60 columns the optional decision-support line disappears whole. */
    narrowColumns: 60,
    cwdFallbackColumns: 36,
    cwdReservedColumns: 22,
    cwdMinimumColumns: 14
  }
};
function healthSeverity(indicator) {
  if (indicator === "major" || indicator === "critical") return "red";
  if (indicator === "minor") return "yellow";
  return "plain";
}

// ../../node_modules/get-east-asian-width/lookup-data.js
var ambiguousMinimalCodePoint = 161;
var ambiguousMaximumCodePoint = 1114109;
var ambiguousRanges = [161, 161, 164, 164, 167, 168, 170, 170, 173, 174, 176, 180, 182, 186, 188, 191, 198, 198, 208, 208, 215, 216, 222, 225, 230, 230, 232, 234, 236, 237, 240, 240, 242, 243, 247, 250, 252, 252, 254, 254, 257, 257, 273, 273, 275, 275, 283, 283, 294, 295, 299, 299, 305, 307, 312, 312, 319, 322, 324, 324, 328, 331, 333, 333, 338, 339, 358, 359, 363, 363, 462, 462, 464, 464, 466, 466, 468, 468, 470, 470, 472, 472, 474, 474, 476, 476, 593, 593, 609, 609, 708, 708, 711, 711, 713, 715, 717, 717, 720, 720, 728, 731, 733, 733, 735, 735, 768, 879, 913, 929, 931, 937, 945, 961, 963, 969, 1025, 1025, 1040, 1103, 1105, 1105, 8208, 8208, 8211, 8214, 8216, 8217, 8220, 8221, 8224, 8226, 8228, 8231, 8240, 8240, 8242, 8243, 8245, 8245, 8251, 8251, 8254, 8254, 8308, 8308, 8319, 8319, 8321, 8324, 8364, 8364, 8451, 8451, 8453, 8453, 8457, 8457, 8467, 8467, 8470, 8470, 8481, 8482, 8486, 8486, 8491, 8491, 8531, 8532, 8539, 8542, 8544, 8555, 8560, 8569, 8585, 8585, 8592, 8601, 8632, 8633, 8658, 8658, 8660, 8660, 8679, 8679, 8704, 8704, 8706, 8707, 8711, 8712, 8715, 8715, 8719, 8719, 8721, 8721, 8725, 8725, 8730, 8730, 8733, 8736, 8739, 8739, 8741, 8741, 8743, 8748, 8750, 8750, 8756, 8759, 8764, 8765, 8776, 8776, 8780, 8780, 8786, 8786, 8800, 8801, 8804, 8807, 8810, 8811, 8814, 8815, 8834, 8835, 8838, 8839, 8853, 8853, 8857, 8857, 8869, 8869, 8895, 8895, 8978, 8978, 9312, 9449, 9451, 9547, 9552, 9587, 9600, 9615, 9618, 9621, 9632, 9633, 9635, 9641, 9650, 9651, 9654, 9655, 9660, 9661, 9664, 9665, 9670, 9672, 9675, 9675, 9678, 9681, 9698, 9701, 9711, 9711, 9733, 9734, 9737, 9737, 9742, 9743, 9756, 9756, 9758, 9758, 9792, 9792, 9794, 9794, 9824, 9825, 9827, 9829, 9831, 9834, 9836, 9837, 9839, 9839, 9886, 9887, 9919, 9919, 9926, 9933, 9935, 9939, 9941, 9953, 9955, 9955, 9960, 9961, 9963, 9969, 9972, 9972, 9974, 9977, 9979, 9980, 9982, 9983, 10045, 10045, 10102, 10111, 11094, 11097, 12872, 12879, 57344, 63743, 65024, 65039, 65533, 65533, 127232, 127242, 127248, 127277, 127280, 127337, 127344, 127373, 127375, 127376, 127387, 127404, 917760, 917999, 983040, 1048573, 1048576, 1114109];
var fullwidthMinimalCodePoint = 12288;
var fullwidthMaximumCodePoint = 65510;
var fullwidthRanges = [12288, 12288, 65281, 65376, 65504, 65510];
var wideMinimalCodePoint = 4352;
var wideMaximumCodePoint = 262141;
var wideRanges = [4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141];

// ../../node_modules/get-east-asian-width/utilities.js
var isInRange = (ranges, codePoint) => {
  let low = 0;
  let high = Math.floor(ranges.length / 2) - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const i = mid * 2;
    if (codePoint < ranges[i]) {
      high = mid - 1;
    } else if (codePoint > ranges[i + 1]) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
};

// ../../node_modules/get-east-asian-width/lookup.js
var commonCjkCodePoint = 19968;
var [wideFastPathStart, wideFastPathEnd] = /* @__PURE__ */ findWideFastPathRange(wideRanges);
function findWideFastPathRange(ranges) {
  let fastPathStart = ranges[0];
  let fastPathEnd = ranges[1];
  for (let index = 0; index < ranges.length; index += 2) {
    const start = ranges[index];
    const end = ranges[index + 1];
    if (commonCjkCodePoint >= start && commonCjkCodePoint <= end) {
      return [start, end];
    }
    if (end - start > fastPathEnd - fastPathStart) {
      fastPathStart = start;
      fastPathEnd = end;
    }
  }
  return [fastPathStart, fastPathEnd];
}
var isAmbiguous = (codePoint) => {
  if (codePoint < ambiguousMinimalCodePoint || codePoint > ambiguousMaximumCodePoint) {
    return false;
  }
  return isInRange(ambiguousRanges, codePoint);
};
var isFullWidth = (codePoint) => {
  if (codePoint < fullwidthMinimalCodePoint || codePoint > fullwidthMaximumCodePoint) {
    return false;
  }
  return isInRange(fullwidthRanges, codePoint);
};
var isWide = (codePoint) => {
  if (codePoint >= wideFastPathStart && codePoint <= wideFastPathEnd) {
    return true;
  }
  if (codePoint < wideMinimalCodePoint || codePoint > wideMaximumCodePoint) {
    return false;
  }
  return isInRange(wideRanges, codePoint);
};

// ../../node_modules/get-east-asian-width/index.js
function validate(codePoint) {
  if (!Number.isSafeInteger(codePoint)) {
    throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
  }
}
function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
  validate(codePoint);
  if (isFullWidth(codePoint) || isWide(codePoint) || ambiguousAsWide && isAmbiguous(codePoint)) {
    return 2;
  }
  return 1;
}

// src/terminal-width.ts
var RESET = "\x1B[0m";
var GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
var ESCAPE_AT_START = /^(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))/;
var OSC8 = /^\u001b\]8;;([^\u0007\u001b]*)(?:\u0007|\u001b\\)$/;
var OSC8_CLOSE = "\x1B]8;;\x1B\\";
function tokenize(text) {
  const tokens = [];
  let index = 0;
  let plainStart = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 27) {
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
function graphemes(text) {
  if (!text) return [];
  if (!GRAPHEME_SEGMENTER) return Array.from(text);
  return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
}
function cjkAmbiguousWidth() {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || process.env.LANGUAGE || "";
  return /(?:^|:)(?:zh|ja|ko)(?:[_\-.]|$)/i.test(locale);
}
function graphemeWidth(grapheme, ambiguousWide) {
  if (!grapheme) return 0;
  if (new RegExp("\\p{Emoji_Presentation}", "u").test(grapheme) || /[\u200d\u20e3\ufe0f]/u.test(grapheme) || /[\u{1f1e6}-\u{1f1ff}]/u.test(grapheme)) {
    return 2;
  }
  let width = 0;
  for (const character of grapheme) {
    if (new RegExp("^\\p{Mark}$", "u").test(character) || character === "\u200D") continue;
    const codePoint = character.codePointAt(0);
    if (codePoint == null || codePoint === 0 || codePoint < 32 || codePoint >= 127 && codePoint < 160) {
      continue;
    }
    const characterWidth = eastAsianWidth(codePoint, {
      ambiguousAsWide: ambiguousWide
    });
    width = Math.max(width, characterWidth);
  }
  return width;
}
function terminalWidth(text) {
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
function truncateLeft(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (terminalWidth(text) <= maxWidth) return text;
  const plain = tokenize(text).filter((token) => token.type === "text").map((token) => token.value).join("");
  const ellipsis = "\u2026";
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
function truncateRight(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (terminalWidth(text) <= maxWidth) return text;
  const ellipsis = "\u2026";
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
  return `${output}${hyperlinkOpen ? OSC8_CLOSE : ""}${ellipsis}${sawEscape ? RESET : ""}`;
}

// src/render.ts
var RESET2 = "\x1B[0m";
var PALETTE = {
  dim: "\x1B[2m",
  bright: "\x1B[97m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  red: "\x1B[31m"
};
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function paint(name, text, colors) {
  return colors ? `${PALETTE[name]}${text}${RESET2}` : text;
}
function dimLine(text, colors) {
  if (!colors) return text;
  return `${PALETTE.dim}${text.replaceAll(RESET2, `${RESET2}${PALETTE.dim}`)}${RESET2}`;
}
function displayText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "") : "";
}
function visibleLength(text) {
  return terminalWidth(text);
}
function toneFor(value, yellowAt, redAt) {
  if (!isFiniteNumber(value)) return null;
  if (value >= redAt) return "red";
  if (value >= yellowAt) return "yellow";
  return null;
}
function signal(value, tone, colors) {
  return tone ? paint(tone, value, colors) : value;
}
function severityTone(severity) {
  return severity && severity !== "plain" ? severity : null;
}
function severityRank(severity) {
  return severity === "red" ? 2 : severity === "yellow" ? 1 : 0;
}
function worseSeverity(left, right) {
  return severityRank(right) > severityRank(left) ? right : left;
}
function toneSeverity(tone) {
  return tone || "plain";
}
function more(hidden, colors) {
  return hidden > 0 ? paint("dim", `+${hidden} more`, colors) : null;
}
function toolLine(tools, colors) {
  if (!tools.length) return null;
  const notable = tools.filter((tool) => tool.status === "running" || tool.status === "error");
  if (notable.length) {
    const visible2 = notable.slice(0, 2);
    const parts2 = visible2.map((tool) => {
      const target = tool.target ? ` ${paint("dim", tool.target, colors)}` : "";
      const marker = tool.status === "error" ? signal("!", "red", colors) : signal("\u25D0", "yellow", colors);
      return `${marker} ${tool.name}${target}`;
    });
    const overflow2 = more(notable.length - visible2.length, colors);
    if (overflow2) parts2.push(overflow2);
    return parts2.join(` ${paint("dim", "\u2502", colors)} `);
  }
  const counts = /* @__PURE__ */ new Map();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
  const grouped = [...counts.entries()];
  const visible = grouped.slice(0, 4);
  const parts = visible.map(([name, count]) => `\u2713 ${name}${count > 1 ? ` \xD7${count}` : ""}`);
  const overflow = more(grouped.length - visible.length, colors);
  if (overflow) parts.push(overflow);
  return parts.join(` ${paint("dim", "\u2502", colors)} `);
}
function agentLine(agents, colors) {
  if (!agents.length) return null;
  const visible = agents.slice(0, 3);
  const parts = visible.map((agent) => {
    const active = agent.status === "running";
    const marker = active ? signal("\u25D0", "yellow", colors) : agent.status === "error" ? signal("!", "red", colors) : "\u2713";
    return `${marker} ${agent.type}`;
  });
  const overflow = more(agents.length - visible.length, colors);
  if (overflow) parts.push(overflow);
  return parts.join(` ${paint("dim", "\u2502", colors)} `);
}
function planLine(plan, colors) {
  if (!plan.length) return null;
  const complete = plan.filter((item) => item.status === "completed").length;
  const active = plan.find((item) => item.status === "in_progress") || plan.find((item) => item.status === "pending");
  const label = active?.text ? ` ${active.text}` : "";
  return `\u25B8${label} ${paint("dim", `(${complete}/${plan.length})`, colors)}`;
}
function statusLine(status, colors) {
  return status === "waiting" ? `${signal("?", "yellow", colors)} needs input` : null;
}
function shortEffort(effort) {
  return { low: "L", medium: "M", high: "H", xhigh: "XH", max: "MAX" }[effort] || effort;
}
function toEpochSeconds(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1e10 ? numeric : numeric / 1e3;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed / 1e3 : null;
}
function formatReset(value, includeWeekday = false) {
  if (value == null || value === "") return "";
  const epoch = toEpochSeconds(value);
  if (epoch == null) return "";
  const date = new Date(epoch * 1e3);
  if (Number.isNaN(date.getTime())) return "";
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  if (!includeWeekday || date.toDateString() === (/* @__PURE__ */ new Date()).toDateString()) return hhmm;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  return `${weekday}${hhmm}`;
}
function compactDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total % 86400 / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  if (days) return hours ? `${days}d${hours}h` : `${days}d`;
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}`;
  return `${minutes}m`;
}
function promotionToken(snapshot, colors) {
  const promotion = snapshot.promotion;
  const now = isFiniteNumber(snapshot.observedAt) && snapshot.observedAt > 0 ? snapshot.observedAt : Date.now() / 1e3;
  const text = promotionText(promotion, now);
  if (!text) return "";
  return promotion?.active ? paint("green", text, colors) : text;
}
function promotionText(promotion, now) {
  if (!promotion || !isFiniteNumber(promotion.changesAt)) return "";
  const label = displayText(promotion.label).slice(0, 8);
  const time = compactDuration(promotion.changesAt - now);
  return `%${label}${label ? " " : ""}${promotion.active ? "" : "\u2191"}${time}`;
}
function incidentText(indicator, label) {
  if (healthSeverity(indicator) === "plain") return "";
  return `!${displayText(label).slice(0, 12)}`;
}
function compactTokens(value) {
  if (!isFiniteNumber(value)) return "";
  return value >= 1e3 ? `${Math.floor(value / 1e3)}k` : `${Math.floor(value)}`;
}
function displayPath(cwd) {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}${path.sep}`)) return `~/${cwd.slice(home.length + 1)}`;
  return cwd;
}
function quotaSeverity(snapshot, now = snapshot.observedAt) {
  let binding = snapshot.limits[0];
  for (const limit of snapshot.limits) {
    if (!binding || Math.floor(limit.percent) > Math.floor(binding.percent)) {
      binding = limit;
    }
  }
  if (!binding) return "plain";
  let severity = toneSeverity(toneFor(
    Math.floor(binding.percent),
    HUD_DESIGN.warning.quotaUsage.yellow,
    HUD_DESIGN.warning.quotaUsage.red
  ));
  {
    const limit = binding;
    const reset = toEpochSeconds(limit.resetAt);
    const windowSeconds = limit.windowSeconds;
    if (Math.floor(limit.percent) < HUD_DESIGN.quota.paceNoiseFloorUsage || reset == null || !windowSeconds) return severity;
    const remaining = Math.max(1, Math.min(windowSeconds, reset - now));
    const elapsed = windowSeconds - remaining;
    if (elapsed < windowSeconds * HUD_DESIGN.quota.paceNoiseFloorFraction) return severity;
    const projected = Math.floor(limit.percent) * windowSeconds / elapsed;
    const pace = toneFor(
      projected,
      HUD_DESIGN.warning.quotaPace.yellow,
      HUD_DESIGN.warning.quotaPace.red
    );
    severity = worseSeverity(severity, toneSeverity(pace));
  }
  return severity;
}
function renderSnapshot(snapshot, options = {}) {
  const colors = options.colors ?? !process.env.NO_COLOR;
  const columns = options.width || Number(process.env.COLUMNS) || 0;
  const separator = paint("dim", " | ", colors);
  const line1 = [];
  const model = displayText(snapshot.model).replace(/\s+\([^)]*\)$/, "");
  if (model) line1.push(signal(model, severityTone(snapshot.modelSeverity), colors));
  const effort = displayText(snapshot.effort).slice(0, 16);
  if (effort) {
    const effortTone = effort === "high" ? "yellow" : ["xhigh", "max"].includes(effort) ? "red" : null;
    line1.push(signal(shortEffort(effort), effortTone, colors));
  }
  if (isFiniteNumber(snapshot.totalInput) && isFiniteNumber(snapshot.contextSize) && snapshot.contextSize > 0) {
    const pressure = snapshot.totalInput * (snapshot.turns || 0);
    const pressureTone = toneFor(
      pressure,
      HUD_DESIGN.warning.contextPressure.yellow,
      HUD_DESIGN.warning.contextPressure.red
    );
    const fullnessTone = toneFor(
      snapshot.context,
      HUD_DESIGN.warning.contextFullness.yellow,
      HUD_DESIGN.warning.contextFullness.red
    );
    const token = signal(compactTokens(snapshot.totalInput), pressureTone, colors);
    const pct = isFiniteNumber(snapshot.context) ? signal(`/${Math.floor(snapshot.context)}%`, fullnessTone, colors) : "";
    const turns = snapshot.turns > 0 ? signal(` ${snapshot.turns}t`, pressureTone, colors) : "";
    line1.push(`${token}${pct}${turns}`);
  }
  if (snapshot.cache) {
    if (snapshot.cache.state === "cold") {
      line1.push(signal("*cold", "red", colors));
    } else {
      line1.push(signal(
        `*${formatReset(snapshot.cache.expiresAt)}`,
        snapshot.cache.state === "expiring" ? "yellow" : null,
        colors
      ));
    }
  }
  if (snapshot.limits.length) {
    const quota = snapshot.limits.map((limit) => `${Math.floor(limit.percent)}%`).join("/");
    line1.push(signal(`#${quota}`, severityTone(quotaSeverity(snapshot)), colors));
  }
  const resets = (snapshot.resets || []).map((reset) => formatReset(reset.resetAt, reset.label === "7d")).filter(Boolean);
  if (resets.length) {
    line1.push(`\u21BB${resets.join("/")}`);
  }
  const promotion = promotionToken(snapshot, colors);
  if (promotion) line1.push(promotion);
  const lines = [];
  if (line1.length) lines.push(line1.join(separator));
  const line2 = [];
  if (isFiniteNumber(snapshot.cost) && snapshot.cost > 0) {
    line2.push(signal(
      `$${snapshot.cost.toFixed(2)}`,
      toneFor(
        Math.floor(snapshot.cost),
        HUD_DESIGN.warning.costUsd.yellow,
        HUD_DESIGN.warning.costUsd.red
      ),
      colors
    ));
  }
  if (snapshot.compactAdvisor) {
    const advisor = snapshot.compactAdvisor;
    if (advisor.kind === "forced") {
      const label = advisor.full ? "\u2192full" : `\u2192~${advisor.turns}t`;
      const tone = advisor.full || advisor.turns <= HUD_DESIGN.warning.forcedCompactTurns.red ? "red" : advisor.turns <= HUD_DESIGN.warning.forcedCompactTurns.yellow ? "yellow" : null;
      line2.push(signal(label, tone, colors));
    } else {
      line2.push(`\u2193~${advisor.turns}t`);
    }
  }
  if ((!columns || columns >= HUD_DESIGN.layout.narrowColumns) && line2.length) {
    lines.push(line2.join(separator));
  }
  const line3 = [];
  if (snapshot.project) line3.push(paint("bright", snapshot.project, colors));
  if (snapshot.git) {
    const ref = snapshot.git.detached ? `@${snapshot.git.branch}` : snapshot.git.branch;
    const suffix = [
      snapshot.git.dirty ? "*" : "",
      snapshot.git.ahead ? `\u2191${snapshot.git.ahead}` : "",
      snapshot.git.behind ? `\u2193${snapshot.git.behind}` : ""
    ].join("");
    line3.push(paint("dim", ` ${ref}${suffix}`, colors));
  }
  const added = isFiniteNumber(snapshot.linesAdded) ? Math.floor(snapshot.linesAdded) : 0;
  const removed = isFiniteNumber(snapshot.linesRemoved) ? Math.floor(snapshot.linesRemoved) : 0;
  if (added > 0 || removed > 0) line3.push(paint("dim", `+${added}/-${removed}`, colors));
  if (snapshot.cwd) {
    const designMaximum = columns ? Math.max(
      HUD_DESIGN.layout.cwdMinimumColumns,
      columns - HUD_DESIGN.layout.cwdReservedColumns
    ) : HUD_DESIGN.layout.cwdFallbackColumns;
    const prefixWidth = line3.length ? terminalWidth(line3.join(separator)) + terminalWidth(separator) : 0;
    const available = columns ? Math.max(0, columns - prefixWidth) : designMaximum;
    const cwdMax = Math.min(designMaximum, available);
    if (cwdMax > 0) {
      line3.push(paint("dim", truncateLeft(displayPath(snapshot.cwd), cwdMax), colors));
    }
  }
  if (line3.length) lines.push(line3.join(separator));
  if (options.activity ?? true) {
    const status = statusLine(snapshot.status, colors);
    const tools = toolLine(snapshot.tools, colors);
    const agents = agentLine(snapshot.agents, colors);
    const plan = planLine(snapshot.plan, colors);
    const activity = [status, tools, agents, plan].filter(Boolean);
    if (activity.length) lines.push(dimLine(activity.join(" | "), colors));
  }
  return (columns ? lines.map((line) => truncateRight(line, columns)) : lines).join("\n");
}
export {
  incidentText,
  promotionText,
  renderSnapshot,
  visibleLength
};
//# sourceMappingURL=render.js.map
