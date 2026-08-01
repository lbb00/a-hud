import type {
  AgentActivity,
  GitStatus,
  PlanItem,
  Platform,
  SessionStatus,
  ToolActivity,
  UsageLimit,
  UsageReset,
} from "@agent-hud/provider";
import type { Severity } from "./design.js";

/**
 * UI-facing model.
 *
 * This is deliberately richer than the provider model: cache labels, compact
 * advisor precedence, severity, lines, glyphs and responsive behavior belong
 * to the visual plugin, never to the data provider.
 */
export interface CacheView {
  state: "warm" | "expiring" | "cold";
  expiresAt: number;
}

export interface CompactAdvisor {
  kind: "forced" | "break-even";
  turns: number;
  full: boolean;
}

export interface HudSnapshot {
  platform: Platform;
  observedAt: number;
  model: string;
  effort: string;
  project: string;
  cwd: string;
  context: number | null;
  contextSize: number | null;
  totalInput: number | null;
  turns: number;
  limits: UsageLimit[];
  resets: UsageReset[];
  git: GitStatus | null;
  cost: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  status?: SessionStatus;
  tools: ToolActivity[];
  agents: AgentActivity[];
  plan: PlanItem[];
  modelSeverity?: Severity;
  cache?: CacheView | null;
  compactAdvisor?: CompactAdvisor | null;
}

export type HudTool = ToolActivity;
export type HudAgent = AgentActivity;
export type HudPlanItem = PlanItem;
