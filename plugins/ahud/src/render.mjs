import { visibleLength, truncate } from "./width.mjs";
import { badgeFor } from "./hosts.mjs";

const RESET = "[0m";
const PALETTE = {
  dim: "[2m",
  green: "[32m",
  yellow: "[33m",
  red: "[31m",
  cyan: "[36m",
  magenta: "[35m",
};

function paint(name, text, colors) {
  return colors ? `${PALETTE[name]}${text}${RESET}` : text;
}

export function bar(percent, width = 10, colors = true) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((value / 100) * width);
  const tone = value >= 80 ? "red" : value >= 60 ? "yellow" : "green";
  return `${paint(tone, "█".repeat(filled), colors)}${paint("dim", "░".repeat(width - filled), colors)}`;
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
  // Per the NO_COLOR spec (https://no-color.org/), the mere PRESENCE of the
  // env var disables color, regardless of its value — so `NO_COLOR=""` must
  // still disable color. `!process.env.NO_COLOR` is wrong here because an
  // empty string is falsy, which would leave colors on.
  const colors = options.colors ?? !("NO_COLOR" in process.env);
  const width = options.width || Number(process.env.COLUMNS) || 120;
  const separator = paint("dim", "│", colors);
  const badge = badgeFor(snapshot.platform);
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
