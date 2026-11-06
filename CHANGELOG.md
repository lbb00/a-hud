# Changelog

All notable user-visible changes to Agent HUD are documented here. The project
uses semantic versioning for each published workspace package.

## a-hud 0.5.0 and @agent-hud/provider 0.3.0 - 2026-11-06

### Added

- Cursor Auto and API plan usage monitoring, local caching, and background refresh with leased locks.
- Per-pool warning coloring for quota when explicit pool labels are rendered.

### Changed

- Aligned package name and CLI binary name to `a-hud` (`bin: { "a-hud": "./dist/cli.js" }`).
- Telemetry transcript cache calculation uses message timestamps rather than filesystem mtime to prevent drift across platforms.
- Normalized rolled-over Claude Code 5-hour rate limits to display 0% without shifting 7-day limits.
- Cleared running tool activity on Stop hook events while preserving long-lived subagents.
- Updated toolchain and dependencies: `actions/setup-node` to v7.1.0, `oxlint` to 1.87.0, `publint` to 0.3.25, `@types/node` to 26.6.4, and Node target to 24.

## Agent HUD 0.4.0 - 2026-09-07

### Added

- Promotional windows from shared and local schedules, matched to the API endpoint when available.
- A pi footer extension for promotional windows and vendor incidents.
- Open-source governance, CI, dependency maintenance and package smoke checks.
- A repository-activation checklist separating local evidence from external
  publishing controls.
- Oxlint correctness, suspicious, import, Node and Promise quality gates.
- Markdown table-structure and local-link documentation gates.
- Publint and TypeScript package-resolution release gates.
- Full-SHA-pinned GitHub Actions with cross-platform and Node 18 runtime checks.
- Simplified Chinese project, plugin, Provider, architecture and contribution
  documentation.

### Changed

- Vendor health is selected by API endpoint and cached across supported hosts in Agent HUD's data directory.
- Provider internals are organized into responsibility-based hook and telemetry
  modules while retaining stable public facades.
- The bundled CLI no longer installs a redundant runtime dependency.
- Documentation and comments describe Agent HUD without external HUD or
  status-line project references.

## Agent HUD 0.3.0 - 2026-07-29

### Added

- One TypeScript ESM HUD core for Claude Code, Codex, Cursor CLI and
  Antigravity CLI.
- Shared tool, subagent, plan and lifecycle activity state.
- Claude-compatible custom renderer for Cursor and Antigravity.
- Codex native footer presets without the unavailable five-hour item.
- Unicode-aware terminal measurement and responsive rendering.
- Provider/UI package boundary with local, fail-soft telemetry collection.

### Compatibility

- Preserved the previous shell HUD's design tokens, scan hierarchy, warning
  semantics and exact differential fixture output.
