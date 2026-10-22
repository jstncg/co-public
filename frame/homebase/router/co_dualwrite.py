"""co dual-write — the sender side of the transport ingest contract.

Mirrors every live Sendblue or Linq message into the canonical Co backend without changing the
reply path. Provider identity stays on the envelope so a rail cutover never forks or falsifies the
relationship record.

HARD REQUIREMENT — ENTIRELY INERT BY DEFAULT:
  Unless BOTH `CO_INGEST_URL` and `CO_INGEST_TOKEN` are set in the environment, every public
  function returns immediately (one cheap env check, no threads, no I/O, no behavior change).

Sender obligations (from the contract):
  - NEVER block or raise into the live reply path: envelopes are handed to a fire-and-forget
    daemon thread; every failure is swallowed (log.debug at most).
  - zero-loss without coupling uptime: on any network/HTTP failure the envelope is appended as one
    JSON line to ~/.co/co_dualwrite_spool.jsonl; at the start of each later send attempt up to
    50 spooled lines are opportunistically flushed (flushed lines removed atomically via temp file).
  - idempotency_key: "<transport>:<external_message_id>" when the transport supplies an id, else
    "<transport>:sig:<sha256(tenant|direction|text|floor(epoch/5))>".

TODO(proactive): proactive sends (frame/claims/proactive_tick.py — reminders, anchors, second
opinions, reflection reads, absence callbacks, daily texts) run in a SEPARATE process and are NOT
wired through this module yet. Wire emit_outbound into that path in a later pass so the canonical
record owns co's proactive words too.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

import requests

log = logging.getLogger("co-dualwrite")

SPOOL_PATH = os.path.expanduser("~/.co/co_dualwrite_spool.jsonl")
TIMEOUT_S = 5
SPOOL_FLUSH_MAX = 50

_ARTIFACT_KEYS = ("source_type", "canonical_url", "coverage", "extraction", "timestamp_seconds")
_TRANSPORTS = frozenset(("sendblue", "linq"))

_spool_lock = threading.Lock()


def enabled() -> bool:
    """True only when both env vars are present. This is the ONLY gate — default state is off."""
    return bool(os.environ.get("CO_INGEST_URL")) and bool(os.environ.get("CO_INGEST_TOKEN"))


def utc_iso(epoch: Optional[float] = None) -> str:
    """Contract-shaped UTC timestamp ('2026-07-20T18:51:23Z')."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if epoch is None else epoch))


# ----------------------------- envelope --------------------------------------
def _sig(tenant_phone: str, direction: str, text: str, epoch: Optional[float] = None) -> str:
    """The contract's id-less fallback signature (mirrors the live router's dedup sig)."""
    epoch = time.time() if epoch is None else epoch
    return hashlib.sha256(f"{tenant_phone}|{direction}|{text}|{int(epoch // 5)}".encode("utf-8")).hexdigest()


def _clean_artifacts(artifacts: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Only the contract's artifact keys go over the wire — nothing extra ever leaks."""
    out = []
    for a in artifacts or []:
        if isinstance(a, dict):
            out.append({k: a.get(k) for k in _ARTIFACT_KEYS})
    return out


def _transport_name(explicit: Optional[str] = None) -> str:
    transport = (explicit or os.environ.get("CO_RAIL") or "sendblue").strip().lower()
    if transport not in _TRANSPORTS:
        raise ValueError(f"unsupported transport {transport!r}")
    return transport


def _thread_id(provider: str, tenant_phone: str, explicit: Optional[str]) -> str:
    if explicit:
        return explicit
    if provider == "linq":
        try:
            import rail
            return rail.linq_chat_for(tenant_phone) or tenant_phone
        except (ImportError, OSError, ValueError):
            pass
    return tenant_phone


def _envelope(direction: str, tenant_phone: str, external_message_id: Optional[str], text: str,
              media_urls: Optional[List[str]] = None, sent_at_iso: Optional[str] = None,
              status: Optional[str] = None, artifacts: Optional[List[Dict[str, Any]]] = None,
              transport: Optional[str] = None, external_thread_id: Optional[str] = None,
              transport_metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    ext = str(external_message_id) if external_message_id else None
    txt = text or ""
    provider = _transport_name(transport)
    key = f"{provider}:{ext}" if ext else f"{provider}:sig:{_sig(tenant_phone, direction, txt)}"
    return {
        "idempotency_key": key,
        "tenant_phone": tenant_phone,
        "transport": provider,
        "direction": direction,
        "external_message_id": ext,
        "external_thread_id": _thread_id(provider, tenant_phone, external_thread_id),
        "text": txt,
        "media_urls": [m for m in (media_urls or []) if m],
        "sent_at": sent_at_iso or utc_iso(),
        "status": status,
        "reply_to_external_id": None,
        "artifacts": _clean_artifacts(artifacts),
        "transport_metadata": transport_metadata or {},
    }


# ----------------------------- delivery (background only) --------------------
def _post(envelope: Dict[str, Any]) -> str:
    """POST one envelope. Returns 'ok' (stored/deduped), 'drop' (422 — will never succeed),
    or 'retry' (network/auth/5xx — spool and try again later)."""
    url = os.environ.get("CO_INGEST_URL", "")
    token = os.environ.get("CO_INGEST_TOKEN", "")
    if not url or not token:
        return "retry"
    try:
        r = requests.post(url, json=envelope, timeout=TIMEOUT_S,
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    except Exception as e:
        log.debug("co ingest post failed: %s", e)
        return "retry"
    if r.ok:
        return "ok"
    if r.status_code == 422:
        log.debug("co ingest rejected envelope 422 (%s) — dropping", envelope.get("idempotency_key"))
        return "drop"
    log.debug("co ingest HTTP %s (%s)", r.status_code, envelope.get("idempotency_key"))
    return "retry"


def _spool(envelope: Dict[str, Any]) -> None:
    """One JSON line per failed envelope; replay is always safe (idempotency_key rides along)."""
    try:
        with _spool_lock:
            os.makedirs(os.path.dirname(SPOOL_PATH), exist_ok=True)
            with open(SPOOL_PATH, "a") as f:
                f.write(json.dumps(envelope) + "\n")
    except Exception as e:
        log.debug("co dualwrite spool append failed: %s", e)


# ARCHIVE (7/24): the spool only protects UNdelivered envelopes — a backend db reset wipes delivered
# rows with no local recovery path (happened twice in four days: codex dev resets). The archive is a
# durable append-only journal of EVERY envelope ever emitted, making the canonical record rebuildable
# from this machine at any time (replay is idempotent). Never pruned automatically.
ARCHIVE_PATH = os.path.expanduser(os.environ.get("CO_DUALWRITE_ARCHIVE", "~/.co/co_dualwrite_archive.jsonl"))
_archive_lock = threading.Lock()


def _archive(envelope: Dict[str, Any]) -> None:
    try:
        with _archive_lock:
            os.makedirs(os.path.dirname(ARCHIVE_PATH), exist_ok=True)
            with open(ARCHIVE_PATH, "a") as f:
                f.write(json.dumps(envelope) + "\n")
    except Exception as e:
        log.debug("co dualwrite archive append failed: %s", e)


def _flush_spool() -> None:
    """Opportunistically drain up to SPOOL_FLUSH_MAX spooled envelopes. A 'retry' outcome stops the
    drain (the backend is likely still down); flushed lines are removed atomically via temp file."""
    with _spool_lock:
        try:
            if not os.path.exists(SPOOL_PATH):
                return
            with open(SPOOL_PATH) as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
        except OSError as e:
            log.debug("co dualwrite spool read failed: %s", e)
            return
        if not lines:
            return
        head, rest = lines[:SPOOL_FLUSH_MAX], lines[SPOOL_FLUSH_MAX:]
        kept: List[str] = []
        stopped = False
        for ln in head:
            if stopped:
                kept.append(ln)
                continue
            try:
                env = json.loads(ln)
            except json.JSONDecodeError:
                continue                      # corrupt line: drop, never wedge the spool
            outcome = _post(env)
            if outcome == "retry":
                kept.append(ln)
                stopped = True
            # 'ok' and 'drop' both remove the line
        remaining = kept + rest
        try:
            tmp = SPOOL_PATH + ".tmp"
            with open(tmp, "w") as f:
                if remaining:
                    f.write("\n".join(remaining) + "\n")
            os.replace(tmp, SPOOL_PATH)
        except OSError as e:
            log.debug("co dualwrite spool rewrite failed: %s", e)


def _deliver(envelope: Dict[str, Any]) -> None:
    """Runs on the daemon thread only. Archive unconditionally, flush the spool, then send."""
    try:
        _archive(envelope)                 # durable journal first — delivery-independent
        _flush_spool()
        if _post(envelope) == "retry":
            _spool(envelope)
    except Exception as e:                    # belt and suspenders: a daemon thread never propagates
        log.debug("co dualwrite deliver failed: %s", e)
        try:
            _spool(envelope)
        except Exception:
            pass


def _spawn(fn) -> None:
    threading.Thread(target=fn, daemon=True).start()


# ----------------------------- public API (never blocks, never raises) -------
def emit_inbound(tenant_phone: str, external_message_id: Optional[str], text: str,
                 media_urls: Optional[List[str]], sent_at_iso: str,
                 enrichment_artifacts: Optional[List[Dict[str, Any]]] = None, *,
                 transport: Optional[str] = None, external_thread_id: Optional[str] = None) -> None:
    """Mirror one inbound user message. artifacts = what the eyes already produced (may be [])."""
    if not enabled():
        return
    try:
        env = _envelope("inbound", tenant_phone, external_message_id, text,
                        media_urls=media_urls, sent_at_iso=sent_at_iso, artifacts=enrichment_artifacts,
                        transport=transport, external_thread_id=external_thread_id)
        _spawn(lambda: _deliver(env))
    except Exception as e:
        log.debug("emit_inbound failed: %s", e)


def emit_outbound(tenant_phone: str, external_message_id_or_none: Optional[str], text: str,
                  sent_at_iso: str, *, transport: Optional[str] = None,
                  external_thread_id: Optional[str] = None) -> None:
    """Mirror one outbound reply — the engine owns its words in the canonical record too."""
    if not enabled():
        return
    try:
        env = _envelope("outbound", tenant_phone, external_message_id_or_none, text,
                        sent_at_iso=sent_at_iso, transport=transport,
                        external_thread_id=external_thread_id)
        _spawn(lambda: _deliver(env))
    except Exception as e:
        log.debug("emit_outbound failed: %s", e)


def emit_status(tenant_phone: str, external_message_id: Optional[str], status: str, *,
                transport: Optional[str] = None, external_thread_id: Optional[str] = None,
                error_code: Optional[str] = None) -> None:
    """Mirror an outbound status callback (SENT|DELIVERED|READ|ERROR): the contract's
    status variant — direction outbound, text empty, upserted by (transport, external_message_id)."""
    if not enabled():
        return
    try:
        env = _envelope("outbound", tenant_phone, external_message_id, "",
                        status=(status or "").upper() or None, transport=transport,
                        external_thread_id=external_thread_id,
                        transport_metadata={"error_code": error_code} if error_code else None)
        _spawn(lambda: _deliver(env))
    except Exception as e:
        log.debug("emit_status failed: %s", e)
