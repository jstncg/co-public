#!/usr/bin/env python3
"""The receipt gate — no outbound claims an action without a machine-checkable receipt.

Epistemic-governance workstream 1 (8/10, executed 8/22): any outbound asserting an action
binds to a receipt state, and co may claim only the highest state actually reached. An
action kind with NO provable rung (the "added it to your notes app" class) is never
claimed at all. Enforced at send-time, not prompt-time: the prompt asks, this refuses.

Held is held: the member gets silence over a lie (the sev-0 was co inventing a reminder
it never set). The gate itself failing is different — a crash inside here fails OPEN,
because a broken guard must not mute the product.

    ok, why = gate(text, claims_db)      # why is None when ok
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re

# Apps co cannot write. A first-person done-verb near one of these, or sending the member
# to look inside one, is unprovable by construction — no receipt rung exists.
_APPS = r"(?:apple\s+)?(?:notes|reminders|calendar)(?:\s+app)?"
NO_CAPABILITY = [
    re.compile(rf"\b(?:added|saved|put|dropped|created|noted|logged)\b.{{0,40}}\b(?:your|the)\s+{_APPS}\b", re.I),
    re.compile(rf"\bcheck\s+(?:your|the)\s+{_APPS}\b", re.I),
    re.compile(rf"\b(?:it'?s|that'?s)\s+in\s+your\s+{_APPS}\b", re.I),
]

# "reminder set" claims → an anchor row must exist, created recently or still pending.
REMINDER_CLAIM = re.compile(
    r"\b(?:reminder(?:'s| is| has been)? set|set(?:ting)? (?:a|the|that|your) reminder|"
    r"i(?:'ll| will) remind you|scheduled (?:a|the|that) reminder)\b", re.I)

# "keeping an eye on it" claims → an active watch row must exist.
WATCH_CLAIM = re.compile(
    r"\b(?:i(?:'ll| will|'m| am)? ?(?:keep|keeping) an eye on|"
    r"i(?:'ll| will) (?:watch for|be watching)|got a watch (?:on|running))\b", re.I)

_ANCHOR_RECENT_S = 20 * 60     # a claim in the same exchange as the ask


def _anchor_receipt(claims_db: str) -> bool:
    """persisted: an anchor row created inside the exchange window, or still unfired."""
    try:
        st = json.load(open(f"{claims_db}.anchors.json"))
    except Exception:
        return False
    now = dt.datetime.now()
    for a in st.get("anchors", []):
        if not a.get("fired"):
            return True
        try:
            made = dt.datetime.fromisoformat(a.get("created", ""))
            if (now - made).total_seconds() < _ANCHOR_RECENT_S:
                return True
        except ValueError:
            continue
    return False


def _watch_receipt(claims_db: str) -> bool:
    """persisted: any watch row still active."""
    try:
        import sqlite3
        c = sqlite3.connect(claims_db)
        n = c.execute("SELECT COUNT(*) FROM watches WHERE status='active'").fetchone()[0]
        c.close()
        return n > 0
    except Exception:
        return False


_NEGATION = re.compile(r"\b(?:can'?t|cannot|won'?t|couldn'?t|no way to|unable to|don'?t)\s+(?:\w+\s+){0,3}$", re.I)


def _denied(t: str, m: re.Match) -> bool:
    """An honest denial makes no claim: 'can't actually set a reminder' passes."""
    return bool(_NEGATION.search(t[:m.start()]))


# THE OTHER HALF OF THE GATE (9/3). Everything above checks a claim about CO's own actions — a
# reminder set, a watch running, a note written. Nothing checked a claim about THEIRS, so on 9/2 co
# shipped "still waiting on that typography redo from four days ago" and then "typography redo's been
# sitting since saturday", neither of which had ever existed, and admitted the invention when asked.
# Hard law 2 already required this ("every 'you said' points at a specific you can produce ON
# DEMAND") and was enforced by nothing. Held is held: silence beats an invented obligation.
_OBLIGATION = re.compile(
    r"\b(still waiting on|been sitting (?:since|for)|you said you'?d|you told me you'?d|"
    r"you (?:committed|promised)|you were going to|you never (?:did|finished|sent|shipped|touched)|"
    r"hasn'?t moved since|still (?:haven'?t|hasn'?t) )\b", re.I)
# Spelled-out durations are the common form and were the actual one: "from four days ago", not
# "from 4 days ago". A digits-only pattern let the message that started all this straight through.
_COUNT = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple(?: of)?|several)"
_UNIT = r"(?:days?|weeks?|months?)"
_WHEN = re.compile(
    rf"\b{_COUNT}\s*{_UNIT}\s+ago\b"
    rf"|\b(?:since|from|for)\s+(?:\w+day|last \w+|yesterday|this (?:week|morning)|{_COUNT}\s*{_UNIT})\b",
    re.I)
_STOP = {"that", "this", "your", "yours", "their", "about", "since", "from", "days", "week",
         "weeks", "month", "still", "waiting", "sitting", "there", "which", "would", "could"}


def _member_receipt(claims_db: str, claim: str) -> bool:
    """Does anything on the record carry this obligation? Anchors hold what they actually asked for;
    a claim that shares no distinctive word with any of them is not something they ever said."""
    try:
        rows = json.load(open(f"{claims_db}.anchors.json")).get("anchors") or []
    except Exception:
        return False
    words = {w for w in re.findall(r"[a-z]{5,}", claim.lower()) if w not in _STOP}
    if not words:
        return False
    hay = " ".join(f"{a.get('what','')} {a.get('quote','')}" for a in rows).lower()
    return any(w in hay for w in words)


def gate(text: str, claims_db: str | None = None) -> tuple[bool, str | None]:
    """(ok, why_held). Crash inside → open, with the reason lost rather than the message."""
    try:
        t = text or ""
        for pat in NO_CAPABILITY:
            if pat.search(t):
                return False, f"no-capability claim: {pat.search(t).group(0)[:60]!r}"
        if claims_db and os.path.exists(claims_db):
            m = REMINDER_CLAIM.search(t)
            if m and not _denied(t, m) and not _anchor_receipt(claims_db):
                return False, "reminder claimed, no anchor row"
            m = WATCH_CLAIM.search(t)
            if m and not _denied(t, m) and not _watch_receipt(claims_db):
                return False, "watch claimed, no active watch row"
            # An obligation pinned to a date is a claim about their past, and it needs a receipt
            # exactly as co's own promises do. Both halves must be present: "you said" alone is
            # conversation, "since saturday" alone is a fact about the world.
            m = _OBLIGATION.search(t)
            if m and _WHEN.search(t) and not _member_receipt(claims_db, t):
                return False, f"member obligation claimed, nothing on the record: {m.group(0)!r}"
        return True, None
    except Exception:
        return True, None
