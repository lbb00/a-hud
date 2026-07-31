---
name: ahud
description: Configure, inspect, or run ahud, a shared HUD for Codex and Claude Code. Use when the user asks for ahud, a Codex/Claude status line, live tool or subagent activity, context and usage visibility, or HUD setup/repair.
---

# ahud

ahud uses one local event model for Claude Code and Codex.

## Setup

Resolve the plugin root as the directory two levels above this file.

For Codex, apply the native balanced footer:

```bash
node <plugin-root>/src/cli.mjs setup codex
```

Use `--preset compact` or `--preset full` when requested. Restart Codex or open
a new session after changing the footer.

For Claude Code, configure the custom statusline:

```bash
node <plugin-root>/src/cli.mjs setup claude
```

The setup command creates a timestamped backup before changing an existing
configuration.

## Live activity companion

Codex does not currently expose an arbitrary custom footer renderer. Its native
footer shows model, context, limits, permissions, git, and task progress. For
the shared tools/subagents view, run this in a second terminal or pane:

```bash
node <plugin-root>/src/cli.mjs watch --cwd "$PWD"
```

Use `watch --once --no-color` for scripts and prompt integrations.

## Verify

```bash
node <plugin-root>/src/cli.mjs demo
node <plugin-root>/src/cli.mjs setup codex --dry-run
node <plugin-root>/src/cli.mjs setup claude --dry-run
```

Do not parse Codex transcript JSONL for core behavior. Codex documents that
format as unstable. Use hook events for tools, agents, and plan progress, and
the native Codex footer for context and usage limits.
