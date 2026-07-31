# ahud marketplace

One marketplace, one plugin implementation, two hosts: Codex and Claude Code.

## Codex

```bash
codex plugin marketplace add /absolute/path/to/ahud
codex plugin add ahud@ahud
```

Then ask Codex: `Set up ahud with the balanced preset.`

## Claude Code

Inside Claude Code:

```text
/plugin marketplace add /absolute/path/to/ahud
/plugin install ahud@ahud
/reload-plugins
/ahud:setup
```

Restart Claude Code after setup so it reloads the statusline command.

The shared implementation is in [`plugins/ahud`](plugins/ahud).
