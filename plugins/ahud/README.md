# ahud

One local HUD core for both Codex and Claude Code.

```text
[Codex · gpt-5.6-sol · high] │ ahud git:(main*)
Context █████░░░░░ 45% │ 5h █░░░░ 25% │ 7d █░░░░ 11%
◐ apply_patch render.mjs │ ✓ Read
◐ reviewer
▸ Implement Claude/Codex HUD (1/3)
```

## Install

```bash
npm install -g @lbb00/ahud
```

This installs the `ahud` binary standalone, independent of the Codex/Claude
Code plugin marketplace flow described below — useful for scripting or for
hosts this project doesn't package a plugin manifest for yet.

## Why two display adapters?

Claude Code accepts an arbitrary statusline command and passes native context
and rate-limit JSON to it. Codex has a native configurable footer, but its
items are currently predefined. ahud therefore shares collection, state,
rendering, colors, and configuration while using:

- Claude Code: the full custom renderer inside the native statusline.
- Codex: the native footer for model/context/limits/git/progress, plus an
  optional live companion for tools and subagents.

This keeps one codebase without depending on Codex's unstable transcript JSONL
format.

## Commands

Once installed via npm, the same commands are available as `ahud <command>`.
Running from a plugin checkout instead, use `node src/cli.mjs <command>`:

```bash
node src/cli.mjs demo
node src/cli.mjs setup claude
node src/cli.mjs setup codex --preset balanced
node src/cli.mjs setup both
node src/cli.mjs watch --cwd "$PWD"
```

Every config write is atomic and creates a timestamped backup first. Add
`--dry-run` to inspect the result without changing anything.

## Plugin layout

The same directory is a valid Codex and Claude Code plugin:

```text
.codex-plugin/plugin.json
.claude-plugin/plugin.json
hooks/hooks.json
skills/ahud/SKILL.md
commands/setup.md
src/
```

Codex sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` compatibility
variables for plugin hooks, so the shared hook file and command work on both
hosts.

## Custom rendering (adapter)

For full control over the rendered text, drop a module at
`~/.ahud/adapter.mjs` and export a `render` function:

```js
// ~/.ahud/adapter.mjs
export function render(snapshot, context) {
  return `${snapshot.project} · ${Math.round(snapshot.context ?? 0)}%`;
}
```

`render(snapshot, context)` may be sync or async and must return a string —
that string becomes the entire HUD output, replacing ahud's built-in
renderer. `snapshot` carries the current platform/model/git/tools/agents/plan
state; `context` carries `{ apiVersion, config, width, colors, utils }`,
where `utils` exposes ahud's own `visibleLength`, `truncate`, and `bar`
helpers so an adapter can reuse the same width-aware formatting. The
`snapshot`/`context` field contract is stable across upgrades: new fields may
be added, but existing fields are never removed or renamed.

Loading or running the adapter is never allowed to take the HUD down: a
missing file, a syntax error, a thrown exception, a non-string return value,
or simply running too slow all fall back to the built-in renderer silently
(the HUD keeps working; nothing hangs or crashes).

Set `"adapter": { "enabled": false }` in `~/.ahud/config.json` to turn the
adapter off entirely, even if the file exists.

## Privacy and resilience

Events stay local. The hook recorder stores timestamps, model/cwd, tool names,
short targets, agent types, and plan labels. It never stores prompts, command
output, or tool responses. Hook failures are ignored so the HUD cannot block an
agent session.

## Credits

The UX is inspired by
[jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) and the
native preset approach in
[ir272/codex-hud](https://github.com/ir272/codex-hud), both MIT-licensed.
