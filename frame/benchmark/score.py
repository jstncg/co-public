#!/usr/bin/env python3
"""Score the graded benchmark → the headline: accuracy vs inferability.

Parses the graded results sheet (the [grade: X] fields the subject filled in), computes accuracy per
inferability level, and prints the curve. The shape — where accuracy falls off as questions get more
inferable — IS the result. n/a grades (genuinely unknowable from email) are excluded.

  python3 score.py [results-YYYY-MM-DD.md]
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent


def latest_sheet():
    sheets = sorted(HERE.glob("results-*.md"))
    return sheets[-1] if sheets else None


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else latest_sheet()
    if not path or not path.exists():
        print("no results sheet found — run run_benchmark.py first")
        return
    text = path.read_text()

    # walk level headers + grades in order
    level = None
    per = defaultdict(lambda: {"graded": 0, "score": 0.0, "na": 0, "ungraded": 0})
    for line in text.splitlines():
        m = re.match(r"##\s+(L[1-5])\b", line)
        if m:
            level = m.group(1)
            continue
        g = re.search(r"\[grade:\s*([0-9.]+|n/a)?\s*\]", line)
        if g and level:
            raw = (g.group(1) or "").strip()
            if raw == "n/a":
                per[level]["na"] += 1
            elif raw in ("0", "0.0", "0.5", "1", "1.0"):
                per[level]["graded"] += 1
                per[level]["score"] += float(raw)
            else:
                per[level]["ungraded"] += 1

    names = {"L1": "RETRIEVAL", "L2": "AGGREGATION", "L3": "PATTERN", "L4": "INFERENCE", "L5": "FRAME"}
    print(f"=== Understanding Benchmark — accuracy vs inferability ===\n   ({path.name})\n")
    tot_g = tot_s = 0
    any_ungraded = 0
    for lvl in ["L1", "L2", "L3", "L4", "L5"]:
        d = per[lvl]
        any_ungraded += d["ungraded"]
        if d["graded"] == 0:
            print(f"  {lvl} {names[lvl]:12}  — (ungraded: {d['ungraded']}, n/a: {d['na']})")
            continue
        acc = d["score"] / d["graded"]
        bar = "█" * round(acc * 20)
        print(f"  {lvl} {names[lvl]:12} {acc*100:5.0f}%  {bar}  ({d['score']:.1f}/{d['graded']}"
              + (f", n/a {d['na']}" if d['na'] else "") + ")")
        tot_g += d["graded"]
        tot_s += d["score"]
    if tot_g:
        print(f"\n  OVERALL {tot_s/tot_g*100:.0f}%  ({tot_s:.1f}/{tot_g})")
    if any_ungraded:
        print(f"\n  ⚠️ {any_ungraded} answers still ungraded — fill the [grade: ] fields for a complete curve.")
    print("\n  The shape is the result: where does accuracy fall off as inferability rises?")


if __name__ == "__main__":
    main()
