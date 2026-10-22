#!/bin/bash
# THE ONE GATE (9/6). Three suites cover this system and no single command ran all three, so a
# change could be green in the directory it lives in and broken in the one that tests it. The
# router's own `unittest discover` finds 5 files; the five that pin its outage behaviour, verdict
# binding, member-obligation gate, Linq event mapping and hint clamp live in engine/tests/ and
# never ran. Run this from the repo root before any kickstart.
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0
echo "── python: router + engine ──────────────────────────────────"
frame/homebase/router/.venv/bin/python3 -m pytest engine/tests/ frame/homebase/router/ -q || FAIL=1
echo "── typescript: runtime ─────────────────────────────────────"
if [ -d packages/runtime/node_modules ]; then
  pnpm check:runtime || FAIL=1
else
  echo "SKIP — packages/runtime/node_modules absent (run pnpm install)"
fi
echo "── rail eval (organs + live invariants) ────────────────────"
if [ "${SKIP_EVAL:-}" = "1" ]; then echo "SKIP — SKIP_EVAL=1"; else frame/evals/run_eval.sh || FAIL=1; fi
echo "────────────────────────────────────────────────────────────"
[ "$FAIL" = "0" ] && echo "VERIFY: all suites green" || echo "VERIFY: FAILURES ABOVE"
exit $FAIL
