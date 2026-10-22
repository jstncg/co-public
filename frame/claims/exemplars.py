#!/usr/bin/env python3
"""The win flywheel — the agent's own landed turns become its exemplars (8/23).

Reactions and fast substantive replies are the only turn-quality signal the member ever
volunteers. Mined nightly from the dualwrite archive into ~/.co/exemplars/<tenant>.json;
the engine injects them as YOUR OWN TURNS THAT LANDED. The agent gets better weekly from
its own record, per member, without a single label being asked for.

A turn LANDED if: co's send was short and linkless, and the member either tapbacked it
positively or replied substantively within ten minutes. Recency wins; near-duplicate
openings collapse so the pack stays diverse.

    python3 exemplars.py            # mine every tenant in the archive
    python3 exemplars.py <tenant>   # one tenant
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

ARCHIVE = os.path.expanduser("~/.co/co_dualwrite_archive.jsonl")
OUT_DIR = os.path.expanduser("~/.co/exemplars")
MAX_PAIRS = 12
FAST_S = 600
_TAPBACK_RE = re.compile(r"^(Loved|Laughed at|Emphasized)\s+[“\"]", re.I)


def _tenant_of(phone: str) -> str:
    norm = "".join(c for c in (phone or "") if c.isdigit())
    founder = "".join(c for c in os.environ.get("CO_FOUNDER_HANDLE", "") if c.isdigit())
    return os.environ.get("CO_FOUNDER_TENANT", "dennis") if (founder and norm == founder) else f"p{norm}"


def _ts(row: dict) -> float:
    try:
        return dt.datetime.fromisoformat((row.get("sent_at") or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def mine(tenant: str | None = None) -> dict[str, int]:
    try:
        rows = [json.loads(ln) for ln in open(ARCHIVE) if ln.strip()]
    except OSError:
        return {}
    by_tenant: dict[str, list] = {}
    for r in rows:
        by_tenant.setdefault(_tenant_of(r.get("tenant_phone", "")), []).append(r)
    os.makedirs(OUT_DIR, exist_ok=True)
    written: dict[str, int] = {}
    for t, trs in by_tenant.items():
        if tenant and t != tenant:
            continue
        pairs = []
        for i, r in enumerate(trs):
            if r.get("direction") != "outbound":
                continue
            you = (r.get("text") or "").strip()
            if not you or len(you) > 240 or "http" in you or you.startswith("["):
                continue
            them = next(((p.get("text") or "").strip() for p in reversed(trs[:i])
                         if p.get("direction") == "inbound"), "")
            if not them or them.startswith("http"):
                continue
            nxt = next((n for n in trs[i + 1:] if n.get("direction") == "inbound"), None)
            if not nxt:
                continue
            ntxt = (nxt.get("text") or "").strip()
            landed = bool(_TAPBACK_RE.match(ntxt)) or \
                (0 < _ts(nxt) - _ts(r) < FAST_S and len(ntxt) > 12 and not ntxt.startswith("http"))
            if landed:
                pairs.append({"them": them[:140], "you": you[:180], "ts": _ts(r)})
        # newest first, near-dup openings collapse (same first five words = same move)
        pairs.sort(key=lambda p: -p["ts"])
        seen, kept = set(), []
        for p in pairs:
            key = " ".join(p["you"].lower().split()[:5])
            if key in seen:
                continue
            seen.add(key)
            kept.append({"them": p["them"], "you": p["you"]})
            if len(kept) >= MAX_PAIRS:
                break
        if kept:
            with open(os.path.join(OUT_DIR, f"{t}.json"), "w") as f:
                json.dump({"pairs": kept, "mined": dt.date.today().isoformat()}, f, ensure_ascii=False)
            written[t] = len(kept)
    return written


if __name__ == "__main__":
    got = mine(sys.argv[1] if len(sys.argv) > 1 else None)
    for t, n in got.items():
        print(f"{t}: {n} exemplars")
    if not got:
        print("(nothing landed yet)")
