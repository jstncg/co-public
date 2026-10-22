#!/usr/bin/env python3
"""Outcomes — the check-back that closes the ring (8/24, the Abelique loop).

Co could hold Thursday 8pm and never learn whether Thursday happened. That gap is the
difference between a calendar and a witness: cybernetics needs SENSE and COMPARE, not just
act. So when a committed window passes, co asks exactly one short question, once, and the
answer becomes ground truth every other organ can compound on.

Sources of a commitment: a fired requested anchor, an hour co held on their calendar, an
accepted proposal. Laws: one check-back a day, evening only, never later than 3 days after
the window, never re-asked, never nagged. A non-answer is recorded as unknown and dropped.

    python3 outcomes.py <tenant>            # stage
    python3 outcomes.py <tenant> --send     # ask, live
    python3 outcomes.py <tenant> --sweep    # classify replies to a pending ask
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STORE = os.path.expanduser("~/.co/outcomes")
EVENING = (17, 22)
MAX_AGE_DAYS = 3

ASK_SYS = """You are co, texting one person one short question to find out whether a thing they
committed to actually happened. Rules: under 12 words, lowercase, no preamble, no encouragement,
no em-dashes, no "just checking in". Reference the thing concretely. Examples of the register:
"did thursday's stream happen?" / "make it to the gym this morning?" / "how'd the pitch go".
Reply ONLY JSON: {"text": "..."}"""

VERDICT_SYS = """Classify whether the person's reply says the committed thing happened.
Reply ONLY JSON: {"verdict": "happened" | "didnt" | "partial" | "unclear", "why": "<their own
words, verbatim, max 12 words, or empty>"}. happened = it occurred. didnt = it did not.
partial = started/shortened/moved. unclear = they answered something else."""


def _path(tenant: str) -> str:
    os.makedirs(STORE, exist_ok=True)
    return os.path.join(STORE, f"{tenant}.json")


def _load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {"asked": [], "outcomes": []}


def _save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False)


def _allowed(tenant: str) -> bool:
    allow = [t.strip() for t in os.environ.get("CO_PROACTIVE_HANDLES", "").split(",") if t.strip()]
    founder = os.environ.get("CO_FOUNDER_TENANT", "dennis")
    return tenant == founder if not allow else True


def commitments(tenant: str) -> list[dict]:
    """Windows that have PASSED and were really theirs. Each: {key, what, when}."""
    out = []
    today = dt.date.today()
    horizon = today - dt.timedelta(days=MAX_AGE_DAYS)
    try:                                            # requested reminders that fired
        import anchors
        import journal
        st = anchors._load(journal._claims_db(tenant))
        for a in st.get("anchors", []):
            if not a.get("fired") or not a.get("requested"):
                continue
            try:
                when = dt.datetime.fromisoformat(a["when"]).date()
            except Exception:
                continue
            if horizon <= when <= today:
                out.append({"key": f"anchor:{(a.get('what') or '')[:50]}",
                            "what": a.get("what") or "", "when": when.isoformat()})
    except Exception:
        pass
    try:                                            # hours co held on their calendar
        cal = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
        for ev in cal.get("events", []):
            if not ev.get("made_by_co"):
                continue
            try:
                when = dt.datetime.fromisoformat(ev["start"].replace("Z", "+00:00"))
            except Exception:
                continue
            if dt.datetime.now(when.tzinfo) > when and horizon <= when.date() <= today:
                out.append({"key": f"held:{ev['title'][:50]}", "what": ev["title"],
                            "when": when.date().isoformat()})
    except Exception:
        pass
    try:                                            # proposals they said yes to
        import propose_lane
        for p in _load_props(tenant):
            if p.get("status") != "yes":
                continue
            when = (p.get("created") or "")[:10]
            if when and horizon.isoformat() <= when <= today.isoformat():
                out.append({"key": f"prop:{p.get('key', '')}", "what": p.get("text", "")[:120],
                            "when": when})
        del propose_lane
    except Exception:
        pass
    return out


def _load_props(tenant: str) -> list[dict]:
    try:
        import propose_lane
        return propose_lane._load(tenant).get("proposals") or []
    except Exception:
        return []


def pending(tenant: str) -> dict | None:
    st = _load(tenant)
    for a in reversed(st["asked"]):
        if a.get("status") == "waiting":
            return a
    return None


def sweep(tenant: str) -> list[str]:
    """A pending ask meets their next words: the verdict is recorded, once, then closed."""
    import llm
    st = _load(tenant)
    # The pending entry must come from THIS store object: pending() re-loads, and mutating a
    # detached copy silently drops every status change on save.
    p = next((a for a in reversed(st["asked"]) if a.get("status") == "waiting"), None)
    if not p:
        return []
    # Staleness closes FIRST, before any read that can fail: an ask that can never be answered
    # must not hold the lane hostage — a stuck "waiting" would mute check-backs forever.
    try:
        stale = (dt.datetime.now() - dt.datetime.fromisoformat(p["asked_at"])).days >= 2
    except ValueError:
        stale = True
    try:
        import journal
        turns = json.load(open(journal._claims_db(tenant) + ".transcript.json"))
    except Exception:
        turns = []
    after = [t for t in turns if t.get("role") == "user" and (t.get("ts") or "") > p["asked_at"]][:2]
    if not after:
        if stale:
            p["status"] = "no_answer"                # silence closes it; never re-asked
            _save(tenant, st)
        return []
    reply = " / ".join((t.get("content") or "")[:140] for t in after)
    got = llm.ask_json(llm.json_specs(), VERDICT_SYS,
                       f"co asked: {p['text']}\nthey replied: {reply}", max_tokens=120) or {}
    v = got.get("verdict")
    if v not in ("happened", "didnt", "partial"):
        p["status"] = "unclear"
        _save(tenant, st)
        return []
    p["status"] = "answered"
    st["outcomes"].append({"what": p["what"], "when": p["when"], "verdict": v,
                           "words": str(got.get("why") or "")[:120],
                           "recorded": dt.date.today().isoformat()})
    _save(tenant, st)
    return [f"{v}:{p['what'][:40]}"]


def compose(tenant: str) -> dict | None:
    import disposition
    import llm
    st = _load(tenant)
    if any(a.get("asked_at", "")[:10] == dt.date.today().isoformat() for a in st["asked"]):
        return None                                   # one a day, ever
    if pending(tenant):
        return None                                   # never two open questions
    done_keys = {a["key"] for a in st["asked"]}
    for c in commitments(tenant):
        if c["key"] in done_keys or not (c["what"] or "").strip():
            continue
        got = llm.ask_json(llm.phrase_specs(), ASK_SYS,
                           f"THE THING: {c['what']}\nWHEN IT WAS: {c['when']}", max_tokens=80) or {}
        text = disposition.sanitize(str(got.get("text") or "").strip())
        if not text or len(text) > 90 or disposition.violations(text, max_chars=90):
            continue
        return {"key": c["key"], "what": c["what"], "when": c["when"], "text": text}
    return None


def recent(tenant: str, days: int = 14) -> list[dict]:
    """What the record knows actually happened — the becoming strip reads this."""
    cutoff = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    return [o for o in _load(tenant).get("outcomes", []) if o.get("when", "") >= cutoff][-6:]


def run_tenant(tenant: str, send: bool = False) -> str:
    moved = sweep(tenant)
    pre = f"(verdicts: {', '.join(moved)}) " if moved else ""
    if not _allowed(tenant):
        return f"[skip] {pre}{tenant} — not on the proactive roster"
    import daily_text
    import tz_dynamic
    now = tz_dynamic.now_in(str(daily_text.tenant_db(tenant)))
    if not (EVENING[0] <= now.hour < EVENING[1]):
        return f"[hold] {pre}{tenant} — outside the check-back window"
    got = compose(tenant)
    if not got:
        return f"[idle] {pre}{tenant} — nothing to ask about"
    if not send:
        return f"[stage] {pre}{tenant} → {got['text']!r}"
    phone = daily_text.tenant_phone(tenant, daily_text._cfg(daily_text.tenant_db(tenant)))
    if phone and daily_text._sendblue(phone, got["text"]):
        daily_text.record_outbound(tenant, got["text"])
        st = _load(tenant)
        st["asked"].append({**got, "asked_at": dt.datetime.now().isoformat(timespec="seconds"),
                            "status": "waiting"})
        _save(tenant, st)
        return f"[SENT] {pre}{tenant} → {got['text']!r}"
    return f"[fail] {tenant} — send failed"


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    if "--sweep" in sys.argv:
        print(sweep(t) or "(no pending ask)")
    else:
        print(run_tenant(t, send="--send" in sys.argv))
