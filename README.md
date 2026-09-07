# Agent HUD: a status line for AI coding agents

[English](README.md) | [简体中文](README.zh-CN.md)

Agent HUD is an open-source terminal status line (a heads-up display, or HUD) for Claude Code, OpenAI Codex, Cursor CLI, Antigravity CLI, and pi. It shows what the host already knows about the session but does not put on screen: context and token usage, quota or estimated cost, Git state, and what the agent is doing right now. pi keeps its own footer and gets a single extra segment for promotions and vendor incidents.

The same HUD reads the same way on every host, so you do not relearn it when you switch tools. Each host installs through its own mechanism, and nothing unrelated in its settings is touched.

## Contents

- [Install](#install)
- [Host support](#host-support)
- [HUD at a glance](#hud-at-a-glance)
- [Promotional windows](#promotional-windows)
- [FAQ](#faq)
- [Development](#development)
- [More documentation](#more-documentation)

## Install

Building from source requires Node.js 20.19 or later in the 20.x line, or Node.js 22.12 or newer, plus npm 11.16+. Clone the repository, then build from its root directory:

```bash
git clone https://github.com/lbb00/a-hud.git agent-hud
cd agent-hud
npm ci
npm run build
```

In the commands below, replace `/absolute/path/to/agent-hud` with the absolute path to this checkout. `setup all` configures all five hosts; `setup both` configures Claude Code and Codex only. Add `--dry-run` to preview a setup command before it changes files; see the [CLI reference](plugins/agent-hud/docs/cli.md) for details. Setup backs up existing files before changing them.

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

```bash
node plugins/agent-hud/dist/cli.js setup cursor
node plugins/agent-hud/dist/cli.js setup antigravity
```

These commands add the host's native status line and hooks without replacing unrelated settings.

### pi

```bash
node plugins/agent-hud/dist/cli.js setup pi
```

pi keeps its own footer for tokens, cost, context, and branch details. Agent HUD adds a segment for an active or upcoming promotion on the selected API endpoint and a vendor incident, such as `!Anthropic`. By default, setup writes `~/.pi/agent/extensions/agent-hud.ts`, which re-exports the built extension; `PI_CODING_AGENT_DIR` can set pi's directory instead.

## Host support

| Host | Where it appears | What it shows |
| --- | --- | --- |
| Claude Code | Its native three-line status line | Session, quota, cache, cost estimate, compaction estimate, Git, promotions |
| Codex | Its native footer, plus an optional [activity companion](plugins/agent-hud/docs/cli.md#activity-companion) | Session and Git; Codex does not report the 5-hour quota, so it is left out; the companion shows tools, subagents, and plans |
| Cursor CLI | Its native status line and hooks | Session and Git; quota is left out because Cursor does not report it |
| Antigravity CLI | Its native status line and hooks | Quota and Git, when the host provides them |
| pi | One segment in pi's own footer | Promotions and vendor incidents for the selected API endpoint |

## HUD at a glance

Example Claude Code status line (illustrative values):

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00 | %+50% 9d
$5.32 | →~3t
agent-hud | main*↑2 | +128/-17 | /workspace/agent-hud
```

Each line answers one question: what this session is doing, whether to act on it now, and where you are. A field the host cannot supply is left out rather than guessed.

**Session state**

| Field | Meaning |
| --- | --- |
| `Sonnet 5` | Current model; when the session uses the Anthropic API, its name carries a warning if the Anthropic status page reports an incident |
| `H` | Reasoning effort: `L`, `M`, `H`, `XH`, or `MAX` |
| `90k/45% 26t` | Context tokens used, context-window fill, and assistant turns; subagent turns are excluded |
| `*19:04` | Prefix-cache expiry; `*cold` means the cache has expired |
| `#15%/70%` | Used share of the 5-hour and 7-day quotas, when available |
| `↻13:10/Fri19:00` | Reset times for those quotas, in the same order |
| `%+50% 9d` | Promotional window: green while open, with the time left; `%+50% ↑3h` means it opens in three hours; `%+50%` alone is open with no end date |

**Decision support**

| Field | Meaning |
| --- | --- |
| `$5.32` | Client-estimated cost for this session |
| `→~3t` | Approximate turns until a forced compact; `→full` means that point has arrived |
| `↓~12t` | Turns until voluntarily compacting becomes worthwhile; it is shown instead of the forced-compact estimate |

**Location**

| Field | Meaning |
| --- | --- |
| `agent-hud` | Project name |
| `main*↑2` | Branch; `*` means uncommitted changes, while `↑2` and `↓1` show commits ahead of and behind upstream |
| `+128/-17` | Lines added and removed in this session |
| `/workspace/agent-hud` | Working directory; on narrow terminals the left side is shortened so the end remains visible |

Color means warning level and nothing else; brightness marks hierarchy. Green is the one exception, reserved for an open promotional window. Full field definitions and the warning thresholds are in the [HUD design contract](plugins/agent-hud/docs/hud-design.md).

## Promotional windows

Vendors run temporary campaigns, such as off-peak discounts or weekend bonuses, that no host reports in its status payload. Agent HUD shows them as a badge. The shared schedule lives in this repository, in [`packages/provider/promotions.json`](packages/provider/promotions.json), so a campaign is corrected once for everyone instead of in every user's config. It ships empty on purpose: a window nobody verified is worse than no badge, so entries arrive by pull request.

The schedule reaches your machine three ways, and the later ones win. A copy is fetched from this repository into `~/.agent-hud/promotions-cache.json` at most every six hours, by a background process that no status line waits on; if a fetch fails, the last good copy stays. The published package also bundles a copy, which answers before the first fetch, when the network is unavailable, and whenever it is newer than the cache. Your own `~/.agent-hud/config.json` sits on top and wins wherever the two disagree. `AGENT_HUD_NO_REMOTE=1` switches off the fetch alone; the bundled copy and your config keep working.

The examples below are made up. Your config can add windows, hide shared ones by `id`, or drop the shared schedule entirely with `"shared": false`:

```json
{
  "disabled": ["example-shared-window"],
  "promotions": [
    {
      "id": "example-weekend-offpeak",
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

Clock times are UTC, so they can be copied from a vendor announcement unchanged; the HUD converts them to your own zone. Add `"timezone": "Asia/Shanghai"` to a window if you would rather write local hours. Daylight-saving changes are handled either way, and a misspelled zone name drops that one window instead of quietly reading its hours as UTC.

Only `start` and `end` are required. An `end` at or before `start` crosses midnight. `days` takes `0` for Sunday or three-letter names, `platforms` limits the window to some hosts, `from` and `until` bound the campaign, and `"enabled": false` switches a window off without deleting it. A local window with the same `id` as a shared one replaces it. A window whose narrowing field has an unusable value is dropped whole, so a typo never turns into a badge that shows on every host, every day.

Some discounts belong to an API rather than to a host: the vendor bills by the clock on its own endpoint, whatever program sends the request, and the same models resold elsewhere are not part of it. Those windows take `endpoints` instead of `platforms`:

```json
{
  "id": "example-api-offpeak",
  "label": "50%",
  "endpoints": ["api.example.com"],
  "start": "16:30",
  "end": "00:30"
}
```

The match is on the host part of the base URL, so `https://api.example.com/v1` and `api.example.com` are the same thing. Such a window only shows up where the host can say which endpoint the current model talks to. pi reads the selected model's `baseUrl`; Claude Code reads its inherited `ANTHROPIC_BASE_URL` and cloud-provider settings, and assumes `api.anthropic.com` only when none of them is set. Everywhere else the badge stays hidden, because a program that cannot tell must not claim the discount.

To see where each schedule came from, every parsed window, the filters applied, and what is active right now, run this with your own endpoint:

```bash
node plugins/agent-hud/dist/cli.js promotions --platform claude --endpoint https://api.example.com
```

## FAQ

### Can Codex display the same HUD as Claude Code?

Not all of it. Codex has its own footer, and Agent HUD fills it with the facts Codex reports, which is fewer than Claude Code's status line carries. The optional activity companion adds tools, subagents, and plans beside it.

### Why are some fields missing?

The host did not report that fact, or it does not apply. Plan quota, for example, means nothing under API billing. Agent HUD leaves such a field out rather than estimating it.

### Why is no promotion badge shown?

No window matches the current time, host, or endpoint. The shared schedule is empty until a campaign is verified, so a badge needs either a merged entry or a window in your own config. To see which windows were loaded and which filters excluded them, run from the checkout, with your own endpoint:

```bash
node plugins/agent-hud/dist/cli.js promotions --platform claude --endpoint https://api.example.com
```

### Does Agent HUD send session data anywhere?

No. Hook events stay in `~/.agent-hud`. The only outbound requests are two plain GETs: one for the shared promotion schedule, a static JSON file in this repository, and one for the status page of the vendor behind the current API. Neither carries session data. `AGENT_HUD_NO_REMOTE=1` stops the schedule fetch; the status-page check is unaffected.

## Development

Development needs the same Node.js and npm as [Install](#install). The published packages still run on Node.js 18. From the repository root:

```bash
npm ci
npm run check
npm run lint:fix
npm run build
```

`npm run check` runs the linter, the documentation link check, and the test suite. The data [provider](packages/provider) and the [UI plugin](plugins/agent-hud) are separate packages; [architecture](docs/architecture.md) describes the line between them.

## More documentation

- [CLI reference](plugins/agent-hud/docs/cli.md)
- [Architecture](docs/architecture.md)
- [Open-source readiness](docs/open-source-readiness.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Release process](docs/releasing.md)
- [MIT License](LICENSE)
