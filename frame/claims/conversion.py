#!/usr/bin/env python3
"""Conversion — turning intake into growth (8/25).

The founder, on his own sending: "idk why i send things. i don't even read the responses."
And his own reading, on the mechanism: "you keep consuming at enormous volume but then
immediately ask how to actually live what you just saw. the intake and the application stay
separate." Put those together and the honest read is that a high-volume send is usually
DISCHARGE (something hit you, sending released the urge to act on it) or DEFERRAL (a promise
to a future self who never gets the message). Capture, at volume, becomes the anesthetic for
the growth it was supposed to serve.

So this organ does not capture anything. It CONVERTS, using the four moves that actually
turn intake into learning:

  RETRIEVAL     you learn what you retrieve, never what you read
  CONNECTION    this is the third framing of one idea since june — here is what they share
  APPLICATION   the one usable piece, sized to this week, aimed at the live gap
  DISTILLATION  what you now believe about X, in your own words, with receipts

STRATEGIC CONSTRAINT, non-negotiable: conversion gets ZERO new message budget. The retrieval
question rides the evening slot the check-back already owns (a commitment to close always
outranks a thing to recall), and connection and distillation live on the wall. A growth lane
that adds notifications would be self-defeating.

    python3 conversion.py <tenant>            # stage everything
    python3 conversion.py <tenant> --question # just the evening question
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STORE = os.path.expanduser("~/.co/conversion")
RECALL_MIN_DAYS = 12          # younger than this and recall is not a memory test
RECALL_MAX_DAYS = 45          # older and it is archaeology, not learning
MIN_SPAN_DAYS = 14            # a connection must cross real time to be a pattern

RECALL_SYS = """You are co, asking one person to retrieve something they saved a few weeks ago.
Retrieval is the learning event, so the question must make them produce the substance from
memory, not recognize it. Reference the thing concretely enough to locate it and no further.

Some items are marked SENT — a photo or screenshot they deposited, described by co, with no
words of their own attached. Co knows they SENT it. Co does NOT know they read, finished, or
believe anything about it, and must never imply otherwise. Ask about the act, not the contents:
"you sent me that book in july, ever read it?" is right. "what was its core claim?" is a
question about a thing they may never have opened, and co asked exactly that one eight times
about a bookstore screenshot before this rule existed.

Under 14 words, lowercase, no preamble, never "just wondering", never a compliment. Examples of
the register: "the vishria interview from three weeks ago, what stuck?" / "that piece on agent
memory, what did you actually take from it?" / "you sent me that chater book in july, read it?"

Reply ONLY JSON: {"text": "..."}"""

CONNECT_SYS = """You have things one person saved, with dates. Find ONE genuine through-line: the
same underlying idea they have now circled three or more times across at least two weeks, in
different clothes.

Then say what the repetitions SHARE that they may not have named — the actual claim underneath.
Not a summary of each. Not "you're interested in X". The move is: name the recurring idea, then
say the thing it implies that they have not said themselves.

Two lowercase sentences, no em-dashes, no lists. If there is no real through-line, say so.
Reply ONLY JSON: {"found": true|false, "line": "...", "items": ["<short label>", "..."]}"""

DISTILL_SYS = """From these things one person saved on a single subject, write WHAT THEY NOW
BELIEVE about it — their emergent position, in their register, as if they wrote it themselves.
Present tense, first person, three or four sentences. It must be a POSITION with an edge, not a
neutral summary: the thing they would say out loud if asked at dinner.

Only claims their own material supports. No hedging, no "it seems", no em-dashes.
Reply ONLY JSON: {"subject": "...", "belief": "..."}"""

APPLY_SYS = """You are co. One thing this person saved, and the gap they are trying to close in
who they are becoming. Propose the ONE small use of that saved thing that would move the gap
this week: a physical, single-sitting, reversible action. Never "reflect on", never "think
about", never a plan. If the saved thing cannot honestly serve the gap, say so.

One lowercase sentence, question-shaped, under 130 characters, no em-dashes.
Reply ONLY JSON: {"usable": true|false, "text": "..."}"""


def _path(tenant: str) -> str:
    os.makedirs(STORE, exist_ok=True)
    return os.path.join(STORE, f"{tenant}.json")


def _load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {"used": [], "asked": []}


def _save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False)


def _deposits(tenant: str, lo: int, hi: int) -> list[dict]:
    """Their own saves in a date band, substantial enough to have contained an idea.

    THROUGH THE ONE DOOR (8/28). This read the raw record, so co's own vision descriptions
    counted as the member's material. He screenshotted a bookstore page; co described the image
    ("...the book The Mind is Flat by Nick Chater..."); this lane then read co's description as
    something he had READ, and spent days asking him to recall the book's core claim eight
    different ways. He had never heard of it.

    journal.scrub_annotations strips co's narration and keeps the deposit, which is the same law
    member_material has enforced since 8/25 — this organ simply was never migrated to it."""
    import journal
    today = dt.date.today()
    out = []
    for e2 in (journal._load(tenant).get("entries") or []):
        text = journal.scrub_annotations(e2.get("text") or "")
        if not text or text.startswith("(from our") or not journal.is_member_authored(text):
            continue
        try:
            when = dt.date.fromisoformat((e2.get("date") or "")[:10])
        except ValueError:
            continue
        age = (today - when).days
        if lo <= age <= hi and len(re.sub(r"https?://\S+", "", text)) > 40:
            out.append({"when": when.isoformat(), "age": age, "text": text[:400]})
    # ARTIFACTS THEY SENT, in the same window, labelled so the composer cannot mistake an act for
    # a belief. Scrubbing rightly removed co's caption from their words — but an entry that was
    # ONLY a photo then had nothing left, so co lost every trace that he sent a book in July.
    # Both facts are true and belong in different tiers.
    for d in journal.deposits(tenant):
        try:
            when = dt.date.fromisoformat(d["date"])
        except ValueError:
            continue
        age = (today - when).days
        if lo <= age <= hi:
            out.append({"when": d["date"], "age": age,
                        "text": f"SENT ({d['kind']}, co's description, not their words): "
                                f"{d['observed'][:220]}"})
    return out


# ---------------------------------------------------------------- the four moves

def retrieval(tenant: str) -> dict | None:
    """The evening question, when there is no commitment to close. Their answer is worth more
    than the link ever was — it is the only corpus co holds that they had to produce."""
    import disposition
    import llm
    st = _load(tenant)
    used = {u["key"] for u in st["used"]}
    for d in sorted(_deposits(tenant, RECALL_MIN_DAYS, RECALL_MAX_DAYS), key=lambda x: -x["age"]):
        key = f"recall:{d['when']}:{d['text'][:40]}"
        if key in used:
            continue
        got = llm.ask_json(llm.phrase_specs(), RECALL_SYS,
                           f"SAVED {d['age']} DAYS AGO:\n{d['text'][:300]}", max_tokens=90) or {}
        text = disposition.sanitize(str(got.get("text") or "").strip())
        if text and len(text) <= 110 and not disposition.violations(text, max_chars=110):
            return {"kind": "retrieval", "key": key, "text": text}
    return None


def connection(tenant: str) -> dict | None:
    """The move no other product can make: synthesis across THEIR OWN archive over time."""
    import disposition
    import llm
    st = _load(tenant)
    used = {u["key"] for u in st["used"]}
    items = _deposits(tenant, 0, 90)
    if len(items) < 8:
        return None
    span = (dt.date.fromisoformat(items[0]["when"]) - dt.date.fromisoformat(items[-1]["when"])).days
    if abs(span) < MIN_SPAN_DAYS:
        return None
    blob = "\n".join(f"[{i['when']}] {i['text'][:200]}" for i in items[-60:])
    got = llm.ask_json(llm.phrase_specs(), CONNECT_SYS, blob[-16000:], max_tokens=350) or {}
    line = disposition.sanitize(str(got.get("line") or "").strip())
    key = f"connect:{line[:50].lower()}"
    if not got.get("found") or not line or key in used:
        return None
    if disposition.violations(line, max_chars=320):
        return None
    return {"kind": "connection", "key": key, "text": line,
            "items": [str(x)[:60] for x in (got.get("items") or [])[:4]]}


def distillation(tenant: str) -> dict | None:
    """What they now believe, written as they would say it. Growth made visible, and the one
    conversion output they would actually want to publish."""
    import disposition
    import llm
    import wrapped
    st = _load(tenant)
    used = {u["key"] for u in st["used"]}
    try:
        tiles = wrapped._tiles(tenant)
        d = wrapped._compute(tenant)
        rooms = wrapped._rooms(tenant, tiles, d.get("orbit") or [])
    except Exception:
        return None
    for r in rooms[:3]:
        if len(r.get("items") or []) < 5:
            continue
        key = f"distill:{r['theme'].lower()}"
        if key in used:
            continue
        blob = "\n".join(f"- {wrapped._unesc(tiles[i]['note'] or '')[:200]}" for i in r["items"][:12])
        got = llm.ask_json(llm.phrase_specs(), DISTILL_SYS,
                           f"SUBJECT: {r['theme']}\n\nWHAT THEY SAVED:\n{blob}", max_tokens=450) or {}
        belief = disposition.sanitize(str(got.get("belief") or "").strip())
        if belief and not disposition.violations(belief, max_chars=700):
            return {"kind": "distillation", "key": key, "subject": r["theme"], "text": belief}
    return None


def application(tenant: str) -> dict | None:
    """A saved thing, aimed at the live gap. This is where intake becomes a Thursday."""
    import becoming
    import disposition
    import llm
    g = becoming.gap(tenant)
    if not g:
        return None
    st = _load(tenant)
    used = {u["key"] for u in st["used"]}
    for d in sorted(_deposits(tenant, 1, 30), key=lambda x: x["age"])[:8]:
        key = f"apply:{d['when']}:{d['text'][:40]}"
        if key in used:
            continue
        got = llm.ask_json(llm.phrase_specs(), APPLY_SYS,
                           f"THEY SAVED:\n{d['text'][:300]}\n\nTHE GAP THEY'RE CLOSING:\n"
                           f"{g['trait']} (they're at {g['actual']}, aiming {g['target']})",
                           max_tokens=150) or {}
        text = disposition.sanitize(str(got.get("text") or "").strip())
        if got.get("usable") and text and not disposition.violations(text, max_chars=170):
            return {"kind": "application", "key": key, "text": text}
    return None


# ---------------------------------------------------------------- what other lanes consume

def question(tenant: str) -> dict | None:
    """The evening slot, ONLY when outcomes has no commitment to close. Application first
    (it moves the gap), retrieval second (it deepens what they already took in)."""
    return application(tenant) or retrieval(tenant)


def card(tenant: str) -> dict | None:
    """The wall: a connection if the archive has one, else a distillation."""
    return connection(tenant) or distillation(tenant)


def diet(tenant: str) -> str | None:
    """What their intake is made of, in plain speech. The bubble-pop aimed at consumption."""
    import becoming
    m = becoming.metrics(tenant)
    if not m.get("primary_ratio") and m.get("primary_ratio") != 0:
        return None
    pr = m.get("primary_ratio", 0)
    br = m.get("breadth", 0)
    bits = []
    bits.append(f"{int(round(pr * 100))} percent of what you send is primary source, the rest is "
                "someone else's read of it")
    if br is not None:
        bits.append(f"{int(round(br * 100))} percent falls outside your three loudest themes")
    return " · ".join(bits)


def mark_used(tenant: str, key: str) -> None:
    st = _load(tenant)
    st["used"] = (st["used"] or [])[-200:] + [{"key": key, "when": dt.date.today().isoformat()}]
    _save(tenant, st)


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    if "--question" in sys.argv:
        print(json.dumps(question(t), indent=1))
        raise SystemExit
    for name, fn in (("QUESTION", question), ("CARD", card)):
        got = fn(t)
        print(f"\n{name}: {got.get('kind') if got else '(none)'}")
        if got:
            print(" ", got["text"][:400])
    print("\nDIET\n ", diet(t) or "(not enough)")
