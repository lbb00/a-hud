import os from "node:os";
import path from "node:path";
import { healthSeverity, HUD_DESIGN, type Severity } from "./design.js";
import {
  terminalWidth,
  truncateLeft,
  truncateRight,
} from "./terminal-width.js";
import type {
  HudAgent,
  HudPlanItem,
  HudSnapshot,
  HudTool,
} from "./types.js";

const RESET = "\u001b[0m";

/**
 * The palette is intentionally tiny. Hue is reserved for warning severity plus
 * the single opportunity signal (green, an open promotional window);
 * brightness, not decorative color, separates session state from location.
 */
const PALETTE = {
  dim: "\u001b[2m",
  bright: "\u001b[97m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
};
type Tone = keyof typeof PALETTE;
type WarningTone = "yellow" | "red";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function paint(name: Tone, text: string, colors: boolean): string {
  return colors ? `${PALETTE[name]}${text}${RESET}` : text;
}

function dimLine(text: string, colors: boolean): string {
  if (!colors) return text;
  // SGR reset ends every attribute, including an outer dim. Restore dim after
  // nested yellow/red markers so the activity label never becomes a new visual
  // anchor merely because its marker carries warning color.
  return `${PALETTE.dim}${text.replaceAll(RESET, `${RESET}${PALETTE.dim}`)}${RESET}`;
}

function displayText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "")
    : "";
}

export function visibleLength(text: string): number {
  return terminalWidth(text);
}

function toneFor(value: unknown, yellowAt: number, redAt: number): WarningTone | null {
  if (!isFiniteNumber(value)) return null;
  if (value >= redAt) return "red";
  if (value >= yellowAt) return "yellow";
  return null;
}

function signal(value: string, tone: Tone | null, colors: boolean): string {
  return tone ? paint(tone, value, colors) : value;
}

function severityTone(severity?: Severity): Tone | null {
  return severity && severity !== "plain" ? severity : null;
}

function severityRank(severity: Severity): number {
  return severity === "red" ? 2 : severity === "yellow" ? 1 : 0;
}

function worseSeverity(left: Severity, right: Severity): Severity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function toneSeverity(tone: WarningTone | null): Severity {
  return tone || "plain";
}

function more(hidden: number, colors: boolean): string | null {
  return hidden > 0 ? paint("dim", `+${hidden} more`, colors) : null;
}

function toolLine(tools: HudTool[], colors: boolean): string | null {
  if (!tools.length) return null;
  const notable = tools
    .filter((tool) => tool.status === "running" || tool.status === "error");
  if (notable.length) {
    const visible = notable.slice(0, 2);
    const parts = visible.map((tool) => {
      const target = tool.target ? ` ${paint("dim", tool.target, colors)}` : "";
      const marker = tool.status === "error"
        ? signal("!", "red", colors)
        : signal("◐", "yellow", colors);
      return `${marker} ${tool.name}${target}`;
    });
    const overflow = more(notable.length - visible.length, colors);
    if (overflow) parts.push(overflow);
    return parts.join(` ${paint("dim", "│", colors)} `);
  }
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
  const grouped = [...counts.entries()];
  const visible = grouped.slice(0, 4);
  const parts = visible
    .map(([name, count]) => `✓ ${name}${count > 1 ? ` ×${count}` : ""}`)
  const overflow = more(grouped.length - visible.length, colors);
  if (overflow) parts.push(overflow);
  return parts.join(` ${paint("dim", "│", colors)} `);
}

function agentLine(agents: HudAgent[], colors: boolean): string | null {
  if (!agents.length) return null;
  const visible = agents.slice(0, 3);
  const parts = visible.map((agent) => {
    const active = agent.status === "running";
    const marker = active
      ? signal("◐", "yellow", colors)
      : agent.status === "error" ? signal("!", "red", colors) : "✓";
    return `${marker} ${agent.type}`;
  });
  const overflow = more(agents.length - visible.length, colors);
  if (overflow) parts.push(overflow);
  return parts.join(` ${paint("dim", "│", colors)} `);
}

function planLine(plan: HudPlanItem[], colors: boolean): string | null {
  if (!plan.length) return null;
  const complete = plan.filter((item) => item.status === "completed").length;
  const active = plan.find((item) => item.status === "in_progress") ||
    plan.find((item) => item.status === "pending");
  const label = active?.text ? ` ${active.text}` : "";
  return `▸${label} ${paint("dim", `(${complete}/${plan.length})`, colors)}`;
}

function statusLine(status: HudSnapshot["status"], colors: boolean): string | null {
  // Waiting is actionable lifecycle state, so the companion surfaces it even
  // when there is no active tool. Working/idle already have stronger visual
  // evidence (spinners or absence) and would add noise if repeated as labels.
  return status === "waiting"
    ? `${signal("?", "yellow", colors)} needs input`
    : null;
}

function shortEffort(effort: string): string {
  return ({ low: "L", medium: "M", high: "H", xhigh: "XH", max: "MAX" })[effort] || effort;
}

function toEpochSeconds(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric : numeric / 1_000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed / 1_000 : null;
}

function formatReset(value: number | string | null | undefined, includeWeekday = false): string {
  if (value == null || value === "") return "";
  const epoch = toEpochSeconds(value);
  if (epoch == null) return "";
  const date = new Date(epoch * 1_000);
  if (Number.isNaN(date.getTime())) return "";
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (!includeWeekday || date.toDateString() === new Date().toDateString()) return hhmm;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  return `${weekday}${hhmm}`;
}

/**
 * Promotional windows compete for the same first line as quota and resets, so
 * the remaining time is compressed to its two most significant units.
 */
function compactDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days) return hours ? `${days}d${hours}h` : `${days}d`;
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}`;
  return `${minutes}m`;
}

/**
 * An open window turns green: it is the HUD's only reward signal, as opposed to
 * the yellow and red warnings. A window that has not opened yet is marked `↑`
 * and stays plain, because there is nothing to act on yet.
 */
function promotionToken(snapshot: HudSnapshot, colors: boolean): string {
  const promotion = snapshot.promotion;
  const now = isFiniteNumber(snapshot.observedAt) && snapshot.observedAt > 0
    ? snapshot.observedAt
    : Date.now() / 1_000;
  const text = promotionText(promotion, now);
  if (!text) return "";
  return promotion?.active ? paint("green", text, colors) : text;
}

/**
 * The uncolored promotion token. Hosts that cannot take the three-line HUD
 * still show this one, in their own palette, so the wording stays in one place.
 */
export function promotionText(
  promotion: HudSnapshot["promotion"],
  now: number,
): string {
  if (!promotion) return "";
  const label = displayText(promotion.label).slice(0, 8);
  // An open window with no end date shows its label alone: a countdown to a
  // date that does not exist would be a lie, and hiding the badge would deny
  // a discount that is in effect.
  if (promotion.changesAt === null) return promotion.active ? `%${label}` : "";
  if (!isFiniteNumber(promotion.changesAt)) return "";
  const time = compactDuration(promotion.changesAt - now);
  return `%${label}${label ? " " : ""}${promotion.active ? "" : "↑"}${time}`;
}

/**
 * The uncolored incident token. The three-line HUD says this by coloring the
 * model name, which a host that prints no model name of its own cannot do, so
 * those hosts name the vendor instead. Empty unless its status page reports an
 * incident.
 */
export function incidentText(indicator: string, label: string): string {
  if (healthSeverity(indicator) === "plain") return "";
  return `!${displayText(label).slice(0, 12)}`;
}

function compactTokens(value: unknown): string {
  if (!isFiniteNumber(value)) return "";
  return value >= 1000 ? `${Math.floor(value / 1000)}k` : `${Math.floor(value)}`;
}

function displayPath(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}${path.sep}`)) return `~/${cwd.slice(home.length + 1)}`;
  return cwd;
}

function quotaSeverity(snapshot: HudSnapshot, now = snapshot.observedAt): Severity {
  // Match the shell's binding-window rule exactly: floor displayed percentages,
  // let 5h win a tie, and apply pace only to that highest-used window.
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
    HUD_DESIGN.warning.quotaUsage.red,
  ));

  // Absolute percentage alone misses a low-looking quota that is burning fast.
  // Project only the binding window to reset, ignoring its noisy first 10%.
  {
    const limit = binding;
    const reset = toEpochSeconds(limit.resetAt);
    const windowSeconds = limit.windowSeconds;
    if (
      Math.floor(limit.percent) < HUD_DESIGN.quota.paceNoiseFloorUsage ||
      reset == null ||
      !windowSeconds
    ) return severity;
    const remaining = Math.max(1, Math.min(windowSeconds, reset - now));
    const elapsed = windowSeconds - remaining;
    if (elapsed < windowSeconds * HUD_DESIGN.quota.paceNoiseFloorFraction) return severity;
    const projected = Math.floor(limit.percent) * windowSeconds / elapsed;
    const pace = toneFor(
      projected,
      HUD_DESIGN.warning.quotaPace.yellow,
      HUD_DESIGN.warning.quotaPace.red,
    );
    severity = worseSeverity(severity, toneSeverity(pace));
  }
  return severity;
}

export function renderSnapshot(
  snapshot: HudSnapshot,
  options: { colors?: boolean; width?: number; activity?: boolean } = {},
): string {
  const colors = options.colors ?? !process.env.NO_COLOR;
  const columns = options.width || Number(process.env.COLUMNS) || 0;
  const separator = paint("dim", " | ", colors);
  const line1: string[] = [];
  const model = displayText(snapshot.model).replace(/\s+\([^)]*\)$/, "");
  if (model) line1.push(signal(model, severityTone(snapshot.modelSeverity), colors));

  const effort = displayText(snapshot.effort).slice(0, 16);
  if (effort) {
    const effortTone = effort === "high" ? "yellow" :
      ["xhigh", "max"].includes(effort) ? "red" : null;
    line1.push(signal(shortEffort(effort), effortTone, colors));
  }

  if (
    isFiniteNumber(snapshot.totalInput) &&
    isFiniteNumber(snapshot.contextSize) &&
    snapshot.contextSize > 0
  ) {
    const pressure = snapshot.totalInput * (snapshot.turns || 0);
    const pressureTone = toneFor(
      pressure,
      HUD_DESIGN.warning.contextPressure.yellow,
      HUD_DESIGN.warning.contextPressure.red,
    );
    const fullnessTone = toneFor(
      snapshot.context,
      HUD_DESIGN.warning.contextFullness.yellow,
      HUD_DESIGN.warning.contextFullness.red,
    );
    const token = signal(compactTokens(snapshot.totalInput), pressureTone, colors);
    const pct = isFiniteNumber(snapshot.context)
      ? signal(`/${Math.floor(snapshot.context)}%`, fullnessTone, colors)
      : "";
    const turns = snapshot.turns > 0
      ? signal(` ${snapshot.turns}t`, pressureTone, colors)
      : "";
    line1.push(`${token}${pct}${turns}`);
  }

  if (snapshot.cache) {
    if (snapshot.cache.state === "cold") {
      line1.push(signal("*cold", "red", colors));
    } else {
      line1.push(signal(
        `*${formatReset(snapshot.cache.expiresAt)}`,
        snapshot.cache.state === "expiring" ? "yellow" : null,
        colors,
      ));
    }
  }

  if (snapshot.limits.length) {
    const quota = snapshot.limits.map((limit) => `${Math.floor(limit.percent)}%`).join("/");
    line1.push(signal(`#${quota}`, severityTone(quotaSeverity(snapshot)), colors));
  }
  const resets = (snapshot.resets || [])
    .map((reset) => formatReset(reset.resetAt, reset.label === "7d"))
    .filter(Boolean);
  if (resets.length) {
    line1.push(`↻${resets.join("/")}`);
  }
  const promotion = promotionToken(snapshot, colors);
  if (promotion) line1.push(promotion);

  const lines: string[] = [];
  if (line1.length) lines.push(line1.join(separator));

  const line2: string[] = [];
  if (isFiniteNumber(snapshot.cost) && snapshot.cost > 0) {
    line2.push(signal(
      `$${snapshot.cost.toFixed(2)}`,
      toneFor(
        Math.floor(snapshot.cost),
        HUD_DESIGN.warning.costUsd.yellow,
        HUD_DESIGN.warning.costUsd.red,
      ),
      colors,
    ));
  }
  if (snapshot.compactAdvisor) {
    const advisor = snapshot.compactAdvisor;
    if (advisor.kind === "forced") {
      const label = advisor.full ? "→full" : `→~${advisor.turns}t`;
      const tone = advisor.full || advisor.turns <= HUD_DESIGN.warning.forcedCompactTurns.red
        ? "red"
        : advisor.turns <= HUD_DESIGN.warning.forcedCompactTurns.yellow ? "yellow" : null;
      line2.push(signal(label, tone, colors));
    } else {
      // Break-even is an opportunity hint, not a warning, so it stays plain.
      line2.push(`↓~${advisor.turns}t`);
    }
  }
  if ((!columns || columns >= HUD_DESIGN.layout.narrowColumns) && line2.length) {
    lines.push(line2.join(separator));
  }

  const line3: string[] = [];
  if (snapshot.project) line3.push(paint("bright", snapshot.project, colors));
  if (snapshot.git) {
    const ref = snapshot.git.detached
      ? `@${snapshot.git.branch}`
      : snapshot.git.branch;
    const suffix = [
      snapshot.git.dirty ? "*" : "",
      snapshot.git.ahead ? `↑${snapshot.git.ahead}` : "",
      snapshot.git.behind ? `↓${snapshot.git.behind}` : "",
    ].join("");
    // Preserve the shell HUD's deliberate visual spacer before the Git token:
    // the dim separator owns punctuation, while Git reads as a grouped datum.
    line3.push(paint("dim", ` ${ref}${suffix}`, colors));
  }
  const added = isFiniteNumber(snapshot.linesAdded) ? Math.floor(snapshot.linesAdded) : 0;
  const removed = isFiniteNumber(snapshot.linesRemoved) ? Math.floor(snapshot.linesRemoved) : 0;
  if (added > 0 || removed > 0) line3.push(paint("dim", `+${added}/-${removed}`, colors));
  if (snapshot.cwd) {
    const designMaximum = columns
      ? Math.max(
          HUD_DESIGN.layout.cwdMinimumColumns,
          columns - HUD_DESIGN.layout.cwdReservedColumns,
        )
      : HUD_DESIGN.layout.cwdFallbackColumns;
    // Preserve the shell HUD's calibrated reserve, but never let that minimum
    // force a real terminal wrap when the project/Git prefix already used it.
    const prefixWidth = line3.length
      ? terminalWidth(line3.join(separator)) + terminalWidth(separator)
      : 0;
    const available = columns ? Math.max(0, columns - prefixWidth) : designMaximum;
    const cwdMax = Math.min(designMaximum, available);
    if (cwdMax > 0) {
      line3.push(paint("dim", truncateLeft(displayPath(snapshot.cwd), cwdMax), colors));
    }
  }
  if (line3.length) lines.push(line3.join(separator));

  // The fourth activity line is a companion-HUD extension. Claude's native
  // statusline stays faithful to the original three-line visual contract.
  if (options.activity ?? true) {
    const status = statusLine(snapshot.status, colors);
    const tools = toolLine(snapshot.tools, colors);
    const agents = agentLine(snapshot.agents, colors);
    const plan = planLine(snapshot.plan, colors);
    const activity = [status, tools, agents, plan].filter(Boolean);
    if (activity.length) lines.push(dimLine(activity.join(" | "), colors));
  }

  // Cwd has a tail-preserving policy above; this final guard covers unusually
  // long model/project/activity values without changing any line that fits.
  return (columns
    ? lines.map((line) => truncateRight(line, columns))
    : lines
  ).join("\n");
}
