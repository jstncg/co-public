#!/bin/bash
# Run the iMessage Co router (the LIVE product rail: provider -> co_react/engine).
# Reads carrier credentials from frame/.env. (The old BlueBubbles rail — donna_router.py — is legacy;
# see ARCHITECTURE.md. This launcher, and the com.dennis.router launchagent that calls it, run
# the product router: sendblue_router.py.)
set -euo pipefail

ROUTER_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROUTER_DIR"

# Credentials + config live in frame/.env (CO_RAIL, provider keys, CO_TEST_HANDLES); local env can override.
FRAME_ENV="$ROUTER_DIR/../../.env"
# The API key lives in the repo-root .env; frame/.env carries only the subscription seat.
# Without this the router could never reach the key at all (8/6).
ROOT_ENV="$ROUTER_DIR/../../../../../.env"
for envfile in "$ROOT_ENV" "$FRAME_ENV" "$ROUTER_DIR/.env"; do
  if [[ -f "$envfile" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$envfile"
    set +a
  fi
done

# Members are served by the API key, never a subscription seat (see brain/run.sh for why:
# 63% of calls 429'd on 8/6 and the dropped recall made co deny having memory).
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_OAUTH_TOKEN
else
  echo "WARN: no ANTHROPIC_API_KEY — falling back to the subscription seat, expect 429s" >&2
fi

case "${CO_RAIL:-sendblue}" in
  linq)
    missing=""
    for name in LINQ_API_KEY LINQ_FROM_NUMBER LINQ_WEBHOOK_SECRET WEBHOOK_TOKEN; do
      [[ -n "${!name:-}" ]] || missing="$missing $name"
    done
    if [[ -n "$missing" ]]; then
      echo "ERROR: CO_RAIL=linq is missing:$missing" >&2
      exit 1
    fi
    ;;
  sendblue)
    if [[ -z "${SENDBLUE_API_KEY_ID:-${SENDBLUE_API_KEY:-}}" ||
          -z "${SENDBLUE_API_SECRET:-${SENDBLUE_SECRET_KEY:-}}" ]]; then
      echo "ERROR: CO_RAIL=sendblue requires Sendblue API key and secret" >&2
      exit 1
    fi
    ;;
  *)
    echo "ERROR: unsupported CO_RAIL=${CO_RAIL}; expected sendblue or linq" >&2
    exit 1
    ;;
esac

# SAFETY GATE: never let an auto-launched router send to arbitrary numbers. CO_TEST_HANDLES is the
# allowlist — only these numbers get real sends. Refuse to start without it (add tester numbers here).
if [[ -z "${CO_TEST_HANDLES:-}" ]]; then
  echo "ERROR: CO_TEST_HANDLES not set — refusing to start unguarded." >&2
  echo "Set the allowlist in frame/.env, e.g. CO_TEST_HANDLES=${CO_FOUNDER_HANDLE:?set in .env}[,+1...tester...]" >&2
  exit 1
fi

# The product runs in co mode unless explicitly overridden.
export CO_MODE="${CO_MODE:-co}"

# Use a venv to avoid dependency hell
VENV="$ROUTER_DIR/.venv"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r requirements.txt
fi

# Ensure the WITNESS ENDPOINT (the brain) is up. The router calls it; without it, Co is mute.
# The unified engine = the agent.ts brain behind an OpenAI-compatible server (server.ts). It runs
# from diyagi/pi (where the node deps live; frame/brain is the committed mirror). Needs Doppler (OAuth).
ENDPOINT_PORT="${WITNESS_PORT:-8090}"
ENGINE_HEALTH_HEADERS=()
if [[ -n "${CO_ENGINE_TOKEN:-}" ]]; then
  ENGINE_HEALTH_HEADERS=(-H "Authorization: Bearer ${CO_ENGINE_TOKEN}")
elif [[ -n "${CO_ENGINE_TOKEN_FILE:-}" && -f "${CO_ENGINE_TOKEN_FILE}" ]]; then
  IFS= read -r ENGINE_TOKEN_FOR_HEALTH < "${CO_ENGINE_TOKEN_FILE}" || [[ -n "${ENGINE_TOKEN_FOR_HEALTH}" ]]
  ENGINE_HEALTH_HEADERS=(-H "Authorization: Bearer ${ENGINE_TOKEN_FOR_HEALTH}")
fi
if ! curl -s -o /dev/null --max-time 2 "${ENGINE_HEALTH_HEADERS[@]}" "http://localhost:${ENDPOINT_PORT}/v1/models"; then
  # ONE engine source (monorepo cutover, 7/29): the watchdog script owns how the engine starts
  # (frame/brain + Secretary-Production/.env). The old inline start here launched a SECOND,
  # stale copy from diyagi/pi — a fork that once shipped an engine without the day's fixes.
  echo "Witness engine not up on :${ENDPOINT_PORT} — deferring to engine-watchdog.sh"
  /bin/bash "$ROUTER_DIR/../../brain/engine-watchdog.sh" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null --max-time 2 "${ENGINE_HEALTH_HEADERS[@]}" "http://localhost:${ENDPOINT_PORT}/v1/models" && break
    sleep 1
  done
fi

# caffeinate (-dimsu): keep the Mac awake while the router runs, so the machine doesn't sleep and drop
# the cloudflared tunnel / inbound provider webhooks. The assertion drops the instant the router exits.
exec caffeinate -dimsu "$VENV/bin/python" sendblue_router.py
