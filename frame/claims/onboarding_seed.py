"""THE WARM START — the app intake's answers become the member's first claims.

A fresh phone-verified member walks the questionnaire (name, birthday, goal, what's stuck,
how it feels, commitment level) and those answers land HERE, as ordinary claims in their own
graph — evidence source "onboarding", stated at the confidence a self-report deserves. Without
this the first conversation starts from nothing and co either says nothing interesting or
reaches for unearned context (the stranger failure, 8/6).

Laws:
  - answers seed the MEMBER'S graph only — tenant comes from the caller's verified binding,
    never from anything a client typed
  - every claim carries provenance ({"source": "onboarding"}) so it can be told apart from
    things actually said in conversation, and retired wholesale if an intake is redone
  - self-reports are facts about what they SAID, so statements say so where it matters
    ("says what's in the way is…"), and confidence stays under conversation-corroborated levels
  - idempotent: claimstore.upsert merges on (type, statement), so a retried POST is a no-op
"""
from __future__ import annotations

import datetime as _dt
import re

import claimstore

# The pill options are fixed vocabulary (OnboardingFixtures.swift); free text never reaches
# this organ except `name`, which is length-capped and stripped of control characters.
_COMMITMENT_READ = {
    "minimal": "Wants co to stay quiet unless asked (chose 'minimal' at signup)",
    "gentle": "Wants gentle nudges, not pressure (chose 'gentle' at signup)",
    "steady": "Wants to be kept honest — steady accountability (chose 'steady' at signup)",
    "allIn": "Wants co to not let them slide — full accountability (chose 'all in' at signup)",
}


def _clean(value: str, cap: int = 120) -> str:
    return re.sub(r"[\x00-\x1f\x7f]", "", str(value)).strip()[:cap]


def seed(tenant: str, answers: dict) -> int:
    """Write the intake into the tenant's graph. Returns how many claims landed."""
    when = _dt.date.today().isoformat()
    evidence = {"source": "onboarding", "when": when}
    rows: list[tuple[str, str, str, float]] = []  # (type, level, statement, confidence)

    name = _clean(answers.get("name") or "", 60)
    if name:
        rows.append(("identity", "fact", f"Goes by {name}", 0.9))

    birthday = _clean(answers.get("birthday") or "", 10)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", birthday):
        rows.append(("identity", "fact", f"Birthday is {birthday}", 0.9))

    goal = _clean(answers.get("goal") or "")
    if goal:
        rows.append(("value", "fact", f"Signed up wanting to: {goal}", 0.75))

    stuck = _clean(answers.get("stuck") or "")
    if stuck:
        rows.append(("frame", "frame", f"Says what's in the way is: {stuck}", 0.5))

    feeling = _clean(answers.get("feeling") or "")
    if feeling:
        rows.append(("frame", "frame", f"When goals slip, says they feel: {feeling}", 0.5))

    commitment = _COMMITMENT_READ.get(str(answers.get("commitment") or ""))
    if commitment:
        rows.append(("preference", "fact", commitment, 0.8))

    attribution = _clean(answers.get("attribution") or "")
    if attribution:
        rows.append(("other", "fact", f"Found co via {attribution}", 0.8))

    if not rows:
        return 0

    conn = claimstore.connect(tenant)
    try:
        for type_, level, statement, confidence in rows:
            claimstore.upsert(conn, type=type_, level=level, statement=statement,
                              confidence=confidence, evidence=dict(evidence), when=when)
    finally:
        conn.close()
    return len(rows)
