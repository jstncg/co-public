"""THE LIST's laws (v2-the-list, 8/12; built 8/22): member words verbatim and never deleted,
the green dot never faked, done-by-co needs receipts, only the member closes, and nothing
dies silently. Tested like lived.py's laws — in the projection, not in caller discipline."""
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "frame" / "claims"))

import list_engine  # noqa: E402


def _tenant(tmp_path, monkeypatch, name="listtest"):
    monkeypatch.setattr(list_engine, "_db", lambda t: str(tmp_path / f"claims_{t}.db"))
    return name


def test_member_words_are_verbatim_and_close_is_member_only(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    iid = list_engine.add(t, "Fix the studio lease — it's month to month")
    it = list_engine.project(t)[0]
    assert it["text"] == "Fix the studio lease — it's month to month"   # em-dash survives: their words
    assert it["state"] == "open"
    list_engine.close(t, iid, "handled it myself")
    assert list_engine.project(t)[0]["state"] == "closed"


def test_the_green_dot_requires_a_job_ref():
    assert not list_engine.set_working("x", "y", "")
    assert not list_engine.set_working("x", "y", "   ")


def test_done_by_co_requires_receipts(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    iid = list_engine.add(t, "find me a better sauna part supplier")
    assert not list_engine.done_by_co(t, iid, [])
    assert not list_engine.done_by_co(t, iid, [{"what": "  "}])
    assert list_engine.project(t)[0]["state"] == "open"
    assert list_engine.done_by_co(t, iid, [{"what": "3 suppliers compared", "url": "https://x.co/r"}])
    it = list_engine.project(t)[0]
    assert it["state"] == "done-by-co"
    # NOT closed: the member settles (lived.py LAW 2/4).
    list_engine.close(t, iid)
    assert list_engine.project(t)[0]["state"] == "closed"


def test_co_drops_only_its_own_proposals_with_a_reason(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    mine = list_engine.add(t, "call mom more")
    theirs = list_engine.add(t, "book the pottery class thursday", source="co-proposed")
    assert not list_engine.drop(t, mine, "co changed its mind")     # member items never deleted
    assert list_engine.project(t)[0]["state"] == "open"
    assert not list_engine.drop(t, theirs, "")                      # no silent deaths
    assert list_engine.drop(t, theirs, "window passed, class full")
    states = {i["id"]: i["state"] for i in list_engine.project(t)}
    assert states[mine] == "open" and states[theirs] == "dropped"
    assert all(i["state"] != "dropped" for i in list_engine.live(t))


def test_scope_then_needs_you_then_next_check(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    iid = list_engine.add(t, "figure out the S-corp thing")
    list_engine.scope(t, iid, "compare election deadlines against your 1099 net, then a one-pager")
    assert list_engine.project(t)[0]["state"] == "scoped"
    list_engine.needs_you(t, iid, "your rough 1099 net for the year — one number")
    it = list_engine.project(t)[0]
    assert it["state"] == "needs-you" and "one number" in it["needs"]
    list_engine.hold(t, iid, "sept 1")
    assert list_engine.project(t)[0]["next_check"] == "sept 1"


def test_member_door_speaks_only_member_actions(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    assert list_engine.record(t, {"action": "add", "text": "learn to actually rest"})
    iid = list_engine.project(t)[0]["id"]
    assert not list_engine.record(t, {"action": "close", "id": "nope"})
    assert list_engine.record(t, {"action": "close", "id": iid})
    assert not list_engine.record(t, {"action": "drop", "id": iid, "reason": "x"})  # not a member verb
    assert not list_engine.record(t, {"action": "add", "text": "   "})


def test_reorder_is_member_shaped_and_lossless(tmp_path, monkeypatch):
    t = _tenant(tmp_path, monkeypatch)
    a = list_engine.add(t, "one")
    b = list_engine.add(t, "two")
    c = list_engine.add(t, "three")
    list_engine.reorder(t, [c, a])
    assert [i["id"] for i in list_engine.project(t)] == [c, a, b]   # unknown-safe, nothing lost
