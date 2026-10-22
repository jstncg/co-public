#!/usr/bin/env python3
"""SITUATIONS — the episodes that generate everything at once (8/27).

An opening is one thing with one clock. An aim is a direction with no clock. A SITUATION is
neither: a bounded episode — a trip, a launch, someone visiting — that predictably produces a
dozen needs at different distances, and that the member has a personal history of doing badly in
a specific way.

    "I'm going to orlando" is not one opening. It is: check the weather two days out, hold the
    dinner now while a table exists, know that he books the return too tight, know the day after
    a red-eye is lost, notice that the thing he wanted to see is closed on Mondays.

Two halves, and the second is the whole product:

    THE TYPE'S NEEDS   what any trip requires. Generic, cheap, and available to anybody.
    THEIR PATTERN      how THIS member does this kind of episode — stays longer than planned,
                       never books dinner, loses the day after the red-eye. Mined from their own
                       past instances, quoted, never invented.

Nobody can sell the second half, which is why it is the part worth building. It is also what
makes co FORWARD-THINKING rather than reactive: a trip detected ten days out generates needs at
ten days, two days, and the morning of, and most of them can be served silently.

Every need still leaves through the openings gate — world × member × window × action, with a
pre-registered undo. A situation is a generator of candidates, never a licence to skip the door.

    python3 situations.py <tenant>            # what is coming, and what it implies
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DIR = os.path.expanduser("~/.co/situations")
HORIZON_DAYS = 21            # far enough to act, near enough to be real

# What each kind of episode reliably needs, and how far out each need becomes actionable. The
# LEAD is why this is forward-thinking: a dinner table has to be taken while one exists, and
# weather is noise until it is close.
NEEDS = {
    "travel": [
        ("dinner", 10, "hold a table for the night they arrive, while there is still one"),
        ("weather", 2, "what the weather actually does there, against what they packed"),
        ("ground", 3, "how they get from the airport at that hour"),
        ("closed", 5, "anything they wanted to see that is shut on those days"),
        ("recovery", 1, "the day after, if it is a red-eye"),
    ],
    "visit": [
        ("occasion", 5, "somewhere to take them that they would not find alone"),
        ("ground", 2, "how the visitor gets from the airport"),
    ],
    "launch": [
        ("quiet", 7, "hold the days before it so nothing else lands there"),
        ("after", 2, "the day after, which always goes"),
    ],
}

DETECT_SYS = """From THE MEMBER's mail and calendar, find upcoming SITUATIONS — bounded episodes
with a start and an end that will generate work.

THE SITUATION MUST BE THEIRS. Other people's itineraries land in their inbox constantly —
forwarded bookings, a friend's flight, a partner's reservation. The first live run claimed
"Friend: YYZ→DTW" as the member's own trip. If the mail is about somebody else travelling,
somebody else launching, or somebody else's booking, it is NOT a situation. When the subject
names another person as the traveller, skip it.

Kinds: travel (they are going somewhere), visit (someone is coming to them), launch (a dated
thing they are shipping or presenting).

Only real, dated, upcoming ones. A flight confirmation is a situation. A newsletter about travel
is not. If the dates are not clear, skip it.

Reply ONLY JSON: {"situations": [{"kind": "travel|visit|launch", "what": "one lowercase line",
"place": "city or empty", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD or empty",
"receipt": "the subject line or event title it came from", "confidence": 0.0}]}"""

PATTERN_SYS = """You are looking at how ONE person has historically handled a kind of episode.

Find their PATTERN: the specific way they reliably do this badly or differently. Not advice, not
a general truth about travel — a fact about them, from the record.

Good: "books the return flight the same evening the event ends, then moves it". "Never books
anywhere to eat and ends up at the hotel bar". "Stays two days longer than the original booking".
Bad: "should plan ahead more". "Travel can be stressful."

Only what the record shows. If it shows nothing about them specifically, say so — a pattern you
had to invent is worse than none.

Reply ONLY JSON: {"pattern": "one line, or empty", "receipt": "the words it came from, verbatim",
"confidence": 0.0}"""


def _path(tenant: str) -> str:
    os.makedirs(DIR, exist_ok=True)
    return os.path.join(DIR, f"{tenant}.json")


def load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {"situations": [], "patterns": {}}


def save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False, indent=1)


def _sid(kind: str, start: str, place: str) -> str:
    return hashlib.sha256(f"{kind}|{start}|{place}".lower().encode()).hexdigest()[:12]


def _cal_lines(tenant: str) -> list[str]:
    try:
        d = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
    except Exception:
        return []
    return [f"calendar: {e.get('start','')[:16]} {e.get('title','')[:70]}"
            for e in (d.get("events") or [])]


def detect(tenant: str) -> int:
    """Upcoming episodes from mail and calendar. Cheap aimed queries, metadata only."""
    import gmail_guard
    import llm
    lines = _cal_lines(tenant)
    for q in ("newer_than:30d (flight OR itinerary OR \"booking confirmation\" OR "
              "\"your trip\" OR boarding) -category:promotions",
              "newer_than:30d (reservation OR \"check-in\" OR hotel OR airbnb) "
              "-category:promotions"):
        for r in gmail_guard.search(q, limit=10, tenant=tenant):
            lines.append(f"mail: {r.get('subject','')[:90]} · {r.get('date','')[:16]} · "
                         f"{r.get('snippet','')[:140]}")
    if not lines:
        return 0
    try:
        import moment
        who = ", ".join(sorted(moment.member_names(tenant)))
    except Exception:
        who = tenant
    got = llm.ask_json(llm.json_specs(), DETECT_SYS,
                       f"TODAY: {dt.date.today().isoformat()}\nTHE MEMBER IS: {who}\n\n"
                       + "\n".join(lines[:50]), max_tokens=900) or {}
    st = load(tenant)
    have = {s["id"] for s in st["situations"]}
    today = dt.date.today().isoformat()
    horizon = (dt.date.today() + dt.timedelta(days=HORIZON_DAYS)).isoformat()
    added = 0
    for raw in (got.get("situations") or [])[:6]:
        kind = str(raw.get("kind") or "").strip()
        start = str(raw.get("start") or "").strip()[:10]
        if kind not in NEEDS or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start or ""):
            continue
        if not (today <= start <= horizon):
            continue                       # past, or too far to be real
        # One trip generates a flight mail AND a hotel mail AND a calendar block. Keying on
        # place too made those separate situations and every need fired twice.
        sid = _sid(kind, start, "")
        if sid in have:
            continue
        have.add(sid)
        st["situations"].append({
            "id": sid, "kind": kind, "what": str(raw.get("what") or "")[:120],
            "place": str(raw.get("place") or "")[:60], "start": start,
            "end": str(raw.get("end") or "")[:10],
            "receipt": str(raw.get("receipt") or "")[:140],
            "confidence": min(max(float(raw.get("confidence") or 0), 0.0), 1.0),
            "found": today})
        added += 1
    st["situations"] = [s for s in st["situations"] if s["start"] >= today][:12]
    save(tenant, st)
    return added


def learn_pattern(tenant: str, kind: str) -> str:
    """How THIS member does this kind of episode. The half nobody else can sell, and the reason
    it must be quoted: an invented pattern is a horoscope aimed at someone's actual trip."""
    import journal
    import llm
    st = load(tenant)
    if st.get("patterns", {}).get(kind, {}).get("pattern"):
        return st["patterns"][kind]["pattern"]
    # WHERE THE PATTERN ACTUALLY LIVES (8/27). The first run found four travel-shaped lines in
    # the co corpus, one of them "landing page", and correctly refused to claim a pattern. How
    # somebody travels is not something they narrate — it is in years of booking, change and
    # cancellation mail. Mine the record of what they DID, not the record of what they said.
    import gmail_guard
    mat = journal.member_material(tenant, limit=None)
    key = {"travel": r"\b(flight|trip|travel|airport|hotel|red.?eye|land(ing|ed)?|fly)\b",
           "visit": r"\b(visit|coming to|in town|staying with)\b",
           "launch": r"\b(launch|ship(ping)?|demo|present|deadline)\b"}.get(kind, kind)
    rx = re.compile(key, re.I)
    hits = [m for m in mat if rx.search(m)][-60:]        # filter first, window second
    # "checked" and a bare "hotel" pulled newsletters into the pattern corpus on the first run.
    # Travel mail is machine-generated and says so: receipts, itineraries, seats, check-ins.
    for q in {"travel": ("older_than:7d (\"flight receipt\" OR itinerary OR \"your flight\" OR "
                         "\"schedule change\" OR \"your trip\" OR \"upgraded seat\" OR "
                         "\"hotel confirmation\" OR \"reservation confirmed\") "
                         "-category:promotions",),
              "visit": ("older_than:7d (visiting OR \"in town\") -category:promotions",),
              "launch": ("older_than:7d (launch OR demo day OR \"going live\") -category:promotions",),
              }.get(kind, ()):
        for r in gmail_guard.search(q, limit=25, tenant=tenant):
            hits.append(f"[mail {r.get('date','')[:16]}] {r.get('subject','')[:90]} · "
                        f"{r.get('snippet','')[:130]}")
    if len(hits) < 6:
        return ""                                        # too little to claim a pattern
    got = llm.ask_json(llm.json_specs(), PATTERN_SYS,
                       f"KIND: {kind}\n\n" + "\n".join(hits)[-14000:], max_tokens=300) or {}
    pat = str(got.get("pattern") or "").strip()[:200]
    rec = str(got.get("receipt") or "").strip()[:200]
    corpus_all = " ".join("\n".join(hits).split()).lower()
    if pat and rec and " ".join(rec.split()).lower() in corpus_all:
        st.setdefault("patterns", {})[kind] = {
            "pattern": pat, "receipt": rec,
            "confidence": min(max(float(got.get("confidence") or 0), 0.0), 1.0),
            "learned": dt.date.today().isoformat()}
        save(tenant, st)
        return pat
    return ""                                            # unquotable: co invented it


def due_needs(tenant: str, today: dt.date | None = None) -> list[dict]:
    """Every need whose lead time has arrived, as opening-shaped candidates. The lead is what
    makes this forward-thinking: a table has to be taken while one exists."""
    today = today or dt.date.today()
    out = []
    for s in load(tenant).get("situations") or []:
        try:
            start = dt.date.fromisoformat(s["start"])
        except (ValueError, KeyError):
            continue
        days = (start - today).days
        if days < 0:
            continue
        pat = load(tenant).get("patterns", {}).get(s["kind"], {}).get("pattern", "")
        for need, lead, action in NEEDS.get(s["kind"], []):
            if days > lead:
                continue                                 # not yet: it would be noise
            out.append({
                "kind": f"situation:{need}",
                "world": f"{s['what']} — {s['place'] or 'no place given'}, {s['start']}",
                "member": s["receipt"] or "on their calendar",
                "window": f"{days} day(s) out; this need goes stale at {lead}",
                "action": action + (f" (they {pat})" if pat else ""),
                "undo": "nothing is committed until they tap; holds are refundable",
                "confidence": min(s.get("confidence", 0.5) + (0.15 if pat else 0), 1.0),
                "spends_expectations": False,
                "situation": s["id"], "pattern": pat,
            })
    return out


def as_detector(tenant: str) -> list[dict]:
    """Registered into openings.DETECTORS: a situation generates candidates, it never skips the
    gate. Every one still needs world × member × window × action and an undo."""
    return due_needs(tenant)


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    if "--detect" in sys.argv:
        print(f"+{detect(t)} situations")
        for k in NEEDS:
            p = learn_pattern(t, k)
            if p:
                print(f"  pattern[{k}]: {p}")
    st = load(t)
    if not st.get("situations"):
        print("(nothing upcoming — run with --detect)")
    for s in st["situations"]:
        print(f"\n  [{s['kind']:6s}] {s['what']}  ({s['place']}, {s['start']})")
        print(f"      from: {s['receipt'][:70]}")
    due = due_needs(t)
    if due:
        print("\n  needs due now:")
        for d in due:
            print(f"    · {d['action'][:88]}")
            print(f"      {d['window']}")
