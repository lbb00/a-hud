# Changelog

All notable user-visible changes to Agent HUD are documented here. The project
uses semantic versioning for each published workspace package.

## Unreleased

### Added

- Bundled DeepSeek idle-hour (off-peak) windows for `api.deepseek.com`: outside Beijing weekday peak hours (09:00-12:00 and 14:00-18:00), pi and other endpoint-aware hosts show a green `%50%` badge counting down the idle stretch. Chinese statutory holidays are not modeled yet, so a holiday that falls on a weekday still reads as peak.
- A `group` field on promotional windows. Entries sharing a group are one continuous discount split across several windows, because quiet hours are the complement of other hours and cannot be spelled as a single entry; the countdown then covers the whole run instead of stopping at the end of whichever entry is open.

### Changed

- pi's footer paints a not-yet-open window in the theme accent instead of the dim grey it used before, which was illegible against the rest of the footer. Peak hours are now readable without borrowing the warning hue. The three-line HUD keeps its plain, uncolored pending token.

## a-hud 0.5.1 and @agent-hud/provider 0.3.1 - 2026-11-09

### Fixed

- Hardened statusline execution with a 2,000ms safety timeout race and AbortSignal support to guarantee prompt rendering and avoid process termination under strict host deadlines (such as Antigravity CLI's 5s hard timeout).
- Eliminated synchronous permission mutations on read-only file tail operations and opened event files with non-blocking flags to prevent indefinite thread hangs on FIFOs or non-regular files.
- Parallelized candidate event file stat checks and added platform-level pre-filtering to minimize disk I/O and deserialization latency on slow or external drives.
- Enforced a unified global budget deadline across sequential Git subprocess invocations and skipped Git queries when remaining statusline execution time is depleted.
- Preserved accurate dirty repository detection on Git buffer overflow (`ENOBUFS`) while ensuring Git failures and timeouts cleanly yield neutral repository state rather than falsely reporting clean working trees.

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
