# Legacy HUD design rationale

This preserves the reasoning embedded in the header and implementation comments
of the authoritative 627-line `~/.claude/statusline-command.sh`. These are
calibration notes and caveats, not a new theme.

The exact reviewed behavior is frozen in
`test/fixtures/legacy-statusline-command.sh` and its responsibility-based
`test/fixtures/legacy-statusline/render-tail.sh` rendering phase; differential
tests do not depend on a mutable home-directory copy.

## The scan model

The HUD is organized for three successive questions:

1. **Session:** What model/effort is active, how expensive/full is context, is
   cache warm, and how much quota remains?
2. **Decision:** What has this session cost, and is compacting actionable now?
3. **Place:** Which project/branch/tree/path am I changing?

Claude's native statusline therefore has at most three lines:

```text
model | effort | context | cache | quota | reset
$cost | exactly one compact advisor
project | branch | churn | cwd
```

The companion can append a fourth activity line, but the native statusline
cannot: adding tools/agents to the three-line hierarchy would change the legacy
scan order.

## Color is warning, brightness is hierarchy

Hue has one meaning only:

- plain: healthy fact;
- yellow: caution;
- red: act now.

Dim and bright-white are structural, not decorative colors. Separators and
location facts are dim; the project name is the bright anchor. Reset clocks are
plain facts. The model is plain except when it carries the Anthropic API-health
warning: minor is yellow, major/critical is red.

This rule is why the break-even advisor stays plain. It is an opportunity, not
an alarm. Coloring non-signals would dilute every real warning.

## Why context has two independent colors

The API is stateless: every turn re-sends the system prompt and history, and the
cached prefix is billed as a cache read. Session re-read work is approximately
the sum of context over turns, so current context `C` times true assistant turns
`N` is a useful action trigger.

The original analysis corrected an older block-counting error: one assistant
message appears on multiple transcript lines (text, thinking and tool-use
blocks). Distinct `msg_…` IDs approximate true assistant rounds. After that
correction, the fitted cache-read model became approximately
`0.8e-6 × C × N`.

The thresholds were calibrated from 39 real sessions:

- context versus turns: `R² ≈ 0.92`;
- cache-read cost versus `C×N`: `R² ≈ 0.73`;
- yellow at 5M (roughly $4 re-read pressure);
- red at 16M (roughly $13).

Context fullness answers a different question: “should I compact now?” It
warns at 70% and turns red at 80%. A cheap but nearly full session must still
warn; an expensive many-turn session can warn before it is full.

The “re-read share” statistic was deliberately rejected as the color signal:
although about two thirds of spend may be prior-context reads, the share stays
too constant to say *when* to act. A “28× deviation / projected remaining”
framing was also rejected because its denominator uses hindsight and labels
necessary stateful re-reading as waste.

The original Opus 4.8 price notes were:

- input $5/MTok;
- cache read $0.5/MTok;
- 5-minute cache write $6.25/MTok;
- 1-hour cache write $10/MTok;
- output $25/MTok.

Those prices explain the calibration but are not fetched dynamically. The
thresholds are inherited UX tokens, not a live billing calculator.

Prompting the model to batch or parallelize reads was A/B tested and showed no
measurable benefit. The reliable savings were structural: `/compact` cuts `C`;
`/clear` resets `N`. A counterfactual context cap around 130k cut simulated
cache-read cost by roughly half.

## Cache findings and caveat

Claude Code used a hybrid 5-minute + 1-hour cache. The volatile tail could sit
on a 5-minute breakpoint while the expensive stable prefix sat on a 1-hour
breakpoint. Across 4,217 sessions on the original machine, cache remained
effective through 5–60 minutes of idle time (rebuild/hit ratio roughly
0.04–0.09×); after 60 minutes the ratio jumped to roughly 19×.

Therefore the HUD:

- inspects recent cache writes;
- uses one hour when any recent write reports `ephemeral_1h`;
- uses five minutes when there is a cache write but no 1-hour evidence;
- falls back to one hour when the transcript cannot decide;
- shows absolute expiry (`*HH:MM`), yellow for the last five minutes, then red
  `*cold`.

The precise division of content between 5-minute and 1-hour breakpoints was
reverse-inferred, not verified from Claude Code source. The UI keeps that
`UNVERIFIED` caveat rather than presenting the heuristic as a protocol promise.

## Compact advisor model

Line two has one advisor slot:

- `→~Nt` forecasts the 80% forced-compact zone from at most six recent
  percentage-changing rows;
- `→full` appears only when a rising segment reaches the zone;
- otherwise `↓~Nt` estimates when compacting now pays for itself.

Forced ETA is hidden above 30 turns, yellow at 6 or fewer, red at 3 or fewer.
A drop of at least three percentage points resets the slope history.

The break-even residual summary `S` is 17k tokens, based on a measured median
of 17,148 tokens over 272 in-session resets. With context `C`:

```text
one-time cost       ≈ 0.5C + 31.25S
per-turn saving     ≈ 0.5(C-S)
break-even turns N  = (C + 62.5S) / (C-S)
```

Below about `2S`, compacting does not pay back. Horizons above 15 turns are
hidden as noise. Forced advice always wins over break-even.

## Quota and responsive behavior

Quota color is the worse of absolute usage and projected pace:

- usage: 60% yellow, 85% red;
- pace: projected 120% at reset yellow, 200% red;
- ignore pace during the first 10% of a window and below 8% usage;
- only the highest-used binding window drives pace; 5h wins an exact tie.

Both reset clocks remain visible independently of whether usage is present.
The 7-day reset gains a weekday when it is not today.

For phone/tmux panes:

- strip any trailing model parenthetical;
- hide line two as a unit below 60 columns;
- make cwd home-relative;
- left-ellipsize cwd to `columns - 22`, minimum 14, or 36 when width is unknown;
- use only basic dim, bright-white, yellow and red SGR codes.

## Intent-preserving TypeScript corrections

The provider excludes explicit `isSidechain: true` records from main-session
turn pressure. The shell's grep could not express that distinction, but its
comments define turns as this session's assistant rounds rather than subagent
traffic. This is an intentional correction to match the stated model, and is
tested/documented as such rather than claimed as byte-for-byte shell behavior.

The TypeScript provider also caches transcript scan state and resumes at the
previous newline-terminated EOF after an append. The shell
streamed with bounded memory; repeatedly slurping a large JSONL into Node every
five seconds would violate the same low-overhead intent.
