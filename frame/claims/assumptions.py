#!/usr/bin/env python3
"""The assumption ledger — load-bearing beliefs, recorded and hunted (8/24).

The founder's own specimen: "my bubble was popped today: it only cost 10k + some know-how
to train a sota TTS model." A cost-of-entry assumption, punctured by one fact. This organ
manufactures that moment instead of waiting for it: stated assumptions get mined from the
thread nightly, and the hunt searches for the fact that breaks one — the single
highest-value message the product can send: "you've been assuming X. it stopped being
true. here's the receipt."

Laws: an assumption is only ever POPPED by a receipt (a live URL with the counter-fact);
a hunt that finds nothing says nothing; pops lead the morning brief; a popped assumption
never re-pops.

    python3 assumptions.py mine [tenant]     # extract stated assumptions from the thread
    python3 assumptions.py hunt [tenant]     # search for a pop; print any found
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT_DIR = os.path.expanduser("~/.co/assumptions")
ARCHIVE = os.path.expanduser("~/.co/co_dualwrite_archive.jsonl")
MAX_LIVE = 12
HUNTS_PER_DAY = 2

MINE_SYS = """From this person's messages, extract LOAD-BEARING ASSUMPTIONS they state as fact:
beliefs about cost ("that's too expensive"), difficulty ("you can't X without Y"), timing ("it's
too late/early for"), capability ("i'd need a team"), or the world ("nobody pays for", "X is the
only way"). Only beliefs their decisions visibly rest on — not opinions, not preferences, not
facts that are obviously true. Phrase each as the falsifiable claim they're assuming. At most 6;
zero is common and honest. Reply ONLY JSON: {"assumptions": ["...", "..."]}"""

JUDGE_SYS = """An assumption someone lives by, and search results. Does any result GENUINELY
break the assumption — a concrete current fact (price, tool, precedent, rule change) that makes
it false or importantly weaker? A think-piece or partial counterexample does not count. Reply
ONLY JSON: {"popped": true|false, "line": "one lowercase sentence: you've been assuming X, but
<the counter-fact>", "url": "<the one receipt url>"} — line/url empty when popped is false."""


def _path(tenant: str) -> str:
    os.makedirs(OUT_DIR, exist_ok=True)
    return os.path.join(OUT_DIR, f"{tenant}.json")


def _load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {"assumptions": []}


def _save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False)


def _tenant_of(phone: str) -> str:
    norm = "".join(c for c in (phone or "") if c.isdigit())
    founder = "".join(c for c in os.environ.get("CO_FOUNDER_HANDLE", "") if c.isdigit())
    return os.environ.get("CO_FOUNDER_TENANT", "dennis") if (founder and norm == founder) else f"p{norm}"


def mine(tenant: str) -> int:
    """Nightly: fresh member turns → new live assumptions (deduped against the ledger)."""
    import llm
    try:
        rows = [json.loads(ln) for ln in open(ARCHIVE) if ln.strip()]
    except OSError:
        return 0
    texts = [(r.get("text") or "") for r in rows
             if _tenant_of(r.get("tenant_phone", "")) == tenant
             and r.get("direction") == "inbound" and len(r.get("text") or "") > 20][-80:]
    if len(texts) < 10:
        return 0
    got = llm.ask_json(llm.json_specs(), MINE_SYS, "\n".join(t[:200] for t in texts), max_tokens=400) or {}
    st = _load(tenant)
    seen = {a["text"].lower()[:60] for a in st["assumptions"]}
    added = 0
    for a in (got.get("assumptions") or []):
        a = str(a).strip()
        if not a or a.lower()[:60] in seen:
            continue
        st["assumptions"].append({"text": a[:220], "stated": dt.date.today().isoformat(),
                                  "status": "live", "evidence": None})
        added += 1
    live = [a for a in st["assumptions"] if a["status"] == "live"]
    if len(live) > MAX_LIVE:                     # oldest fall off; the load-bearing keep restating
        drop = len(live) - MAX_LIVE
        kept, dropped = [], 0
        for a in st["assumptions"]:
            if a["status"] == "live" and dropped < drop:
                dropped += 1
                continue
            kept.append(a)
        st["assumptions"] = kept
    _save(tenant, st)
    return added


def hunt(tenant: str) -> list[str]:
    """Search for the fact that breaks a live assumption. Receipt or silence."""
    import llm
    import research_engine
    import wrapped
    st = _load(tenant)
    live = [a for a in st["assumptions"] if a["status"] == "live"]
    if not live:
        return []
    today = dt.date.today().isoformat()
    live.sort(key=lambda a: a.get("last_hunt", ""))
    pops = []
    for a in live[:HUNTS_PER_DAY]:
        a["last_hunt"] = today
        q = llm.ask_json(llm.json_specs(),
                         'One web-search query that would surface evidence AGAINST this assumption '
                         '(current prices, new tools, precedents, rule changes). Reply ONLY JSON '
                         '{"query": "..."}', a["text"], max_tokens=80) or {}
        query = str(q.get("query") or "").strip()
        if not query:
            continue
        results = research_engine._search(query)
        if not results:
            continue
        blob = "\n".join(f"- {r['title']} ({r['url']}): {r.get('snippet', '')[:160]}" for r in results[:8])
        got = llm.ask_json(llm.json_specs(), JUDGE_SYS,
                           f"ASSUMPTION: {a['text']}\n\nRESULTS:\n{blob}", max_tokens=200) or {}
        url = str(got.get("url") or "").strip()
        line = str(got.get("line") or "").strip()
        if got.get("popped") and url and line and wrapped._url_alive(url):
            import disposition
            line = disposition.sanitize(line)
            a["status"] = "popped"
            a["evidence"] = {"line": line, "url": url, "date": today}
            pops.append(f"{line}\n{url}")
    _save(tenant, st)
    return pops


def fresh_pops(tenant: str) -> list[str]:
    """Undelivered pops for the brief. Held as PENDING, never marked delivered here: a pop
    consumed by a compose that never sent is the single most valuable sentence co can write,
    gone forever (8/25 — the same burn-on-compose defect found in the finds and the join).
    The caller commits after the send lands."""
    st = _load(tenant)
    out = []
    for a in st["assumptions"]:
        ev = a.get("evidence") or {}
        if a["status"] == "popped" and not a.get("delivered") and ev.get("line"):
            out.append(f"{ev['line']}\n{ev['url']}")
            a["pending"] = True
    if out:
        _save(tenant, st)
    return out


def commit(tenant: str) -> int:
    """The brief went out: what was pending is spent, and never re-delivered."""
    st = _load(tenant)
    n = 0
    for a in st["assumptions"]:
        if a.pop("pending", False):
            a["delivered"] = True
            n += 1
    if n:
        _save(tenant, st)
    return n


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "mine"
    t = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    if cmd == "mine":
        print(f"{t}: {mine(t)} new assumptions on the ledger")
        for a in _load(t)["assumptions"]:
            print(f"  [{a['status']}] {a['text'][:90]}")
    elif cmd == "hunt":
        got = hunt(t)
        print("\n\n".join(got) if got else "(no pops today — the assumptions held)")
