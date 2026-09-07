# HUD design contract

This is the TypeScript continuation of the original
`~/.claude/statusline-command.sh` design, not a new visual theme.
The empirical findings, rejected alternatives, formulas and `UNVERIFIED`
caveats from its comments are preserved in
[legacy-design-rationale.md](legacy-design-rationale.md).

## Lines

The custom Claude, Cursor and Antigravity statusline has at most three lines:

1. Session state: `model | effort | context | cache | quota | resets`
2. Decision support: `$cost | compact advisor`
3. Place: `project | branch | churn | cwd`

The companion may add a fourth dim activity line for tools, subagents, and plan
progress. That extension is deliberately disabled inside each native custom
statusline, so the original hierarchy remains intact.

## Glyph contract

| Token | Meaning |
| --- | --- |
| `L/M/H/XH/MAX` | Reasoning effort |
| `90k/45% 26t` | Context tokens, window fullness, true assistant turns |
| `*19:04`, `*cold` | Prefix-cache expiry time or expired cache |
| `#15%/70%` | 5-hour and 7-day quota usage |
| `↻13:10/Fri19:00` | Reset times in the same order as quota |
| `%+50% 9d` | Promotional window: green while open, `↑3h` until it opens, no time when it has no end date |
| `$5.32` | Client-estimated session cost |
| `→~3t`, `→full` | Turns until forced compact, or already in the zone |
| `↓~12t` | Turns until a voluntary compact pays for itself |
| `main*↑2↓1` | Branch, dirty tree, ahead/behind upstream |
| `+128/-17` | Session line churn |

The glyphs stay single-width and tmux/phone-safe. `~` means “about,” `t`
means turns, `k` means thousands of tokens, and dim ` | ` is punctuation.

## Color is a warning channel

Color encodes warning level and nothing else:

- Plain: healthy fact.
- Yellow: caution.
- Red: act now.

Session facts use normal brightness. Location is dim, except the project name,
which is bright white and acts as the visual anchor. Reset times are facts and
stay plain. The model is plain unless the Anthropic API status cache reports an
incident; then Claude's own name carries the health warning.

The warning ramps live in `src/design.ts`:

| Signal | Yellow | Red |
| --- | ---: | ---: |
| Context re-read pressure (`tokens × turns`) | 5M | 16M |
| Context fullness | 70% | 80% |
| Session cost | $4 | $13 |
| Quota usage | 60% | 85% |
| Projected quota burn at reset | 120% | 200% |
| Forced-compact ETA | ≤6 turns | ≤3 turns |

Context pressure and context fullness are intentionally independent. Pressure
estimates repeated prefix-reading cost; fullness answers “should I compact
now?” A cheap but nearly full context must still turn red, and an expensive
many-turn context may warn before it is full.

## Compact advisor

Line two owns one mutually exclusive advisor slot:

- While context is filling, forced-compact ETA wins: `→~Nt`, or `→full`.
- Otherwise, the voluntary compact break-even may appear: `↓~Nt`.

Break-even stays plain because it is an opportunity, not a warning. The
residual summary size is calibrated at 17k tokens. Far-away estimates are
hidden because they are noise, not actionable telemetry.

## Cache, turns, and quota semantics

- Turns are distinct main-thread `msg_…` assistant IDs, not JSONL content
  blocks. Sidechain/subagent messages are excluded as an intent-preserving
  correction to the shell's grep-only implementation.
- Cache TTL is inferred from recent cache writes: an `ephemeral_1h` prefix uses
  one hour; a shorter cache-write session uses five minutes; missing evidence
  falls back to one hour.
- Cache displays an absolute expiry clock, not a relative countdown. Hosts do
  not repaint the line while a session sits idle, so a `9m` countdown freezes
  at the moment you walk away — exactly when the number matters. `*19:04`
  survives being frozen: read it against the wall clock and it is still true.
  Minute resolution follows from that reading, so two sessions whose
  transcripts were last written in the same minute legitimately show one
  clock. The field answers when this session's prefix cache dies, not which
  session you are looking at.
- Quota color is the worse of absolute usage and projected burn rate. Pace is
  ignored during the noisy first 10% of a window.

## Responsive behavior

Model context suffixes are removed because the context box already carries
that information. On panes narrower than 60 columns, line two is hidden.
The cwd is home-relative and left-ellipsized, preserving the useful path tail.
Width follows live terminal columns and Unicode East Asian Width rules,
including locale-dependent ambiguous characters. Only basic dim,
bright-white, green, yellow, and red ANSI SGR codes are used. Yellow and red
are warnings; green appears on exactly one item, an open promotional window,
because it is the only signal that rewards acting right away.

## Codex adapter

Codex currently accepts only an ordered list of predefined native footer item
IDs, so it cannot render the custom three-line layout in-process. The default
Codex order mirrors the same information hierarchy:

`model/reasoning → tokens/context → weekly quota → branch/churn/path → task`

The unsupported 5-hour item is omitted. The companion consumes the same hook
events, state model, design tokens, and renderer as Claude when exact visual
parity is needed.

## Cursor and Antigravity adapters

Cursor and Antigravity render the same three-line contract rather than gaining
new host-specific widgets. Missing facts are omitted, never estimated:

- Cursor supplies model, effort, context, width and lifecycle hooks, but no
  current quota field.
- Antigravity supplies model, context, terminal width, quota, VCS, agent state,
  confirmation state and running background-task count.

Both adapters normalize host JSON in the provider. The UI sees only flat facts,
so host schema changes cannot silently turn into presentation policy.
