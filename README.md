# Agent HUD

[English](README.md) | [简体中文](README.zh-CN.md)

One shared HUD, one UI plugin, one independent data provider, five hosts:
Codex, Claude Code, Cursor CLI, Antigravity CLI and pi.

```text
host status + hooks + Git → @agent-hud/provider → UI adapter → shell-HUD renderer
```

The provider is in [`packages/provider`](packages/provider). The shared UI
plugin is in [`plugins/agent-hud`](plugins/agent-hud). See
[`docs/architecture.md`](docs/architecture.md) for the layer contract.

## HUD at a glance

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00 | %+50% 9d
$5.32 | →~3t
agent-hud | main*↑2 | +128/-17 | /workspace/agent-hud
```

Each line answers one question: what this session is doing, whether to act on
it now, and where you are.

**Line one — session state**

| Field | What it is |
| --- | --- |
| `Sonnet 5` | Current model. Its own name carries the warning when the Anthropic status page reports an incident |
| `H` | Reasoning effort, one of `L` `M` `H` `XH` `MAX` |
| `90k/45% 26t` | Context tokens used, how full the window is, true assistant turns (subagents excluded) |
| `*19:04` | When the prefix cache expires; `*cold` once it has |
| `#15%/70%` | Share used of the 5-hour and the 7-day quota |
| `↻13:10/Fri19:00` | When each of those two quotas resets, in the same order |
| `%+50% 9d` | Promotional window: green while open, with the time left; `%+50% ↑3h` means it opens in three hours; `%+50%` alone is open with no end date |

**Line two — decision support**

| Field | What it is |
| --- | --- |
| `$5.32` | Client-estimated cost of this session |
| `→~3t` | Roughly how many turns until a forced compact; `→full` once you are in that zone |
| `↓~12t` | Turns until a voluntary compact pays for itself. Mutually exclusive with the one above |

**Line three — place**

| Field | What it is |
| --- | --- |
| `agent-hud` | Project name, the visual anchor of the whole HUD |
| `main*↑2` | Branch; `*` means uncommitted changes, `↑2` `↓1` are commits ahead of and behind upstream |
| `+128/-17` | Lines this session added and removed |
| `/workspace/agent-hud` | Working directory, left-ellipsized on narrow panes so the tail survives |

Color encodes warning level only; brightness encodes hierarchy. Green is the
single exception and marks an open promotional window. Fields shrink with the
terminal width, and a fact the host does not supply is omitted rather than
guessed. Full definitions and the warning thresholds live in the
[HUD design contract](plugins/agent-hud/docs/hud-design.md).

## Host support

| Host | Native surface | Shared activity |
| --- | --- | --- |
| Claude Code | Full inherited three-line HUD | Native statusline |
| Codex | Balanced native footer without unavailable 5h quota | Optional companion |
| Cursor CLI | Shared three-line HUD; unavailable quota omitted | Native hooks |
| Antigravity CLI | Shared three-line HUD with quota and VCS facts | Native hooks |
| pi | Promotional window and vendor incident inside pi's own footer | Native extension |

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
(`.claude-plugin/marketplace.json`). Cursor CLI, Antigravity CLI and pi have no
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

### pi

pi renders its own footer with tokens, cost, context and branch, so setup adds
one segment beside them instead of taking the line over. That segment carries
only what pi cannot work out for itself: whether the API behind the selected
model has an open promotional window, and whether that vendor's status page is
reporting an incident (shown as `!Anthropic`). Both belong to the API rather
than to pi, so both are shared with every other host on the same endpoint:

```bash
node plugins/agent-hud/dist/cli.js setup pi
```

That writes `~/.pi/agent/extensions/agent-hud.ts`, a one-line file re-exporting
the built extension, and the segment shows whether a promotional window is open
right now. Nothing else transfers: plan quota means nothing under API billing,
and the compaction estimate is calibrated to Claude Code's thresholds.

Use `setup all` to configure all five hosts. Every changed file receives a
timestamped backup.

## Promotional windows

Vendors run temporary campaigns — extra off-peak usage, weekend bonuses — that no host reports in its status payload. The schedule lives in this repository, in [`packages/provider/promotions.json`](packages/provider/promotions.json), so a campaign is corrected once for everyone instead of in every user's config. It ships empty on purpose: a window nobody verified is worse than no badge, so entries arrive by pull request.

The runtime reads that schedule from three places. A copy fetched from this repository into `~/.agent-hud/promotions-cache.json`, refreshed at most every six hours by a detached background process that no status line ever waits on. The copy bundled into the published packages, which answers before the first fetch and whenever the network is unavailable. And your own `~/.agent-hud/config.json`, layered on top, which wins wherever the two disagree.

The fetch is a plain GET of one static JSON file. It carries no session data, and `AGENT_HUD_NO_REMOTE=1` switches it off — the bundled copy and your own config keep working.

Your config adds windows, hides shared ones by id, or opts out of the shared schedule entirely with `"shared": false`:

```json
{
  "disabled": ["some-shared-window-id"],
  "promotions": [
    {
      "id": "claude-offpeak",
      "label": "50%",
      "platforms": ["claude"],
      "days": ["sat", "sun"],
      "start": "15:00",
      "end": "23:00",
      "from": "2026-09-01",
      "until": "2026-12-31"
    }
  ]
}
```

Clock times are UTC, so they can be copied from a vendor announcement unchanged; the HUD converts to your own zone. Add `"timezone": "Asia/Shanghai"` to a window if you would rather write local hours — either way daylight-saving changes are handled. A misspelled zone name drops that one window instead of quietly reading its hours as UTC and showing the wrong time.

Only `start` and `end` are required. An `end` at or before `start` crosses midnight. `days` takes `0` for Sunday or three-letter names, `platforms` limits the window to some hosts, `from` and `until` bound the campaign, and `"enabled": false` switches a window off without deleting it. A local window with the same `id` as a shared one replaces it. A field that narrows a window is dropped together with its window when the value is unusable, so a typo never turns into a badge that shows on every host, every day.

Some discounts belong to an API rather than to a host. DeepSeek prices requests billed on `api.deepseek.com` by the clock, whatever program sends them, and the same models resold by someone else are not part of that. Those windows take `endpoints` instead of `platforms`:

```json
{
  "id": "vendor-offpeak",
  "label": "50%",
  "endpoints": ["api.example.com"],
  "start": "16:30",
  "end": "00:30"
}
```

The hours above are illustrative, not a schedule to copy. Vendors rewrite these: DeepSeek retired its 16:30–00:30 UTC discount along with the V3/R1 model aliases and now bills peak and off-peak hours instead. That is the reason the shared table lives in this repository and ships empty, rather than being compiled into the runtime where a retired window would need a release to remove.

The match is on the host part of the base URL, so `https://api.deepseek.com/v1` and `api.deepseek.com` are the same thing. A window written this way only shows up where the host can say which endpoint the current model talks to. pi reads the selected model's `baseUrl`; Claude Code reads its inherited `ANTHROPIC_BASE_URL` and cloud-provider settings, defaulting to `api.anthropic.com` only when none of those settings is present. Everywhere else it stays hidden, because a program that cannot tell must not claim the discount.

The first HUD line then carries a green `%50% 1h20` while the window is open, and a plain `%50% ↑2h13` before it opens: the label, then how long it lasts or how long until it starts. Green is the HUD's only non-warning color, reserved for this one item, because it is the only signal that rewards acting immediately.

`agent-hud promotions` prints both source paths, where the shared schedule came from and when, every parsed window, the platform and endpoint filters it applied, and what is active right now.

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
