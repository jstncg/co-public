"""The outcome loop's laws (8/24): one check-back a day, evening only, never re-asked,
silence closes it, and a verdict is only ever recorded from the member's own answer.
This is the SENSE half of the cybernetics ring — without it co is a calendar."""
import datetime as dt
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "frame" / "claims"))

import outcomes  # noqa: E402


def _store(tmp_path, monkeypatch, name="octest"):
    monkeypatch.setattr(outcomes, "_path", lambda t: str(tmp_path / f"{t}.json"))
    return name


def test_one_a_day_and_never_two_open(tmp_path, monkeypatch):
    t = _store(tmp_path, monkeypatch)
    outcomes._save(t, {"asked": [{"key": "k", "what": "x", "when": "2026-08-24",
                                  "text": "did it happen?",
                                  "asked_at": dt.datetime.now().isoformat(timespec="seconds"),
                                  "status": "waiting"}], "outcomes": []})
    assert outcomes.compose(t) is None                 # today's ask is spent
    assert outcomes.pending(t) is not None


def test_silence_closes_it_and_it_is_never_reasked(tmp_path, monkeypatch):
    t = _store(tmp_path, monkeypatch)
    old = (dt.datetime.now() - dt.timedelta(days=3)).isoformat(timespec="seconds")
    outcomes._save(t, {"asked": [{"key": "k", "what": "the stream", "when": "2026-08-20",
                                  "text": "did thursday happen?", "asked_at": old,
                                  "status": "waiting"}], "outcomes": []})
    monkeypatch.setattr(outcomes, "_load_props", lambda t2: [])
    outcomes.sweep(t)
    st = outcomes._load(t)
    assert st["asked"][0]["status"] == "no_answer"     # closed, not nagged
    assert st["outcomes"] == []                        # silence is never a verdict


def test_recent_reads_the_window(tmp_path, monkeypatch):
    t = _store(tmp_path, monkeypatch)
    today = dt.date.today().isoformat()
    stale = (dt.date.today() - dt.timedelta(days=40)).isoformat()
    outcomes._save(t, {"asked": [], "outcomes": [
        {"what": "the stream", "when": today, "verdict": "happened", "words": ""},
        {"what": "old thing", "when": stale, "verdict": "didnt", "words": ""}]})
    got = outcomes.recent(t)
    assert [o["what"] for o in got] == ["the stream"]


def test_the_ring_is_wired_and_outranks_proposing():
    tick = (REPO / "frame" / "claims" / "proactive_tick.py").read_text()
    assert "import outcomes" in tick
    assert tick.index("import outcomes") < tick.index("import propose_lane")


def test_the_page_reports_what_happened():
    page = (REPO / "frame" / "claims" / "wrapped.py").read_text()
    assert "what actually happened" in page
    assert "card becoming" in page


def test_the_proposal_asks_for_one_move():
    pl = (REPO / "frame" / "claims" / "propose_lane.py").read_text()
    assert "propose ONE MOVE" in pl
    assert "next 48 hours" in pl
    assert "Never a list" in pl
