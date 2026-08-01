# Agent HUD architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

Agent HUD has one data package and one UI plugin. The dependency direction is
strictly one-way:

```text
host status JSON ─────┐
four native hook APIs ┼─> @agent-hud/provider ─> UI adapter ─> renderer
Git / Claude metrics ─┘       raw facts          policy       ANSI lines
```

## Provider boundary

`packages/provider` owns I/O, host-schema normalization, durable local state
and raw derived measurements. Its public model uses neutral names such as
`ProviderState`, `ToolActivity`, `GitStatus`, `ClaudeSessionFacts` and
`HostSessionFacts`. `normalizeClaudeStatus`, `normalizeCursorStatus` and
`normalizeAntigravityStatus` are the only functions that read nested host
fields such as `context_window`, `rate_limits` and `quota`; the UI receives a
complete flat fact set.

The public modules remain small facades over responsibility-based internals:

- `store.ts` owns event persistence and state folding, while
  `hooks/normalize.ts` owns host-specific hook normalization;
- `telemetry.ts` composes Claude measurements, while `telemetry/transcript.ts`,
  `telemetry/health.ts` and `telemetry/config.ts` own incremental transcript
  evidence, Statuspage refresh/cache behavior and shared defaults respectively.

This keeps imports from `@agent-hud/provider` stable without mixing unrelated
collection lifecycles in one source file.

The provider can say:

- cache expiry is epoch `T`;
- forced compact is approximately `N` turns away;
- API health indicator is `minor`;
- quota usage is `P` with reset `R`.

It cannot say:

- cache is yellow;
- display `→~Nt` instead of `↓~Nt`;
- tint the model;
- hide line two below 60 columns.

That prohibition is tested by `packages/provider/test/boundary.test.mjs`.

## UI plugin boundary

`plugins/agent-hud` is the host adapter and presentation layer:

- `adapter.ts` maps raw facts to the legacy display model and resolves display
  precedence;
- `design.ts` preserves the calibrated shell design tokens and their rationale;
- `render.ts` is a pure ANSI/text renderer;
- `setup.ts` adapts the presentation to each host's configuration surface;
- `cli.ts` composes the two layers and bundles a self-contained plugin runtime.

Claude, Cursor and Antigravity support the complete custom three-line renderer.
Cursor omits quota because its live status payload has no quota fact.
Antigravity contributes native quota, VCS, lifecycle and background-task facts.
Codex exposes only predefined native footer items, so its footer mirrors the
same hierarchy and omits the unavailable five-hour item. The optional companion
uses the same renderer for tool, subagent and plan activity.

## Packaging rule

The provider is independently buildable and testable. The plugin declares it as
a workspace development dependency, then bundles it into `dist/*.js`.
Installed plugins therefore never rely on the source workspace or a runtime
`node_modules/@agent-hud/provider` path.

Maintained source, tests, fixtures and documentation are capped at 500 lines
per file by `plugins/agent-hud/test/structure.test.mjs`. Generated build output,
dependencies and lockfiles are excluded from that responsibility boundary.
