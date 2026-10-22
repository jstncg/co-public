"""The join's laws (8/25): an entity is only watched when it's genuinely theirs and carries
its receipt; movement is a recency claim enforced at the search, not a vibe; a delivered join
never repeats; and a watched thing that never moves leaves the set instead of burning a search
a day forever. The first live run produced one perfect join and one junk one — these are the
junk one's autopsy."""
import datetime as dt
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "frame" / "claims"))

import entities  # noqa: E402
import join  # noqa: E402


def _store(tmp_path, monkeypatch, name="jointest"):
    monkeypatch.setattr(entities, "_path", lambda t: str(tmp_path / f"{t}.json"))
    return name


def test_an_entity_without_a_receipt_is_not_an_entity(tmp_path, monkeypatch):
    t = _store(tmp_path, monkeypatch)
    monkeypatch.setattr(entities, "_material", lambda t2: "x" * 500)
    fake = {"entities": [
        {"name": "Real Co", "kind": "company", "why": "comparing it against the other one"},
        {"name": "No Receipt", "kind": "company", "why": ""},
        {"name": "Bad Kind", "kind": "concept", "why": "they talk about it"}]}
    monkeypatch.setattr(entities, "llm", type("L", (), {
        "json_specs": staticmethod(lambda: []),
        "ask_json": staticmethod(lambda *a, **k: fake)})(), raising=False)
    sys.modules["llm"] = type("L", (), {"json_specs": staticmethod(lambda: []),
                                        "ask_json": staticmethod(lambda *a, **k: fake)})
    assert entities.mine(t) == 1
    assert [e["name"] for e in entities.load(t)["entities"]] == ["Real Co"]


def test_a_watched_thing_that_never_moves_leaves_the_set(tmp_path, monkeypatch):
    t = _store(tmp_path, monkeypatch)
    entities.save(t, {"entities": [
        {"name": "Incidental", "kind": "person", "why": "face in a screenshot",
         "seen": "2026-08-01", "mentions": 1, "misses": 0, "checked": ""},
        {"name": "Real", "kind": "company", "why": "comparing it", "seen": "2026-08-01",
         "mentions": 4, "misses": 0, "checked": ""}]})
    for _ in range(entities.MAX_MISSES):
        entities.mark_checked(t, "Incidental")
        entities.mark_checked(t, "Real")
    names = [e["name"] for e in entities.load(t)["entities"]]
    assert "Incidental" not in names        # noise self-cleans
    assert "Real" in names                  # weight survives silence


def test_movement_carries_a_real_recency_window():
    assert join.FRESH_DAYS <= 60
    src = (REPO / "frame" / "claims" / "join.py").read_text()
    assert "startPublishedDate" in src      # enforced at the search, not just asked for
    assert "TODAY:" in src                  # and the judge is told what today is


def test_a_delivered_join_is_burned(tmp_path, monkeypatch):
    monkeypatch.setattr(join, "BURN", str(tmp_path / "burn.json"))
    join._burn("t", ["person:lance:2026-08-25"])
    assert "person:lance:2026-08-25" in join._burned("t")


def test_the_mechanism_is_never_narrated():
    src = (REPO / "frame" / "claims" / "join.py").read_text()
    for banned in ("i've been watching", "i noticed"):
        assert banned in src.lower()        # present only as an instruction NOT to say it
    assert "Never say you were watching" in src


def test_the_join_leads_the_brief_and_entities_are_mined_nightly():
    finds = (REPO / "frame" / "claims" / "daily_finds.py").read_text()
    assert "import join as _join" in finds
    assert finds.index("_join.fresh") < finds.index("assumptions.fresh_pops")
    tick = (REPO / "frame" / "claims" / "proactive_tick.py").read_text()
    assert "entities.mine" in tick
