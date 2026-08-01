import path from "node:path";
import { safeText } from "./io.mjs";
import { badgeFor } from "./hosts.mjs";

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
    // "Agent" here is intentionally the same fallback badgeFor() uses for an
    // unrecognized platform id, not a Codex-specific default — this path
    // serves any host without its own dedicated snapshotFrom*() function.
    model: state.model || badgeFor(state.platform),
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
