/**
 * Provider domain types contain data and lifecycle semantics only.
 *
 * They intentionally know nothing about lines, glyphs, ANSI colors, warning
 * ramps, or responsive layout. Those are UI-plugin concerns.
 */
export type Platform = "codex" | "claude" | "antigravity" | "cursor" | "agent";
export type ActivityStatus = "running" | "completed" | "error";
export type PlanStatus = "pending" | "in_progress" | "completed";
export type SessionStatus = "idle" | "working" | "waiting";

export interface ToolActivity {
  id?: string;
  name: string;
  target?: string;
  status: ActivityStatus;
  startedAt?: number;
  updatedAt?: number;
}

export interface AgentActivity {
  id?: string;
  type: string;
  status: ActivityStatus;
  startedAt?: number;
  updatedAt?: number;
}

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export interface GitStatus {
  branch: string;
  detached: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface UsageLimit {
  label: string;
  percent: number;
  resetAt?: number | string;
  windowSeconds?: number;
}

export interface UsageReset {
  label: string;
  resetAt: number | string;
}

export interface ProviderState {
  platform: Platform;
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  model: string;
  status: SessionStatus;
  tools: ToolActivity[];
  agents: AgentActivity[];
  plan: PlanItem[];
  updatedAt: number;
  turns: number;
}

export interface ClaudeStatusInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  workspace?: {
    current_dir?: string;
  };
  model?: {
    display_name?: string;
    id?: string;
    effort?: string | {
      level?: string;
      effort?: string;
    };
  };
  effort?: string | {
    level?: string;
    effort?: string;
  };
  reasoning_effort?: string;
  output_style?: {
    effort?: string | {
      level?: string;
      effort?: string;
    };
  };
  context_window?: {
    used_percentage?: number;
    context_window_size?: number;
    total_input_tokens?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  rate_limits?: {
    five_hour?: {
      used_percentage?: number;
      resets_at?: number | string;
    };
    seven_day?: {
      used_percentage?: number;
      resets_at?: number | string;
    };
  };
  cost?: {
    total_cost_usd?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
}

/**
 * Cursor intentionally mirrors the useful core of Claude Code's status-line
 * payload. Keep its few host-specific fields explicit so we can reuse the
 * visual contract without pretending Cursor transcripts or usage APIs are
 * Claude-compatible.
 */
export interface CursorStatusInput extends ClaudeStatusInput {
  autorun?: boolean;
  render_width_chars?: number;
  version?: string;
  model?: ClaudeStatusInput["model"] & {
    param_summary?: string;
    max_mode?: boolean;
  };
}

/**
 * Antigravity exposes a first-class live status payload. Unlike hook payloads,
 * this is authoritative for context, quota, VCS and agent lifecycle, so the
 * renderer never needs to scrape its transcript.
 */
export interface AntigravityStatusInput extends ClaudeStatusInput {
  conversation_id?: string;
  product?: string;
  version?: string;
  model?: ClaudeStatusInput["model"];
  quota?: Record<string, {
    remaining_fraction?: number;
    reset_time?: number | string;
    reset_in_seconds?: number;
  }>;
  agent_state?: "idle" | "thinking" | "working" | "tool_use" | "initializing" | string;
  vcs?: {
    type?: string;
    branch?: string;
    client?: string;
    dirty?: boolean;
  };
  pending_input_count?: number;
  tool_confirmation_pending?: boolean;
  task_count?: number;
  terminal_width?: number;
  execution_mode?: string;
}

/**
 * Flat, host-neutral status facts for CLI surfaces whose native payloads are
 * already authoritative. UI code consumes this shape and never reads nested
 * Cursor or Antigravity schemas directly.
 */
export interface HostSessionFacts {
  platform: "cursor" | "antigravity";
  observedAt: number;
  model: string;
  cwd: string;
  context: number | null;
  contextSize: number | null;
  totalInput: number | null;
  turns: number;
  effort: string;
  limits: UsageLimit[];
  resets: UsageReset[];
  git: GitStatus | null;
  status: SessionStatus;
  tools: ToolActivity[];
  agents: AgentActivity[];
  plan: PlanItem[];
}

export type JsonObject = Record<string, any>;

export interface HookEvent {
  v: 1;
  at: number;
  sessionId: string;
  platform: Platform;
  type: string;
  cwd: string;
  transcriptPath: string;
  model: string;
  turnId: string;
  /**
   * A Stop can end the foreground turn while Claude-owned background work is
   * still running. This is normalized to a boolean so lifecycle folding never
   * needs to depend on the host's nested task payload.
   */
  backgroundTasksRunning?: boolean;
  /**
   * True only for structured host events that explicitly require user input.
   * Free-form notification text is never retained or interpreted.
   */
  needsInput?: boolean;
  tool?: ToolActivity;
  agent?: AgentActivity;
  plan?: PlanItem[];
}

/**
 * Complete normalized facts for one Claude statusline render.
 *
 * Host schema knowledge ends here. Consumers receive flat, display-neutral
 * values and decide only presentation policy.
 */
export interface ClaudeSessionFacts {
  platform: "claude";
  observedAt: number;
  model: string;
  cwd: string;
  context: number | null;
  contextSize: number | null;
  totalInput: number | null;
  turns: number;
  effort: string;
  limits: UsageLimit[];
  resets: UsageReset[];
  cost: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  status: SessionStatus;
  tools: ToolActivity[];
  agents: AgentActivity[];
  plan: PlanItem[];
  cache: import("./telemetry.js").CacheTelemetry | null;
  compact: import("./telemetry.js").CompactTelemetry;
  apiHealthIndicator: string;
  healthCacheStale: boolean;
}
