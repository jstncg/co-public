"""The gate decides which voice speaks; it never decided whether that voice may make a read.

co_react scored the 9/2 typography sends LIGHT — "topical match, not a behavioral claim — a glance,
never the vague read" — and the engine then asserted a four-day-old commitment about him anyway.
Muting the NONE tier (the obvious fix) would have silenced the GeeLark explanation and the "made it
up, dropping it" retraction, both NONE, and left both nags standing. So the verdict travels to the
engine as a constraint instead.
"""
import sys
from pathlib import Path

ROUTER = Path(__file__).resolve().parents[2] / "frame" / "homebase" / "router"
sys.path.insert(0, str(ROUTER))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "frame" / "claims"))

import sendblue_router as router  # noqa: E402

LIGHT = {"tier": "light", "why": "topical match, not a behavioral claim — a glance, never the vague read"}
NONE = {"tier": "none", "why": "skimmed past it — holding back IS the product"}
LINE = {"tier": "line", "why": "a real avoidance pattern, twice-evidenced"}


def test_a_light_verdict_forbids_a_read():
    h = router.verdict_hint(LIGHT)
    assert h and "do not name a pattern about them" in h.lower()
    assert "light" in h.lower(), "the engine is told which way the gate went"


def test_a_none_verdict_forbids_a_read_but_never_the_reply():
    h = router.verdict_hint(NONE)
    assert h and "add, answer, or react" in h.lower()


def test_a_line_earned_the_read_and_is_left_alone():
    assert router.verdict_hint(LINE) is None


def test_cos_own_earlier_proposals_are_named_as_cos():
    """Both fabrications cited something co proposed. The constraint says so in words."""
    h = router.verdict_hint(LIGHT)
    assert "something YOU proposed" in h


def test_the_constraint_leads_and_the_situation_follows():
    joined = router.join_hint(router.verdict_hint(LIGHT), "they are in NYC this week")
    assert joined.startswith("NO READ THIS TURN")
    assert "NYC" in joined


def test_join_drops_the_empties():
    assert router.join_hint(None, None) is None
    assert router.join_hint(None, "only this") == "only this"


def test_both_reply_paths_carry_the_verdict():
    src = Path(router.__file__).read_text()
    assert src.count("join_hint(verdict_hint(r), hint)") == 2, "text path and content path"
