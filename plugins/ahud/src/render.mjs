import path from "node:path";
import { execFileSync } from "node:child_process";
import { safeText } from "./io.mjs";

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const RESET = "\u001b[0m";
const PALETTE = {
  dim: "\u001b[2m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
};

function paint(name, text, colors) {
  return colors ? `${PALETTE[name]}${text}${RESET}` : text;
}

// Ranges of codepoints that render as double-width (2 terminal columns) in
// most terminals: CJK ideographs, Hangul, Hiragana/Katakana, fullwidth
// forms, etc. Everything else counts as a single column.
function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function charWidth(char) {
  return isWideCodePoint(char.codePointAt(0)) ? 2 : 1;
}

export function visibleLength(text) {
  return [...String(text).replace(ANSI_RE, "")]
    .reduce((sum, char) => sum + charWidth(char), 0);
}

export function truncate(text, width) {
  if (!width || visibleLength(text) <= width) return text;
  const plain = String(text).replace(ANSI_RE, "");
  const chars = [...plain];
  const budget = Math.max(1, width - 1);
  let kept = "";
  let used = 0;
  for (const char of chars) {
    const charW = charWidth(char);
    if (used + charW > budget) break;
    kept += char;
    used += charW;
  }
  if (!kept && chars.length) kept = chars[0];
  return `${kept}…`;
}

export function bar(percent, width = 10, colors = true) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((value / 100) * width);
  const tone = value >= 80 ? "red" : value >= 60 ? "yellow" : "green";
  return `${paint(tone, "█".repeat(filled), colors)}${paint("dim", "░".repeat(width - filled), colors)}`;
}

export function contextPercent(input) {
  const native = input?.context_window?.used_percentage;
  if (Number.isFinite(native)) return Math.max(0, Math.min(100, native));
  const usage = input?.context_window?.current_usage;
  const size = input?.context_window?.context_window_size;
  if (!usage || !Number.isFinite(size) || size <= 0) return null;
  const used =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  return Math.max(0, Math.min(100, (used / size) * 100));
}

// `git status -b` on a repo with no commits yet prints a heading like
// "## No commits yet on main" instead of the usual "## main...origin/main"
// or "## main". A naive split(" ")[0] on the post-"## " text would yield the
// wrong word "No" for that case, so it gets its own branch first.
function branchFromHeading(headingRaw) {
  const heading = headingRaw.replace(/^##\s*/, "");
  const fresh = heading.match(/^No commits yet on (.+)$/);
  if (fresh) return fresh[1].trim();
  return heading.split("...")[0].split(" ")[0];
}

const GIT_STATUS_DEFAULT_TIMEOUT_MS = 600;
const GIT_STATUS_DEFAULT_CACHE_MS = 2000;
const gitStatusCache = new Map();

export function getGitStatus(cwd, options = {}) {
  if (!cwd) return null;
  const exec = options.exec || execFileSync;
  const now = options.now || Date.now;
  const cacheMs = options.cacheMs ?? GIT_STATUS_DEFAULT_CACHE_MS;

  const nowMs = now();
  const cached = gitStatusCache.get(cwd);
  if (cached && nowMs - cached.at < cacheMs) {
    return cached.value;
  }

  let value;
  try {
    const output = exec(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "-b", "--untracked-files=no"],
      { encoding: "utf8", timeout: GIT_STATUS_DEFAULT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
    );
    const lines = output.trimEnd().split("\n");
    const heading = lines.shift() || "";
    const branch = safeText(branchFromHeading(heading), 48);
    value = { branch: branch || "detached", dirty: lines.some(Boolean) };
  } catch {
    value = null;
  }

  gitStatusCache.set(cwd, { at: nowMs, value });
  return value;
}

export function snapshotFromClaude(input, state, git = null) {
  const model =
    safeText(input?.model?.display_name || input?.model?.id, 64) ||
    state.model ||
    "Claude";
  const cwd =
    safeText(input?.workspace?.current_dir || input?.cwd, 320) ||
    state.cwd ||
    process.cwd();
  const limits = [];
  const five = input?.rate_limits?.five_hour?.used_percentage;
  const seven = input?.rate_limits?.seven_day?.used_percentage;
  if (Number.isFinite(five)) limits.push({ label: "5h", percent: five });
  if (Number.isFinite(seven)) limits.push({ label: "7d", percent: seven });
  return {
    platform: "claude",
    model,
    cwd,
    project: path.basename(cwd) || cwd,
    context: contextPercent(input),
    limits,
    git,
    status: state.status,
    tools: state.tools,
    agents: state.agents,
    plan: state.plan,
  };
}

export function snapshotFromState(state, git = null) {
  const cwd = state.cwd || process.cwd();
  return {
    platform: state.platform,
    model: state.model || (state.platform === "codex" ? "Codex" : "Agent"),
    cwd,
    project: path.basename(cwd) || cwd,
    context: null,
    limits: [],
    git,
    status: state.status,
    tools: state.tools,
    agents: state.agents,
    plan: state.plan,
  };
}

function toolLine(tools, colors) {
  if (!tools.length) return null;
  const running = tools.filter((tool) => tool.status === "running").slice(0, 2);
  if (running.length) {
    return running.map((tool) => {
      const target = tool.target ? ` ${paint("dim", tool.target, colors)}` : "";
      return `${paint("yellow", "◐", colors)} ${tool.name}${target}`;
    }).join(` ${paint("dim", "│", colors)} `);
  }
  // Once nothing is still running, aggregate by name — but a tool that ended
  // in "error" (PostToolUseFailure) must stay visually distinct from a
  // successful one, otherwise the whole point of failure hooks (surfacing a
  // failure) is silently lost behind a green checkmark.
  const counts = new Map();
  for (const tool of tools) {
    const entry = counts.get(tool.name) || { count: 0, hasError: false };
    entry.count += 1;
    if (tool.status === "error") entry.hasError = true;
    counts.set(tool.name, entry);
  }
  return [...counts.entries()].slice(0, 4)
    .map(([name, { count, hasError }]) => {
      const icon = hasError ? paint("red", "✗", colors) : paint("green", "✓", colors);
      return `${icon} ${name}${count > 1 ? ` ×${count}` : ""}`;
    })
    .join(` ${paint("dim", "│", colors)} `);
}

function agentLine(agents, colors) {
  if (!agents.length) return null;
  return agents.slice(0, 3).map((agent) => {
    const active = agent.status === "running";
    return `${paint(active ? "yellow" : "green", active ? "◐" : "✓", colors)} ${paint("magenta", agent.type, colors)}`;
  }).join(` ${paint("dim", "│", colors)} `);
}

function planLine(plan, colors) {
  if (!plan.length) return null;
  const complete = plan.filter((item) => item.status === "completed").length;
  const active = plan.find((item) => item.status === "in_progress") ||
    plan.find((item) => item.status === "pending");
  const label = active?.text ? ` ${active.text}` : "";
  return `${paint("cyan", "▸", colors)}${label} ${paint("dim", `(${complete}/${plan.length})`, colors)}`;
}

export function renderSnapshot(snapshot, options = {}) {
  const colors = options.colors ?? !process.env.NO_COLOR;
  const width = options.width || Number(process.env.COLUMNS) || 120;
  const separator = paint("dim", "│", colors);
  const badge = snapshot.platform === "codex" ? "Codex" :
    snapshot.platform === "claude" ? "Claude" : "Agent";
  const git = snapshot.git
    ? ` git:(${snapshot.git.branch}${snapshot.git.dirty ? "*" : ""})`
    : "";
  // state.status ("working"/"idle") is folded from hook events in store.mjs;
  // surface it as a small leading indicator when present.
  const statusIcon = snapshot.status === "working"
    ? `${paint("yellow", "◐", colors)} `
    : snapshot.status === "idle"
      ? `${paint("green", "●", colors)} `
      : "";
  const lines = [
    `${statusIcon}${paint("cyan", `[${badge} · ${snapshot.model}]`, colors)} ${separator} ${snapshot.project}${paint("dim", git, colors)}`,
  ];

  if (Number.isFinite(snapshot.context) || snapshot.limits.length) {
    const context = Number.isFinite(snapshot.context)
      ? `Context ${bar(snapshot.context, 10, colors)} ${Math.round(snapshot.context)}%`
      : "";
    const limits = snapshot.limits.map((limit) =>
      `${limit.label} ${bar(limit.percent, 5, colors)} ${Math.round(limit.percent)}%`
    ).join(` ${separator} `);
    lines.push([context, limits].filter(Boolean).join(` ${separator} `));
  }

  const tools = toolLine(snapshot.tools, colors);
  const agents = agentLine(snapshot.agents, colors);
  if (tools) lines.push(tools);
  if (agents) lines.push(agents);
  const plan = planLine(snapshot.plan, colors);
  if (plan) lines.push(plan);

  return lines.map((line) => truncate(line, width)).join("\n");
}
