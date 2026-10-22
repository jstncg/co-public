#!/usr/bin/env python3
"""The cheap test: CAN coverage move? (no LLM generation — just embeddings)

For each held-out question with a known truth, ask two things of the belief graph:
  1. Is the true answer PRESENT at all?  (max cosine of the truth-answer to any active claim)
  2. Did recall on the QUESTION SURFACE it? (max cosine of the truth to what question-recall retrieved)

Three outcomes, and the mix is the answer:
  • SURFACED — truth present AND question-recall got it → the system HAD it, abstention/synthesis was too
    conservative (cheapest possible fix; coverage can move with zero new data).
  • GAP      — truth present but question-recall MISSED it → a retrieval problem (cheap fix; coverage can move).
  • ABSENT   — truth not in the graph → needs a new channel / elicitation (data-bound, not retrieval-bound).

(SURFACED+GAP)/total = the coverage CEILING reachable with better retrieval alone, no new data. If that's high,
coverage is not structurally stuck. If most is ABSENT, it's email-blindness and only new data moves it.

  doppler run -- /…/python3 coverage_test.py
"""
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "claims"))
import claimstore
import embed as E

GT = HERE / "groundtruth_heldout.md"
PRESENT = 0.50   # cosine bar for "this claim is about the same thing as the truth" (voyage-4-lite)


def items():
    out, h, q = [], None, None
    for line in GT.read_text().splitlines():
        m = re.match(r"\*\*H(\d+)\.\s*(.+?)\*\*", line)
        if m:
            h, q = int(m.group(1)), m.group(2).strip(); continue
        if h and line.startswith(">"):
            truth = line.lstrip("> ").strip()
            if truth and not truth.startswith("_(pending"):
                out.append((h, q, truth)); h = None
    return out


def main():
    conn = claimstore.connect()
    rows = conn.execute("SELECT statement, embedding FROM claims WHERE embedding IS NOT NULL "
                        "AND COALESCE(status,'active')!='retired' AND COALESCE(graded,'')!='demote'").fetchall()
    M = np.array([np.frombuffer(r[1], dtype=np.float32) for r in rows])
    M = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-9)
    its = items()
    qs = [q for _, q, _ in its]
    ts = [t for _, _, t in its]
    QE = np.array(E.voyage(qs, input_type="query"), dtype=np.float32)
    TE = np.array(E.voyage(ts, input_type="query"), dtype=np.float32)
    QE = QE / (np.linalg.norm(QE, axis=1, keepdims=True) + 1e-9)
    TE = TE / (np.linalg.norm(TE, axis=1, keepdims=True) + 1e-9)

    surfaced = gap = absent = 0
    print(f"{'H':>3}  present  surfaced  verdict   question")
    for k, (h, q, t) in enumerate(its):
        t_sims = M @ TE[k]
        q_top = (M @ QE[k]).argsort()[::-1][:12]      # what the QUESTION retrieves
        present = float(t_sims.max())                  # is the truth anywhere in the graph?
        surfaced_sim = float(t_sims[q_top].max())      # did question-recall pull a truth-relevant claim?
        if present < PRESENT:
            v = "ABSENT"; absent += 1
        elif surfaced_sim >= PRESENT:
            v = "SURFACED"; surfaced += 1
        else:
            v = "GAP"; gap += 1
        print(f"{('H'+str(h)):>3}   {present:.2f}     {surfaced_sim:.2f}    {v:8}  {q[:46]}")

    n = len(its)
    print(f"\n  SURFACED {surfaced}  ·  GAP {gap}  ·  ABSENT {absent}   (n={n})")
    print(f"  answer-in-graph ceiling (SURFACED+GAP) = {(surfaced+gap)/n*100:.0f}%  ← coverage reachable with better retrieval, NO new data")
    print(f"  retrieval headroom (GAP)               = {gap/n*100:.0f}%  ← cheap fix, coverage moves now")
    print(f"  data-bound (ABSENT)                    = {absent/n*100:.0f}%  ← needs new channel / elicitation")
    print("\n  verdict: " + (
        "coverage is RETRIEVAL-bound — it can move cheaply (fix recall/synthesis, no new data)."
        if (surfaced + gap) >= absent else
        "coverage is DATA-bound — email-blind; only new channels/elicitation move it."))


if __name__ == "__main__":
    main()
