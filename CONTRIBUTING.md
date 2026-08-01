# Contributing to Agent HUD

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve Agent HUD. Changes should preserve one shared data
model and one visual contract across Codex, Claude Code, Cursor CLI and
Antigravity CLI.

## Before you start

- Use Node.js 20.19+ or 22.12+ and npm 11.16+ for development.
- Search existing issues before opening a new one.
- Keep pull requests focused on one behavior, bug, or documentation concern.
- For large behavior or provider-boundary changes, open an issue first so the
  compatibility contract can be agreed before implementation.

## Local setup

```bash
npm ci
npm run check
npm run package:smoke
```

`npm run check` runs Oxlint, documentation structure/link checks, TypeScript
builds, provider tests, renderer tests, legacy shell differential tests and
package-boundary tests.
`npm run package:smoke` packs both workspaces, installs the tarballs into an
isolated temporary consumer and exercises the public provider export and CLI.
`npm run package:lint` checks package manifests, ESM resolution and generated
TypeScript declarations from the same packed artifacts.

## Architecture boundaries

Read [docs/architecture.md](docs/architecture.md) before changing collection or
display behavior.

- `packages/provider` owns raw facts, host normalization, local persistence and
  lifecycle semantics. It must not own colors, glyphs, warning ramps or layout.
- `plugins/agent-hud/src/adapter.ts` owns raw-to-view precedence.
- `plugins/agent-hud/src/design.ts` owns inherited design tokens.
- `plugins/agent-hud/src/render.ts` is the pure terminal renderer.
- Host integrations must use documented payloads and hooks. Do not parse Codex,
  Cursor or Antigravity transcript formats.
- Maintained files must stay at or below 500 lines. Split by responsibility,
  while preserving stable public facades.

The shell HUD fixture and its comments are compatibility evidence. UI changes
must update focused tests and explain intentional parity changes rather than
silently rewriting the inherited contract.

## Testing changes

Add the narrowest test that proves the public behavior:

- provider facts or lifecycle: `packages/provider/test`;
- display policy or ANSI output: `plugins/agent-hud/test`;
- host configuration changes: `plugins/agent-hud/test/setup.test.mjs`;
- shell parity: `plugins/agent-hud/test/legacy-differential.test.mjs`;
- packaging or repository contracts: package/structure tests and
  `npm run package:smoke`.

A TypeScript build alone is insufficient. Before submitting, run:

```bash
npm run release:check
node plugins/agent-hud/dist/cli.js setup codex --dry-run
node plugins/agent-hud/dist/cli.js setup claude --dry-run
node plugins/agent-hud/dist/cli.js setup cursor --dry-run
node plugins/agent-hud/dist/cli.js setup antigravity --dry-run
```

Dry-run output can contain local paths and existing host configuration. Redact
it before attaching logs to an issue or pull request.

## Code and commit style

- Use TypeScript ESM for production code and include `.js` extensions in
  relative imports that survive compilation.
- Prefer fail-soft collection: missing telemetry must omit a field instead of
  blocking an agent session.
- Preserve unrelated user configuration and create backups before host config
  writes.
- Keep comments focused on design intent, compatibility constraints and
  rejected alternatives.
- Use clear English Conventional Commit messages, for example:
  `fix(provider): preserve lifecycle state after a stale hook`.

## Pull requests

Pull requests should include:

- the user-visible or architectural reason for the change;
- the hosts and package boundaries affected;
- tests added or updated;
- exact verification commands;
- screenshots or terminal captures for visual changes, with private data
  redacted;
- a changelog entry for user-visible behavior.

By contributing, you agree that your contribution is licensed under the MIT
License.
