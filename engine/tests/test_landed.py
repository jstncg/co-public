"""LANDED — the one table that says whether a message did anything (8/27).

Co had no definition of better. The eval measures laws held, the tests measure source laws, and
neither measures quality — so every improvement came from a human reading data and editing files.
This is the table that ends that: every send is a bet, every signal is evidence, and the lane is
what makes it answerable which lanes deserve to exist.
"""
import datetime as dt
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
ROUTER = REPO / "frame" / "homebase" / "router"
sys.path.insert(0, str(CLAIMS))

import landed  # noqa: E402


def _at(tmp_path, monkeypatch):
    monkeypatch.setattr(landed, "_path", lambda t: str(tmp_path / f"{t}.jsonl"))


def test_a_send_starts_at_sent_and_evidence_moves_it_up(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    rid = landed.record("t", "five slots opened at 2. you have the 3:30.", lane="moment")
    assert landed.fold("t")[0]["rung"] == "sent"
    landed.signal("t", "read", rid=rid)
    assert landed.fold("t")[0]["rung"] == "read"


def test_evidence_never_moves_backwards(tmp_path, monkeypatch):
    # a DELIVERED callback arriving after a reply must not demote the row
    _at(tmp_path, monkeypatch)
    rid = landed.record("t", "x", lane="moment")
    landed.signal("t", "acted", rid=rid)
    landed.signal("t", "delivered", rid=rid)
    assert landed.fold("t")[0]["rung"] == "acted"


def test_signals_join_by_message_handle_when_there_is_no_id(tmp_path, monkeypatch):
    # the status webhook knows the handle, never co's row id
    _at(tmp_path, monkeypatch)
    landed.record("t", "x", lane="daily_finds", handle="H123")
    landed.signal("t", "read", handle="H123")
    assert landed.fold("t")[0]["rung"] == "read"


def test_the_ledger_is_append_only(tmp_path, monkeypatch):
    # the router already lost its history once to a last-status-per-number map
    _at(tmp_path, monkeypatch)
    rid = landed.record("t", "x", lane="moment")
    landed.signal("t", "read", rid=rid)
    rows = [json.loads(x) for x in open(tmp_path / "t.jsonl")]
    assert [r["t"] for r in rows] == ["send", "sig"]


def test_the_lane_is_derived_so_no_caller_can_forget(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    landed.record("t", "x")                       # no lane passed
    assert landed.fold("t")[0]["lane"] == "test_landed"   # this module sent it


def test_stats_answer_which_lanes_deserve_to_exist(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    a = landed.record("t", "a", lane="moment")
    landed.record("t", "b", lane="moment")
    landed.signal("t", "acted", rid=a)
    for i in range(4):
        landed.record("t", f"f{i}", lane="daily_finds")
    st = landed.stats("t")
    assert st["moment"]["act_rate"] == 0.5
    assert st["daily_finds"]["act_rate"] == 0.0   # four sends, nothing came back


def test_a_late_reply_is_a_new_conversation_not_a_response(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    landed.record("t", "x", lane="moment")
    assert landed.note_reply("t") is True
    assert landed.REPLY_WINDOW_MIN <= 120
    late = dt.datetime.now() + dt.timedelta(minutes=landed.REPLY_WINDOW_MIN + 5)
    landed.record("t", "y", lane="moment")
    assert landed.note_reply("t", when=late) is False


def test_bookkeeping_can_never_break_a_send(tmp_path, monkeypatch):
    # an unwritable ledger must lose the row, never the message
    monkeypatch.setattr(landed, "_path", lambda t: "/nonexistent-dir/x.jsonl")
    assert landed.record("t", "x", lane="moment")          # returns an id, does not raise
    landed.signal("t", "read", rid="whatever")


def test_every_send_path_writes_to_the_ledger():
    assert "landed.record" in (CLAIMS / "rail.py").read_text()   # one door since 8/31
    router = (ROUTER / "sendblue_router.py").read_text()
    assert "_ld.signal" in router and "_ld.note_reply" in router


def test_a_tapback_counts_as_acted_and_a_dislike_does_not():
    """9/2: one function serves both providers (Sendblue's text fallback, Linq's reaction.added)."""
    router = (ROUTER / "sendblue_router.py").read_text()
    blk = router.split("cheapest possible")[1][:700]
    assert '"replied" if kind.lower().startswith("dislike") else "acted"' in blk
    assert router.count("note_inbound_reaction(") >= 3      # the def and both providers' calls


# ── the objective function ────────────────────────────────────────────────────────────────────

def test_reading_is_worth_nothing(tmp_path, monkeypatch):
    # the unusual choice, and the whole point: information that changed nothing is worth exactly
    # as much as no information, however well written
    assert landed.VALUE["read"] == 0.0
    assert landed.VALUE["delivered"] == 0.0
    assert landed.VALUE["acted"] > landed.VALUE["replied"] > 0


def test_a_send_that_lands_nowhere_is_negative(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    landed.record("t", "a generic find", lane="daily_finds")
    assert landed.objective("t")["total"] < 0          # it cost attention and caused nothing


def test_silence_beats_an_undone_act(tmp_path, monkeypatch):
    # undo is not neutral: it spent attention AND made work. zero must beat it.
    _at(tmp_path, monkeypatch)
    rid = landed.record("t", "booked the thing", lane="moment")
    landed.signal("t", "acted", rid=rid)
    landed.signal("t", "undone", rid=rid)
    assert landed.objective("t")["total"] < 0
    assert landed.UNDONE < 0


def test_you_cannot_win_by_sending_more(tmp_path, monkeypatch):
    # the anti-gaming property: volume is the cost term, so the only direction up is precision
    _at(tmp_path, monkeypatch)
    for i in range(20):
        landed.record("t", f"find {i}", lane="daily_finds")
    many = landed.objective("t")["total"]
    _at(tmp_path, monkeypatch)
    (tmp_path / "t.jsonl").unlink(missing_ok=True)
    rid = landed.record("t", "one that mattered", lane="moment")
    landed.signal("t", "acted", rid=rid)
    assert landed.objective("t")["total"] > many


def test_an_answer_costs_less_than_an_interruption():
    assert landed.COST["proactive"] > landed.COST["requested"] > landed.COST["act"] == 0.0


def test_the_default_kind_is_the_expensive_one(tmp_path, monkeypatch):
    # assuming a send was free is how a cost term quietly stops working
    _at(tmp_path, monkeypatch)
    landed.record("t", "x", lane="moment")
    assert landed.fold("t")[0]["kind"] == "proactive"


def test_the_ledger_names_lanes_that_should_be_deleted(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    for i in range(5):
        landed.record("t", f"f{i}", lane="daily_finds")
    rid = landed.record("t", "read", lane="moment")
    landed.signal("t", "acted", rid=rid)
    ob = landed.objective("t")
    assert "daily_finds" in ob["negative"] and "moment" not in ob["negative"]


def test_a_held_send_scores_nothing_either_way(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    landed.hold_out("t", "daily_finds", "the one co chose not to send")
    ob = landed.objective("t")
    assert ob["sends"] == 0 and ob["total"] == 0.0
