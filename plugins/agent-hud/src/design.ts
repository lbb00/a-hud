/**
 * Agent HUD visual contract, inherited from the original shell statusline.
 *
 * COLOR ENCODES WARNING LEVEL, NOTHING ELSE.
 * Plain means healthy, yellow means caution, red means act now. Hierarchy comes
 * from brightness: session facts are normal foreground; location is dim except
 * for the bright project-name anchor. Separators are dim punctuation, not data.
 *
 * Keep these values centralized. They are calibrated policy, not incidental
 * renderer constants, and changing one should require a focused test update.
 */
export const HUD_DESIGN = {
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
    contextPressure: { yellow: 5_000_000, red: 16_000_000 },
    /**
     * Fullness is deliberately independent from pressure. It answers “should I
     * compact now?”, while C×N answers “is repeated context reading expensive?”
     */
    contextFullness: { yellow: 70, red: 80 },
    costUsd: { yellow: 4, red: 13 },
    quotaUsage: { yellow: 60, red: 85 },
    quotaPace: { yellow: 120, red: 200 },
    forcedCompactTurns: { yellow: 6, red: 3 },
  },
  cache: {
    fallbackTtlSeconds: 3_600,
    expiringWithinSeconds: 300,
  },
  compact: {
    /**
     * Median residual context measured after an in-session context reset in the
     * shell HUD. It drives the voluntary /compact break-even estimate.
     */
    summaryTokens: 17_000,
    /** Far-away estimates are noise; the instantaneous context box is enough. */
    forcedEtaMaxTurns: 30,
    breakEvenMaxTurns: 15,
    /** The shell used at most six changed-percentage rows for the recent slope. */
    recentChangedRows: 6,
  },
  quota: {
    fiveHourSeconds: 18_000,
    sevenDaySeconds: 604_800,
    paceNoiseFloorFraction: 0.1,
    paceNoiseFloorUsage: 8,
  },
  layout: {
    /** Below 60 columns the optional decision-support line disappears whole. */
    narrowColumns: 60,
    cwdFallbackColumns: 36,
    cwdReservedColumns: 22,
    cwdMinimumColumns: 14,
  },
} as const;

export type Severity = "plain" | "yellow" | "red";
