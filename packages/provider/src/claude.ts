import { safePath } from "./io.js";
import { contextPercent, type ClaudeDerivedTelemetry } from "./telemetry.js";
import type {
  ClaudeSessionFacts,
  ClaudeStatusInput,
  ProviderState,
  UsageLimit,
  UsageReset,
} from "./types.js";

const FIVE_HOUR_SECONDS = 18_000;
const SEVEN_DAY_SECONDS = 604_800;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resetValue(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value !== "");
}

export function normalizeClaudeStatus(
  input: ClaudeStatusInput,
  state: ProviderState,
  derived: ClaudeDerivedTelemetry,
): ClaudeSessionFacts {
  const model = safePath(input.model?.display_name || input.model?.id) || state.model;
  const cwd = safePath(input.workspace?.current_dir || input.cwd) || state.cwd;
  const limits: UsageLimit[] = [];
  const resets: UsageReset[] = [];
  // Claude Code drops a window from rate_limits once its reset time passes and
  // only brings it back after the next API response. A dropped window has
  // rolled over, so it reads 0% with no known reset; leaving it out would let
  // the 7d figure take the 5h slot.
  const reported = input.rate_limits?.five_hour || input.rate_limits?.seven_day;
  const five = input.rate_limits?.five_hour || (reported ? { used_percentage: 0 } : undefined);
  const seven = input.rate_limits?.seven_day || (reported ? { used_percentage: 0 } : undefined);

  if (finite(five?.used_percentage)) {
    limits.push({
      label: "5h",
      percent: five.used_percentage,
      resetAt: five.resets_at,
      windowSeconds: FIVE_HOUR_SECONDS,
    });
  }
  if (finite(seven?.used_percentage)) {
    limits.push({
      label: "7d",
      percent: seven.used_percentage,
      resetAt: seven.resets_at,
      windowSeconds: SEVEN_DAY_SECONDS,
    });
  }
  if (resetValue(five?.resets_at)) resets.push({ label: "5h", resetAt: five.resets_at });
  if (resetValue(seven?.resets_at)) resets.push({ label: "7d", resetAt: seven.resets_at });

  return {
    platform: "claude",
    observedAt: derived.observedAt,
    model,
    cwd,
    context: contextPercent(input),
    contextSize: finite(input.context_window?.context_window_size)
      ? input.context_window.context_window_size
      : null,
    totalInput: finite(input.context_window?.total_input_tokens)
      ? input.context_window.total_input_tokens
      : null,
    turns: derived.turns,
    effort: derived.effort,
    limits,
    resets,
    cost: finite(input.cost?.total_cost_usd) ? input.cost.total_cost_usd : null,
    linesAdded: finite(input.cost?.total_lines_added) ? input.cost.total_lines_added : null,
    linesRemoved: finite(input.cost?.total_lines_removed) ? input.cost.total_lines_removed : null,
    status: state.status,
    tools: state.tools,
    agents: state.agents,
    plan: state.plan,
    cache: derived.cache,
    compact: derived.compact,
    apiHealthIndicator: derived.apiHealthIndicator,
    healthCacheStale: derived.healthCacheStale,
  };
}
