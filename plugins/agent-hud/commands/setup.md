---
description: Set up Agent HUD for a supported agent CLI
allowed-tools: Bash
---

Resolve the plugin root from `${CLAUDE_PLUGIN_ROOT}` and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup claude
```

Then restart Claude Code so it reloads `statusLine`. The setup command creates
a timestamped backup of the existing settings file before replacing the
statusline command.

For explicit cross-host setup, run the same CLI with `setup codex`, `setup
cursor`, `setup antigravity`, or `setup all`.
