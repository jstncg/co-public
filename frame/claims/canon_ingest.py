#!/usr/bin/env python3
"""Canon ingest — the conversations become memory.

8/1, founder: "think about alllllll the damn conversations we've had." He was right and the
gap was structural: co's graph held 79 claims and a stream of links, while every decision,
thesis, constraint and research finding from months of strategic conversation lived in
docs/*.md and in the working vault — outside the product's memory. So co's daily prep was
guessing from thumbnails while the actual context sat unread.

This reads the CANON (docs/*.md — the DDs, the essays, the research adjudications, the
reviews, the goals) and the VAULT (the working memory files: goals, insights, patterns,
corrections, people) and writes the DURABLE things into co's graph as dated claims with
provenance, plus a short digest into the journal so recall, the orbit, and the daily prep
can see them.

Why this doesn't violate the blank-slate law (OPS 7/31): that law bans importing history a
real user could never give co — 14 years of scraped messages. This is the opposite: these
are conversations ABOUT HIS OWN WORK that any user would have with co over months. The
pathway is legitimate; only the volume is unusual.

Extraction law: DECISIONS, THESES, CONSTRAINTS, and FINDINGS only — never summaries, never
the model's opinion about him. Each claim carries its source file and is idempotent
(re-running updates nothing that already exists).

    python3 canon_ingest.py            # dry run: print what would land
    python3 canon_ingest.py --write    # write to the graph + journal
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "engine"))

CANON = Path("/Users/main/Projects/Secretary/Secretary-Production/projects/co/docs")
VAULT = Path("/Users/main/Projects/Secretary/Secretary-Production/.claude/memory")
VAULT_FILES = ["goals.md", "insights.md", "patterns.md", "corrections.md", "people.md", "facts.md"]
# docs/ is organized in buckets (canon/calls/research/specs/drops/…, 8/4) — rglob
# takes all of them; drops/ is Dennis's inbox and non-md drops get converted on processing.
STATE = os.path.expanduser("~/.co/canon_ingest.json")

SYS = """This document is one person's own strategic thinking — their decisions, theses,
constraints, and research findings about their work and life. Extract only what is DURABLE
and would still matter to them in three months.

Return ONLY JSON: {"claims": [{"statement": "<one sentence, THEIR vocabulary, stated as
fact about them or their work>", "kind": "belief|commitment|interest|event|person",
"why": "<3-8 words: what makes it durable>"}]}

Rules: 6-12 claims max. Never summarize the document. Never characterize the person
psychologically. Never include anything that reads as a to-do. A decision ("shipped X",
"chose Y over Z", "the buyer is not the user") is gold; a description ("the doc covers
several topics") is worthless. Skip the document entirely (empty list) if it holds no
durable position."""


def _load_state() -> dict:
    try:
        return json.load(open(STATE))
    except (OSError, json.JSONDecodeError):
        return {"files": {}}


def _save_state(st: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(st, open(STATE, "w"))


def _extract(path: Path) -> list:
    import asyncio

    import episode_engine as ee
    text = path.read_text(errors="ignore")[:14000]
    if len(text) < 400:
        return []
    got = asyncio.run(ee._ask(SYS, f"DOCUMENT: {path.name}\n\n{text}", ee.MODEL, max_tokens=1400)) or {}
    out = []
    for c in (got.get("claims") or [])[:12]:
        stmt = str(c.get("statement") or "").strip()
        if len(stmt) < 12:
            continue
        out.append({"statement": stmt[:280],
                    "kind": str(c.get("kind") or "belief"),
                    "why": str(c.get("why") or "")[:80],
                    "src": path.name})
    return out


def founder_tenant() -> str:
    """The one graph canon may touch. Env-resolved so nothing here is pinned to a name."""
    return os.environ.get("CO_FOUNDER_TENANT", "dennis")


def run(write: bool = False, tenant: str | None = None) -> dict:
    from co_engine import ontology as O

    # CANON BELONGS TO EXACTLY ONE GRAPH — the founder's.
    #
    # This reads co's own product documentation and writes it in as claims so the founder
    # can recall it. On a MEMBER's graph that same material is three separate harms: it is
    # not true of them, it drowns their real beliefs in recall (the founder's own graph is
    # already 2,720 canon vs 121 real), and it hands a member co's internal strategy.
    #
    # Until 8/6 the only thing preventing that was a default argument. One caller passing a
    # tenant would have done it silently. The law is structural now: canon refuses any graph
    # but the founder's, loudly, rather than trusting every future caller to remember.
    founder = founder_tenant()
    tenant = tenant or founder
    if tenant != founder:
        raise ValueError(
            f"canon_ingest refuses tenant {tenant!r}: co's documentation is not a fact about "
            f"a member. Only {founder!r} may hold canon claims.")

    files = sorted(list(CANON.rglob("*.md")) + list(CANON.rglob("*.txt"))) + [VAULT / f for f in VAULT_FILES if (VAULT / f).exists()]
    st = _load_state()
    db = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
    conn = O.connect(db) if write else None
    total, per_file = 0, {}
    digest = []
    for p in files:
        try:
            sig = f"{p.stat().st_mtime_ns}:{p.stat().st_size}"
        except OSError:
            continue
        if st["files"].get(str(p)) == sig:
            continue                                    # unchanged since last ingest
        claims = _extract(p)
        per_file[p.name] = len(claims)
        for c in claims:
            total += 1
            digest.append(c["statement"])
            if write:
                O.record(conn, c["statement"],
                         ontology=c["kind"] if c["kind"] in O.ONTOLOGY_KINDS else "belief",
                         source="chat",              # it came from conversation, not passive capture
                         confidence=0.8, level="frame" if c["kind"] == "belief" else "fact",
                         evidence=[{"source": "canon", "doc": c["src"], "note": c["why"],
                                    "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}])
        if write:
            st["files"][str(p)] = sig
    if write:
        conn.close()
        _save_state(st)
        if digest:                                      # the orbit + recall should see the thinking
            try:
                import journal
                for chunk in [digest[i:i + 8] for i in range(0, len(digest), 8)]:
                    journal.capture(tenant, "(from our conversations) " + " · ".join(chunk)[:1200],
                                    feed_transcript=False)   # corpus yes, conversation NEVER (8/4 defect)
            except Exception:
                pass
    return {"claims": total, "files": per_file}


if __name__ == "__main__":
    r = run(write="--write" in sys.argv)
    print(json.dumps(r, indent=1)[:1500])
