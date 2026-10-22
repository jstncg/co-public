#!/usr/bin/env python3
"""The Instagram DM door — kyo's flagship surface (kyo/ig_door.py), absorbed into the one product.

DMing a reel to a contact is the most native share behavior on the platform, so co lives in
the DMs as a contact you send things to. Webhook mode ONLY (Meta's official Instagram
Messaging API — kyo's poll mode was queued for deletion by its own author and stays dead).

The laws, kept verbatim from kyo because research wrote them:
  - NO WORDS ON IG: a share is captured QUIETLY; the door's only feedback is one heart
    reaction — the receipt that says "held it." A typed message is redirected HOME over
    iMessage, once, with a 7-day cooldown.
  - Identity is bound by phone: an IG user proves who they are with a code co texts to the
    number THEY typed (never a guessed one), so an IG share lands in the SAME memory as
    their texts. Codes are hashed at rest, 10-minute TTL, 3 attempts.
  - ROSTER GATE: no code is ever texted to a number that isn't already invited (the
    allowlist is the roster). The refusal reads identical to success — the door must not
    become a membership oracle. Strikes escalate to silence, never to argument.
  - Echoes, receipts, and reactions are skipped; webhook redeliveries dedupe on item id.

Flag: CO_IG_DOOR=1 + CO_IG_GRAPH_TOKEN/CO_IG_APP_SECRET/CO_IG_VERIFY_TOKEN. Off = zero
footprint (the router's /ig-webhook 404s). State: ~/.co/ig/.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

STATE_DIR = Path(os.path.expanduser("~/.co/ig"))
CODE_TTL = 600
MAX_ATTEMPTS = 3
REDIRECT_COOLDOWN_DAYS = 7
_WH_SHARE_TYPES = {"ig_reel": "reel", "share": "post", "video": "video"}

# Fixed in-voice copy — the door never calls the model (plumbing, not conversation).
ASK_PHONE = ("gotta confirm who you are first",
             "whats ur number? i'll send you a code so i can verify")
ASK_CODE = ("just sent over the code", "lmk what it is")
BAD_CODE = "doesn't look right, try again"
TROLLING = "need an actual number to let you in"
SHRUG = "no number, no door \U0001f937"
BOUND = "locked in — send me anything here and it lands in the same place as your texts"
REDIRECT = "i live in your texts, not here — text me instead and this stays the drop box"


def _now() -> float:
    return time.time()


class IGState:
    """Durable door state: bindings, mid-verification, webhook dedupe. Atomic writes."""

    def __init__(self, root: Path = STATE_DIR) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def _load(self, name: str) -> dict:
        try:
            return json.loads((self.root / name).read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _save(self, name: str, data: dict) -> None:
        tmp = self.root / (name + ".tmp")
        tmp.write_text(json.dumps(data))
        os.replace(tmp, self.root / name)

    def bindings(self) -> dict:
        return self._load("bindings.json")

    def bind(self, ig_user: str, phone: str) -> None:
        b = self.bindings()
        b[ig_user] = {"phone": phone, "bound_at": _now()}
        self._save("bindings.json", b)

    def pending(self) -> dict:
        return self._load("pending.json")

    def set_pending(self, ig_user: str, rec: dict | None) -> None:
        p = self.pending()
        if rec is None:
            p.pop(ig_user, None)
        else:
            p[ig_user] = rec
        self._save("pending.json", p)

    def wh_seen(self, item_id: str) -> bool:
        return item_id in (self._load("wh_seen.json").get("ids") or [])

    def mark_wh_seen(self, item_id: str) -> None:
        d = self._load("wh_seen.json")
        ids = (d.get("ids") or [])[-500:]
        ids.append(item_id)
        self._save("wh_seen.json", {"ids": ids})

    def redirected_recently(self, ig_user: str) -> bool:
        b = self.bindings().get(ig_user) or {}
        return _now() - (b.get("redirected_at") or 0) < REDIRECT_COOLDOWN_DAYS * 86400

    def mark_redirected(self, ig_user: str) -> None:
        b = self.bindings()
        if ig_user in b:
            b[ig_user]["redirected_at"] = _now()
            self._save("bindings.json", b)


class GraphClient:
    """Meta's Instagram Messaging API — this client only speaks and reacts (receiving is push)."""

    API = "https://graph.instagram.com/v23.0"

    def __init__(self, token) -> None:
        self._token = token

    def _bearer(self) -> str:
        return self._token() if callable(self._token) else self._token

    def send_dm(self, user_id: str, text: str) -> None:
        self._post({"recipient": {"id": str(user_id)}, "message": {"text": text}})

    def react(self, user_id: str, message_id: str) -> None:
        self._post({"recipient": {"id": str(user_id)}, "sender_action": "react",
                    "payload": {"message_id": message_id, "reaction": "love"}})

    def _post(self, body: dict) -> None:
        import urllib.request
        req = urllib.request.Request(
            f"{self.API}/me/messages", data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self._bearer()}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()


def parse_webhook(payload: dict) -> list:
    """Meta's POST body → [(ig_user_id, item), ...]. Echoes/receipts/reactions skipped;
    malformed entries dropped, never raised — a webhook body is untrusted input."""
    out = []
    for entry in (payload or {}).get("entry", []) or []:
        for ev in entry.get("messaging", []) or []:
            msg = ev.get("message")
            if not isinstance(msg, dict) or msg.get("is_echo"):
                continue
            sender = str(((ev.get("sender") or {}).get("id")) or "")
            mid = str(msg.get("mid") or "")
            if not sender or not mid:
                continue
            for i, att in enumerate(msg.get("attachments") or []):
                kind = _WH_SHARE_TYPES.get((att or {}).get("type"))
                pay = (att or {}).get("payload") or {}
                if not kind or not pay.get("url"):
                    continue
                out.append((sender, {"item_id": f"{mid}:{i}", "mid": mid, "type": kind,
                                     "caption": str(pay.get("title") or ""),
                                     "media_url": str(pay.get("url"))}))
            if str(msg.get("text") or "").strip():
                out.append((sender, {"item_id": f"{mid}:t", "mid": mid, "type": "text",
                                     "text": str(msg.get("text"))}))
    return out


def verify_signature(app_secret: str, raw_body: bytes, header: str) -> bool:
    """X-Hub-Signature-256 — reject forged webhook POSTs before parsing anything."""
    if not app_secret:
        return True
    want = "sha256=" + hmac.new(app_secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, header or "")


class IGDoor:
    """The state machine. Injected seams (send_sms / capture / is_rostered / tenant_of)
    keep this module free of router imports — same law as kyo's engine_bridge."""

    def __init__(self, ig: GraphClient, state: IGState, send_sms, capture, is_rostered,
                 tenant_of) -> None:
        self.ig = ig
        self.state = state
        self.send_sms = send_sms            # (phone, text) -> None   (sendblue)
        self.capture = capture              # (tenant, text) -> None  (journal + eyes)
        self.is_rostered = is_rostered      # (phone) -> bool         (the allowlist)
        self.tenant_of = tenant_of          # (phone) -> str

    def handle_webhook_item(self, ig_user: str, item: dict) -> bool:
        if self.state.wh_seen(item["item_id"]):
            return False
        self.state.mark_wh_seen(item["item_id"])
        binding = self.state.bindings().get(ig_user)
        if binding and binding.get("phone"):
            self._handle_bound(ig_user, binding, item)
        else:
            self._handle_unverified(ig_user, item)
        return True

    def _say(self, ig_user: str, copy) -> None:
        beats = copy if isinstance(copy, (list, tuple)) else (copy,)
        for beat in beats:                   # one DM per beat — a boundary in a paragraph is fine print
            try:
                self.ig.send_dm(ig_user, beat)
            except Exception:
                return

    def _handle_bound(self, ig_user: str, binding: dict, item: dict) -> None:
        phone = binding["phone"]
        tenant = self.tenant_of(phone)
        if item["type"] == "text":
            # words belong at home. Once; then a week of quiet on this.
            if not self.state.redirected_recently(ig_user):
                self._say(ig_user, REDIRECT)
                self.state.mark_redirected(ig_user)
            return
        # a share: capture quietly into the SAME memory as their texts; heart = "held it"
        cap = (item.get("caption") or "").strip()
        self.capture(tenant, f"[shared on instagram] {cap} {item.get('media_url', '')}".strip())
        try:
            self.ig.react(ig_user, item["mid"])
        except Exception:
            pass                             # the capture landed; the heart is best-effort

    def _handle_unverified(self, ig_user: str, item: dict) -> None:
        rec = self.state.pending().get(ig_user)
        text = (item.get("text") or "").strip()
        if rec is None:
            self._say(ig_user, ASK_PHONE)
            self.state.set_pending(ig_user, {"step": "await_phone", "strikes": 0})
            return
        if rec["step"] == "await_phone":
            digits = re.sub(r"[^\d]", "", text)
            if len(digits) < 10:
                strikes = int(rec.get("strikes") or 0) + 1
                self.state.set_pending(ig_user, {"step": "await_phone", "strikes": strikes})
                if strikes == 1:
                    self._say(ig_user, TROLLING)
                elif strikes == 2:
                    self._say(ig_user, SHRUG)
                return                       # 3rd and beyond: silence — a troll gets no loop
            e164 = "+" + digits if len(digits) >= 11 else "+1" + digits
            # ROSTER GATE: no SMS to a stranger's typed number; the reply reads the same
            # either way so the door is not a membership oracle.
            if not self.is_rostered(e164):
                strikes = int(rec.get("strikes") or 0) + 1
                self.state.set_pending(ig_user, {"step": "await_phone", "strikes": strikes})
                if strikes <= 2:
                    self._say(ig_user, SHRUG)
                return
            code = f"{secrets.randbelow(1000000):06d}"
            self.state.set_pending(ig_user, {
                "step": "await_code", "phone": e164,
                "code_hash": hashlib.sha256(code.encode()).hexdigest(),
                "expires": _now() + CODE_TTL, "attempts": 0})
            self.send_sms(e164, f"co here — your instagram link code is {code}")
            self._say(ig_user, ASK_CODE)
            return
        if rec["step"] == "await_code":
            if _now() > rec.get("expires", 0):
                self.state.set_pending(ig_user, None)
                self._say(ig_user, ASK_PHONE)
                self.state.set_pending(ig_user, {"step": "await_phone", "strikes": 0})
                return
            got = re.sub(r"[^\d]", "", text)
            if hashlib.sha256(got.encode()).hexdigest() == rec.get("code_hash"):
                self.state.bind(ig_user, rec["phone"])
                self.state.set_pending(ig_user, None)
                self._say(ig_user, BOUND)
                return
            attempts = int(rec.get("attempts") or 0) + 1
            if attempts >= MAX_ATTEMPTS:
                self.state.set_pending(ig_user, None)
                return
            rec["attempts"] = attempts
            self.state.set_pending(ig_user, rec)
            self._say(ig_user, BAD_CODE)
