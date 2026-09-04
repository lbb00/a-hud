import { endpointHost } from "../promotions.js";

/**
 * Every vendor status page the HUD is allowed to contact.
 *
 * The address and the parser live here in code and nowhere else. The shared
 * promotional schedule is fetched from GitHub, so letting that table name a
 * status URL would let one poisoned entry point every installed HUD at an
 * address of the attacker's choosing. Adding a vendor is a code change and a
 * release, and that cost is the point.
 */
export interface HealthSource {
  /**
   * Cache file name for this source. It is a fixed identifier rather than an
   * API hostname because the fetched fact is page-wide: it reports the
   * vendor's overall service state, not the health of one endpoint.
   */
  id: string;
  /** Short vendor name for hosts that show the incident as text. */
  label: string;
  /** API hosts whose traffic this page speaks for. */
  endpoints: readonly string[];
  url: string;
  /** The severity word to cache, or "" when the body carries none. */
  read(body: unknown): string;
}

export const HEALTH_SOURCES: readonly HealthSource[] = [
  {
    id: "anthropic-statuspage",
    label: "Anthropic",
    endpoints: ["api.anthropic.com"],
    url: "https://status.claude.com/api/v2/status.json",
    read(body) {
      const status = (body as { status?: { indicator?: unknown } } | null)?.status;
      return typeof status?.indicator === "string" ? status.indicator : "";
    },
  },
];

/**
 * The status page that speaks for an API host, when one is registered. A host
 * the HUD cannot name, or one no page covers, gets no signal rather than
 * borrowing another vendor's.
 */
export function healthSourceFor(endpoint: unknown): HealthSource | null {
  const host = endpointHost(endpoint);
  if (!host) return null;
  return HEALTH_SOURCES.find((source) => source.endpoints.includes(host)) ?? null;
}

/** Resolve the source a detached refresh child was asked to update. */
export function healthSourceById(id: string): HealthSource | null {
  return HEALTH_SOURCES.find((source) => source.id === id) ?? null;
}
