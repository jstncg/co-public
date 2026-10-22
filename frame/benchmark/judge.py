#!/usr/bin/env python3
"""Auto-grader for the OBJECTIVE tier (UNDERSTANDING_AGENT.md P3).

The benchmark's philosophy is subject-graded truth — but L1/L2 (retrieval/aggregation: "what bank?",
"what city?") have OBJECTIVE answers that live in the raw corpus, so a judge can grade them against the
actual emails (NOT against the belief graph — that's circular; the graph is what produced the answer).
This yields a REAL number for the factual tier now, without faking the subjective L4/L5 grades that only
Dennis can give. The moat tier (inference/frame) is left for the subject.

Per L1/L2 question: pull raw email evidence (substrate FTS) → judge whether the answer is SUPPORTED by it
→ write the grade into the sheet. Skips a question if no raw evidence is found (left for subject grading).

  doppler run -- /…/python3 judge.py [--levels L1,L2] [results-YYYY-MM-DD.md]
"""
import asyncio
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
from donna_warm import make_client

HERE = Path(__file__).resolve().parent
SUBSTRATE = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
MODEL = "claude-haiku-4-5-20251001"   # cheap — it's a grounded support-check, not deep reasoning
STOP = set("what which who the a an does do is are user have has with most".split())

JUDGE_SYS = (
    "You grade whether an AI's factual answer about a person is SUPPORTED by raw email evidence. "
    "Reply with exactly one token then a short reason:\n"
    "  1   — answer's core claim is corroborated by the evidence\n"
    "  0.5 — partially right (some entities right, some wrong/missing, or vague-but-defensible)\n"
    "  0   — wrong, contradicted, or confabulated (named things absent from evidence)\n"
    "Judge ONLY against the evidence shown. Be strict: unsupported specifics = not a 1.")


def fts(conn, question, answer, k=8):
    """Pull RAW evidence to verify the answer. We check the ANSWER's named entities (Chase, SoFi, Robinhood)
    against the corpus — not the question's words ("bank", "accounts"), which surface irrelevant newsletter
    chatter and produce false-negatives. The question is verifying 'are the things it named actually in the
    user's mail', so we search for those things."""
    # answer entities = capitalized multi-char tokens (brands/proper nouns), minus sentence-noise
    NOISE = {"the", "based", "user", "these", "additional", "overall", "one", "also", "their", "this"}
    ents = [w for w in re.findall(r"\b[A-Z][A-Za-z]{2,}\b", answer or "") if w.lower() not in NOISE]
    qterms = [w for w in re.findall(r"[A-Za-z0-9]+", question.lower()) if w not in STOP and len(w) > 2]
    seen, terms = set(), []
    for t in ents + qterms:  # answer entities first
        if t.lower() not in seen:
            seen.add(t.lower()); terms.append(t)
    if not terms:
        return ""
    snippets = []
    # OWNERSHIP signal = the brand in the SUBJECT line (transactional: "Your SoFi statement", "Chase Loan"),
    # NOT body word-count (ads/newsletters mention brands you don't use — the RECEIVING≠DOING trap). Sample
    # distinct subjects so the judge sees whether the user actually transacts with each named thing.
    for t in terms[:8]:
        subs = conn.execute("SELECT count(*) FROM communications WHERE subject LIKE ?", (f"%{t}%",)).fetchone()[0]
        rows = conn.execute(
            "SELECT DISTINCT subject FROM communications WHERE subject LIKE ? AND subject IS NOT NULL LIMIT 3",
            (f"%{t}%",)).fetchall()
        if subs:
            snippets.append(f"[{t}: {subs} emails w/ it in subject] " + " | ".join((s or "").strip()[:64] for s, in rows))
        else:
            body = conn.execute("SELECT count(*) FROM communications WHERE body LIKE ?", (f"%{t}%",)).fetchone()[0]
            snippets.append(f"[{t}: 0 in any subject line ({body} body-only mentions = likely ads/newsletter, not owned)]")
    return "\n".join(snippets)


def parse_blocks(text):
    """Ordered list of (level, question, answer, grade_line_idx) for the gradeable blocks."""
    lines = text.splitlines()
    out, level, q, ans = [], None, None, None
    for i, line in enumerate(lines):
        m = re.match(r"##\s+(L[1-5])\b", line)
        if m:
            level = m.group(1)
        qm = re.match(r"\*\*Q\d+.*?:\*\*\s*(.+)", line)
        if qm:
            q = qm.group(1).strip(); ans = None
        if line.startswith(">"):
            ans = (ans + " " if ans else "") + line.lstrip("> ").strip()
        if re.match(r"`\[grade:\s*\]`", line.strip()):
            out.append({"level": level, "q": q, "ans": ans, "idx": i})
    return lines, out


async def main():
    argv = sys.argv[1:]
    levels = ["L1", "L2"]
    pos = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--levels="):
            levels = a.split("=", 1)[1].split(",")
        elif a == "--levels":
            levels = argv[i + 1].split(","); i += 1
        elif not a.startswith("--"):
            pos.append(a)
        i += 1
    path = Path(pos[0]) if pos else sorted(HERE.glob("results-*.md"))[-1]
    lines, blocks = parse_blocks(path.read_text())
    targets = [b for b in blocks if b["level"] in levels and b["ans"] and not b["ans"].upper().startswith("INSUFFICIENT")]
    print(f"auto-grading {len(targets)} objective answers ({'/'.join(levels)}) against the raw corpus…")

    conn = sqlite3.connect(SUBSTRATE, uri=True)
    client = make_client()
    sem = asyncio.Semaphore(4)

    async def grade(b):
        ev = fts(conn, b["q"], b["ans"])
        if not ev:
            return b, None, "(no raw evidence found — left for subject grading)"
        async with sem:
            try:
                r = await client.messages.create(
                    model=MODEL, system=JUDGE_SYS, max_tokens=100,
                    messages=[{"role": "user", "content": f"QUESTION: {b['q']}\nANSWER: {b['ans']}\n\nRAW EMAIL EVIDENCE:\n{ev}"}])
                v = " ".join("".join(x.text for x in r.content if x.type == "text").split())  # one line
            except Exception as e:
                return b, None, f"(judge error: {e})"
        mt = re.match(r"(1\.0|1|0\.5|0)\b", v)
        return b, (mt.group(1) if mt else None), v

    graded = await asyncio.gather(*[grade(b) for b in targets])
    n_written = 0
    for b, score, verdict in graded:
        tag = f"`[grade: {score}]`  <!-- auto: {verdict[:80]} -->" if score is not None else "`[grade: ]`"
        if score is not None:
            lines[b["idx"]] = tag
            n_written += 1
        print(f"  {b['level']} [{score if score else '—'}] {b['q'][:54]}")
    path.write_text("\n".join(lines))
    print(f"\n✓ wrote {n_written} auto-grades into {path.name}. Run `calibrate.py` for the number.")
    print("  (L3–L5 left for subject grading — the moat only Dennis can grade.)")


if __name__ == "__main__":
    asyncio.run(main())
