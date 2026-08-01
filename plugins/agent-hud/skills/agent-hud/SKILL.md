---
name: agent-hud
description: Configure, inspect, or run Agent HUD, a shared HUD for Codex, Claude Code, Cursor CLI and Antigravity CLI. Use when the user asks for Agent HUD, an agent CLI status line, live tool or subagent activity, context and usage visibility, or HUD setup/repair.
---

# Agent HUD

Agent HUD uses one local event model and the inherited shell-HUD visual contract
for Claude Code, Codex, Cursor CLI and Antigravity CLI.

## Setup

Resolve the plugin root as the directory two levels above this file.

For Codex, apply the native balanced footer:

```bash
node <plugin-root>/dist/cli.js setup codex
```

Use `--preset compact` or `--preset full` when requested. Restart Codex or open
a new session after changing the footer.

For Claude Code, configure the custom statusline:

```bash
node <plugin-root>/dist/cli.js setup claude
```

For Cursor CLI, configure its custom status line and native v1 hooks:

```bash
node <plugin-root>/dist/cli.js setup cursor
```

For Antigravity CLI, configure its custom status line and the namespaced global
hooks under `~/.gemini/config/hooks.json`:

```bash
node <plugin-root>/dist/cli.js setup antigravity
```

Use `setup all` only when the user asks to configure every host. Cursor and
Antigravity receive the same three-line visual contract as Claude. Omit facts
their live payload does not expose; never infer quota or lifecycle from text.

The setup command creates a timestamped backup before changing an existing
configuration.

## Live activity companion

Codex does not currently expose an arbitrary custom footer renderer. Its native
footer shows model, context, limits, permissions, git, and task progress. For
the shared tools/subagents view, run this in a second terminal or pane:

```bash
node <plugin-root>/dist/cli.js watch --cwd "$PWD"
```

Use `watch --once --no-color` for scripts and prompt integrations.

## Verify

```bash
node <plugin-root>/dist/cli.js demo
node <plugin-root>/dist/cli.js setup codex --dry-run
node <plugin-root>/dist/cli.js setup claude --dry-run
node <plugin-root>/dist/cli.js setup cursor --dry-run
node <plugin-root>/dist/cli.js setup antigravity --dry-run
```

Do not parse Codex transcript JSONL for core behavior. Codex documents that
format as unstable. Use hook events for tools, agents, and plan progress, and
the native Codex footer for context and usage limits. Do not parse Cursor or
Antigravity transcript logs; their documented status payloads and hooks are the
source of truth.
