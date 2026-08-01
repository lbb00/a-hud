# Legacy HUD parity specification

Authoritative source: `~/.claude/statusline-command.sh` (627 lines), frozen in
the repository as the executable fixture
`test/fixtures/legacy-statusline-command.sh` plus its sourced rendering phase
`test/fixtures/legacy-statusline/render-tail.sh`. Splitting at the final render
boundary keeps each maintained file focused and below 500 lines; differential
tests preserve the original observable behavior. The original comments are
treated as design rationale, not merely implementation notes; their cost model,
rejected alternatives, glyph legend, responsive rules and warning semantics are
preserved in `hud-design.md`, `src/design.ts` and focused renderer comments.

This document is a requirement matrix, not a loose inspiration list. A new UI
implementation is complete only when each observable contract below has a
provider value, a renderer rule, and a test.

| Area | Legacy contract | Provider responsibility | UI plugin responsibility |
| --- | --- | --- | --- |
| Structure | Up to three native lines: session, decision support, place | Supply semantic fields only | Preserve field and line order |
| Companion | No fourth native line | Supply activity state | Fourth dim line only in companion mode |
| Palette | Color means warning, never decoration | Supply raw values | Plain → yellow → red ramps |
| Hierarchy | Session bright; place dim; project bright anchor | None | ANSI brightness tokens |
| Separator | Dim ` \| ` punctuation | None | Never color as data |
| Model | Strip any trailing parenthetical | Model display name | Plain, except API incident severity |
| Effort | `L/M/H/XH/MAX`; high yellow, xhigh/max red | Resolve live value, then settings fallback | Abbreviation and warning color |
| Context box | `90k/45% 26t` | Tokens, fullness, true turns | One compact, unlabeled token |
| Pressure | Token and turn color use `context × turns` | Preserve raw tokens and turns | 5M yellow, 16M red |
| Fullness | Percentage color is independent of pressure | Preserve native percentage | 70% yellow, 80% red |
| Turns | Distinct assistant `message.id`; content blocks deduped (shell also counted sidechains) | Parse transcript; exclude sidechains as the documented intent-preserving correction | Display `Nt` suffix |
| Cache TTL | Infer 1h when `ephemeral_1h` exists, otherwise 5m after a cache write; fallback 1h | Infer TTL and absolute expiry | `*HH:MM`, yellow in last 5m, red `*cold` |
| Cost | Client session USD, logged only when changed | Append cost history | `$N.NN`, $4 yellow, $13 red |
| Forced compact | Recent fullness-per-turn slope; reset history after ≥3 point drop | Maintain context history and raw ETA | `→~Nt`; ≤6 yellow, ≤3 red, `→full` |
| Break-even | `(C + 62.5S)/(C-S)`, `S=17k`; forced advice wins | Calculate raw turns | Plain `↓~Nt`, hide when >15 |
| Advisor slot | Exactly one advisor beside cost | Supply both candidates | Forced wins; no competing tokens |
| Quota | `#5h%/7d%`, floored values | Preserve windows, percentages, resets | 60% yellow, 85% red |
| Quota pace | Only the binding (highest-used) window drives pace; ignore first 10% | Preserve reset/window length | Project to reset; 120% yellow, 200% red |
| Resets | Show both independently of usage; weekday for non-today 7d reset | Preserve epochs separately from quota values | Plain `↻HH:MM/DayHH:MM` |
| Git branch | Branch or detached `@shortsha` | Read without optional locks | Dim token |
| Git state | `*`, `↑N`, `↓N`; untracked files count as dirty | Collect dirty/ahead/behind | Append suffix without labels |
| Churn | `+N/-N`, hidden at zero | Preserve Claude cost line counts | Dim token |
| CWD | Home-relative, retain useful tail | Preserve canonical cwd | Left ellipsis with legacy budget |
| Narrow pane | `<60` columns hides line two | None | Keep session and place lines |
| Safety | User strings are never reinterpreted as escape sequences | Sanitize control characters | Emit values as text, ANSI from tokens only |
| API health | Cached Statuspage indicator; nonblocking background refresh | Cache/fetch raw indicator | Tint model only |
| Failure mode | Missing telemetry hides a field; HUD never blocks agent work | Fail soft and return partial snapshot | Render available facts without placeholders |

## Evidence

- Provider semantics and absence of UI policy:
  `packages/provider/test/{telemetry,boundary,git,store}.test.mjs`
- Adapter precedence and severity mapping:
  `plugins/agent-hud/test/adapter.test.mjs`
- Exact line/glyph/color output against the live shell, warning boundaries,
  narrow panes, missing fields and
  weekly reset labels: `plugins/agent-hud/test/render.test.mjs`
- Codex native parity and omission of unsupported 5h:
  `plugins/agent-hud/test/setup.test.mjs`
- Self-contained ESM package boundary:
  `plugins/agent-hud/test/package.test.mjs`

## Adapter-specific contract

Claude supplies full native statusline JSON, so its adapter can render the
complete legacy HUD.

Codex exposes predefined footer item identifiers but no arbitrary statusline
command. Its native order must mirror the same hierarchy:

`model/reasoning → used tokens/context → weekly quota → branch/churn/cwd → task`

The unsupported five-hour item is absent from every preset. Exact multi-line
visual parity is provided by the companion renderer over the same provider
state; unavailable Codex values are omitted rather than guessed.
