#!/usr/bin/env python3
"""THE RAIL — one door out, and the provider behind it is swappable.

Seven places called the Sendblue API directly. Four of them were in the router, but journal.py and
cold_open.py sent around daily_text._sendblue entirely, so they wore the disposition belt and none
of the gates that door had accumulated: the abstain guard, the shape hold, dedup, the receipt gate.
An abstain-shaped line or a 900-character briefing from either shipped unguarded, which is the
class of send that reached a member on 8/03 and 8/17.

So the split here is not really about vendors. The gates are what co owes the member and they are
the same whoever carries the bytes; the transport is an implementation detail that is about to
change. Keeping them in one function meant every new caller chose, accidentally, how guarded it was.

send() returns (ok, evidence). Never a bare bool: a caller that receives True with nothing behind
it is how execute() marked a message sent for three months.

    CO_RAIL=sendblue|linq     which transport carries it (default sendblue)
    LINQ_API_KEY              bearer token from dashboard.linqapp.com/api-tooling
    LINQ_FROM_NUMBER          co's Linq line, used only to label typing events
    LINQ_WEBHOOK_SECRET       signing secret returned once when the subscription is created
"""
from __future__ import annotations

import os
import threading
import time


def _belt(text: str) -> str:
    try:
        import disposition
        return disposition.sanitize(text)
    except Exception:
        return text


def _held(phone: str, content: str) -> str:
    """Why this send must not go, or "". The gates, in cost order."""
    try:
        import disposition
        shape = disposition.refusal(content)
        if shape:
            return f"abstain: the composer explained itself ({shape!r})"
        bubbles = [b for b in content.split("\n\n") if b.strip()]
        longest = max((len(b) for b in bubbles), default=0)
        if longest > 450 or len(bubbles) > 3:
            return f"shape: {len(bubbles)} beat(s), longest {longest}ch (max 3 / 450)"
    except Exception:
        pass
    try:
        import daily_text
        if daily_text._sent_before(phone, content):
            return "dedup: identical proactive send inside the guard window"
    except Exception:
        pass
    try:
        import journal
        import receipts
        norm = "".join(c for c in (phone or "") if c.isdigit())
        founder = "".join(c for c in os.environ.get("CO_FOUNDER_HANDLE", "") if c.isdigit())
        tenant = os.environ.get("CO_FOUNDER_TENANT", "dennis") if (founder and norm == founder) else f"p{norm}"
        ok, why = receipts.gate(content, journal._claims_db(tenant))
        if not ok:
            return f"receipt-gate: {why}"
    except Exception:
        pass
    return ""


def _send_sendblue(phone: str, content: str, media_url: str = "") -> tuple:
    import requests
    key = os.environ.get("SENDBLUE_API_KEY_ID") or os.environ.get("SENDBLUE_API_KEY", "")
    sec = os.environ.get("SENDBLUE_API_SECRET") or os.environ.get("SENDBLUE_SECRET_KEY", "")
    if not (key and sec):
        return False, "sendblue creds missing"
    body = {"number": phone, "content": content}
    if media_url:
        body["media_url"] = media_url
    if os.environ.get("SENDBLUE_FROM_NUMBER"):
        body["from_number"] = os.environ["SENDBLUE_FROM_NUMBER"]
    cb, tok = os.environ.get("WEBHOOK_PUBLIC_URL", "").rstrip("/"), os.environ.get("WEBHOOK_TOKEN", "")
    if cb and tok:
        body["status_callback"] = f"{cb}/hook/{tok}"
    try:
        r = requests.post("https://api.sendblue.com/api/send-message", json=body, timeout=20,
                          headers={"sb-api-key-id": key, "sb-api-secret-key": sec,
                                   "Content-Type": "application/json"})
        r.raise_for_status()
        return True, str((r.json() or {}).get("message_handle") or "sent")
    except Exception as e:
        return False, f"sendblue refused: {e}"


# ---------------- Linq (CO_RAIL=linq, sandbox live 9/2) ----------------
# Linq addresses a chat, not a number: a send takes `to` and answers with a chat_id, and every
# later event (delivered, read, typing) names only the chat. So the rail keeps the phone<->chat
# pairing it learns from both directions; without it a read receipt could not find its member.
LINQ_API = "https://api.linqapp.com/api/partner/v3"
_LINQ_CHATS = os.path.expanduser("~/.co/linq_chats.json")
_linq_chats_lock = threading.RLock()


def _linq_post(path: str, body: dict | None, timeout: int = 20) -> dict:
    """One authenticated call. Raises on HTTP failure so callers report the refusal verbatim."""
    import requests
    key = os.environ.get("LINQ_API_KEY", "")
    if not key:
        raise RuntimeError("LINQ_API_KEY missing")
    r = requests.post(f"{LINQ_API}{path}", json=body, timeout=timeout,
                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    if not r.ok:                       # Linq's body names the refusal; the status line alone hid 2015
        try:
            err = (r.json() or {}).get("error") or {}
            raise RuntimeError(f"{r.status_code} {err.get('message') or r.text[:120]} (code {err.get('code')})")
        except ValueError:
            raise RuntimeError(f"{r.status_code} {r.text[:120]}")
    try:
        return r.json() or {}
    except ValueError:
        return {}


def _chats() -> dict:
    with _linq_chats_lock:
        try:
            import json
            with open(_LINQ_CHATS) as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}


def _chats_note(phone: str, chat_id: str, is_group: bool = False) -> None:
    if not (phone and chat_id):
        return
    import json
    with _linq_chats_lock:
        data = _chats()
        by_phone = data.setdefault("by_phone", {})
        by_chat = data.setdefault("by_chat", {})
        groups = set(data.get("groups") or [])
        if is_group:
            # Co is a private one-to-one relationship. Never let a group chat become the saved
            # route for one member: a later private reply would otherwise land in that group.
            previous_phone = by_chat.pop(chat_id, None)
            if previous_phone and by_phone.get(previous_phone) == chat_id:
                by_phone.pop(previous_phone, None)
            groups.add(chat_id)
        else:
            by_phone[phone] = chat_id
            by_chat[chat_id] = phone
            groups.discard(chat_id)
        data["groups"] = sorted(groups)
        tmp = _LINQ_CHATS + ".tmp"
        os.makedirs(os.path.dirname(_LINQ_CHATS), exist_ok=True)
        with open(tmp, "w") as handle:
            json.dump(data, handle)
        os.chmod(tmp, 0o600)
        os.replace(tmp, _LINQ_CHATS)


def linq_chat_for(phone: str) -> str:
    return str((_chats().get("by_phone") or {}).get(phone) or "")


def linq_phone_for(chat_id: str) -> str:
    return str((_chats().get("by_chat") or {}).get(chat_id) or "")


def linq_is_group(chat_id: str) -> bool:
    return chat_id in set(_chats().get("groups") or [])


def _send_linq(phone: str, content: str, media_url: str = "") -> tuple:
    """Into the chat when one is known, else to the number. The sandbox line (9/2) is not in the
    account's sendable pool, so the number form answers 409 "no eligible sending line" and only a
    chat the member opened can carry a reply. A production line lifts that; the routing stays."""
    parts = [{"type": "text", "value": content}]
    if media_url:
        parts.append({"type": "media", "url": media_url})
    chat_id = linq_chat_for(phone)
    body = {"message": {"parts": parts}}
    if not chat_id:
        body["to"] = [phone]
        if os.environ.get("LINQ_FROM_NUMBER"):
            body["from"] = os.environ["LINQ_FROM_NUMBER"]
    try:
        # A caller-selected line starts a chat through /chats. /messages deliberately auto-selects
        # a line, which is the wrong primitive for a stable Co identity.
        path = f"/chats/{chat_id}/messages" if chat_id else ("/chats" if body.get("from") else "/messages")
        j = _linq_post(path, body)
    except Exception as e:
        return False, f"linq refused: {e}"
    _chats_note(phone, str(j.get("chat_id") or ""))
    return True, str((j.get("message") or {}).get("id") or "sent")


def linq_typing(phone: str) -> bool:
    """Typing is per chat on Linq, so it only works for a phone the rail has already paired."""
    chat_id = linq_chat_for(phone)
    if not chat_id:
        return False
    try:
        _linq_post(f"/chats/{chat_id}/typing", None, timeout=10)
        return True
    except Exception:
        return False


def linq_mark_read(phone: str) -> bool:
    """The read receipt Sendblue never had: the member sees "Read" under what they sent."""
    chat_id = linq_chat_for(phone)
    if not chat_id:
        return False
    try:
        _linq_post(f"/chats/{chat_id}/read", None, timeout=10)
        return True
    except Exception:
        return False


def linq_react(message_id: str, kind: str, emoji: str = "") -> bool:
    """Tapback on an inbound message by Linq id. Sendblue's six types, plus the custom slot Linq
    adds — which is what lets a 👀 be an actual reaction on their message rather than a text
    bubble containing an eyes emoji, the thing the founder called horrible on 9/3."""
    if not message_id:
        return False
    body = {"operation": "add", "type": "custom", "custom_emoji": emoji} if emoji \
        else {"operation": "add", "type": kind}
    try:
        _linq_post(f"/messages/{message_id}/reactions", body, timeout=10)
        return True
    except Exception:
        return False


def linq_verify(secret: str, headers, raw: bytes, now: float | None = None) -> bool:
    """Verify a Standard Webhooks signature and its five-minute replay window."""
    import base64
    import hashlib
    import hmac
    mid = headers.get("webhook-id", ""); ts = headers.get("webhook-timestamp", "")
    sig = headers.get("webhook-signature", "")
    if not (secret and mid and ts and sig):
        return False
    try:
        sent_at = int(ts)
        if abs((time.time() if now is None else now) - sent_at) > 300:
            return False
        key = base64.b64decode(secret[6:] if secret.startswith("whsec_") else secret)
    except Exception:
        return False
    want = base64.b64encode(hmac.new(key, f"{mid}.{ts}.".encode() + raw, hashlib.sha256).digest()).decode()
    return any(part.startswith("v1,") and hmac.compare_digest(want, part[3:]) for part in sig.split())


def linq_event(event: dict):
    """One Linq webhook -> (kind, payload) in the shapes the router's Sendblue handlers already take,
    so both providers share every handler below the door. None for events co has no use for."""
    et = str(event.get("event_type") or "")
    d = event.get("data") or {}
    chat_id = str((d.get("chat") or {}).get("id") or d.get("chat_id") or "")
    legacy_message = d.get("message") or {}
    parts = d.get("parts") or legacy_message.get("parts") or []
    if et == "message.received":
        sender = str((d.get("sender_handle") or d.get("from_handle") or {}).get("handle") or d.get("from") or "")
        is_group = bool((d.get("chat") or {}).get("is_group") or d.get("is_group"))
        _chats_note(sender, chat_id, is_group)
        if is_group:
            return None
        text = "\n".join(str(p.get("value") or "") for p in parts if p.get("type") == "text").strip()
        media = [p["url"] for p in parts if p.get("type") == "media" and p.get("url")]
        return "message", {"from_number": sender, "content": text, "media_url": media,
                           "message_handle": str(d.get("id") or legacy_message.get("id") or ""),
                           "external_thread_id": chat_id, "transport": "linq"}
    if et in ("message.sent", "message.delivered", "message.read", "message.failed"):
        status = "ERROR" if et == "message.failed" else et.split(".")[1].upper()
        payload = {"number": linq_phone_for(chat_id), "status": status,
                   "message_handle": str(d.get("id") or d.get("message_id") or legacy_message.get("id") or ""),
                   "external_thread_id": chat_id, "transport": "linq", "is_outbound": True}
        if status == "ERROR" and d.get("code") is not None:
            payload["error_code"] = str(d["code"])
        return "status", payload
    if et == "reaction.added" and not d.get("is_from_me"):
        return "reaction", {"from_number": str(d.get("from") or ""), "reaction": str(d.get("reaction_type") or ""),
                            "message_handle": str(d.get("message_id") or "")}
    # TYPING (9/2). The payload names only the chat, never the person, so this looked
    # unattributable: co posts its own typing indicator into the same chat while it composes, and
    # feeding that back to the burst hold would delay every reply by up to 30s and tell the
    # presence lane the member is active when they are not.
    #
    # Measured instead of assumed: co POSTed a typing indicator to its own chat (204) and Linq
    # sent back nothing. Its own typing is not echoed. So in a chat with one other person, a
    # typing event is that person's hands and nothing else. A GROUP is still unattributable —
    # Linq's own docs say you learn someone is typing, not who — so those are dropped.
    if et in ("chat.typing_indicator.started", "chat.typing_indicator.stopped"):
        num = linq_phone_for(chat_id)
        if not num or linq_is_group(chat_id):
            return None
        return "typing", {"number": num, "is_typing": et.endswith("started"),
                          "from_number": os.environ.get("LINQ_FROM_NUMBER", "")}
    return None


PROVIDERS = {"sendblue": _send_sendblue, "linq": _send_linq}


def transport(phone: str, content: str, media_url: str = "") -> tuple:
    """The bytes only, on whichever provider CO_RAIL names. For callers that run their own gates."""
    return PROVIDERS[provider()](phone, content, media_url)


def provider() -> str:
    p = os.environ.get("CO_RAIL", "sendblue").strip().lower()
    if p not in PROVIDERS:
        raise ValueError(f"unsupported CO_RAIL {p!r}; expected one of {', '.join(PROVIDERS)}")
    return p


def from_number() -> str:
    """The public texting identity for the selected carrier."""
    return os.environ.get("LINQ_FROM_NUMBER" if provider() == "linq" else "SENDBLUE_FROM_NUMBER", "")


def send(phone: str, content: str, *, media_url: str = "", gated: bool = True) -> tuple:
    """Send one message. Returns (ok, evidence). gated=False is the conversational path, which
    answers a question the member just asked and must not be held for dedup or shape."""
    if not phone or not (content or "").strip():
        return False, "nothing to send"
    content = _belt(content)
    if gated:
        why = _held(phone, content)
        if why:
            return False, why
    ok, evidence = PROVIDERS[provider()](phone, content, media_url)
    if ok:
        _book(phone, content, evidence)
    return ok, evidence


def _book(phone: str, content: str, handle: str) -> None:
    """Bookkeeping after a proved send. Lives above the provider because a send is a send whoever
    carried it: the dedup mark is what makes the guard able to trip at all, and the ledger row with
    its handle is what lets a status callback join read/delivered to THIS message."""
    try:
        import daily_text
        daily_text._mark_sent(phone, content)
    except Exception:
        pass
    try:
        import daily_text
        import landed
        landed.record(daily_text._tenant_for_phone(phone), content, handle=handle)
    except Exception:
        pass
