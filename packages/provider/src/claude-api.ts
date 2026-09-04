import { endpointHost } from "./promotions.js";

const ANTHROPIC_API_HOST = "api.anthropic.com";

const CLOUD_PROVIDERS: ReadonlyArray<{
  flag: string;
  baseUrl?: string;
}> = [
  {
    flag: "CLAUDE_CODE_USE_BEDROCK",
    baseUrl: "ANTHROPIC_BEDROCK_BASE_URL",
  },
  {
    flag: "CLAUDE_CODE_USE_MANTLE",
    baseUrl: "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  },
  {
    flag: "CLAUDE_CODE_USE_VERTEX",
    baseUrl: "ANTHROPIC_VERTEX_BASE_URL",
  },
  {
    flag: "CLAUDE_CODE_USE_FOUNDRY",
    baseUrl: "ANTHROPIC_FOUNDRY_BASE_URL",
  },
  {
    flag: "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    baseUrl: "ANTHROPIC_AWS_BASE_URL",
  },
  {
    flag: "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    baseUrl: "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  },
  // Gateway mode has no provider-specific base URL variable, so the HUD must
  // keep its destination unknown instead of borrowing the first-party default.
  { flag: "CLAUDE_CODE_USE_GATEWAY" },
] as const;

function enabled(value: string | undefined): boolean {
  // Claude Code's boolean environment parser enables exactly these spellings;
  // mirroring it keeps routed requests from being presented as first-party.
  return ["1", "true", "yes", "on"].includes(
    value?.trim().toLowerCase() ?? "",
  );
}

/**
 * Accept the URL and bare-authority forms Claude Code users put in settings.
 * Promotion endpoint normalization rejects malformed and overlong values, so
 * this path cannot turn a truncated environment value into a different host.
 */
function configuredEndpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return endpointHost(value) || undefined;
}

/**
 * The API host Claude Code sends model requests to, when its inherited
 * environment identifies one. A normal session defaults to Anthropic's API;
 * cloud-provider modes stay unknown unless their own base URL is explicit,
 * because their generated endpoints can vary by region, project, and model.
 */
export function claudeApiEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const activeProviders = CLOUD_PROVIDERS.filter(({ flag }) => enabled(env[flag]));
  if (activeProviders.length > 1) return undefined;
  if (activeProviders.length === 1) {
    const { baseUrl } = activeProviders[0];
    return baseUrl ? configuredEndpoint(env[baseUrl]) : undefined;
  }
  if (env.ANTHROPIC_BASE_URL !== undefined) {
    // This empty-string behavior is inferred from the Anthropic SDK's
    // `baseURL || default`; Claude Code's own path has not been verified.
    // Whitespace is truthy there and remains an invalid destination here.
    if (env.ANTHROPIC_BASE_URL === "") return ANTHROPIC_API_HOST;
    return configuredEndpoint(env.ANTHROPIC_BASE_URL);
  }
  return ANTHROPIC_API_HOST;
}
