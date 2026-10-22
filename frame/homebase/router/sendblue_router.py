"""
iMessage provider → Co router (V1_PRODUCT_SPEC channel adapter).

The managed-iMessage rail. Sendblue provisions the number/Apple-ID, so we never touch Dennis's personal
Apple ID or this machine's iMessage. One number you text anything — thoughts, reels, tweets, links,
screenshots — and it responds like a sharp friend who remembers everything.

MODE "co" (the product, default) per inbound send:
  new tenant     → the same Co relationship with an empty graph — no onboarding ceremony or guessing game.
  content send   → instant light ack (ALWAYS-PAYS: seconds, never silence) → ingest (links/reels/tweets/
   (link/image)    screenshots via link_read: Apify IG, native-Gemini YouTube, fxtwitter X, Gemini vision)
                   → co_react gate → the RARE line lands as a follow-up text. Restraint governs depth.
  pure text      → co_react first (the deterministic restrained read + repetition mechanic); if no LINE,
                   the engine (:8090, model "co" = the Co disposition) answers like a friend, short.
  every send     → journal.capture (the Saga + flywheel) + threads.update (the rolling open-threads state
                   the brain carries) — all state per-tenant, zero cross-tenant leaks.
  "not tonight"  → sets the per-tenant skip flag (mutes tonight's call AND daily text), brief ack.

  inbound:  tester texts the Co number → the selected carrier POSTs our webhook
            → route (tenant = sender) → the loop above → reply through the same carrier
  timing:   every reply logs latency to ~/.co/homebase/router/timing.jsonl
            (time-to-first-wow is computable from inbound_ts → first reply per tenant).

Run (on the box, behind a public tunnel so the carrier can reach the webhook):
  set -a; source ../../.env; set +a; python3 sendblue_router.py     # or: doppler run -- python3 sendblue_router.py
  # then expose WEBHOOK_PORT publicly (cloudflared/ngrok) and register the provider webhook URL.

Env (via frame/.env or Doppler — NEVER hardcode the secret):
  CO_RAIL                 sendblue (default) | linq
  SENDBLUE_API_KEY_ID  (or SENDBLUE_API_KEY)     required — Sendblue API key id   (header sb-api-key-id)
  SENDBLUE_API_SECRET  (or SENDBLUE_SECRET_KEY)  required — Sendblue API secret   (header sb-api-secret-key)
  SENDBLUE_FROM_NUMBER    our provisioned Sendblue number, E.164 — optional if the account has one number
  LINQ_API_KEY             required for Linq — bearer token
  LINQ_FROM_NUMBER         required for Linq — stable Co line, E.164
  LINQ_WEBHOOK_SECRET      required for Linq — Standard Webhooks signing secret
  WITNESS_URL             default http://localhost:8090/v1/chat/completions  (the engine)
  WEBHOOK_PORT            default 8099  (the port Sendblue POSTs to, via the tunnel)
  CO_TEST_HANDLES      comma-separated invited testers' numbers; empty = answer ANY inbound (test only)
  CO_MODE              co (default) | journal | engine | echo
"""
from __future__ import annotations

import json
import hashlib
import hmac
import logging
import os
import re
import sqlite3
import sys
import stat
import threading
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional

import requests

# ----------------------------- config (from env) -----------------------------
SENDBLUE_API_KEY_ID = os.environ.get("SENDBLUE_API_KEY_ID") or os.environ.get("SENDBLUE_API_KEY", "")
SENDBLUE_API_SECRET = os.environ.get("SENDBLUE_API_SECRET") or os.environ.get("SENDBLUE_SECRET_KEY", "")
SENDBLUE_FROM_NUMBER = os.environ.get("SENDBLUE_FROM_NUMBER", "")
# env-overridable so the rail eval can point sends at a local capture server (kyo NullTransport lesson)
SENDBLUE_SEND_URL = os.environ.get("SENDBLUE_SEND_URL", "https://api.sendblue.com/api/send-message")
WITNESS_URL = os.environ.get("WITNESS_URL", "http://localhost:8090/v1/chat/completions")
WITNESS_FALLBACK_URL = os.environ.get("WITNESS_FALLBACK_URL", "").strip()
_RUNTIME_TENANTS = frozenset(
    tenant.strip()
    for tenant in os.environ.get("CO_RUNTIME_TENANTS", "").split(",")
    if tenant.strip()
)


def _engine_url(tenant: str) -> str:
    """Keep an incremental cutover tenant-bound.

    With no allowlist, every tenant uses the primary endpoint, preserving the
    historical behavior. Once CO_RUNTIME_TENANTS is set, identities outside
    that set remain on the explicit fallback instead of crossing into another
    tenant's runtime cell or failing closed on every turn.
    """
    if not _RUNTIME_TENANTS or tenant in _RUNTIME_TENANTS:
        return WITNESS_URL
    if not WITNESS_FALLBACK_URL:
        raise RuntimeError(f"tenant {tenant!r} is not assigned to an engine")
    return WITNESS_FALLBACK_URL


def _engine_token() -> str:
    inline = os.environ.get("CO_ENGINE_TOKEN")
    path = os.environ.get("CO_ENGINE_TOKEN_FILE")
    if inline is not None and path is not None:
        raise RuntimeError("set CO_ENGINE_TOKEN or CO_ENGINE_TOKEN_FILE, not both")
    if inline is not None:
        return inline.strip()
    if not path:
        return ""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(os.path.realpath(path), flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise RuntimeError("CO_ENGINE_TOKEN_FILE must be a private regular file")
        if info.st_uid not in {os.getuid(), 0}:
            raise RuntimeError("CO_ENGINE_TOKEN_FILE must be owned by this account or root")
        value = os.read(fd, 65_537)
        if len(value) > 65_536:
            raise RuntimeError("CO_ENGINE_TOKEN_FILE exceeds 64 KiB")
        token = value.decode("utf-8").strip()
        if not token or "\0" in token:
            raise RuntimeError("CO_ENGINE_TOKEN_FILE is empty or invalid")
        return token
    finally:
        os.close(fd)

_ENGINE_TOKEN = _engine_token()
ENGINE_HEADERS = {"Authorization": f"Bearer {_ENGINE_TOKEN}"} if _ENGINE_TOKEN else {}
WEBHOOK_PORT = int(os.environ.get("WEBHOOK_PORT", "8099"))
# MODE (V1_PRODUCT_SPEC.md): "co" = the product; "journal" = daily-question journal only;
# "engine" = raw conversational engine (:8090); "echo" = pipe test.
MODE = os.environ.get("CO_MODE", "co").lower()
MAX_HINT = 500                       # frame/brain/runtime-boundary.ts MAX_HINT_LENGTH
if os.environ.get("CO_ECHO", "") == "1":       # back-compat with the earlier flags
    MODE = "echo"
elif os.environ.get("CO_JOURNAL_MODE", "") == "1":
    MODE = "journal"
FRAME_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(FRAME_ROOT, "claims"))
sys.path.insert(0, os.path.join(FRAME_ROOT, "voice"))
_TEST_HANDLES = [h.strip() for h in os.environ.get("CO_TEST_HANDLES", "").split(",") if h.strip()]
HISTORY_TURNS = 24
WITNESS_TIMEOUT = 180
ONBOARDED_CLAIMS = 3          # mirror of server.ts ONBOARDED_CLAIMS
ONBOARDED_TURNS = 8           # mirror of server.ts ONBOARDED_TURNS
TIMING_LOG = os.path.expanduser("~/.co/homebase/router/timing.jsonl")
APP_TURN_DB = os.path.expanduser("~/.co/app_turns.sqlite3")
APP_TURN_LEASE_SECONDS = 5 * 60

logging.basicConfig(level=os.environ.get("CO_LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("sendblue-router")

# co dual-write (the ingest-contract SENDER, co/docs/ingest-contract.md): mirrors messages into the
# canonical co backend. ENTIRELY INERT unless CO_INGEST_URL + CO_INGEST_TOKEN are set (default: off,
# zero live change). Fire-and-forget; never on the reply path; every call site is try/except'd.
try:
    import co_dualwrite
except Exception:                              # the mirror must never break the live rail
    co_dualwrite = None

# ----------------------------- state ----------------------------------------
_history: Dict[str, List[Dict[str, str]]] = {}
_history_lock = threading.Lock()
_seen: set = set()
_seen_lock = threading.Lock()
_flood: Dict[str, int] = {}
_flood_lock = threading.Lock()
FLOOD_CAP = int(os.environ.get("CO_FLOOD_CAP", "150"))   # messages/sender/day — a person never hits this
_sender_locks: Dict[str, threading.Lock] = {}
_sender_locks_guard = threading.Lock()


def _norm(num: str) -> str:
    return "".join(c for c in (num or "") if c.isdigit() or c == "+")


def is_allowed(sender: str) -> bool:
    """OPEN MODE (7/31, founder decision): anyone with the number can text — the door is the
    number itself. The old allowlist survives only as its inverse: a blocklist for abuse.
    CO_CLOSED=1 restores invite-only (the old behavior) if a launch ever needs the gate back."""
    s = _norm(sender)
    try:
        import json as _j
        blocked = _j.load(open(os.path.expanduser("~/.co/blocklist.json"))).get("numbers") or []
        if any(s == _norm(h) for h in blocked):
            return False
    except Exception:
        pass
    if os.environ.get("CO_CLOSED") != "1":
        return True
    if not _TEST_HANDLES:
        return True
    try:                       # invited-on-the-fly: the invite rail still works in closed mode
        import json as _j
        dyn = _j.load(open(os.path.expanduser("~/.co/allowlist.json"))).get("numbers") or []
    except Exception:
        dyn = []
    if any(s == _norm(h) for h in dyn):
        return True
    s = _norm(sender)
    return any(s == _norm(h) or s.endswith(_norm(h).lstrip("+")) for h in _TEST_HANDLES)


# The FOUNDER's phone maps to the founder tenant ("dennis" → claims.db, the full graph) — without this he
# rides a stranger tenant and the product cold-opens its own founder (lived it live, 7/2 05:36).
FOUNDER_HANDLE = _norm(os.environ.get("CO_FOUNDER_HANDLE", ""))
FOUNDER_TENANT = os.environ.get("CO_FOUNDER_TENANT", "dennis")


def tenant_of(handle: str) -> str:
    """Sender handle → tenant id (its own belief graph). The engine enforces separation; this just names them."""
    n = _norm(handle)
    if FOUNDER_HANDLE and n.lstrip("+") == FOUNDER_HANDLE.lstrip("+"):
        return FOUNDER_TENANT
    return n.lower().replace("+", "p") or "anon"


def _belt(text: str) -> str:
    """The disposition belt (dashes out, the closing period off the last beat), and it can NEVER drop a
    message: if disposition dies the raw text still goes. Every surface co speaks through calls this —
    the Sendblue wire, the native app reply, and the transcript both of them read back."""
    try:
        import disposition
        return disposition.sanitize(text)
    except Exception as e:
        log.debug("sanitize failed (using raw): %s", e)
        return text


def _transcript_path(tenant: str) -> str:
    # Legacy filename is an on-disk contract. Renaming it for a carrier cutover would hide history.
    return os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json")


def _append_transcript(user_text: str, reply: str, tenant: str, transport_name: str | None = None) -> None:
    try:
        import rail
        path = _transcript_path(tenant)
        msgs = []
        if os.path.exists(path):
            try:
                msgs = json.loads(open(path).read())
            except (json.JSONDecodeError, OSError):
                msgs = []
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        transport_name = transport_name or rail.provider()
        msgs += [{"role": "user", "content": user_text, "ts": now, "transport": transport_name},
                 {"role": "assistant", "content": reply, "ts": now, "transport": transport_name}]
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(msgs, f)
        os.replace(tmp, path)
    except Exception as e:
        log.debug("transcript append failed: %s", e)


def app_thread(tenant: str) -> list:
    """The one relationship thread as the app reads it (`/w/<slug>/chat.json`): the transcript's last
    250 turns, oldest first, which is the order the thread renders in.

    Co's half wears the belt HERE as well as at the send, because the thread already holds weeks of
    replies that shipped before the rules existed (measured 8/7: 42 of 65 closing on a period, 6
    carrying a dash). The member's words are theirs and are never touched.
    """
    rows = []
    try:
        path = _transcript_path(tenant)
        if not os.path.exists(path):
            return []
        with open(path) as f:
            raw_rows = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    for index, row in enumerate(raw_rows[-250:]):
        role = row.get("role")
        content = str(row.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        is_co = role == "assistant"
        stable = hashlib.sha256(
            f"{tenant}:{index}:{role}:{row.get('ts')}:{content}".encode()
        ).hexdigest()
        rows.append({"id": f"rail-{stable[:24]}", "isKyo": is_co,
                     "text": _belt(content) if is_co else content,
                     "sentAt": row.get("ts"), "transport": row.get("transport") or "sendblue"})
    return rows


def _log_timing(tenant: str, kind: str, t_inbound: float, extra: dict | None = None) -> None:
    """Append a timing row (time-to-first-wow is computable from these)."""
    try:
        os.makedirs(os.path.dirname(TIMING_LOG), exist_ok=True)
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "tenant": tenant, "kind": kind,
               "latency_ms": int((time.time() - t_inbound) * 1000)}
        if extra:
            row.update(extra)
        with open(TIMING_LOG, "a") as f:
            f.write(json.dumps(row) + "\n")
    except OSError:
        pass


# ----------------------------- transport + engine ---------------------------
def _mirror_sent(to_number: str, content: str, provider: str, external_message_id: str | None) -> None:
    """Canonicalize only a provider-proven send, with the handle its status callbacks will name."""
    try:
        if co_dualwrite:
            co_dualwrite.emit_outbound(
                _norm(to_number), external_message_id, content, co_dualwrite.utc_iso(),
                transport=provider,
            )
    except Exception as error:
        log.debug("co dualwrite outbound failed: %s", error)


def sendblue_send(to_number: str, content: str, media_url: str = "") -> bool:
    # The mechanical belt, at the one place every outbound iMessage word passes through (8/7).
    # disposition.py has owned the em-dash rule since v1, but only the claims-side phrasers ever called
    # it, so engine replies shipped the — character whenever the prompt lost the argument. Prose asks;
    # this enforces. The app has its own doors (ask_engine, /api/app/chat) and wears the same belt.
    content = _belt(content)
    # The receipt gate (8/22, epistemic-governance ws1): an outbound claiming an action must hold
    # the receipt row, or it does not go. Held is held — silence beats a lie about a reminder.
    try:
        import journal
        import receipts
        ok, why = receipts.gate(content, journal._claims_db(tenant_of(to_number)))
        if not ok:
            log.warning("receipt gate HELD outbound to %s: %s", tenant_of(to_number), why)
            return False
    except Exception as e:
        log.debug("receipt gate unavailable (send proceeds): %s", e)
    import rail
    if rail.provider() == "linq":                  # the toggle (9/2): same gates above, other bytes
        ok, evidence = rail.transport(to_number, content, media_url)
        if ok:
            log.info("sent via linq → %s (%d chars)", to_number, len(content))
            _mirror_sent(to_number, content, "linq", evidence if evidence != "sent" else None)
        else:
            log.error("linq send failed: %s", evidence)
        return ok
    headers = {"sb-api-key-id": SENDBLUE_API_KEY_ID, "sb-api-secret-key": SENDBLUE_API_SECRET,
               "Content-Type": "application/json"}
    body = {"number": to_number, "content": content}
    cb_base = os.environ.get("WEBHOOK_PUBLIC_URL", "").rstrip("/")
    cb_tok = os.environ.get("WEBHOOK_TOKEN", "")
    if cb_base and cb_tok:
        # status callbacks (7/31): DELIVERED/READ per message — the ledger was empty for a month
        # because no send ever ASKED for them. READ arrives when their handset sends receipts,
        # and it powers the read-aware proactive gate + the reward stream.
        body["status_callback"] = f"{cb_base}/hook/{cb_tok}"
    if media_url:
        body["media_url"] = media_url          # an image lands inline — the artifact as a bubble
    if SENDBLUE_FROM_NUMBER:
        body["from_number"] = SENDBLUE_FROM_NUMBER
    try:
        r = requests.post(SENDBLUE_SEND_URL, headers=headers, json=body, timeout=20)
        r.raise_for_status()
        log.info("sent → %s (%d chars)", to_number, len(content))
        try:
            response = r.json()
            message_handle = str(response.get("message_handle") or "") if isinstance(response, dict) else ""
        except ValueError:
            message_handle = ""
        _mirror_sent(to_number, content, "sendblue", message_handle or None)
        return True
    except Exception as e:
        log.exception("sendblue send failed: %s", e)
        return False


def _elapsed(seconds: float) -> str:
    """How long ago, the way a person says it."""
    m = seconds / 60
    if m < 2:
        return "just now"
    if m < 60:
        return f"{int(m)}m ago"
    h = m / 60
    if h < 24:
        return f"{int(h)}h ago"
    d = h / 24
    if d < 7:
        return f"{int(d)}d ago"
    if d < 60:
        return f"{round(d / 7)}w ago"     # round, not floor: two turns a minute apart
    return f"{round(d / 30)}mo ago"       # must not read as "3w" and "2w"


def _stamp_history(msgs: list, claims_db: str) -> list:
    """Put THEIR clock and the gap on every prior turn.

    The transcript has carried `ts` on ~94% of turns since July and the engine has never seen
    one: `_seed_history` and `splitMessages` both mapped to {role, content}. So co could not
    tell a three-minute pause from a three-week silence in its own history — while the founder
    was asking it to treat elapsed time as a signal of relevance (8/6).

    Local time, never host time. "1am" only means something in the clock they are living in,
    and the device now reports that zone on every app call.

    Annotates only where it carries information: a real gap, or a turn from another day. A
    stamp on every consecutive turn is noise, and noise in the tail is what dilutes the
    register budgets.
    """
    try:
        import tz_dynamic
        now_local = tz_dynamic.now_in(str(claims_db), None)
        tz = now_local.tzinfo
    except Exception:
        import datetime as _dt
        now_local, tz = _dt.datetime.now(), None

    import datetime as _dt

    def _epoch(v):
        """The transcript stores ISO strings; in-process history stores floats. Accept both.

        Shipped 8/6 accepting floats only, which silently annotated nothing loaded from disk —
        i.e. all cross-session history, the entire reason this exists. A guard that quietly
        does nothing is the failure mode this whole day has been about.
        """
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
        if isinstance(v, str) and v.strip():
            try:
                return _dt.datetime.fromisoformat(v.strip()).timestamp()
            except ValueError:
                return None
        return None

    out, prev_ts, anchored = [], None, False
    for m in msgs:
        ts = _epoch(m.get("ts"))
        content = m.get("content", "")
        if ts:
            when = _dt.datetime.fromtimestamp(ts, tz) if tz else _dt.datetime.fromtimestamp(ts)
            gap = (now_local - when).total_seconds()
            # Stamp only where the gap itself is the information: a real pause, or the first
            # turn we carry. A day boundary always brings a pause with it, so checking the
            # calendar separately just stamps every old turn and buries the signal in noise.
            big_gap = prev_ts is not None and (ts - prev_ts) > 20 * 60
            # `anchored`, not `prev_ts is None`: a window that opens on an assistant turn would
            # otherwise never tell the model how old the whole window is.
            if m.get("role") == "user" and (big_gap or not anchored):
                stamp = _elapsed(gap)
                clock = when.strftime("%a %-I:%M%p").lower()
                content = f"[{stamp}, {clock} their time] {content}"
                anchored = True
            prev_ts = ts
        out.append({"role": m.get("role", "user"), "content": content})
    return out


def _seed_history(sender: str, tenant: str) -> None:
    """DURABLE conversation history (7/2 cycle-3 fix 1/2 root cause): in production every webhook can hit a
    fresh process (and restarts drop RAM), so an in-memory-only history makes EVERY message look like turn 1
    — the engine re-opens, never accumulates disclosures, never persists claims, onboarding never flips.
    Cold process → rebuild the sender's history from the persisted per-tenant transcript."""
    with _history_lock:
        if sender in _history:
            return
    msgs: List[Dict[str, str]] = []
    try:
        p = _transcript_path(tenant)
        if os.path.exists(p):
            # keep `ts` — the gap between turns is CONTENT, not bookkeeping. Dropping it here is
            # why the engine could not tell a three-minute pause from a three-week silence (8/6).
            msgs = [{"role": m["role"], "content": m["content"], "ts": m.get("ts")}
                    for m in json.loads(open(p).read())
                    if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)]
    except (json.JSONDecodeError, OSError) as e:
        log.debug("history seed failed: %s", e)
    with _history_lock:
        _history.setdefault(sender, msgs[-HISTORY_TURNS:])


def _record_assistant_only(sender: str, tenant: str, reply: str) -> None:
    """An outbound with no inbound attached (episode receipts): history + transcript,
    without fabricating an empty user turn in the durable record."""
    _seed_history(sender, tenant)
    with _history_lock:
        hist = _history.setdefault(sender, [])
        hist.append({"role": "assistant", "content": reply})
        del hist[:-HISTORY_TURNS]
    try:
        import rail
        path = _transcript_path(tenant)
        msgs = json.loads(open(path).read()) if os.path.exists(path) else []
        msgs.append({"role": "assistant", "content": reply,
                     "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                     "transport": rail.provider()})
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(msgs, f)
        os.replace(tmp, path)
    except Exception as e:
        log.debug("assistant-only transcript append failed: %s", e)


def _record_turn(sender: str, tenant: str, user_text: str, reply: str,
                 mirror_outbound: bool = True) -> None:
    """One exchange → BOTH the in-memory history and the durable transcript (the engine must see LINE and
    ack turns later, in this process and in the next one)."""
    if (reply or "").strip() == "[SILENCE]":
        reply = "(read it; chose not to reply)"          # the choice is the record, not the token
    # The router's own lines ("got it. tomorrow.") never pass an engine, so they reach the belt here —
    # otherwise the app reads them back out of the transcript with the period still on.
    reply = _belt(reply)
    _seed_history(sender, tenant)
    with _history_lock:
        hist = _history.setdefault(sender, [])
        now_ts = time.time()
        hist.append({"role": "user", "content": user_text, "ts": now_ts})
        hist.append({"role": "assistant", "content": reply, "ts": now_ts})
        del hist[:-HISTORY_TURNS]
    _append_transcript(user_text, reply, tenant, "app" if not mirror_outbound else None)


class AppTurnBusy(Exception):
    """The same native turn is already running and still owns its execution lease"""


def _app_turn_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(APP_TURN_DB), exist_ok=True)
    db = sqlite3.connect(APP_TURN_DB, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""
        CREATE TABLE IF NOT EXISTS app_turns (
            tenant TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            text_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending','complete','failed')),
            reply TEXT,
            updated_at REAL NOT NULL,
            PRIMARY KEY (tenant, turn_id)
        )
    """)
    return db


def _claim_app_turn(tenant: str, turn_id: str, text: str) -> Optional[str]:
    """Claim before inference, return a completed reply on retry, or raise while a live owner runs"""
    digest = hashlib.sha256(text.encode()).hexdigest()
    now = time.time()
    db = _app_turn_connection()
    try:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT text_hash,status,reply,updated_at FROM app_turns WHERE tenant=? AND turn_id=?",
            (tenant, turn_id),
        ).fetchone()
        if row is None:
            db.execute(
                "INSERT INTO app_turns(tenant,turn_id,text_hash,status,updated_at) VALUES(?,?,?,'pending',?)",
                (tenant, turn_id, digest, now),
            )
            db.commit()
            return None
        prior_hash, status, reply, updated_at = row
        if prior_hash != digest:
            raise ValueError("turn_id_reused_with_different_text")
        if status == "complete" and reply:
            db.commit()
            return str(reply)
        if status == "pending" and now - float(updated_at) < APP_TURN_LEASE_SECONDS:
            raise AppTurnBusy(turn_id)
        db.execute(
            "UPDATE app_turns SET status='pending',reply=NULL,updated_at=? WHERE tenant=? AND turn_id=?",
            (now, tenant, turn_id),
        )
        db.commit()
        return None
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _complete_app_turn(tenant: str, turn_id: str, reply: str) -> None:
    db = _app_turn_connection()
    try:
        db.execute(
            "UPDATE app_turns SET status='complete',reply=?,updated_at=? WHERE tenant=? AND turn_id=?",
            (reply, time.time(), tenant, turn_id),
        )
        db.commit()
    finally:
        db.close()


def _release_app_turn(tenant: str, turn_id: str) -> None:
    db = _app_turn_connection()
    try:
        db.execute(
            "UPDATE app_turns SET status='failed',updated_at=? WHERE tenant=? AND turn_id=? AND status='pending'",
            (time.time(), tenant, turn_id),
        )
        db.commit()
    finally:
        db.close()


# sendblue_mark_read() REMOVED (8/7). It POSTed to /api/mark-as-read, a route that does not exist:
# OPS.md 8/1 recorded the probe result ("READ RECEIPTS: confirmed impossible on Sendblue ... DELIVERED
# is terminal, no mark-as-read API") but the caller stayed. Every inbound 404'd once, flipped a dead
# flag, and went quiet forever, which is why the thread never showed Read. The tapback is the read
# receipt in both directions. True 'Read' needs the BlueBubbles transport, which is an architecture
# decision, not a patch. NOTE: this is the OUTBOUND direction only. The status_callback in
# sendblue_send still collects READ from their handset and still feeds the proactive gate.


def sendblue_typing(number: str, max_ms: int = 45000) -> None:
    """Fire-and-forget typing indicator (docs: POST /api/send-typing-indicator, auto-stops on send or
    after max_duration_ms). Runs on a daemon thread so it never adds latency to the reply path."""
    def go():
        try:
            import rail
            if rail.provider() == "linq":
                rail.linq_typing(number)
                return
            body = {"number": number, "max_duration_ms": max_ms}
            if SENDBLUE_FROM_NUMBER:
                body["from_number"] = SENDBLUE_FROM_NUMBER
            requests.post("https://api.sendblue.com/api/send-typing-indicator", json=body, timeout=10,
                          headers={"sb-api-key-id": SENDBLUE_API_KEY_ID,
                                   "sb-api-secret-key": SENDBLUE_API_SECRET,
                                   "Content-Type": "application/json"})
        except Exception as e:
            log.debug("typing indicator failed: %s", e)
    threading.Thread(target=go, daemon=True).start()


# iMessage tapback types (docs: POST /api/send-reaction; love|like|dislike|laugh|emphasize|question).
# Tone-mapped from the same signal as the text-emoji ack: hype → emphasize, heavy → love, funny → laugh.
# NO 'like' (8/7): a thumbs-up is the limpest thing you can say back to someone, and since Sendblue has
# no mark-as-read API the tapback IS the read receipt, so this fires on essentially everything. Only
# emphasize and love (and laugh, when it's actually funny) read as a person on the other end.
#   OVERRULED IN PART (9/5). 8/7's objection was that 👍 fires on everything and therefore says
#   nothing. It is now the FLOOR of a two-mark deposit sequence — 👍 received, 👀 read — so the
#   information is in the difference, which is what 8/7 actually asked for. The limpness charge
#   stood while 👍 was the whole answer; it is not, and the alternative shipped since 8/26 was
#   nothing at all. What survives 8/7 unchanged: 👍 is never a REPLY, and never a text bubble.
_LAUGH_RE = re.compile(r"\b(lol|lmao|lmfao|haha|hahaha)\b|😂|💀", re.I)


def sendblue_react(message_handle: str, reaction: str, emoji: str = "") -> bool:
    """Send a tapback to a specific inbound message. False on any failure → caller falls back to text."""
    if not message_handle:
        return False
    import rail
    if rail.provider() == "linq":
        # Linq carries arbitrary unicode as a real reaction, so the eyes can finally BE a tapback
        # instead of a text pretending to be one. Sendblue has six fixed types and no custom slot,
        # so it takes the mapped fallback and loses the glyph.
        return rail.linq_react(message_handle, reaction, emoji=emoji)
    try:
        body = {"message_handle": message_handle, "reaction": reaction}
        if SENDBLUE_FROM_NUMBER:
            body["from_number"] = SENDBLUE_FROM_NUMBER
        r = requests.post("https://api.sendblue.com/api/send-reaction", json=body, timeout=10,
                          headers={"sb-api-key-id": SENDBLUE_API_KEY_ID,
                                   "sb-api-secret-key": SENDBLUE_API_SECRET,
                                   "Content-Type": "application/json"})
        r.raise_for_status()
        log.info("tapback %s → message %s…", reaction, message_handle[:8])
        return True
    except Exception as e:
        log.debug("tapback failed (falling back to text ack): %s", e)
        return False


# THE TAPBACK VOCABULARY (8/26). A reaction used to mirror the member's MOOD, which meant almost
# everything got ‼️ — an exclamation on every deposit says nothing, and a signal that fires always
# is not a signal. It now reports what co DID with the thing, in the cheapest message there is:
#
#   👍 like       "cool, saw it" — and that is the WHOLE answer. Never beside words.
#   👀 eyes       "huh, that's new" — a source co has never seen from them. May come with words.
#   ‼️ emphasize  on it. co is acting, expect something back.
#   ❓ question   co could not read it, or could not tell what was wanted.
#   😂 laugh      it was a joke.
#   ❤️ love       a hard day, a personal moment. warmth, not filing.
#
# REDRAWN 9/8 (founder: "there should not be a thumbs up for every content ... thumbs up alone is
# enough signal"). 8/26 and 9/5 both read the marks as RECEIPTS — stages of co's own processing,
# so they fired on every send and stacked in front of whatever co then said. Two corrections:
#
#   👍 is terminal, not a stage. It is the cheapest complete reply there is, and it only means that
#     while nothing follows it. Sent at receipt it was a guess about a ladder that had not run yet,
#     and on every turn that went on to answer, the guess was wrong. It now fires from the branch
#     that CHOSE silence (mark_received), so it is never a prediction and never precedes words.
#
#   👀 is surprise, not read-success. Reading is what co does with everything, so a mark that
#     reports it fires always — 8/7's objection to the thumbs-up, wearing a better glyph. It now
#     means the send is out of the ordinary FOR THEM (co_react.novel_source: a host they have
#     never sent), which is a thing about them, decided at receipt, and free to sit beside a reply.
#
# Sendblue has six fixed types (👎 exists and co never uses it) and no custom slot, so the eyes do
# not ship there at all and the send takes the ordinary mark — see eyes_worthy. Linq
# carries arbitrary unicode as a real reaction, which is what makes the eyes a mark on their
# message instead of a text bubble pretending to be one.
_ASK_RE = re.compile(
    r"\b(remind|watch|track|keep an eye|find|look (?:in)?to|dig|book|hold|cancel|kill|"
    r"draft|set up|follow up|chase|check on)\b", re.I)

# A URL IS NOT SOMETHING THEY SAID (9/8). Every predicate below reads the member's words, and a
# link is not words — it is a path someone else chose. _ASK_RE matched the literal "watch" in
# youtube.com/watch and "track" in open.spotify.com/track, so EVERY youtube and spotify deposit
# wore ‼️ "on it, expect something back" and was then met with silence. The same class bit the
# 9/8 `owed` check, where a "?" in ?si= or ?utm_source= read as a question co had failed to
# answer. Strip once, here, so a new predicate cannot reintroduce it.
# A superset of link_read.URL_RE on purpose: that one requires a scheme, and members paste bare
# "www.youtube.com/watch?v=…" constantly. Greedy to whitespace, which can only ever REMOVE a
# trigger, never invent one — safe by construction for every predicate below.
_URL_RE = re.compile(r"https?://\S+|\bwww\.\S+", re.I)


def words_only(text: str) -> str:
    return _URL_RE.sub(" ", text or "")


def pick_tapback(text: str, action: str = "received") -> str:
    """action: received | acting | unclear. Tone still wins for jokes and hard days — those are
    replies to a person, not receipts for a job.

    SILENCE IS NOT A MARK (9/5, founder, on a paper he sent that got nothing back: "the reason i
    felt ignored is because there was literally no reaction"). 8/26 returned "" for a plain
    deposit and the caller sent nothing at all, reasoning that a mark firing on everything is not
    a signal. The restraint half of that ruling stands and is the point — co must not reply to
    everything. The silent half rested on a premise that is now false: it said "Sendblue has no
    mark-as-read API … so the member sees NO read indicator on their own sends either", and co
    moved to Linq, which marks read and carries custom-emoji reactions. What the deposit needed
    was never a reply, it was an acknowledgement, and the ladder can give one for free.

    So a deposit is acknowledged. WHEN is the 9/8 correction: this returns the deposit's mark, it
    does not decide that the deposit gets one. `like` here means "if co ends up saying nothing,
    this is the mark" — the content path holds it back until the ladder has actually declined to
    speak, because "cool, saw it" is only true when nothing follows it."""
    t = words_only(text)
    if _LAUGH_RE.search(t):
        return "laugh"
    import co_react
    tone = co_react._light_emoji(t)
    if tone == "😮‍💨":                               # a hard day gets warmth, never a receipt
        return "love"
    if action == "unclear":
        return "question"
    # ‼️ is co animated: either it is on the job, or he just won. Which one is obvious from
    # whether he asked for anything, the same way it is between two people.
    if action == "acting" or tone == "🔥" or _ASK_RE.search(t):
        return "emphasize"
    return "like"  # a deposit is filed, and says so: see SILENCE IS NOT A MARK above


EYES = "👀"        # the surprise mark. Linq sends it as itself; Sendblue has no custom slot.


def eyes_worthy(text: str, memory_path: str) -> bool:
    """Is this send out of the ordinary FOR THEM? A host they have never sent co before.

    LINQ ONLY. Sendblue drops the emoji argument, so the eyes would arrive as a plain 'like' — not
    a degraded glyph but the wrong sentence, since 👍 is terminal and 👀 is not. It would also be a
    repeat tap of a type that may already be on the message, and Apple's wire format sends REMOVE
    for that, so the worst case deletes the mark. Unmeasured against the live API; this file's
    standard is "Measured instead of assumed" (rail.py), so it stays on the rail that can carry it.

    Never the reason a turn dies: a novelty check that raises must cost the eyes, never the send."""
    try:
        import rail
        if rail.provider() != "linq":
            return False
        import co_react
        return co_react.novel_source(text, memory_path)
    except Exception as e:
        log.debug("novelty check failed, no eyes: %s", e)
        return False


def will_speak(text: str, media_urls: List[str]) -> bool:
    """Is this a turn co is likely to answer IN WORDS?

    TYPING IS A PROMISE (8/26): the indicator runs up to 45s on Sendblue, has no duration and no
    stop call at all on Linq, and auto-stops only on a send — so firing it for a turn that ends in
    a tapback shows a bubble that resolves into silence, which is strictly worse than silence
    because it promised. One predicate, because the guard was in two places and the second one
    (_process, every inbound in MODE co) fired unconditionally and defeated the first.

    A PREDICTION, NOT THE LADDER, and that is a real cost: it is a second place that has to know
    what _content_respond will do, and it will drift. It is not free to remove — the indicator has
    to fire BEFORE the read and the engine, which is exactly when the answer is not known yet. So
    it is deliberately biased toward True: a missing bubble on a turn that speaks is a latency
    complaint, an extra bubble on a turn that does not is a broken promise, and only one of those
    is the bug 9/5 was about. Anything unsure belongs on the True side.

    Text with no link and no attachment always reaches the engine (the TEXT-ONLY FAST PATH answers
    it), so the only turns that can end in a mark are content sends — and of those, a question, an
    ask, an explain-ask (the deep watch, the slowest speaking path there is), a content question,
    or an attachment all still earn words."""
    try:
        import link_read
        t = text or ""
        if not media_urls and not link_read.find_urls(t):
            return True
        return bool(media_urls) or "?" in t or pick_tapback(t) == "emphasize" \
            or bool(_EXPLAIN_RE.search(t)) or bool(_CONTENT_Q_RE.search(t))
    except Exception as e:
        # Never the reason a turn dies: this runs in _process ABOVE the try that owns the floor
        # ack, and _flush_burst's wrapper is try/finally with no except, so a raise here would
        # take the whole reply with it. Fail toward the bubble — the old behaviour.
        log.warning("will_speak failed, assuming words: %s", e)
        return True


# Inbound tapbacks: Sendblue has NO reaction webhook event (verified docs 7/2) — but tapbacks from some
# clients arrive as the Apple TEXT fallback ('Loved "…"'). Detect those, log as first-class signal
# (a ❤️ on a line = wow-confirmation; a 👎 = miss), never reply — reacting to a reaction is bot behavior.
_INBOUND_TAPBACK_RE = re.compile(
    r'^\s*(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)\s+[“"](.{1,120})[”"]\s*$')


def log_inbound_reaction(tenant: str, kind: str, target: str, claims_db: str) -> None:
    try:
        import co_react
        co_react.remember(target[:150], "reaction_in", kind.lower(), "", "other",
                          path=f"{claims_db}.co_memory.db")
    except Exception as e:
        log.debug("reaction ledger write failed: %s", e)
    _log_timing(tenant, "inbound_reaction", time.time(), {"reaction": kind.lower(), "target": target[:80]})


def _beat_overlap(a: str, b: str) -> float:
    """Token overlap between two beats (echo detection: the tool-split accumulation can emit the model's
    restarted sentence twice — 'the job arrives before monday does' bug, 7/2)."""
    tok = lambda s: {w for w in re.sub(r"[^a-z0-9\s']", " ", s.lower()).split() if len(w) > 2}  # noqa: E731
    A, B = tok(a), tok(b)
    if not A or not B:
        return 0.0
    return len(A & B) / min(len(A), len(B))


def send_reply(to_number: str, reply: str) -> None:
    """Send a reply as 1-3 texts: blank-line beats become separate messages (texting-native). Consecutive
    beats sharing >60% tokens are echoes — the duplicate is dropped, never sent."""
    parts = [p.strip() for p in reply.split("\n\n") if p.strip()][:3]
    deduped = []
    for p in parts:
        if deduped and _beat_overlap(deduped[-1], p) > 0.6:
            log.info("dropped echo beat: %r", p[:60])
            continue
        deduped.append(p)
    for p in deduped or [reply]:
        sendblue_send(to_number, p)


# co_react scores every inbound and then the engine ignores it. On 9/2 the gate said, verbatim,
# "topical match, not a behavioral claim — a glance, never the vague read", and the engine went on to
# assert a four-day-old typography commitment that never existed, twice, and then a "you're still
# avoiding naming your own domain" the next morning about an assignment co had made up itself.
# The tier was LIGHT both times, so muting NONE (the obvious fix) would have silenced the GeeLark
# answer and the retraction and left both nags standing. The verdict is the constraint, not the tier.
def verdict_hint(r: dict) -> str | None:
    """What co_react decided, turned into something the engine is bound by."""
    if not r or r.get("tier") == "line":
        return None
    # Short on purpose. The first version of this ran 500 characters, which is exactly the engine's
    # hint ceiling, so every turn that also carried a promise or a recall hint 422'd — and a 422
    # means ask_engine returns nothing and the floor below texts a bare eyes emoji over the outage.
    return ("NO READ THIS TURN (gate: " + str(r.get("tier")) + "). Do not name a pattern about them "
            "or assert what they have or haven't done. Never hold them to something YOU proposed. "
            "Add, answer, or react.")


def join_hint(*parts) -> str | None:
    live = [p for p in parts if p]
    return "\n".join(live) if live else None


def ask_engine(sender: str, user_text: str, tenant: str, record_history: bool = True,
               hint: Optional[str] = None, mirror_outbound: bool = True) -> Optional[str]:
    """One turn against the unified engine (:8090). model='co' selects the Co texting disposition for
    every tenant; relationship depth changes authority, never the door manner. `hint` = situational
    directives (a stored promise, recall, the sharing act) stacked for this turn."""
    _seed_history(sender, tenant)
    with _history_lock:
        hist = _history.setdefault(sender, [])
        prior = list(hist[-HISTORY_TURNS:])
    # elapsed time and THEIR local clock, on the turns where it carries meaning
    import journal as _jn
    prior = _stamp_history(prior, _jn._claims_db(tenant))
    messages = prior + [{"role": "user", "content": user_text}]
    # The runtime compatibility boundary needs a stable relationship key. The
    # incumbent brain ignores unknown OpenAI fields, so this is rollback-safe.
    body = {"model": "co", "messages": messages, "stream": False, "user": tenant,
            "peer_id": sender}
    try:                                   # the late-recovery register: a paid debt, not a live turn
        with _sb_seen_lock:
            _rec_when = _recovery_note.pop(_norm(sender), None)
        if _rec_when:
            rec = (f"RECOVERED MESSAGES: what they sent above was sent {_rec_when}Z but only "
                   f"reached you now (overnight delivery drop on our side). Own the lateness in "
                   f"ONE short beat, reply as ONE message, and ask NO questions — the moment has "
                   f"passed. If something deserves more, leave the door open without asking.")
            hint = f"{rec}\n{hint}" if hint and len(rec) + len(hint) < 480 else rec
    except Exception:
        pass
    if hint:
        # The engine bounds co_hint by BYTES (engine-compat.ts `bounded`, Buffer.byteLength), not
        # characters. Clamping by character count and then appending a 3-byte ellipsis produced a
        # 502-byte hint from a 500-char budget, so the clamp itself caused the 422 it existed to
        # prevent — observed live 9/6 09:31 ("hint clamped 627→500" immediately followed by
        # "co_hint is invalid"). A 422 here is total: no reply at all, then a retry with no hint.
        # Trim on the byte budget and keep the marker inside it. The verdict constraint leads the
        # string, so a trim takes the situational tail and keeps the law.
        raw = hint.encode()
        if len(raw) > MAX_HINT:
            hint = raw[:MAX_HINT - 3].decode("utf-8", "ignore").rstrip() + "..."
            log.warning("hint clamped %d→%d bytes", len(raw), len(hint.encode()))
        body["co_hint"] = hint
    try:                                   # the register dial (modes.py): delivery/capture tenants
        import modes as _modes             # get a mode law appended engine-side; thread = no-op
        _m = _modes.get(tenant)
        if _m != "thread":
            body["mode"] = _m
    except Exception:
        pass
    try:
        import session_compact
        block = session_compact.context_block(_transcript_path(tenant)) or ""
        sty = _style_block(tenant)
        if sty:
            block = f"{sty}\n\n{block}".strip()    # standing orders ride the session block (engine caps 4000)
        if block:
            body["session"] = block[:4000]
    except Exception as e:
        log.debug("session block unavailable: %s", e)
    try:
        endpoint = _engine_url(tenant)
        r = requests.post(endpoint, json=body, headers=ENGINE_HEADERS, timeout=WITNESS_TIMEOUT)
        r.raise_for_status()
        reply = (r.json()["choices"][0]["message"]["content"] or "").strip()
    except Exception as e:
        log.exception("engine call failed for tenant-bound endpoint: %s", e)
        return None
    if not reply:
        return None
    # The belt at the reply's BIRTH, not at the wire: this one string becomes the transcript the app
    # reads, the native chat response, and the iMessage send. Sanitizing only in sendblue_send left the
    # app showing the version with the dash and the period still in it.
    reply = _belt(reply)
    if record_history:
        with _history_lock:
            hist = _history.setdefault(sender, [])
            hist.append({"role": "user", "content": user_text})
            hist.append({"role": "assistant", "content": reply})
            del hist[:-HISTORY_TURNS]
    _append_transcript(user_text, reply, tenant, "app" if not mirror_outbound else None)
    # Native app turns are recorded by co-api. iMessage is mirrored by sendblue_send only after the
    # carrier returns a message handle, so delivery/read callbacks can join the exact row.
    return reply


# ----------------------------- the co loop ----------------------------------
def _claim_count(claims_db: str) -> int:
    import sqlite3
    if not os.path.exists(claims_db):
        return 0
    try:
        c = sqlite3.connect(f"file:{claims_db}?mode=ro", uri=True)
        n = c.execute("SELECT COUNT(*) FROM claims WHERE COALESCE(status,'active')!='retired'").fetchone()[0]
        c.close()
        return int(n)
    except Exception:
        return 0


def _user_turns(tenant: str) -> int:
    p = _transcript_path(tenant)
    try:
        msgs = json.loads(open(p).read()) if os.path.exists(p) else []
        return sum(1 for m in msgs if m.get("role") == "user")
    except (json.JSONDecodeError, OSError):
        return 0


def _is_onboarded(tenant: str, claims_db: str) -> bool:
    return _claim_count(claims_db) >= ONBOARDED_CLAIMS or _user_turns(tenant) >= ONBOARDED_TURNS


# ----------------------------- bookkeeping (synchronous, post-reply) --------
# journal.capture + threads.update are bookkeeping: they feed the NEXT turn, never this one. Cycle 1 moved
# them off the reply path (a Gemini 503 storm gated a stranger's first "hey" for 108s); cycle 3 killed the
# daemon queue after it proved VOLATILE (one-process-per-webhook and router restarts dropped queued jobs —
# Saga/threads silently lost). Now: run synchronously AFTER the reply has gone out, inside the same request
# handler (and the per-sender lock), so durability is guaranteed and user latency is still unaffected.
def _bookkeep_sync(tenant: str, claims_db: str, text: str, enrichment: Optional[str], do_capture: bool) -> None:
    t0 = time.time()
    stages = {}
    if do_capture:
        t = time.time()
        try:
            import journal
            journal.capture(tenant, text)                # Saga + flywheel feed (+ link_read, no-op on plain text)
        except Exception as e:
            log.warning("capture failed (bookkeeping): %s", e)
        stages["capture_ms"] = int((time.time() - t) * 1000)
    t = time.time()
    try:
        import threads
        threads.update(claims_db, text, enrichment)      # the rolling open-threads state (Gemini, can stall)
    except Exception as e:
        log.debug("threads update failed (bookkeeping): %s", e)
    stages["threads_ms"] = int((time.time() - t) * 1000)
    try:
        # CATCH THE CORRECTION IN CONVERSATION (8/6). The machinery below has always been
        # right and always been empty: its only writer was the viewer's flag/edit UI, and the
        # viewer is dead — zero rows on every graph on the box. So "no, A7 V not IV" and
        # "i'm currently in eastern time" reached nothing. This is the missing writer, and it
        # runs BEFORE process() so a correction caught this turn is honoured this turn.
        import correction_detect
        note = correction_detect.scan(claims_db, text, enrichment or "")
        if note:
            log.info("%s (tenant=%s)", note, tenant)
    except Exception as e:
        log.debug("correction detect failed: %s", e)
    try:
        import correction_ingest
        done = correction_ingest.process(claims_db)      # honor viewer flags/edits (user = first-class)
        if done:
            log.info("corrections: %s", "; ".join(done))
    except Exception as e:
        log.debug("correction ingest failed: %s", e)
    try:
        import anchors
        n = anchors.extract(claims_db, text)             # timed things in their life → callback anchors
        if n:
            log.info("anchors: %d extracted from this send", n)
    except Exception as e:
        log.debug("anchor extract failed: %s", e)
    t = time.time()
    try:
        import session_compact
        session_compact.compact(_transcript_path(tenant))   # rolling arc memory (fold when window overflows)
    except Exception as e:
        log.debug("session compaction failed: %s", e)
    stages["compact_ms"] = int((time.time() - t) * 1000)
    _log_timing(tenant, "bookkeeping", t0, stages)


VISION_FAIL_LINE = "can't see images right now, on me. what was it?"
AUDIO_FAIL_LINE = "can't listen to voice notes right now, on me. what'd you say?"
_AUDIO_EXT = (".m4a", ".caf", ".amr", ".mp3", ".wav", ".aac", ".ogg")
VISION_FAIL_COOLDOWN_S = 600


def _vision_fail_allowed(claims_db: str) -> bool:
    """ONE failure line per cooldown window; repeats are silence (never 'send it again', never twice)."""
    import pathlib
    p = pathlib.Path(f"{claims_db}.visionfail")
    now = time.time()
    try:
        if p.exists() and now - float(p.read_text().strip() or 0) < VISION_FAIL_COOLDOWN_S:
            return False
    except (ValueError, OSError):
        pass
    try:
        p.write_text(str(now))
    except OSError:
        pass
    return True


def _log_send(text: str, memory_path: str, tier: str, reaction: str) -> None:
    """Record a send in co_memory even on paths where react() doesn't run (onboarding) — the
    deterministic run counter needs EVERY send text in the ledger."""
    try:
        import co_react
        co_react.remember(text, tier, reaction, "", co_react._theme(text), path=memory_path)
    except Exception as e:
        log.debug("send log failed: %s", e)


def _memory_unreachable(hint: Optional[str]) -> Optional[str]:
    """Tell the engine the LOOKUP failed — never hand it silence and let it infer amnesia.

    8/6: six consecutive 429s blew the recall gate's latency budget, the guard dropped recall,
    and co told the founder "i don't have anything from before this session, no. each
    conversation starts fresh for me on that side" — while holding 29,452 claims and months of
    transcript. The guard's own docstring says "a missed recall costs nothing." It cost the
    single worst sentence the product can produce.

    Silence and "no history" are indistinguishable to a model. This makes them distinguishable.
    """
    line = ("[MEMORY LOOKUP TIMED OUT this turn — a slow call, nothing more. You DO have long "
            "history with this person and it is intact; you simply could not reach it in time. "
            "NEVER say you have no memory, that you start fresh, or that sessions don't carry "
            "over — that is false and it is the worst thing you can tell them. Answer from what "
            "is in front of you, or say you're pulling it up and come back.]")
    return f"{hint}\n{line}" if hint else line


def _start_recall(tenant: str, text: str, sender: str = ""):
    """Kick the recall pass on a worker thread so it overlaps co_react + engine prep instead of
    serializing in front of the reply (system-review #2: the blocking gate tripled p50). Returns a
    join(hint) callable; a gate still pending at join time SKIPS recall this turn — a missed recall
    costs nothing, a slow reply costs trust."""
    import queue
    box: "queue.Queue" = queue.Queue(maxsize=1)

    def _work():
        try:
            import return_engine as _re
            _re.record_reaction(tenant, text)
            # a pending episode outranks recall: their message may be the yes/no it waits on
            try:
                import episode_engine as _ee
                if _ee.pending(tenant):
                    j = _ee.judge_reply(tenant, text)
                    if j and j["verdict"] == "yes":
                        log.info("EPISODE approved (tenant=%s): %s", tenant, j["episode"]["what"][:60])
                        box.put(("ok", {"kind": "episode_hint", "line":
                            f"[EPISODE APPROVED — they just said yes to: \"{j['episode']['what'][:100]}\". "
                            f"Reply ONE short line that you're on it — the receipt with what checked out "
                            f"arrives as your NEXT message. Do NOT state findings yet.]"}))
                        eid, ewhat = j["episode"]["id"], j["episode"]["what"]

                        def _do_episode():
                            try:
                                receipt = _ee.execute(tenant, eid)
                                if not receipt:
                                    receipt = ("hit a wall verifying the live details just now — "
                                               "the plan stands as proposed. i'll take another run "
                                               "at the missing pieces.")
                                if sender:
                                    sendblue_send(sender, receipt)
                                    _record_assistant_only(sender, tenant, receipt)
                                _ee.complete(tenant, eid, receipt)
                                log.info("EPISODE receipt delivered (tenant=%s): %s", tenant, ewhat[:60])
                            except Exception as e:
                                log.warning("episode execute failed: %s", e)

                        threading.Thread(target=_do_episode, daemon=True).start()
                        return
                    if j and j["verdict"] == "no":
                        log.info("EPISODE declined (tenant=%s)", tenant)
                        box.put(("ok", {"kind": "episode_hint", "line":
                            "[They declined the pending episode. Acknowledge in one short line and let it "
                            "go completely — a no is a clean answer, never salvage or renegotiate.]"}))
                        return
            except Exception as e:
                log.warning("episode judge skipped: %s", e)
            import find_engine as _fe
            try:
                box.put(("ok", _fe.recall(tenant, text)))
            except _fe.RecallUnavailable as e:
                box.put(("unavailable", str(e)))
        except Exception as e:
            box.put(("err", str(e)))

    threading.Thread(target=_work, daemon=True).start()

    def join(hint, timeout: float = 12.0):   # make_real plans take longer than gate verdicts
        try:
            kind, res = box.get(timeout=timeout)
        except Exception:
            log.warning("recall skipped: gate still pending at join (latency guard)")
            return _memory_unreachable(hint)
        if kind == "unavailable":
            log.warning("recall UNAVAILABLE: %s", res)
            return _memory_unreachable(hint)
        if kind == "err" or not res:
            if kind == "err":
                log.warning("recall skipped: %s", res)
            else:
                log.info("recall:none")
            return hint
        import find_engine as _fe
        if res.get("kind") == "episode_hint":
            return f"{hint}\n{res['line']}" if hint else res["line"]
        if res.get("kind") == "commission":
            # commissioned research (kyo research.py pattern): search NOW, deliver on the promised
            # day off the requested-anchor rail. The confirm rides as a hint — co promises in voice.
            import research_engine as _rs
            c = _rs.commission(tenant, text)
            if c:
                log.info("RESEARCH commissioned (tenant=%s, due=%s): %s", tenant, c["due"][:16], c["topic"][:60])
                cline = (f"[RESEARCH COMMISSIONED — you'll dig into \"{c['topic'][:90]}\" and report back "
                         f"{c['due'][:10]}. Confirm in ONE line, your voice: what you're looking into and "
                         f"when they'll hear back. {'Findings were thin so far — be honest that you may come back light. ' if c.get('thin') else ''}"
                         f"No tour, no plan-listing.]")
                return f"{hint}\n{cline}" if hint else cline
            return hint
        if res.get("kind") == "make_real":
            # MAKE REAL (7/29): compile the ask into a decision packet. The packet is a WORK PRODUCT
            # — delivered verbatim (deterministic), never paraphrased by the engine. One pending
            # episode at a time; their next relevant message is judged approve/decline.
            import episode_engine as _ee
            try:
                import session_compact
                ctx = session_compact.context_block(_transcript_path(tenant)) or ""
            except Exception:
                ctx = ""
            prop = _ee.propose(tenant, text, context=ctx)
            if prop and prop.get("already_open"):
                return f"{hint}\n[ONE EPISODE AT A TIME — \"{prop['what'][:80]}\" is still waiting on their yes/no. Say so in one line and ask which they want.]" if hint else \
                       f"[ONE EPISODE AT A TIME — \"{prop['what'][:80]}\" is still waiting on their yes/no. Say so in one line and ask which they want.]"
            if prop and prop.get("packet"):
                log.info("EPISODE proposed (tenant=%s): %s", tenant, prop["what"][:60])
                return ("__DIRECT_SEND__" + prop["packet"])
            return hint
        if res.get("kind") == "watch":
            import watch_engine as _we
            w = _we.create(tenant, text)
            if w and w.get("line"):
                return f"{hint}\n[{w['line']}]" if hint else f"[{w['line']}]"
            if w:
                log.info("WATCH created (kind=%s): %s", w["kind"], w["what"][:60])
                wline = (f"[WATCH CREATED — you are now watching: \"{w['what']}\" (fires when: "
                         f"{w.get('care') or 'material change'}). Confirm in ONE line, your voice, no tour.]")
                return f"{hint}\n{wline}" if hint else wline
            return hint
        log.info("recall:%s (corpus=%d)", res.get("kind"), res.get("n", 0))
        line = _fe.hint_line(res)
        return f"{hint}\n{line}" if hint else line

    return join


def _add_recall(tenant: str, text: str, hint):
    """THE RETURN (goal.md A1/A10): hand back something they sent weeks ago when it lands, folded into
    the reply they were already getting — never a push, so it can't trip quiet hours or the cap (§18).

    Two things happen here, in this order, and the order matters: the PREVIOUS return gets its verdict
    from this message (their reaction is the label — the reward signal the corrections table never had),
    and only then do we look for a new one. Never raises: a broken return costs nothing but itself."""
    try:
        import return_engine as _re
        _re.record_reaction(tenant, text)                    # their reaction labels the last recall

        import find_engine as _fe
        try:
            res = _fe.recall(tenant, text)
            if res and res.get("kind") == "watch":
                # WATCH: the mandate verb (docs/watch-architecture.md). Create it NOW, confirm in
                # voice via hint. A promise made must be a row, not a vibe.
                import watch_engine as _we
                w = _we.create(tenant, text)
                if w and w.get("line"):
                    return f"{hint}\n[{w['line']}]" if hint else f"[{w['line']}]"
                if w:
                    log.info("WATCH created (tenant=%s, kind=%s): %s", tenant, w["kind"], w["what"][:60])
                    wline = (f"[WATCH CREATED — you are now watching: \"{w['what']}\" "
                             f"(fires when: {w.get('care') or 'material change'}). Confirm it in ONE "
                             f"line in your voice — what you're watching and what you'll ping them "
                             f"about. No feature tour.]")
                    return f"{hint}\n{wline}" if hint else wline
                return hint
        except _fe.RecallUnavailable as e:
            # 7/27: this was the whole bug. A rate-limited gate returned {} and read as "nothing to
            # recall", at log.debug — invisible at INFO. So recall looked like considered restraint
            # while it was actually never running. A capability that cannot be distinguished from
            # silence when it breaks is a capability you do not have.
            log.warning("recall UNAVAILABLE (tenant=%s): %s", tenant, e)
            return hint
        if not res:
            log.info("recall:none (tenant=%s)", tenant)      # the common answer, but say so out loud
            return hint
        log.info("recall:%s (tenant=%s, corpus=%d)", res.get("kind"), tenant, res.get("n", 0))
        line = _fe.hint_line(res)
        return f"{hint}\n{line}" if hint else line
    except Exception as e:
        log.warning("recall skipped (tenant=%s): %s", tenant, e)
        return hint


def _dump_burst(tenant: str, text: str) -> bool:
    """True when THIS text is the 2nd+ substantive statement in a tight window — they're dumping,
    not conversing. Substantive = 40+ chars, no question, not a command. Window = 8 min."""
    t = (text or "").strip()
    if len(t) < 40 or "?" in t or t.lower().startswith(("invite ", "my wrapped")):
        return False
    try:
        msgs = json.loads(open(_transcript_path(tenant)).read())[-6:]
    except (OSError, json.JSONDecodeError):
        return False
    now = time.time()
    prior_user = [m for m in msgs if m.get("role") == "user"]
    if not prior_user:
        return False
    last = prior_user[-1]
    lt = (last.get("content") or "").strip()
    try:
        age = now - time.mktime(time.strptime(last.get("ts", ""), "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, OverflowError):
        return False
    return len(lt) >= 40 and "?" not in lt and age < 480


def _promise_hint(claims_db: str, text: str, hint):
    """THE PROMISE POSTCONDITION (8/5). Anchor extraction used to run in the AFTER-reply
    bookkeeping, so co composed "got it, pinging you at 8:30am" before any record existed —
    and when extraction silently dropped it, the promise evaporated (Justin, 8/4: "why didnt
    you ping me?"). For an EXPLICIT ask, the anchor is now created BEFORE the reply and the
    engine is told what was actually stored, so the confirmation quotes the record instead of
    the intention. Storage failure produces an honest reply instead of a false yes."""
    try:
        import anchors
        if not anchors.REQUEST_RE.search(text or ""):
            return hint
        before = {(a.get("what"), a.get("fire")) for a in anchors._load(claims_db)["anchors"]}
        anchors.extract(claims_db, text)
        made = [a for a in anchors._load(claims_db)["anchors"]
                if (a.get("what"), a.get("fire")) not in before]
        if made:
            a = made[0]
            when = a.get("fire", "")[:16].replace("T", " ")
            rep = f", repeating {a['repeat']}" if a.get("repeat") else ""
            line = (f"[PROMISE STORED — it is really in the book: \"{a.get('what','')}\" at {when}{rep}. "
                    f"Confirm in ONE short line and say the time back so they can catch a mistake.]")
        else:
            line = ("[PROMISE NOT STORED — you could not pin a time from that. Do NOT say you'll remind "
                    "them. Ask for the day/time in one short line instead.]")
        return f"{hint}\n{line}" if hint else line
    except Exception:
        return hint


def _co_reply(sender: str, tenant: str, text: str, media_urls: List[str], t_inbound: float,
              message_handle: str = "", burst_n: int = 1,
              deliver: Optional[Callable[[str], None]] = None) -> None:
    """The locked v1 loop. RULE: nothing runs before the reply except what PRODUCES the reply.
    Text-only → react/engine immediately (raw text); content → instant ack, ingest (the reaction needs the
    enrichment), react. All bookkeeping (capture/threads) runs synchronously AFTER the reply is out
    (durable across per-webhook processes and restarts). Delivery is an adapter: omitted means iMessage,
    while native chat supplies a collector and therefore cannot accidentally send through Sendblue."""
    import co_react
    import journal
    import link_read

    claims_db = journal._claims_db(tenant)
    # A new relationship may already have a SQLite file created by returns/episodes, without the
    # belief tables. Initialize by schema, never by file-existence, before any parallel reader starts
    import claimstore
    _claims_conn = claimstore.connect_path(claims_db)
    _claims_conn.close()
    memory_path = f"{claims_db}.co_memory.db"

    # "not tonight" mutes tonight's proactive surfaces (call + daily text), then we stop. (~1ms, stays first.)
    try:
        import scheduler
        if scheduler.is_skip_phrase(text):
            scheduler.set_skip(tenant=tenant)
            reply = "got it. tomorrow."
            if deliver:
                deliver(reply)
            else:
                sendblue_send(sender, reply)
            _record_turn(sender, tenant, text, reply, mirror_outbound=deliver is None)
            _log_timing(tenant, "skip_ack", t_inbound)
            return
    except Exception as e:
        log.debug("skip-phrase check unavailable: %s", e)

    # Standing style orders (~0ms regex): "shorter" / "stop asking questions" persists BEFORE this reply.
    try:
        _style_note(claims_db, text)
    except Exception as e:
        log.debug("style note failed: %s", e)

    # Dynamic timezone (7/2): "i'm in DC" / "just landed in london" / "set my timezone to X" moves the
    # tenant's clock BEFORE this reply is produced (regex gate is ~0ms; the resolver only runs on a hit).
    try:
        import tz_dynamic
        moved = tz_dynamic.update_from_text(claims_db, text)
        if moved:
            log.info("tenant %s timezone → %s", tenant, moved)
    except Exception as e:
        log.debug("tz detect failed: %s", e)

    relationship_known = _is_onboarded(tenant, claims_db)
    onboarded = True                              # no cold-open flow on product surfaces
    has_content = bool(media_urls) or bool(link_read.find_urls(text))

    # Runs for every deposit, ahead of the branches, because the asks worth staging are usually
    # plain text and the no-content branch returns long before the content path.
    def _stage_act() -> None:
        try:
            import actions
            rec = actions.stage_from(text, tenant)
            if rec:
                log.info("STAGED %s (tenant=%s): %s", rec["kind"], tenant, rec["id"])
                log.info("  -> %s", actions.execute(rec["id"]))
        except Exception:
            log.exception("staging failed for tenant=%s", tenant)
    threading.Thread(target=_stage_act, daemon=True).start()
    stages: Dict[str, int] = {}
    is_imessage = deliver is None

    burst_key = _norm(sender)
    continuation = _continuation(burst_key) if is_imessage else None
    if continuation:
        log.info("continuation: %s wrote again before they could read the last reply", tenant)

    def overtaken() -> bool:
        """They said more while this was being written, so this reply answers half a thought."""
        return is_imessage and _superseded(burst_key)

    def record_turn(user_text: str, reply: str) -> None:
        if overtaken():
            return          # unsent is unsaid: a held reply must never enter the record as spoken
        _record_turn(sender, tenant, user_text, reply, mirror_outbound=is_imessage)

    # ONE WRITER PER MESSAGE (9/5). Every tapback on their message goes through the mark thread on
    # the content path; this says a mark already stands there. Before 9/5 nothing did, because a
    # deposit earned no mark and the paths could not collide.
    marked = threading.Event()
    # Hoisted out of the content path (9/8) so [SILENCE] below can see them. They were content-only
    # while the receipt POST set `marked` for every deposit; once the bare 👍 started waiting, that
    # guard stopped closing and this branch became a second writer that could overwrite the ❓.
    final_mark: List[tuple] = []           # at most one (kind, emoji) the read verdict owes them
    mark_received = None                   # set by the content path; text-only sends have no read

    def timed_send(reply: str) -> None:
        if (reply or "").strip() == "[SILENCE]":
            # silence with a receipt (7/31): the like says SEEN — silence stops being ambiguous.
            # The content path routes it through mark_received so the engine choosing silence gets
            # the same read check as the ladder choosing it; a text-only send has nothing to check.
            if is_imessage and mark_received and not final_mark:
                mark_received(owed="?" in words_only(text))
                log.info("engine chose silence (tenant=%s) — marked their message, nothing said", tenant)
            elif is_imessage and not mark_received and not marked.is_set() \
                    and sendblue_react(message_handle, "like"):
                log.info("engine chose silence (tenant=%s) — liked their message, nothing said", tenant)
            else:
                log.info("engine chose silence (tenant=%s) — affirmative, nothing sent", tenant)
                if deliver:
                    deliver("seen")
            return
        t = time.time()
        if deliver:
            deliver(reply)
        else:
            if not _claim_send(burst_key):     # also starts the window in which more text is one thought
                log.info("HELD the reply to %s — they kept typing; the next turn answers it whole", tenant)
                return
            send_reply(sender, reply)
        stages["send_ms"] = int((time.time() - t) * 1000)

    # INVITE (7/30, the on-call v1 unlock): the founder texts "invite +1416..." mid-call and the
    # interviewee's number is live before they finish saving the contact. Invite-only stays the law —
    # this just moves the gate from an env edit on homebase to a text.
    m_inv = re.match(r"^\s*invite\s+(\+?\d[\d\s().-]{6,18})\s*$", text, re.I)
    if m_inv and tenant == FOUNDER_TENANT:
        num = "+" + re.sub(r"[^\d]", "", m_inv.group(1)).lstrip("+")
        try:
            import json as _j
            ap = os.path.expanduser("~/.co/allowlist.json")
            st_a = _j.load(open(ap)) if os.path.exists(ap) else {"numbers": []}
            if num not in st_a["numbers"]:
                st_a["numbers"].append(num)
                tmp = ap + ".tmp"
                open(tmp, "w").write(_j.dumps(st_a))
                os.replace(tmp, ap)
            reply = f"in. {num} can text this number now — first message starts their onboarding."
        except Exception as e:
            log.warning("invite failed: %s", e)
            reply = "couldn't write the allowlist — check the router log."
        timed_send(reply)
        record_turn(text, reply)
        return

    # CALL ME (8/3): any tenant texts "call me" and co dials THEM back — same brain, out loud.
    # The number dialed is always the sender's own handle; nothing personal lives in code.
    if re.match(r"^\s*call me\s*[.!]?\s*$", text, re.I) and str(sender).strip().startswith("+"):
        try:
            import call_out
            got = call_out.place(str(sender).strip(), first="hey. you rang the bell.")
            if got.get("ok"):
                reply = "calling you now."
            else:
                log.warning("call me failed: %s", got)
                reply = "couldn't get the line up — check the router log."
        except Exception as e:
            log.warning("call me errored: %s", e)
            reply = "couldn't get the line up — check the router log."
        timed_send(reply)
        record_turn(text, reply)
        return

    # THE DAILY PREP (8/1): "today" / "prep me" hands back the same day-plan the world shows —
    # co on your side, first thing, in the thread where they already are.
    if not has_content and re.match(r"^\s*(today|prep me|what'?s today|set me up|my day)\s*[?.!]?\s*$",
                                    text.strip(), re.I):
        import wrapped as _wr
        t_ = _wr._today(tenant, block=True)
        if t_.get("one_thing"):
            parts = [t_.get("read", "").strip(), "the one thing: " + t_["one_thing"]]
            if t_.get("setup"):
                parts.append(" · ".join(t_["setup"][:2]))
            reply = "\n\n".join(p2 for p2 in parts if p2)
            timed_send(reply)
            record_turn(text, reply)
            _log_timing(tenant, "daily_prep", t_inbound, stages)
            return

    # WRAPPED (agreed v1, 7/30): asking for your trends gets the link, deterministic, instant.
    if not has_content and re.search(r"\b(my )?(wrapped|recap|trends?|timeline|stream)\b.{0,20}$",
                                     text.strip(), re.I) and len(text) < 60:
        import wrapped as _wr
        link = _wr.public_url(tenant)
        reply = f"here's your stream. everything you've sent me, mapped\n\n{link}"
        timed_send(reply)
        record_turn(text, reply)
        _log_timing(tenant, "wrapped_link", t_inbound, stages)
        return

    # BRIEF MUTE (8/24, the can't-be-annoying law): one text pauses the morning finds, one
    # resumes them. Deterministic, instant, bounded (a mute lapses after a week by default).
    if not has_content and re.search(r"\b(stop|pause|mute|no more)\b.{0,24}\b(finds?|briefs?)\b",
                                     text.strip(), re.I) and len(text) < 70:
        import daily_finds as _df
        until = _df.mute(tenant)
        reply = f"done, no more morning finds until {until}. say 'resume the finds' any time"
        timed_send(reply)
        record_turn(text, reply)
        _log_timing(tenant, "finds_mute", t_inbound, stages)
        return
    if not has_content and re.search(r"\b(resume|restart|unmute|bring back)\b.{0,24}\b(finds?|briefs?)\b",
                                     text.strip(), re.I) and len(text) < 70:
        import daily_finds as _df
        _df.unmute(tenant)
        reply = "back on. tomorrow morning"
        timed_send(reply)
        record_turn(text, reply)
        _log_timing(tenant, "finds_unmute", t_inbound, stages)
        return

    # THE READING (8/22, trigger-detection spec §C): asked-for feedback with receipts, Tier 1 only.
    # Deterministic trigger; the compose is slow (full-corpus LLM pass) so the typing dots go first.
    # A dark mirror gets an honest line, never filler — thin corpus is a fact, not a failure.
    if not has_content and re.search(r"^(my |the )?reading$|^read me( back)?$", text.strip(), re.I):
        import reading as _rd
        if is_imessage and message_handle:
            try:
                sendblue_typing(sender)
            except Exception:
                pass
        read = _rd.compose(tenant)
        reply = read or ("not enough on the record yet for a real one. "
                         "keep sending me your life and ask again in a couple weeks")
        timed_send(reply)
        record_turn(text, reply)
        _log_timing(tenant, "reading" if read else "reading_dark", t_inbound, stages)
        return

    # ---------------- TEXT-ONLY FAST PATH: the reply gates on nothing but itself ----------------
    if not has_content:
        hint = continuation
        hint = _promise_hint(claims_db, text, hint)      # a promise is confirmed FROM the record
        # THE MUSE LOOP (founder, 8/9: "say noted … and come back with insights, not slop"):
        # a deposited thought queues for overnight expansion and the engine is hinted to ack.
        # The engine still judges — a question wearing a musing's clothes gets answered.
        try:
            import muse as _muse
            if onboarded and _muse.looks_like_musing(text):
                _muse.queue(tenant, text)
                hint = f"{hint}\n{_muse.ACK_HINT}" if hint else _muse.ACK_HINT
        except Exception:
            pass
        _recall_join = _start_recall(tenant, text, sender)  # overlaps co_react + the engine prep below
        if not onboarded:
            # Brand-new person → the guessing game, immediately. Raw text; no enrichment to wait on.
            hint = _recall_join(hint)
            if hint and hint.startswith("__DIRECT_SEND__"):
                timed_send(hint[len("__DIRECT_SEND__"):])
                record_turn(text, hint[len("__DIRECT_SEND__"):])
                _log_timing(tenant, "episode_packet", t_inbound, stages)
                _bookkeep_sync(tenant, claims_db, text, None, do_capture=True)
                return
            t = time.time()
            reply = ask_engine(sender, text, tenant, hint=hint, mirror_outbound=is_imessage)
            stages["engine_ms"] = int((time.time() - t) * 1000)
            if not reply:
                # a canned line masking OUR outage is the bot-tell — silence + a loud log instead;
                # the watchdog restores the engine inside a minute and they were never lied to.
                log.error("engine returned nothing — NO fallback sent; inbound from %s unanswered", tenant)
                _log_timing(tenant, "engine_empty", t_inbound, stages)
                return
            timed_send(reply)
            _log_send(text, memory_path, "onboarding", reply)
            _log_timing(tenant, "first_contact", t_inbound, stages)
        else:
            # Read the sharing act (8/6) — for people co already knows. A stranger's first turn
            # runs the guessing game raw: situational metadata is noise there, and the hint must
            # not sit upstream of the __DIRECT_SEND__ check that path depends on.
            hint = _situation_hint(tenant, claims_db, text, burst_n, "", hint)
            # DEEP WATCH: an explain-ask about recent link(s) goes straight to the engine with the full
            # re-watch in hand — before react(), so a LINE can never hijack "explain these videos".
            deep = None
            try:
                deep = _deep_watch_block(sender, tenant, text, timed_send, is_imessage)
            except Exception as e:
                log.debug("deep watch unavailable: %s", e)
            if deep:
                hint = _recall_join(hint)
                if hint and hint.startswith("__DIRECT_SEND__"):
                    timed_send(hint[len("__DIRECT_SEND__"):])
                    record_turn(text, hint[len("__DIRECT_SEND__"):])
                    _log_timing(tenant, "episode_packet", t_inbound, stages)
                    _bookkeep_sync(tenant, claims_db, text, None, do_capture=True)
                    return
                t = time.time()
                reply = ask_engine(sender, f"{text}\n{deep}", tenant, hint=hint,
                                   mirror_outbound=is_imessage)
                stages["engine_ms"] = int((time.time() - t) * 1000)
                if reply:
                    timed_send(reply)
                    _log_timing(tenant, "deep_watch", t_inbound, stages)
                    _bookkeep_sync(tenant, claims_db, text, None, do_capture=True)
                    return
            # REACT (restraint engine) — this IS reply production, not bookkeeping: it decides line vs
            # engine (relate = one embed call; the LLM phrase only runs when a LINE actually fires).
            t = time.time()
            r = co_react.react(text, claims_db=claims_db, memory_path=memory_path)
            stages["react_ms"] = int((time.time() - t) * 1000)
            log.info("co: tier=%s why=%s", r["tier"], r["why"][:100])
            # ANSWER-FIRST (7/2, from the founder's real thread): a direct question NEVER gets a canned
            # read instead of an answer — the LINE only preempts the engine on non-question sends.
            if r["tier"] == co_react.LINE and r["reaction"] and "?" not in text:
                timed_send(r["reaction"])
                record_turn(text, r["reaction"])
                _log_timing(tenant, "line", t_inbound, {**stages, "how": r.get("how", "")})
            else:
                # Pure text with no LINE → talk like a friend (the engine has core + threads + time).
                hint = _recall_join(hint)               # gate ran concurrent with co_react above
                hint = join_hint(verdict_hint(r), hint)
                if not hint and relationship_known and _dump_burst(tenant, text):
                    # they're dumping. Hold it — the receipt is the reply. No conversation tax.
                    if is_imessage:
                        if not sendblue_react(message_handle, "love"):
                            sendblue_send(sender, "held")
                        recorded_reply = "(held it — they're dumping, no reply owed)"
                    else:
                        timed_send("held")
                        recorded_reply = "held"
                    record_turn(text, recorded_reply)
                    _bookkeep_sync(tenant, claims_db, text, None, do_capture=True)
                    _log_timing(tenant, "dump_hold", t_inbound, stages)
                    log.info("DUMP MODE: held (tenant=%s)", tenant)
                    return
                if hint and hint.startswith("__DIRECT_SEND__"):
                    timed_send(hint[len("__DIRECT_SEND__"):])
                    record_turn(text, hint[len("__DIRECT_SEND__"):])
                    _log_timing(tenant, "episode_packet", t_inbound, stages)
                    _bookkeep_sync(tenant, claims_db, text, None, do_capture=True)
                    return
                t = time.time()
                reply = ask_engine(sender, text, tenant, hint=hint, mirror_outbound=is_imessage)
                if not reply:                       # one retry: 422s and 5xx here are transient
                    log.warning("engine gave nothing — retrying once (tenant=%s)", tenant)
                    reply = ask_engine(sender, text, tenant, hint=None, mirror_outbound=is_imessage)
                stages["engine_ms"] = int((time.time() - t) * 1000)
                if not reply:
                    # THE EYES WERE A LIE (9/3, founder: "it just doesn't respond or only sends me
                    # the eyes instead of even reacting with the eyes"). This line used to text a
                    # bare 👀 whenever the engine failed, so four outages today read to him as co
                    # glancing at his message and choosing to say nothing. An emoji in its own
                    # bubble is not a receipt, it is a canned line masking OUR outage — the bot-tell
                    # CO_SYSTEM already bans, and the onboarding branch already refuses. A real
                    # tapback IS a receipt: it sits on his message and claims nothing.
                    log.error("engine returned nothing twice — NO text sent; %s went unanswered", tenant)
                    # bare, not wearing the eyes (9/8): 👀 claims interest co never had.
                    if is_imessage and message_handle:
                        sendblue_react(message_handle, "question")
                    _log_timing(tenant, "engine_empty", t_inbound, stages)
                    return
                timed_send(reply)
                _log_timing(tenant, "engine", t_inbound, stages)
        # Bookkeeping AFTER the reply is out: synchronous = durable (survives per-webhook processes and
        # restarts); the reply latency is already paid out.
        _bookkeep_sync(tenant, claims_db, text, None, do_capture=True)
        return

    # ---------------- CONTENT PATH (links/media) ----------------
    # 7/2 error-disposition rules: for MEDIA sends the ack comes AFTER a successful read (the ack IS the
    # read-success signal — a 👀 followed by a failure reads as gaslighting). Link-only sends keep the
    # instant ack (reads are fast and failures degrade to captions).
    ack_mark = pick_tapback(text)
    # At receipt, off their own history: nothing the read returns can change whether a source is
    # new to them, and deciding early is what lets 👀 sit there while the reply is written.
    ack_emoji = EYES if ack_mark == "like" and eyes_worthy(text, memory_path) else ""
    read_known = threading.Event()         # the read, or its failure, is decided

    def send_ack() -> None:
        """The one thread that writes marks on this message: ack now, the read's verdict after.

        ONE WRITER, NOT THREE (9/5). The ack, the ❓ for an unreadable attachment and the 👀 for a
        successful read used to be three unordered daemon threads against one handle, which only
        looked safe while a plain deposit earned no ack at all — at HEAD `_do` returned early and
        never POSTed, so the ❓ raced nothing. Giving the deposit a 👍 woke that race up: the ack
        POST has been measured at 6-22s and the media read is p50 ~10s, so the 👍 could land last
        and overwrite the ❓, claiming co saw what it could not open. Sequencing them in one thread
        costs a wait and removes the class.

        OFF the critical path (7/2 fix: the tapback POST was eating 6-22s INLINE — every ack row
        that day — serializing ingest/react/reply behind a slow remote API)."""
        if not is_imessage or not message_handle:
            return
        def _do() -> None:
            # The bare 👍 waits for mark_received (9/8): nothing at receipt knows yet whether the
            # ladder will speak. Every other mark is honest before the answer is known.
            immediate = "" if ack_mark == "like" and not ack_emoji else ack_mark
            if immediate and sendblue_react(message_handle, immediate, emoji=ack_emoji):
                marked.set()
                _log_timing(tenant, "ack", t_inbound, {"via": "tapback"})
            elif immediate:
                # A FAILED REACTION IS NOT A MESSAGE (8/29). This fell back to sending `ack` as
                # text, and `ack` is _light_emoji(), which defaults to 👀 — so three failed tapback
                # POSTs on 8/17 arrived at a real member as three messages containing one eye
                # emoji and nothing else. Their next active day was 6 turns down to 2.
                #
                # A reaction that cannot be delivered degrades to nothing, never to a worse signal
                # occupying its own bubble — 9/5 gave the deposit a mark, and that is still a mark
                # or nothing, never a text. Loud, because this used to fail invisibly at debug.
                log.warning("tapback %r failed (tenant=%s) — holding, no text fallback", immediate, tenant)
                _log_timing(tenant, "ack", t_inbound, {"via": "held (tapback failed)"})
                return                      # a mark that never landed has nothing to upgrade
            read_known.wait(90)             # the ingest's own ceiling; never block a daemon forever
            if not final_mark:
                return
            kind, emoji = final_mark[0]
            if sendblue_react(message_handle, kind, emoji=emoji):
                marked.set()
                log.info("mark upgraded to %s (tenant=%s)", emoji or kind, tenant)
            else:
                log.warning("mark upgrade to %s failed (tenant=%s)", emoji or kind, tenant)
        threading.Thread(target=_do, daemon=True).start()

    def mark_received(owed: bool = False) -> str:
        """👍 "cool, saw it", and nothing after it. Called ONLY from a branch that chose silence.

        Runs after read_known, so it checks for a standing mark rather than racing send_ack.

        AND ONLY IF CO SAW IT. A link that failed to open reaches this same silent branch, and
        unlike media it has no ❓ from the read loop — a bare 👍 would say co saw a page it never
        opened. Same for `owed`: a question only gets here when the engine gave nothing twice, and
        "that is my whole answer" on a question co never answered is a lie. Both take the ❓.

        It reads `enrichment`, NOT `enriched`. enriched is their raw text plus the enrichment, so
        an empty enrichment (a capture that threw) is still a non-empty string and read as a
        successful read — a 👍 on a link co never opened — and their own words could trip a flag.

        The ❓ correction outranks the eyes. 👀 fires at receipt on a novel host, and novel hosts
        are exactly the ones most likely to fail to open, so exempting them left the one class of
        send that most needed correcting wearing a mark that says co found it interesting.

        UNMEASURED (9/8): that correction POSTs a standard type onto a message already carrying a
        Linq CUSTOM emoji. 8/26's "a second tapback REPLACES the first" was only ever observed
        between standard types. If Linq stacks instead of replacing, the member sees 👀 and ❓
        together — still honest, just noisy. Measure it and date this line."""
        if not is_imessage or not message_handle or ack_mark != "like":
            return ""
        if final_mark and marked.is_set():
            return final_mark[0][0]     # the read verdict already landed; report it, do not repeat it
        # `final_mark` alone is NOT a bail (9/8): _do returns without POSTing when the read outruns
        # its 90s wait, and when an eyes POST fails before it. Both leave the verdict owed and
        # nothing on the message — which is how the deposit ended up with no mark at all.
        if owed or final_mark or not link_read.is_a_real_read(enrichment):
            kind = "question"           # corrects a 👀 that already stands, too
        elif marked.is_set():
            return ""                   # the eyes landed and the read was good: nothing to add
        else:
            kind = "like"               # includes the eyes POST that failed — better 👍 than nothing
        if sendblue_react(message_handle, kind):
            marked.set()
            _log_timing(tenant, "ack", t_inbound, {"via": f"tapback {kind} (the whole answer)"})
            return kind
        # A FAILED REACTION IS NOT A MESSAGE (8/29): degrade to nothing, never to a text bubble.
        log.warning("deposit mark %r failed (tenant=%s) — holding, no text fallback", kind, tenant)
        return ""

    # ACK IMMEDIATELY, always (7/15): a friend likes the message THEN watches the video. The old design
    # held the tapback hostage to a successful read — principled, but p50 10s of dead air on iMessage reads
    # as ignored. 9/8 exempts the bare 👍 and only the bare 👍: it is an answer, not an ack, so its
    # latency is the ladder's, and every mark that IS an ack still leaves here at receipt.
    send_ack()
    # TYPING IS A PROMISE (8/26, predicate moved into will_speak 9/5 — the mark is no longer the
    # tell, since a deposit now earns one and still says nothing). _process already fired the
    # indicator behind this same predicate for every inbound, so there is no second POST here.

    # INGEST (the eyes): media first (the ack + reaction hang on it), then capture (Saga + link reads).
    media_enrich = []
    media_failed = 0
    t = time.time()
    for mu in media_urls[:3]:
        try:
            got = link_read.read_media_url(mu, claims_db=claims_db)
        except Exception as e:
            log.debug("media read failed: %s", e)
            got = link_read.READ_FAILED
        if got == link_read.READ_FAILED:
            media_failed += 1
        elif got:
            media_enrich.append(got)
    if media_urls:
        stages["media_ms"] = int((time.time() - t) * 1000)
        # UPGRADE THE TAPBACK (8/26). The ack fires before the read so there is no dead air, which
        # means it can only ever say "received". Once the read lands co knows more, and a second
        # tapback REPLACES the first in iMessage — so a 👍 that turned out to be blind becomes a ❓.
        # Leaving the 👍 would claim co saw something it could not open, which is the receipt-gate
        # law in a channel that has no words. (9/5: handed to the mark thread instead of racing it.)
        if is_imessage and message_handle and media_failed and not media_enrich:
            final_mark.append(("question", ""))
    # KEEP THEIR OWN IMAGES (8/1): Sendblue's CDN links expire, so a photo they sent was gone
    # from their world within days. Persist a thumbnail at capture and carry its key in the
    # captured text — their gym shots and screenshots become tiles like everything else.
    for mu in media_urls[:3]:
        try:
            import thumbs as _th
            if _th.fetch(mu):
                media_enrich.append(f"[img:{_th.key_for(mu)}]")
        except Exception as e:
            log.debug("thumb keep failed: %s", e)

    has_links = bool(link_read.find_urls(text))
    if media_urls and not media_enrich:
        # every attachment unreadable → ONE honest line, ours, in voice — or silence inside the cooldown.
        # Never blame their phone, never ask them to resend. Text/links still get answered below.
        log.warning("all media reads failed (%d) for %s", media_failed, tenant)
        read_known.set()          # this path can return below: release the ❓ now, not in 90s
        if not text.strip() and not has_links:
            audioish = all(u.lower().split("?")[0].endswith(_AUDIO_EXT) for u in media_urls)
            line = AUDIO_FAIL_LINE if audioish else VISION_FAIL_LINE
            if _vision_fail_allowed(claims_db):
                timed_send(line)
                record_turn("(they sent something i couldn't read)", line)
                _log_timing(tenant, "vision_fail", t_inbound, stages)
            else:
                _log_timing(tenant, "vision_fail_muted", t_inbound, stages)
            return
    elif media_urls and is_imessage:
        sendblue_typing(sender)                      # thread stays alive through capture → react (ack already sent)

    t = time.time()
    link_enrich = None

    def _defer_watch(url: str, note: str, minutes: int, transcript: str = None) -> str:
        if transcript:
            # captions landed inside the turn — the reply IS the watch. No ceremony.
            import link_read as _lr
            _lr.save_watched(tenant, url, transcript)
            log.info("INLINE WATCH via captions (tenant=%s, %dmin): %s", tenant, minutes, url[:60])
            return (f"[shared: a {minutes}-minute video ({note or 'no caption'}) — YOU ALREADY WATCHED "
                    f"IT, transcript below. Reply ONCE with what THIS one actually earns — a real take "
                    f"if you have one, the single useful extraction if it's advice, 'honestly, skip it' "
                    f"if it's thin, the watch-this-span verdict if a stretch beats any summary. Pick ONE "
                    f"mode; never a briefing, never the same shape twice in a row.\n"
                    f"TRANSCRIPT: {transcript[:9000]}]")
        if not is_imessage:
            # Native chat has no background-delivery channel yet, so never create a promise whose
            # result can only escape through iMessage
            return (f"[shared: a {minutes}-minute video ({note or 'no caption'}). You do not have the "
                    f"full watch in this turn and cannot deliver one later in native chat. Be honest "
                    f"about that, use only the material actually present, and promise nothing.]")
        # long video: durable record first, watch on a thread, deliver as the NEXT message —
        # the sender's lock is released the moment this turn's reply goes out (kyo watch.py pattern)
        import deferred_watch as _dw
        rid = _dw.register(tenant, url, note, minutes)

        def _run():
            try:
                _dw.watch_and_deliver(tenant, rid,
                                      send=lambda m: sendblue_send(sender, m),
                                      record=lambda m: _record_assistant_only(sender, tenant, m))
                log.info("DEFERRED WATCH delivered (tenant=%s, %dmin): %s", tenant, minutes, url[:60])
            except Exception as e:
                log.warning("deferred watch failed: %s", e)

        threading.Thread(target=_run, daemon=True).start()
        return _dw.placeholder(note, minutes)

    # RE-SEND CATCH (7/31): they sent this exact thing before. Deterministic, zero-cost, and the
    # most visceral proof of memory the product can give — a re-send is unintentional emphasis.
    resend = None
    try:
        resend = journal.prior_send(tenant, text)
    except Exception as e:
        log.debug("resend check failed: %s", e)
    try:
        link_enrich = journal.capture(tenant, text + (("\n" + " ".join(media_enrich)) if media_enrich else ""),
                                      on_defer=_defer_watch)
    except Exception as e:
        log.warning("capture failed: %s", e)
    stages["capture_ms"] = int((time.time() - t) * 1000)
    if resend:
        _d, _ago = resend
        when = "today" if _ago == 0 else ("yesterday" if _ago == 1 else f"{_ago} days ago ({_d})")
        media_enrich.append(f"[THEY SENT THIS EXACT THING BEFORE — {when}. Say so plainly in your "
                            f"first beat: twice means it matters, and that IS the read. Don't "
                            f"re-describe the content they already know.]")
        log.info("RESEND CATCH (tenant=%s, %s)", tenant, when)
    enrichment = " ".join(([link_enrich] if link_enrich else []) + media_enrich) or None
    enriched = text + (f"\n{enrichment}" if enrichment else "")

    # THE READ EARNS NO MARK (9/8): co reads everything it is sent, so a mark reporting the read
    # fires always and reports co's own plumbing. The eyes are spent on surprise at receipt now
    # (ack_emoji, above). What survives here is the honest failure the media loop appended.
    read_known.set()               # release the mark thread: the ❓ verdict, if there is one

    hint = continuation
    hint = _add_recall(tenant, enriched, hint)
    # the sharing act, read off the enrichment: a 41-minute video sent 4th at 11pm is a
    # different message from the same video sent alone at 10pm (8/6 ruling)
    hint = _situation_hint(tenant, claims_db, text, burst_n, enriched, hint)
    try:
        _content_respond(sender, tenant, text, enriched, onboarded, claims_db, memory_path,
                         stages, t_inbound, timed_send, hint,
                         mirror_outbound=is_imessage, record_turn=record_turn,
                         mark_received=mark_received)
    finally:
        # Bookkeeping AFTER the reply is out (capture already ran inline above — the reaction needed it).
        _bookkeep_sync(tenant, claims_db, text, enrichment, do_capture=False)


# THE MOLDABLE AGENT (7/15): standing style orders, in THEIR words. When a send reads as a durable
# instruction about HOW to be ("shorter", "stop asking questions", "no emojis", "call me X"), keep the raw
# sentence in <claims_db>.style.json and inject the list into every engine turn via the session block.
# Raw quotes, never paraphrases — their words are the truest spec, and an LLM summarizer would overfit.
_STYLE_STRONG = re.compile(
    r"\b(be more|be less|stop (doing|saying|asking|sending)|don'?t (say|ask|send|use)|call me \w+|"
    r"from now on|talk (to me )?like|no more (emojis?|questions?|bullets?))\b", re.I)
# Weak tokens ("shorter", "too many words") only count as a bare bark — inside a long sentence they're
# usually about life, not about us ("he was too much at dinner" is gossip, not a style order).
_STYLE_WEAK = re.compile(
    r"\b(shorter|longer|too (long|wordy)|too many (words|questions|texts|emojis|bullets)|"
    r"(more|less|fewer) (sass|questions?|words|emojis?|bullets?))\b", re.I)
_STYLE_BARK_LEN = 60
_STYLE_MAX = 12


def _style_path(claims_db: str) -> str:
    return f"{claims_db}.style.json"


def _style_note(claims_db: str, text: str) -> bool:
    """Capture a standing style order (dedup by prefix, FIFO cap). Returns True when one was kept."""
    t = (text or "").strip()
    if not t or len(t) > 300 or "http" in t:
        return False
    if not (_STYLE_STRONG.search(t) or (_STYLE_WEAK.search(t) and len(t) <= _STYLE_BARK_LEN)):
        return False
    p = _style_path(claims_db)
    try:
        st = json.loads(open(p).read()) if os.path.exists(p) else {"orders": []}
    except (json.JSONDecodeError, OSError):
        st = {"orders": []}
    key = t.lower()[:40]
    if any(o["text"].lower()[:40] == key for o in st["orders"]):
        return False
    st["orders"] = (st["orders"] + [{"when": time.strftime("%Y-%m-%d"), "text": t}])[-_STYLE_MAX:]
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, p)
    log.info("style order kept for %s: %r", os.path.basename(p), t[:60])
    return True


def _style_block(tenant: str) -> str:
    """The standing-orders block for the engine's session context ('' when none)."""
    try:
        import journal
        p = _style_path(journal._claims_db(tenant))
        st = json.loads(open(p).read()) if os.path.exists(p) else None
    except Exception:
        st = None
    if not st or not st.get("orders"):
        return ""
    lines = "\n".join(f"- ({o['when']}) \"{o['text']}\"" for o in st["orders"])
    return f"STANDING ORDERS from them about how to be (obey until they say otherwise):\n{lines}"


# READ RECEIPTS (7/15): Sendblue status callbacks for OUTBOUND messages get recorded instead of dropped.
# Organic proactivity (reflection reads, absence callbacks, daily texts) checks this: if the last thing we
# sent is sitting unread, we wait our turn — stacking texts on an away person is how the mute button gets
# found. Requested reminders (promises) are exempt. Missing data → gate stays open (not every plan/handset
# reports read state; the gate must never brick proactivity).
_OUTBOUND_STATUS_PATH = os.path.expanduser("~/.co/outbound_status.json")


def _note_outbound_status(payload: dict) -> None:
    num = _norm(str(payload.get("number") or payload.get("to_number") or ""))
    status = str(payload.get("status") or "").upper()
    if not num or not status:
        return
    try:
        st = json.loads(open(_OUTBOUND_STATUS_PATH).read()) if os.path.exists(_OUTBOUND_STATUS_PATH) else {}
    except (json.JSONDecodeError, OSError):
        st = {}
    st[num] = {"status": status, "ts": time.time()}
    # THE LEDGER (8/27): DELIVERED/READ join to the SEND that produced them via the message
    # handle, so a landing rate can be computed per lane instead of per phone number.
    try:
        import landed as _ld
        _rung = {"DELIVERED": "delivered", "READ": "read"}.get(status)
        if _rung:
            _ld.signal(tenant_of(num), _rung,
                       handle=str(payload.get("message_handle") or ""))
    except Exception:
        pass
    try:                                       # READ RECEIPTS as LABELS (7/29): the last-per-number
        with open(os.path.expanduser("~/.co/outbound_status_log.jsonl"), "a") as _lf:
            _lf.write(json.dumps({"num": num, "status": status,          # map overwrote history —
                                  "handle": str(payload.get("message_handle") or ""),  # per-message
                                  "ts": time.time()}) + "\n")           # events are the reward
    except OSError:                            # stream for proactive/watch sends (review #4).
        pass
    tmp = _OUTBOUND_STATUS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, _OUTBOUND_STATUS_PATH)
    try:                                       # co dual-write: delivery/read state onto the canonical row
        if co_dualwrite:
            co_dualwrite.emit_status(
                num,
                str(payload.get("message_handle") or "") or None,
                status,
                transport=str(payload.get("transport") or "sendblue"),
                external_thread_id=str(payload.get("external_thread_id") or "") or None,
                error_code=str(payload.get("error_code") or "") or None,
            )
    except Exception as e:
        log.debug("co dualwrite status failed: %s", e)


# DEEP WATCH (7/15, from the founder's real thread — "can you watch these two vids" / "explain these
# videos to me"): an explain-ask re-watches the clip(s) with link_read.EXPLAIN_PROMPT so the engine answers
# with the actual content in hand, not the 2-sentence reaction read. URL-less asks reach back through
# recent history for the links they mean.
_EXPLAIN_RE = re.compile(
    r"\b(explain|re[- ]?view|re[- ]?read|go (over|through)|revisit|break (it|this|that|these|them)( all)? down|"
    r"breakdown|summari[sz]e|walk me through|(just )?watch (it|this|that|these|them|the vids?|the videos?)|"
    r"just watch\b|tl;?dr|what('s| is| are| did) (it|this|that|these|they) (about|saying|say)|"
    r"(list|name) (them|the terms|the concepts|everything)|what (terms|concepts)|"
    r"actual content|full (read|version|breakdown|summary)|go deeper|in depth|deep dive|dig in(to)?)\b", re.I)
# CONTENT QUESTIONS about a shared video (7/29, from the founder's real thread — "didn't he mention
# something about having two phones?"): not an explain-ask, a SPECIFIC question about what was said.
# The gist read can't answer these; the stored transcript can. And the one forbidden move is handing
# the work back ("search the title, it'll come right up") — that reply is the anti-product.
_CONTENT_Q_RE = re.compile(
    r"\b(didn'?t (he|she|they)\b|did (he|she|they) (say|mention|talk|bring)|"
    r"(he|she|they) (mentions?|mentioned|said|says) (something|somewhere|anything)?|"
    r"what did (he|she|they) say about|where (does|did) (he|she|they) (say|mention|talk)|"
    r"(wasn'?t|was) there (a part|something|anything|a bit) about|"
    r"(somewhere|at some point) (in|during) (the|that|this) (video|clip|vid))\b", re.I)

_EXCERPT_SYS = """Someone asked a question about what was said in video(s) they shared. Below are the
full transcript(s). Pull the EXACT passages that bear on their question — verbatim, timestamps kept if
present, at most 3 passages. Return ONLY JSON:
{"found": true|false, "passages": ["<verbatim passage>", ...], "which": "<which video, if several>"}
found=false ONLY if genuinely nothing in the transcripts addresses the question."""

_COUNT_WORDS = {"two": 2, "three": 3, "four": 4, "both": 2, "all": 4}
_COUNT_RE = re.compile(r"\b(?:last|past)?\s*(\d{1,2}|two|three|four|both|all)\s+(?:links?|vids?|videos?|clips?)\b", re.I)
# An explain-ask is a COMMAND: short and imperative. Prose past this length is someone thinking out
# loud (8/4: a 3,462-char essay containing "when you break this down" and a 1,068-char one opening
# "TLDR is that I agree" both launched video ceremonies mid-conversation).
EXPLAIN_ASK_MAX = 240
# The ask must POINT AT CONTENT: a content noun, or a pronoun sitting directly beside the explain
# verb. A bare "it"/"this"/"that" anywhere in a sentence is not evidence — they are the most common
# words in English, which is exactly how the first version of this guard was defeated.
_POINTS_AT_CONTENT_RE = re.compile(
    r"\b(?:vids?|videos?|clips?|shorts?|links?|articles?|pieces?|posts?|pods?|podcasts?|episodes?)\b"
    r"|\b(?:explain|watch|summari[sz]e|breakdown|review|revisit)\s+(?:it|this|that|these|them|both|all)\b"
    r"|\bbreak\s+(?:it|this|that|these|them)(?:\s+all)?\s+down\b"
    r"|\b(?:go (?:over|through)|walk me through)\s+(?:it|this|that|these|them)\b", re.I)
_PLURAL_ASK_RE = re.compile(r"\b(these|them|both|the (?:vids?|videos?|clips?|links?))\b", re.I)


def _recent_urls(sender: str, tenant: str, current_text: str) -> List[str]:
    """URLs an explain-ask refers to: the current send first, else the most recent user sends. 'the last 4
    links' widens the reach to 4 (cap); default 2."""
    import link_read
    m = _COUNT_RE.search(current_text or "")
    # DEFAULT ONE (8/4): the old default of 2 is why every misfire announced "watching BOTH now" —
    # it was never finding two relevant things, it was grabbing the last two links from up to 20
    # turns back. Plural only when the ask is actually plural.
    n = 1
    if m:
        tok = m.group(1).lower()
        n = int(tok) if tok.isdigit() else _COUNT_WORDS.get(tok, 2)
    elif _PLURAL_ASK_RE.search(current_text or ""):
        n = 2
    limit = max(1, min(n, 4))
    urls = list(link_read.find_urls(current_text))
    if urls:
        return urls[:limit]
    _seed_history(sender, tenant)
    with _history_lock:
        hist = list(_history.get(sender, []))
    user_turns = [m.get("content", "") for m in reversed(hist) if m.get("role") == "user"]
    # RECENCY: 20 turns back is a different conversation. A URL-less ask means the link is still
    # in the air — a few turns, not an archive dive.
    for content in user_turns[:6]:
        for u in link_read.find_urls(content):
            if u not in urls:
                urls.append(u)
        if len(urls) >= limit:
            break
    return urls[:limit]


def _transcript_answer(sender: str, tenant: str, text: str,
                       notify: Optional[Callable[[str], None]] = None,
                       use_imessage: bool = True) -> Optional[str]:
    """A specific question about what was said in recent video(s): answer from the stored transcript,
    fetching it live if the video was never transcript-watched (status bubble covers the wait). The
    hint forbids the hand-back — if it's not in the transcript, co says so; it never sends them to
    go search for what it could watch itself."""
    import link_read
    urls = [u for u in _recent_urls(sender, tenant, text) if link_read._YT_ID_RE.search(u)]
    if not urls:
        return None
    urls = urls[:2]
    missing = [u for u in urls if not link_read.get_watched(tenant, u)]
    if missing:
        status = "pulling up the exact part, gimme a sec"
        if use_imessage:
            sendblue_send(sender, status)
        elif notify:
            notify(status)
    if use_imessage:
        sendblue_typing(sender)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as ex:
        list(ex.map(lambda u: link_read.yt_transcript(u, tenant=tenant), missing))
    parts = []
    for u in urls:
        t = link_read.get_watched(tenant, u)
        if t:
            parts.append(f"VIDEO {u}:\n{t[:20000]}")
    if not parts:
        return None
    try:
        import asyncio
        import episode_engine as ee
        got = asyncio.run(ee._ask(_EXCERPT_SYS, f"THEIR QUESTION: {text[:300]}\n\n" + "\n\n".join(parts),
                                  ee.JUDGE_MODEL, max_tokens=500)) or {}
    except Exception as e:
        log.debug("excerpt extraction failed: %s", e)
        return None
    if got.get("found") and got.get("passages"):
        quoted = "\n".join(f"  · \"{pp}\"" for pp in got["passages"][:3])
        which = f" (from {got['which']})" if got.get("which") else ""
        return (f"[THE EXACT PASSAGES from the video they're asking about{which}:\n{quoted}\n"
                f"Answer from these — quote what was actually said, specifically. Never tell them to "
                f"go search or rewatch it themselves; that is your job and it is done.]")
    return ("[You checked the FULL transcript of the recent video(s) — nothing in them about what "
            "they're asking. Say that plainly (it may have been a different video; offer to check "
            "another one they sent). NEVER tell them to go search for it themselves.]")


def _deep_watch_block(sender: str, tenant: str, text: str,
                      notify: Optional[Callable[[str], None]] = None,
                      use_imessage: bool = True) -> Optional[str]:
    """The re-watch, or None. Only fires on an explain-ask with a findable link; clips watched IN PARALLEL
    with the full prompt (wall time ≈ one watch — the typing indicator covers it). A failed watch just
    drops out of the block."""
    if not _EXPLAIN_RE.search(text or ""):
        if _CONTENT_Q_RE.search(text or ""):
            return _transcript_answer(sender, tenant, text, notify, use_imessage)
        return None
    import link_read
    # THE ABOUTNESS GUARD (8/4, hardened after two live misfires). A keyword regex cannot tell
    # "explain these videos" (a command) from "when you break this down…" or "TLDR is that I
    # agree…" (the founder thinking out loud in his own long message) — both launched a video
    # ceremony mid-conversation. A URL-less explain-ask now clears three gates before anything
    # is watched: it must be SHORT (a command, not an essay), it must POINT AT CONTENT, or the
    # previous turn must have been a link send (bare "explain" right after a link is about it).
    if not link_read.find_urls(text):
        t = (text or "").strip()
        if len(t) > EXPLAIN_ASK_MAX:
            return None                         # prose = thinking out loud, never a command
        if not _POINTS_AT_CONTENT_RE.search(t):
            prev_user = ""
            with _history_lock:
                for m in reversed(_history.get(sender, [])):
                    if m.get("role") == "user":
                        prev_user = str(m.get("content") or "")
                        break
            if not link_read.find_urls(prev_user):
                return None                     # conversational ask — the engine owns it
    urls = _recent_urls(sender, tenant, text)
    if not urls:
        return None
    # A multi-clip watch runs ~30s+ — past the point silence reads as a hang. One honest status bubble
    # (they explicitly asked for the work; answer-first applies to status), then typing through the wait.
    if len(urls) > 1:
        _status = f"watching {'both' if len(urls) == 2 else 'all ' + str(len(urls))} now, gimme a min"
        if use_imessage:
            sendblue_send(sender, _status)
        elif notify:
            notify(_status)
        try:                                   # THE GASLIGHT LAW (7/2): every word co sends must
            import daily_text                  # reach the record, or it will deny saying it. This
            daily_text.record_outbound(tenant, _status)   # status bubble bypassed it entirely.
        except Exception:
            pass
    if use_imessage:
        sendblue_typing(sender)                    # the watch is slow; claim only "I'm looking"

    def _watch(u: str) -> Optional[str]:
        try:
            got = link_read.deep_read(u, prompt=link_read.EXPLAIN_PROMPT)
        except Exception as e:
            log.debug("deep watch of %s failed: %s", u, e)
            return None
        return f"[deep watch of {u}: {got}]" if got else None

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(4, len(urls))) as ex:
        reads = [r for r in ex.map(_watch, urls) if r]
    return "\n".join(reads) or None


def _mission_moment(sender: str, tenant: str, enriched: str) -> bool:
    """True when this content send answers the onboarding mission (a recent reply asked them to send a
    screenshot) — the reaction must be specific + the naming line, so it goes to the engine, never held."""
    if not any(m in enriched for m in ("[screenshot/image they sent", "[clip they sent", "[photo they sent")):
        return False
    _seed_history(sender, tenant)
    with _history_lock:
        hist = list(_history.get(sender, []))[-8:]
    prior = "\n".join(m.get("content", "") for m in hist if m.get("role") == "assistant").lower()
    return "screenshot" in prior and "send" in prior


def _content_respond(sender: str, tenant: str, text: str, enriched: str, onboarded: bool, claims_db: str,
                     memory_path: str, stages: Dict[str, int], t_inbound: float, timed_send,
                     hint: Optional[str] = None, mirror_outbound: bool = True,
                     record_turn: Optional[Callable[[str, str], None]] = None,
                     mark_received: Optional[Callable[..., str]] = None) -> None:
    """The content-send reply (post-ack, post-ingest): guessing game / the LINE / the question / restraint."""
    import co_react

    # Brand-new person → the guessing game, with the enrichment in view.
    if not onboarded:
        t = time.time()
        reply = ask_engine(sender, enriched or "(they sent an attachment)", tenant, hint=hint,
                           mirror_outbound=mirror_outbound)
        stages["engine_ms"] = int((time.time() - t) * 1000)
        if not reply:
            log.error("engine returned nothing — NO fallback sent; inbound from %s unanswered", tenant)
            _log_timing(tenant, "engine_empty", t_inbound, stages)
            return
        timed_send(reply)
        _log_send(enriched, memory_path, "onboarding", reply)
        _log_timing(tenant, "first_contact", t_inbound, stages)
        return

    # DEEP WATCH: "explain this <link>" in one send — re-watch with the full prompt, answer with content.
    deep = None
    try:
        deep = _deep_watch_block(sender, tenant, text, timed_send, mirror_outbound)
    except Exception as e:
        log.debug("deep watch unavailable: %s", e)
    if deep:
        t = time.time()
        reply = ask_engine(sender, f"{enriched}\n{deep}", tenant, hint=hint,
                           mirror_outbound=mirror_outbound)
        stages["engine_ms"] = int((time.time() - t) * 1000)
        if reply:
            timed_send(reply)
            _log_timing(tenant, "deep_watch", t_inbound, stages)
            return

    # REACT (restraint engine): the rare LINE, else the ack already sent was the reply.
    t = time.time()
    r = co_react.react(enriched, claims_db=claims_db, memory_path=memory_path)
    stages["react_ms"] = int((time.time() - t) * 1000)
    log.info("co: tier=%s why=%s", r["tier"], r["why"][:100])

    hint = join_hint(verdict_hint(r), hint)

    # ANSWER-FIRST: their question outranks any read — straight to the engine with the enrichment.
    # words_only, not text (9/8): a "?" in ?si= or ?utm_source= is not a question, and reading it
    # as one sent co to the engine to SPEAK on a plain share — the restraint violation, not just a
    # wrong mark. This and the `owed` check below must read the same string the same way.
    if "?" in words_only(text):
        t = time.time()
        reply = ask_engine(sender, enriched, tenant, hint=hint, mirror_outbound=mirror_outbound)
        stages["engine_ms"] = int((time.time() - t) * 1000)
        if reply:
            timed_send(reply)
            _log_timing(tenant, "engine", t_inbound, stages)
            return

    if r["tier"] == co_react.LINE and r["reaction"]:
        timed_send(r["reaction"])
        (record_turn or (lambda u, r_: _record_turn(sender, tenant, u, r_)))(enriched, r["reaction"])
        _log_timing(tenant, "line", t_inbound, {**stages, "how": r.get("how", "")})
        return

    # already marked; a LIGHT/NONE content send is done (restraint IS the product). Exceptions that get a
    # real reply: a VOICE NOTE (spoken words are them talking, not scroll-past), a camera photo, or the
    # MISSION MOMENT (their first screenshot after the onboarding mission — questions were handled above).
    # TAPBACK-DEFAULT for shares is now UNIVERSAL (8/22, founder-usage-analysis): the 7/15 founder
    # share-floor exception is retired — 21 days of the founder's own thread showed unrequested takes
    # tax depositing (weekly sends 68→2; 147 of co's 150 messages answered no question). The tapback
    # is the complete response for every tenant; a question earns the take.
    if ("[voice note" in enriched or "[photo they sent" in enriched
            or _mission_moment(sender, tenant, enriched)):
        t = time.time()
        reply = ask_engine(sender, enriched, tenant, hint=hint, mirror_outbound=mirror_outbound)
        stages["engine_ms"] = int((time.time() - t) * 1000)
        if reply:
            timed_send(reply)
            _log_timing(tenant, "engine", t_inbound, stages)
            return
    # THE TAKE (8/28): the one rung above silence, and the only one. The ladder above is unchanged —
    # every branch that could speak has already declined — so this is the last thing between a
    # deposit and saying nothing. It ships at most one a day, per tenant, and only when a judge that
    # did not write it says it beats silence. Off for everybody until CO_TAKE_TENANTS names them.
    line = _take_line(tenant, text, enriched)
    if line:
        timed_send(line)
        (record_turn or (lambda u, r_: _record_turn(sender, tenant, u, r_)))(enriched, line)
        _log_timing(tenant, "take", t_inbound, stages)
        return

    # THE MARK IS THE WHOLE ANSWER (9/8). Every branch above that could speak has declined, so this
    # is the only line that knows co is saying nothing — and the only one where 👍 is a true
    # sentence. A missed 👍 costs a little; a 👍 next to words costs the mark its meaning.
    sent = mark_received(owed="?" in words_only(text)) if mark_received else ""
    # RECORD THE MARK, NOT AN EMOJI (9/8). This wrote `ack` — co_react._light_emoji(), which
    # defaults to "👀" — so the transcript, the app and the engine's own history all showed co
    # replying with a bare eye on the one branch where co sent a tapback or nothing at all. That
    # is the 8/29 artefact reaching the surfaces that render history, and it taught the model that
    # an emoji in its own bubble is a thing co says. Prose, like the dump-hold branch above.
    (record_turn or (lambda u, r_: _record_turn(sender, tenant, u, r_)))(
        enriched, {"like": "(marked it received, no words)",
                   "question": "(marked it unreadable, no words)"}.get(sent, "(said nothing)"))
    _log_timing(tenant, "held", t_inbound, stages)


def _take_line(tenant: str, text: str, enriched: str) -> str:
    """One unprompted opinion, judged, capped, and recorded either way.

    The ladder's silence came from real data (8/22: unrequested takes cut the founder's weekly
    sends 68 → 2), so this reopens the door on a measurement rather than an argument. Sends go in
    the ledger with what co expects them to cause; the judge's refusals go in as held sends. In a
    week `landed.objective()` answers whether the take earns its interruption, and if it does not,
    the lane comes back out and the ledger will say so.

    The take is composed against ENRICHED, not the raw message: a bare link is a URL, and a judge
    shown a URL can only ever call an opinion about the article a restatement of the link."""
    try:
        import take
        line = take.compose(tenant, enriched or text, _take_context(tenant))
        if not line:
            import landed
            landed.hold_out(tenant, "take", (text or "")[:80])
            return ""
        import landed
        landed.record(tenant, line, lane="take", kind="proactive",
                      expected="he replies, or keeps depositing at the same rate")
        log.info("TAKE (tenant=%s): %s", tenant, line[:80])
        return line
    except Exception as e:
        log.debug("take unavailable: %s", e)
        return ""


def _take_context(tenant: str) -> str:
    """What else is theirs, for the connection. Their standing wants and what they are becoming —
    never a scorecard: see take.py, where feeding co the member's gap made every take a lecture."""
    bits = []
    try:
        import aims
        bits += [a["aim"] for a in aims.live(tenant)][:4]
    except Exception:
        pass
    try:
        import becoming
        bits.append(becoming.portrait_line(tenant))
    except Exception:
        pass
    return "; ".join(b for b in bits if b)[:900]


_MIN_RE = re.compile(r"\ba (\d{1,3})-minute video\b")


def _situation_hint(tenant: str, claims_db: str, text: str, burst_n: int,
                    enriched: str = "", hint: Optional[str] = None) -> Optional[str]:
    """Stack the situational read (claims/situation.py) onto whatever hint we already have.

    The 8/6 ruling: read the sharing ACT — length, burst shape, local hour — and act on it
    instead of offering the member a menu of what co could do. Video length is read back
    out of the router's own `[shared: a N-minute video ...]` marker, so this costs nothing;
    re-probing yt-dlp for a register hint would trade seconds of latency for politeness.
    """
    try:
        import situation as _sit
        art = None
        m = _MIN_RE.search(enriched or "")
        if m:
            art = {"kind": "video", "seconds": int(m.group(1)) * 60}
        line = _sit.for_turn(tenant, [text], artifact=art, claims_db=claims_db,
                             burst=max(1, burst_n))
        if not line:
            return hint
        return f"{hint}\n{line}" if hint else line
    except Exception as e:
        log.debug("situation hint failed: %s", e)
        return hint


def _process(sender: str, text: str, media_urls: List[str], t_inbound: float, message_handle: str = "",
             burst_n: int = 1, transport_name: str = "", external_thread_id: str = "") -> None:
    tenant = tenant_of(sender)
    log.info("inbound (tenant=%s, mode=%s, media=%d): %r", tenant, MODE, len(media_urls), text[:160])
    sb_mark_handled(message_handle)            # durable: the sweep must never re-inject this
    import rail
    if rail.provider() == "linq":              # co has read it: say so on the handset (9/2)
        threading.Thread(target=rail.linq_mark_read, args=(sender,), daemon=True).start()
    try:                                       # co dual-write: lossless-first — raw inbound, artifacts
        if co_dualwrite:                       # ride later passes (enrichment happens after this point)
            co_dualwrite.emit_inbound(_norm(sender), message_handle or None, text, media_urls,
                                      co_dualwrite.utc_iso(t_inbound), [], transport=transport_name or None,
                                      external_thread_id=external_thread_id or None)
    except Exception as e:
        log.debug("co dualwrite inbound failed: %s", e)
    if MODE == "co" and will_speak(text, media_urls):
        sendblue_typing(sender)                    # the thread feels alive during the 5-15s think
    if MODE == "echo":
        if text:
            sendblue_send(sender, text)
        return
    if MODE == "journal":
        import journal
        reply = journal.on_message(tenant, text)   # always captures; returns None to stay calmly silent
        if reply:
            sendblue_send(sender, reply)
        return
    if MODE == "engine":
        reply = ask_engine(sender, text, tenant)
        if reply:
            sendblue_send(sender, reply)
        return
    # "co" — the product (V1_PRODUCT_SPEC.md). Sends its own replies (two-phase).
    try:
        _co_reply(sender, tenant, text, media_urls, t_inbound, message_handle, burst_n)
    except Exception:
        log.exception("co loop error — marking it unread-able (always-pays)")
        # A TEXT BUBBLE IS NOT A FLOOR (9/8). This sent a message whose entire content was one eye
        # emoji — the artefact 8/29 traced to a member dropping 6 turns to 2. Worse now that 👀
        # means interest: a crash would have answered them with enthusiasm. ❓ is what happened.
        try:
            if message_handle:
                sendblue_react(message_handle, "question")
        except Exception:
            pass


def note_inbound_reaction(sender: str, kind: str, target: str) -> None:
    """A tapback ON co's message is the cheapest possible "that landed" — stronger than READ,
    because it took a deliberate act. Loved/Liked/Emphasized/Laughed count; Disliked is a
    landing too (it provoked something) but the LANE deserves to know it was a miss.
    Sendblue delivers these as Apple's text fallback; Linq as a reaction.added event."""
    tenant = tenant_of(sender)
    import journal
    try:
        import landed as _ld
        _ld.signal(tenant, "replied" if kind.lower().startswith("dislike") else "acted")
    except Exception:
        pass
    log_inbound_reaction(tenant, kind, target, journal._claims_db(tenant))
    log.info("inbound tapback from %s: %s on %r", tenant, kind, target[:50])


# ----------------------------- webhook server -------------------------------
def handle_inbound(payload: Dict[str, Any]) -> None:
    t_inbound = time.time()
    sender = payload.get("from_number") or payload.get("number") or ""
    text = (payload.get("content") or "").strip()
    media = payload.get("media_url") or payload.get("mediaUrl") or ""
    media_urls = [m for m in ([media] if isinstance(media, str) else list(media or [])) if m]
    message_handle = payload.get("message_handle") or ""
    # Inbound tapbacks (Apple text-fallback shape — Sendblue has no reaction webhook, verified 7/2):
    # log as first-class signal, never reply, never process as a message.
    m = _INBOUND_TAPBACK_RE.match(text or "")
    if m and sender and not payload.get("is_outbound"):
        note_inbound_reaction(sender, m.group(1), m.group(2))
        return
    # STATUS FIRST (8/28). This block used to sit BELOW the "no sender and no text" guard — which
    # is exactly the shape of a status callback, so every DELIVERED and READ was dropped four
    # lines before the handler that existed to record them. The handler has been unreachable
    # since it was written, which is why ~/.co/outbound_status.json never appeared and the
    # read-aware proactive gate has failed open for its entire life. Sendblue was never at fault.
    if payload.get("is_outbound") or (payload.get("status") and not payload.get("content") and not media_urls):
        try:
            _note_outbound_status(payload)         # read receipts: record, never drop (the proactive gate)
        except Exception as e:
            log.debug("outbound status note failed: %s", e)
        return
    # Skip our own outbound echoing through the same webhook.
    if not sender or (not text and not media_urls):
        return
    if SENDBLUE_FROM_NUMBER and _norm(sender) == _norm(SENDBLUE_FROM_NUMBER):
        return
    # Provider webhooks are at-least-once. Content/time dedup below catches an immediate retry, but
    # only the external id can identify the same message outside that five-second bucket.
    if message_handle and payload.get("transport") in ("sendblue", "linq") \
            and not claim_inbound_handle(str(message_handle)):
        return
    # A REPLY IS EVIDENCE (8/27): they answered inside the window, so co's last message did
    # something. landed.note_reply refuses anything older than 90 minutes — after that it is a
    # new conversation, not a response.
    try:
        import landed as _ld
        _ld.note_reply(tenant_of(sender))
    except Exception:
        pass
    try:
        import presence as _pr
        _pr.note_message(tenant_of(sender))     # it arrived: not an abandoned draft
    except Exception:
        pass
    # Dedupe (Sendblue may retry a webhook): signature on sender+content+coarse-time.
    sig = f"{_norm(sender)}|{text}|{media_urls}|{int(t_inbound // 5)}"
    with _seen_lock:
        if sig in _seen:
            return
        _seen.add(sig)
        if len(_seen) > 5000:
            _seen.clear()
    if not is_allowed(sender):
        log.info("ignored inbound from blocked/non-invited %s", sender)
        return
    day = time.strftime("%Y-%m-%d")
    key = f"{_norm(sender)}:{day}"
    with _flood_lock:
        _flood[key] = _flood.get(key, 0) + 1
        if len(_flood) > 10000:
            _flood.clear()
        if _flood[key] > FLOOD_CAP:
            if _flood[key] == FLOOD_CAP + 1:
                log.warning("FLOOD CAP hit by %s (%d msgs today) — going quiet on them", sender, FLOOD_CAP)
            return
    _buffer_burst(sender, text, media_urls, t_inbound, message_handle,
                  str(payload.get("transport") or ""), str(payload.get("external_thread_id") or ""))


# ----------------------------- burst coalescing (7/2) ------------------------
# Two screenshots sent together arrive as two webhooks seconds apart; processing them as two turns gives
# two acks + two replies (measured live 08:34). Coalesce per sender on a ROLLING window (media sends get a
# longer one), merge texts + media into ONE turn. In-flight turns still serialize on the per-sender lock,
# so a message landing mid-processing starts the next burst and merges with anything else that arrives.
_bursts: Dict[str, Dict[str, Any]] = {}
# RLock, not Lock: the supersession helpers below share this guard so the burst map and the
# in-flight turn can never be read in two different lock orders, and _flush_burst registers a
# turn while already holding it.
_bursts_guard = threading.RLock()

# ---- THE OVERTAKEN REPLY (9/2) ----------------------------------------------------------------
# The burst window closes 7s after the last message, but composing takes 15-25s. So the shape that
# broke live at 12:03 was: they send half a thought, the window closes, co spends 25s writing, and
# while it writes they send the other half ("...tho" / "which chamath is a fan of"). Two turns, two
# replies, to one sentence. The window can never fix this — the second half arrives long after any
# window would have shut.
#
# So the rule is not about timing, it is about standing: a reply that has been overtaken is no
# longer an answer to anything, and it does not go. The turn in flight is marked, its text is
# handed to the burst now forming, and the next turn answers the whole thought once. Nothing is
# lost and nothing is said twice.
_inflight: Dict[str, Dict[str, Any]] = {}
_last_reply_at: Dict[str, float] = {}
# Under 6 seconds they cannot have read co's reply — they were already typing when it landed.
# Longer than that is an ordinary fast answer and must NOT be read as a continuation.
CONTINUATION_S = float(os.environ.get("CO_CONTINUATION_S", "6"))
CONTINUATION_HINT = (
    "[They were still typing when you answered — this continues the message you just replied to, "
    "it is not a new turn. Read the two as one. Do not answer again what you already answered; say "
    "only what the rest of their thought changes. If it changes nothing, stay silent.]")


def _turn_begins(key: str, text: str) -> None:
    with _bursts_guard:
        _inflight[key] = {"text": text, "superseded": False, "carried": False, "sent": False}


def _turn_ends(key: str) -> None:
    with _bursts_guard:
        _inflight.pop(key, None)


def _superseded(key: str) -> bool:
    with _bursts_guard:
        turn = _inflight.get(key)
        return bool(turn and turn["superseded"])


def _supersede(key: str) -> str:
    """Mark the in-flight turn overtaken and hand back its text ONCE, so the burst now forming
    carries the first half of the thought. Returns "" when there is nothing to overtake.

    A turn that has ALREADY replied is not overtaken — it was answered, and re-merging its text
    would make co answer the same message twice (caught by the eval: a reminder ask and the
    wrapped ask, posted back to back, became one confused turn). Past the send, the continuation
    hint is what carries the relationship between the two messages, not the merge."""
    with _bursts_guard:
        turn = _inflight.get(key)
        if not turn or turn["sent"]:
            return ""
        turn["superseded"] = True
        if turn["carried"]:
            return ""
        turn["carried"] = True
        return turn["text"]


def _claim_send(key: str) -> bool:
    """One atomic question: is this reply still standing? If it is, it is now committed — the
    check and the claim cannot be split, or a message landing between them would hold a reply
    that has already gone out. A turn co is not tracking (the app, a proactive lane) always sends."""
    with _bursts_guard:
        turn = _inflight.get(key)
        if turn is not None:
            if turn["superseded"]:
                return False
            turn["sent"] = True
        if len(_last_reply_at) > 5000:
            _last_reply_at.clear()
        _last_reply_at[key] = time.monotonic()
        return True


def _continuation(key: str) -> Optional[str]:
    """The hint for a message that landed before they could have read the last reply."""
    with _bursts_guard:
        last = _last_reply_at.get(key)
    return CONTINUATION_HINT if last is not None and (time.monotonic() - last) < CONTINUATION_S else None
# 7s (8/4, founder call): 3 was shorter than a real human beat — dropping a link and then typing
# the thought about it takes longer than that, so the two halves of ONE message were answered as
# two turns (which is also how "that's the job. glad it landed." collided with a fresh send).
# Rolling: the window restarts on each message, so co replies 7s after they actually stop.
BURST_TEXT_S = float(os.environ.get("CO_BURST_TEXT_S", "7"))
BURST_MEDIA_S = float(os.environ.get("CO_BURST_MEDIA_S", "10"))

# Receive-side typing state (8/6): Sendblue's typing_indicator webhook tells us when a contact is
# mid-composition. While they're typing we HOLD the burst flush — the reply must not step on a
# half-finished thought (the "didn't let me type two messages" complaint). Typing-stop flushes;
# the window timer remains the backstop if the webhook is ever noisy/lost.
# A typing signal EXPIRES rather than latching. Sendblue's is_typing:false can be dropped — the
# contact backgrounds Messages, the tunnel blips, the webhook is lost — and a latched `true` would
# re-arm the flush forever, which is co going permanently silent for that person with no error.
# That is the went-quiet failure class, so the hold is bounded twice: the signal goes stale on its
# own, AND one burst can only be held so long in total. A late reply is a bug; no reply is a breach.
TYPING_STALE_S = float(os.environ.get("CO_TYPING_STALE_S", "20"))
TYPING_HOLD_MAX_S = float(os.environ.get("CO_TYPING_HOLD_MAX_S", "30"))

_typing_at: Dict[str, float] = {}       # key -> monotonic clock when is_typing:true last arrived
_typing_guard = threading.Lock()


def _is_typing(key: str) -> bool:
    with _typing_guard:
        seen = _typing_at.get(key)
    return seen is not None and (time.monotonic() - seen) < TYPING_STALE_S


def _flush_burst(key: str) -> None:
    with _bursts_guard:
        b = _bursts.get(key)
    if not b:
        return
    held = time.monotonic() - b.get("mono0", time.monotonic())
    if _is_typing(key) and held < TYPING_HOLD_MAX_S:   # still composing — hold and re-arm
        log.info("burst held %.0fs — %s is still typing", held, key)
        with _bursts_guard:
            window = BURST_MEDIA_S if b["media"] else BURST_TEXT_S
            b["timer"] = threading.Timer(window, _flush_burst, args=(key,))
            b["timer"].daemon = True
            b["timer"].start()
        return
    if held >= TYPING_HOLD_MAX_S:
        log.info("burst hold capped at %.0fs (typing signal stuck?) — flushing", held)
    with _bursts_guard:
        _bursts.pop(key, None)
    sender = b["sender"]
    text = "\n".join(t for t in b["texts"] if t).strip()
    with _sender_locks_guard:
        lk = _sender_locks.setdefault(_norm(sender), threading.Lock())
    with lk:
        # how many separate sends landed in this window — "five things back to back" is a
        # signal about THEM, and joining the texts first would throw it away (8/6 ruling)
        _turn_begins(key, text)
        try:
            _process(sender, text, b["media"], b["t0"], b.get("handle", ""),
                     burst_n=len([t for t in b["texts"] if t]) + len(b["media"]),
                     transport_name=b.get("transport", ""),
                     external_thread_id=b.get("external_thread_id", ""))
        finally:
            _turn_ends(key)


def _buffer_burst(sender: str, text: str, media_urls: List[str], t_inbound: float, message_handle: str = "",
                  transport_name: str = "", external_thread_id: str = "") -> None:
    key = _norm(sender)
    carried = _supersede(key)          # a turn mid-compose for them is now answering half a thought
    if carried:
        log.info("burst overtakes the reply in flight for %s — merging %r", key, carried[:60])
    with _bursts_guard:
        b = _bursts.get(key)
        if b is None:
            b = {"sender": sender, "texts": [], "media": [], "t0": t_inbound, "timer": None,
                 "handle": "", "transport": transport_name,
                 "external_thread_id": external_thread_id,
                 "mono0": time.monotonic()}   # mono0 bounds the typing hold
            _bursts[key] = b
        elif transport_name and b.get("transport") and transport_name != b["transport"]:
            log.warning("burst crossed transport providers for %s; retaining %s", key, b["transport"])
        elif transport_name:
            b["transport"] = transport_name
        if external_thread_id:
            b["external_thread_id"] = external_thread_id
        if carried:
            b["texts"].insert(0, carried)      # it was said first; it reads first
            # The window is now a real wait (7s), so the thread must not look dead through it —
            # typing starts when the burst OPENS, not when processing begins. Silence during a
            # deliberate pause reads as a hang; "typing" reads as a person composing.
            if MODE == "co":
                try:
                    threading.Thread(target=sendblue_typing, args=(sender,), daemon=True).start()
                except Exception:
                    pass
        if text:
            b["texts"].append(text)
        b["media"].extend(media_urls)
        if message_handle:
            b["handle"] = message_handle          # tapback target = the latest message in the burst
        window = BURST_MEDIA_S if b["media"] else BURST_TEXT_S
        if b["timer"]:
            b["timer"].cancel()
        b["timer"] = threading.Timer(window, _flush_burst, args=(key,))
        b["timer"].daemon = True
        b["timer"].start()


def handle_typing_signal(payload: Dict[str, Any]) -> None:
    """Sendblue typing_indicator webhook: {number, is_typing, from_number}. Track per-sender typing
    so the burst flush waits out a half-finished thought, then flush the moment they stop."""
    # `number` is the CONTACT; `from_number` is our own line. Only the contact's typing gates a
    # flush, so never fall back to from_number — that would key the hold on ourselves.
    sender = payload.get("number") or ""
    if not sender:
        return
    key = _norm(sender)
    typing = bool(payload.get("is_typing"))
    with _typing_guard:
        if typing:
            _typing_at[key] = time.monotonic()
        else:
            _typing_at.pop(key, None)
    # PRESENCE (8/28). This handler has existed for burst-flush control since before today, but
    # the typing_indicator webhook was never REGISTERED with Sendblue, so it has never once run.
    # Registered now, and the same edge is worth more than flush timing: it is the only real-time
    # read of the member's attention co has. Every proactive lane holds while they are typing.
    try:
        import presence as _pr
        _pr.note(tenant_of(sender), typing)
    except Exception as e:
        log.debug("presence note failed: %s", e)
    if not typing:                      # they stopped — say the thing now, don't wait out the window
        _flush_burst(key)


def _voice_grant(tenant: str) -> tuple:
    """A LiveKit room for ONE app voice session, with the witness agent dispatched into it.

    Returns (http_code, json_bytes) — 200 with {serverUrl, roomName, token}, or 503 when the
    box has no LiveKit grant loaded. 503 is deliberate and distinct from an error: the app
    reads it as "voice isn't configured here" rather than blaming the network.

    The room name is UNIQUE PER SESSION. LiveKit applies token-embedded agent dispatch only at
    room CREATION, so a stable per-tenant room name silently drops the dispatch on the second
    call and the agent never joins — livekit/livekit#4390, the "voice works once then dies"
    brick that already cost the V2 door a day (see apps/web/src/lib/voice-room.ts).

    The tenant rides as job metadata, which is exactly what witness_voice.py:_job_tenant()
    reads. Room metadata is NOT usable here: it cannot be set from an AccessToken.
    """
    url = os.environ.get("LIVEKIT_URL", "").strip()
    key = os.environ.get("LIVEKIT_API_KEY", "").strip()
    secret = os.environ.get("LIVEKIT_API_SECRET", "").strip()
    if not (url and key and secret):
        log.warning("APP VOICE refused: LIVEKIT_URL/API_KEY/API_SECRET not set")
        return 503, b'{"ok":false,"error":"voice_not_configured"}'
    try:
        # Lazy: the router must stay importable on a box that has never installed the voice
        # extras, exactly like `call_out` and `wrapped` above.
        from livekit import api as _lk
    except ImportError:
        log.warning("APP VOICE refused: livekit-api not installed (pip install livekit-api)")
        return 503, b'{"ok":false,"error":"voice_not_configured"}'

    import uuid
    room = f"co-voice-{tenant}-{uuid.uuid4().hex[:8]}"
    agent = os.environ.get("LIVEKIT_AGENT_NAME", "witness")
    token = (_lk.AccessToken(key, secret)
             .with_identity(tenant)
             .with_ttl(timedelta(minutes=10))      # long enough to connect, short enough to be worthless if leaked
             .with_grants(_lk.VideoGrants(room_join=True, room=room,
                                          can_publish=True, can_subscribe=True))
             .with_room_config(_lk.RoomConfiguration(agents=[
                 _lk.RoomAgentDispatch(agent_name=agent,
                                       metadata=json.dumps({"tenant": tenant}))]))
             .to_jwt())
    log.info("APP VOICE granted (tenant=%s, room=%s, agent=%s)", tenant, room, agent)
    return 200, json.dumps({"serverUrl": url, "roomName": room, "token": token}).encode()


class Handler(BaseHTTPRequestHandler):
    def _device_tz(self, tenant: str) -> None:
        """The app reports the DEVICE's timezone on every call (X-Co-Timezone: IANA id).

        This is the authoritative signal and it costs the member nothing to give — no
        question, no setting, no form (the 8/6 no-buttons ruling applied to a fact the
        phone already knows). It also follows travel by itself, because iOS updates the
        system zone on arrival.

        Why it matters: parsing zones out of prose is unreliable in exactly the way that
        breaks promises. A tester said "i'm currently in eastern time" on 8/6, the text
        detector missed it, every anchor stayed on the host's zone, and his reminder fired
        three hours early. The device never has that ambiguity.

        Only written when it actually CHANGES — otherwise every poll would churn the file
        and reset the provenance timestamp.
        """
        tz = (self.headers.get("X-Co-Timezone") or "").strip()
        if not tz or len(tz) > 64 or "/" not in tz:
            return
        try:
            import journal
            import tz_dynamic
            claims_db = journal._claims_db(tenant)
            if tz_dynamic.get_tz(claims_db) == tz:
                return
            tz_dynamic.set_tz(claims_db, tz, source="app:device")
            log.info("TZ from device (tenant=%s): %s", tenant, tz)
        except Exception as e:
            log.debug("device tz ignored (%s): %s", tz[:40], e)

    def _ok(self, code=200, body=b'{"ok":true}', ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # health check + the wrapped artifact (GET /w/<slug>, agreed v1 7/30)
        # co.vcf (8/3, "make the texting number and the calling number the same"): the digits
        # can't merge (iMessage rail vs voice rail, two vendors) — the IDENTITY can. One contact,
        # both numbers, so texts and calls both say "co", and known-contact status ends the
        # call-screening fights. Numbers come from env; nothing personal, nothing hardcoded.
        if (self.path or "").split("?")[0] == "/co.vcf":
            import rail
            txt_n = rail.from_number()
            call_n = os.environ.get("CO_VAPI_NUMBER", "")
            photo = ""
            try:
                import base64
                import wrapped as _wr
                photo = f"PHOTO;ENCODING=b;TYPE=PNG:{base64.b64encode(_wr.icon_png()).decode()}\n"
            except Exception:
                pass
            card = ("BEGIN:VCARD\nVERSION:3.0\nN:;co;;;\nFN:co\n"
                    + (f"item1.TEL:{txt_n}\nitem1.X-ABLabel:text\n" if txt_n else "")
                    + (f"item2.TEL:{call_n}\nitem2.X-ABLabel:call\n" if call_n else "")
                    + photo + "END:VCARD\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/vcard")
            self.send_header("Content-Disposition", 'attachment; filename="co.vcf"')
            self.send_header("Content-Length", str(len(card)))
            self.end_headers()
            self.wfile.write(card)
            return
        if (self.path or "").split("?")[0] == "/ig-webhook" and os.environ.get("CO_IG_DOOR") == "1":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            if (q.get("hub.mode") or [""])[0] == "subscribe" and \
                    (q.get("hub.verify_token") or [""])[0] == os.environ.get("CO_IG_VERIFY_TOKEN", ""):
                chal = (q.get("hub.challenge") or [""])[0].encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(chal)))
                self.end_headers()
                self.wfile.write(chal)
                return
            self._ok(403, b"forbidden")
            return
        mi = re.match(r"^/invite/([0-9a-f]{20})\?p=(%2B|\+)?(\d{7,15})$", self.path or "")
        if mi:
            import hashlib as _hl
            import hmac as _hm
            tok = os.environ.get("WEBHOOK_TOKEN", "")
            want = _hm.new(tok.encode(), b"invite", _hl.sha256).hexdigest()[:20] if tok else ""
            if want and _hm.compare_digest(mi.group(1), want):
                num = "+" + mi.group(3)
                try:
                    import json as _j
                    ap = os.path.expanduser("~/.co/allowlist.json")
                    st_a = _j.load(open(ap)) if os.path.exists(ap) else {"numbers": []}
                    if num not in st_a["numbers"]:
                        st_a["numbers"].append(num)
                        tmp = ap + ".tmp"
                        open(tmp, "w").write(_j.dumps(st_a))
                        os.replace(tmp, ap)
                    log.info("INVITED via endpoint: %s", num)
                    self._ok(200, b'{"ok":true,"invited":true}')
                except Exception:
                    self._ok(500, b'{"ok":false}')
                return
            self._ok(404, b"not found")
            return
        mt = re.match(r"^/w/([0-9a-f]{20})/t/([0-9a-f]{6,16})$", self.path or "")
        if mt:
            import wrapped as _wr
            if _wr.tenant_for_slug(mt.group(1)):
                import thumbs as _th
                fp = _th.path_by_key(mt.group(2))
                if fp:
                    body = open(fp, "rb").read()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "private, max-age=604800")
                    self.end_headers()
                    self.wfile.write(body)
                    return
            self._ok(404, b"not found")
            return
        msr = re.match(r"^/w/([0-9a-f]{20})/search$", (self.path or "").split("?")[0])
        if msr:
            import wrapped as _wr
            tenant = _wr.tenant_for_slug(msr.group(1))
            if tenant:
                from urllib.parse import parse_qs, urlparse
                q = (parse_qs(urlparse(self.path).query).get("q") or [""])[0][:80]
                body = _wr.search_entries(tenant, q).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._ok(404, b"not found")
            return
        mj = re.match(r"^/w/([0-9a-f]{20})/app\.json$", self.path or "")
        if mj:
            import wrapped as _wr
            tenant = _wr.tenant_for_slug(mj.group(1))
            if tenant:
                self._device_tz(tenant)     # the phone knows where they are; ask it, not them
                body = _wr.app_state(tenant).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._ok(404, b"not found")
            return
        mh = re.match(r"^/w/([0-9a-f]{20})/chat\.json$", self.path or "")
        if mh:
            import wrapped as _wr
            tenant = _wr.tenant_for_slug(mh.group(1))
            if tenant:
                body = json.dumps({"messages": app_thread(tenant)}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "private, no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            self._ok(404, b"not found")
            return
        ma = re.match(r"^/w/([0-9a-f]{20})/(icon\.png|manifest\.json)$", self.path or "")
        if ma:
            import wrapped as _wr
            tenant = _wr.tenant_for_slug(ma.group(1))
            if tenant:
                if ma.group(2) == "icon.png":
                    body, ctype = _wr.icon_png(), "image/png"
                else:
                    body, ctype = _wr.manifest(tenant).encode(), "application/manifest+json"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
                return
            self._ok(404, b"not found")
            return
        mc = re.match(r"^/w/([0-9a-f]{20})/card\.png$", self.path or "")
        if mc:
            import wrapped as _wr
            tenant = _wr.tenant_for_slug(mc.group(1))
            if tenant:
                body = _wr.get_card_cached(tenant)
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "private, max-age=600")
                self.end_headers()
                self.wfile.write(body)
                return
            self._ok(404, b"not found")
            return
        # Trailing slash tolerated: a pasted "/w/<slug>/" fell through every route and answered
        # {"ok":true} from a catch-all, so the member's own world looked like a broken API. A
        # link people copy by hand has to survive being copied by hand.
        # GOOGLE CONSENT CALLBACK (8/28). The member taps a link in iMessage, consents on their
        # OWN phone, and lands here. No token is protected by this route being secret — the STATE
        # is HMAC-signed, so a forged callback cannot attach somebody's Google account to another
        # member's co. The token value never reaches a log or a response body.
        if (self.path or "").split("?")[0] == "/oauth/google":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            try:
                import google_link as _gl
                got = _gl.complete(q.get("code", [""])[0], q.get("state", [""])[0])
            except Exception as e:
                log.warning("oauth callback failed: %s", type(e).__name__)
                got = {"ok": False, "why": "internal"}
            log.info("GOOGLE LINK %s (tenant=%s)", "ok" if got.get("ok") else "FAILED",
                     got.get("tenant", "?"))
            body = (b"<h2>co is linked. you can close this.</h2>" if got.get("ok")
                    else b"<h2>that link didn't work. ask co for a new one.</h2>")
            self._ok(200 if got.get("ok") else 400, body, "text/html")
            return
        m = re.match(r"^/w/([0-9a-f]{20})/?$", (self.path or "").split("?")[0])
        if m:
            import wrapped as _wr
            tenant = _wr.tenant_for_slug(m.group(1))
            if tenant:
                body = _wr.get_cached(tenant).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "private, max-age=300")
                self.end_headers()
                self.wfile.write(body)
                return
            self._ok(404, b"not found")
            return
        self._ok()

    def do_POST(self):
        # Webhook auth (7/2): the tunnel URL is public — without a shared secret anyone who finds it can
        # inject fake "inbound texts" from any number. If WEBHOOK_TOKEN is set, only POSTs to /hook/<token>
        # are accepted (register that full path as the webhook URL in the Sendblue dashboard). Unset = open
        # (back-compat with the currently-registered bare URL).
        # Authenticated server-to-server native chat path
        # Unlike the public relationship slug, this can start a completely fresh member whose
        # journal does not exist yet, while the database-owned tenant remains the authority
        if (self.path or "").split("?")[0] == "/api/app/chat":
            expected = os.environ.get("CO_APP_RAIL_TOKEN") or os.environ.get("WEBHOOK_TOKEN", "")
            supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if not expected or not hmac.compare_digest(supplied, expected):
                self._ok(404, b"not found")
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n) if 0 < n <= 512 * 1024 else b""
                payload = json.loads(raw or b"{}")
                tenant = str(payload.get("tenant") or "")
                text = str(payload.get("text") or "").strip()
                turn_id = str(payload.get("turnId") or "")
                if (not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant) or not text
                        or not re.fullmatch(r"[0-9a-f-]{36}", turn_id, re.I)):
                    self._ok(400, b'{"ok":false}')
                    return
                num = os.environ.get("CO_FOUNDER_HANDLE", "") if tenant == FOUNDER_TENANT else ""
                if not num and re.fullmatch(r"p\d{7,15}", tenant):
                    num = "+" + tenant[1:]
                if not num:
                    self._ok(400, b'{"ok":false,"error":"no_handle"}')
                    return
                self._device_tz(tenant)
                cached = _claim_app_turn(tenant, turn_id, text)
                if cached is not None:
                    self._ok(200, json.dumps({"ok": True, "reply": cached, "cached": True}).encode())
                    return
                replies: List[str] = []
                try:
                    _co_reply(num, tenant, text, [], time.time(), deliver=replies.append)
                except Exception:
                    _release_app_turn(tenant, turn_id)
                    raise
                # Same belt the Sendblue wire wears: this route's replies include the router's own
                # hardcoded lines, which never pass an engine.
                reply = _belt("\n\n".join(part.strip() for part in replies if part.strip()).strip())
                # Same receipt gate as the wire (8/22): the app door must not carry a claim
                # the Sendblue door would refuse.
                try:
                    import journal as _jr
                    import receipts as _rg
                    _ok, _why = _rg.gate(reply, _jr._claims_db(tenant))
                    if not _ok:
                        log.warning("receipt gate HELD app reply for %s: %s", tenant, _why)
                        reply = ""
                except Exception as _rge:
                    log.debug("receipt gate unavailable (app reply proceeds): %s", _rge)
                if not reply:
                    _release_app_turn(tenant, turn_id)
                    self._ok(502, b'{"ok":false,"error":"engine_unavailable"}')
                    return
                _complete_app_turn(tenant, turn_id, reply)
                log.info("NATIVE CHAT (tenant=%s, %d chars)", tenant, len(text))
                self._ok(200, json.dumps({"ok": True, "reply": reply}).encode())
            except AppTurnBusy:
                self._ok(409, b'{"ok":false,"error":"turn_in_progress"}')
            except ValueError as native_value_error:
                log.warning("native chat rejected: %s", native_value_error)
                self._ok(409, b'{"ok":false,"error":"turn_conflict"}')
            except Exception as native_error:
                log.warning("native chat failed: %s", native_error)
                self._ok(500, b'{"ok":false}')
            return

        # The warm start: the app intake's answers seed a fresh member's graph. Same
        # server-to-server bearer as /api/app/chat; the tenant arrives from the edge
        # function's verified binding, never from anything a client typed. Idempotent
        # (claimstore.upsert merges on type+statement), so a retried POST is a no-op.
        if (self.path or "").split("?")[0] == "/api/app/onboarding":
            expected = os.environ.get("CO_APP_RAIL_TOKEN") or os.environ.get("WEBHOOK_TOKEN", "")
            supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if not expected or not hmac.compare_digest(supplied, expected):
                self._ok(404, b"not found")
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n) if 0 < n <= 64 * 1024 else b""
                payload = json.loads(raw or b"{}")
                tenant = str(payload.get("tenant") or "")
                answers = payload.get("answers")
                if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant) or not isinstance(answers, dict):
                    self._ok(400, b'{"ok":false}')
                    return
                import onboarding_seed as _seed
                # Even for empty answers — a verified member who skipped the intake still gets a world.
                import journal as _journal
                created = _journal.provision(tenant)
                seeded = _seed.seed(tenant, answers)
                log.info("ONBOARDING SEED (tenant=%s, provisioned=%s, claims=%d)",
                         tenant, created, seeded)
                self._ok(200, json.dumps({"ok": True, "seeded": seeded}).encode())
            except Exception as seed_error:
                log.warning("onboarding seed failed: %s", seed_error)
                self._ok(500, b'{"ok":false}')
            return

        mp = re.match(r"^/w/([0-9a-f]{20})/(capture|verdict|aim|done|crown|call|lived|chat|voice|forget|list|world)$", (self.path or "").split("?")[0])
        if mp:
            import wrapped as _wr
            tenant = _wr.tenant_for_slug(mp.group(1))
            if not tenant:
                self._ok(404, b"not found")
                return
            self._device_tz(tenant)         # every app call re-asserts the device's zone
            try:
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n) if 0 < n <= 512 * 1024 else b""
                payload = json.loads(raw or b"{}")
                if mp.group(2) == "capture":
                    ok2 = _wr.record_capture(tenant, payload)
                    log.info("APP CAPTURE (tenant=%s, ok=%s)", tenant, ok2)
                    self._ok(200 if ok2 else 400, b'{"ok":true}' if ok2 else b'{"ok":false}')
                elif mp.group(2) == "done":
                    # honest bool: JSON true/false arrives as bool, but older builds sent
                    # the STRING "false", and bool("false") is True — un-ticking the one
                    # thing was silently impossible (8/9 walkthrough)
                    _dv = payload.get("done", True)
                    _wr.set_done(tenant, _dv if isinstance(_dv, bool)
                                 else str(_dv).strip().lower() not in ("false", "0", "no"))
                    log.info("ONE THING marked done (tenant=%s)", tenant)
                    self._ok(200, b'{"ok":true}')
                elif mp.group(2) == "forget":
                    ok5 = _wr.record_forget(tenant, payload)
                    log.info("FORGET artifact (tenant=%s, ok=%s)", tenant, ok5)
                    self._ok(200 if ok5 else 400, b'{"ok":true}' if ok5 else b'{"ok":false}')
                elif mp.group(2) == "list":
                    # THE LIST's member half: add / close / comment / reorder. Only this door
                    # speaks with member authority; co's writes go through list_engine directly.
                    import list_engine as _le
                    ok6 = _le.record(tenant, payload)
                    log.info("LIST %s (tenant=%s, ok=%s)", payload.get("action"), tenant, ok6)
                    self._ok(200 if ok6 else 400, b'{"ok":true}' if ok6 else b'{"ok":false}')
                elif mp.group(2) == "world":
                    # YOUR WORLD's member half: drop a watched entity. co has no authority to
                    # add here and none to undo it — the nightly mine reads the same material
                    # forever, so a drop that did not persist would resurrect by morning.
                    import entities as _en
                    ok7 = (_en.drop(tenant, str(payload.get("name") or ""))
                           if payload.get("action") == "drop" else False)
                    log.info("WORLD %s (tenant=%s, ok=%s)", payload.get("action"), tenant, ok7)
                    self._ok(200 if ok7 else 400, b'{"ok":true}' if ok7 else b'{"ok":false}')
                elif mp.group(2) == "lived":
                    # the flagship loop's member half: install / undo / verdict. co
                    # proposes and can never take these steps for them (lived.py LAW 2/4).
                    ok4 = _wr.record_lived(tenant, payload)
                    log.info("LIVED %s (tenant=%s, ok=%s)", payload.get("action"), tenant, ok4)
                    self._ok(200 if ok4 else 400, b'{"ok":true}' if ok4 else b'{"ok":false}')
                elif mp.group(2) == "chat":
                    # The app's ask-Kyo IS the iMessage rail: one turn against the SAME engine,
                    # the SAME per-tenant history, and the reply lands in the SAME transcript
                    # the thread reads — so talking in the app and texting Kyo stay one mind.
                    # ask_engine records the turn (history + transcript) itself; this route only
                    # hands it the member's handle so the right interior is loaded.
                    text = str(payload.get("text") or "").strip()
                    if not text:
                        self._ok(400, b'{"ok":false}')
                        return
                    num = ""
                    if tenant == FOUNDER_TENANT:
                        num = os.environ.get("CO_FOUNDER_HANDLE", "")
                    elif re.fullmatch(r"p\d{7,15}", tenant):
                        num = "+" + tenant[1:]
                    if not num:
                        self._ok(400, b'{"ok":false,"error":"no_handle"}')
                        return
                    reply = ask_engine(num, text, tenant, mirror_outbound=False)
                    if not reply:
                        self._ok(502, b'{"ok":false,"error":"engine_unavailable"}')
                        return
                    log.info("APP CHAT (tenant=%s, %d chars)", tenant, len(text))
                    self._ok(200, json.dumps({"ok": True, "reply": reply}).encode())
                elif mp.group(2) == "call":
                    # the app asks for a ring-back: tenant -> their number (founder from env,
                    # p<digits> tenants carry their handle in the id)
                    num = ""
                    if tenant == FOUNDER_TENANT:
                        num = os.environ.get("CO_FOUNDER_HANDLE", "")
                    elif re.fullmatch(r"p\d{7,15}", tenant):
                        num = "+" + tenant[1:]
                    if num:
                        import call_out
                        got = call_out.place(num, first="hey. you asked from the app.")
                        log.info("APP CALL ME (tenant=%s ok=%s)", tenant, got.get("ok"))
                        self._ok(200 if got.get("ok") else 502,
                                 b'{"ok":true}' if got.get("ok") else b'{"ok":false}')
                    else:
                        self._ok(400, b'{"ok":false}')
                elif mp.group(2) == "crown":
                    ok3 = _wr.set_crown(tenant, str(payload.get("theme") or ""), str(payload.get("key") or ""))
                    log.info("ROOM CROWNED (tenant=%s, theme=%s)", tenant, payload.get("theme"))
                    self._ok(200 if ok3 else 400, b'{"ok":true}' if ok3 else b'{"ok":false}')
                elif mp.group(2) == "aim":
                    _wr.set_aim(tenant, str(payload.get("text") or ""))
                    log.info("TODAY'S AIM set (tenant=%s)", tenant)
                    self._ok(200, b'{"ok":true}')
                elif mp.group(2) == "voice":
                    # In-app voice: a LiveKit room with the witness agent already dispatched
                    # into it. The slug resolved the tenant above, so the app never names one
                    # and cannot ask for somebody else's interior — the same guarantee every
                    # other route on this handler gets for free.
                    #
                    # No pre-call thread rides along. The V2 door had to ship the last few
                    # turns because its chat and its voice brain were different stores; here
                    # the agent's engine reads the SAME per-tenant transcript ask_engine
                    # writes, so it already knows the conversation.
                    code, body = _voice_grant(tenant)
                    self._ok(code, body)
                else:
                    _wr.record_verdict(tenant, payload)
                    self._ok(200, b'{"ok":true}')
            except Exception as e2:
                log.warning("app post failed: %s", e2)
                self._ok(500, b'{"ok":false}')
            return
        # VAPI end-of-call report (8/3, "all of this should be looped in"): the call becomes memory.
        # The transcript lands in the tenant's thread history (so the next text knows what the call
        # said) and in the journal (so the world/wake/ingest see it). One mind, for real.
        me = re.match(r"^/vapi/([A-Za-z0-9_\-]{16,})/events$", (self.path or "").split("?")[0])
        if me:
            tok = os.environ.get("WEBHOOK_TOKEN", "")
            if not tok or me.group(1) != tok:
                self._ok(404, b"not found")
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n) if 0 < n <= 2 * 1024 * 1024 else b"{}"
                msg = (json.loads(raw or b"{}") or {}).get("message") or {}
                if msg.get("type") == "end-of-call-report":
                    cust = ((msg.get("call") or {}).get("customer") or {}).get("number") \
                        or (msg.get("customer") or {}).get("number") or ""
                    tr = (msg.get("transcript")
                          or (msg.get("artifact") or {}).get("transcript") or "").strip()
                    if cust and tr:
                        tnt = tenant_of(cust)
                        summary = str(msg.get("summary") or "").strip()
                        _record_turn(cust, tnt,
                                     "[we just talked on the phone — transcript]\n" + tr[:6000],
                                     summary or "(the call above — said what's in it)")
                        try:
                            import journal
                            journal.capture(tnt, "(phone call) " + (summary or tr[:1200]))
                        except Exception:
                            pass
                        log.info("CALL LOOPED IN (tenant=%s, %d chars)", tnt, len(tr))
                self._ok(200, b'{"ok":true}')
            except Exception as e2:
                log.warning("vapi event failed: %s", e2)
                self._ok(200, b'{"ok":true}')   # never make VAPI retry-storm us
            return
        # VAPI custom-LLM proxy (8/3, "I also need phone calls"): the voice rail's brain IS the text
        # rail's brain — VAPI posts OpenAI-shaped requests here, we pin model/tenant and pipe to the
        # engine, streaming straight through. Token-gated like the webhook (the funnel URL is public).
        mv = re.match(r"^/vapi/([A-Za-z0-9_\-]{16,})/chat/completions$", (self.path or "").split("?")[0])
        if mv:
            tok = os.environ.get("WEBHOOK_TOKEN", "")
            if not tok or mv.group(1) != tok:
                self._ok(404, b"not found")
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n) if 0 < n <= 1024 * 1024 else b"{}"
                body = json.loads(raw or b"{}")
                # Multi-tenant (8/3, founder correction): the caller's number maps to a tenant with
                # the SAME function the text rail uses — a call and a text from the same phone are
                # the same person. No founder pinning; unknown numbers get their own graph (open
                # mode), blocked numbers get nothing, and a request with no number at all is refused
                # rather than mis-filed into someone's memory.
                cust = ((body.get("call") or {}).get("customer") or {}).get("number") \
                    or (body.get("customer") or {}).get("number") or ""
                if not cust:
                    self._ok(403, b'{"error":"no customer number on call"}')
                    return
                if not is_allowed(cust):
                    self._ok(403, b'{"error":"blocked"}')
                    return
                body["model"] = "co"
                body["user"] = tenant_of(cust)
                body["peer_id"] = cust
                body["channel"] = "voice"      # routes CO_VOICE_MODEL + the lean toolset
                # The call frame (8/3, first live call): the engine drops system messages, so the
                # frame rides as a synthetic opening exchange. Without it co didn't know it was ON
                # a call, that IT dialed, or that iPhone call screening speaks first — "nobody's
                # calling you," said co, calling.
                frame = {"role": "user", "content":
                         "[live phone call — YOU dialed them, or they called your number. Spoken register: "
                         "short flowing sentences, plain speech, no links, no lists. Their phone shows your name "
                         "(saved contact) — do NOT speak your name to someone who knows you; if a "
                         "STRANGER asks who's calling, say it as 'ko' (spelled that way — anything "
                         "else gets mangled to 'go' or 'coach'). SCREENING: a robotic "
                         "line like 'record your name and reason for calling' is their phone's screening "
                         "bot, NOT them — answer it with ONE short line ('it's koh, calling for them') and "
                         "NOTHING else; do not deliver your real opening to a robot. When a HUMAN voice "
                         "arrives after that ('hello?'), start fresh: greet again and say why you called "
                         "in one line. If they sound busy, offer to drop back to text and get off warmly. "
                         "Never claim you didn't call. FIRST-BEAT LAW: your FIRST sentence is 8 words or "
                         "fewer and lands immediately — the rest of the thought follows in the next "
                         "sentence. Speech is streamed sentence-by-sentence; a long first sentence is "
                         "dead air on the line.]"}
                ack = {"role": "assistant", "content": "(on the line)"}
                body["messages"] = [frame, ack] + [m for m in (body.get("messages") or [])
                                                   if m.get("role") != "system"]
                import requests as _rq
                t0 = time.time()
                up = _rq.post(_engine_url(body["user"]), json=body,
                              headers=ENGINE_HEADERS, stream=bool(body.get("stream")), timeout=120)
                if body.get("stream"):
                    self.send_response(up.status_code)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    first = None
                    for chunk in up.iter_content(chunk_size=None):
                        if chunk:
                            if first is None:
                                first = time.time() - t0
                            self.wfile.write(chunk)
                            self.wfile.flush()
                    log.info("VAPI turn ttfb=%.2fs total=%.2fs tenant=%s",
                             first or -1, time.time() - t0, body.get("user"))
                else:
                    data = up.content
                    self.send_response(up.status_code)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                log.info("VAPI turn proxied (stream=%s)", bool(body.get("stream")))
            except Exception as e2:
                log.warning("vapi proxy failed: %s", e2)
                self._ok(502, b'{"error":"engine unreachable"}')
            return
        if (self.path or "").split("?")[0] == "/ig-webhook":
            if os.environ.get("CO_IG_DOOR") != "1":
                self._ok(404, b'{"ok":false}')
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n) if 0 < n <= 512 * 1024 else b""
                import ig_door as _ig
                if not _ig.verify_signature(os.environ.get("CO_IG_APP_SECRET", ""), raw,
                                            self.headers.get("X-Hub-Signature-256", "")):
                    self._ok(403, b'{"ok":false}')
                    return
                door = _ig.IGDoor(
                    _ig.GraphClient(lambda: os.environ.get("CO_IG_GRAPH_TOKEN", "")), _ig.IGState(),
                    send_sms=sendblue_send,
                    capture=lambda t, txt: __import__("journal").capture(t, txt),
                    is_rostered=lambda ph: os.path.exists(_transcript_path(tenant_of(ph))),
                    tenant_of=tenant_of)
                for ig_user, item in _ig.parse_webhook(json.loads(raw or b"{}")):
                    door.handle_webhook_item(ig_user, item)
            except Exception as e:
                log.warning("ig-webhook error: %s", e)
            self._ok(200, b'{"ok":true}')       # Meta retries on non-200; errors are ours to log
            return
        tok = os.environ.get("WEBHOOK_TOKEN", "")
        if tok and self.path.rstrip("/") == f"/linq/{tok}":
            self._linq_hook()
            return
        if tok and self.path.rstrip("/").startswith(f"/google/{tok}/"):
            self._google_bridge(self.path.rstrip("/").rsplit("/", 1)[-1])
            return
        if tok and self.path.rstrip("/") != f"/hook/{tok}":
            log.warning("rejected webhook POST to %s (bad/missing token path)", self.path[:40])
            self._ok(404, b'{"ok":false}')
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            # body cap (kyo bodylimit.py): Sendblue sends JSON with CDN media URLs, never raw bytes —
            # a real webhook body is a few KB. An uncapped read on a public tunnel is a memory-DoS hole.
            if n > 512 * 1024:
                log.warning("rejected oversized webhook body (%d bytes)", n)
                self._ok(413, b'{"ok":false}')
                return
            raw = self.rfile.read(n) if n else b""
            payload = json.loads(raw or b"{}")
        except Exception as e:
            log.warning("bad webhook body: %s", e)
            self._ok(400, b'{"ok":false}')
            return
        # Sendblue typing_indicator webhook (same endpoint, distinct payload {number, is_typing}):
        # detect a contact mid-composition and hold the burst flush so a reply never steps on their
        # half-finished thought. Ack fast; flushing happens on typing-stop / the window backstop.
        if payload.get("is_typing") is not None and (payload.get("number") or payload.get("from_number")):
            self._ok()
            try:
                handle_typing_signal(payload)
            except Exception:
                log.exception("typing indicator handling error")
            return
        # Ack immediately (Sendblue expects a fast 200); do the engine call + reply in the background.
        payload["transport"] = "sendblue"
        self._ok()
        try:
            handle_inbound(payload)
        except Exception:
            log.exception("inbound handling error")

    def _google_bridge(self, verb: str) -> None:
        """Google, for the runtime (9/6).

        The runtime owns the founder's conversation and has no Google client. The 800 lines that do
        — gcal, gmail_audit, gmail_guard — live here, next to the OAuth tokens, and porting them
        would mean re-earning consent and re-testing a working integration. So the capability stays
        where it works and the runtime reaches it over loopback, under its own authority: it decides
        whether a call is allowed, this only performs it.

        Tenant-scoped on every call, because `gcal.accounts_for` exists precisely to stop one
        member's held hour landing on another's calendar (8/28). No tenant, no accounts, no call.
        Every failure returns a reason rather than an empty success — a missing refresh token must
        read as 'not connected', never as 'nothing on your calendar'."""
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}") if 0 < n <= 64 * 1024 else {}
        except Exception:
            self._ok(400, b'{"ok":false,"why":"bad body"}')
            return
        tenant = str(body.get("tenant") or "").strip()
        if not tenant:
            self._ok(400, b'{"ok":false,"why":"tenant is required"}')
            return
        try:
            import gcal
            if verb == "calendar":
                accts = gcal.accounts_for(tenant)
                # A linked account FILE is not a working connection (found live 9/6): the founder
                # has ~/.co/google/personal on disk while the keyring has no refresh token, so
                # accounts_for() said yes, sync() returned nothing, and the bridge reported an
                # empty day. That is the confident lie this whole path exists to prevent — a free
                # calendar and a broken one are indistinguishable to the member until they miss
                # something. Prove the token refreshes before claiming connected.
                live = [a for a in accts if gcal._access(a)]
                if not accts:
                    out = {"ok": False, "why": "no linked google account for this member",
                           "connected": False}
                elif not live:
                    out = {"ok": False, "connected": False,
                           "why": f"google is linked but the token will not refresh "
                                  f"({', '.join(a['label'] for a in accts)}) — re-run gog auth add"}
                else:
                    accts = live
                    gcal.sync(tenant)
                    day = os.path.expanduser(f"~/.co/gcal/{tenant}.json")
                    day = day if os.path.exists(day) else os.path.expanduser("~/.co/gcal/today.json")
                    events = json.load(open(day)).get("events", []) if os.path.exists(day) else []
                    out = {"ok": True, "connected": True, "accounts": [a["label"] for a in accts],
                           "events": events[: int(body.get("limit") or 20)]}
            elif verb == "hold":
                out = gcal.hold(str(body.get("title") or "").strip(),
                                str(body.get("start") or "").strip(),
                                int(body.get("minutes") or 30),
                                str(body.get("instructions") or ""),
                                tenant=tenant)
            elif verb == "mail":
                import gmail_audit
                accts = gcal.accounts_for(tenant)
                if not accts:
                    out = {"ok": False, "connected": False,
                           "why": "no linked google account for this member"}
                else:
                    token = gmail_audit._access(accts[0])
                    if not token:
                        out = {"ok": False, "connected": False,
                               "why": f"google is linked but the token will not refresh "
                                      f"({accts[0]['label']}) — re-run gog auth add"}
                    else:
                        ids = gmail_audit._search(token, str(body.get("q") or "newer_than:7d"),
                                                  min(int(body.get("limit") or 10), 25))
                        rows = [m for m in (gmail_audit._meta(token, i) for i in ids) if m]
                        out = {"ok": True, "connected": True, "messages": rows}
            else:
                self._ok(404, b'{"ok":false,"why":"unknown verb"}')
                return
        except Exception as e:
            log.exception("google bridge %s failed for %s", verb, tenant)
            out = {"ok": False, "why": f"{type(e).__name__}: {e}"[:200], "connected": False}
        self._ok(200 if out.get("ok") else 502, json.dumps(out).encode())

    def _linq_hook(self) -> None:
        """Linq's webhook (CO_RAIL=linq). Verified with the Standard Webhooks HMAC when
        LINQ_WEBHOOK_SECRET is set; rail.linq_event turns each event into the payload the
        Sendblue handlers already take, so the providers share everything below the door."""
        import rail
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > 512 * 1024:
                self._ok(413, b'{"ok":false}')
                return
            raw = self.rfile.read(n) if n else b""
            event = json.loads(raw or b"{}")
        except Exception as e:
            log.warning("bad linq webhook body: %s", e)
            self._ok(400, b'{"ok":false}')
            return
        secret = os.environ.get("LINQ_WEBHOOK_SECRET", "")
        if not secret or not rail.linq_verify(secret, self.headers, raw):
            log.warning("linq webhook rejected: bad signature")
            self._ok(401, b'{"ok":false}')
            return
        self._ok()
        try:
            got = rail.linq_event(event)
            if not got:
                # Loud on purpose: what co does NOT map is the only record of what Linq offers and
                # co is throwing away. Typing lands here (see rail.linq_event on attribution).
                log.info("linq event unmapped: %s %s", event.get("event_type"),
                         json.dumps(event.get("data") or {})[:200])
                return
            kind, payload = got
            if kind == "typing":
                handle_typing_signal(payload)
            elif kind == "reaction":
                note_inbound_reaction(payload["from_number"], payload["reaction"], payload["message_handle"])
            else:
                handle_inbound(payload)
        except Exception:
            log.exception("linq webhook handling error")

    def log_message(self, *a):  # silence default access logging
        pass


# ----------------------------- the recovery sweep (8/4) ---------------------------------
# Webhooks are AT-MOST-ONCE: the night the funnel died (restarted 06:17), Sendblue accepted
# the founder's three videos and Justin's asks and the webhooks fell on a dead tunnel —
# silent loss, discovered only by "how come no response to my last 3 messages". This sweep
# makes inbound AT-LEAST-ONCE: poll Sendblue's own message history and inject anything we
# never saw through the same handle_inbound pipeline. Late beats lost, every time.

# Legacy filename is retained because it is durable state, though the handles now span both rails.
_SB_SEEN_PATH = os.path.expanduser("~/.co/sb_handles.json")
_sb_seen: set = set()
_sb_seen_lock = threading.Lock()
# The LATE-RECOVERY REGISTER (8/4, the burst incident): recovered messages processed as if live
# produced a wall of bubbles answering 12-hour-old sends with fresh-context questions ("what are
# you building." about takis eaten the night before). A recovered message is a paid debt, not a
# live turn: the reply must own the lateness once, consolidate, and never ask into stale context.
# The sweep notes the original send time per sender; ask_engine turns it into a hint directive.
_recovery_note: dict = {}
SWEEP_INTERVAL = int(os.environ.get("CO_SWEEP_INTERVAL", "240"))
SWEEP_MAX_AGE_H = 36
# Min age (8/4, the double-send incident): a webhook-delivered MMS carried a different/empty
# handle vs the history API, both dedup guards missed, and the sweep re-injected a message TWO
# MINUTES after it was answered — co then told the founder "sent this one twice" about a single
# send. The sweep exists for OUTAGE recovery; webhooks deliver in seconds. Anything younger than
# this is either already processed or still in flight — never the sweep's business.
SWEEP_MIN_AGE_S = int(os.environ.get("CO_SWEEP_MIN_AGE", "900"))


def _sb_seen_load() -> None:
    """Durable handle store; first run seeds from the dual-write archive (the record of what
    the router actually processed) so history isn't re-injected after this ships."""
    global _sb_seen
    try:
        _sb_seen = set(json.load(open(_SB_SEEN_PATH)))
        return
    except Exception:
        _sb_seen = set()
    for p in (os.path.expanduser("~/.co/co_dualwrite_archive.jsonl"),
              os.path.expanduser("~/.co/co_dualwrite_spool.jsonl")):
        try:
            for line in open(p):
                try:
                    r = json.loads(line)
                    if r.get("direction") == "inbound" and r.get("external_message_id"):
                        _sb_seen.add(str(r["external_message_id"]))
                except Exception:
                    continue
        except OSError:
            continue
    _sb_seen_save()


def _sb_seen_save() -> None:
    try:
        with _sb_seen_lock:
            keep = list(_sb_seen)[-4000:]
        tmp = _SB_SEEN_PATH + ".tmp"
        json.dump(keep, open(tmp, "w"))
        os.replace(tmp, _SB_SEEN_PATH)
    except Exception:
        pass


def sb_mark_handled(handle: str) -> None:
    if not handle:
        return
    with _sb_seen_lock:
        _sb_seen.add(str(handle))


def claim_inbound_handle(handle: str) -> bool:
    """Atomically claim an exact provider message id. False means this is a webhook replay."""
    if not handle:
        return True
    with _sb_seen_lock:
        if str(handle) in _sb_seen:
            return False
        _sb_seen.add(str(handle))
    _sb_seen_save()
    return True


def _in_transcript(tenant: str, text: str) -> bool:
    """Second guard for handle-less history rows: their words are verbatim in the record."""
    try:
        base = os.path.join(FRAME_ROOT, "claims",
                            "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
        turns = json.load(open(f"{base}.transcript.json"))
        needle = (text or "").strip()
        # CONTAINMENT, not equality (8/4): recorded user turns carry the enrichment appended
        # ("url\n[shared: …]"), so an exact match can never hit for content sends.
        return bool(needle) and any(needle in (t.get("content") or "")
                                    for t in turns[-200:] if t.get("role") == "user")
    except Exception:
        return False


def _sweep_once() -> int:
    import datetime as _dt
    recovered = 0
    rows = []
    for offset in (0, 50, 100):               # 150 rows ≈ well past 36h at current volume
        try:
            r = requests.get("https://api.sendblue.com/api/v2/messages",
                             params={"limit": 50, "offset": offset},
                             headers={"sb-api-key-id": SENDBLUE_API_KEY_ID,
                                      "sb-api-secret-key": SENDBLUE_API_SECRET}, timeout=20)
            if not r.ok:
                break
            body = r.json() or {}
            page = body.get("data") or body.get("messages") or []
            rows.extend(page)
            if len(page) < 50:
                break
        except Exception:
            break
    if not rows:
        return 0
    now = _dt.datetime.now(_dt.timezone.utc)
    for m in rows:
        try:
            if m.get("is_outbound"):
                continue
            handle = str(m.get("message_handle") or "")
            sender = str(m.get("from_number") or m.get("number") or "").strip()
            text = (m.get("content") or "").strip()
            media = m.get("media_url") or ""
            when = str(m.get("date_sent") or m.get("date_created") or "")
            if not sender or not (text or media):
                continue
            with _sb_seen_lock:
                if handle and handle in _sb_seen:
                    continue
            try:
                ts = _dt.datetime.fromisoformat(when.replace("Z", "+00:00"))
                age_s = (now - ts).total_seconds()
                if age_s > SWEEP_MAX_AGE_H * 3600:
                    if handle:
                        sb_mark_handled(handle)
                    continue
                if age_s < SWEEP_MIN_AGE_S:
                    continue                    # too fresh — the webhook owns this window
            except ValueError:
                pass
            if not is_allowed(sender):
                if handle:
                    sb_mark_handled(handle)
                continue
            if _in_transcript(tenant_of(sender), text):
                if handle:
                    sb_mark_handled(handle)
                continue
            log.warning("RECOVERED dropped inbound (%s, %s): %r", sender[-4:], when[:19], text[:80])
            if handle:
                sb_mark_handled(handle)
            with _sb_seen_lock:
                _recovery_note[_norm(sender)] = when[:16]
            handle_inbound({"from_number": sender, "content": text,
                            "media_url": media, "message_handle": handle})
            recovered += 1
            if recovered >= 6:
                break
        except Exception:
            continue
    if recovered or rows:
        _sb_seen_save()
    return recovered


def _sweep_loop() -> None:
    log.info("recovery sweep armed (every %ds, %d handles known)", SWEEP_INTERVAL, len(_sb_seen))
    while True:
        time.sleep(SWEEP_INTERVAL)
        try:
            got = _sweep_once()
            if got:
                log.warning("recovery sweep injected %d dropped message(s)", got)
        except Exception as e:
            log.debug("sweep error: %s", e)


def main() -> None:
    import rail
    active_provider = rail.provider()
    requirements = (
        {"LINQ_API_KEY": os.environ.get("LINQ_API_KEY"),
         "LINQ_FROM_NUMBER": os.environ.get("LINQ_FROM_NUMBER"),
         "LINQ_WEBHOOK_SECRET": os.environ.get("LINQ_WEBHOOK_SECRET"),
         "WEBHOOK_TOKEN": os.environ.get("WEBHOOK_TOKEN")}
        if active_provider == "linq" else
        {"SENDBLUE_API_KEY_ID (or SENDBLUE_API_KEY)": SENDBLUE_API_KEY_ID,
         "SENDBLUE_API_SECRET (or SENDBLUE_SECRET_KEY)": SENDBLUE_API_SECRET}
    )
    missing = [name for name, value in requirements.items() if not value]
    if missing and MODE != "echo":
        log.error("missing required env: %s", ", ".join(missing))
        sys.exit(1)
    if active_provider == "sendblue" and not SENDBLUE_FROM_NUMBER:
        log.warning("SENDBLUE_FROM_NUMBER unset — sends will rely on the account's default number")
    try:
        requests.get(WITNESS_URL.rsplit("/chat/completions", 1)[0] + "/models",
                     headers=ENGINE_HEADERS, timeout=3).raise_for_status()
        log.info("engine reachable at %s", WITNESS_URL)
    except Exception as e:
        log.warning("engine NOT reachable at %s (%s) — start brain/server.ts on :8090", WITNESS_URL, e)
    if _RUNTIME_TENANTS and WITNESS_FALLBACK_URL:
        try:
            requests.get(WITNESS_FALLBACK_URL.rsplit("/chat/completions", 1)[0] + "/models",
                         timeout=3).raise_for_status()
            log.info("fallback engine reachable for non-runtime tenants")
        except Exception as e:
            log.warning("fallback engine NOT reachable for non-runtime tenants (%s)", e)
    _sb_seen_load()  # exact webhook replay protection is shared; Sendblue also uses it for recovery
    if active_provider == "linq":
        log.info("rail: linq (%s); provider retries signed webhooks for transient failures",
                 os.environ.get("LINQ_FROM_NUMBER", "?"))
    else:
        threading.Thread(target=_sweep_loop, daemon=True).start()   # webhooks at-least-once (8/4)
    srv = ThreadingHTTPServer(("0.0.0.0", WEBHOOK_PORT), Handler)
    log.info("%s webhook listening on :%d  (mode=%s, testers=%d)",
             active_provider, WEBHOOK_PORT, MODE, len(_TEST_HANDLES))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
