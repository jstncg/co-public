"""The rail toggle (9/2): CO_RAIL=linq carries the same bytes through the same gates on another
provider, and Linq's webhook becomes the payload shapes the Sendblue handlers already take.
Fixtures are Linq's documented example payloads; numbers are 555-range as the phone guard requires.
"""
import base64
import hashlib
import hmac
import os
import sys
from pathlib import Path

import pytest

CLAIMS = Path(__file__).resolve().parents[2] / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import rail  # noqa: E402

MEMBER = "+12025559876"
LINE = "+12025551234"
CHAT = "8f392755-6865-4b18-880a-227f9d8b458f"


@pytest.fixture(autouse=True)
def _own_chat_file(tmp_path, monkeypatch):
    monkeypatch.setattr(rail, "_LINQ_CHATS", str(tmp_path / "linq_chats.json"))


def _received(text="Hello!", media=None):
    parts = [{"type": "text", "value": text}]
    if media:
        parts.append({"type": "media", "url": media, "mime_type": "image/jpeg"})
    return {"event_type": "message.received",
            "data": {"chat": {"id": CHAT, "owner_handle": {"handle": LINE, "is_me": True}},
                     "id": "89e3566e-1d13-49e5-a8ee-48490d5bfeb7", "direction": "inbound",
                     "sender_handle": {"handle": MEMBER, "is_me": False}, "parts": parts}}


def test_toggle_defaults_to_sendblue_and_reads_env(monkeypatch):
    monkeypatch.delenv("CO_RAIL", raising=False)
    assert rail.provider() == "sendblue"
    monkeypatch.setenv("CO_RAIL", "linq")
    assert rail.provider() == "linq"


def test_public_number_follows_the_selected_carrier(monkeypatch):
    monkeypatch.setenv("SENDBLUE_FROM_NUMBER", "+15555550110")
    monkeypatch.setenv("LINQ_FROM_NUMBER", LINE)
    monkeypatch.setenv("CO_RAIL", "sendblue")
    assert rail.from_number() == "+15555550110"
    monkeypatch.setenv("CO_RAIL", "linq")
    assert rail.from_number() == LINE


def test_a_misspelled_rail_is_loud_not_silently_the_other_one(monkeypatch):
    """Hardened 9/3: a typo used to fall back to sendblue, which means a line nobody chose quietly
    carries the member's messages. Failing at startup beats sending on the wrong rail."""
    monkeypatch.setenv("CO_RAIL", "pigeon")
    with pytest.raises(ValueError, match="unsupported CO_RAIL"):
        rail.provider()


def test_first_send_goes_to_the_number_and_learns_the_chat(monkeypatch):
    calls = []

    def post(path, body, timeout=20):
        calls.append((path, body))
        return {"chat_id": CHAT, "message": {"id": "m-1", "delivery_status": "queued"}}

    monkeypatch.setattr(rail, "_linq_post", post)
    monkeypatch.setenv("LINQ_FROM_NUMBER", LINE)
    assert rail._send_linq(MEMBER, "hi there", "https://cdn/x.jpg") == (True, "m-1")
    path, body = calls[0]
    # With a line of our own named, the chat is created on THAT line — /messages auto-selects one,
    # which is the wrong primitive for a stable co identity.
    assert path == "/chats" and body["to"] == [MEMBER] and body["from"] == LINE
    assert body["message"]["parts"] == [{"type": "text", "value": "hi there"},
                                        {"type": "media", "url": "https://cdn/x.jpg"}]
    assert rail.linq_chat_for(MEMBER) == CHAT and rail.linq_phone_for(CHAT) == MEMBER
    assert os.stat(rail._LINQ_CHATS).st_mode & 0o777 == 0o600


def test_a_known_chat_is_sent_into_directly(monkeypatch):
    """9/2: the sandbox line can only carry replies inside a chat the member opened."""
    calls = []
    monkeypatch.setattr(rail, "_linq_post", lambda path, body, timeout=20: (calls.append((path, body)) or
                                                                             {"chat_id": CHAT, "message": {"id": "m-2"}}))
    rail.linq_event(_received())
    assert rail._send_linq(MEMBER, "back at you") == (True, "m-2")
    path, body = calls[0]
    assert path == f"/chats/{CHAT}/messages" and "to" not in body and "from" not in body


def test_mark_read_needs_a_paired_chat(monkeypatch):
    calls = []
    monkeypatch.setattr(rail, "_linq_post", lambda path, body, timeout=20: calls.append(path) or {})
    assert rail.linq_mark_read(MEMBER) is False
    rail.linq_event(_received())
    assert rail.linq_mark_read(MEMBER) is True and calls == [f"/chats/{CHAT}/read"]


def test_send_without_a_key_is_a_refusal_not_a_lie(monkeypatch):
    monkeypatch.delenv("LINQ_API_KEY", raising=False)
    ok, why = rail._send_linq(MEMBER, "hi")
    assert ok is False and "LINQ_API_KEY" in why


def test_received_becomes_the_inbound_payload():
    kind, p = rail.linq_event(_received("Hello!", media="https://cdn.linqapp.com/a/photo.jpg"))
    assert kind == "message"
    assert p["from_number"] == MEMBER and p["content"] == "Hello!"
    assert p["media_url"] == ["https://cdn.linqapp.com/a/photo.jpg"]
    assert p["message_handle"] == "89e3566e-1d13-49e5-a8ee-48490d5bfeb7"
    assert rail.linq_phone_for(CHAT) == MEMBER


def test_delivered_and_read_become_status_for_that_chats_member():
    rail.linq_event(_received())
    for et, status in (("message.delivered", "DELIVERED"), ("message.read", "READ")):
        kind, p = rail.linq_event({"event_type": et, "data": {"chat": {"id": CHAT}, "id": "m-9",
                                                              "direction": "outbound"}})
        assert kind == "status"
        # A subset, not the whole dict: the payload grows as the rail learns more about a send, and
        # a test that pins every key just breaks whenever someone adds one.
        assert {"number": MEMBER, "status": status, "message_handle": "m-9",
                "is_outbound": True}.items() <= p.items()


def test_failed_carries_its_message_id():
    kind, p = rail.linq_event({"event_type": "message.failed",
                               "data": {"chat_id": CHAT, "message_id": "m-7", "code": 4006,
                                        "reason": "timed out"}})
    assert kind == "status" and p["status"] == "ERROR" and p["message_handle"] == "m-7"
    assert p["error_code"] == "4006" and p["transport"] == "linq"


def test_typing_in_a_one_to_one_chat_is_the_member(monkeypatch):
    """Measured 9/2: co POSTed typing to its own chat and Linq echoed nothing back. So the only
    hands that can raise this event in a two-person chat are theirs."""
    monkeypatch.setenv("LINQ_FROM_NUMBER", LINE)
    started = {"event_type": "chat.typing_indicator.started", "data": {"chat_id": CHAT}}
    assert rail.linq_event(started) is None, "an unknown chat cannot be attributed either"
    rail.linq_event(_received())
    kind, p = rail.linq_event(started)
    assert kind == "typing" and p == {"number": MEMBER, "is_typing": True, "from_number": LINE}
    _, p = rail.linq_event({"event_type": "chat.typing_indicator.stopped", "data": {"chat_id": CHAT}})
    assert p["is_typing"] is False


def test_typing_in_a_group_is_dropped():
    """Linq's own docs: in a group you learn someone is typing, not who. Naming one of them would
    be a guess, and the burst hold would then wait on a person who is not writing to co."""
    ev = _received()
    ev["data"]["chat"]["is_group"] = True
    rail.linq_event(ev)
    assert rail.linq_is_group(CHAT) is True
    assert rail.linq_event({"event_type": "chat.typing_indicator.started",
                            "data": {"chat_id": CHAT}}) is None
    assert rail.linq_chat_for(MEMBER) == "", "a future private reply must never route into a group"


def test_a_chat_that_stops_being_a_group_stops_being_dropped():
    ev = _received()
    ev["data"]["chat"]["is_group"] = True
    rail.linq_event(ev)
    rail.linq_event(_received())                     # same chat, now reported one-to-one
    assert rail.linq_is_group(CHAT) is False
    assert rail.linq_event({"event_type": "chat.typing_indicator.started",
                            "data": {"chat_id": CHAT}})[0] == "typing"


def test_reaction_added_by_the_member_only():
    ev = {"event_type": "reaction.added", "data": {"chat_id": CHAT, "message_id": "m-3",
                                                   "reaction_type": "love", "is_from_me": False, "from": MEMBER}}
    kind, p = rail.linq_event(ev)
    assert kind == "reaction" and p == {"from_number": MEMBER, "reaction": "love", "message_handle": "m-3"}
    ev["data"]["is_from_me"] = True
    assert rail.linq_event(ev) is None
    assert rail.linq_event({"event_type": "reaction.removed", "data": ev["data"]}) is None


def test_events_co_has_no_use_for_are_none():
    assert rail.linq_event({"event_type": "payment.succeeded", "data": {}}) is None
    assert rail.linq_event({}) is None


# The clock is passed in rather than read, so these never depend on the wall time they run at.
NOW = 9000.0
KEY = b"kqzvxhbtmpcnwjlrgsdfyaeouiKQZVXH"
SECRET = "whsec_" + base64.b64encode(KEY).decode()
RAW = b'{"event_type":"message.received"}'


def _signed(ts: str):
    mac = hmac.new(KEY, f"evt_1.{ts}.".encode() + RAW, hashlib.sha256).digest()
    return {"webhook-id": "evt_1", "webhook-timestamp": ts,
            "webhook-signature": "v1," + base64.b64encode(mac).decode()}


def test_verify_accepts_the_documented_signature_and_nothing_else():
    headers = _signed("9000")
    assert rail.linq_verify(SECRET, headers, RAW, now=NOW)
    assert rail.linq_verify(SECRET, {**headers, "webhook-signature": "v1,AAAA"}, RAW, now=NOW) is False
    assert rail.linq_verify(SECRET, headers, RAW + b" ", now=NOW) is False
    assert rail.linq_verify("", headers, RAW, now=NOW) is False


def test_a_correctly_signed_replay_from_last_hour_is_still_refused():
    """Hardened 9/3: a valid signature is not enough, it has to be recent. Five-minute window."""
    stale = _signed("5000")                       # 4000 seconds before NOW
    assert rail.linq_verify(SECRET, stale, RAW, now=NOW) is False
    fresh = _signed("8800")                       # 200 seconds before NOW
    assert rail.linq_verify(SECRET, fresh, RAW, now=NOW) is True


def test_legacy_webhook_version_is_normalized_without_forking_handlers():
    event = {
        "event_type": "message.received",
        "data": {
            "chat_id": CHAT,
            "from": MEMBER,
            "from_handle": {"handle": MEMBER, "is_me": False},
            "is_group": False,
            "message": {"id": "legacy-1", "parts": [{"type": "text", "value": "old shape"}]},
        },
    }
    kind, payload = rail.linq_event(event)
    assert kind == "message"
    assert payload["content"] == "old shape" and payload["message_handle"] == "legacy-1"
    assert payload["external_thread_id"] == CHAT and payload["transport"] == "linq"


def test_typing_and_react_report_failure_instead_of_raising(monkeypatch):
    monkeypatch.delenv("LINQ_API_KEY", raising=False)
    assert rail.linq_typing(MEMBER) is False
    rail._chats_note(MEMBER, CHAT)
    assert rail.linq_typing(MEMBER) is False
    assert rail.linq_react("m-1", "love") is False
    assert rail.linq_react("", "love") is False
