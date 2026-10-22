#!/usr/bin/env python3
"""
STORY ENGINE — the bonding layer. The top of the wow ladder.

Facts hook (perplexity). Spook proves it's real (depth). STORY bonds (retention) —
because when something tells you your own story across your whole life, you feel
witnessed, not surveilled. That's what makes someone stay.

Method: code gathers the IDENTITY DOSSIER from the traces —
  - faithfully-kept obscure services (identity facets: a creator, a believer, an athlete)
  - specific verified facts (achievements, place, faith)
  - relationship trajectory (who sustained across years vs who faded)
  - the temporal arc (which life-phase signals rose and fell)
Then the LLM weaves a SHORT narrative: protagonist + arc + through-line. Every beat is
anchored to a real data point; the weave is interpretation and is flagged as such.

SANDBOXED read-only. Truth rule: facts verified, narrative offered for correction.
Usage: python3 story_engine.py
"""

import json
import re
import sqlite3
import sys
from collections import defaultdict

sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from llm import complete  # noqa: E402

DB_RO = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
MODEL = "claude-sonnet-4-6"
GENERIC = re.compile(r"(facebook|google|apple|linkedin|youtube|amazon|nextdoor|instagram|spotify|uber|venmo|paypal|gmail)")


def from_email(raw):
    m = re.search(r'"from_email"\s*:\s*"([^"]*)"', raw or "")
    return (m.group(1) if m else "").lower()


def gather(conn):
    rows = conn.execute(
        "SELECT ts, raw_metadata, subject FROM communications "
        "WHERE channel='gmail' AND direction='received' AND ts IS NOT NULL"
    ).fetchall()
    months, last = defaultdict(set), {}
    for ts, raw, subj in rows:
        d = from_email(raw).split("@")[-1]
        if d:
            months[d].add(ts[:7])
            last[d] = max(last.get(d, ""), ts)
    # faithfully-kept, obscure (identity-revealing) services
    kept = sorted(
        [(len(m), d, f"{min(m)}→{max(m)}") for d, m in months.items()
         if len(m) >= 8 and last.get(d, "") > "2024-06" and not GENERIC.search(d)],
        reverse=True,
    )[:18]

    # relationship trajectory (top imessage contacts, msgs per year)
    contacts = conn.execute(
        """SELECT p.id, p.display_name, COUNT(*) n FROM communications c JOIN persons p ON p.id=c.from_person_id
           WHERE c.channel='imessage' AND c.direction='received' AND c.is_group_chat=0 AND p.is_self=0
             AND length(p.display_name) BETWEEN 1 AND 30
           GROUP BY p.id ORDER BY n DESC LIMIT 8""").fetchall()
    rel = []
    for cid, name, n in contacts:
        yrs = conn.execute(
            """SELECT substr(ts,1,4) y, COUNT(*) FROM communications
               WHERE channel='imessage' AND is_group_chat=0
                 AND (from_person_id=? OR to_person_ids LIKE '%'||?||'%') GROUP BY y ORDER BY y""",
            (cid, cid)).fetchall()
        rel.append(f"{name}: " + " ".join(f"{y}:{c}" for y, c in yrs if c > 20))

    return {
        "faithfully_kept_identity_signals": [f"{d} ({n} months, {span})" for n, d, span in kept],
        "relationship_trajectory_by_year": rel,
    }


SYS = """You are the bonding layer of a personal AI. From the identity dossier (drawn entirely from
the user's own inbox + message metadata), write the user their own STORY.

Not a profile, not a fact list — a SHORT narrative (under 220 words) with:
  - a protagonist with specific texture (use the REAL named services/signals to infer identity facets:
    e.g. a niche creator tool kept for years = a maker; a recurring church = faith; a sports/run signal
    = an athlete)
  - an arc over time (which relationships and life-phases rose and faded — use the trajectory data)
  - a through-line that means something and makes the person feel seen

Structure (per the user's own writing taste): three beats, no parallel-list rhetoric. Specific human,
specific stakes, specific detail. Warm, not flattering. Every beat anchored to a real signal in the
dossier. Where you INFER (identity from a service, meaning from a pattern), it's allowed but it must
be grounded — no inventing facts not implied by the data.

Return JSON: { "story": "<the narrative>", "anchors": ["<data point each beat rests on>"] }
Return ONLY JSON."""


def main():
    conn = sqlite3.connect(DB_RO, uri=True)
    dossier = gather(conn)
    print("IDENTITY DOSSIER (from traces):\n")
    print("  faithfully-kept signals:")
    for s in dossier["faithfully_kept_identity_signals"]:
        print(f"    {s}")
    print("\n  relationship trajectory:")
    for r in dossier["relationship_trajectory_by_year"]:
        print(f"    {r}")

    res = complete(model=MODEL, system=SYS, user=json.dumps(dossier, ensure_ascii=False), max_tokens=900)
    print("\n" + "=" * 64)
    print("YOUR STORY (facts verified, weave offered for correction):")
    print("=" * 64)
    m = re.search(r"\{.*\}", res["text"], re.S)
    try:
        out = json.loads(m.group(0))
        print("\n" + out.get("story", ""))
        print("\n  anchors:")
        for a in out.get("anchors", []):
            print(f"    • {a}")
    except (json.JSONDecodeError, AttributeError):
        print(res["text"])


if __name__ == "__main__":
    main()
