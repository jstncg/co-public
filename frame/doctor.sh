#!/bin/bash
# frame doctor — the whole rail's health on one screen, with honest probes (curl with real budgets,
# never lsof: the 7/29 false alarm was lsof lying while every service was up).
G="\033[32m✓\033[0m"; R="\033[31m✗\033[0m"; Y="\033[33m~\033[0m"
p() { printf "  %b %-22s %s\n" "$1" "$2" "$3"; }
# .env lives next to this script — resolve it absolutely so doctor tells the truth from any cwd
# (run from the repo root it used to read a nonexistent ./.env and cry "webhook auth OPEN")
ENV="$(cd "$(dirname "$0")" && pwd)/.env"
echo "frame doctor — $(date '+%a %H:%M')"
s=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8099/health); [ "$s" = 200 ] && p "$G" "router :8099" "up" || p "$R" "router :8099" "http $s"
s=$(curl -s --max-time 25 -o /dev/null -w "%{http_code}" -X POST http://localhost:8090/v1/chat/completions -H 'content-type: application/json' -d '{"model":"co","messages":[{"role":"user","content":"ping"}],"user":"doctor"}'); [ "$s" = 200 ] && p "$G" "engine :8090" "up (full model call)" || p "$R" "engine :8090" "http $s"
s=$(curl -s --max-time 6 -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3010/api/ingest/transport -H 'content-type: application/json' -d '{}'); [ "$s" = 401 ] && p "$G" "receiver :3010" "up (fail-closed)" || p "$R" "receiver :3010" "http $s (expected 401)"
CI=/Users/main/Projects/Secretary/Secretary-Production/projects/co-ingest
grep -q "supabase.co" $CI/apps/web/.env.local 2>/dev/null && p "$G" "mirror target" "cloud" || p "$Y" "mirror target" "LOCAL (dev stack)"
sp=$(wc -l < ~/.co/co_dualwrite_spool.jsonl 2>/dev/null | tr -d ' '); [ "${sp:-0}" -eq 0 ] && p "$G" "dual-write spool" "empty" || p "$Y" "dual-write spool" "$sp queued"
H=$(date +%H)
# the tick's cron window is 08-22; outside it, silence is correct — alarming nightly is the
# lsof-false-alarm class of bug (a green board must mean something).
TICK_MAX=20; [ "$H" -ge 23 ] || [ "$H" -lt 8 ] && TICK_MAX=600
for j in "proactive_tick.log $TICK_MAX" "weave.log 1500" "scout.log 1500" "ingest_sweep.log 1500"; do set -- $j
  if [ -f ~/.co/$1 ]; then age=$(( ($(date +%s) - $(stat -f %m ~/.co/$1)) / 60 )); [ $age -le $2 ] && p "$G" "${1%.log}" "ran ${age}m ago" || p "$R" "${1%.log}" "STALE: ${age}m (max $2)"
  else p "$R" "${1%.log}" "no log"; fi
done
tok=$(grep -c "^WEBHOOK_TOKEN=" "$ENV" 2>/dev/null || echo 0); en=$(curl -s --max-time 4 -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8099/ -d '{}'); if [ "${tok:-0}" -ge 1 ] && [ "$en" = 404 ]; then p "$G" "webhook auth" "ENFORCED"; elif [ "${tok:-0}" -ge 1 ]; then p "$Y" "webhook auth" "staged, not enforced (restart router after Sendblue paste)"; else p "$R" "webhook auth" "OPEN"; fi
PUB=$(grep "^WEBHOOK_PUBLIC_URL=" "$ENV" 2>/dev/null | cut -d= -f2)
if [ -n "$PUB" ]; then
  # 8/1: this Mac's own resolver can lose *.ts.net (tailscaled MagicDNS hiccup) while the funnel
  # is perfectly healthy for the internet — a false RED is as bad as a false GREEN. Probe with the
  # PUBLIC resolver's answer, exactly as Sendblue would reach us.
  HOSTN=$(echo "$PUB" | sed -E 's#https?://##; s#/.*##')
  IP=$(dig +short "$HOSTN" A @1.1.1.1 2>/dev/null | head -1)
  if [ -n "$IP" ]; then
    s=$(curl -s --max-time 10 --resolve "$HOSTN:443:$IP" -o /dev/null -w "%{http_code}" "$PUB/health")
  else
    s=$(curl -s --max-time 8 -o /dev/null -w "%{http_code}" "$PUB/health")
  fi
  [ "$s" = 200 ] && p "$G" "public tunnel" "up ($PUB)" || p "$R" "public tunnel" "DEAD ($s) — inbound texts are NOT arriving"
fi
[ -f ~/.co/tunnel-rotated.flag ] && p "$R" "tunnel hostname" "ROTATED — update Sendblue dashboard, then rm ~/.co/tunnel-rotated.flag"
B=$(ls -t ~/Backups/donna/donna-*.enc 2>/dev/null | head -1)
if [ -n "$B" ]; then age=$(( ($(date +%s) - $(stat -f %m "$B")) / 3600 )); [ $age -le 26 ] && p "$G" "data backup" "$(basename $B) (${age}h old)" || p "$R" "data backup" "STALE: ${age}h"
else p "$R" "data backup" "NONE"; fi
w=$(python3 -c "import sqlite3;print(sqlite3.connect('file:claims/claims.db?mode=ro',uri=True).execute(\"SELECT count(*) FROM watches WHERE status='active'\").fetchone()[0])" 2>/dev/null); p "$G" "watches active" "${w:-?}"

# recall-gate probe (7/30, the dead-gate lesson): import + auth from INSIDE the router venv —
# the exact interpreter production uses. "works in my shell" proved nothing for a month.
RV="$(cd "$(dirname "$0")" && pwd)/homebase/router/.venv/bin/python3"
if [ -x "$RV" ] && "$RV" -c "import anthropic" 2>/dev/null; then
  p "$G" "router venv brain" "anthropic SDK importable"
else
  p "$R" "router venv brain" "anthropic SDK MISSING — recall/episodes/phrase silently dead"
fi
