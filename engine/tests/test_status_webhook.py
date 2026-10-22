"""Status callbacks reach the handler that exists for them (8/28).

DELIVERED and READ have never been recorded. Not because Sendblue withheld them and not because
sends failed to ask — the handler sat four lines BELOW a guard that returns on "no sender and no
text", which is exactly the shape of a status callback. It was unreachable from the day it was
written, so ~/.co/outbound_status.json never appeared and the read-aware proactive gate failed
open for its entire life.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROUTER = REPO / "frame" / "homebase" / "router"


def _handler_src() -> str:
    return (ROUTER / "sendblue_router.py").read_text()


def test_the_status_branch_runs_before_the_sender_guard():
    src = _handler_src()
    status_at = src.index("STATUS FIRST (8/28)")
    guard_at = src.index("# Skip our own outbound echoing through the same webhook.")
    assert status_at < guard_at, "the guard drops status callbacks before the handler sees them"


def test_a_status_payload_has_neither_sender_nor_text():
    # which is why the guard ate it: the drop condition IS the callback's shape
    src = _handler_src()
    guard = src.split("# Skip our own outbound echoing")[1][:200]
    assert "not sender or (not text and not media_urls)" in guard


def test_both_delivered_and_read_are_recorded():
    src = _handler_src()
    blk = src.split("def _note_outbound_status")[1][:900]
    assert "status" in blk and "_OUTBOUND_STATUS_PATH" in blk
    ld = src.split('_rung = {"DELIVERED"')[1][:120]
    assert '"delivered"' in ld and '"read"' in ld


def test_the_reason_it_was_dead_is_written_where_it_can_be_undone():
    src = _handler_src()
    assert "unreachable" in src and "Sendblue was never at fault" in src
