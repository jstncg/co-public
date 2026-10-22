#!/usr/bin/env python3
"""The work ledger — the staff's work, made visible.

The twice-converged organ (call-002: Justin's "the feed can display the agent's actions —
'I did some digging, here are cheaper sauna parts'"; Dennis's work-ledger ask, weeks
apart, uncoordinated) and institution-law property 2: MANY HANDS, ONE LEDGER — the
organs presented as staff whose work APPEARS. The ledger is the invoice justification.

The organs already DO the work (watches checked, videos watched for later, weekly finds
sourced, morning reads pulled, research commissioned). Nothing surfaced it, so the
product read as a mind, never as a staff. This is the one place they clock in:

    work.log(tenant, verb, what, why=None, url=None)

Append-only JSONL at ~/.co/work/<tenant>.jsonl. wrapped.app_state serves the recent
window ("staff" key) for the app; the world page renders it as its own stack. Entries
are USER-MEANINGFUL work only — reads, watches, deliveries, research — never plumbing
(backups, ingests, thumbnail warms). A ledger that lists cron jobs is a log; a ledger
that lists what a person would have billed for is a staff.

Verbs (closed set, so surfaces can phrase them):
    watched     — a long video actually watched end to end (deferred_watch)
    read        — a morning read pulled and sent (wake)
    checked     — a standing watch checked AND something material found (watch_engine fire)
    found       — an unasked find sourced and delivered (unasked_delivery)
    researched  — a commission gathered or delivered (research_engine)
    drafted     — groundwork produced for a leap (staff.py)

Silent-on-failure by design: the ledger must never break the organ doing the work.
"""
from __future__ import annotations

import json
import os
import time

DIR = os.path.expanduser("~/.co/work")
VERBS = {"watched", "read", "checked", "found", "researched", "drafted"}
KEEP = 400          # rolling window per tenant; the file is truncated past 2x this


def _path(tenant: str) -> str:
    os.makedirs(DIR, exist_ok=True)
    return os.path.join(DIR, f"{tenant}.jsonl")


def log(tenant: str, verb: str, what: str, why: str = None, url: str = None) -> None:
    """One line of staff work. Never raises."""
    try:
        if not tenant or verb not in VERBS or not (what or "").strip():
            return
        e = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "verb": verb, "what": what.strip()[:280]}
        if why:
            e["why"] = why.strip()[:200]
        if url:
            e["url"] = url.strip()[:500]
        p = _path(tenant)
        with open(p, "a") as f:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
        # bound the file without ever losing the recent window
        try:
            if os.path.getsize(p) > 200_000:
                lines = open(p).read().splitlines()[-KEEP:]
                tmp = p + ".tmp"
                open(tmp, "w").write("\n".join(lines) + "\n")
                os.replace(tmp, p)
        except OSError:
            pass
    except Exception:
        pass


def recent(tenant: str, n: int = 20, days: int = 14) -> list:
    """Last n entries within the window, newest first. [] on any trouble."""
    try:
        cutoff = time.time() - days * 86400
        out = []
        for ln in open(_path(tenant)).read().splitlines():
            try:
                e = json.loads(ln)
                t = time.mktime(time.strptime(e.get("ts", ""), "%Y-%m-%dT%H:%M:%S"))
                if t >= cutoff:
                    e["_t"] = t
                    out.append(e)
            except Exception:
                continue
        out.sort(key=lambda x: -x["_t"])
        for e in out:
            e.pop("_t", None)
        return out[:n]
    except Exception:
        return []


def week(tenant: str) -> list:
    """The 'what your people did' window — last 7 days, oldest first (report order)."""
    got = recent(tenant, n=100, days=7)
    return list(reversed(got))


if __name__ == "__main__":
    import sys
    t = sys.argv[1] if len(sys.argv) > 1 else "dennis"
    for e in recent(t):
        print(f"{e['ts']}  {e['verb']:10s} {e['what']}" + (f"  ({e['why']})" if e.get("why") else ""))
