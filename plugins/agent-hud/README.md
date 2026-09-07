# Agent HUD

[English](README.md) | [简体中文](README.zh-CN.md)

One local HUD core for Codex, Claude Code, Cursor CLI and Antigravity CLI.

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00
$5.32 | →~3t
agent-hud |  main*↑2 | +128/-17 | /workspace/agent-hud
```

The UI contract is inherited from the previous shell HUD. Color only means
warning severity; brightness creates hierarchy; compact advice, cache
freshness, quota pace, and narrow-pane behavior retain their original
semantics. See [docs/hud-design.md](docs/hud-design.md).

## Two layers, five host surfaces

The implementation has a hard package boundary:

- `@agent-hud/provider` collects and normalizes raw facts. It owns I/O, event
  storage, Git state and derived telemetry, but no glyphs, colors or layout.
- This plugin adapts facts to the inherited UI policy and renders them.

Claude Code, Cursor and Antigravity accept custom status-line commands. Codex
has a configurable native footer whose items are predefined. Agent HUD shares
collection, state, rendering, colors, and configuration while respecting each
host's actual payload:

- Claude Code: the full custom renderer inside the native statusline.
- Cursor CLI: the same custom renderer and native lifecycle hooks. Cursor does
  not currently expose quota in its status payload, so quota is omitted.
- Antigravity CLI: the same custom renderer plus native quota, VCS, lifecycle
  and background-task facts.
- Codex: the native footer for model/context/limits/git/progress, plus an
  optional live companion for tools and subagents.
- pi: its own footer already carries tokens, cost, context and branch, so the
  extension adds one segment beside them for the promotional window and any
  incident the API's vendor is reporting.

No adapter scrapes Cursor or Antigravity transcripts, and the Codex adapter
does not depend on Codex's unstable transcript JSONL format.

The implementation is TypeScript ESM. `src/adapter.ts` owns raw-to-view
selection, `src/design.ts` owns calibrated visual tokens, and `src/render.ts`
is the pure shared renderer. The build bundles `@agent-hud/provider` into a
self-contained `dist/` runtime.

## Commands

From the workspace root:

```bash
npm test
node plugins/agent-hud/dist/cli.js demo
node plugins/agent-hud/dist/cli.js setup claude
node plugins/agent-hud/dist/cli.js setup codex --preset balanced
node plugins/agent-hud/dist/cli.js setup cursor
node plugins/agent-hud/dist/cli.js setup antigravity
node plugins/agent-hud/dist/cli.js setup both
node plugins/agent-hud/dist/cli.js setup all
node plugins/agent-hud/dist/cli.js watch --cwd "$PWD"
node plugins/agent-hud/dist/cli.js watch --once --json
```

Every config write is atomic and creates a timestamped backup first. Add
`--dry-run` to inspect the result without changing anything.
See the [CLI reference](docs/cli.md) for the complete command, option,
input and environment contract.

## Plugin layout

The same directory carries manifests for the four hosts that have them; pi
loads its extension from a file setup writes into pi's own directory:

```text
.codex-plugin/plugin.json
.claude-plugin/plugin.json
.cursor-plugin/plugin.json
plugin.json
hooks/hooks.json
skills/agent-hud/SKILL.md
commands/setup.md
src/
dist/
docs/hud-design.md
```

Codex and Claude share the packaged hook manifest. Cursor and Antigravity use
their native hook schemas, installed by the backed-up, idempotent setup
patchers.

## Privacy and resilience

Events stay local in `~/.agent-hud`. The hook recorder stores timestamps,
model/cwd, tool names, short targets, agent types, and plan labels. It never
stores prompts, command output, or tool responses. Private directories and
files are repaired to `0700/0600`; bounded event/cache maintenance is
cross-process-safe and advisory. Hook failures are ignored so the HUD cannot
block an agent session. The inherited cost/context metric logs remain under
`~/.claude/{cost,context}-log`, matching the shell HUD. The only network read
is the inherited, cached Anthropic Statuspage health check used to tint the
model name during an incident. Concurrent refreshes are coalesced, and a
failure preserves the last-good result.
