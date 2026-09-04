# Agent HUD CLI

The `agent-hud` executable is the shared runtime for setup, host status lines,
hook collection and the optional Codex activity companion.

Run it from an installed package:

```bash
agent-hud help
```

Or from a source checkout after `npm run build`:

```bash
node plugins/agent-hud/dist/cli.js help
```

## Setup

```text
agent-hud setup claude
agent-hud setup codex [--preset compact|balanced|full]
agent-hud setup cursor
agent-hud setup antigravity
agent-hud setup pi
agent-hud setup both
agent-hud setup all
```

Setup patches the selected host configuration atomically and creates a
timestamped backup before changing an existing file. Repeating setup is
idempotent.

Common setup options:

| Option | Meaning |
| --- | --- |
| `--dry-run` | Print the proposed files without writing them |
| `--config PATH` | Override the selected host's main config path |
| `--hooks-config PATH` | Override the selected host's hooks config path |
| `--preset NAME` | Select the Codex native footer preset |

`both` configures Claude Code and Codex. `all` additionally configures Cursor
CLI, Antigravity CLI and pi.

`setup pi` writes `~/.pi/agent/extensions/agent-hud.ts`, which re-exports the
built extension. pi loads every `.ts` file in that directory with no build step,
so the installed file stays a single line and upgrading the plugin is enough.
`PI_CODING_AGENT_DIR` overrides the directory it is written into.

## Status line

```text
agent-hud statusline
```

The command reads one host status payload as JSON from standard input and
writes one rendered status line to standard output. Host setup writes this
command into the native status-line configuration; it is normally not invoked
by hand.

## Hook recorder

```text
agent-hud hook --platform HOST --event EVENT
```

The command reads one native hook payload as JSON from standard input,
normalizes the safe activity fields and appends them to local storage. Hook
errors are swallowed so telemetry cannot block an agent session. The recorder
does not persist prompts, command output or tool responses.

Supported platform values are `claude`, `codex`, `cursor`, `antigravity` and
the generic fallback `agent`.

## Activity companion

```text
agent-hud watch [--cwd PATH] [--width COLUMNS] [--no-color]
agent-hud watch --once [--json]
```

Interactive `watch` repaints the current activity snapshot until interrupted.
It is useful beside Codex because Codex's native footer cannot render arbitrary
tool and subagent rows.

| Option | Meaning |
| --- | --- |
| `--cwd PATH` | Select the workspace whose activity and Git state are shown |
| `--width COLUMNS` | Hard-cap every rendered line to a terminal-cell width |
| `--no-color` | Disable ANSI styling |
| `--once` | Render one snapshot and exit |
| `--json` | With `--once`, print the normalized snapshot instead of the HUD |

When `--width` is absent, the renderer uses the live TTY width, then the
`COLUMNS` environment variable.

## Diagnostics

```text
agent-hud demo
```

`demo` prints a deterministic representative HUD without reading host state.
It is the quickest way to confirm that the installed executable and terminal
styling work.

## Promotional windows

```text
agent-hud promotions [--platform claude|codex|cursor|antigravity|pi] [--endpoint URL]
```

Prints the config path, the shared-schedule cache path, your local zone, where
the shared schedule came from and when, every parsed window tagged `local` or
`shared`, the filters used for this run, and which window is open or coming up
next. Use it when the HUD shows no badge and you need to tell "nothing is
scheduled" from "the file is not being read" or "no endpoint was provided".

Windows come from the schedule maintained in the repository — fetched into
`~/.agent-hud/promotions-cache.json`, falling back to the copy bundled with the
package — plus your own `~/.agent-hud/config.json` layered on top. Configured
hours are UTC unless a window sets `timezone`; reported times are always
converted to the local zone. The README documents the fields.

`--endpoint` answers the question for one API rather than for the host in
general: pass the base URL a model is billed on, e.g.
`--endpoint https://api.deepseek.com`, and windows bound to that endpoint are
included. Without it, such windows stay out of the answer. The command reports
that no endpoint was provided instead of silently making that filter look like
an empty schedule.

## Environment

| Variable | Meaning |
| --- | --- |
| `AGENT_HUD_DATA_DIR` | Override local event storage (default `~/.agent-hud`) |
| `AGENT_HUD_CONFIG` | Override the promotional-window config file path |
| `AGENT_HUD_PROMOTIONS_URL` | Override the shared promotional schedule URL |
| `AGENT_HUD_NO_REMOTE` | Set to `1` to never fetch the shared schedule |
| `NO_COLOR` | Disable ANSI styling |

The internal `refresh-health` and `refresh-promotions` commands are reserved for
the background Anthropic Statuspage and shared-schedule refresh processes. They
are not public interactive commands: a status line starts them detached when its
cache is due, so a repaint never waits on the network.
