"""THE SIT-DOWN — co books time and calls (8/27).

The first thing in the product that behaves like an institution rather than a tool: it takes
fifteen minutes on the calendar and rings, because there is something it needs to know and a
message would take four rounds to get it.

It is NOT the probing this session ruled against. That ruling stands for SCHEDULED questions —
anything volunteered deliberately cannot surprise you later. This is a live, bounded,
load-bearing gap: co does not know why he is flying to Orlando, and the answer changes four
things it would otherwise get wrong. The law is ask when the answer changes what co does next,
and never otherwise.
"""
import datetime as dt
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import sitdown  # noqa: E402


def _state(tmp_path, monkeypatch, d=None):
    monkeypatch.setattr(sitdown, "STATE", str(tmp_path / "s.json"))
    if d is not None:
        sitdown._save(d)


def test_a_question_that_changes_nothing_is_not_load_bearing(monkeypatch):
    # a call with nothing behind it is worse than silence
    import llm
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {
        "gap": True, "question": "how are you feeling about the trip?", "changes": [],
        "confidence": 0.9})
    assert sitdown.gap("t", {"kind": "travel", "what": "x", "start": "2026-08-28"}) is None


def test_a_real_gap_carries_what_would_change(monkeypatch):
    import llm
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {
        "gap": True, "question": "morning or evening flight, and how many days?",
        "changes": ["protect tonight if morning", "gym near the hotel if multi-day"],
        "confidence": 0.8})
    g = sitdown.gap("t", {"kind": "travel", "what": "x", "start": "2026-08-28"})
    assert g and len(g["changes"]) == 2


def test_only_one_sit_down_is_ever_open(tmp_path, monkeypatch):
    # two booked sit-downs is a standing meeting, which is a different product
    _state(tmp_path, monkeypatch, {"pending": {"a": {"open": True}}})
    assert sitdown.MAX_PENDING == 1
    assert sitdown.propose("t") is None


def test_the_block_is_its_own_undo():
    src = (CLAIMS / "sitdown.py").read_text()
    body = src.split("def book")[1].split("\ndef ")[0]
    assert "delete this block to decline" in body
    assert "nothing will ring" in body


def test_nothing_rings_without_an_open_sit_down(tmp_path, monkeypatch):
    _state(tmp_path, monkeypatch, {"pending": {}})
    assert sitdown.ring("t", "missing")["ok"] is False


def test_a_placed_call_says_why_it_is_ringing():
    # a call opening with a naked "hey" is a robocall
    body = (CLAIMS / "sitdown.py").read_text().split("def ring")[1].split("\ndef ")[0]
    assert "it's co" in body and "p['question']" in body


def test_the_loudest_thing_co_does_is_opt_in(monkeypatch):
    monkeypatch.delenv("CO_SITDOWN_TENANTS", raising=False)
    assert not sitdown.rostered("dennis")
    monkeypatch.setenv("CO_SITDOWN_TENANTS", "dennis")
    assert sitdown.rostered("dennis") and not sitdown.rostered("isabel")


def test_the_slot_is_short_enough_to_accept_and_inside_waking_hours():
    assert sitdown.MINUTES <= 20
    assert sitdown.EARLIEST_H >= 8 and sitdown.LATEST_H <= 21


def test_co_takes_time_it_can_see_is_free(tmp_path, monkeypatch):
    # stacking a call on top of an existing meeting is not booking time, it is double-booking
    body = (CLAIMS / "sitdown.py").read_text().split("def _free_slot")[1].split("\ndef ")[0]
    assert "busy" in body and "3600" in body


def test_the_law_is_written_where_it_is_enforced():
    src = (CLAIMS / "sitdown.py").read_text()
    assert "ASK WHEN THE ANSWER CHANGES WHAT CO DOES NEXT" in src
    assert "NOT THE PROBING I ARGUED AGAINST" in src
