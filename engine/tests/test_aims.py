"""AIMS — standing wants, and the quiet work of serving them (8/27).

An implied want is something said more than once and never acted on. Mining the founder's own
corpus showed detection was never the gap: two of his wants were already sitting in co's entity
store, described accurately, doing nothing, while his list held zero items. What was missing is
the thing that turns a noticed want into an aim with acts hanging off it.

The nudge is legitimate on three enforced properties: aims are quoted VERBATIM from the member,
VISIBLE to them, and REMOVABLE. Co may never invent one, and never hold one they dropped.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import aims  # noqa: E402


def _at(tmp_path, monkeypatch):
    monkeypatch.setattr(aims, "_path", lambda t: str(tmp_path / f"{t}.json"))


def test_rare_signal_is_filtered_before_it_is_windowed():
    # third time today. the corpus ran 46k chars, a 30k tail was taken, and the most explicit
    # want in the record — "I need to exercise more" at item 167 of 627 — fell outside it.
    src = (CLAIMS / "aims.py").read_text()
    body = src.split("def mine")[1].split("\ndef ")[0]
    assert "WANT_RE.search(m)" in body                     # filter...
    assert body.index("wanting") < body.index("ask_json")   # ...before the window reaches the model
    assert aims.WANT_RE.search("I need to exercise more. Really hit the gym")
    assert not aims.WANT_RE.search("shipped the router change today")


def test_a_quote_about_someone_else_is_not_their_aim():
    # containment proves the words exist; it does not prove they are about the speaker. The first
    # live run turned "he's growing his own network into venture" into one of his own aims.
    assert not aims.FIRST_PERSON.search("he's growing his own network into venture")
    assert aims.FIRST_PERSON.search("I want to think more first principles")
    assert aims.FIRST_PERSON.search("my posture is so bad right now")


def test_an_unquotable_aim_is_invented_and_never_ships():
    corpus = "i need to exercise more. really hit the gym."
    assert aims._grounded("i need to exercise more", corpus)
    assert not aims._grounded("he wants to become a better founder", corpus)
    assert not aims._grounded("short", corpus)              # a fragment is not a quote


def test_every_aim_names_an_act_that_can_serve_it():
    # an aim co cannot serve is a horoscope, which is what stops the miner returning "be happier"
    assert set(aims.SERVICE) == {"time", "material", "practice", "people"}
    for k in aims.SERVICE:
        assert k in aims.MINE_SYS


def test_relationships_get_occasions_never_reminders():
    # "you haven't called your brother in six weeks" is a guilt delivery: it adds debt to the
    # thing and makes them worse at it
    assert "occasions" in aims.SERVICE["people"] and "never reminders" in aims.SERVICE["people"]
    assert "manufacture an occasion, never a reminder" in aims.MINE_SYS.replace("\n", " ") \
        or "never a reminder" in " ".join(aims.MINE_SYS.split())


def test_a_dropped_aim_stays_dropped(tmp_path, monkeypatch):
    # mine() reads the same corpus forever; a correction it can undo is not a correction
    _at(tmp_path, monkeypatch)
    aims.save("t", {"aims": [{"id": "a1", "aim": "x", "service": "time"}], "dropped": []})
    assert aims.drop("t", "a1")
    assert aims.load("t")["dropped"] == ["a1"]
    assert aims.live("t") == []


def test_a_member_cannot_be_aimed_at_ten_things():
    assert aims.MAX_AIMS <= 6


def test_serving_an_aim_outranks_an_equally_good_act_that_does_not(tmp_path, monkeypatch):
    # the long-horizon term: it makes co's bets correlated instead of independent
    _at(tmp_path, monkeypatch)
    aims.save("t", {"aims": [{"id": "a1", "aim": "exercise more cardio gym", "why": "posture",
                              "service": "practice"}], "dropped": []})
    assert aims.serves("t", "hold an hour for cardio at the gym")     # gym is 3 chars and vital
    assert aims.serves("t", "reply to the invoice") is None
    assert aims.AIM_BONUS > 0


def test_the_long_horizon_term_is_wired_into_ranking():
    src = (CLAIMS / "openings.py").read_text()
    body = src.split("def expected")[1].split("\ndef ")[0]
    assert "aims.serves" in body and "AIM_BONUS" in body


def test_every_ambient_move_is_silent_and_carries_its_undo(tmp_path, monkeypatch):
    # ambient means the member meets a changed condition, not a request
    _at(tmp_path, monkeypatch)
    aims.save("t", {"aims": [{"id": s, "aim": f"aim {s}", "service": s} for s in aims.SERVICE],
                    "dropped": []})
    moves = aims.ambient("t")
    assert len(moves) == len(aims.SERVICE)
    assert all(m["silent"] and m["undo"] for m in moves)


def test_the_nudge_line_is_stated_in_the_source():
    src = (CLAIMS / "aims.py").read_text()
    assert "goals they did not choose or" in src
    assert "STRONGEST NUDGE IS A DEFAULT" in src
    assert "blind spot" in src.lower()          # family is unreachable by text mining
