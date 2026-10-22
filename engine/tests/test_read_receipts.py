"""Read receipts reach the gate that needs them (8/26).

The read-aware proactive gate (_outbound_read_ok) holds organic sends while the last outbound
sits unread. It failed open for months because ~/.co/outbound_status.json was never written:
Sendblue only posts DELIVERED/READ when a send ASKS via status_callback, the router's send has
asked since 7/31, and every proactive organ sends through daily_text._sendblue — which didn't.
The gate built to hold proactive sends was starved by the proactive sends it was built to hold.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
ROUTER = REPO / "frame" / "homebase" / "router"
sys.path.insert(0, str(CLAIMS))


def test_both_send_paths_ask_for_status_callbacks():
    # one path asking is the bug: the ledger stays empty for whichever path is silent
    for p in (CLAIMS / "rail.py", ROUTER / "sendblue_router.py"):
        assert "status_callback" in p.read_text(), f"{p.name} never asks for delivery status"


def test_the_proactive_path_builds_the_callback_from_env_not_a_literal():
    body = (CLAIMS / "rail.py").read_text().split("status_callback")[0][-500:]
    assert "WEBHOOK_PUBLIC_URL" in body and "WEBHOOK_TOKEN" in body


def test_the_gate_fails_open_when_no_receipt_has_ever_arrived(tmp_path, monkeypatch):
    # a missing ledger must never mute the product — silence is the wrong failure direction
    import proactive_tick as pt
    monkeypatch.setattr(pt, "OUTBOUND_STATUS_PATH", tmp_path / "absent.json")
    assert pt._outbound_read_ok("+15550001111") is True


def test_an_unread_outbound_holds_organic_sends(tmp_path, monkeypatch):
    import json
    import time
    import proactive_tick as pt
    p = tmp_path / "status.json"
    p.write_text(json.dumps({"+15550001111": {"status": "DELIVERED", "ts": time.time()}}))
    monkeypatch.setattr(pt, "OUTBOUND_STATUS_PATH", p)
    assert pt._outbound_read_ok("+15550001111") is False       # delivered, not read → wait
    p.write_text(json.dumps({"+15550001111": {"status": "READ", "ts": time.time()}}))
    assert pt._outbound_read_ok("+15550001111") is True


def test_an_old_unread_stops_holding_forever(tmp_path, monkeypatch):
    import json
    import time
    import proactive_tick as pt
    p = tmp_path / "status.json"
    old = time.time() - (pt.UNREAD_HOLD_HOURS + 1) * 3600
    p.write_text(json.dumps({"+15550001111": {"status": "DELIVERED", "ts": old}}))
    monkeypatch.setattr(pt, "OUTBOUND_STATUS_PATH", p)
    assert pt._outbound_read_ok("+15550001111") is True        # one unread cannot mute co forever
