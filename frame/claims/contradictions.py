#!/usr/bin/env python3
"""Contradiction edges — the (d) engine, made graph-native (SUBSTRATE_PLAN, review Flaw #2).

The OLD (d) engine re-derived contradictions every run by feeding the whole vault + week to an LLM —
expensive, stateless, ungrounded. THIS materializes contradictions as persistent EDGES in the belief
graph: a `contradicts` edge from a value-claim (what they SAY matters) to a behavior-claim (what they
ACTUALLY do), with the (d) line stored on the edge. After this runs, surfacing the (d) is a cheap query
(claimstore.surface_contradiction) — grounded, auditable, rotatable, no re-derivation.

Two phases:
  1. extract VALUE-claims from the vault (goals.md + patterns.md stated values) into the store
  2. pair value × behavior claims → LLM finds genuine conflicts → write contradicts edges + the (d) note

  doppler run -- /…/substrate/.venv/bin/python3 contradictions.py
"""
import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from claimstore import connect, upsert, add_relation, claims_by_types, surface_contradiction, dump_markdown
from anthro import make_client

VAULT = Path("/Users/main/Projects/Secretary/Secretary-Production/.claude/memory")
MODEL = "claude-sonnet-4-6"   # contradiction detection is the moat call — worth Sonnet, not Haiku
BEHAVIOR_TYPES = ["routine", "possession", "obligation", "preference", "relationship"]

VALUE_SYS = """Extract the user's STATED VALUES / GOALS — what they SAY matters most — from these vault
notes. These are first-class claims of type 'value', e.g.: "this year is about depth not breadth",
"wants to build something that lasts", "relationships matter most", "avoids discomfort".

Only genuine stated values/goals/self-described priorities. NOT behaviors, NOT facts about possessions.
5-15 of them, the load-bearing ones.

Return ONLY JSON: {"values":[{"statement": "...", "confidence": 0.0-1.0}]}"""

CONTRA_SYS = """You're given the user's STATED VALUES and their ACTUAL BEHAVIORS (both from evidence).
Find genuine CONTRADICTIONS — where a behavior conflicts with a stated value. This is the "you say X but
you actually do Y" that a real friend who knows them would call out.

For each genuine contradiction, name which value and which behavior conflict (by their indices) and write
the LINE Donna would say — 1-2 sentences, specific, quotes the behavior, warm-but-honest, the friend-who-
calls-bullshit voice. NOT preachy, NOT "have you considered". Total conviction.

Be strict: only REAL conflicts, not loose thematic links. A forced contradiction is worse than none.
If nothing genuinely conflicts, return an empty list.

Return ONLY JSON: {"contradictions":[{"value_idx":int,"behavior_idx":int,"line":"...","confidence":0.0-1.0}]}"""


async def extract_values(client, conn):
    text = ""
    for f in ["goals.md", "patterns.md"]:
        p = VAULT / f
        if p.exists():
            text += f"\n=== {f} ===\n" + p.read_text()[:6000]
    r = await client.messages.create(model=MODEL, system=VALUE_SYS, max_tokens=1500,
                                     messages=[{"role": "user", "content": text}])
    m = re.search(r"\{.*\}", "".join(b.text for b in r.content if b.type == "text"), re.S)
    vals = json.loads(m.group(0)).get("values", []) if m else []
    for v in vals:
        upsert(conn, type="value", level="fact", statement=v["statement"].strip(),
               confidence=float(v.get("confidence", 0.8)),
               evidence=[{"source": "vault", "file": "goals/patterns"}], when="2026-05-28")
    return len(vals)


async def build_edges(client, conn):
    values = conn.execute("SELECT id, statement FROM claims WHERE type='value' ORDER BY confidence DESC").fetchall()
    # Contradictions live in behavioral PATTERNS ("spends weekends networking"), NOT high-confidence FACTS
    # ("has a Robinhood account" — can't contradict a value). Pull pattern-level behaviors; that's where
    # value-conflicts actually are. (Embeddings/#4 would relevance-match behaviors to each value — deferred.)
    # A live (d) must fire on WHO THEY ARE NOW. Two filters, both learned from real false-positives:
    #  1. ACTIVE behaviors only — passive-receipt claims ("receives alerts", "subscribed") aren't
    #     behaviors that contradict a value (the receiving!=doing rule at the (d) layer).
    #  2. RECENT only — a true-but-stale action (applied to summer-2025 internships, ~15mo ago) is NOT a
    #     current contradiction. last_verified must be within RECENT_DAYS, else it's history, not behavior.
    import datetime as _dt
    cutoff = (_dt.date.today() - _dt.timedelta(days=150)).isoformat()
    behaviors = conn.execute(
        "SELECT id, type, statement, confidence FROM claims "
        "WHERE level='pattern' AND type IN ('routine','obligation','preference','relationship') "
        "AND COALESCE(status,'active')!='retired' "
        "AND statement NOT LIKE '%receiv%' AND statement NOT LIKE '%subscrib%' "
        "AND statement NOT LIKE '%alert%' AND statement NOT LIKE '%newsletter%' "
        "AND statement NOT LIKE '%job search%' AND statement NOT LIKE '%job-seek%' "
        "AND statement NOT LIKE '%applied%' AND statement NOT LIKE '%internship%' "
        "AND last_verified >= ? "
        "ORDER BY confidence DESC LIMIT 80", (cutoff,)).fetchall()
    behaviors = [(r[0], r[1], r[2], r[3]) for r in behaviors]
    if not values or not behaviors:
        return 0
    vlist = "\n".join(f"[V{i}] {s}" for i, (_, s) in enumerate(values))
    blist = "\n".join(f"[B{i}] {s}" for i, (_, _, s, _) in enumerate(behaviors))
    r = await client.messages.create(
        model=MODEL, system=CONTRA_SYS, max_tokens=2000,
        messages=[{"role": "user", "content": f"STATED VALUES:\n{vlist}\n\nACTUAL BEHAVIORS:\n{blist}"}])
    m = re.search(r"\{.*\}", "".join(b.text for b in r.content if b.type == "text"), re.S)
    contras = json.loads(m.group(0)).get("contradictions", []) if m else []
    n = 0
    for c in contras:
        vi, bi = c.get("value_idx"), c.get("behavior_idx")
        if vi is None or bi is None or not (0 <= vi < len(values)) or not (0 <= bi < len(behaviors)):
            continue
        add_relation(conn, values[vi][0], behaviors[bi][0], "contradicts",
                     note=c.get("line", "").strip(), confidence=float(c.get("confidence", 0.6)),
                     when="2026-05-28")
        n += 1
    return n


async def main():
    client = make_client()
    conn = connect()
    nv = await extract_values(client, conn)
    print(f"📥 extracted {nv} stated-value claims from vault")
    ne = await build_edges(client, conn)
    print(f"🔗 materialized {ne} contradiction edges\n")
    top = surface_contradiction(conn)
    print("=== top (d) — now a cheap graph query ===")
    if top:
        print(f"  {top['note']}\n  ↳ value: {top['value']}\n  ↳ behavior: {top['behavior']}  [{top['confidence']:.0%}]")
    else:
        print("  (no contradictions — honest SKIP)")


if __name__ == "__main__":
    asyncio.run(main())
