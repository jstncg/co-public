#!/usr/bin/env python3
"""E3 — evidence-grounded confidence (the source fix for calibration).

The held-out result proved the system is overconfident (ECE 0.349) because confidence was LLM VIBE — a number
the model emits, uncorrelated with whether it's right. The fix: confidence must be a deterministic FUNCTION OF
THE EVIDENCE (weak-supervision style — agreement of independent signals), not self-report. This recomputes
every active claim's confidence from features we can actually compute:

  corroboration   — how many independent evidence signals back it (log-scaled)
  source class    — subject-CONFIRMED / journal (authored self-disclosure) > forensic (deterministic/earned)
                    > email-extracted; the RECEIVING-gate already capped inbound at extraction
  subject verdict — graded boost/keep/demote OVERRIDES (the human is ground truth)
  level cap       — frame-level (interpretive) hard-capped ≤0.5
  recency         — stale beliefs decay toward uncertainty

Deterministic, no LLM. This is the prerequisite: you can't map/abstain (E2/E4) your way to calibration if the
underlying number is noise. Make it honest at the source first.

  doppler run -- /…/python3 calibrate_confidence.py [--dry]
"""
import datetime as dt
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore


def _corroboration(n: int) -> float:
    return min(1.0, math.log1p(n) / math.log1p(15))   # 1 sig→0.23, 5→0.60, 15+→1.0


def _recency(last_verified: str, today_ord: int) -> float:
    try:
        age = today_ord - dt.date.fromisoformat(last_verified[:10]).toordinal()
    except (ValueError, TypeError):
        return 1.0
    return 1.0 if age <= 180 else max(0.6, 1.0 - (age - 180) / 1460)   # mild; values don't evaporate


def evidence_confidence(ev_json, level, graded, last_verified, today_ord) -> float:
    try:
        ev = json.loads(ev_json) if isinstance(ev_json, str) else (ev_json or [])
    except (json.JSONDecodeError, TypeError):
        ev = []
    n = len(ev)
    sources = {e.get("source", "email") for e in ev if isinstance(e, dict)}
    corr = _corroboration(n)
    # Calibration is MATCHING, not lowering. A directly-evidenced FACT is reliable even at n=1 (one Amex
    # statement = he has Amex). A PATTERN needs repetition. A FRAME is interpretive. So confidence is keyed to
    # LEVEL (the kind of claim), with corroboration as a booster — not a crusher of single-but-definitive facts.
    if level == "fact":
        c = 0.72 + 0.25 * corr                               # directly evidenced → reliable; corroboration tops it up
    elif level == "pattern":
        c = 0.40 + 0.40 * corr                               # behavior-over-time → needs repetition to trust
    else:  # frame
        c = 0.30 + 0.20 * corr                               # interpretive
    if "subject-confirmed" in sources or "journal" in sources:
        c = max(c, 0.82)                                     # authored self-disclosure = strong
    if "forensic" in sources:
        c = max(c, 0.78)                                     # deterministic/computed = earned
    c *= _recency(last_verified, today_ord)
    if level == "frame":
        c = min(c, 0.50)                                     # interpretive — hard cap (the guardrail)
    # the subject's verdict is ground truth — it overrides the computed value
    if graded == "boost":
        c = max(c, 0.92)
    elif graded == "keep":
        c = max(c, 0.80)
    elif graded == "demote":
        c = min(c, 0.30)
    return round(min(0.97, max(0.05, c)), 3)


def main():
    dry = "--dry" in sys.argv
    conn = claimstore.connect()
    today_ord = dt.date.today().toordinal()
    rows = conn.execute("SELECT id, confidence, level, evidence, graded, last_verified FROM claims "
                        "WHERE COALESCE(status,'active')!='retired'").fetchall()
    moved_up = moved_down = 0
    deltas = []
    for cid, old, level, ev, graded, lv in rows:
        new = evidence_confidence(ev, level, graded, lv, today_ord)
        deltas.append(new - (old or 0))
        if new > (old or 0) + 0.02:
            moved_up += 1
        elif new < (old or 0) - 0.02:
            moved_down += 1
        if not dry:
            conn.execute("UPDATE claims SET confidence=? WHERE id=?", (new, cid))
    if not dry:
        conn.commit()
    import statistics
    print(f"{'[DRY] ' if dry else ''}E3 evidence-grounded confidence over {len(rows)} active claims")
    print(f"  ↑ raised {moved_up}   ↓ lowered {moved_down}   mean Δ {statistics.mean(deltas):+.3f}")
    print(f"  (lowered = vibe-overconfidence corrected; raised = corroborated/confirmed/forensic earned it)")
    # show the corrections at the extremes
    print("\n  biggest drops (overconfident vibe → honest):")
    for cid, old, level, ev, graded, lv in rows:
        new = evidence_confidence(ev, level, graded, lv, today_ord)
        if old and old - new > 0.3:
            stmt = conn.execute("SELECT statement FROM claims WHERE id=?", (cid,)).fetchone()[0]
            print(f"    {old:.0%}→{new:.0%}  {stmt[:62]}")
            if moved_down and cid % 7 == 0:
                break


if __name__ == "__main__":
    main()
