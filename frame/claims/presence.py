#!/usr/bin/env python3
"""PRESENCE — is the member at the keyboard right now (8/28).

Sendblue's typing_indicator webhook fires the moment a contact starts or stops typing, in real
time, straight off the device: {number, is_typing, from_number, timestamp}. It was registered
today and had never been subscribed before.

It answers a question co has never been able to ask. Every interruption law until now was a
GUESS about the moment — quiet hours, a daily budget, a read receipt from twenty hours ago. This
is the actual state of the person on the other end, and it costs nothing.

Three things it gives, in order of how much they are worth:

    NEVER INTERRUPT MID-SENTENCE. If they are typing, co holds. The whole "an interruption costs
    more at a bad moment" model had no way to see a bad moment; this is one, exactly.

    THE ABANDONED DRAFT. Typing starts, typing stops, nothing arrives. They wrote something and
    thought better of it. Nobody else in their life can see that, and it is the kind of signal
    that only exists in behaviour — never in words.

    PRESENCE BEATS A SCHEDULE. Typing at 11pm means awake, which is better evidence than a
    quiet-hours window guessing on their behalf.

Typing state is EPHEMERAL and fails open. A "started" with no "stopped" expires on its own,
because a webhook that goes missing must never leave co permanently muted.

    python3 presence.py <tenant>
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STATE = os.path.expanduser("~/.co/presence.json")
TYPING_TTL_S = 45            # a start with no stop expires: never mute co on a dropped webhook
DRAFT_WINDOW_S = 90          # stopped typing and nothing arrived within this = abandoned


def _load() -> dict:
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def _save(d: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(d, open(STATE, "w"))


def note(tenant: str, is_typing: bool, at: float | None = None) -> None:
    """Record a typing edge. Called from the webhook; never raises."""
    try:
        now = at or dt.datetime.now().timestamp()
        d = _load()
        prev = d.get(tenant) or {}
        row = {"typing": bool(is_typing), "at": now}
        if prev.get("typing") and not is_typing:
            row["stopped_at"] = now            # a candidate abandoned draft until a message lands
        elif is_typing:
            row["started_at"] = now
        d[tenant] = {**prev, **row}
        _save(d)
    except Exception:
        pass


def typing(tenant: str, ttl: int = TYPING_TTL_S) -> bool:
    """Are they typing right now? Expires on its own — a missing stop event must not mute co."""
    r = (_load().get(tenant) or {})
    if not r.get("typing"):
        return False
    return (dt.datetime.now().timestamp() - float(r.get("at", 0))) < ttl


def note_message(tenant: str) -> None:
    """A message landed, so whatever they were typing was sent rather than abandoned."""
    d = _load()
    if tenant in d:
        d[tenant].pop("stopped_at", None)
        d[tenant]["typing"] = False
        _save(d)


def abandoned(tenant: str) -> bool:
    """They started writing, stopped, and nothing arrived. A thought they talked themselves out
    of — recorded because it exists nowhere else, and acted on by nothing yet."""
    r = (_load().get(tenant) or {})
    s = r.get("stopped_at")
    if not s:
        return False
    age = dt.datetime.now().timestamp() - float(s)
    return DRAFT_WINDOW_S < age < DRAFT_WINDOW_S * 20


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    print(f"  typing now:      {typing(t)}")
    print(f"  abandoned draft: {abandoned(t)}")
    print(f"  raw:             {json.dumps(_load().get(t) or {})}")
