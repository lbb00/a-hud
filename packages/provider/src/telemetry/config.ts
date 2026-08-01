/**
 * Measurement defaults inherited from the shell provider.
 *
 * These are data-model parameters, not visual tokens: they determine what the
 * provider measures. Color thresholds and display cutoffs remain in the UI.
 */
export const PROVIDER_DEFAULTS = {
  cacheFallbackTtlSeconds: 3_600,
  compactTargetPercent: 80,
  compactSummaryTokens: 17_000,
  recentContextRows: 6,
  apiHealthTtlSeconds: 300,
} as const;
