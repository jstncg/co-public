#!/usr/bin/env python3
"""Synthesis-level calibration — answer confidence bounded by the EVIDENCE STRUCTURE of what it cites.

The held-out failure this kills: claim-level calibration was honest (E3 caps frames ≤0.5), but the
ANSWER layer freely composed frame-level claims into 0.72–0.82-confidence psychological portraits that
graded 0 (H20/H21/H23 — confident-wrong, the fatal class). The stated [conf] is a vibe; the isotonic
map (E4) only remaps that vibe. This layer is structural instead: the answer must cite which claims it
used ([used: 1,3]), and the LEVELS of the cited claims set a hard ceiling on the confidence —

    frame-only support  → ABSTAIN. An interior portrait built only on interpretation is never asserted.
    pattern at best     → conf capped at 0.6 (behavior-over-time can suggest, not declare)
    any fact cited      → no structural cap (facts are reliable; E3/E4 already govern them)

Deterministic, code-enforced, runs BEFORE the isotonic abstention (E4) — same philosophy as the
RECEIVING≠DOING gate: don't trust the model to be honest about its own grounding; make the structure
of the evidence decide.
"""
import re

CAP = {"fact": 1.0, "pattern": 0.6, "frame": 0.4}

_USED = re.compile(r"\[used:\s*([0-9,\s]+)\]", re.I)
_CONF = re.compile(r"\[conf:\s*([0-9.]+)\s*\]")


def cited_levels(answer: str, meta: list) -> list:
    """Levels of the claims the answer says it used. No [used:] tag → conservatively assume it drew on
    everything retrieved (the cap then reflects the best evidence available, which still catches the
    frame-only-retrieval case that produced the confident-wrongs)."""
    by_n = {m["n"]: m["level"] for m in meta}
    m = _USED.search(answer)
    if m:
        ns = [int(x) for x in re.findall(r"\d+", m.group(1))]
        levels = [by_n[n] for n in ns if n in by_n]
        if levels:
            return levels
    return [x["level"] for x in meta]


def apply_synth_calibration(answer: str, meta: list) -> str:
    """The structural gate. Pass-through for abstentions, errors, and the no-meta fallback path."""
    if not answer or not meta or answer.strip().upper().startswith("INSUFFICIENT"):
        return answer
    levels = set(cited_levels(answer, meta))
    if not levels:
        return answer
    if levels <= {"frame"}:   # frame-only synthesis = the measured killer — never asserted
        return ("INSUFFICIENT — only frame-level (interpretive) claims support this; an interior "
                "read built on interpretation alone is not asserted. [conf: 0.2]")
    cap = max(CAP.get(lv, 0.4) for lv in levels)
    m = _CONF.search(answer)
    if not m:
        return answer
    stated = float(m.group(1))
    if stated <= cap:
        return answer
    capped = answer[:m.start()] + f"[conf: {cap:.2f} (stated {stated:.2f}, capped: best evidence is {max(levels, key=lambda l: CAP.get(l, 0))}-level)]" + answer[m.end():]
    return capped


def best_level(answer: str, meta: list) -> str:
    """Strongest evidence level among the cited claims — drives the ASYMMETRIC abstention bar:
    fact/pattern-grounded answers get a permissive bar (tentative-wrong is recoverable, and coverage
    there is the product's utility); frame-grounded get the strict bar (confident-wrong interior is
    the fatal class). Returns 'fact' | 'pattern' | 'frame' | '' (no meta)."""
    if not meta:
        return ""
    levels = set(cited_levels(answer, meta))
    for lv in ("fact", "pattern", "frame"):
        if lv in levels:
            return lv
    return ""


# Abstention bars by best evidence level (consumed with calibration_map.apply_abstention(tau=...)).
TAU_BY_LEVEL = {"fact": 0.30, "pattern": 0.30, "frame": 0.45, "": None}   # None → map's default bar


def strip_audit(answer: str) -> str:
    """Remove the [used: ...] tag for human-facing output (it's audit plumbing, not prose)."""
    return _USED.sub("", answer).strip()


if __name__ == "__main__":
    meta = [{"n": 1, "level": "frame", "confidence": 0.4, "statement": "maybe status-driven"},
            {"n": 2, "level": "frame", "confidence": 0.35, "statement": "possibly avoids follow-through"},
            {"n": 3, "level": "pattern", "confidence": 0.6, "statement": "buys stuff when burnt out"},
            {"n": 4, "level": "fact", "confidence": 0.9, "statement": "has an Amex"}]
    print("frame-only cited →", apply_synth_calibration("He fears being exposed as a fraud. [used: 1,2] [conf: 0.78]", meta)[:90])
    print("pattern cited    →", apply_synth_calibration("He shops when burnt out. [used: 3] [conf: 0.82]", meta)[:110])
    print("fact cited       →", apply_synth_calibration("He has an Amex. [used: 4] [conf: 0.85]", meta)[:60])
    print("no tag, mixed    →", apply_synth_calibration("Something. [conf: 0.9]", meta)[:80])
    print("abstention pass  →", apply_synth_calibration("INSUFFICIENT", meta))
