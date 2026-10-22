#!/usr/bin/env python3
"""Grade the benchmark against the SUBJECT ORACLE — Dennis's verbatim answers (groundtruth.md).

This is the honest grader. judge.py graded L1-L2 against a corpus proxy (and couldn't touch the deep tier).
Now we have the real thing: Dennis's own answers. So we grade EVERY tier (facts AND frames) by comparing
the system's answer to what Dennis actually said. For the moat (L3-L5), this is the only valid ground truth
that exists — the subject is the oracle (see the "who's the judge" thread). An LLM judge here is legitimate
because it's not deciding truth, only measuring DISTANCE between the system's answer and the subject's.

  doppler run -- /…/python3 grade_vs_truth.py [results-YYYY-MM-DD.md]

Writes [grade: 1|0.5|0] into the fresh sheet for every question that has a ground-truth answer. Questions
with no ground truth yet (Q43-50, pending) are left blank.
"""
import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
from donna_warm import make_client

HERE = Path(__file__).resolve().parent
GT = HERE / "groundtruth.md"
MODEL = "claude-haiku-4-5-20251001"  # comparison task, not deep reasoning

JUDGE_SYS = (
    "You grade how well an AI system's answer about a person matches the PERSON'S OWN verbatim answer "
    "(the ground truth). The person's answer is authoritative — grade the system's distance from it.\n"
    "  1   — system's core claim matches the person's answer (right, even if worded differently)\n"
    "  0.5 — partially matches (some right, some wrong/missing, or vague-but-aligned)\n"
    "  0   — wrong, contradicts the person, or the system said INSUFFICIENT when the person gave a real answer\n"
    "Reply with exactly one token (1, 0.5, or 0) then a one-line reason. Be strict but fair: reward "
    "substance over wording; punish confident specifics the person didn't confirm."
)


def parse_truth(text):
    """{key: dennis_answer} keyed by Q<n>/H<n> — the `>` blockquote after each **Q/HN.** header."""
    out, key = {}, None
    for line in text.splitlines():
        m = re.match(r"\*\*([QH]\d+)\.", line)
        if m:
            key = m.group(1); continue
        if key and line.startswith(">"):
            ans = line.lstrip("> ").strip()
            if ans and not ans.startswith("_(pending"):
                out[key] = (out.get(key, "") + " " + ans).strip()
    return out


def parse_sheet(text):
    """[{key, q, ans, idx}] keyed by Q<n>/H<n> — matches the truth keys directly."""
    lines = text.splitlines()
    blocks, key, q, ans = [], None, None, None
    for i, line in enumerate(lines):
        qm = re.match(r"\*\*([QH]\d+).*?:\*\*\s*(.+)", line)
        if qm:
            key = qm.group(1); q = qm.group(2).strip(); ans = None
        if line.startswith(">"):
            ans = (ans + " " if ans else "") + line.lstrip("> ").strip()
        if re.match(r"`\[grade:\s*\]`", line.strip()):
            blocks.append({"key": key, "q": q, "ans": ans, "idx": i})
    return lines, blocks


async def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    truth_file = GT
    if "--truth" in sys.argv:
        truth_file = HERE / sys.argv[sys.argv.index("--truth") + 1]
    path = Path(args[0]) if args else sorted(HERE.glob("results-*.md"))[-1]
    truth = parse_truth(truth_file.read_text())
    lines, blocks = parse_sheet(path.read_text())
    targets = [b for b in blocks if b["key"] in truth]
    print(f"grading {len(targets)} answers in {path.name} vs {truth_file.name} ({len(truth)} truth answers)…")

    client = make_client()
    sem = asyncio.Semaphore(4)

    async def grade(b):
        gt = truth[b["key"]]
        async with sem:
            try:
                r = await client.messages.create(
                    model=MODEL, system=JUDGE_SYS, max_tokens=90,
                    messages=[{"role": "user", "content":
                        f"QUESTION: {b['q']}\n\nPERSON'S OWN ANSWER (ground truth): {gt}\n\nSYSTEM'S ANSWER: {b['ans']}"}])
                v = " ".join("".join(x.text for x in r.content if x.type == "text").split())
            except Exception as e:
                return b, None, f"(error: {e})"
        mt = re.match(r"(1\.0|1|0\.5|0)\b", v)
        return b, (mt.group(1) if mt else None), v

    graded = await asyncio.gather(*[grade(b) for b in targets])
    n = 0
    for b, score, verdict in sorted(graded, key=lambda x: x[0]["key"]):
        if score is not None:
            lines[b["idx"]] = f"`[grade: {score}]`  <!-- vs-truth: {verdict[:80]} -->"
            n += 1
        print(f"  {b['key']:>3} [{score if score is not None else '—'}] {(b['q'] or '')[:46]}")
    path.write_text("\n".join(lines))
    print(f"\n✓ wrote {n} grades (vs ground truth) into {path.name}. Run calibrate.py for the number.")


if __name__ == "__main__":
    asyncio.run(main())
