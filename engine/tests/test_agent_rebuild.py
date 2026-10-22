"""The agent rebuild's laws (founder go, 8/23: 'witty, intent seeking'): the compact core
replaces the law bible, exemplars carry the register, the turn's job is decided by a model,
drafts are verified before send, and the agent can see its own book."""
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRAIN = (REPO / "frame" / "brain" / "brain.ts").read_text()
SERVER = (REPO / "frame" / "brain" / "server.ts").read_text()


def test_core_is_two_properties_plus_exemplars():
    assert "TWO PROPERTIES" in BRAIN
    assert "WITTY." in BRAIN and "INTENT-SEEKING." in BRAIN
    assert "EXEMPLARS (the register" in BRAIN
    assert BRAIN.count("them:") >= 8                    # the pack is real, not a gesture
    # the bible is gone: the old accreted blocks must not have survived the excision
    for relic in ("ENERGY (the calibration", "THE MARKER IS A CHECK", "IMAGE EMPHASIS (composed",
                  "KNOWING (the wise-friend register)"):
        assert relic not in BRAIN, relic


def test_hard_laws_survived_the_cut():
    # the scenario-load-bearing dozen — losing any of these regresses a live eval scenario
    for law in ("ANSWER FIRST", "RECEIPTS", "NEVER DENY A POWER", "WRONG READ FLAGGED",
                "MAKE THE CALL", "BANNED ALWAYS", "SILENCE IS LEGAL", "[SILENCE]"):
        assert law in BRAIN, law


def test_turn_job_is_decided_not_guessed():
    assert "decideTurn" in SERVER
    assert "THIS TURN'S JOB (decided, not guessed)" in SERVER
    assert "silence_ok" in SERVER


def test_draft_verify_send_exists_and_fails_open():
    assert "verifyDraft" in SERVER
    assert "one revision" in SERVER
    assert "DRAFT CHECK" in SERVER


def test_the_agent_sees_its_own_book():
    assert "bookBlock" in SERVER
    assert "THE BOOK (your own open commitments" in SERVER
    assert "list_events" in SERVER                      # the list, visible to the mouth


def test_the_flywheel_turns():
    assert "exemplarBlock" in SERVER
    assert "TURNS THAT LANDED" in SERVER
    tick = (REPO / "frame" / "claims" / "proactive_tick.py").read_text()
    assert "exemplars.mine" in tick                     # nightly, per tenant
