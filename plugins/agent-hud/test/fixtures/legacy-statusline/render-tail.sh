# Context fullness forecast → forced-compact ETA (line 2 compact advisor).
etatok=""
if [ -n "$used_pct" ] && [ -n "$session_id" ]; then
  cdir="$HOME/.claude/context-log"; cf="$cdir/$session_id.tsv"
  [ -d "$cdir" ] || mkdir -p "$cdir" 2>/dev/null
  clast=$(awk 'END{print $2}' "$cf" 2>/dev/null)
  if [ "$clast" != "$used_pct" ]; then
    if [ -n "$clast" ] && [ "$(( $(floor "$clast") - $(floor "$used_pct") ))" -ge 3 ]; then
      : > "$cf"
    fi
    printf '%s\t%s\t%s\n' "$(date +%s)" "$used_pct" "$turns" >> "$cf" 2>/dev/null
  fi

  eta=$(awk -v full="$CTX_FULL" '
    {p[NR]=$2+0; t[NR]=$3+0}
    END{
      n=NR; if(n<2) exit;
      s=n-5; if(s<1)s=1;
      dp=p[n]-p[s]; dt=t[n]-t[s];
      if(dt<=0||dp<=0) exit;
      if(p[n]>=full){ print 0; exit }
      rem=(full-p[n])/(dp/dt);
      r=int(rem+0.5); if(r<1)r=1;
      print r
    }' "$cf" 2>/dev/null)

  if [ -n "$eta" ]; then
    if   [ "$eta" -le 0 ]; then etatok="${RED}→full${RESET}"
    elif [ "$eta" -le 3 ]; then etatok="${RED}→~${eta}t${RESET}"
    elif [ "$eta" -le 6 ]; then etatok="${YELLOW}→~${eta}t${RESET}"
    elif [ "$eta" -le "$ETA_MAX" ]; then etatok="→~${eta}t"; fi
  fi
fi

# Compact break-even (↓~Nt, line 2).
betok=""
if [ -n "$total_input" ] && [ "$total_input" -gt "$(( SUMMARY_TOK * 2 ))" ]; then
  _num=$(( 2 * total_input + 125 * SUMMARY_TOK ))
  _den=$(( 2 * (total_input - SUMMARY_TOK) ))
  _be=$(( (_num + _den / 2) / _den ))
  [ "$_be" -lt 1 ] && _be=1
  [ "$_be" -le "$BE_MAX" ] && betok="↓~${_be}t"
fi

# Quota severity combines absolute usage with projected pace to reset.
quota_parts=(); five_floor=""; week_floor=""
if [ -n "$five_pct" ]; then five_floor=$(floor "$five_pct"); quota_parts+=("${five_floor}%"); fi
if [ -n "$week_pct" ]; then week_floor=$(floor "$week_pct"); quota_parts+=("${week_floor}%"); fi
qmax=0; qwin=""
if [ -n "$five_floor" ] && [ "$five_floor" -ge "$qmax" ]; then qmax=$five_floor; qwin="5h"; fi
if [ -n "$week_floor" ] && [ "$week_floor" -gt "$qmax" ]; then qmax=$week_floor; qwin="7d"; fi

case "$qwin" in
  7d) reset_epoch="$week_reset";;
  5h) reset_epoch="$five_reset";;
  *)  reset_epoch="${five_reset:-$week_reset}";;
esac

if [ ${#quota_parts[@]} -gt 0 ]; then
  quota_str="#$(IFS=/; printf '%s' "${quota_parts[*]}")"
  sev_name=$(ramp "$qmax" 60 85)
  case "$sev_name" in red) sev=2;; yellow) sev=1;; *) sev=0;; esac
  if [ "$qmax" -ge 8 ] && [ -n "$reset_epoch" ]; then
    case "$qwin" in 7d) wlen=604800;; *) wlen=18000;; esac
    trem=$(( reset_epoch - now )); [ "$trem" -lt 1 ] && trem=1
    [ "$trem" -gt "$wlen" ] && trem="$wlen"
    elapsed=$(( wlen - trem ))
    if [ "$elapsed" -ge "$(( wlen / 10 ))" ]; then
      projected=$(( qmax * wlen / elapsed ))
      pace_sev=$(ramp "$projected" 120 200)
      if   [ "$pace_sev" = red ] && [ "$sev" -lt 2 ]; then sev=2
      elif [ "$pace_sev" = yellow ] && [ "$sev" -lt 1 ]; then sev=1; fi
    fi
  fi
  qsev=$(ramp "$sev" 1 2); qcolor="${!qsev}"
  line1+=("${qcolor}${quota_str}${RESET}")
fi

# Reset clocks stay factual and follow the same 5h/7d order as quota.
reset_parts=()
if [ -n "$five_reset" ]; then rt=$(fmt_time "$five_reset"); [ -n "$rt" ] && reset_parts+=("$rt"); fi
if [ -n "$week_reset" ]; then rt=$(fmt_reset "$week_reset"); [ -n "$rt" ] && reset_parts+=("$rt"); fi
if [ ${#reset_parts[@]} -gt 0 ]; then
  line1+=("↻$(IFS=/; printf '%s' "${reset_parts[*]}")")
fi

# Line 3: place — dir | branch | cwd.
cols=${COLUMNS:-0}; to_int cols
if [ "$cols" -gt 0 ]; then cwd_max=$(( cols - 22 )); [ "$cwd_max" -lt 14 ] && cwd_max=14; else cwd_max=36; fi
narrow=0; [ "$cols" -gt 0 ] && [ "$cols" -lt 60 ] && narrow=1

disp_cwd="$cwd"
if [ "$disp_cwd" = "$HOME" ]; then
  disp_cwd="~"
elif [ -n "$HOME" ] && [ "${disp_cwd#"$HOME"/}" != "$disp_cwd" ]; then
  disp_cwd="~/${disp_cwd#"$HOME"/}"
fi
if [ "${#disp_cwd}" -gt "$cwd_max" ]; then
  disp_cwd="…${disp_cwd: -$(( cwd_max - 1 ))}"
fi

churn=""
la=$(floor "$lines_add"); ld=$(floor "$lines_del")
[ "$la" -gt 0 ] || [ "$ld" -gt 0 ] && churn="+${la}/-${ld}"

line3=()
[ -n "$dir_name" ] && line3+=("${BWHITE}${dir_name}${RESET}")
[ -n "$branch" ] && line3+=("${DIM} ${branch}${gitextra}${RESET}")
[ -n "$churn" ] && line3+=("${DIM}${churn}${RESET}")
[ -n "$disp_cwd" ] && line3+=("${DIM}${disp_cwd}${RESET}")

sep="${DIM} | ${RESET}"
join() {
  local out="" p
  for p in "$@"; do
    if [ -z "$out" ]; then out="$p"; else out="${out}${sep}${p}"; fi
  done
  printf '%s' "$out"
}
printf '%s\n' "$(join "${line1[@]}")"
line2=()
[ -n "$costtok" ] && line2+=("$costtok")
if   [ -n "$etatok" ]; then line2+=("$etatok")
elif [ -n "$betok" ];  then line2+=("$betok")
fi
[ "$narrow" -eq 0 ] && [ ${#line2[@]} -gt 0 ] && printf '%s\n' "$(join "${line2[@]}")"
printf '%s\n' "$(join "${line3[@]}")"
