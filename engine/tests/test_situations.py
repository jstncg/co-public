"""SITUATIONS — the episodes that generate everything at once (8/27).

An opening is one thing with one clock. An aim is a direction with no clock. A situation is a
bounded episode that produces a dozen needs at different distances, filtered through how THIS
member does that kind of episode.

Live on the founder's mail it found his real Orlando flight the next day, and also claimed a
friend's forwarded itinerary as his own — the third attribution failure of the day.
"""
import datetime as dt
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import situations as S  # noqa: E402


def _at(tmp_path, monkeypatch, sits, patterns=None):
    monkeypatch.setattr(S, "_path", lambda t: str(tmp_path / f"{t}.json"))
    S.save("t", {"situations": sits, "patterns": patterns or {}})


def test_a_need_stays_quiet_until_its_lead_arrives(tmp_path, monkeypatch):
    # a dinner table has to be taken while one exists; weather is noise until it is close
    today = dt.date(2026, 8, 27)
    _at(tmp_path, monkeypatch, [{"id": "s1", "kind": "travel", "what": "orlando",
                                 "place": "Orlando", "start": "2026-09-04", "end": "",
                                 "receipt": "LGA to MCO", "confidence": 0.9}])
    kinds = {n["kind"] for n in S.due_needs("t", today)}      # 8 days out
    assert "situation:dinner" in kinds                        # lead 10: due
    assert "situation:weather" not in kinds                   # lead 2: not yet


def test_leads_are_ordered_so_the_scarce_thing_comes_first():
    leads = dict((n, l) for n, l, _ in S.NEEDS["travel"])
    assert leads["dinner"] > leads["weather"]                 # tables run out; forecasts do not


def test_a_past_episode_generates_nothing(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch, [{"id": "s1", "kind": "travel", "what": "x", "place": "",
                                 "start": "2026-08-01", "end": "", "receipt": "r",
                                 "confidence": 0.9}])
    assert S.due_needs("t", dt.date(2026, 8, 27)) == []


def test_one_trip_is_one_situation_however_many_confirmations_arrive():
    # a flight mail AND a hotel mail AND a calendar block are one episode; keying on place made
    # them three, and every need fired three times
    src = (CLAIMS / "situations.py").read_text()
    body = src.split("def detect")[1].split("\ndef ")[0]
    assert '_sid(kind, start, "")' in body
    assert "have.add(sid)" in body


def test_someone_elses_itinerary_is_not_the_members_situation():
    # first live run claimed "Friend: YYZ→DTW" as his own trip
    sys_ = " ".join(S.DETECT_SYS.split())
    assert "THE SITUATION MUST BE THEIRS" in sys_
    assert "somebody else" in sys_
    body = (CLAIMS / "situations.py").read_text().split("def detect")[1].split("\ndef ")[0]
    assert "THE MEMBER IS" in body                              # identity passed, not assumed


def test_a_pattern_co_could_not_quote_is_never_stored(tmp_path, monkeypatch):
    # an invented pattern is a horoscope aimed at somebody's actual trip
    sys_ = " ".join(S.PATTERN_SYS.split())
    assert "a pattern you had to invent is worse than none" in sys_.lower()
    src = (CLAIMS / "situations.py").read_text()
    body = src.split("def learn_pattern")[1].split("\ndef ")[0]
    assert "corpus_all" in body and 'return ""' in body


def test_the_pattern_is_mined_from_what_they_did_not_what_they_said():
    # four travel-shaped lines in the co corpus, one of them "landing page". How somebody
    # travels is not narrated — it is in years of booking and change mail.
    body = (CLAIMS / "situations.py").read_text().split("def learn_pattern")[1].split("\ndef ")[0]
    assert "gmail_guard" in body
    assert "flight receipt" in body.lower()


def test_the_pattern_raises_confidence_but_is_never_required(tmp_path, monkeypatch):
    sit = [{"id": "s1", "kind": "travel", "what": "x", "place": "", "start": "2026-08-28",
            "end": "", "receipt": "r", "confidence": 0.6}]
    _at(tmp_path, monkeypatch, sit)
    plain = S.due_needs("t", dt.date(2026, 8, 27))
    _at(tmp_path, monkeypatch, sit, {"travel": {"pattern": "stays two days longer than booked"}})
    withpat = S.due_needs("t", dt.date(2026, 8, 27))
    assert plain and withpat
    assert withpat[0]["confidence"] > plain[0]["confidence"]
    assert "stays two days longer" in withpat[0]["action"]


def test_every_need_is_opening_shaped_and_carries_its_undo(tmp_path, monkeypatch):
    # a situation generates candidates; it never licenses skipping the gate
    import openings
    _at(tmp_path, monkeypatch, [{"id": "s1", "kind": "travel", "what": "orlando",
                                 "place": "Orlando", "start": "2026-08-28", "end": "",
                                 "receipt": "LGA to MCO", "confidence": 0.9}])
    for n in S.due_needs("t", dt.date(2026, 8, 27)):
        ok, why = openings.gate(n)
        assert ok, why


def test_situations_are_registered_as_an_openings_detector():
    src = (CLAIMS / "openings.py").read_text()
    assert "_situation_openings" in src and "situations.as_detector" in src
