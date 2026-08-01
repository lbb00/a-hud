import type {
  AntigravityStatusInput,
  CursorStatusInput,
  HostSessionFacts,
  ProviderState,
  SessionStatus,
  UsageLimit,
  UsageReset,
} from "./types.js";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusModel(input: CursorStatusInput | AntigravityStatusInput): string {
  return typeof input.model === "object"
    ? String(input.model?.display_name || input.model?.id || "")
    : "";
}

function effortFromStatus(
  input: CursorStatusInput | AntigravityStatusInput,
): string {
  const model = (input.model || {}) as Record<string, unknown>;
  if (model.max_mode === true) return "max";
  const cursorSummary = typeof model.param_summary === "string"
    ? model.param_summary
    : "";
  const values = [
    cursorSummary,
    input.model?.effort,
    input.effort,
    input.reasoning_effort,
    statusModel(input).match(/\(([^()]*)\)\s*$/)?.[1],
  ];
  for (const value of values) {
    const text = typeof value === "string"
      ? value
      : typeof value === "object" && value
        ? value.level || value.effort || ""
        : "";
    const match = String(text).toLowerCase().match(
      /(?:effort|reasoning)\s*=\s*(low|medium|high|xhigh|max)|\b(low|medium|high|xhigh|max)\b/,
    );
    if (match) return match[1] || match[2] || "";
  }
  return "";
}

function statusCwd(input: CursorStatusInput | AntigravityStatusInput): string {
  return input.workspace?.current_dir || input.cwd || "";
}

function sharedFacts(
  platform: HostSessionFacts["platform"],
  input: CursorStatusInput | AntigravityStatusInput,
  state: ProviderState,
  observedAt: number,
): Omit<HostSessionFacts, "limits" | "resets" | "git" | "status" | "agents"> {
  const cwd = statusCwd(input) || state.cwd;
  return {
    platform,
    observedAt,
    model: statusModel(input) || state.model,
    cwd,
    context: finite(input.context_window?.used_percentage),
    contextSize: finite(input.context_window?.context_window_size),
    totalInput: finite(input.context_window?.total_input_tokens),
    turns: state.turns || 0,
    effort: effortFromStatus(input),
    tools: state.tools,
    plan: state.plan,
  };
}

/**
 * Cursor mirrors Claude's core status field names, but not its transcript or
 * quota APIs. Normalize only Cursor's live payload and shared hook state.
 */
export function normalizeCursorStatus(
  input: CursorStatusInput,
  state: ProviderState,
  observedAt = Math.floor(Date.now() / 1_000),
): HostSessionFacts {
  return {
    ...sharedFacts("cursor", input, state, observedAt),
    limits: [],
    resets: [],
    git: null,
    status: state.status,
    agents: state.agents,
  };
}

function antigravityStatus(
  input: AntigravityStatusInput,
  state: ProviderState,
): SessionStatus {
  if (input.tool_confirmation_pending) return "waiting";
  if ((finite(input.task_count) || 0) > 0) return "working";
  if (input.agent_state === "idle") return "idle";
  if (
    ["thinking", "working", "tool_use", "initializing"].includes(
      String(input.agent_state),
    )
  ) return "working";
  return state.status;
}

function antigravityQuota(input: AntigravityStatusInput): {
  limits: UsageLimit[];
  resets: UsageReset[];
} {
  const limits: UsageLimit[] = [];
  const resets: UsageReset[] = [];
  for (const [bucket, value] of Object.entries(input.quota || {})) {
    const remaining = finite(value?.remaining_fraction);
    if (remaining == null) continue;
    const label = /weekly|seven.?day|7d/i.test(bucket) ? "7d" :
      /daily|one.?day|1d/i.test(bucket) ? "1d" : bucket;
    const resetAt = value.reset_time;
    limits.push({
      label,
      percent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
      ...(resetAt == null ? {} : { resetAt }),
    });
    if (resetAt != null) resets.push({ label, resetAt });
  }
  return { limits, resets };
}

/**
 * Antigravity's live status payload is authoritative for lifecycle, quota and
 * VCS. Hooks contribute exact recent tool names without transcript scraping.
 */
export function normalizeAntigravityStatus(
  input: AntigravityStatusInput,
  state: ProviderState,
  observedAt = Math.floor(Date.now() / 1_000),
): HostSessionFacts {
  const quota = antigravityQuota(input);
  const taskCount = Math.max(0, Math.floor(finite(input.task_count) || 0));
  const agents = taskCount > 0 && !state.agents.some((agent) => agent.status === "running")
    ? [
        {
          id: "antigravity:tasks",
          type: taskCount === 1 ? "task" : `${taskCount} tasks`,
          status: "running" as const,
        },
        ...state.agents,
      ]
    : state.agents;
  return {
    ...sharedFacts("antigravity", input, state, observedAt),
    limits: quota.limits,
    resets: quota.resets,
    git: input.vcs?.branch
      ? {
          branch: input.vcs.branch,
          detached: false,
          dirty: input.vcs.dirty === true,
          ahead: 0,
          behind: 0,
        }
      : null,
    status: antigravityStatus(input, state),
    agents,
  };
}
