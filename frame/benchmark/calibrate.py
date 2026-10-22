#!/usr/bin/env python3
"""Calibration scorer — the number that matters (UNDERSTANDING_AGENT.md P3).

Accuracy alone is the wrong target: a Nature result (2026) shows accuracy-based eval INCENTIVIZES
overconfident hallucination — a system that always guesses confidently scores fine on accuracy and is
useless as a witness. So we score CALIBRATION: when it says 80%, is it right ~80% of the time? And we
count the cardinal sin directly — confident-AND-wrong.

Reads the graded sheet ([conf: X] from the run + [grade: Y] from the subject):
  • accuracy by inferability level (the gradient curve)
  • ECE (expected calibration error) + a reliability table — the headline
  • overconfidence = mean(confidence − correctness): positive = the Nature failure mode
  • confident-wrong rate: fraction of conf≥0.7 answers graded 0 — the trust-killer, counted explicitly
  • honesty: did it abstain (INSUFFICIENT) on the unknowable instead of confabulating
  • (d)-rate: optional [d: a|b|c|d] impressiveness grade on L4/L5 — fraction against-the-room

  python3 calibrate.py [results-YYYY-MM-DD.md]
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUCKETS = [(0.0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)]


def latest():
    s = sorted(HERE.glob("results-*.md"))
    return s[-1] if s else None


def parse(text):
    """Walk the sheet → list of {level, conf, grade, insufficient, dgrade}. A record is closed at each
    `[grade: ]` line, pairing it with the most recent [conf:] and the question's INSUFFICIENT flag."""
    level, conf, insuf, dgrade = None, None, False, None
    recs = []
    for line in text.splitlines():
        m = re.match(r"##\s+(L[1-5])\b", line)
        if m:
            level = m.group(1); continue
        c = re.search(r"\[conf:\s*([0-9.]+)\s*\]", line)
        if c:
            conf = float(c.group(1))
        if re.search(r">\s*INSUFFICIENT", line, re.I) or re.match(r"\s*>\s*INSUFFICIENT", line, re.I):
            insuf = True
        dm = re.search(r"\[d:\s*([abcd])\s*\]", line)
        if dm:
            dgrade = dm.group(1)
        g = re.search(r"\[grade:\s*([0-9.]+|n/a)?\s*\]", line)
        if g:
            raw = (g.group(1) or "").strip()
            recs.append({"level": level or "NA", "conf": conf, "grade": raw, "insuf": insuf, "d": dgrade})
            conf, insuf, dgrade = None, False, None  # reset per answer
    return recs


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else latest()
    if not path or not path.exists():
        print("no results sheet — run run_benchmark.py first"); return
    recs = parse(path.read_text())
    graded = [r for r in recs if r["grade"] in ("0", "0.0", "0.5", "1", "1.0")]
    ungraded = [r for r in recs if r["grade"] == ""]
    na = [r for r in recs if r["grade"] == "n/a"]

    names = {"L1": "RETRIEVAL", "L2": "AGGREGATION", "L3": "PATTERN", "L4": "INFERENCE", "L5": "FRAME"}
    print(f"=== Calibration report — {path.name} ===")
    print(f"   {len(recs)} answers · {len(graded)} graded · {len(ungraded)} ungraded · {len(na)} n/a\n")
    if not graded:
        print("  nothing graded yet. Fill [grade: 0|0.5|1|n/a] (and optional [d: a|b|c|d] on L4/L5),")
        print("  or run `judge.py` to auto-grade the objective L1–L2 tier. Then re-run.")
        return

    # 1. accuracy gradient
    per = defaultdict(lambda: [0.0, 0])
    for r in graded:
        per[r["level"]][0] += float(r["grade"]); per[r["level"]][1] += 1
    print("  accuracy by inferability level (the gradient):")
    for lvl in ["L1", "L2", "L3", "L4", "L5"]:
        s, n = per[lvl]
        if n:
            acc = s / n
            print(f"    {lvl} {names[lvl]:11} {acc*100:4.0f}%  {'█'*round(acc*18)}  ({s:.1f}/{n})")
    ts = sum(p[0] for p in per.values()); tn = sum(p[1] for p in per.values())
    print(f"    {'OVERALL':16} {ts/tn*100:4.0f}%  ({ts:.1f}/{tn})\n")

    # 2. calibration — the headline
    paired = [(r["conf"], float(r["grade"])) for r in graded if r["conf"] is not None]
    if paired:
        ece, N = 0.0, len(paired)
        print("  calibration (when it says X%, is it right X%?):")
        print("    conf-bucket   n   avg-conf   accuracy   gap")
        for lo, hi in BUCKETS:
            b = [(c, g) for c, g in paired if lo <= c < hi]
            if not b:
                continue
            ac = sum(c for c, _ in b) / len(b)
            aa = sum(g for _, g in b) / len(b)
            ece += len(b) / N * abs(ac - aa)
            print(f"    {lo:.1f}–{hi if hi<=1 else 1.0:.1f}     {len(b):3}    {ac:.2f}      {aa:.2f}     {ac-aa:+.2f}")
        over = sum(c - g for c, g in paired) / N
        print(f"\n    ECE (expected calibration error) = {ece:.3f}   (lower = better; <0.1 is well-calibrated)")
        print(f"    overconfidence = {over:+.3f}   ({'overconfident' if over>0.05 else 'underconfident' if over<-0.05 else 'calibrated'})")
        cw = [(c, g) for c, g in paired if c >= 0.7 and g == 0]
        print(f"    CONFIDENT-WRONG (conf≥0.7, graded 0) = {len(cw)}/{N}  ← the cardinal sin (one destroys trust)")

    # 3. honesty
    insuf_graded = [r for r in graded if r["insuf"]]
    insuf_na = [r for r in na if r["insuf"]]
    print(f"\n  honesty: {len(insuf_na)} abstentions on the genuinely-unknowable (correct), "
          f"{sum(1 for r in insuf_graded if r['grade'] in ('0','0.0'))} INSUFFICIENT on knowable things (misses)")

    # 4. (d)-rate
    dgr = [r for r in graded if r["d"]]
    if dgr:
        d_ct = sum(1 for r in dgr if r["d"] == "d")
        print(f"\n  (d)-RATE: {d_ct}/{len(dgr)} against-the-room ({d_ct/len(dgr)*100:.0f}%)  ← the moat. "
              f"a=slop b=seen-it c=discovery d=against-the-room")
    else:
        print("\n  (d)-rate: no [d: ] grades yet — add [d: a|b|c|d] to L4/L5 answers to score the moat.")
    if ungraded:
        print(f"\n  ⚠️ {len(ungraded)} still ungraded.")


if __name__ == "__main__":
    main()
