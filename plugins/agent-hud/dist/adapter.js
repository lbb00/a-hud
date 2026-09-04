// src/adapter.ts
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

// src/adapter.ts
function cacheView(facts) {
  if (!facts.cache) return null;
  const remaining = facts.cache.expiresAt - facts.observedAt;
  return {
    expiresAt: facts.cache.expiresAt,
    state: remaining <= 0 ? "cold" : remaining <= HUD_DESIGN.cache.expiringWithinSeconds ? "expiring" : "warm"
  };
}
function compactAdvisor(facts) {
  const compact = facts.compact;
  if (compact.inForcedZone || compact.forcedTurns != null && compact.forcedTurns <= HUD_DESIGN.compact.forcedEtaMaxTurns) {
    return {
      kind: "forced",
      turns: compact.forcedTurns ?? 0,
      full: compact.inForcedZone || compact.forcedTurns === 0
    };
  }
  if (compact.breakEvenTurns != null && compact.breakEvenTurns <= HUD_DESIGN.compact.breakEvenMaxTurns) {
    return {
      kind: "break-even",
      turns: compact.breakEvenTurns,
      full: false
    };
  }
  return null;
}
function snapshotFromClaude(facts, git = null, promotion = null) {
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
    promotion
  };
}
function snapshotFromState(state, git = null, promotion = null) {
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
    promotion
  };
}
function snapshotFromCursor(facts, git = null, promotion = null) {
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
    promotion
  };
}
function snapshotFromAntigravity(facts, fallbackGit = null, promotion = null) {
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
    promotion
  };
}
export {
  snapshotFromAntigravity,
  snapshotFromClaude,
  snapshotFromCursor,
  snapshotFromState
};
//# sourceMappingURL=adapter.js.map
