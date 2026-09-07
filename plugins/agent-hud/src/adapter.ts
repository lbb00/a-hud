import path from "node:path";
import {
  type ClaudeSessionFacts,
  type GitStatus,
  type HostSessionFacts,
  type PromotionStatus,
  type ProviderState,
} from "@agent-hud/provider";
import { healthSeverity, HUD_DESIGN } from "./design.js";
import type { CacheView, CompactAdvisor, HudSnapshot } from "./types.js";

function cacheView(
  facts: ClaudeSessionFacts,
): CacheView | null {
  if (!facts.cache) return null;
  const remaining = facts.cache.expiresAt - facts.observedAt;
  return {
    expiresAt: facts.cache.expiresAt,
    state: remaining <= 0
      ? "cold"
      : remaining <= HUD_DESIGN.cache.expiringWithinSeconds ? "expiring" : "warm",
  };
}

/**
 * The shell showed exactly one advisor: forced-compaction ETA wins, and the
 * voluntary break-even hint is considered only when forced ETA is absent or
 * too far away. Keeping that choice here prevents display policy leaking into
 * the provider's raw measurements.
 */
function compactAdvisor(
  facts: ClaudeSessionFacts,
): CompactAdvisor | null {
  const compact = facts.compact;
  if (
    compact.inForcedZone ||
    (compact.forcedTurns != null &&
      compact.forcedTurns <= HUD_DESIGN.compact.forcedEtaMaxTurns)
  ) {
    return {
      kind: "forced",
      turns: compact.forcedTurns ?? 0,
      full: compact.inForcedZone || compact.forcedTurns === 0,
    };
  }
  if (
    compact.breakEvenTurns != null &&
    compact.breakEvenTurns <= HUD_DESIGN.compact.breakEvenMaxTurns
  ) {
    return {
      kind: "break-even",
      turns: compact.breakEvenTurns,
      full: false,
    };
  }
  return null;
}

export function snapshotFromClaude(
  facts: ClaudeSessionFacts,
  git: GitStatus | null = null,
  promotion: PromotionStatus | null = null,
): HudSnapshot {
  const cwd = facts.cwd;
  return {
    platform: "claude",
    observedAt: facts.observedAt,
    model: facts.model,
    cwd,
    project: cwd ? path.basename(cwd) : "",
    context: facts.context,
    contextSize: facts.contextSize,
    totalInput: facts.totalInput,
    turns: facts.turns,
    effort: facts.effort,
    limits: facts.limits,
    resets: facts.resets,
    git,
    cost: facts.cost,
    linesAdded: facts.linesAdded,
    linesRemoved: facts.linesRemoved,
    status: facts.status,
    tools: facts.tools,
    agents: facts.agents,
    plan: facts.plan,
    modelSeverity: healthSeverity(facts.apiHealthIndicator),
    cache: cacheView(facts),
    compactAdvisor: compactAdvisor(facts),
    promotion,
  };
}

export function snapshotFromState(
  state: ProviderState,
  git: GitStatus | null = null,
  promotion: PromotionStatus | null = null,
): HudSnapshot {
  const cwd = state.cwd;
  return {
    platform: state.platform,
    observedAt: 0,
    model: state.model,
    cwd,
    project: cwd ? path.basename(cwd) : "",
    context: null,
    contextSize: null,
    totalInput: null,
    turns: state.turns || 0,
    effort: "",
    limits: [],
    resets: [],
    git,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    status: state.status,
    tools: state.tools,
    agents: state.agents,
    plan: state.plan,
    modelSeverity: "plain",
    cache: null,
    compactAdvisor: null,
    promotion,
  };
}

/**
 * Cursor and Antigravity reach the UI through one flat provider contract.
 * Host schema knowledge, quota conversion and lifecycle interpretation remain
 * on the provider side of the boundary.
 */
export function snapshotFromCursor(
  facts: HostSessionFacts,
  git: GitStatus | null = null,
  promotion: PromotionStatus | null = null,
): HudSnapshot {
  const cwd = facts.cwd;
  return {
    platform: "cursor",
    observedAt: facts.observedAt,
    model: facts.model,
    effort: facts.effort,
    project: cwd ? path.basename(cwd) : "",
    cwd,
    context: facts.context,
    contextSize: facts.contextSize,
    totalInput: facts.totalInput,
    turns: facts.turns,
    limits: facts.limits,
    resets: facts.resets,
    git: facts.git || git,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    status: facts.status,
    tools: facts.tools,
    agents: facts.agents,
    plan: facts.plan,
    modelSeverity: "plain",
    cache: null,
    compactAdvisor: null,
    promotion,
  };
}

export function snapshotFromAntigravity(
  facts: HostSessionFacts,
  fallbackGit: GitStatus | null = null,
  promotion: PromotionStatus | null = null,
): HudSnapshot {
  const cwd = facts.cwd;
  return {
    platform: "antigravity",
    observedAt: facts.observedAt,
    model: facts.model,
    effort: facts.effort,
    project: cwd ? path.basename(cwd) : "",
    cwd,
    context: facts.context,
    contextSize: facts.contextSize,
    totalInput: facts.totalInput,
    turns: facts.turns,
    limits: facts.limits,
    resets: facts.resets,
    git: facts.git || fallbackGit,
    cost: null,
    linesAdded: null,
    linesRemoved: null,
    status: facts.status,
    tools: facts.tools,
    agents: facts.agents,
    plan: facts.plan,
    modelSeverity: "plain",
    cache: null,
    compactAdvisor: null,
    promotion,
  };
}
