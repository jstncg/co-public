#!/usr/bin/env python3
"""First contact — the cold-open wow, in SECONDS. The onboarding fix.

The user must NOT wait 30-60 min (full extraction) for the first text. The wow needs depth on a FEW
high-signal things, fast — not exhaustive extraction. Two speeds:
  • FIRST TEXT (this file): instant deterministic spook (pure SQL, no LLM, sub-second) + one fast LLM
    spook on a tiny pre-aggregated slice. First "how did you know that" in <10s.
  • FULL BELIEF GRAPH: extract_claims.py in the BACKGROUND after — makes LATER texts deep. Never blocks
    the first text.

  doppler run -- /…/substrate/.venv/bin/python3 firstcontact.py
"""
import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
DB = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"


def instant_deterministic():
    """Sub-second, no LLM. The spooky-but-exact metadata read — stopped-reading year + most-ignored sender."""
    c = sqlite3.connect(DB, uri=True)
    # read-rate by year (only need year + unread flag) — targeted, fast
    yr = defaultdict(lambda: [0, 0])  # [total, read]
    for ts, raw in c.execute("SELECT ts, raw_metadata FROM communications "
                             "WHERE channel='gmail' AND direction='received' AND ts IS NOT NULL"):
        y = ts[:4]
        yr[y][0] += 1
        if '"UNREAD"' not in (raw or ""):
            yr[y][1] += 1
    years = sorted(y for y in yr if yr[y][0] >= 50)
    rate = {y: yr[y][1] / yr[y][0] for y in years}
    collapse = next((y for i, y in enumerate(years)
                     if rate[y] < 0.4 and (i == 0 or rate[years[i-1]] >= 0.4)), None)
    line = None
    if collapse:
        peak = max(years, key=lambda y: rate[y])
        line = (f"you stopped keeping up with your inbox in {collapse}. went from basically reading "
                f"everything to ~{rate[years[-1]]*100:.0f}%. the inbox won that year and never gave it back.")
    return line


SPOOK_SYS = """Given two lists from someone's inbox — what they FAITHFULLY KEEP (paid/subscribed for years)
and what they START AND ABANDON — produce ONE spooky-specific observation: name the ACTUAL brands, a
juxtaposition that'd be FALSE for most people, undeniably true, zero psychology-jargon. Make them think
"how do you know that about me".

HARD RULE (this is the FIRST message — creepy-wrong = instant churn): state ONLY what the brands directly
show. NO interpretive leaps, NO "which means you're [X]", NO inferring income/secrets/motives/life-events.
Just the undeniable named-brand pattern itself. Stay on the side of "specific and true," never "presumptuous."

Return ONLY JSON: {"spook":"<2 sentences, named brands, no inference>"}"""


def fast_spook_payload():
    """Tiny pre-aggregated slice for one fast LLM call — not a full extraction."""
    c = sqlite3.connect(DB, uri=True)
    months, cancels = defaultdict(set), defaultdict(int)
    CANCEL = re.compile(r"(cancel|refund|return|won.t renew|sorry to see you go)", re.I)
    for ts, raw, subj in c.execute(
            "SELECT ts, raw_metadata, subject FROM communications WHERE channel='gmail' AND direction='received' "
            "AND ts > '2023-01' LIMIT 40000"):
        m = re.search(r'"from_email"\s*:\s*"([^"]*)"', raw or "")
        dom = (m.group(1) if m else "").split("@")[-1]
        if dom and not re.search(r"(google|gmail|apple|amazonses|facebook)", dom):
            months[dom].add(ts[:7])
            if CANCEL.search(f"{subj or ''}"):
                cancels[dom] += 1
    kept = sorted(((len(ms), d) for d, ms in months.items() if len(ms) >= 8), reverse=True)[:15]
    abandoned = sorted(cancels.items(), key=lambda x: -x[1])[:10]
    return {"faithfully_kept": [f"{d} ({n} months)" for n, d in kept],
            "abandoned": [f"{d} ({n})" for d, n in abandoned]}


def main():
    t0 = time.time()
    instant = instant_deterministic()
    t1 = time.time()
    print(f"⚡ INSTANT (deterministic, no LLM) — {t1-t0:.1f}s:")
    print(f"   {instant}\n")

    # one fast LLM spook on the tiny slice
    from donna_warm import make_client
    import asyncio
    payload = fast_spook_payload()
    t2 = time.time()

    async def spook():
        client = make_client()
        r = await client.messages.create(model="claude-haiku-4-5", system=SPOOK_SYS, max_tokens=300,
                                         messages=[{"role": "user", "content": json.dumps(payload)}])
        m = re.search(r"\{.*\}", "".join(b.text for b in r.content if b.type == "text"), re.S)
        return json.loads(m.group(0)).get("spook", "") if m else ""
    sp = asyncio.run(spook())
    t3 = time.time()
    print(f"🔮 SPOOK (1 LLM call) — slice {t2-t1:.1f}s + LLM {t3-t2:.1f}s:")
    print(f"   {sp}\n")
    print(f"=== first text ready in {t3-t0:.1f}s total (vs 30-60min full extraction) ===")


if __name__ == "__main__":
    main()
