#!/bin/bash
# Foreground launcher for launchd and local operations
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ROOT_ENV="$SCRIPT_DIR/../../../../.env"
FRAME_ENV="$SCRIPT_DIR/../.env"
for envfile in "$ROOT_ENV" "$FRAME_ENV" "$SCRIPT_DIR/.env"; do
  if [[ -f "$envfile" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$envfile"
    set +a
  fi
done

# MEMBERS ARE SERVED BY THE API KEY, NEVER A SUBSCRIPTION SEAT.
#
# CLAUDE_CODE_OAUTH_TOKEN is one person's interactive Claude Code quota. pi-ai PREFERS it
# when both are present, so the multi-tenant engine silently ran on it: 63% of Anthropic
# calls 429'd on 8/6, replies stretched to 17s, and the recall gate was dropped by the
# latency guard — which is what made co tell the founder it had no memory. Meanwhile the
# API key sitting in the same env reports 20,000 req/min, essentially untouched.
#
# The seat is fine for batch and dev. It is not fine for the reply path.
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_OAUTH_TOKEN
else
  echo "WARN: no ANTHROPIC_API_KEY — falling back to the subscription seat, expect 429s" >&2
fi

NODE_BIN="${CO_NODE_BIN:-/Users/main/.nvm/versions/node/v24.13.0/bin/node}"
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node)"
fi

# Evict any stale holder of the configured port before listening. The engine's log shows 10
# EADDRINUSE crash-boots (of 34 total): kickstart raced a lingering process, the new
# engine died, and the OLD process kept serving — the "restart that didn't take"
# gotcha, now mechanized away. Ports are singular; the newest launch wins.
ENGINE_PORT="${WITNESS_PORT:-8090}"
if [[ ! "$ENGINE_PORT" =~ ^[0-9]+$ ]] || (( ENGINE_PORT < 1 || ENGINE_PORT > 65535 )); then
  echo "invalid WITNESS_PORT: $ENGINE_PORT" >&2
  exit 1
fi
STALE=$(lsof -ti "tcp:${ENGINE_PORT}" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$STALE" ]]; then
  echo "evicting stale :${ENGINE_PORT} holder(s): $STALE" >&2
  kill $STALE 2>/dev/null || true
  sleep 1
  REMAINING=$(lsof -ti "tcp:${ENGINE_PORT}" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$REMAINING" ]]; then
    kill -9 $REMAINING 2>/dev/null || true
  fi
fi

exec "$NODE_BIN" --experimental-strip-types server.ts
