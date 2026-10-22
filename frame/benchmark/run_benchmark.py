#!/usr/bin/env python3
"""Run the Understanding Benchmark — the system answers each question FROM ITS BELIEF GRAPH ONLY.

What we're testing: did the substrate capture enough to answer, across the inferability gradient? The
system retrieves relevant claims (semantic recall) and synthesizes an answer grounded ONLY in them — it
MUST say INSUFFICIENT when the graph doesn't support an answer (an honest non-answer is calibration signal,
not a wrong answer; confabulating is the failure). Produces a gradeable sheet → subject grades truth.

  doppler run -- /…/python3 run_benchmark.py
"""
import asyncio
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "claims"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
import claimstore
from donna_warm import make_client
from battery import QUESTIONS

MODEL = "claude-sonnet-4-6"
OUT = Path(__file__).resolve().parent / f"results-{dt.date.today().isoformat()}.md"

SYS = """You answer ONE question about a person, grounded STRICTLY in the belief-claims provided (built from
their email). The claims are NUMBERED and tagged with their evidence level (fact/pattern/frame). Rules:
- Use ONLY the claims. Do NOT use outside knowledge or guess.
- If the claims don't support a real answer, reply exactly: INSUFFICIENT — and nothing else. An honest
  "I don't know" is correct behavior, never confabulate.
- For frame/inference questions, you MAY synthesize across claims, but every part must trace to a claim.
- Answer in 1-3 tight sentences. End with the claim numbers you actually relied on as [used: N,N] and a
  confidence 0-1 as [conf: X].
Return just the answer line(s) + the [used: ...] [conf: X] tags."""


async def answer(client, q, claims_txt, meta=None):
    r = await client.messages.create(
        model=MODEL, system=SYS, max_tokens=300,
        messages=[{"role": "user", "content": f"QUESTION: {q}\n\nBELIEF CLAIMS:\n{claims_txt}"}])
    raw = "".join(b.text for b in r.content if b.type == "text").strip()
    try:
        # Gate 1 (structural, synth_calib): confidence bounded by the evidence LEVEL of the cited
        # claims — frame-only support never asserts. Gate 2 (E4): isotonic remap + an ASYMMETRIC
        # abstention bar — strict on frame-grounded (confident-wrong interior = fatal), permissive
        # on fact/pattern-grounded (tentative behavioral coverage = the utility).
        from synth_calib import apply_synth_calibration, best_level, TAU_BY_LEVEL
        from calibration_map import apply_abstention
        gated = apply_synth_calibration(raw, meta or [])
        return apply_abstention(gated, tau=TAU_BY_LEVEL.get(best_level(raw, meta or [])))
    except Exception:
        return raw


async def main():
    conn = claimstore.connect()
    client = make_client()

    async def do(item):
        qid, level, dim, q = item
        claims, meta = claimstore.recall_semantic(conn, q, limit=12, return_meta=True)
        ans = await answer(client, q, claims, meta)
        return {"id": qid, "level": level, "dim": dim, "q": q, "answer": ans}

    sem = asyncio.Semaphore(6)

    async def guarded(item):
        async with sem:
            try:
                return await do(item)
            except Exception as e:
                return {"id": item[0], "level": item[1], "dim": item[2], "q": item[3], "answer": f"(error: {e})"}

    results = await asyncio.gather(*[guarded(it) for it in QUESTIONS])
    results.sort(key=lambda r: (r["level"], r["id"]))

    insufficient = sum(1 for r in results if r["answer"].upper().startswith("INSUFFICIENT"))
    lines = [f"# Understanding Benchmark — {dt.date.today().isoformat()}",
             "",
             f"System answered {len(results)} questions from its belief graph. "
             f"{len(results)-insufficient} attempted, {insufficient} INSUFFICIENT.",
             "",
             "## HOW TO GRADE",
             "For each answer, replace `[grade: ]` with **1** (correct), **0.5** (partial/vague-but-right-direction), "
             "or **0** (wrong / confabulated). Grade INSUFFICIENT as **0** (missed) only if the answer IS knowable "
             "about you — if it's genuinely unknowable from email, mark `[grade: n/a]` (excluded from scoring). "
             "Then run `score.py`.",
             ""]
    cur = None
    for r in results:
        if r["level"] != cur:
            cur = r["level"]
            names = {"L1": "RETRIEVAL", "L2": "AGGREGATION", "L3": "PATTERN", "L4": "INFERENCE", "L5": "FRAME (the moat)"}
            lines += ["", f"## {cur} — {names.get(cur,'')}", ""]
        lines.append(f"**Q{r['id']} ({r['dim']}):** {r['q']}")
        lines.append(f"> {r['answer']}")
        lines.append("`[grade: ]`")
        lines.append("")
    OUT.write_text("\n".join(lines))
    print(f"📋 benchmark sheet → {OUT}")
    print(f"   {len(results)} answered ({insufficient} INSUFFICIENT). Grade the [grade: ] fields, then run score.py.")
    # preview the L5 (moat) answers — the interesting ones
    print("\n=== L5 FRAME answers (the moat tier) ===")
    for r in results:
        if r["level"] == "L5":
            print(f"\nQ{r['id']}: {r['q']}\n  → {r['answer']}")


if __name__ == "__main__":
    asyncio.run(main())
