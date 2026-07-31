---
description: Set up ahud as the Claude Code statusline
allowed-tools: Bash
---

Resolve the plugin root from `${CLAUDE_PLUGIN_ROOT}` and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" setup claude
```

Then restart Claude Code so it reloads `statusLine`. The setup command creates
a timestamped backup of the existing settings file before replacing the
statusline command.
