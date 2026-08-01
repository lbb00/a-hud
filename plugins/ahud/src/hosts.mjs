import { setupClaude, setupCodex } from "./setup.mjs";

// The single place that knows which agent hosts ahud supports. Detection,
// the HUD's platform badge, and `ahud setup`'s valid targets/dispatch all
// read from this list instead of each having their own hardcoded
// "codex"/"claude" branches — adding a third host later means adding one
// descriptor here, not hunting down four separate if/else chains across
// store.mjs/render.mjs/cli.mjs.
//
// `detect(input, env)` mirrors the exact heuristic each host has always
// used: Codex sets PLUGIN_ROOT (or its hook payloads/transcript paths
// mention "/.codex/"); Claude Code sets CLAUDE_PLUGIN_ROOT (or "/.claude/").
// Order matters for detectHost() below (first match wins) and mirrors the
// previous hardcoded if/else chain's exact precedence: Codex is checked
// before Claude.
//
// This is NOT the order `ahud setup both` writes hosts in — that dispatch
// order is a separate, independent decision (see setupTargetIds below):
// `setup both` writing Codex before Claude isn't just a cosmetic difference
// in which "configured:" line prints first. Setup is sequential and not
// transactional, so if the SECOND host's config is malformed, the first
// host's write has already landed even though the overall command exits
// nonzero — which host absorbs that partial mutation depends on dispatch
// order. Detection order and setup-dispatch order were independently
// chosen before this registry existed (Codex-first for detection,
// Claude-first for setup) and are kept independent here on purpose.
export const HOSTS = [
  {
    id: "codex",
    badge: "Codex",
    detect: (input, env) =>
      Boolean(env.PLUGIN_ROOT) || String(input.transcript_path || "").includes("/.codex/"),
    setup: setupCodex,
  },
  {
    id: "claude",
    badge: "Claude",
    detect: (input, env) =>
      Boolean(env.CLAUDE_PLUGIN_ROOT) || String(input.transcript_path || "").includes("/.claude/"),
    setup: setupClaude,
  },
];

export function hostIds() {
  return HOSTS.map((host) => host.id);
}

// The pre-registry claude-before-codex order `ahud setup both` has always
// dispatched in (see the ordering note above HOSTS). Filtered through
// hostIds() so a host removed from the registry can't leave a dangling id
// here.
const SETUP_DISPATCH_ORDER = ["claude", "codex"];

// Resolves a setup CLI target ("claude" | "codex" | "both") to the ordered
// list of host ids to actually run setup for.
export function setupTargetIds(target) {
  if (target !== "both") return [target];
  const ids = hostIds();
  return SETUP_DISPATCH_ORDER.filter((id) => ids.includes(id));
}

export function findHost(id) {
  return HOSTS.find((host) => host.id === id) ?? null;
}

// Returns a registered host's id, or "agent" when no host's detect()
// matches (e.g. ahud invoked outside any known plugin host).
export function detectHost(input, env) {
  for (const host of HOSTS) {
    if (host.detect(input, env)) return host.id;
  }
  return "agent";
}

// The display label used in the HUD's `[Badge · model]` header. Falls back
// to "Agent" for an unregistered/unknown platform id, matching detectHost's
// own fallback.
export function badgeFor(platformId) {
  return findHost(platformId)?.badge ?? "Agent";
}
