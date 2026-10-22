#!/usr/bin/env python3
"""THE SIT-DOWN — co books time with you and calls (8/27).

Founder: "even just setting time on my calendar and calling me during that time to see why i'm
going to Orlando would be sick."

It is the first thing in the product that behaves like an institution rather than a tool. A tool
waits to be opened. A person who works for you takes fifteen minutes on your calendar and rings
you, because there is something they need to know and a message would take four rounds to get it.

    WHY THIS IS NOT THE PROBING I ARGUED AGAINST. Earlier today the ruling was that co must not
    interrogate — "I don't want to be showing my hand", and anything the member volunteers
    deliberately cannot surprise them later. That still holds for SCHEDULED questions. This is
    different in the way that matters: the gap is live, bounded, and LOAD-BEARING. Co genuinely
    does not know why he is flying to Orlando, and the answer changes four things it would
    otherwise get wrong — whether to hold a dinner, whether to guard the day after, whether to
    protect the gym block, whether the trip is work at all.

    So the law is: ASK WHEN THE ANSWER CHANGES WHAT CO DOES NEXT, AND NEVER OTHERWISE. Not on a
    schedule, not to fill a profile, not to reduce uncertainty in the abstract.

The booking is the act; the call is the conversation. The hold is its own undo — deleting the
block is how you decline, and nothing rings if the block is gone.

    python3 sitdown.py <tenant>            # what co would sit down about
    python3 sitdown.py <tenant> --book     # take the slot
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STATE = os.path.expanduser("~/.co/sitdown.json")
MINUTES = 15                 # long enough to answer, short enough to accept
MAX_PENDING = 1              # two booked sit-downs is a standing meeting, which is a different thing
EARLIEST_H, LATEST_H = 9, 20

GAP_SYS = """A situation is coming up in the member's life. Decide whether co is missing something
LOAD-BEARING about it — a fact that would change what co should do, not merely something it would
be interesting to know.

Load-bearing examples: is this work or personal (changes whether to guard the surrounding days),
who they are seeing (changes whether to prep anything), whether they are coming straight back
(changes whether to protect the day after).
NOT load-bearing: how they feel about it, what they hope to get out of it, anything co could look
up, anything that only fills a profile.

If the gap is real, write the ONE question worth fifteen minutes, and the concrete things co would
do differently once it knows. If co already has enough to act, say so — a call with nothing behind
it is worse than silence.

Reply ONLY JSON: {"gap": true|false, "question": "one line, in co's voice, lowercase",
"changes": ["what co would do differently", "..."], "confidence": 0.0}"""


def _load() -> dict:
    try:
        return json.load(open(STATE))
    except Exception:
        return {"pending": {}}


def _save(d: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(d, open(STATE, "w"), ensure_ascii=False, indent=1)


def rostered(tenant: str) -> bool:
    """Booking on someone's calendar and then phoning them is the loudest thing co does. Opt-in
    per tenant, and off for everybody by default."""
    import roster
    return roster._rostered(tenant, "CO_SITDOWN_TENANTS")


def gap(tenant: str, sit: dict) -> dict | None:
    """What co does not know about this episode that would change its acts."""
    import llm
    try:
        import aims
        standing = "; ".join(a["aim"] for a in aims.live(tenant))
    except Exception:
        standing = ""
    got = llm.ask_json(llm.json_specs(), GAP_SYS,
                       f"TODAY: {dt.date.today().isoformat()}\n"
                       f"SITUATION: {sit.get('kind')} — {sit.get('what')} "
                       f"({sit.get('place') or 'no place'}, {sit.get('start')})\n"
                       f"KNOWN FROM: {sit.get('receipt','')[:120]}\n"
                       f"THEIR STANDING AIMS: {standing or 'none known'}\n",
                       max_tokens=400) or {}
    if not got.get("gap") or not str(got.get("question") or "").strip():
        return None
    changes = [str(c)[:100] for c in (got.get("changes") or []) if str(c).strip()][:4]
    if not changes:
        return None                       # a question that changes nothing is not load-bearing
    return {"question": str(got["question"]).strip()[:200], "changes": changes,
            "confidence": min(max(float(got.get("confidence") or 0), 0.0), 1.0)}


def _free_slot(before: str) -> dt.datetime | None:
    """A gap in today's calendar, ahead of the situation and inside waking hours. Co takes time
    it can see is free rather than stacking on something."""
    try:
        cal = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
    except Exception:
        return None
    busy = []
    for e in cal.get("events") or []:
        s = (e.get("start") or "")[:16]
        try:
            busy.append(dt.datetime.fromisoformat(s))
        except ValueError:
            continue
    now = dt.datetime.now()
    t = now.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=1)
    limit = min(dt.datetime.fromisoformat(before + "T00:00") if before else now + dt.timedelta(days=2),
                now + dt.timedelta(days=2))
    while t < limit:
        if EARLIEST_H <= t.hour < LATEST_H and not any(
                abs((t - b).total_seconds()) < 3600 for b in busy):
            return t
        t += dt.timedelta(minutes=30)
    return None


def propose(tenant: str) -> dict | None:
    """The one situation worth fifteen minutes. One at a time, always."""
    import situations
    st = _load()
    if len([p for p in (st.get("pending") or {}).values() if p.get("open")]) >= MAX_PENDING:
        return None
    for sit in situations.load(tenant).get("situations") or []:
        if sit["id"] in (st.get("pending") or {}):
            continue
        g = gap(tenant, sit)
        if g and g["confidence"] >= 0.5:
            slot = _free_slot(sit.get("start", ""))
            if not slot:
                continue                  # nowhere free before it: the call would be theatre
            return {"situation": sit, "gap": g, "slot": slot}
    return None


def book(tenant: str, p: dict) -> dict:
    """Take the slot. The block IS the undo — delete it and nothing rings."""
    import gcal
    sit, g, slot = p["situation"], p["gap"], p["slot"]
    title = f"co — 15 min about {sit.get('place') or sit.get('what','the trip')}"
    got = gcal.hold(title, slot.isoformat(timespec="minutes"), MINUTES,
                    instructions=f"{g['question']}\n\n[co] delete this block to decline; "
                                 f"nothing will ring.", tenant=tenant)
    if not got.get("ok"):
        return got
    st = _load()
    st.setdefault("pending", {})[sit["id"]] = {
        "open": True, "at": slot.isoformat(timespec="minutes"),
        "question": g["question"], "changes": g["changes"],
        "receipt": got.get("receipt", ""), "booked": dt.date.today().isoformat()}
    _save(st)
    return {"ok": True, "at": slot.isoformat(timespec="minutes"), "receipt": got.get("receipt")}


def ring(tenant: str, sid: str) -> dict:
    """Dial, opening with the reason. A placed call that starts with a naked 'hey' is a robocall;
    this one says why it is ringing before it asks anything."""
    import call_out
    st = _load()
    p = (st.get("pending") or {}).get(sid)
    if not p or not p.get("open"):
        return {"ok": False, "why": "no open sit-down"}
    phone = os.environ.get("CO_FOUNDER_HANDLE", "")
    if not phone:
        return {"ok": False, "why": "no handle"}
    first = f"hey, it's co. {p['question']}"
    got = call_out.place(phone, first=first[:280])
    if got.get("ok"):
        p["open"] = False
        p["rang"] = dt.datetime.now().isoformat(timespec="seconds")
        _save(st)
    return got


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    p = propose(t)
    if not p:
        print("(nothing worth fifteen minutes — co has enough to act, which is the common answer)")
        raise SystemExit
    print(f"  about:    {p['situation']['what']} ({p['situation'].get('place')}, "
          f"{p['situation']['start']})")
    print(f"  question: {p['gap']['question']}")
    print("  changes:")
    for c in p["gap"]["changes"]:
        print(f"    · {c}")
    print(f"  slot:     {p['slot'].isoformat(timespec='minutes')}")
    if "--book" in sys.argv:
        print("  ->", json.dumps(book(t, p))[:200])
