#!/bin/bash
# Ingress watchdog. PRIMARY is tailscale funnel — the public HTTPS door Sendblue posts through.
#
# REWRITTEN 2026-08-31 after it looped uselessly for seven hours. Two bugs, both the same shape:
# the script asserted facts about the machine instead of asking it.
#
#  1. IT HARDCODED ONE CLI. `/opt/homebrew/bin/tailscale` is one of three installs on this box, and
#     it answers "Tailscale is stopped" while a different daemon carries the live tunnel. So every
#     minute the watchdog detected the outage correctly, ran `funnel --bg 8099` against a dead
#     daemon, got "Tailscale is stopped", and logged it. Faithfully. Into a file nobody reads.
#
#  2. IT HARDCODED THE HOSTNAME. The header used to claim a stable hostname "can never rotate out
#     from under the Sendblue registration — that whole class of failure is structurally gone." It
#     was not gone. This node now answers to homebase-1.tail1f60f6.ts.net: a duplicate registration
#     appended -1, which is the same failure by a different route. A hostname that is discovered
#     cannot silently diverge from the one that is registered; a hostname that is asserted can.
#
# The law both fixes share: ASK THE MACHINE, DON'T ASSERT IT. And when there is nothing to ask,
# fail loudly — a guard that cannot do its job must say so, not retry forever in a logfile.
set -u
LOG=~/.co/tunnel.log
EXPECT_HOST="${CO_FUNNEL_HOST:-homebase.tail1f60f6.ts.net}"   # what Sendblue is registered against
PORT="${WEBHOOK_PORT:-8099}"
say() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

# --- 1. find a CLI whose backend is actually running -------------------------------------------
CLI=""; FALLBACK_CLI=""; STATES=""
for c in /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale \
         /opt/homebrew/bin/tailscale; do
  [ -x "$c" ] || continue
  st=$("$c" status --json 2>/dev/null | /usr/bin/python3 -c \
      'import sys,json;d=json.load(sys.stdin);print(d.get("BackendState","?"))' 2>/dev/null)
  STATES="$STATES\n    $c = ${st:-unreachable}"
  # PREFER THE DAEMON THAT OWNS THE EXPECTED NAME (8/31). This box runs two Tailscale installs and
  # they are two SEPARATE NODES: homebrew's holds `homebase`, the app's registered itself as
  # `homebase-1`. Taking the first one that reports Running would arm the funnel on whichever
  # daemon happened to answer, which is a door Sendblue is not knocking on. Match the name first;
  # settle for any running backend only if none matches.
  if [ "${st:-}" = "Running" ]; then
    dns=$("$c" status --json 2>/dev/null | /usr/bin/python3 -c \
      'import sys,json;print(((json.load(sys.stdin).get("Self") or {}).get("DNSName") or "").rstrip("."))' 2>/dev/null)
    if [ "$dns" = "$EXPECT_HOST" ]; then CLI="$c"; break; fi
    [ -z "$FALLBACK_CLI" ] && FALLBACK_CLI="$c"
  fi
done
[ -z "$CLI" ] && CLI="$FALLBACK_CLI"

if [ -z "$CLI" ]; then
  # THE CASE THAT USED TO LOOP SILENTLY. No daemon is up, so re-arming is impossible and retrying
  # is theatre. Say it once a run, name every install's state, and make it findable.
  say "FUNNEL DOWN AND UNFIXABLE — no tailscale backend is Running:$(printf '%b' "$STATES")"
  say "  → a human must bring tailscale up; the funnel re-arms automatically on the next tick"
  exit 1
fi

# --- 2. ask that daemon what this node is actually called ---------------------------------------
SELF=$("$CLI" status --json 2>/dev/null | /usr/bin/python3 -c \
  'import sys,json;print(((json.load(sys.stdin).get("Self") or {}).get("DNSName") or "").rstrip("."))' 2>/dev/null)
if [ -n "$SELF" ] && [ "$SELF" != "$EXPECT_HOST" ]; then
  say "HOSTNAME DRIFT — this node is '$SELF' but the webhook is registered to '$EXPECT_HOST'."
  say "  → funnel will come up on the wrong door. Reclaim the name in the tailscale admin,"
  say "    or re-register the Sendblue webhook against '$SELF'."
fi

# --- 3. health, then re-arm with the CLI that can actually do it ---------------------------------
if ! /usr/bin/curl -s --max-time 10 -o /dev/null "https://${EXPECT_HOST}/health"; then
  say "FUNNEL not answering on ${EXPECT_HOST} — re-arming via $CLI"
  "$CLI" funnel --bg "$PORT" >> "$LOG" 2>&1
fi
