#!/usr/bin/env python3
"""Commissioned research — "look into X, tell me in 3 days."

The kyo pattern (kyo/research.py), reimplemented on frame's rails. The missing middle
verb: episodes deliver NOW, watches fire WHENEVER the world moves — a commission is a
deliverable with a promised DAY. Two design laws taken from kyo because they're right:

  1. SEARCH AT COMMISSION, not at delivery. The findings are gathered and stored the
     moment they ask; delivery day composes from stored state. The promise survives a
     vendor outage on delivery day (Exa 402'd the day the episode loop shipped — this
     law is not hypothetical), and delivery is cheap and deterministic.
  2. Deliver through the NORMAL rails, no new sender. The promise rides the requested-
     anchor rail — the same kept-promise class as "remind me tomorrow", budget-exempt,
     quiet-hours-sovereign. The tick's anchor rung sees a research anchor and composes
     from the stored findings instead of phrasing a reminder.

Bounded findings (kyo's injection caps, same numbers): search results feed a model
prompt on delivery day, so everything stored is clipped at write time.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

STATE_DIR = os.path.expanduser("~/.co/research")
MAX_FINDINGS = 6
SNIPPET_CAP = 300
TITLE_CAP = 160

PARSE_SYS = """Someone asked their co to look into something and report back later. Extract the
commission. TODAY IS {today} ({tz}). Return ONLY JSON:
{{"topic": "<what to research, their words, specific>",
 "due": "<ISO datetime local, when they want the report. 'in 3 days' = that day 10:00. 'this
weekend' = Saturday 10:00. 'tomorrow' = tomorrow 10:00. No timeframe given = 2 days out, 10:00.>",
 "angle": "<what they actually want out of it — the decision or curiosity behind the ask, or null>"}}"""

DELIVER_SYS = """Days ago they asked you to look into something, and you promised today's report.
The findings below were gathered when they asked. Write the report as ONE text message in a sharp
friend's voice: what you found, the concrete takeaway (numbers/names, not vibes), at most 2 source
mentions woven in naturally, and if the findings are thin say so plainly. No headers, no bullets,
no "as promised". Under 900 characters. Return ONLY JSON: {"report": "<the message>"}"""


def _dir(tenant: str) -> str:
    d = os.path.join(STATE_DIR, tenant)
    os.makedirs(d, exist_ok=True)
    return d


def _search(topic: str) -> list:
    """Exa first (cheap, rich), the web_search model as fallback — same ladder the episode
    receipt uses. Returns bounded finding dicts, possibly empty (an honest empty beats a crash)."""
    findings = []
    try:
        import requests
        r = requests.post("https://api.exa.ai/search",
                          headers={"x-api-key": os.environ.get("EXA_API_KEY", ""),
                                   "Content-Type": "application/json"},
                          json={"query": topic, "numResults": MAX_FINDINGS, "type": "auto",
                                "contents": {"highlights": {"numSentences": 3}}}, timeout=25)
        r.raise_for_status()
        for h in (r.json().get("results") or [])[:MAX_FINDINGS]:
            findings.append({"title": (h.get("title") or "")[:TITLE_CAP], "url": (h.get("url") or "")[:500],
                             "snippet": " ".join(h.get("highlights") or [])[:SNIPPET_CAP]})
    except Exception:
        pass
    if findings:
        return findings
    try:                                   # Exa down → one web_search call gathers what it can
        import episode_engine as ee
        got = asyncio.run(ee._ask(
            "Research the topic. Return ONLY JSON: {\"findings\": [{\"title\": \"...\", "
            "\"url\": \"...\", \"snippet\": \"<what it says, 2-3 sentences>\"}]} — at most 6, "
            "real sources only.",
            f"TOPIC: {topic}", ee.MODEL, max_tokens=1200,
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 4}])) or {}
        for h in (got.get("findings") or [])[:MAX_FINDINGS]:
            findings.append({"title": str(h.get("title") or "")[:TITLE_CAP],
                             "url": str(h.get("url") or "")[:500],
                             "snippet": str(h.get("snippet") or "")[:SNIPPET_CAP]})
    except Exception:
        pass
    return findings


READ_SOURCES = 2          # how many of the top hits get OPENED, not just skimmed
BODY_CAP = 4000


def _deepen(tenant: str, rid: str) -> None:
    """Open the top hits and store what's actually ON them. A snippet is a search result's opinion of
    a page; the report they were promised is worth the page. Runs on a daemon thread AFTER commission
    has returned — the confirm text ("looking into it, back Thursday") must never wait on two page
    fetches, and delivery is days out, so there is all the time in the world."""
    path = os.path.join(_dir(tenant), f"{rid}.json")
    try:
        import link_read
        with open(path) as f:
            rec = json.load(f)
        for finding in (rec.get("findings") or [])[:READ_SOURCES]:
            body = link_read.read_raw(finding.get("url") or "", max_chars=BODY_CAP)
            if body:
                finding["body"] = body
        with open(path, "w") as f:
            json.dump(rec, f, ensure_ascii=False, indent=1)
    except Exception:
        pass                                   # the snippets alone still deliver a report


def commission(tenant: str, ask: str) -> dict | None:
    """Parse the ask, search NOW, store findings, promise delivery on the anchor rail.
    Returns {"topic", "due", "thin"} or None."""
    try:
        import episode_engine as ee
        import tz_dynamic
        db = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
        now = tz_dynamic.now_in(db)
        got = asyncio.run(ee._ask(
            PARSE_SYS.format(today=now.strftime("%A %Y-%m-%d %H:%M"), tz=str(now.tzinfo)),
            f"THE ASK:\n{ask[:500]}", ee.JUDGE_MODEL, max_tokens=200)) or {}
        topic = (got.get("topic") or "").strip()
        due = (got.get("due") or "").strip()
        if not topic or not due:
            return None
        findings = _search(topic)
        rid = f"rs{int(time.time() * 1000)}"
        with open(os.path.join(_dir(tenant), f"{rid}.json"), "w") as f:
            json.dump({"id": rid, "topic": topic, "angle": got.get("angle"),
                       "asked": ask[:500], "findings": findings,
                       "commissioned": now.isoformat(timespec="seconds"), "due": due}, f,
                      ensure_ascii=False, indent=1)
        import anchors
        st = anchors._load(db)
        st.setdefault("anchors", []).append({
            "what": f"research report: {topic[:80]}", "kind": "deadline",
            "when": due, "fire": due,
            "quote": ask[:160], "requested": True,       # a kept promise, budget-exempt
            "research_id": rid,                          # the tick composes from stored findings
            "created": now.isoformat(timespec="seconds"), "fired": False})
        anchors._save(db, st)
        if findings:
            import threading
            threading.Thread(target=_deepen, args=(tenant, rid), daemon=True).start()
        return {"topic": topic, "due": due, "thin": len(findings) == 0}
    except Exception:
        return None


def deliver(tenant: str, research_id: str) -> str | None:
    """Delivery day: compose the report from what was stored at commission. One model call,
    no re-search — the promise doesn't depend on any vendor being up today."""
    try:
        with open(os.path.join(_dir(tenant), f"{research_id}.json")) as f:
            rec = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    try:
        import episode_engine as ee
        body = "\n".join(
            f"- {f_['title']} ({f_['url']}): {f_['snippet']}"
            + (f"\n  FROM THE PAGE ITSELF:\n  {f_['body']}" if f_.get("body") else "")
            for f_ in rec.get("findings") or [])
        got = asyncio.run(ee._ask(
            DELIVER_SYS,
            (f"THE ASK ({rec.get('commissioned', '')[:10]}): {rec['asked']}\n"
             f"THE ANGLE: {rec.get('angle') or '(none stated)'}\n\n"
             f"FINDINGS (gathered at commission):\n{body or '(nothing found — say so honestly)'}"),
            ee.MODEL, max_tokens=600)) or {}
        r = (got.get("report") or "").strip()
        return r[:1100] if r else None
    except Exception:
        return None


if __name__ == "__main__":
    t = "dennis"
    args = sys.argv[1:]
    if args and args[0] == "--deliver":
        print(deliver(t, args[1]) or "(no report)")
    elif args:
        print(json.dumps(commission(t, " ".join(args)), indent=1))
    else:
        for fn in sorted(os.listdir(_dir(t))):
            rec = json.load(open(os.path.join(_dir(t), fn)))
            print(f"- {rec['id']} [{len(rec.get('findings') or [])} findings] due {rec['due'][:16]}: {rec['topic'][:60]}")
