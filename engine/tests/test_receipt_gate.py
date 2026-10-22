"""The receipt gate is law (8/22, epistemic-governance ws1): no outbound claims an action
without a machine-checkable receipt. The sev-0 it exists for: co telling the founder a
reminder was set when nothing was persisted, and sending members to a notes app it cannot
write. Held is held; only a crash inside the gate fails open."""
import datetime as dt
import json
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "frame" / "claims"))

import receipts  # noqa: E402


def _db(tmp_path, anchors=None, watches=0):
    db = tmp_path / f"claims_t{watches}_{len(anchors or [])}.db"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE IF NOT EXISTS watches (id INTEGER PRIMARY KEY, what TEXT, "
              "kind TEXT, target TEXT, status TEXT)")
    for i in range(watches):
        c.execute("INSERT INTO watches (what, kind, target, status) VALUES (?,?,?,?)",
                  (f"w{i}", "price", "x", "active"))
    c.commit()
    c.close()
    if anchors is not None:
        Path(f"{db}.anchors.json").write_text(json.dumps({"anchors": anchors}))
    return str(db)


def test_notes_app_claim_is_never_provable(tmp_path):
    for lie in ("added it to your notes app", "i've saved that in your Apple Notes",
                "check your reminders app when you get a sec", "it's in your calendar"):
        ok, why = receipts.gate(lie, _db(tmp_path))
        assert not ok, lie
        assert why


def test_reminder_claim_needs_an_anchor_row(tmp_path):
    claim = "reminder set for 9am"
    ok, _ = receipts.gate(claim, _db(tmp_path, anchors=[]))
    assert not ok
    fresh = [{"what": "x", "fired": True, "created": dt.datetime.now().isoformat()}]
    ok, _ = receipts.gate(claim, _db(tmp_path, anchors=fresh))
    assert ok
    pending = [{"what": "x", "fired": False, "created": "2026-01-01T00:00:00"}]
    ok, _ = receipts.gate(claim, _db(tmp_path, anchors=pending))
    assert ok


def test_watch_claim_needs_an_active_watch(tmp_path):
    claim = "i'll keep an eye on the price"
    ok, _ = receipts.gate(claim, _db(tmp_path))
    assert not ok
    ok, _ = receipts.gate(claim, _db(tmp_path, watches=1))
    assert ok


def test_plain_speech_passes_untouched(tmp_path):
    db = _db(tmp_path)
    for fine in ("bet, talk tomorrow", "that video was worth the 40 minutes",
                 "what time does the flight land?", "noted. go get it",
                 "remind me what she said about the studio?"):
        ok, why = receipts.gate(fine, db)
        assert ok, (fine, why)


def test_missing_db_gates_only_the_unprovable(tmp_path):
    ok, _ = receipts.gate("added it to your notes app", None)
    assert not ok
    ok, _ = receipts.gate("reminder set for 9am", str(tmp_path / "nope.db"))
    assert ok  # no store to check against — the claim classes that need rows stay open


def test_every_send_door_wears_the_gate():
    router = (REPO / "frame" / "homebase" / "router" / "sendblue_router.py").read_text()
    assert router.count("receipts.gate(") >= 1
    assert "_rg.gate(" in router                 # the app door
    assert "receipts.gate(" in (REPO / "frame" / "claims" / "rail.py").read_text()
