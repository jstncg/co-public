"""The agent's epistemic laws (governance drop 8/10, built 8/23): recall never serves the
product's own canon, relevance has a floor, memory renders in speech-authority tiers, the
carried core never claims to be 'always true', and now-shaped questions get search RUN
before generation. Source laws — the live behavior is asserted by the engine scenarios."""
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MEMORY = (REPO / "frame" / "brain" / "memory.ts").read_text()
BRAIN = (REPO / "frame" / "brain" / "brain.ts").read_text()


def test_recall_excludes_canon_on_every_read_path():
    # Both the semantic and keyword paths carry the clause (rawCore had it since 8/4; recall didn't).
    assert MEMORY.count("NOT_CANON") >= 3          # const + two query sites


def test_recall_has_a_relevance_floor():
    assert "RELEVANCE_FLOOR" in MEMORY
    assert "dot >= RELEVANCE_FLOOR" in MEMORY
    assert "nothing genuinely relevant" in MEMORY  # the honest empty answer, not a reach


def test_memory_renders_in_tiers_not_flat_percent():
    for tier in ("KNOWN (they told you directly)", "OBSERVED", "WONDER (a weak inference"):
        assert tier in MEMORY
    assert "may be stale" in MEMORY                # the STALE suffix
    assert "confidence * 100" not in MEMORY.split("function tierLine")[1].split("class Memory")[0] \
        if "function tierLine" in MEMORY else True


def test_core_self_is_a_read_not_a_truth():
    assert "carried, always true" not in BRAIN     # the shipped wrapper phrase, dead
    assert "standing read" in BRAIN
    assert "drop any line of it the moment they contradict it" in BRAIN


def test_current_world_preflight_is_deterministic():
    assert "TIME_SENSITIVE" in BRAIN
    assert "searchWeb(text" in BRAIN               # the preflight RUNS the search itself
    assert "[current world" in BRAIN
    assert "Answer from THIS, not from memory" in BRAIN
