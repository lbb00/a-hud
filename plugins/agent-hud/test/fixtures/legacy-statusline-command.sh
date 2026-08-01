#!/usr/bin/env bash
# Claude Code statusLine command (up to three lines)
#   Line 1 (Claude): model | effort | ctx-box | cache | quota | reset
#   Line 2 (trend):  $spend | <compact advisor>
#                    compact advisor = ONE token, mutually exclusive: →~Nt while
#                    context is filling (turns until FORCED compact, colored), else
#                    ↓~Nt (turns until a voluntary compact PAYS FOR ITSELF, plain).
#                    whole line HIDDEN on narrow phone windows (cols < 60);
#                    $ and ctx% are still logged for charts.
#   Line 3 (place):  dir | branch [+add/-del] | cwd
#
# ── Icon legend (what every marker on the bar means) ─────────────────────────
#   Glyphs are kept single-width and render-safe for tmux + Terminus on phone;
#   meaning comes from this legend, color comes from the scheme below. Markers:
#     L/M/H/XH/MAX  effort (reasoning) level        ↻HH:MM  quota window resets at
#     96k           context tokens in use           *HH:MM  prefix cache warm until (~1h TTL)
#     /10%          context-window fullness          *cold  cache cold (>1h idle → prefix re-read)
#     16t           turns (assistant rounds) so far  #a%/b%  quota usage: a = 5h, b = 7d window
#     $1.23         session cost so far              →~Nt    turns until FORCED compact (colored)
#     name          project dir (bright = anchor)    →full   already in the auto-compact zone
#     @abc123       detached HEAD (short SHA)         ↓~Nt    turns until a /compact PAYS OFF (plain)
#     main*         dirty working tree (uncommitted)  " | "  dim separator (punctuation, not data)
#     +N/-N         lines added/removed this session  ↑N/↓N  commits ahead / behind upstream
#                                                      model  colored = Anthropic API incident
#                                                              (yellow minor · red major/critical)
#   Shared units:  ~ ≈ "about"   ·   t = turns   ·   k = ×1000 tokens   ·   % = of window
#
# ── Design / color scheme ────────────────────────────────────────────────────
# Guiding rule: COLOR ENCODES WARNING LEVEL, NOTHING ELSE. No decorative palette.
# If something has color, it wants your attention; if it's plain, it's fine.
#
#   • Two-line split by BRIGHTNESS, not hue:
#       Line 1 (Claude/session state) = default (bright) foreground.
#       Line 2 (where you are)        = DIM, except the project name (bright
#                                       white) as the anchor you scan to.
#     The eye separates the lines by light/dark alone, so line 2 never competes.
#
#   • Pure facts stay plain white — ↻HH:MM (reset) is never colored; coloring a
#     non-signal would dilute the warning meaning. The model name is plain too,
#     with ONE exception: it carries the API-health signal (yellow/red) when
#     Anthropic reports an incident — "Claude is unwell" tinting Claude's own name.
#
#   • Fields light up on the same ramp: plain (fine) → YELLOW (caution) → RED
#     (act now). Two independent concerns get color: COST and CONTEXT-FULLNESS.
#       - ctx-box token (e.g. 168k): color = C·N re-read pressure (cost model below).
#                   plain <5M · yellow ≥5M (≈$4) · red ≥16M (≈$13).
#       - ctx-box %    (e.g. /78%) : color = CONTEXT FULLNESS — the "should I
#                   /compact?" signal. plain <CTX_WARN · yellow ≥CTX_WARN · red
#                   ≥CTX_FULL (auto-compact zone). Independent of the $ ramp.
#       - compact advisor (line 2, ONE slot): →~Nt = turns left until CTX_FULL at
#                   the recent fill rate (plain · yellow ≤6t · red ≤3t / →full in
#                   the zone). When context ISN'T filling, the slot instead shows
#                   ↓~Nt = turns until a voluntary /compact recoups its own cost —
#                   always PLAIN (an opportunity hint, not a warning). Forced wins.
#       - cost    : color = client-estimated session $ (cost.total_cost_usd).
#                   plain <$4 · yellow ≥$4 · red ≥$13 (mirrors the C·N $ ramp).
#       - quota   : color = MAX of two concerns — absolute usage (plain <60% ·
#                   yellow ≥60% · red ≥85%) AND pace: if the binding window's
#                   current burn rate is projected to hit 100% BEFORE it resets,
#                   escalate (yellow if it overshoots, red if it'd exhaust by
#                   mid-window). So a modest % that's burning too fast still lights.
#       - effort  : plain low/medium · yellow high · red xhigh/max.
#     So at a glance: all-white = nothing to do; any color = look there.
#
#   • Separator " | " is dim; it's punctuation, not content.
#
# ── Mobile / tmux (Terminus on phone) ────────────────────────────────────────
# Phone panes are narrow, so the bar must not wrap into a mess:
#   • Model name drops its " (… context)" suffix — redundant with the ctx-box
#     and the single biggest width hog on line 1.
#   • cwd is left-ellipsised to a width budget (COLUMNS if exported, else 36),
#     so a deep path shows its useful tail instead of wrapping the pane.
#   • Only plain ANSI SGR codes (dim / bright-white / yellow / red) are used —
#     all pass through tmux unchanged and render on Terminus.
#
# ── Implementation helpers ──────────────────────────────────────────────────
# BSD/GNU differences are centralized: fmt_time wraps date -r/date -d and
# mtime_of wraps stat -f/stat -c. to_int cleans integer variables in place, and
# ramp returns plain/yellow/red severity names so every warning color keeps the
# same plain → yellow → red meaning.
#
# ── Why this exists (cost model + findings; no separate report) ──────────────
# The API is STATELESS: every turn re-sends system + full history, and the cached
# prefix is billed as cache_read EVERY turn. So a session's cost ≈ Σ(context per
# turn) ≈ context × turns, and grows ~quadratically as the session lengthens.
# Opus 4.8 prices (per MTok): input $5, cache_read $0.5 (0.1×), cache_write 5m
# $6.25 (1.25×) / 1h $10 (2×), output $25 (5×). No long-context premium (full 1M
# at standard price).
#
# COLOR = C·N (current_context_tokens × turns) — the ctx-box's color. "turns" here
#   is true assistant rounds (distinct msg_ ids), NOT the old content-block grep
#   count, which ran ~2× high; the regression below was fit on that inflated count,
#   so its constant is rescaled (~0.4e-6 → ~0.8e-6) and the thresholds halved to
#   keep the SAME $ trigger points on the corrected, ~½-as-large N.
#   Validated by regression on 39 real sessions: context~turns is linear
#   (R²=0.92); session cache_read cost ≈ 0.8e-6·C·N (R²=0.73). Thresholds:
#   plain <5M  ·  yellow ≥5M (≈$4 re-read)  ·  red ≥16M (≈$13 re-read).
#   C·N is a TRIGGER (rises as the session gets expensive → act). It catches both
#   "context too big" AND "context modest but turns very frequent".
#   Remedies: /compact cuts C (the per-turn re-read) · /clear cuts N (resets it).
#   The cost field ($) is the direct companion: C·N can underweight output-heavy
#   sessions, so the client's own $ estimate catches what the proxy misses.
#
# Deliberately NOT used as the color:
#   - "re-read share" (~67% of spend is re-reading prior context) — the honest
#     diagnostic of where the money goes, but it's ~constant across sessions, so
#     it can't tell you WHEN to act. Diagnostic, not a trigger; left out.
#   - "28× deviation / projected-remaining" framing — rejected in adversarial
#     review: its denominator (final context fed once) is a hindsight oracle and
#     it mislabels necessary stateful re-read as "waste".
#
# Empirical caveat: prompting the model to batch/parallelize reads was A/B-tested
# on Opus 4.8 (headless) and had NO measurable effect — the reliable savings are
# STRUCTURAL (compact/clear), not prompt-nudging tool-call style. Capping context
# at ~130k in a counterfactual sim cut cache_read cost ~50%.

input=$(cat)

fmt_time() {
  date -r "$1" "+%H:%M" 2>/dev/null || date -d "@$1" "+%H:%M" 2>/dev/null
}

# Like fmt_time but for a reset that can be DAYS out (the 7d quota window resets
# weekly). A bare "%H:%M" on a reset two days away reads as a stale "still 19:00";
# prefix the weekday when it's not today so "↻Fri19:00" is unambiguous.
fmt_reset() {
  local hm day today
  hm=$(date -r "$1" "+%H:%M" 2>/dev/null || date -d "@$1" "+%H:%M" 2>/dev/null)
  [ -n "$hm" ] || return 1
  day=$(date -r "$1" "+%Y%m%d" 2>/dev/null || date -d "@$1" "+%Y%m%d" 2>/dev/null)
  today=$(date "+%Y%m%d")
  if [ -n "$day" ] && [ "$day" != "$today" ]; then
    local wd
    wd=$(date -r "$1" "+%a" 2>/dev/null || date -d "@$1" "+%a" 2>/dev/null)
    printf '%s%s' "$wd" "$hm"
  else
    printf '%s' "$hm"
  fi
}

mtime_of() {
  local m raw
  m=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null)
  raw="$m"
  [ -n "$m" ] || return 1
  to_int m
  [ "$m" = "$raw" ] || return 1
  printf '%s' "$m"
}

to_int() {
  local name="$1" val
  val="${!name}"
  if [ -z "$val" ] || [ "${val##*[!0-9]*}" != "$val" ]; then
    printf -v "$name" '%s' 0
  fi
}

# ── Extract everything in ONE jq pass (raw numbers preserved) ────────────────
# Fields are joined with US (\x1f), a non-whitespace control char: it can't
# appear in a path and, unlike tab, an empty leading/middle field is NOT eaten
# by `read` (whitespace IFS would collapse empties and shift every column).
IFS=$'\x1f' read -r cwd used_pct total_input ctx_size transcript model effort \
  five_pct five_reset week_pct week_reset cost session_id lines_add lines_del < <(printf '%s' "$input" | jq -r '
  [ (.workspace.current_dir // .cwd // ""),
    (.context_window.used_percentage // ""),
    (.context_window.total_input_tokens // ""),
    (.context_window.context_window_size // ""),
    (.transcript_path // ""),
    (.model.display_name // ""),
    ((( .effort // .model.effort // .reasoning_effort // .output_style.effort )
        | if type=="object" then (.level // .effort) else . end) // ""),
    (.rate_limits.five_hour.used_percentage // ""),
    (.rate_limits.five_hour.resets_at // ""),
    (.rate_limits.seven_day.used_percentage // ""),
    (.rate_limits.seven_day.resets_at // ""),
    (.cost.total_cost_usd // ""),
    (.session_id // ""),
    (.cost.total_lines_added // ""),
    (.cost.total_lines_removed // "")
  ] | map(tostring) | join("")')

# Effort fallback — input may omit it; read the first existing settings file once.
# (Only a fallback: the live input value, when present, always wins above.)
if [ -z "$effort" ]; then
  for sf in "$cwd/.claude/settings.local.json" "$cwd/.claude/settings.json" \
            "$HOME/.claude/settings.local.json" "$HOME/.claude/settings.json"; do
    [ -f "$sf" ] || continue
    effort=$(jq -r '(.effortLevel | if type=="object" then (.level // "") else . end) // ""' "$sf" 2>/dev/null)
    [ -n "$effort" ] && [ "$effort" != "null" ] && break || effort=""
  done
fi

# Project name only when cwd is real (avoid basename "" → ".").
dir_name=""
[ -n "$cwd" ] && dir_name=$(basename "$cwd")

# Branch (or short SHA for detached HEAD, prefixed @ so it can't be mistaken
# for a branch name in the cramped bar), plus working-tree state appended as a
# dim suffix: "*" = uncommitted changes · "↑N" = commits ahead of upstream ·
# "↓N" = behind. So "main*↑2" reads "main, dirty, 2 ahead". All git convention.
branch=""; gitextra=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  branch=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null)
  detached=0
  if [ -z "$branch" ]; then
    sha=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
    [ -n "$sha" ] && { branch="@$sha"; detached=1; }
  fi
  if [ -n "$branch" ]; then
    # Dirty? Any porcelain output (staged, unstaged, or untracked) → trailing "*".
    [ -n "$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" status --porcelain 2>/dev/null | head -1)" ] && gitextra="*"
    # Ahead/behind upstream — only on a real branch that has one. --left-right
    # --count over @{u}...HEAD yields "<behind><TAB><ahead>".
    if [ "$detached" -eq 0 ]; then
      ab=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)
      if [ -n "$ab" ]; then
        read -r be_n ah_n <<<"$ab"
        to_int ah_n
        to_int be_n
        [ "$ah_n" -gt 0 ] && gitextra="${gitextra}↑${ah_n}"
        [ "$be_n" -gt 0 ] && gitextra="${gitextra}↓${be_n}"
      fi
    fi
  fi
fi

# Prompt-cache TTL — the idle window before the EXPENSIVE prefix re-read. Claude
# Code uses a HYBRID 5m+1h cache: the volatile last few turns sit on a 5-minute
# breakpoint, but the big stable prefix (system prompt + tool schemas + early
# conversation) sits on a 1-HOUR breakpoint. The cost that matters — re-reading
# that whole prefix — only happens past ~1h idle, not 5m. Validated empirically on
# this machine: across 4217 sessions, cache stays hit through 5–60min idle
# (rebuild/hit ratio 0.04–0.09×); only >60min collapses (19×, prefix fully rebuilt).
# So the old "5-minute TTL" worry is obsolete. (UNVERIFIED: exactly which content
# CC tags 5m vs 1h — reverse-inferred from cache_creation's ephemeral_1h split,
# not CC source — but that 1h cache survives well past 5min is hard data.)
CACHE_TTL=3600    # FALLBACK warm window (s) when the transcript can't tell us the
                  # real per-session TTL below; CC's prefix is usually on the 1h
                  # breakpoint, so default to 1h, not 5m.
CACHE_WARN=300    # turn the expiry time yellow within this many seconds of the cliff

# Turn count for THIS session = number of assistant API responses. ONE assistant
# message is written across MANY transcript lines (one per content block: text,
# tool_use, thinking), each tagged "type":"assistant" and sharing the SAME
# "id":"msg_…". So `grep -c '"type":"assistant"'` counts content blocks, not turns —
# it over-counts ~2× (tool-heavy turns have more blocks), which also inflated C·N
# below. Count DISTINCT msg_ ids instead (grep the id, dedup): the msg_ prefix can't
# collide with tool_use (toolu_) or session uuids. ~7ms over a 5MB transcript.
turns=0
cache_left=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  turns=$(grep -oE '"id": ?"msg_[A-Za-z0-9_]+"' "$transcript" 2>/dev/null | sort -u | wc -l | tr -d ' ')
  to_int turns

  # Detect THIS session's REAL cache TTL instead of assuming. CC tags cache
  # breakpoints per request; which one holds the big prefix decides the warm
  # window. If ANY recent cache WRITE landed on the 1h breakpoint (ephemeral_1h),
  # the stable prefix is on 1h and stays warm ~1h — even when later turns only
  # touch the 5m breakpoint, so keying off the LAST write alone under-reports and
  # would flash *cold early. Per-session it varies; empty / no-1h / no-jq → fall
  # back to CACHE_TTL. This stays separate from the main stdin jq pass because it
  # depends on transcript_path extracted from that pass and only needs the recent
  # transcript tail; merging would require slurping unrelated transcript data into
  # the hot statusline path before we know whether it exists.
  ttl=$CACHE_TTL
  sess_ttl=$(tail -n 600 "$transcript" 2>/dev/null | jq -rs '
    [ .[] | (.message.usage // empty)
      | select((.cache_creation_input_tokens // 0) > 0)
      | (.cache_creation.ephemeral_1h_input_tokens // 0) ]
    | if length == 0 then empty
      elif (max > 0) then "3600" else "300" end' 2>/dev/null)
  case "$sess_ttl" in 300|3600) ttl=$sess_ttl;; esac

  # The transcript is written every turn, so its mtime ≈ the last API call ≈ when
  # the cache was last refreshed. remaining = ttl − idle.
  mtime=$(mtime_of "$transcript")
  [ -n "$mtime" ] && cache_left=$(( ttl - ($(date +%s) - mtime) ))
fi

# ── Colors as REAL escape bytes (so user data can be emitted with %s, never %b:
#    a branch/path containing a backslash stays literal — no escape injection) ─
RESET=$'\033[0m'; DIM=$'\033[2m'; BWHITE=$'\033[97m'
YELLOW=$'\033[33m'; RED=$'\033[31m'
plain=""; yellow="$YELLOW"; red="$RED"

ramp() {
  local v="$1" y="$2" r="$3"
  to_int v; to_int y; to_int r
  if [ "$v" -ge "$r" ]; then
    printf '%s' red
  elif [ "$v" -ge "$y" ]; then
    printf '%s' yellow
  else
    printf '%s' plain
  fi
}

# floor(positive number) via string truncation — no rounding, no fork.
floor() { local v="${1%%.*}"; to_int v; printf '%s\n' "$v"; }

# Context-fullness thresholds, in used_percentage points. Claude Code triggers
# auto-compact somewhere around 77–80% by community reports — Anthropic doesn't
# publish the exact figure (UNVERIFIED), so we warn a little early. Tune here.
CTX_WARN=70   # yellow: filling up
CTX_FULL=80   # red: in the auto-compact zone — /compact or /clear now
ETA_MAX=30    # hide the compact ETA when it's farther out than this many turns —
              # at 816t it's noise, not a signal; only show it once it's near.
SUMMARY_TOK=17000  # tokens a /compact (or /clear) leaves behind — the residual prefix
                   # re-read every turn afterward. MEASURED on this machine: median
                   # 17,148 over 272 in-session context resets. Drives break-even below.
BE_MAX=15          # only surface the compact break-even when it's this near — a far
                   # horizon means the context is too small for /compact to pay off.
                   # (≈94k+ context; a typical 96–124k session lands ~11–15t.)

# ── Anthropic API health — colors the MODEL name ─────────────────────────────
# When Anthropic reports an incident, tint the model name itself (minor → yellow,
# major/critical → red) instead of adding a separate marker. "Claude is unwell"
# reads most naturally on Claude's own name and costs no width; healthy (none)
# leaves it plain. Source: Statuspage status.json, cached in a SHARED file so each
# render shows the last verdict INSTANTLY (never blocks on the network). When the
# cache is older than STATUS_TTL, the render fires a detached background curl to
# refresh it — no lock: at worst a few terminals refresh at once on expiry, which
# is harmless at ~once / 5 min. Concurrent writers stay safe via a per-PID temp
# file (atomic mv). (now is computed here once and reused by the quota pace.)
now=$(date +%s)
STATUS_TTL=300
sdir="$HOME/.claude/status-cache"; statusf="$sdir/anthropic"
[ -d "$sdir" ] || mkdir -p "$sdir" 2>/dev/null
indicator=""
[ -f "$statusf" ] && indicator=$(cat "$statusf" 2>/dev/null)
smtime=$(mtime_of "$statusf")
to_int smtime
if [ "$(( now - smtime ))" -ge "$STATUS_TTL" ]; then
  ( tmp="$statusf.$$.tmp"
    curl -fsSL --max-time 4 https://status.claude.com/api/v2/status.json 2>/dev/null \
      | jq -r '.status.indicator // empty' > "$tmp" 2>/dev/null
    if [ -s "$tmp" ]; then mv -f "$tmp" "$statusf"; else rm -f "$tmp"; fi
  ) </dev/null >/dev/null 2>&1 &
fi
mcolor=""
case "$indicator" in
  minor)          mcolor="$YELLOW";;
  major|critical) mcolor="$RED";;
esac

# ── Line 1: Claude — model | effort | ctx-box | cache | quota | reset ─────────
line1=()

# Model — a static fact (plain), EXCEPT it carries the API-health color: an
# Anthropic incident tints the name yellow/red (see mcolor above). Strip the
# " (… context)" suffix to save width.
if [ -n "$model" ]; then
  model_disp="${model% (*)}"
  line1+=("${mcolor}${model_disp}${RESET}")
fi

# Effort — escalates with per-turn cost: plain low/medium · yellow high · red xhigh/max.
#   Abbreviated to save width on phone panes: low→L medium→M high→H xhigh→XH max→MAX.
if [ -n "$effort" ]; then
  ecolor=""; eshort="$effort"; esev=0
  case "$effort" in
    low)    eshort="L";;
    medium) eshort="M";;
    high)   eshort="H"; esev=1;;
    xhigh)  eshort="XH"; esev=2;;
    max)    eshort="MAX"; esev=2;;
  esac
  esev_name=$(ramp "$esev" 1 2); ecolor="${!esev_name}"
  line1+=("${ecolor}${eshort}${RESET}")
fi

# Context × turns box — color = C·N, the cumulative context-RE-READ pressure (the
# thing /compact actually relieves), NOT total session $ (which also carries output
# and tool/web costs that /compact can't touch). Thresholds HALVED vs the original
# regression because turns is now true assistant rounds, ~½ the old content-block
# count (so the cache_read$ ≈ C·N constant ≈ doubles to ~0.8e-6): plain <5M / yellow
# ≥5M (≈$4 re-read) / red ≥16M (≈$13 re-read).
if [ -n "$total_input" ] && [ -n "$ctx_size" ] && [ "$ctx_size" != "0" ]; then
  cn=$(( total_input * turns ))           # C·N ; session cache_read cost ≈ 0.8e-6·C·N
  cn_sev=$(ramp "$cn" 5000000 16000000); cl="${!cn_sev}"  # plain / ≈$4 / ≈$13 re-read
  if [ "$total_input" -ge 1000 ]; then
    tok_display="$(( total_input / 1000 ))k"
  else
    tok_display="$total_input"
  fi
  # The % is colored by CONTEXT FULLNESS (not cost): plain · yellow ≥CTX_WARN ·
  # red ≥CTX_FULL (auto-compact zone). This is the at-a-glance "/compact?" signal,
  # so it carries its OWN color independent of the token's C·N cost color (cl).
  pct=""
  if [ -n "$used_pct" ]; then
    upf=$(floor "$used_pct"); pct_sev=$(ramp "$upf" "$CTX_WARN" "$CTX_FULL"); pctcl="${!pct_sev}"
    pct="${RESET}${pctcl}/${upf}%${RESET}${cl}"   # restore cl for the t-count tail
  fi
  # turns-so-far as a "t"-SUFFIX (261t), matching the compact ETA's "t" unit
  # (→~5t) so both read as "turns"; the → marks the forecast vs. this running total.
  tdisp=""; [ "$turns" -gt 0 ] && tdisp=" ${turns}t"
  # No "ctx" label — "47k/5% 26t" reads clearly on its own and saves width.
  line1+=("${cl}${tok_display}${pct}${tdisp}${RESET}")
fi

# Prompt-cache freshness — the ABSOLUTE wall-clock time the prefix cache goes cold
# (mtime + ttl, ttl detected per-session above), not a countdown. Claude Code doesn't redraw the bar while
# idle, so a relative "cache 9m" freezes the moment you walk away — exactly when it
# matters. An absolute "*19:04" stays correct even frozen: glance, compare to the
# clock, done. warm plain · within CACHE_WARN of the cliff yellow · past it red
# "cold". Low-stakes now (the 1h cliff wastes ~0.25% of spend and heartbeat-warming
# it costs more than the rebuild) — kept as a heads-up before a long walk-away.
if [ -n "$cache_left" ]; then
  if [ "$cache_left" -le 0 ]; then
    line1+=("${RED}*cold${RESET}")
  else
    exp_epoch=$(( mtime + ttl ))
    exp_time=$(fmt_time "$exp_epoch")
    if [ "$cache_left" -le "$CACHE_WARN" ]; then
      line1+=("${YELLOW}*${exp_time}${RESET}")
    else
      line1+=("*${exp_time}")
    fi
  fi
fi

# Cost — client-estimated session spend (same $ ramp as the C·N box). Display is
# moved to its OWN line (line 2), but the per-session TSV is logged here on every
# change regardless of display, so ~/.claude/cost-chart.sh always has the data
# even on a phone or under tmux where line 2 is hidden. The session $ is
# monotonic, so logging only on change keeps the file tiny.
costtok=""
if [ -n "$cost" ] && [ "$cost" != "0" ]; then
  if [ -n "$session_id" ]; then
    logdir="$HOME/.claude/cost-log"; logf="$logdir/$session_id.tsv"
    [ -d "$logdir" ] || mkdir -p "$logdir" 2>/dev/null
    last=$(awk 'END{print $2}' "$logf" 2>/dev/null)
    if [ "$last" != "$cost" ]; then
      printf '%s\t%s\n' "$(date +%s)" "$cost" >> "$logf" 2>/dev/null
    fi
  fi

  cost_floor=$(floor "$cost")
  cost_sev=$(ramp "$cost_floor" 4 13); costcl="${!cost_sev}"
  cost_display=$(printf '$%.2f' "$cost" 2>/dev/null || printf '$%s' "$cost")
  costtok="${costcl}${cost_display}${RESET}"
  # The cumulative spend curve lives in ~/.claude/cost-chart.sh (fed by the TSV
  # logged above). The old inline spend-rate bar was dropped as low-signal.
fi

# Keep the frozen shell provider executable while grouping its final rendering
# phase separately. BASH_SOURCE is stable whether the fixture is run directly
# or through a symlinked workspace.
fixture_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$fixture_dir/legacy-statusline/render-tail.sh"
