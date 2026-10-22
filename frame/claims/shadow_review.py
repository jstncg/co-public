#!/usr/bin/env python3
"""Scout shadow review — grade what the scout proposed, measure the bar (kyo interest.py ritual).

The ledger (~/.co/scout_shadow/<tenant>.jsonl) holds every candidate the scout model
ever proposed, created or rejected. This CLI is the weekly ritual: grade each ungraded
candidate yes ("I'd have wanted that watch") or no, then read the stats. The
PRE-REGISTERED gate, set before any data existed so it can't be gamed after:

    the scout bar may be LOWERED only when graded-yes >= 90% across 2 consecutive
    weeks with >= 1 candidate/week. Until then the declared-intent bar stands.

    python3 shadow_review.py            # grade ungraded candidates interactively
    python3 shadow_review.py --stats    # the gate check, by week
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

LEDGER_DIR = os.path.expanduser("~/.co/scout_shadow")


def _path(tenant: str) -> str:
    return os.path.join(LEDGER_DIR, f"{tenant}.jsonl")


def _rows(tenant: str) -> list:
    try:
        with open(_path(tenant)) as f:
            return [json.loads(l) for l in f if l.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def _rewrite(tenant: str, rows: list) -> None:
    tmp = _path(tenant) + ".tmp"
    with open(tmp, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, _path(tenant))


def grade(tenant: str) -> None:
    rows = _rows(tenant)
    ungraded = [r for r in rows if r.get("grade") is None]
    if not ungraded:
        print("nothing ungraded.")
        return
    print(f"{len(ungraded)} candidates to grade — y (would want it) / n (would not) / s (skip)\n")
    for r in ungraded:
        print(f"  [{r['verdict']}] {r['what']}")
        print(f"      target: {r.get('target','')[:80]}  care: {r.get('care','')[:80]}")
        a = input("  y/n/s > ").strip().lower()
        if a in ("y", "n"):
            r["grade"] = a
            r["graded_at"] = dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    _rewrite(tenant, rows)
    stats(tenant)


def stats(tenant: str) -> None:
    rows = _rows(tenant)
    if not rows:
        print("empty ledger — the scout hasn't proposed anything yet.")
        return
    by_week: dict = {}
    for r in rows:
        wk = dt.datetime.strptime(r["ts"][:10], "%Y-%m-%d").strftime("%G-W%V")
        by_week.setdefault(wk, []).append(r)
    print(f"{'week':<10} {'proposed':>8} {'created':>8} {'graded':>7} {'yes-rate':>9}")
    weeks_ok = []
    for wk in sorted(by_week):
        rs = by_week[wk]
        graded = [r for r in rs if r.get("grade") in ("y", "n")]
        yes = sum(1 for r in graded if r["grade"] == "y")
        rate = (yes / len(graded)) if graded else None
        created = sum(1 for r in rs if str(r["verdict"]).startswith("created"))
        print(f"{wk:<10} {len(rs):>8} {created:>8} {len(graded):>7} "
              f"{f'{rate:.0%}' if rate is not None else '—':>9}")
        weeks_ok.append(rate is not None and rate >= 0.9 and len(rs) >= 1)
    gate = len(weeks_ok) >= 2 and all(weeks_ok[-2:])
    print(f"\npre-registered gate (>=90% yes, 2 consecutive weeks): {'PASSES — bar may be lowered' if gate else 'not met — declared-intent bar stands'}")


if __name__ == "__main__":
    tenant = "dennis"
    if "--stats" in sys.argv:
        stats(tenant)
    else:
        grade(tenant)
