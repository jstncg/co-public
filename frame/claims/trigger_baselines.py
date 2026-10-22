#!/usr/bin/env python3
"""Baseline accrual for trigger detection (spec 8/22, accrual started 8/24).

A trigger is a delta from baseline; a baseline takes weeks — so the nightly job exists
before any surfacing does. Pure computation, writes ~/.co/baselines/<tenant>.json, sends
nothing, surfaces nothing. The delta/hypothesis machinery reads this later, under the
spec's delivery laws (3 signal classes, reflective mode, 30-day floor).

Per day, from the member's own turns: message count, median length, punctuation rate,
caps-burst rate, question rate, median reply latency to co, and the day's top terms.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT_DIR = os.path.expanduser("~/.co/baselines")
ARCHIVE = os.path.expanduser("~/.co/co_dualwrite_archive.jsonl")
_STOP = set("the a an and or but of to in on for with is are was were be i you it this that "
            "my your me we they he she at as if so not just like what how why when".split())


def _tenant_of(phone: str) -> str:
    norm = "".join(c for c in (phone or "") if c.isdigit())
    founder = "".join(c for c in os.environ.get("CO_FOUNDER_HANDLE", "") if c.isdigit())
    return os.environ.get("CO_FOUNDER_TENANT", "dennis") if (founder and norm == founder) else f"p{norm}"


def _ts(row: dict) -> float:
    try:
        return dt.datetime.fromisoformat((row.get("sent_at") or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[len(s) // 2]


def day_stats(turns: list[dict]) -> dict:
    """One day's numbers from interleaved turns (both directions, time order)."""
    inbound = [t for t in turns if t.get("direction") == "inbound"]
    texts = [(t.get("text") or "") for t in inbound]
    lat = []
    for i, t in enumerate(turns):
        if t.get("direction") != "outbound":
            continue
        nxt = next((n for n in turns[i + 1:] if n.get("direction") == "inbound"), None)
        if nxt:
            d = _ts(nxt) - _ts(t)
            if 0 < d < 3600 * 6:
                lat.append(d)
    words = Counter(w for x in texts for w in re.findall(r"[a-z']{3,}", x.lower()) if w not in _STOP)
    return {
        "n": len(inbound),
        "med_len": _median([float(len(x)) for x in texts]),
        "punct": round(sum(1 for x in texts if re.search(r"[.!?]", x)) / max(1, len(texts)), 3),
        "caps": round(sum(1 for x in texts if re.search(r"\b[A-Z]{3,}\b", x)) / max(1, len(texts)), 3),
        "question": round(sum(1 for x in texts if "?" in x) / max(1, len(texts)), 3),
        "med_latency_s": round(_median(lat), 1),
        "top_terms": [w for w, _ in words.most_common(8)],
    }


def accrue(tenant: str | None = None) -> dict[str, int]:
    try:
        rows = [json.loads(ln) for ln in open(ARCHIVE) if ln.strip()]
    except OSError:
        return {}
    os.makedirs(OUT_DIR, exist_ok=True)
    by_tenant: dict[str, dict[str, list]] = {}
    for r in rows:
        t = _tenant_of(r.get("tenant_phone", ""))
        day = (r.get("sent_at") or "")[:10]
        if not day:
            continue
        by_tenant.setdefault(t, {}).setdefault(day, []).append(r)
    written = {}
    for t, days in by_tenant.items():
        if tenant and t != tenant:
            continue
        path = os.path.join(OUT_DIR, f"{t}.json")
        try:
            st = json.load(open(path))
        except Exception:
            st = {"days": {}}
        for day, turns in days.items():
            st["days"][day] = day_stats(sorted(turns, key=_ts))
        st["days"] = dict(sorted(st["days"].items())[-120:])   # a rolling four months
        json.dump(st, open(path, "w"), ensure_ascii=False)
        written[t] = len(st["days"])
    return written


if __name__ == "__main__":
    got = accrue(sys.argv[1] if len(sys.argv) > 1 else None)
    for t, n in got.items():
        print(f"{t}: {n} days of baseline")
