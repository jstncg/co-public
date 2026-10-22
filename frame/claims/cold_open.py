#!/usr/bin/env python3
"""Cold open — the make-or-break "see you" read (V0_BUILD_BRIEF §4).

Replaces firstcontact.py's spook (which narrativized from noise — the "abandoned Chase" / "stopped reading
your inbox" failures: one inferred, one a log). Whiff-proof by construction:

  1. DISCOVER — read the forensic deterministic claims already computed into the belief graph (observed
     behavior, earned confidence, no LLM). For a fresh tenant, run forensic.py live first.
  2. SELECT   — the single warmest, most specific, OBSERVED dimension read (how they love / prioritize / show
     up), not a log and not a negative. Reject "you've drifted from X", dead subscriptions, schedule logs.
  3. PHRASE   — one LLM call turns the chosen read into a witty, held-as-a-guess text. It may NOT add claims;
     it only rephrases the grounded fact.
  4. VALIDATE — the grounded anchor (the person's name) must survive into the output, or it's a whiff →
     retry once → graceful fallback that fakes nothing.

  doppler run -- /…/python3 cold_open.py [claims.db]      # prints candidates + chosen opener (the gate)
"""
import asyncio
import json
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

DEFAULT_DB = str(Path(__file__).resolve().parent / "claims.db")

# read.type → warmth weight (identity + relationship = "how you love" = the gold; routine/preference = log).
TYPE_W = {"identity": 1.0, "relationship": 0.95, "routine": 0.35, "preference": 0.25}
# never OPEN with a negative/accusatory/lurking read — "seen", never "watched & judged".
NEGATIVE = re.compile(r"\b(cool(ed|ing)|dropped|ignores?|dead|lurk|drift|respond rather than|quiet|sleep)\b", re.I)
# the warmest, most inexplicable dimensions get a bonus.
WARM_BONUS = re.compile(r"(endearment|code-switch|reach out|initiat|priority contact|intensif|closest|most-contacted)", re.I)
_STOP = {"Replies", "Uses", "Code", "Usually", "Most", "Messaging", "Active", "Relationship", "Closest",
         "Exchanges", "Frequent", "Receives", "Actually"}


def _names(stmt: str):
    """Grounded anchor tokens the phrasing must preserve (proper names + un-paraphrasable nouns like 'Korean').
    Stops at hyphens/spaces so 'Korean-heritage' yields the validatable 'Korean'."""
    toks = re.findall(r"\b[A-Z][a-zà-ÿ'’]+\b", stmt)
    return [t for t in toks if t not in _STOP and len(t) > 1]


def discover(claims_db: str):
    """The forensic deterministic reads already in the graph (the 'compute, don't guess' signal)."""
    c = sqlite3.connect(f"file:{claims_db}?mode=ro", uri=True)
    try:
        rows = c.execute(
            "SELECT statement, type, confidence, evidence FROM claims "
            "WHERE evidence LIKE '%\"source\": \"forensic\"%' AND COALESCE(status,'active')!='retired' "
            "AND level IN ('fact','pattern')").fetchall()
    except sqlite3.OperationalError:
        rows = []
    c.close()
    return [{"statement": s, "type": t or "preference", "confidence": cf or 0.5, "evidence": ev} for s, t, cf, ev in rows]


def _score(r):
    s = TYPE_W.get(r["type"], 0.3) * float(r["confidence"])
    if NEGATIVE.search(r["statement"]):
        s -= 2.0                       # disqualify negatives for an opener
    if not _names(r["statement"]):
        s -= 0.6                       # an opener needs a specific person
    if WARM_BONUS.search(r["statement"]):
        s += 0.25
    return s


def select(candidates):
    ranked = sorted(candidates, key=_score, reverse=True)
    best = ranked[0] if ranked else None
    if best is None or _score(best) <= 0:
        return None, ranked
    return best, ranked


PHRASE_SYS = """You are texting someone for the very FIRST time. You quietly looked through their messages and
noticed ONE true thing about them (below). Turn it into ONE short text — warm, a little witty, the kind a
perceptive friend sends, held lightly as a guess so it survives being slightly off.

HARD RULES (this is the first impression; creepy-or-wrong = instant churn):
- Keep the grounded specific (the person's NAME and the behavior). Do NOT add ANY new claim, inference,
  psychology, motive, or judgment. Only rephrase what you're given.
- Warm and on their side. NEVER accusatory, never "you neglect/ignore X". It must land as "it sees me," not
  "it's watching me."
- Plain text, casual is good, no markdown, 1–2 sentences. End a touch open (…or am i off?).
Return ONLY JSON: {"text":"<the message>"}"""


async def phrase(read, client):
    payload = {"the_true_thing": read["statement"], "grounding": read.get("evidence", "")}
    r = await client.messages.create(model="claude-haiku-4-5", system=PHRASE_SYS, max_tokens=200,
                                     messages=[{"role": "user", "content": json.dumps(payload)}])
    txt = "".join(b.text for b in r.content if b.type == "text")
    m = re.search(r"\{.*\}", txt, re.S)
    try:
        return (json.loads(m.group(0)).get("text", "") if m else "").strip()
    except (json.JSONDecodeError, AttributeError):
        return ""


FALLBACK = ("ok i went poking around to find the one thing that'd make you go 'how'd it know that' — and "
            "honestly you're harder to read than most, which is its own kind of interesting. so: what's "
            "actually been on your mind this week?")


def _validate(text, read):
    """Whiff-proof: a non-empty line that preserves at least one grounded name from the chosen read."""
    if not text or len(text) > 600:
        return False
    names = _names(read["statement"])
    return (not names) or any(n.lower() in text.lower() for n in names)


async def cold_open(claims_db: str = DEFAULT_DB, verbose: bool = False):
    cands = discover(claims_db)
    best, ranked = select(cands)
    if verbose:
        print(f"\n=== {len(cands)} forensic candidates, top 8 by warmth·specificity·confidence ===")
        for r in ranked[:8]:
            print(f"  [{_score(r):+.2f}] ({r['type']}) {r['statement']}")
        print(f"\n--- chosen ---\n  {best['statement'] if best else '(none cleared the bar)'}\n")
    if not best:
        return FALLBACK
    from anthro import make_client
    client = make_client()
    for _ in range(2):
        try:
            text = await phrase(best, client)
        except Exception as e:
            if verbose:
                print(f"  (phrase LLM error: {e})")
            text = ""
        if _validate(text, best):
            return text
    return FALLBACK


def _sendblue_send(to_number: str, content: str) -> bool:
    """Send the first 'seeing' text via Sendblue. Creds from env (Doppler) — never hardcoded."""
    import os
    import rail
    ok, why = rail.send(to_number, content)
    print(f"  {'✅ sent to ' + to_number if ok else '⚠️ held: ' + why}")
    return ok


def main():
    args = sys.argv[1:]
    db = next((a for a in args if not a.startswith("-")), DEFAULT_DB)
    to = args[args.index("--send") + 1] if "--send" in args else None
    msg = asyncio.run(cold_open(db, verbose=True))
    print("🔮 COLD OPEN (the first text a stranger would get):\n")
    print(f"   {msg}\n")
    if to:
        _sendblue_send(to, msg)


if __name__ == "__main__":
    main()
