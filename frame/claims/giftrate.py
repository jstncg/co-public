#!/usr/bin/env python3
"""The gift rate — is co adding, or is it making them pull?

The measurement behind the gift law, computed from the transcript with ZERO user input.

The insight it operationalizes (8/4, from the Steve Jobs short): a flat reply is not just
dull, it is EXPENSIVE — the person has to spend their next message dragging co toward the
thing they wanted. He sent a video, got a verdict, then had to send "tell me about the 80/20
framework" and "explain relevant to my life." Two extra turns of work. So the honest test of
a reply is behavioral, not aesthetic:

    did it save them their next message, or cost them one?

A PULL is the user's next turn doing work the reply should have done: asking for the
explanation, the relevance, the meaning, or a bare confusion marker. A pull immediately after
co replies to something they SENT (a link, a clip, a thought) is a scored miss. Their own
follow-up thoughts, new sends, and answers to co's questions are not pulls.

    python3 giftrate.py                 # last 14 days, founder
    python3 giftrate.py --tenant p1647… --days 30
    python3 giftrate.py --show           # print the actual missed exchanges

Not a leaderboard: the number is only useful as a TREND against prompt/supply changes.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timedelta

PULL = re.compile(
    r"^\s*(?:"
    r"explain\b|elaborate\b|expand\b|go deeper\b|say more\b|"
    r"what(?:'s| is| do you)?\s*(?:mean|that mean)?\b\s*\??$|"
    r"wdym\b|what do you mean\b|huh\??$|\?+$|"
    r"tell me (?:more|about)\b|break (?:it|this|that) down\b|"
    r"(?:and )?relevant to (?:my|me)\b|how does (?:this|that) (?:apply|relate)\b|"
    r"so what\b|and\?|meaning\??$|why does that matter\b"
    r")", re.I)
# A send is content the person handed co (a link or a substantial thought) — the moment a gift
# is owed. Short conversational turns are not sends and are excluded from the denominator.
URL = re.compile(r"https?://")


def _transcript(tenant: str) -> list:
    """The ROUTER's transcript — the only record holding both roles. (claims.db.transcript.json is
    the journal's capture feed: user turns only, by design.)"""
    p = os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json")
    try:
        return json.load(open(p))
    except (OSError, json.JSONDecodeError):
        return []


def _fresh(turn: dict, cutoff: date) -> bool:
    ts = turn.get("ts") or ""
    try:
        return datetime.fromisoformat(ts).date() >= cutoff
    except ValueError:
        return True                       # undated turns (older writes) still count


def rate(tenant: str = "dennis", days: int = 14, show: bool = False) -> dict:
    turns = _transcript(tenant)
    cutoff = date.today() - timedelta(days=days)
    sends, pulls, misses = 0, 0, []
    for i, t in enumerate(turns):
        if t.get("role") != "user" or not _fresh(t, cutoff):
            continue
        text = str(t.get("content") or "")
        # a SEND: they handed over material (link) or a real thought (not a one-liner)
        if not (URL.search(text) or len(text.strip()) > 120):
            continue
        reply = next((x for x in turns[i + 1:i + 2] if x.get("role") == "assistant"), None)
        nxt = next((x for x in turns[i + 2:i + 3] if x.get("role") == "user"), None)
        if not reply or not nxt:
            continue
        sends += 1
        if PULL.search(str(nxt.get("content") or "")):
            pulls += 1
            if show:
                misses.append({"sent": text[:90], "co": str(reply.get("content") or "")[:110],
                               "pull": str(nxt.get("content") or "")[:60]})
    scored = sends or 1
    return {"tenant": tenant, "days": days, "sends_scored": sends, "pulls": pulls,
            "gift_rate": round(1 - pulls / scored, 3), "misses": misses}


if __name__ == "__main__":
    a = sys.argv[1:]
    t = a[a.index("--tenant") + 1] if "--tenant" in a else "dennis"
    d = int(a[a.index("--days") + 1]) if "--days" in a else 14
    r = rate(t, d, show="--show" in a)
    print(f"gift rate — {r['tenant']}, last {r['days']}d: {r['gift_rate']:.0%} "
          f"({r['sends_scored'] - r['pulls']}/{r['sends_scored']} sends didn't cost them a follow-up)")
    for m in r["misses"]:
        print(f"\n  sent: {m['sent']}\n  co:   {m['co']}\n  pull: {m['pull']}")
