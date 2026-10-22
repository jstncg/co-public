#!/usr/bin/env python3
"""Salience scorer — confidence ≠ salience (UNDERSTANDING_AGENT.md P2).

The bug it fixes: the carried core ranked by CONFIDENCE, so "has a Krispy Kreme rewards account" (100%
confident, zero identity-weight) outranked a tentative pattern about who he actually is. Confidence answers
"how sure am I this is true." Salience answers "how much does this DEFINE them." They're orthogonal.

Deterministic, cheap, no LLM — computed over the graph each Conductor tick:

  salience = 0.35·type_weight + 0.30·level_weight + 0.20·corroboration + 0.15·recency

  type_weight   identity/value/frame > relationship/preference > routine/obligation > possession
  level_weight  pattern (cross-corpus synthesis) > frame (interpretive) > fact (single obs)
  corroboration log-scaled evidence count (one signal = weak, 20+ = strong)
  recency       actively expressed lately > stale (mild — a 2-yr-old value still defines you)

`graded` (the subject's verdict, ground truth) OVERRIDES the computed score: boost→pin near top,
keep→floor at relevant, demote→crush. The human is the authority on what defines them; this is the prior.

  doppler run -- /…/python3 salience.py          # recompute all · prints the new top of the carried core
"""
import datetime as dt
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore  # noqa: E402

TYPE_W = {
    "identity": 1.0, "value": 0.92, "frame": 0.72, "relationship": 0.58,
    "preference": 0.46, "trait": 0.66, "goal": 0.85, "routine": 0.30,
    "obligation": 0.30, "possession": 0.15, "other": 0.28,
}
LEVEL_W = {"pattern": 1.0, "frame": 0.85, "fact": 0.40}
GRADE_OVERRIDE = {"boost": lambda s: max(s, 0.93), "keep": lambda s: max(s, 0.70), "demote": lambda s: s * 0.35}


def _corroboration(evidence_json: str) -> float:
    try:
        n = len(json.loads(evidence_json))
    except (json.JSONDecodeError, TypeError):
        n = 1
    return min(1.0, math.log1p(n) / math.log1p(20))  # 1 sig→0.23, 5→0.60, 20→1.0


def _recency(last_verified: str, today_ord: int) -> float:
    try:
        age = today_ord - dt.date.fromisoformat(last_verified[:10]).toordinal()
    except (ValueError, TypeError):
        return 0.5
    if age <= 90:
        return 1.0
    return max(0.30, 1.0 - (age - 90) / 900)  # ~0.30 floor by ~2.7yr; values don't evaporate


def score(type_: str, level: str, evidence_json: str, last_verified: str, graded, today_ord: int) -> float:
    base = (0.35 * TYPE_W.get(type_, 0.28)
            + 0.30 * LEVEL_W.get(level, 0.40)
            + 0.20 * _corroboration(evidence_json)
            + 0.15 * _recency(last_verified, today_ord))
    base = round(min(1.0, base), 4)
    return round(GRADE_OVERRIDE[graded](base), 4) if graded in GRADE_OVERRIDE else base


# Doc-derived claims are not facts about the member. They are co's own product canon,
# ingested so it can be recalled — never ranked as "who is this person". Salience is the
# carried-core ranking, so scoring them is what put 17 of 20 resident lines on the
# founder's engineering spec (8/5).
#
# That day's fix filtered them at READ time in memory.ts, which left 2,720 canon rows
# sitting at salience up to 0.95 with one WHERE clause standing between them and the core.
# Any new reader that forgets the clause reinstates the bug. Fixed at the source instead:
# they are never scored, and any historical score is cleared.
CANON_EVIDENCE = '%"source": "canon"%'


def recompute(conn) -> int:
    today_ord = dt.date.today().toordinal()
    # clear anything a previous run scored before this law existed
    conn.execute("UPDATE claims SET salience=NULL WHERE salience IS NOT NULL "
                 "AND COALESCE(evidence,'') LIKE ?", (CANON_EVIDENCE,))
    rows = conn.execute(
        "SELECT id, type, level, evidence, last_verified, graded FROM claims "
        "WHERE COALESCE(status,'active')!='retired' "
        "AND COALESCE(evidence,'') NOT LIKE ?", (CANON_EVIDENCE,)).fetchall()
    for cid, type_, level, ev, lv, graded in rows:
        conn.execute("UPDATE claims SET salience=? WHERE id=?",
                     (score(type_, level, ev, lv, graded, today_ord), cid))
    conn.commit()
    return len(rows)


def top(conn, limit=20):
    return conn.execute(
        "SELECT salience, confidence, type, level, statement, graded FROM claims "
        "WHERE COALESCE(status,'active')!='retired' AND salience IS NOT NULL "
        "ORDER BY salience DESC LIMIT ?", (limit,)).fetchall()


if __name__ == "__main__":
    conn = claimstore.connect()
    n = recompute(conn)
    print(f"🎚️  recomputed salience for {n} active claims\n\ntop of the carried core (by salience, not confidence):")
    for sal, conf, t, lv, stmt, g in top(conn, 20):
        flag = f" ⟨{g}⟩" if g else ""
        print(f"  {sal:.2f} sal / {conf:.0%} conf  ({t}/{lv}){flag}  {stmt[:64]}")
