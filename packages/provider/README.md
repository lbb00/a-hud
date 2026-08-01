# @agent-hud/provider

[English](README.md) | [简体中文](README.zh-CN.md)

Host-neutral data collection and state for Agent HUD.

The provider owns facts and lifecycle semantics:

- normalized Claude, Codex, Cursor and Antigravity hook events;
- local event storage and state folding;
- Claude transcript-derived turns, cache expiry, compact measurements and cost
  history;
- raw Anthropic Statuspage health;
- raw Git branch, dirty and ahead/behind state.

`normalizeClaudeStatus` flattens Claude telemetry into `ClaudeSessionFacts`.
`normalizeCursorStatus` and `normalizeAntigravityStatus` flatten their
documented live payloads into `HostSessionFacts`. UI consumers therefore never
depend on a nested host JSON schema. Claude transcripts are streamed with
bounded live data; stable scans persist their message-id/evidence state under
`~/.agent-hud/transcript-cache`, so later refreshes scan only newly appended
bytes. Cursor and Antigravity transcripts are not parsed.

It does **not** own ANSI colors, glyphs, line order, warning ramps, responsive
layout, or the choice between competing advisor signals. Those belong to the UI
plugin.

## Internal layout

The package root exposes stable public facades; implementation details are
grouped by data lifecycle:

- `src/hooks/normalize.ts` converts four host hook schemas into the shared event
  model consumed by `store.ts`;
- `src/telemetry/transcript.ts` incrementally scans and caches Claude transcript
  evidence;
- `src/telemetry/health.ts` owns the fail-soft Statuspage cache and refresh
  lease;
- `src/telemetry/config.ts` owns collection defaults;
- `src/telemetry.ts` composes those raw measurements into one Claude snapshot.

```ts
import {
  deriveClaudeTelemetry,
  getGitStatus,
  loadState,
  normalizeAntigravityStatus,
  normalizeClaudeStatus,
  normalizeCursorStatus,
  recordHook,
} from "@agent-hud/provider";
```

## Public API

The package root is the only public import path. Its exports are grouped by
responsibility:

| Area | Exports |
| --- | --- |
| Host normalization | `normalizeClaudeStatus`, `normalizeCursorStatus`, `normalizeAntigravityStatus` |
| Hook state | `normalizeHookEvent`, `recordHook`, `loadState`, `foldEvents` |
| Claude telemetry | `deriveClaudeTelemetry`, `contextPercent`, `extractEffort`, `compactBreakEvenTurns`, `transcriptTurns`, `inferCacheTtl` |
| Health | `refreshAnthropicHealth`, `spawnHealthRefresh` |
| Repository | `getGitStatus` |
| Safe local I/O | `resolveDataDir`, `eventFileFor`, `appendJsonLine`, `readTail`, `readJsonStdin`, `safeText`, `safePath` |

All corresponding input, fact, event, activity, usage and state interfaces are
exported as TypeScript types from the same root. The generated declarations
are included in the package, so consumers do not need a separate types
package.

### Typical lifecycle

```ts
import {
  deriveClaudeTelemetry,
  loadState,
  normalizeClaudeStatus,
  type ClaudeStatusInput,
} from "@agent-hud/provider";

export async function collect(input: ClaudeStatusInput) {
  const state = await loadState({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.workspace?.current_dir || input.cwd,
    platform: "claude",
  });
  const derived = await deriveClaudeTelemetry(input);
  return normalizeClaudeStatus(input, state, derived);
}
```

Consumers should treat returned facts as nullable or partial: collection is
deliberately fail-soft, and a host may omit capabilities such as quotas,
transcripts or VCS.

All persistence is local (`~/.agent-hud`, plus the inherited Claude metric
logs under `~/.claude`). Collection is fail-soft so a missing or partially
written data source produces partial facts instead of blocking the host.
