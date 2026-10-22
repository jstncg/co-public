"""Your world — the watched set, rendered and correctable (8/25).

The page showed everything co produced and nothing co holds. Two laws: the roster RENDERS with
the receipt that makes each thing theirs, and a DROP is the member's alone and must survive the
nightly mine, which reads the same material forever and would otherwise resurrect it by morning.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import entities  # noqa: E402


def _store(tmp_path, monkeypatch, ents):
    monkeypatch.setattr(entities, "_path", lambda t: str(tmp_path / f"{t}.json"))
    entities.save("t", {"entities": ents})


def test_a_drop_removes_it_from_the_watched_set(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch, [{"name": "Kestrel AI", "kind": "company", "why": "sent twice"},
                                   {"name": "Larkfield", "kind": "company", "why": "comparing"}])
    assert entities.drop("t", "Kestrel AI")
    names = [x["name"] for x in entities.load("t")["entities"]]
    assert names == ["Larkfield"]


def test_a_drop_is_remembered_so_the_nightly_mine_cannot_undo_it(tmp_path, monkeypatch):
    # the mine runs over the same corpus every night; without this the correction lasts one day
    _store(tmp_path, monkeypatch, [{"name": "Kestrel AI", "kind": "company", "why": "sent twice"}])
    entities.drop("t", "Kestrel AI")
    monkeypatch.setattr(entities, "_material", lambda t: "x" * 400)
    import llm
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {"entities": [
        {"name": "Kestrel AI", "kind": "company", "why": "sent twice"},
        {"name": "Sable", "kind": "product", "why": "comparing it"}]})
    entities.mine("t")
    names = [x["name"] for x in entities.load("t")["entities"]]
    assert "Kestrel AI" not in names and "Sable" in names


def test_dropping_something_absent_is_not_an_error(tmp_path, monkeypatch):
    _store(tmp_path, monkeypatch, [])
    assert entities.drop("t", "never watched") is False
    assert entities.drop("t", "") is False


def test_co_cannot_drop_only_the_member_can():
    # authority lives at the door, the same shape as closing a list item
    router = (REPO / "frame" / "homebase" / "router" / "sendblue_router.py").read_text()
    assert "|world)$" in router                       # the route is registered
    door = router.split('mp.group(2) == "world"')[1][:600]
    assert 'payload.get("action") == "drop"' in door  # drop is the ONLY verb the door accepts
    assert "_en.drop" in door


def test_the_roster_renders_the_receipt_not_just_the_name():
    page = (CLAIMS / "wrapped.py").read_text()
    band = page.split("def _roster")[1][:900]
    assert 'x.get("why")' in band                     # why it is theirs ships with the name
    assert "dropEnt" in band
    assert '"person": 0' in band                      # people lead: a world is mostly people
