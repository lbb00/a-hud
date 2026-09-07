# Agent HUD: a status line for AI coding agents

[English](README.md) | [简体中文](README.zh-CN.md)

Agent HUD is an open-source terminal heads-up display (HUD) and status line for Claude Code, OpenAI Codex, Cursor CLI, Antigravity CLI, and pi. It puts the session facts your host makes available—such as context and token usage, quota or estimated cost, Git state, and activity—where you can see them while you work. pi keeps its own footer and receives only the promotion and vendor-health extension it needs.

Use Agent HUD when you want one familiar view across AI coding agents without replacing their native workflows. It reads each host's supported signals, leaves unavailable data out, and keeps configuration scoped to the host you choose.

## Contents

- [Install](#install)
- [Host support](#host-support)
- [HUD at a glance](#hud-at-a-glance)
- [Promotional windows](#promotional-windows)
- [FAQ](#faq)
- [Development](#development)
- [Project policies](#project-policies)

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

| Host | HUD or extension | Available facts depend on the host |
| --- | --- | --- |
| Claude Code | Native three-line status line | Session, quota, cache, cost estimate, compaction estimate, Git, promotions |
| Codex | Native footer with an optional [activity companion](plugins/agent-hud/docs/cli.md#activity-companion) | Session and Git facts; unavailable 5-hour quota is omitted; the companion shows tools, subagents, and plans |
| Cursor CLI | Native status line and hooks | Session and Git facts; unavailable quota is omitted |
| Antigravity CLI | Native status line and hooks | Quota and Git facts when the host provides them |
| pi | Extension in pi's own footer | Promotions and vendor incidents for the selected API endpoint |

Agent HUD displays the data available from each host. If a field is not supplied, it is simply not shown.

## HUD at a glance

Example Claude Code status line (illustrative values):

```text
Sonnet 5 | H | 90k/45% 26t | *19:04 | #15%/70% | ↻13:10/Fri19:00 | %+50% 9d
$5.32 | →~3t
agent-hud | main*↑2 | +128/-17 | /workspace/agent-hud
```

The first line shows session state, the second helps with a cost or compaction decision, and the third shows where you are. A host can omit any field it cannot provide.

**Session state**

| Field | Meaning |
| --- | --- |
| `Sonnet 5` | Current model; when the session uses the Anthropic API, its name carries a warning if the Anthropic status page reports an incident |
| `H` | Reasoning effort: `L`, `M`, `H`, `XH`, or `MAX` |
| `90k/45% 26t` | Context tokens used, context-window fill, and assistant turns; subagent turns are excluded |
| `*19:04` | Prefix-cache expiry; `*cold` means the cache has expired |
| `#15%/70%` | Used share of the 5-hour and 7-day quotas, when available |
| `↻13:10/Fri19:00` | Reset times for those quotas, in the same order |
| `%+50% 9d` | A promotion: green while open with time remaining; `↑3h` means it opens in three hours; no time means it has no stated end |

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

Color communicates warning level and brightness communicates hierarchy. Green is reserved for an open promotional window. Full field definitions and warning thresholds are in the [HUD design contract](plugins/agent-hud/docs/hud-design.md).

## Promotional windows

Vendors sometimes offer temporary off-peak usage or other bonuses that a host does not include in its status payload. Agent HUD can show those verified windows in the HUD. The shared list lives in [`packages/provider/promotions.json`](packages/provider/promotions.json) and is currently empty; unverified campaigns are deliberately left out.

Agent HUD reads a cached shared schedule from `~/.agent-hud/promotions-cache.json`, falling back to the bundled copy when no usable cache exists. Your `~/.agent-hud/config.json` overrides matching shared entries. A newer bundled schedule can supersede an older cached one. The shared list is a static JSON file fetched from this repository at most once every six hours; if a refresh fails, a previously downloaded valid copy remains available. `AGENT_HUD_NO_REMOTE=1` stops requests for that shared promotion list; it does not make every Agent HUD feature offline.

All examples in this section are fictional. Your local configuration can add windows, disable shared entries by ID, or turn off the shared list with `"shared": false`:

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

Times are UTC unless a window sets `"timezone"`, for example `"Asia/Shanghai"`; Agent HUD handles daylight-saving changes for valid named zones. Only `start` and `end` are required. An `end` at or before `start` crosses midnight. `days` accepts `0` for Sunday or three-letter day names, `platforms` limits a window to hosts, `from` and `until` set its date range, and `"enabled": false` turns it off. A local window with the same `id` replaces the shared one.

Use `endpoints` when a promotion belongs to an API endpoint rather than a host:

```json
{
  "id": "example-api-offpeak",
  "label": "50%",
  "endpoints": ["api.example.com"],
  "start": "16:30",
  "end": "00:30"
}
```

Endpoint matching uses the host part of the base URL, so `https://api.example.com/v1` and `api.example.com` match the same entry. Claude Code identifies the endpoint from its inherited routing environment; pi uses the selected model's `baseUrl`. An endpoint promotion stays hidden when the host cannot identify the current endpoint. To inspect source paths, parsed windows, filters, and current matches, replace the example endpoint with your own and run:

```bash
node plugins/agent-hud/dist/cli.js promotions --platform claude --endpoint https://api.example.com
```

## FAQ

### Can Codex display the same HUD as Claude Code?

Codex uses a native footer, so it shows the fields Codex provides rather than every Claude Code status-line field. Its optional activity companion can show tools, subagents, and plans.

### Why are some metrics missing?

The host did not supply that metric, or it is not meaningful for the current billing or runtime model. Agent HUD hides it instead of estimating it from incomplete data.

### Why is no promotion badge shown?

No configured window may match the current time, host, or endpoint. Run `node plugins/agent-hud/dist/cli.js promotions --platform claude --endpoint https://api.example.com` from the checkout with your own endpoint to inspect the loaded lists and filters. The shared list is currently empty until a campaign is verified.

### Does Agent HUD send session data to a server?

Hook events stay in `~/.agent-hud`. Background requests retrieve the shared promotion schedule and registered vendor status; the promotion request is a static JSON GET with no session-data body. `AGENT_HUD_NO_REMOTE=1` stops schedule downloads, not vendor-health checks.

## Development

Development requires Node.js `^20.19.0 || >=22.12.0` and npm 11.16+. Published packages retain Node.js 18 runtime compatibility. From the repository root:

```bash
npm ci
npm run check
npm run lint:fix
npm run build
```

`npm run check` runs linting, documentation checks, and the test suite. The [provider source](packages/provider) and [shared UI plugin](plugins/agent-hud) are separate packages; see the [architecture](docs/architecture.md) for their boundary.

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
