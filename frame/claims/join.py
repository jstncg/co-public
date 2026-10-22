#!/usr/bin/env python3
"""The join — their world crossed with the world moving (8/25).

The product's actual cleverness lives here. Not knowing the member, not knowing the world:
knowing which piece of the world just became relevant to THEM. Every message this organ
produces has the same shape — an entity in their world moved, and there is a receipt from
their own material saying why it's theirs.

    "the guy you screenshotted in june just raised $4M"
    "the camera you keep comparing dropped $200 overnight"
    "you're seeing lance at 10:30 — he published friday, here's the part that matters"

Two lanes: ENTITY MOVEMENT (rotating sweep of their watched set) and PEOPLE TODAY (anyone on
today's calendar). Both feed the morning brief's lead position rather than sending on their
own — one text a day stays one text a day.

Laws: a join fires only on genuine, recent, material movement; the receipt is spoken
naturally and never as evidence ("you screenshotted him in june", never "you mentioned this
3 times"); the mechanism is never narrated (no "i've been watching him"); a delivered join
is burned forever.

    python3 join.py <tenant>            # stage both lanes
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BURN = os.path.expanduser("~/.co/join_sent.json")
PENDING = os.path.expanduser("~/.co/join_pending.json")
MAX_CHECKS = 6
MAX_JOINS = 2
MAX_PEOPLE = 2

MOVE_SYS = """You are co. An entity from one person's world, the receipt saying why it is theirs,
and fresh search results. Decide: did this entity ACTUALLY MOVE in a way that matters to them,
recently? Movement = raised, launched, shipped, published, priced differently, opened, closed,
sold, hired, moved, announced a date. NOT movement: background info, old news, generic coverage,
an article merely mentioning them.

Every result carries its publish date. TODAY is given below. Anything older than about six
weeks is NOT movement no matter how significant — reject it. Undated results are not evidence
of movement on their own.

If it moved, write ONE lowercase line in co's voice that says the news and weaves in why it is
theirs, naturally, the way a friend would. Never cite counts. Never say you were watching. Never
say "i noticed". Under 140 characters. Pick the single best source url.

Reply ONLY JSON: {"moved": true|false, "line": "...", "url": "..."}"""

PERSON_SYS = """You are co, prepping one person for a meeting later today. Given who they are
meeting and fresh search results about that person, write ONE lowercase line: the most useful
NEW thing about them worth walking in knowing (shipped, published, raised, moved, announced).
Nothing generic, nothing biographical, nothing they'd already know. Recency is NOT the bar here
— a raise or launch from months ago is worth walking in knowing. Say when it happened if the
date is clear. If there is nothing genuinely useful, say so honestly. Under 170 characters, no
em-dashes.

Reply ONLY JSON: {"useful": true|false, "line": "...", "url": "..."}"""


def _burned(tenant: str) -> set:
    try:
        return set(json.load(open(BURN)).get(tenant) or [])
    except Exception:
        return set()


def _burn(tenant: str, keys: list[str]) -> None:
    try:
        d = json.load(open(BURN))
    except Exception:
        d = {}
    d[tenant] = (d.get(tenant) or [])[-400:] + keys
    os.makedirs(os.path.dirname(BURN), exist_ok=True)
    json.dump(d, open(BURN, "w"))


FRESH_DAYS = 60          # movement: "did this move?" is a recency claim
CONTEXT_DAYS = 540       # a pre-brief: what's worth walking in knowing, fresh or not


def _context_search(query: str) -> list[dict]:
    """The pre-brief path: NO date filter. Exa's startPublishedDate silently drops undated
    pages, and person context lives exactly there — profiles, company pages, announcements
    without metadata. Filtering for freshness returned zero results for a man who raised $5M
    and killed a real pre-brief (8/25). Recency is not the bar here; usefulness is."""
    import research_engine
    return [{"title": r.get("title", ""), "url": r.get("url", ""), "date": "",
             "snippet": r.get("snippet", "")} for r in research_engine._search(query)[:6]]


def _fresh_search(query: str, days: int = FRESH_DAYS) -> list[dict]:
    """Two standards, deliberately (8/25): MOVEMENT is inherently recent, so the entity lane
    enforces a tight window at the search — without it the judge called a three-month-old
    story 'just happened', live, on the first run. A PRE-BRIEF is different: the useful thing
    about someone you're meeting at 10 doesn't expire, it just has to be something they don't
    already know. Collapsing the two silently killed a real pre-brief."""
    import requests
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    try:
        r = requests.post("https://api.exa.ai/search",
                          headers={"x-api-key": os.environ.get("EXA_API_KEY", ""),
                                   "Content-Type": "application/json"},
                          json={"query": query, "numResults": 6, "type": "auto",
                                "startPublishedDate": since,
                                "contents": {"highlights": {"numSentences": 2}}}, timeout=25)
        r.raise_for_status()
        out = []
        for h in (r.json().get("results") or [])[:6]:
            when = (h.get("publishedDate") or "")[:10]
            if when and when < since:
                continue                                  # belt and braces: the API is advisory
            out.append({"title": (h.get("title") or "")[:160], "url": (h.get("url") or "")[:500],
                        "date": when, "snippet": " ".join(h.get("highlights") or [])[:220]})
        return out
    except Exception:
        return []


def entity_moves(tenant: str) -> list[dict]:
    """The rotating sweep. Most days this returns nothing, and that is the product working."""
    import disposition
    import entities
    import llm
    import wrapped
    burned = _burned(tenant)
    out = []
    for ent in entities.due(tenant, MAX_CHECKS):
        if len(out) >= MAX_JOINS:
            continue
        results = _fresh_search(f"{ent['name']} news announcement launch funding {dt.date.today().year}")
        if not results:
            entities.mark_checked(tenant, ent["name"])
            continue
        blob = "\n".join(f"- [{r.get('date') or 'undated'}] {r['title']} ({r['url']}): "
                         f"{r.get('snippet', '')[:180]}" for r in results)
        got = llm.ask_json(llm.json_specs(), MOVE_SYS,
                           f"TODAY: {dt.date.today().isoformat()}\nENTITY: {ent['name']} ({ent['kind']})\n"
                           f"WHY IT'S THEIRS: {ent['why']}\n\nRESULTS:\n{blob}",
                           max_tokens=250) or {}
        url = str(got.get("url") or "").strip()
        line = disposition.sanitize(str(got.get("line") or "").strip())
        key = f"ent:{ent['name'].lower()}:{url[:60]}"
        entities.mark_checked(tenant, ent["name"], moved=bool(got.get("moved")))
        if not (got.get("moved") and url and line) or key in burned:
            continue
        if disposition.violations(line, max_chars=200) or not wrapped._url_alive(url):
            continue
        out.append({"key": key, "text": f"{line}\n{url}"})
    return out


def people_today(tenant: str) -> list[dict]:
    """Anyone on today's calendar: what changed about them since the member last looked."""
    import disposition
    import llm
    import wrapped
    try:
        cal = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
    except Exception:
        return []
    today = dt.date.today().isoformat()
    titles = [ev["title"] for ev in cal.get("events", []) if (ev.get("start") or "")[:10] == today]
    if not titles:
        return []
    got = llm.ask_json(llm.json_specs(),
                       'Extract the OTHER people\'s names from these calendar event titles (never '
                       'the member themselves, never generic words like "sync" or "hold"). Reply '
                       'ONLY JSON: {"names": ["..."]}',
                       "\n".join(titles[:8]), max_tokens=150) or {}
    burned = _burned(tenant)
    out = []
    for name in [str(n).strip() for n in (got.get("names") or [])][:4]:
        if len(out) >= MAX_PEOPLE or len(name) < 3:
            continue
        key = f"person:{name.lower()}:{today}"
        if key in burned:
            continue
        results = _context_search(f"{name} announcement published launched raised funding")
        if not results:
            continue
        blob = "\n".join(f"- [{r.get('date') or 'undated'}] {r['title']} ({r['url']}): "
                         f"{r.get('snippet', '')[:180]}" for r in results)
        j = llm.ask_json(llm.json_specs(), PERSON_SYS,
                         f"TODAY: {dt.date.today().isoformat()}\nMEETING: {name}\n\nRESULTS:\n{blob}",
                         max_tokens=220) or {}
        url = str(j.get("url") or "").strip()
        line = disposition.sanitize(str(j.get("line") or "").strip())
        if not (j.get("useful") and line):
            continue
        if disposition.violations(line, max_chars=220):
            continue
        if line and line[0].isupper():
            line = line[0].lower() + line[1:]     # co's register holds even mid-lane
        when = next((ev["start"][11:16] for ev in cal.get("events", [])
                     if name.lower() in (ev.get("title") or "").lower()), "")
        head = f"{name.lower()} at {when}: " if when else f"{name.lower()}: "
        body = head + line
        if url and wrapped._url_alive(url):
            body += f"\n{url}"
        out.append({"key": key, "text": body})
    return out


def fresh(tenant: str) -> list[str]:
    """Everything the join has for the brief, best first. Held as PENDING, never burned here:
    a composed join that was never sent must not be eaten (staging one in a terminal already
    cost a real pre-brief). The caller commits after the send lands."""
    # The moment lane owns pre-briefs when it is on for this tenant: it sends the same read 90
    # minutes before the meeting, where it is actually worth something. Leaving this lane running
    # too would say it twice, once uselessly. The brief keeps what has no moment to attach to.
    try:
        import moment
        people = [] if moment.rostered(tenant) else people_today(tenant)
    except Exception:
        people = people_today(tenant)
    picked = people + entity_moves(tenant)
    if not picked:
        return []
    try:
        d = json.load(open(PENDING))
    except Exception:
        d = {}
    d[tenant] = [p["key"] for p in picked]
    os.makedirs(os.path.dirname(PENDING), exist_ok=True)
    json.dump(d, open(PENDING, "w"))
    return [p["text"] for p in picked]


def commit(tenant: str) -> int:
    """The brief went out: what was pending is now spent, and never repeats."""
    try:
        d = json.load(open(PENDING))
    except Exception:
        return 0
    keys = d.pop(tenant, []) or []
    if keys:
        _burn(tenant, keys)
        json.dump(d, open(PENDING, "w"))
    return len(keys)


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    got = fresh(t)
    print("\n\n".join(got) if got else "(no joins today — the world held still)")
