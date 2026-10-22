#!/usr/bin/env python3
"""Build the golden transcript set (goal.md §5.7 / §32 week 0b).

Reads the live router's durable founder transcript (role/content turns, order preserved) and emits:

  evals/golden/data/transcript.jsonl   one line per turn: {idx, role, content, exchange_id}
  evals/golden/data/labels.jsonl       one line per turn: {idx, exchange_id, role, labels}

Auto-labels only what is mechanically detectable (capability denials, memory teases, the documented
production incidents from docs/imessage-rail-context.md §5). Everything else is `unlabeled` — the
labels file is the human/founder review worklist. Prints a per-label count summary (counts only;
this script never prints message content).

PRIVACY: evals/golden/data/ is gitignored and never leaves this machine.

Run from the co repo root:  python3 scripts/build_golden_set.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter

TRANSCRIPT_SRC = os.path.expanduser("~/.co_dennis_sendblue_transcript.json")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "evals", "golden", "data")

# ----------------------------- mechanical detectors (assistant turns) --------
CAPABILITY_DENIAL_RE = re.compile(
    r"can'?t (open|watch|play|see)|only get the (blurb|description|summary)|"
    r"no actual (playback|content)", re.I)

# "i know what tuesday cost you" — memory referenced but not produced in the same bubble.
MEMORY_TEASE_RE = re.compile(r"\bi know what .{0,40}(cost|happened)", re.I)

# Documented incidents (imessage-rail-context.md §5), matched by content substring after
# normalizing curly apostrophes. All map to capability_denial.
KNOWN_DENIAL_SNIPPETS = (
    "i can't play video",
    "same answer. i only get the blurb",
    "i only get short auto-summaries",
    "still just getting the thumbnail",
)

# The truncated nine-terms reply (a length cap silently cut the enumeration; the reply covered only
# the first terms, through "Catastrophic Forgetting"). Exactly one assistant turn in the production
# transcript contains the phrase — containment is an unambiguous mechanical match for the incident.
TRUNCATION_SNIPPET = "catastrophic forgetting"


def _norm(s: str) -> str:
    return (s or "").replace("’", "'").lower()


def auto_labels(role: str, content: str) -> list[str]:
    labels: list[str] = []
    if role == "assistant":
        c = _norm(content)
        if CAPABILITY_DENIAL_RE.search(c) or any(k in c for k in KNOWN_DENIAL_SNIPPETS):
            labels.append("capability_denial")
        if MEMORY_TEASE_RE.search(c):
            labels.append("memory_tease")
        if TRUNCATION_SNIPPET in c:
            labels.append("enumeration_truncation")
    return labels or ["unlabeled"]


def main() -> int:
    if not os.path.exists(TRANSCRIPT_SRC):
        print(f"transcript not found: {TRANSCRIPT_SRC} (run on homebase)", file=sys.stderr)
        return 1
    with open(TRANSCRIPT_SRC) as f:
        turns = json.load(f)
    os.makedirs(DATA_DIR, exist_ok=True)

    transcript_path = os.path.join(DATA_DIR, "transcript.jsonl")
    labels_path = os.path.join(DATA_DIR, "labels.jsonl")
    counts: Counter[str] = Counter()
    exchange_id = 0

    with open(transcript_path, "w") as tf, open(labels_path, "w") as lf:
        for idx, m in enumerate(turns):
            role = m.get("role", "")
            content = m.get("content", "")
            if role == "user":
                exchange_id += 1              # an exchange = a user turn + the replies that follow
            tf.write(json.dumps({"idx": idx, "role": role, "content": content,
                                 "exchange_id": exchange_id}, ensure_ascii=False) + "\n")
            labels = auto_labels(role, content)
            counts.update(labels)
            lf.write(json.dumps({"idx": idx, "exchange_id": exchange_id, "role": role,
                                 "labels": labels}, ensure_ascii=False) + "\n")

    n_user = sum(1 for m in turns if m.get("role") == "user")
    n_asst = sum(1 for m in turns if m.get("role") == "assistant")
    print(f"golden set built: {len(turns)} turns ({n_user} user / {n_asst} assistant), "
          f"{exchange_id} exchanges")
    print(f"  transcript: {transcript_path}")
    print(f"  labels:     {labels_path}")
    print()
    print(f"{'label':<24} {'count':>5}")
    print(f"{'-' * 24} {'-' * 5}")
    for label, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"{label:<24} {n:>5}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
