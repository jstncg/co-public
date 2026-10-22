#!/usr/bin/env python3
"""The dispatch rung — open list items routed to the organs that can work them (v2-the-list §work loop).

This is dispatch, not new capability: research-shaped asks go to research_engine.commission
(search-at-commission, delivery on the anchor rail), watch-shaped asks to watch_engine.create,
and anything no organ can work is `scoped` with an honest comment saying what it's waiting on.
Never fake progress: `working` carries the real job ref, and a research item flips to
done-by-co only when its anchor actually fired (the delivery receipt, not a hope).

The whole rung is SILENT — it sends nothing, so it runs outside the send budget and the
member finds out what happened by their own volition (the list's founding law). A standing
watch keeps its item `working` honestly: the watch IS live work; the member closes it.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MAX_DISPATCH_PER_TICK = 2      # bounds LLM cost; the rest wait for the next tick

CLASSIFY_SYS = """You route a person's want to the one worker that can act on it. Reply ONLY JSON:
{"shape": "research" | "watch" | "none", "note": str}

- "research": a question co can search and compose an answer to (find X, compare Y, what's the
  best Z, look into W). Must be answerable from the world, not from their life.
- "watch": a standing condition on the world to monitor (a price, a date, availability,
  a release, a deadline).
- "none": needs hands, a decision, or access co doesn't have — or it's a life intention,
  not a task. For "none", `note` says in one honest lowercase sentence what this is waiting
  on or why co can't work it yet. Never promise, never coach."""


def _classify(text: str) -> dict:
    import llm
    got = llm.ask_json(llm.json_specs(), CLASSIFY_SYS, text[:400], max_tokens=120) or {}
    return got if got.get("shape") in ("research", "watch", "none") else {"shape": "none", "note": ""}


def _research_rid(tenant: str, ask: str) -> str | None:
    """commission() doesn't return its id — recover it from the anchor row it just wrote."""
    try:
        import anchors
        import journal
        st = anchors._load(journal._claims_db(tenant))
        for a in reversed(st.get("anchors", [])):
            if a.get("research_id") and (a.get("quote") or "") == ask[:160]:
                return a["research_id"]
    except Exception:
        pass
    return None


def _dispatch_one(tenant: str, it: dict) -> str:
    import list_engine as le
    text = it["text"]
    shape = _classify(text)
    if shape["shape"] == "research":
        import research_engine
        got = research_engine.commission(tenant, text)
        if got:
            rid = _research_rid(tenant, text) or ""
            le.scope(tenant, it["id"], f"researching: {got['topic']} — report lands {got['due']}")
            le.set_working(tenant, it["id"], f"research:{rid or got['topic'][:60]}")
            return f"research:{got['topic'][:40]!r}"
    if shape["shape"] == "watch":
        import watch_engine
        got = watch_engine.create(tenant, text)
        if got and got.get("kind") not in (None, "over_budget"):
            le.scope(tenant, it["id"], got.get("line") or f"watching: {got['what'][:120]}")
            le.set_working(tenant, it["id"], f"watch:{(got.get('what') or text)[:60]}")
            return f"watch:{got['what'][:40]!r}"
        if got and got.get("kind") == "over_budget":
            le.scope(tenant, it["id"], got.get("line") or "watch budget is full")
            return "watch:over_budget"
    # No organ can work it — scoped with the honest reason, never fake progress.
    note = (shape.get("note") or "").strip() or \
        "nothing co can run on this yet. it holds here until there's a workable piece."
    le.scope(tenant, it["id"], note)
    return "scoped:unworkable"


def _sweep_research_completions(tenant: str) -> list[str]:
    """A research item is done when its anchor FIRED — the delivery is the receipt."""
    import journal
    import list_engine as le
    out = []
    try:
        import anchors
        st = anchors._load(journal._claims_db(tenant))
        fired = {a["research_id"]: a for a in st.get("anchors", [])
                 if a.get("research_id") and a.get("fired")}
    except Exception:
        return out
    for it in le.live(tenant):
        ref = it.get("job_ref") or ""
        if it["state"] == "working" and ref.startswith("research:"):
            a = fired.get(ref.split(":", 1)[1])
            if a:
                what = a.get("what") or "research report delivered"
                if le.done_by_co(tenant, it["id"], [{"what": what}]):
                    try:
                        import work
                        work.log(tenant, "researched", what, why=it["text"][:120])
                    except Exception:
                        pass
                    out.append(f"done:{it['text'][:40]!r}")
    return out


def run_tenant(tenant: str) -> list[str]:
    """Silent by construction: routes open member items, flips finished research. Never sends."""
    import list_engine as le
    lines = []
    opens = [i for i in le.live(tenant)
             if i["state"] == "open" and i["source"] != "co-proposed"]
    for it in opens[:MAX_DISPATCH_PER_TICK]:
        try:
            lines.append(_dispatch_one(tenant, it))
        except Exception as ex:
            lines.append(f"err:{ex}")
    lines.extend(_sweep_research_completions(tenant))
    return lines


def main():
    import daily_text
    for db in daily_text.all_tenant_dbs():
        tenant = "dennis" if db.name == "claims.db" else db.name[len("claims_"):-len(".db")]
        got = run_tenant(tenant)
        if got:
            print(f"{tenant}: {', '.join(got)}")


if __name__ == "__main__":
    main()
