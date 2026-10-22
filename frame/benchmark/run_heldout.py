#!/usr/bin/env python3
"""Run the system COLD on the held-out questions (E10 recalibration).

Reads the held-out questions from groundtruth_heldout.md (the NEVER-INGESTED set), answers each STRICTLY
from the belief graph (post-gate, post-E6 recall-bias), and writes a gradeable sheet. The system MUST say
INSUFFICIENT when the graph doesn't support an answer — on the deep held-out questions (decisions,
self-deceptions) honest abstention is the correct, calibrated behavior; confabulating is the failure.

  doppler run -- /…/python3 run_heldout.py
Then: grade_vs_truth.py <sheet> --truth groundtruth_heldout.md ; calibrate.py <sheet>
"""
import asyncio
import datetime as dt
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "claims"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
import claimstore
from donna_warm import make_client
from run_benchmark import answer as _answer, SYS, MODEL  # the exact same answering contract (both gates inside)

HERE = Path(__file__).resolve().parent
GT = HERE / "groundtruth_heldout.md"
OUT = HERE / f"results_heldout-{dt.date.today().isoformat()}.md"


def questions():
    """[(hnum, question)] from the **HN. ...?** headers in the held-out file."""
    out = []
    for line in GT.read_text().splitlines():
        m = re.match(r"\*\*H(\d+)\.\s*(.+?)\*\*", line)
        if m:
            out.append((int(m.group(1)), m.group(2).strip()))
    return out


async def main():
    conn = claimstore.connect()
    client = make_client()
    qs = questions()
    sem = asyncio.Semaphore(5)

    async def do(h, q):
        async with sem:
            claims, meta = claimstore.recall_semantic(conn, q, limit=12, return_meta=True)
            try:
                ans = await _answer(client, q, claims, meta)  # synth_calib + E4 gates inside
            except Exception as e:
                ans = f"(error: {e})"
            return h, q, ans

    res = sorted(await asyncio.gather(*[do(h, q) for h, q in qs]))
    insuf = sum(1 for _, _, a in res if a.upper().startswith("INSUFFICIENT"))
    lines = [f"# Held-out results — {dt.date.today().isoformat()}", "",
             f"System answered {len(res)} held-out (never-ingested) questions cold. "
             f"{len(res)-insuf} attempted, {insuf} INSUFFICIENT (honest abstention = correct on the unguessable).", "",
             "## HELD-OUT", ""]
    for h, q, a in res:
        lines += [f"**H{h} :** {q}", f"> {a}", "`[grade: ]`", ""]
    OUT.write_text("\n".join(lines))
    print(f"📋 {OUT.name} — {len(res)} answered, {insuf} INSUFFICIENT")
    for h, q, a in res:
        print(f"  H{h:2}: {a[:90]}")


if __name__ == "__main__":
    asyncio.run(main())
