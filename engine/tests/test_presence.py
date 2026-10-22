"""PRESENCE — is the member at the keyboard right now (8/28).

Sendblue's typing_indicator webhook fires the moment a contact starts or stops typing, off the
device, in real time. A handler for it has existed in the router for burst-flush control since
before today — it had simply never been REGISTERED with Sendblue, so it never once ran.

Every interruption law before this guessed at the moment: quiet hours, a daily budget, a read
receipt from twenty hours ago. This is the actual state of the person on the other end.
"""
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
ROUTER = REPO / "frame" / "homebase" / "router"
sys.path.insert(0, str(CLAIMS))

import presence  # noqa: E402


def _at(tmp_path, monkeypatch):
    monkeypatch.setattr(presence, "STATE", str(tmp_path / "p.json"))


def test_typing_starts_and_stops(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    presence.note("t", True)
    assert presence.typing("t")
    presence.note("t", False)
    assert not presence.typing("t")


def test_a_missing_stop_event_can_never_mute_co(tmp_path, monkeypatch):
    # webhooks go missing; a "started" with no "stopped" must expire on its own
    _at(tmp_path, monkeypatch)
    presence.note("t", True, at=time.time() - (presence.TYPING_TTL_S + 5))
    assert not presence.typing("t")
    assert presence.TYPING_TTL_S <= 120


def test_the_abandoned_draft_is_recorded(tmp_path, monkeypatch):
    # they wrote something and thought better of it — a signal that exists nowhere in words
    _at(tmp_path, monkeypatch)
    presence.note("t", True, at=time.time() - 200)
    presence.note("t", False, at=time.time() - (presence.DRAFT_WINDOW_S + 30))
    assert presence.abandoned("t")


def test_a_message_that_lands_was_not_abandoned(tmp_path, monkeypatch):
    _at(tmp_path, monkeypatch)
    presence.note("t", True, at=time.time() - 200)
    presence.note("t", False, at=time.time() - (presence.DRAFT_WINDOW_S + 30))
    presence.note_message("t")
    assert not presence.abandoned("t")


def test_co_does_not_talk_over_a_half_finished_sentence():
    tick = (CLAIMS / "proactive_tick.py").read_text()
    assert "presence.typing(tenant)" in tick
    assert "mid-sentence" in tick
    # and it holds BEFORE the read-receipt gate, which is a much older signal
    assert tick.index("presence.typing") < tick.index("_outbound_read_ok(phone)")


def test_presence_is_fed_by_the_handler_that_actually_receives_typing():
    # a second branch added inside handle_inbound would be dead code: handle_typing_signal
    # intercepts first, in do_POST
    r = (ROUTER / "sendblue_router.py").read_text()
    body = r.split("def handle_typing_signal")[1].split("\ndef ")[0]
    assert "_pr.note(tenant_of(sender), typing)" in body
    # handle_inbound may only mark a message as HAVING LANDED — it must not try to read typing
    # edges, because do_POST routes those away before it ever sees them
    inbound = r.split("def handle_inbound")[1].split("\ndef ")[0]
    assert "_pr.note_message" in inbound
    assert "_pr.note(" not in inbound      # typing edges never reach here; do_POST routes them away


def test_only_the_contacts_typing_counts_never_our_own_line():
    body = (ROUTER / "sendblue_router.py").read_text().split("def handle_typing_signal")[1].split("\ndef ")[0]
    assert "never fall back to from_number" in body
