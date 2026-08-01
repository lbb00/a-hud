# Agent HUD

[English](README.md) | [简体中文](README.zh-CN.md)

One shared HUD, one UI plugin, one independent data provider, four hosts:
Codex, Claude Code, Cursor CLI and Antigravity CLI.

```text
host status + hooks + Git → @agent-hud/provider → UI adapter → shell-HUD renderer
```

The provider is in [`packages/provider`](packages/provider). The shared UI
plugin is in [`plugins/agent-hud`](plugins/agent-hud). See
[`docs/architecture.md`](docs/architecture.md) for the layer contract.

## Host support

| Host | Native surface | Shared activity |
| --- | --- | --- |
| Claude Code | Full inherited three-line HUD | Native statusline |
| Codex | Balanced native footer without unavailable 5h quota | Optional companion |
| Cursor CLI | Shared three-line HUD; unavailable quota omitted | Native hooks |
| Antigravity CLI | Shared three-line HUD with quota and VCS facts | Native hooks |

All configuration changes are atomic, backed up and scoped to the selected
host. Agent HUD does not infer missing telemetry from model output or unstable
transcript formats.

## Development

Development uses Node 20.19+ or 22.12+ with npm 11.16+. Published packages
retain their Node 18 runtime compatibility. From this workspace root:

```bash
npm install
npm run check
npm run lint:fix
npm run build
```

`npm run check` runs Oxlint with warnings denied, then the complete test suite.
The shared configuration treats correctness and suspicious findings as errors
and enables its native TypeScript, Oxc, Unicorn, import, Node and Promise rule
sets while ignoring generated bundles. ANSI/control-sequence regex rules are
disabled because the HUD intentionally parses terminal controls; `toSorted()`
is not required so the published runtime can remain compatible with Node 18,
and small test/local helpers may stay scoped beside the behavior they describe.

## Install

Codex and Claude Code install through this repo's plugin marketplace manifest
(`.claude-plugin/marketplace.json`). Cursor CLI and Antigravity CLI have no
plugin-manager concept of their own, so they configure directly through the
built CLI instead.

### Codex

```bash
codex plugin marketplace add /absolute/path/to/agent-hud
codex plugin add agent-hud@agent-hud
```

Then ask Codex: `Set up Agent HUD with the balanced preset.`

### Claude Code

Inside Claude Code:

```text
/plugin marketplace add /absolute/path/to/agent-hud
/plugin install agent-hud@agent-hud
/reload-plugins
/agent-hud:setup
```

Restart Claude Code after setup so it reloads the statusline command.

### Cursor CLI and Antigravity CLI

The same built runtime configures their native custom status lines and
host-specific hooks without replacing unrelated settings:

```bash
node plugins/agent-hud/dist/cli.js setup cursor
node plugins/agent-hud/dist/cli.js setup antigravity
```

Use `setup all` to configure all four hosts. Every changed file receives a
timestamped backup.

## Project policies

- [CLI reference](plugins/agent-hud/docs/cli.md)
- [Architecture](docs/architecture.md)
- [Open-source readiness](docs/open-source-readiness.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Release process](docs/releasing.md)
- [MIT License](LICENSE)
