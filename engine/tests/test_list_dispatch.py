"""The dispatch rung's laws (v2-the-list §work loop): routing carries real job refs, the
unworkable is scoped with an honest note instead of fake progress, completion needs a FIRED
anchor, and the rung stays silent. Organs and the classifier are stubbed — the routing
contract is what's under test."""
import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "frame" / "claims"))

import list_dispatch  # noqa: E402
import list_engine  # noqa: E402


def _tenant(tmp_path, monkeypatch, name="dsp"):
    monkeypatch.setattr(list_engine, "_db", lambda t: str(tmp_path / f"claims_{t}.db"))
    return name


def test_research_route_scopes_and_works_with_ref(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    iid = list_engine.add(t, "find the best price on a decent anvil")
    monkeypatch.setattr(list_dispatch, "_classify", lambda s: {"shape": "research", "note": ""})
    fake_re = types.SimpleNamespace(commission=lambda tn, ask: {"topic": "anvil prices", "due": "2026-08-24", "thin": False})
    monkeypatch.setitem(sys.modules, "research_engine", fake_re)
    monkeypatch.setattr(list_dispatch, "_research_rid", lambda tn, ask: "rs123")
    out = list_dispatch._dispatch_one(t, next(i for i in list_engine.live(t) if i["id"] == iid))
    assert out.startswith("research:")
    it = list_engine.project(t)[0]
    assert it["state"] == "working" and it["job_ref"] == "research:rs123"
    assert "report lands" in it["plan"]


def test_unworkable_is_scoped_honestly_never_working(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    list_engine.add(t, "be a calmer person around my brother")
    monkeypatch.setattr(list_dispatch, "_classify",
                        lambda s: {"shape": "none", "note": "this is lived, not run. it holds here."})
    out = list_dispatch._dispatch_one(t, list_engine.live(t)[0])
    assert out == "scoped:unworkable"
    it = list_engine.project(t)[0]
    assert it["state"] == "scoped" and "lived" in it["plan"]
    assert it["job_ref"] is None                       # no fake green dot, ever


def test_completion_requires_a_fired_anchor(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    iid = list_engine.add(t, "look into the s-corp math")
    list_engine.set_working(t, iid, "research:rs9")
    store = {"anchors": [{"research_id": "rs9", "fired": False, "what": "research report: s-corp math"}]}
    fake_anchors = types.SimpleNamespace(_load=lambda db: store)
    fake_journal = types.SimpleNamespace(_claims_db=lambda tn: "x")
    monkeypatch.setitem(sys.modules, "anchors", fake_anchors)
    monkeypatch.setitem(sys.modules, "journal", fake_journal)
    assert list_dispatch._sweep_research_completions(t) == []          # unfired → still working
    assert list_engine.project(t)[0]["state"] == "working"
    store["anchors"][0]["fired"] = True
    got = list_dispatch._sweep_research_completions(t)
    assert len(got) == 1
    it = list_engine.project(t)[0]
    assert it["state"] == "done-by-co"
    assert it["receipts"] and "s-corp" in it["receipts"][0]["what"]


def test_co_proposed_items_are_never_dispatched(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    list_engine.add(t, "book that class thursday", source="co-proposed")
    monkeypatch.setattr(list_dispatch, "_classify",
                        lambda s: (_ for _ in ()).throw(AssertionError("classified a proposal")))
    monkeypatch.setattr(list_dispatch, "_sweep_research_completions", lambda tn: [])
    assert list_dispatch.run_tenant(t) == []           # proposals wait for the member's yes


def test_the_rung_is_wired_and_silent():
    tick = (REPO / "frame" / "claims" / "proactive_tick.py").read_text()
    assert "list_dispatch" in tick
    src = (REPO / "frame" / "claims" / "list_dispatch.py").read_text()
    assert "_sendblue" not in src and "sendblue_send" not in src      # the rung never texts
