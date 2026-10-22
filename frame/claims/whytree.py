#!/usr/bin/env python3
"""The Why-Tree — SOTA-2026 method for understanding a person from EMAIL ONLY (Dennis's design).

Two ideas:
  1. TRIAGE, don't ingest everything. Email is mostly marketing pre-selects (noise). Score senders; keep the
     SIGNAL (transactional = real actions, engaged = he chose to read, personal = real humans, aspirational =
     subscribed-but-ignored = a WISH). Reason only over the signal slice. Cheap + deterministic.
  2. RECURSIVE ABDUCTION to root drives. For each observation ask WHY → proximate goal → deeper goal → root.
     The person's core driver is the ROOT THE MOST BRANCHES CONVERGE ON (convergent abduction = confidence).
     Roots are a compact motivational taxonomy (status/belonging/competence/security/autonomy/meaning).

EMAIL ONLY (channel='gmail'). The abduction is ONE LLM pass over the triaged observations — efficient.

  doppler run -- /…/python3 whytree.py            # triage + abduce → the why-tree
  /…/python3 whytree.py --triage                   # just the deterministic signal triage (no LLM)
"""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore
import flib

SUB = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
ROOTS = ["status/recognition", "belonging/connection", "competence/mastery", "security/safety",
         "autonomy/freedom", "meaning/purpose"]


def sub():
    return sqlite3.connect(SUB, uri=True)


# ---------- 1. TRIAGE: who's sending what → keep signal, drop the pre-select noise (deterministic) ----------
IDENTITY_KW = ("founder", "startup", "venture", "ycombinator", "y combinator", "indie", "build", "lenny",
               "substack", "first round", "a16z", "research", "arxiv", "ml", "ai ")


def triage(c, limit=40):
    """Score senders via email_features.sender_type (the reliable signal) + open-rate. Keep the SIGNAL slice;
    drop promotional/bot/social_notification noise (the pre-selects) — the 'don't ingest everything'."""
    out = {"TRANSACTIONAL": [], "ENGAGED": [], "ASPIRATIONAL": [], "PERSONAL": [], "_noise": 0}
    # PERSONAL = real humans (sender_type='human'), by name
    for nm, n in c.execute(
        "SELECT p.display_name, count(*) n FROM communications cm JOIN persons p ON cm.from_person_id=p.id "
        "JOIN email_features ef ON ef.comm_id=cm.id WHERE cm.channel='gmail' AND cm.direction='received' "
        "AND ef.sender_type='human' AND p.is_self=0 AND p.display_name IS NOT NULL GROUP BY p.id "
        "ORDER BY n DESC LIMIT ?", (limit,)).fetchall():
        if not flib.is_bot(nm):
            out["PERSONAL"].append((nm, n, None))
    # dominant non-human sender_type per domain
    dt = {}
    for d, t, n in c.execute("SELECT sender_domain, sender_type, count(*) FROM email_features "
                             "WHERE sender_domain IS NOT NULL AND sender_type!='human' GROUP BY sender_domain, sender_type"):
        if d not in dt or n > dt[d][1]:
            dt[d] = (t, n)
    for sd, name, recv, opened in c.execute(
        "SELECT sender_domain, sender_name, total_received, total_opened FROM subscriptions WHERE total_received>=10"):
        nm = name or sd
        rate = (opened or 0) / recv if recv else 0
        t = dt.get(sd, ("?", 0))[0]
        if t in ("receipt", "transactional"):
            out["TRANSACTIONAL"].append((nm, recv, rate))
        elif rate >= 0.30:
            out["ENGAGED"].append((nm, recv, rate))
        elif recv >= 30 and rate < 0.06 and (t in ("newsletter", "institutional") or any(k in nm.lower() for k in IDENTITY_KW)):
            out["ASPIRATIONAL"].append((nm, recv, rate))             # the WISH: signed up, never reads
        else:
            out["_noise"] += 1
    for k in ("TRANSACTIONAL", "ENGAGED", "ASPIRATIONAL", "PERSONAL"):
        out[k].sort(key=lambda x: -x[1])
        out[k] = out[k][:limit]
    return out


def observations(c):
    """The leaves of the tree: triaged signal + the highest-salience existing claims (email-derived facts)."""
    tri = triage(c)
    obs = []
    for nm, recv, rate in tri["TRANSACTIONAL"][:15]:
        obs.append(f"[does, recurring] transacts with {nm}")
    for nm, recv, rate in tri["ENGAGED"][:12]:
        obs.append(f"[reads/cares] actually engages {nm} (opens {rate:.0%})")
    for nm, recv, rate in tri["ASPIRATIONAL"][:12]:
        obs.append(f"[WISH: subscribed but ignores, opens {rate:.0%}] {nm}")
    for nm, recv, rate in tri["PERSONAL"][:12]:
        obs.append(f"[real human he writes back to] {nm}")
    # high-salience email-derived claims (exclude iMessage-only forensic by keeping fact/value/identity)
    conn = claimstore.connect()
    for stmt, in conn.execute(
        "SELECT statement FROM claims WHERE COALESCE(status,'active')!='retired' AND salience IS NOT NULL "
        "AND type IN ('value','identity','preference','possession','routine') ORDER BY salience DESC LIMIT 30"):
        obs.append(f"[known] {stmt}")
    return tri, obs


# ---------- 2. RECURSIVE ABDUCTION: observations → why → why → root, convergence = confidence ----------
ABDUCE_SYS = f"""You are Sherlock Holmes building a WHY-TREE of a person from grounded EMAIL observations.

Method: for each observation ask WHY he does/wants it → the proximate goal → the deeper goal → recurse until
you reach a ROOT DRIVE from this taxonomy: {', '.join(ROOTS)}. (Mid-tree nodes like "wants to be respected"
or "wants to seem smart" sit between behaviors and roots — surface them.)

THE KEY: the person's CORE DRIVER is the root that the MOST independent observation-branches converge on.
Convergence = confidence. A root reached by 1 branch is weak; by 8 branches is near-certain.

Be BOLD in the abduction (reach for the real why he wouldn't say out loud) but every link must be a plausible
inference, and flag weak/speculative links. Honor RECEIVING≠DOING: a [WISH] observation reveals aspiration/
identity, NOT a habit. Return ONLY JSON:
{{"roots":[{{"root","convergence":int,"confidence":0-1,"paths":["observation → why → why → root", ...]}}],
"core_driver":"the deepest one-sentence read of what fundamentally drives him, and the chain to it",
"surprises":"the boldest well-grounded deduction he wouldn't admit"}}"""


async def abduce(obs):
    from anthro import make_client
    client = make_client()
    r = await client.messages.create(
        model="claude-sonnet-4-6", system=ABDUCE_SYS, max_tokens=2500,
        messages=[{"role": "user", "content": "OBSERVATIONS (email-only, triaged to signal):\n" + "\n".join(f"- {o}" for o in obs)}])
    txt = "".join(b.text for b in r.content if b.type == "text")
    import re
    m = re.search(r"\{.*\}", txt, re.S)
    return json.loads(m.group(0)) if m else {}


def main():
    c = sub()
    tri, obs = observations(c)
    print(f"=== TRIAGE (signal kept, {tri['_noise']} noise senders dropped) ===")
    for k in ("TRANSACTIONAL", "ENGAGED", "ASPIRATIONAL", "PERSONAL"):
        print(f"  {k} ({len(tri[k])}): " + ", ".join(n for n, _, _ in tri[k][:6]))
    print(f"\n→ {len(obs)} signal observations feed the why-tree\n")
    if "--triage" in sys.argv:
        return
    import asyncio
    tree = asyncio.run(abduce(obs))
    print("=== WHY-TREE (roots ranked by branch-convergence) ===")
    for r in sorted(tree.get("roots", []), key=lambda x: -x.get("convergence", 0)):
        print(f"\n  ▸ {r['root'].upper()}  (converge={r.get('convergence')}, conf={r.get('confidence')})")
        for p in r.get("paths", [])[:5]:
            print(f"      {p}")
    print(f"\n  CORE DRIVER: {tree.get('core_driver','')}")
    print(f"  SURPRISE:    {tree.get('surprises','')}")


if __name__ == "__main__":
    main()
