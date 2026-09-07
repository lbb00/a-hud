import {
  endpointHost,
  promotionSources,
  remoteFetchDisabled,
  resolveConfigPath,
  resolvePromotion,
  sharedCachePath,
  sharedPromotionsUrl,
  type Platform,
  type PromotionWindow,
} from "@agent-hud/provider";

/**
 * Promotional windows come from two files the HUD never writes: the shared
 * schedule fetched from the repository and the user's own config. When no badge
 * appears, the only way to tell "nothing is scheduled" from "the file is not
 * being read" is to print both resolved paths alongside what was parsed.
 */
export function promotions(
  platform: Platform | undefined,
  endpoint?: string,
): void {
  const sources = promotionSources();
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.stdout.write(`config: ${resolveConfigPath()}\n`);
  process.stdout.write(`cache: ${sharedCachePath()}\n`);
  process.stdout.write(`local zone: ${localZone}\n`);
  process.stdout.write(`shared: ${sharedSummary(sources)}\n`);
  const normalizedEndpoint = endpoint === undefined ? undefined : endpointHost(endpoint);
  const endpointFilter = endpoint === undefined
    ? "not provided (endpoint-scoped windows excluded)"
    : normalizedEndpoint || "invalid";
  process.stdout.write(
    `filter: platform ${platform ?? "all"}; endpoint ${endpointFilter}\n`,
  );

  const windows = [...sources.local, ...sources.shared];
  if (!windows.length) {
    process.stdout.write("windows: none configured\n");
  }
  for (const window of sources.local) describe(window, "local");
  for (const window of sources.shared) describe(window, "shared");

  const status = resolvePromotion(windows, { platform, endpoint });
  process.stdout.write(
    status === null
      ? "now: no window active or upcoming\n"
      : status.changesAt === null
      ? `now: ${status.id} active, no end date\n`
      : `now: ${status.id} ${status.active ? "active until" : "starts"} ${
        localTime(status.changesAt)
      }\n`,
  );
}

function sharedSummary(sources: ReturnType<typeof promotionSources>): string {
  if (sources.sharedOrigin === "off") return "off (disabled in config)";
  const frozen = remoteFetchDisabled();
  if (sources.sharedOrigin === "bundled") {
    return frozen
      ? "bundled copy (AGENT_HUD_NO_REMOTE is set)"
      : `bundled copy, not fetched yet from ${sharedPromotionsUrl()}`;
  }
  const fetched = sources.sharedFetchedAt
    ? localTime(sources.sharedFetchedAt)
    : "an unknown time";
  // A cache keeps answering while fetching is off, so say which it is: the
  // windows below came from the network either way.
  const refresh = frozen
    ? " (AGENT_HUD_NO_REMOTE is set, not refreshing)"
    : sources.sharedStale
    ? ", refresh due"
    : "";
  // The cache records where the bytes came from, which is a different URL from
  // the one that was requested whenever it redirected.
  return `fetched ${fetched}${refresh} from ${
    sources.sharedSource ?? sharedPromotionsUrl()
  }`;
}

function describe(window: PromotionWindow, origin: string): void {
  const scope = [
    window.timezone || "UTC",
    window.platforms?.join(",") || "all hosts",
    window.endpoints?.join(",") || "",
    window.days ? `days ${window.days.join(",")}` : "",
    window.from || window.until ? `${window.from || "…"}..${window.until || "…"}` : "",
  ].filter(Boolean).join("  ");
  process.stdout.write(
    `  ${origin}  ${window.id}  ${window.label || "-"}  ${window.start}-${window.end}  ${scope}\n`,
  );
}

/** Config hours are UTC; everything shown to the reader is their own clock. */
function localTime(epochSeconds: number): string {
  // Intl rejects timeZoneName next to dateStyle/timeStyle, so the components
  // are listed explicitly. sv-SE renders them in ISO order.
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(epochSeconds * 1_000));
}
