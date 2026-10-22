"""
iMessage → Donna router (the witness in your pocket).

Listens on the BlueBubbles socket for new messages and routes each to the WITNESS ENDPOINT
(voice/endpoint.py, OpenAI-compatible on :8088) — the calibrated belief-graph brain that knows
Dennis from his email + past conversations and won't flatter him. Reply goes back via BlueBubbles.

Architecture (now clean request/response — no tmux, no stdout-scraping):
  iMessage → Messages.app → BlueBubbles → socket push
       ↓
  donna_router.py  ──HTTP──▶  witness endpoint :8088 (/v1/chat/completions)  [the brain]
       ↓ HTTP POST
  BlueBubbles REST API → Messages.app → iMessage

Production hardening (learned from Hermes/BlueBubbles + OpenClaw's imsg channel):
  • caffeinate (in run.sh): Messages.app idles after ~10-15min → inbound webhooks silently stop. The #1 bug.
  • Typing indicator + read receipts (Private API): the slow think feels alive, not dead.
  • Burst coalescing: you text in fragments → one reply per thought, not one per text.
  • 15-min stale fence + GUID dedupe: recover messages sent during downtime, never vomit ancient backlog.
  • Flywheel: every exchange feeds ~/.co_imessage_transcript.json → conductor's journal_ingest deepens the model.

Run:
  ./run.sh            (sets BLUEBUBBLES_PASSWORD, caffeinate, ensures the endpoint is up)

Environment:
  BLUEBUBBLES_PASSWORD — required, the BlueBubbles server password
  BLUEBUBBLES_URL      — default http://localhost:1234
  DENNIS_PHONE         — Dennis's handle; his self-chat is where Donna lives
  WITNESS_URL          — default http://localhost:8088/v1/chat/completions
"""
from __future__ import annotations

import collections
import json
import logging
import os
import signal
import sys
import threading
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import requests
import socketio

# ----------------------------- config ---------------------------------------

BLUEBUBBLES_URL = os.environ.get("BLUEBUBBLES_URL", "http://localhost:1234")
BLUEBUBBLES_PASSWORD = os.environ.get("BLUEBUBBLES_PASSWORD")
DENNIS_PHONE = os.environ.get("DENNIS_PHONE", "")   # the user's handle — from .env, never hardcoded
WITNESS_URL = os.environ.get("WITNESS_URL", "http://localhost:8090/v1/chat/completions")  # the unified agent.ts engine (brain/server.ts)
LOG_DIR = os.path.expanduser("~/.co/homebase/router")
os.makedirs(LOG_DIR, exist_ok=True)

# Flywheel: iMessage turns land here; the conductor's journal_ingest reads it (single writer = this process).
# Per-tenant so one stranger's words never leak into another's (or the founder's) file. Dennis keeps the
# legacy path the conductor already reads.
def _transcript_path(tenant: str) -> str:
    if tenant == "dennis":
        return os.path.expanduser("~/.co_imessage_transcript.json")
    return os.path.expanduser(f"~/.co_{tenant}_imessage_transcript.json")

# Burst coalescing — wait this long after the LAST message in a burst before answering, so three
# rapid texts become one thought (Apple also splits text+URL into two rows ~1s apart).
DEBOUNCE_SECONDS = float(os.environ.get("CO_DEBOUNCE", "2.5"))
# Don't process messages older than this (downtime recovery without ancient-backlog vomit on reconnect).
STALE_FENCE_MS = 15 * 60 * 1000
# How long to keep per-chat conversation history (turns) in memory for the endpoint.
HISTORY_TURNS = 24
WITNESS_TIMEOUT = 180

# Allow-list: who can reach Donna. Dennis's self-chat always; plus CO_TEST_HANDLES (comma-separated
# numbers/emails) for the stranger test, so we route the people we invited and ignore random inbound/spam.
# Leave CO_TEST_HANDLES unset and it's self-chat only (the prior behavior).
_TEST_HANDLES = [h.strip() for h in os.environ.get("CO_TEST_HANDLES", "").split(",") if h.strip()]
ALLOWED_HANDLES: List[str] = [h for h in ([DENNIS_PHONE] + _TEST_HANDLES) if h]

# Logging
log_level = os.environ.get("CO_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=log_level,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(os.path.join(LOG_DIR, "router.log")),
    ],
)
log = logging.getLogger("donna-router")

# ----------------------------- bluebubbles client ---------------------------


def _bb_url(path: str, **params) -> str:
    if not BLUEBUBBLES_PASSWORD:
        raise SystemExit("BLUEBUBBLES_PASSWORD env var is required")
    qs = "&".join([f"password={BLUEBUBBLES_PASSWORD}"] + [f"{k}={v}" for k, v in params.items()])
    return f"{BLUEBUBBLES_URL}{path}?{qs}"


def bb_send_text(chat_guid: str, text: str) -> bool:
    """Send a plain text message via BlueBubbles."""
    url = _bb_url("/api/v1/message/text")
    payload = {
        "chatGuid": chat_guid,
        "tempGuid": f"donna-{int(time.time() * 1000)}",   # BlueBubbles dedupes outbound on this
        "message": text,
        "method": "apple-script",
    }
    try:
        r = requests.post(url, json=payload, timeout=10)
        r.raise_for_status()
        log.info("Sent reply to %s (%d chars)", chat_guid, len(text))
        return True
    except Exception as e:
        log.exception("Failed to send: %s", e)
        return False


def bb_mark_read(chat_guid: str) -> None:
    """Mark the chat read (Private API). Best-effort — silently no-ops if Private API is off."""
    try:
        requests.post(_bb_url(f"/api/v1/chat/{quote(chat_guid, safe='')}/read"), timeout=5)
    except Exception as e:
        log.debug("mark_read (private api?) failed: %s", e)


def bb_typing(chat_guid: str, on: bool) -> None:
    """Show/hide the typing indicator (Private API). Best-effort."""
    try:
        path = f"/api/v1/chat/{quote(chat_guid, safe='')}/typing"
        if on:
            requests.post(_bb_url(path), timeout=5)
        else:
            requests.delete(_bb_url(path), timeout=5)
    except Exception as e:
        log.debug("typing (private api?) failed: %s", e)


# ----------------------------- the witness endpoint -------------------------

_history: Dict[str, List[Dict[str, str]]] = {}
_history_lock = threading.Lock()
_transcript_lock = threading.Lock()


def _append_transcript(user_text: str, reply: str, tenant: str = "dennis") -> None:
    """Flywheel: persist the exchange (per-tenant) so the conductor's journal_ingest deepens the model from it.
    Single writer (this process), lock-guarded, atomic rename — no cross-process race, no cross-tenant leak."""
    try:
        with _transcript_lock:
            path = _transcript_path(tenant)
            msgs = []
            if os.path.exists(path):
                try:
                    msgs = json.loads(open(path).read())
                except (json.JSONDecodeError, OSError):
                    msgs = []
            msgs.append({"role": "user", "content": user_text})
            msgs.append({"role": "assistant", "content": reply})
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(msgs, f)
            os.replace(tmp, path)
    except Exception as e:
        log.debug("transcript append failed: %s", e)


def tenant_of(handle: str) -> str:
    """Map an iMessage handle to a tenant id. Dennis's handles → the default tenant (full agentic brain
    + his belief graph); anyone else → their own tenant (own cold-start store, witness path) — the
    endpoint enforces the separation, this just names who's talking."""
    h = (handle or "").strip()
    if not h or h == DENNIS_PHONE or h.endswith(DENNIS_PHONE.lstrip("+")):
        return "dennis"
    return h.lower().replace("+", "p").replace("@", "_at_").replace(".", "_")


def ask_witness(chat_guid: str, user_text: str, tenant: str = "dennis") -> Optional[str]:
    """Send the (coalesced) message + recent per-chat history to the witness endpoint; return its reply."""
    with _history_lock:
        hist = _history.setdefault(chat_guid, [])
        hist.append({"role": "user", "content": user_text})
        messages = list(hist[-HISTORY_TURNS:])
    try:
        r = requests.post(WITNESS_URL, json={"model": "witness", "messages": messages, "stream": False,
                                             "user": tenant},
                          timeout=WITNESS_TIMEOUT)
        r.raise_for_status()
        reply = (r.json()["choices"][0]["message"]["content"] or "").strip()
    except Exception as e:
        log.exception("witness endpoint call failed (is :8088 up?): %s", e)
        return None
    if not reply:
        return None
    with _history_lock:
        hist = _history.setdefault(chat_guid, [])
        hist.append({"role": "assistant", "content": reply})
        if len(hist) > HISTORY_TURNS:
            del hist[:-HISTORY_TURNS]
    _append_transcript(user_text, reply, tenant)
    return reply


# ----------------------------- burst coalescing -----------------------------

_pending: Dict[str, Dict[str, Any]] = {}        # chat_guid -> {"texts": [...], "handle": str, "timer": Timer}
_pending_lock = threading.Lock()
_chat_locks: Dict[str, threading.Lock] = collections.defaultdict(threading.Lock)


def _enqueue(chat_guid: str, handle: str, text: str) -> None:
    """Buffer a message and (re)arm the debounce timer — flush once the burst goes quiet."""
    with _pending_lock:
        p = _pending.get(chat_guid)
        if p and p.get("timer"):
            p["timer"].cancel()
        if not p:
            p = {"texts": [], "handle": handle}
            _pending[chat_guid] = p
        p["texts"].append(text)
        p["handle"] = handle
        t = threading.Timer(DEBOUNCE_SECONDS, _flush, args=(chat_guid,))
        t.daemon = True
        p["timer"] = t
        t.start()


def _flush(chat_guid: str) -> None:
    with _pending_lock:
        p = _pending.pop(chat_guid, None)
    if not p or not p["texts"]:
        return
    combined = "\n".join(p["texts"])
    # Serialize per-chat: if a reply is mid-flight, the next burst waits its turn (no interleaving).
    with _chat_locks[chat_guid]:
        _process(chat_guid, p.get("handle", ""), combined)


def _process(chat_guid: str, handle: str, combined_text: str) -> None:
    """Mark read → show typing (kept alive) → ask the witness → send. The 'feels alive' path."""
    tenant = tenant_of(handle)
    log.info("processing burst (tenant=%s) → witness: %r", tenant, combined_text[:160])
    bb_mark_read(chat_guid)
    stop = threading.Event()

    def _keepalive():
        # iMessage typing indicators lapse after a few seconds — refresh until the reply is ready.
        while not stop.is_set():
            bb_typing(chat_guid, True)
            stop.wait(8)
        bb_typing(chat_guid, False)

    ka = threading.Thread(target=_keepalive, daemon=True)
    ka.start()
    try:
        reply = ask_witness(chat_guid, combined_text, tenant)
    finally:
        stop.set()
        ka.join(timeout=2)
    if reply:
        _remember_sent(reply)
        bb_send_text(chat_guid, reply)
    else:
        log.error("no reply produced; burst dropped: %s", combined_text[:120])


# ----------------------------- routing logic --------------------------------

_seen_guids: set = set()
_seen_lock = threading.Lock()
# Anti-loop: Donna's own outbound comes back as a new-message event (same Apple ID in the self-chat).
# A SHARED file ledger (not just in-memory) so EVERY Donna process — this router's replies, the morning
# brief, reminders, proactive pings — records what it sent, and the router skips the echo. No visible tag.
_OUTBOUND = os.path.expanduser("~/.co_outbound.json")
_OUTBOUND_TTL = 3600


def _ledger_load() -> list:
    try:
        return json.loads(open(_OUTBOUND).read())
    except (json.JSONDecodeError, OSError):
        return []


def _remember_sent(text: str) -> None:
    with _seen_lock:
        led = _ledger_load()
        led.append({"ts": time.time(), "t": text.strip()})
        led = [e for e in led if time.time() - e.get("ts", 0) < _OUTBOUND_TTL][-200:]
        try:
            tmp = _OUTBOUND + ".tmp"
            with open(tmp, "w") as f:
                json.dump(led, f)
            os.replace(tmp, _OUTBOUND)
        except OSError:
            pass


def _is_own_echo(text: str) -> bool:
    t, now = text.strip(), time.time()
    return any(e.get("t") == t and now - e.get("ts", 0) < _OUTBOUND_TTL for e in _ledger_load())


def is_allowed(handle: str) -> bool:
    if not ALLOWED_HANDLES:
        return True
    return any(handle.endswith(h.lstrip("+")) or handle == h for h in ALLOWED_HANDLES)


def handle_new_message(payload: Dict[str, Any]) -> None:
    """Process a single new-message event from BlueBubbles."""
    try:
        guid = payload.get("guid") or payload.get("tempGuid")
        text = (payload.get("text") or "").strip()
        is_from_me = payload.get("isFromMe", False)
        chat = (payload.get("chats") or [{}])
        chat = chat[0] if chat else {}
        chat_guid = chat.get("guid", "")
        handle = (payload.get("handle") or {}).get("address") or ""

        # Stale fence: process live + recently-missed (downtime recovery), drop ancient backlog on reconnect.
        date_created = payload.get("dateCreated") or 0
        if date_created and date_created < int(time.time() * 1000) - STALE_FENCE_MS:
            log.debug("stale backlog suppressed: dateCreated=%d", date_created)
            return

        # GUID dedupe (a double-fired webhook / replay won't double-reply).
        if guid:
            with _seen_lock:
                if guid in _seen_guids:
                    return
                _seen_guids.add(guid)
                if len(_seen_guids) > 5000:
                    _seen_guids.clear()

        if not text:
            return  # reactions / attachment-only — nothing to answer
        if _is_own_echo(text):
            return  # Donna's own reply echoing back — anti-loop

        # Two routes:
        #  • Dennis's self-chat — his own messages arrive isFromMe=True, handle == his number → tenant "dennis".
        #  • A stranger texting the number — arrives isFromMe=False, handle == the stranger → their own tenant.
        # Donna's OWN outbound (to anyone) is isFromMe=True too, but _is_own_echo already dropped it by content
        # above; any remaining isFromMe=True from a non-Dennis handle is an echo / manual send → ignore.
        if is_from_me:
            is_dennis = (not handle) or handle == DENNIS_PHONE or (DENNIS_PHONE and handle.endswith(DENNIS_PHONE.lstrip("+")))
            if not is_dennis:
                return
            sender = DENNIS_PHONE or handle
        else:
            sender = handle
        if not is_allowed(sender):
            return
        if not chat_guid:
            log.warning("no chat guid on message; cannot reply")
            return

        log.info("msg guid=%s from=%s text=%r chat=%s", guid, sender, text[:120], chat_guid)
        _enqueue(chat_guid, sender or DENNIS_PHONE, text)
    except Exception:
        log.exception("Error handling message")


# ----------------------------- socket.io connection -------------------------


def _check_endpoint() -> None:
    base = WITNESS_URL.rsplit("/chat/completions", 1)[0]
    try:
        requests.get(f"{base}/models", timeout=3).raise_for_status()
        log.info("witness endpoint reachable at %s", WITNESS_URL)
    except Exception as e:
        log.warning("witness endpoint NOT reachable at %s (%s) — run.sh should start it on :8088", WITNESS_URL, e)


def main() -> None:
    if not BLUEBUBBLES_PASSWORD:
        log.error("BLUEBUBBLES_PASSWORD not set in environment")
        sys.exit(1)

    _check_endpoint()

    sio = socketio.Client(reconnection=True, reconnection_attempts=0, reconnection_delay=2)

    @sio.event
    def connect():
        log.info("Connected to BlueBubbles socket")

    @sio.event
    def disconnect():
        log.warning("Disconnected from BlueBubbles socket")

    @sio.on("new-message")
    def on_new_message(data):
        handle_new_message(data)

    @sio.on("*")
    def catch_all(event, data):
        if event != "new-message":
            log.debug("event=%s", event)

    url = f"{BLUEBUBBLES_URL}?password={BLUEBUBBLES_PASSWORD}"
    log.info("Connecting to %s", BLUEBUBBLES_URL)
    sio.connect(url, transports=["websocket"], wait_timeout=15)

    def shutdown(signum, frame):
        log.info("Shutting down (signal %d)", signum)
        sio.disconnect()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    sio.wait()


if __name__ == "__main__":
    main()
