"""THE BURN LAW (8/25): nothing is spent at compose time, only on delivery.

Found three times in one day — the finds burned URLs when composed, the join burned its
candidates when staged (eating a real pre-brief that was never sent), and the assumption
ledger marked pops delivered on read. Each one silently destroyed the best output the organ
had, because the failure is invisible: no error, no retry, the content simply never exists
again. These tests make a fourth instance fail loudly instead."""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import assumptions  # noqa: E402
import join  # noqa: E402


def test_every_brief_contributor_has_a_commit():
    for mod in (join, assumptions):
        assert hasattr(mod, "commit"), f"{mod.__name__} composes for the brief without a commit"


def test_the_brief_commits_only_after_the_send(tmp_path):
    src = (CLAIMS / "daily_finds.py").read_text()
    body = src.split("def run_tenant")[1]
    sent = body.index("_sendblue")
    commit = body.index(".commit(tenant)")
    assert sent < commit, "commit must follow the send, never precede it"


def test_pops_survive_a_compose_that_never_sends(tmp_path, monkeypatch):
    monkeypatch.setattr(assumptions, "_path", lambda t: str(tmp_path / f"{t}.json"))
    assumptions._save("t", {"assumptions": [
        {"text": "it costs 10k", "status": "popped", "stated": "2026-08-24",
         "evidence": {"line": "it's actually $400", "url": "https://x.co/a", "date": "2026-08-24"}}]})
    first = assumptions.fresh_pops("t")
    assert len(first) == 1
    # the brief abstained: nothing was delivered, so the pop must still be there tomorrow
    assert len(assumptions.fresh_pops("t")) == 1
    assumptions.commit("t")
    assert assumptions.fresh_pops("t") == []      # and only once it actually went out


def test_joins_survive_a_compose_that_never_sends(tmp_path, monkeypatch):
    monkeypatch.setattr(join, "BURN", str(tmp_path / "burn.json"))
    monkeypatch.setattr(join, "PENDING", str(tmp_path / "pending.json"))
    monkeypatch.setattr(join, "people_today", lambda t: [{"key": "person:lance", "text": "lance raised"}])
    monkeypatch.setattr(join, "entity_moves", lambda t: [])
    assert join.fresh("t") == ["lance raised"]
    assert "person:lance" not in join._burned("t")   # staged, not spent
    assert join.fresh("t") == ["lance raised"]       # still available after an abandoned compose
    join.commit("t")
    assert "person:lance" in join._burned("t")       # spent only on delivery
