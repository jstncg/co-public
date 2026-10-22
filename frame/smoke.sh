#!/bin/bash
# smoke.sh — run the whole Co loop locally, zero real messages. ~3 minutes.
#   ./smoke.sh            # engine up? → eval gate → full simulated conversation (onboarding → co mode)
#   ./smoke.sh --fast     # skip the eval gate (just the conversation)
set -uo pipefail

FRAME="$(cd "$(dirname "$0")" && pwd)"
PI="/Users/main/Projects/Secretary/Secretary-Production/projects/diyagi/pi"
PY="/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/.venv/bin/python3"

# secrets
set -a; source "$FRAME/.env"; set +a

# 1. engine on :8090 (the ONE brain — server.ts). Start it if it's not up.
if ! curl -s -o /dev/null --max-time 2 "http://localhost:8090/v1/models"; then
  echo "→ starting the witness engine on :8090"
  ( cd "$PI" && WITNESS_PORT=8090 node donna/server.ts >> "$HOME/.co/engine.log" 2>&1 & )
  for _ in $(seq 1 15); do
    curl -s -o /dev/null --max-time 2 "http://localhost:8090/v1/models" && break
    sleep 1
  done
fi
curl -s -o /dev/null --max-time 2 "http://localhost:8090/v1/models" \
  && echo "✓ engine up (:8090)" || { echo "✗ engine failed to start — check ~/.co/engine.log"; exit 1; }

# 2. the disposition eval gate (banned patterns, programmatic)
if [[ "${1:-}" != "--fast" ]]; then
  echo "→ disposition eval (claims/co_eval.py)"
  ( cd "$FRAME/claims" && "$PY" co_eval.py ) || { echo "✗ EVAL RED — read the violations above"; exit 1; }
fi

# 3. the full simulated loop (webhook path minus Sendblue: onboarding → content → thought → skip)
echo "→ simulated conversation (homebase/router/smoke_driver.py)"
rm -f "$FRAME"/claims/claims_p15559990077.db* "$HOME/.co_p15559990077_sendblue_transcript.json" \
      "$HOME/.co/journal/p15559990077.json" 2>/dev/null
( cd "$FRAME/homebase/router" && "$PY" smoke_driver.py ) || exit 1

echo
echo "SMOKE GREEN — the loop works. Go live with MORNING.md."
