#!/bin/bash
# THE RAIL EVAL — always in the production interpreter with the production env (the dead-gate law).
set -euo pipefail
FRAME="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$FRAME/.env"; set +a
PY="$FRAME/homebase/router/.venv/bin/python3"
"$PY" "$FRAME/evals/rail_eval.py" "$@"; rc=$?

# THE INVARIANTS — laws over REAL production state, not fixtures. rail_eval tests organs
# in isolation and was 59/59 green on a day five live bugs were found by hand; this half
# opens what production actually wrote and asks whether it is legal. Read-only.
# Reported but NOT gating yet: it currently finds real, pre-existing violations, and a gate
# that is red on arrival gets ignored. Flip CO_INVARIANTS_GATE=1 once the backlog is clear.
echo
"$PY" "$FRAME/evals/invariants.py" || {
  [ "${CO_INVARIANTS_GATE:-0}" = "1" ] && rc=1
  echo "  (invariants are advisory until CO_INVARIANTS_GATE=1)"
}
exit $rc
