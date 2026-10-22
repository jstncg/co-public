#!/usr/bin/env python3
"""LANDED — did the message do anything (8/27).

The one table. Co has never known whether anything it sent was worth sending: the eval measures
laws held, the tests measure source laws, and neither measures quality. Every improvement co made
before this came from a human reading its data and editing files, which is craftsmanship, not
self-improvement, and it does not survive that human.

A landing is not binary, it is a LADDER, and each rung is stronger evidence than the last:

    sent → delivered → read → replied → acted

`acted` is the only rung that means the message changed what happened. `read` is the cheapest
honest signal and only exists at all since status callbacks went on every send path today
(cf329916) — before that "landed" was inferred nightly from guesses.

Append-only by construction. The router already learned this the hard way: a last-status-per-number
MAP overwrote its own history and the reward stream had to be rebuilt as per-message events. So
this file only ever appends, and the fold happens at read time.

The LANE is the load-bearing column. Without it you cannot answer the only question worth asking —
do meeting reads land better than desk finds — so it is derived from the calling module rather than
passed, because a caller that must remember to label itself eventually will not.

    python3 landed.py <tenant>            # per-lane landing rates
"""
from __future__ import annotations

import datetime as dt
import hashlib
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DIR = os.path.expanduser("~/.co/landed")

# Ordered. A later rung implies every earlier one, so evidence only ever moves forward.
RUNGS = ("sent", "delivered", "read", "replied", "acted")
MARKS = ("undone",)          # terminal, not a rung: co acted and the member reversed it
REPLY_WINDOW_MIN = 90        # a reply after this is a new conversation, not a response

# ── THE OBJECTIVE FUNCTION ────────────────────────────────────────────────────────────────────
#   maximise the outcomes co caused and the member KEPT, minus the attention it cost to cause them
#
# The subtraction is the load-bearing half. Without it, more is always better and the product
# becomes a feed; with it, the only direction up is precision, because volume is the cost term.
#
# READ IS WORTH ZERO. That is the unusual choice and the whole point: information that changed
# nothing is worth exactly as much as no information, however well written. Almost everything co
# has ever sent scores zero under this, which is not a bug in the scoring.
VALUE = {
    "sent": 0.0,             # went out. proves nothing.
    "delivered": 0.0,        # the network worked. proves nothing.
    "read": 0.0,             # they looked. still nothing changed.
    "replied": 0.3,          # it provoked something out of them
    "acted": 1.0,            # the outcome. the only rung that means the message mattered.
}
UNDONE = -2.0                # worse than silence: it spent attention AND made work

# Attention is not spent equally. An interruption costs; an answer to their own question costs
# almost nothing because they had already spent the attention; a silent act costs none at all.
COST = {"proactive": 0.35, "requested": 0.05, "act": 0.0}
KINDS = tuple(COST)


def _path(tenant: str) -> str:
    os.makedirs(DIR, exist_ok=True)
    return os.path.join(DIR, f"{tenant}.jsonl")


def _append(tenant: str, row: dict) -> None:
    try:
        with open(_path(tenant), "a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass                                   # never let bookkeeping break a send


def _caller_lane() -> str:
    """The module that sent it IS the lane. Derived rather than passed: fifteen call sites, and
    one that forgets its label writes a row nobody can group by."""
    try:
        for fr in inspect.stack()[2:8]:
            mod = os.path.basename(fr.filename)[:-3]
            if mod not in ("landed", "daily_text", "sendblue_router"):
                return mod[:40]
    except Exception:
        pass
    return "unknown"


def _id(tenant: str, text: str, when: str) -> str:
    return hashlib.sha256(f"{tenant}|{text}|{when}".encode()).hexdigest()[:16]


def record(tenant: str, text: str, lane: str | None = None,
           expected: str | None = None, handle: str = "", kind: str = "proactive") -> str:
    """A send happened. EXPECTED is the prediction — what co thinks this should cause. Without it
    the ledger records traffic; with it every message becomes a scored bet.

    KIND sets the attention price. Defaults to `proactive`, the expensive one, because assuming a
    send was free is how a cost term quietly stops working."""
    when = dt.datetime.now().isoformat(timespec="seconds")
    rid = _id(tenant, text or "", when)
    _append(tenant, {"t": "send", "id": rid, "lane": (lane or _caller_lane()),
                     "sent": when, "chars": len(text or ""), "handle": handle or "",
                     "kind": kind if kind in KINDS else "proactive",
                     "expected": (expected or "")[:120],
                     "head": (text or "")[:80]})
    return rid


def signal(tenant: str, rung: str, rid: str = "", handle: str = "") -> None:
    """Evidence arrived. Joined by id when co has one, else by the send's message handle."""
    if rung not in RUNGS and rung not in MARKS:
        return
    _append(tenant, {"t": "sig", "id": rid, "handle": handle or "", "rung": rung,
                     "at": dt.datetime.now().isoformat(timespec="seconds")})


def fold(tenant: str, days: int = 30) -> list[dict]:
    """Sends with their best rung. Evidence only moves forward: a delivered receipt arriving after
    a reply cannot demote the row."""
    cut = (dt.datetime.now() - dt.timedelta(days=days)).isoformat()
    sends: dict[str, dict] = {}
    by_handle: dict[str, str] = {}
    sigs: list[dict] = []
    try:
        for line in open(_path(tenant)):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("t") == "send":
                if r.get("sent", "") < cut:
                    continue
                r["rung"] = "sent"
                sends[r["id"]] = r
                if r.get("handle"):
                    by_handle[r["handle"]] = r["id"]
            elif r.get("t") == "sig":
                sigs.append(r)
    except OSError:
        return []
    for s in sigs:
        rid = s.get("id") or by_handle.get(s.get("handle", ""), "")
        row = sends.get(rid)
        if not row:
            continue
        if s["rung"] in MARKS:
            row["undone"] = True          # terminal: a reversal is not a rung, it is a verdict
        elif RUNGS.index(s["rung"]) > RUNGS.index(row["rung"]):
            row["rung"] = s["rung"]
    return sorted(sends.values(), key=lambda r: r["sent"])


def score(row: dict) -> float:
    """One send's contribution to the objective: what it caused, minus what it cost to cause.

    An undone act does not merely score zero — it is NEGATIVE, because it spent the member's
    attention and then made work for them. Silence, which scores exactly zero, beats it."""
    cost = COST.get(row.get("kind", "proactive"), COST["proactive"])
    if row.get("undone"):
        return UNDONE - cost
    return VALUE.get(row.get("rung", "sent"), 0.0) - cost


def objective(tenant: str, days: int = 30) -> dict:
    """THE number, and the per-lane breakdown that says which lanes deserve to exist.

    A lane whose total is negative is not underperforming, it is COSTING the member — and the
    honest response to it is deletion rather than tuning. That verdict is the whole reason the
    cost term exists."""
    rows = fold(tenant, days)
    lanes: dict[str, dict] = {}
    for r in rows:
        d = lanes.setdefault(r["lane"], {"sends": 0, "acted": 0, "undone": 0, "score": 0.0})
        d["sends"] += 1
        d["score"] += score(r)
        if r.get("undone"):
            d["undone"] += 1
        elif r.get("rung") == "acted":
            d["acted"] += 1
    for d in lanes.values():
        d["score"] = round(d["score"], 2)
        d["per_send"] = round(d["score"] / max(d["sends"], 1), 2)
    total = round(sum(d["score"] for d in lanes.values()), 2)
    return {"total": total, "sends": len(rows),
            "lanes": dict(sorted(lanes.items(), key=lambda kv: kv[1]["score"])),
            "negative": [k for k, v in lanes.items() if v["score"] < 0]}


# ── HOLD-OUTS: the sparse ground truth ────────────────────────────────────────────────────────
# The objective's dense proxy is `acted`, and a proxy left alone rots. Counterfactual impact is
# the real quantity — a renewal the member would have caught unaided scores zero however well co
# reported it — and withholding is the only way to observe it. Recording the mechanism here does
# NOT turn it on: suppressing real sends is a product decision, taken separately.
HOLD_OUT_RATE = 0.05


def hold_out(tenant: str, lane: str, text: str) -> str:
    """A send co chose NOT to make, recorded so the counterfactual can be read later. Scores
    nothing either way: a held send costs no attention and causes no outcome."""
    when = dt.datetime.now().isoformat(timespec="seconds")
    rid = _id(tenant, text or "", when)
    _append(tenant, {"t": "held", "id": rid, "lane": lane, "sent": when,
                     "head": (text or "")[:80]})
    return rid


def stats(tenant: str, days: int = 30) -> dict:
    """Per-lane landing rates. THE answer to the only question: which lanes deserve to exist."""
    rows = fold(tenant, days)
    out: dict[str, dict] = {}
    for r in rows:
        d = out.setdefault(r["lane"], {"sent": 0, "read": 0, "replied": 0, "acted": 0})
        d["sent"] += 1
        i = RUNGS.index(r["rung"])
        for k in ("read", "replied", "acted"):
            if i >= RUNGS.index(k):
                d[k] += 1
    for d in out.values():
        n = max(d["sent"], 1)
        d["read_rate"] = round(d["read"] / n, 2)
        d["act_rate"] = round(d["acted"] / n, 2)
    return out


def note_reply(tenant: str, when: dt.datetime | None = None) -> bool:
    """They answered. Upgrades the most recent send inside the window — a reply two hours later is
    a new conversation, not a response to what co said."""
    when = when or dt.datetime.now()
    rows = [r for r in fold(tenant, days=2) if r["rung"] != "acted"]
    if not rows:
        return False
    last = rows[-1]
    try:
        age = (when - dt.datetime.fromisoformat(last["sent"])).total_seconds() / 60
    except ValueError:
        return False
    if age > REPLY_WINDOW_MIN or age < 0:
        return False
    signal(tenant, "replied", rid=last["id"])
    return True


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    ob = objective(t)
    if not ob["sends"]:
        print("(nothing recorded yet — the ledger starts at the next send)")
        raise SystemExit
    print(f"  OBJECTIVE {ob['total']:+.2f} over {ob['sends']} sends\n")
    st = stats(t)
    for lane, d in ob["lanes"].items():
        r = st.get(lane, {})
        print(f"  {lane:18s} {d['score']:+6.2f}  ({d['per_send']:+.2f}/send)  "
              f"sent {d['sends']:3d}  acted {d['acted']:2d}  undone {d['undone']:2d}  "
              f"read {r.get('read_rate', 0):.0%}")
    if ob["negative"]:
        print(f"\n  costing you more than they produce: {', '.join(ob['negative'])}")
