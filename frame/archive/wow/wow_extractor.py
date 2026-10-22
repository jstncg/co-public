#!/usr/bin/env python3
"""
WOW EXTRACTOR — recreate the Poke "how did it know that?" moment.

Different objective function from the rest of Substrate:
  - regret engine optimizes ACTIONABLE
  - gmail profile optimizes COMPLETE / CURRENT
  - this optimizes SURPRISE — improbable-to-know-but-verifiably-true.

The magic Poke pulled ("smoke grey amber lamp shades", a 2nd-place inland-empire
robotics finish) is PERPLEXITY: the gap between "I just connected my inbox" and "it
knows a buried, specific, private detail about me." The wow is unexplainable accuracy.

Ranking principle: INBOX-ONLYNESS. A fact you could Google (employer, school) is a
parlor trick. A fact only your inbox knows (an exact purchase, a forgotten membership)
is magic — there's no other explanation for how it knew.

Hard rule: TRUTH ONLY. Every fact cites a source email. One hallucinated "fact" inverts
the magic into "this thing is guessing about me." Better to surface 3 true than 5 shaky.

SANDBOXED: read-only on substrate.db (mode=ro). Writes nothing to the engine.

Usage: python3 wow_extractor.py [--candidates 120] [--top 5]
"""

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

# import only the model caller from the substrate lib (no engine writes)
sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from llm import complete  # noqa: E402

DB_RO = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
MODEL = "claude-sonnet-4-6"


def from_email(raw):
    m = re.search(r'"from_email"\s*:\s*"([^"]*)"', raw or "")
    return (m.group(1) if m else "").lower()


def is_bulk(addr):
    return bool(re.search(r"(no[-_.]?reply|newsletter|marketing|promo|notifications?@|mailer|deals@|email\.|mail\.|e\.|em\.)", addr))


def harvest(conn, cap):
    """Deterministic candidate harvest across high-wow buckets. Diversity over volume."""
    buckets = {
        # purchases/receipts — the private-specific gold (lamp-shade class)
        "purchase": """(subject LIKE '%order%' OR subject LIKE '%receipt%' OR subject LIKE '%your purchase%'
                        OR subject LIKE '%shipped%' OR subject LIKE '%confirmation%')
                       AND body LIKE '%$%'""",
        # identity: school / club / team / church / org / membership
        "identity": """(body LIKE '%club%' OR body LIKE '%team%' OR body LIKE '%church%' OR body LIKE '%chapter%'
                        OR body LIKE '%membership%' OR body LIKE '%competition%' OR body LIKE '%tournament%'
                        OR subject LIKE '%congratulations%' OR body LIKE '%volunteer%' OR body LIKE '%fellowship%')""",
        # tickets / events actually attended
        "event": "(body LIKE '%lu.ma%' OR body LIKE '%eventbrite%' OR subject LIKE '%ticket%' OR subject LIKE '%you''re going%' OR subject LIKE '%RSVP%')",
        # old personal one-offs (buried = surprising)
        "buried": "ts < '2021-01-01'",
    }
    seen, out = set(), []
    per = max(cap // len(buckets), 10)
    for name, where in buckets.items():
        rows = conn.execute(
            f"""SELECT id, ts, raw_metadata, subject, substr(body,1,900)
                FROM communications
                WHERE channel='gmail' AND direction='received'
                  AND body IS NOT NULL AND length(body) > 40
                  AND ({where})
                ORDER BY RANDOM() LIMIT ?""",
            (per * 3,),
        ).fetchall()
        kept = 0
        for cid, ts, raw, subj, body in rows:
            if cid in seen:
                continue
            addr = from_email(raw)
            # for identity/buried we tolerate some bulk; for purchase the sender often IS a store, keep it
            if name == "identity" and is_bulk(addr) and "congratulation" not in (subj or "").lower():
                continue
            seen.add(cid)
            out.append({"id": cid, "ts": ts, "from": addr, "subject": subj or "", "body": (body or "").strip(), "bucket": name})
            kept += 1
            if kept >= per:
                break
    return out


EXTRACT_SYS = """You mine emails for WOW FACTS about the inbox owner — specific, true, buried
details that would make them say "wait, how did you know that?"

For each email, extract AT MOST one wow-fact ABOUT THE OWNER (not the sender, not generic).
A wow-fact is concrete and personal: an exact thing they bought, a club/team/competition they
were in, an event they attended, an organization or community they belong to, a specific place,
a named achievement. NOT generic ("likes shopping"), NOT about the company emailing them.

Return a JSON list (same order, skip emails with no wow-fact) of objects:
  id: int (the email id)
  fact: the specific fact, <16 words, stated as a known truth about the owner
  category: purchase | membership | achievement | event | place | relationship | other
  inbox_onlyness: 1-5 — could you learn this by Googling the person?
     5 = no way (a specific Amazon purchase, a private receipt)
     1 = trivially Googleable (their employer, their university)
  specificity: 1-5 (named exact thing = 5; vague category = 1)
  surprise: 1-5 (buried/old/niche/forgotten = 5; obvious/recent = 1)
  evidence: <12 words quoting/paraphrasing the email proof

Be strict and TRUTHFUL. If the email doesn't clearly state a personal fact, skip it.
Return ONLY the JSON list."""


def extract(cands, batch=10):
    facts = []
    for i in range(0, len(cands), batch):
        chunk = cands[i:i + batch]
        payload = "\n\n".join(
            f"[id={c['id']}] from {c['from']} | {c['ts'][:10]}\nSUBJ: {c['subject']}\nBODY: {c['body'][:550]}"
            for c in chunk
        )
        res = complete(model=MODEL, system=EXTRACT_SYS, user=payload, max_tokens=1500)
        m = re.search(r"\[.*\]", res["text"], re.S)
        if not m:
            continue
        try:
            facts.extend(json.loads(m.group(0)))
        except json.JSONDecodeError:
            pass
    return facts


POLISH_SYS = """You are the onboarding moment of a personal AI. You are given the user's top WOW FACTS,
each verified from their own inbox. Write the FIRST message the user sees — the "how did you know that?"
cold open. It should feel like being seen, not surveilled: specific, warm, a little playful, never a flex.

Open with one line that lands the perplexity, then reflect 3-4 of the facts naturally (not a bulleted
list — woven, like a person who's been paying attention). End with a light line that hands control back
to them. Under 90 words. No emoji. This is the GPT-3 moment — make them feel it."""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", type=int, default=120)
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()

    conn = sqlite3.connect(DB_RO, uri=True)
    cands = harvest(conn, args.candidates)
    by_id = {c["id"]: c for c in cands}
    counts = defaultdict(int)
    for c in cands:
        counts[c["bucket"]] += 1
    print(f"harvested {len(cands)} candidates across buckets {dict(counts)}\n")

    facts = extract(cands)
    scored = []
    for f in facts:
        io = f.get("inbox_onlyness", 1) or 1
        sp = f.get("specificity", 1) or 1
        su = f.get("surprise", 1) or 1
        # wow leans hardest on inbox-onlyness (the "no other explanation" axis), then specificity, then surprise
        wow = io * 2.0 + sp * 1.3 + su * 1.0
        scored.append((wow, f))
    scored.sort(key=lambda x: -x[0])

    print("=" * 64)
    print("TOP WOW FACTS (ranked by improbable-to-know-but-true):")
    print("=" * 64)
    top = scored[:args.top]
    for wow, f in top:
        c = by_id.get(f["id"], {})
        print(f"  [{wow:4.1f}] ({f.get('category','?')}, inbox-only {f.get('inbox_onlyness')}/5) {f.get('fact','')}")
        print(f"         evidence: {f.get('evidence','')}  | src: {c.get('from','?')} {c.get('ts','')[:10]}")
    if not top:
        print("  (no facts cleared the bar — harvest buckets may need tuning)")
        return

    # write the cold-open
    fact_lines = "\n".join(f"- {f.get('fact')} (evidence: {f.get('evidence')})" for _, f in top)
    res = complete(model=MODEL, system=POLISH_SYS, user=f"Top verified wow-facts:\n{fact_lines}", max_tokens=400)
    print("\n" + "=" * 64)
    print("THE COLD OPEN (first message the user would see):")
    print("=" * 64)
    print(res["text"].strip())


if __name__ == "__main__":
    main()
