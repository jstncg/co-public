"""Unit tests for co_dualwrite (the ingest-contract sender). No network: requests.post is mocked.

Run:  python3 -m unittest test_co_dualwrite -v
"""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import co_dualwrite as dw  # noqa: E402

ENV = {"CO_INGEST_URL": "https://co.example/api/ingest/sendblue", "CO_INGEST_TOKEN": "tok-123"}
TENANT = "+15551234567"


def _inline(fn):
    """Replace the fire-and-forget daemon thread with synchronous execution for assertions."""
    fn()


def _ok_response():
    r = mock.Mock()
    r.ok = True
    r.status_code = 200
    return r


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.spool = os.path.join(self.tmp.name, "spool.jsonl")
        self.archive = os.path.join(self.tmp.name, "archive.jsonl")
        for p in (mock.patch.object(dw, "SPOOL_PATH", self.spool),
                  mock.patch.object(dw, "ARCHIVE_PATH", self.archive),
                  mock.patch.object(dw, "_spawn", _inline)):
            p.start()
            self.addCleanup(p.stop)

    def spool_lines(self):
        if not os.path.exists(self.spool):
            return []
        with open(self.spool) as f:
            return [json.loads(ln) for ln in f.read().splitlines() if ln.strip()]


class TestDisabled(Base):
    """Disabled mode (no env vars) must be a strict no-op: requests is never touched."""

    def test_all_emitters_noop_without_env(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(dw.requests, "post") as post:
            dw.emit_inbound(TENANT, "MSG-1", "hey", [], "2026-07-20T18:51:23Z", [])
            dw.emit_outbound(TENANT, None, "yo", "2026-07-20T18:51:24Z")
            dw.emit_status(TENANT, "MSG-1", "READ")
        post.assert_not_called()
        self.assertFalse(os.path.exists(self.spool))

    def test_one_var_alone_is_still_disabled(self):
        for partial in ({"CO_INGEST_URL": ENV["CO_INGEST_URL"]},
                        {"CO_INGEST_TOKEN": ENV["CO_INGEST_TOKEN"]}):
            with mock.patch.dict(os.environ, partial, clear=True), \
                 mock.patch.object(dw.requests, "post") as post:
                self.assertFalse(dw.enabled())
                dw.emit_inbound(TENANT, "MSG-1", "hey", [], "2026-07-20T18:51:23Z", [])
            post.assert_not_called()


class TestEnvelopes(Base):
    def _emit(self, fn, *args, environment=None, **kw):
        with mock.patch.dict(os.environ, environment or ENV, clear=True), \
             mock.patch.object(dw.requests, "post", return_value=_ok_response()) as post:
            fn(*args, **kw)
        self.assertEqual(post.call_count, 1)
        (url,), kwargs = post.call_args
        return url, kwargs

    def test_inbound_envelope_matches_contract(self):
        artifacts = [{"source_type": "youtube", "canonical_url": "https://youtu.be/x",
                      "coverage": "full_media", "extraction": "This clip is about ...",
                      "timestamp_seconds": None, "junk_key": "never-on-the-wire"}]
        url, kwargs = self._emit(dw.emit_inbound, TENANT, "84052365-abc", "https://youtu.be/x",
                                 ["https://cdn/img.jpg"], "2026-07-20T18:51:23Z", artifacts)
        self.assertEqual(url, ENV["CO_INGEST_URL"])
        self.assertEqual(kwargs["timeout"], 5)
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer tok-123")
        env = kwargs["json"]
        self.assertEqual(env["idempotency_key"], "sendblue:84052365-abc")
        self.assertEqual(env["tenant_phone"], TENANT)
        self.assertEqual(env["transport"], "sendblue")
        self.assertEqual(env["direction"], "inbound")
        self.assertEqual(env["external_message_id"], "84052365-abc")
        self.assertEqual(env["external_thread_id"], TENANT)
        self.assertEqual(env["text"], "https://youtu.be/x")
        self.assertEqual(env["media_urls"], ["https://cdn/img.jpg"])
        self.assertEqual(env["sent_at"], "2026-07-20T18:51:23Z")
        self.assertIsNone(env["status"])
        self.assertIsNone(env["reply_to_external_id"])
        self.assertEqual(env["artifacts"], [{"source_type": "youtube",
                                             "canonical_url": "https://youtu.be/x",
                                             "coverage": "full_media",
                                             "extraction": "This clip is about ...",
                                             "timestamp_seconds": None}])
        self.assertEqual(env["transport_metadata"], {})

    def test_linq_envelope_keeps_provider_and_chat_identity(self):
        linq_env = {**ENV, "CO_RAIL": "linq"}
        _, kwargs = self._emit(
            dw.emit_inbound, TENANT, "L-1", "hello", [], "2026-07-20T18:51:23Z", [],
            transport="linq", external_thread_id="chat-1", environment=linq_env,
        )
        env = kwargs["json"]
        self.assertEqual(env["idempotency_key"], "linq:L-1")
        self.assertEqual(env["transport"], "linq")
        self.assertEqual(env["external_thread_id"], "chat-1")

    def test_linq_failure_uses_the_canonical_error_status(self):
        _, kwargs = self._emit(
            dw.emit_status, TENANT, "L-2", "ERROR", transport="linq",
            external_thread_id="chat-1", error_code="4006", environment={**ENV, "CO_RAIL": "linq"},
        )
        env = kwargs["json"]
        self.assertEqual(env["status"], "ERROR")
        self.assertEqual(env["transport_metadata"], {"error_code": "4006"})

    def test_outbound_envelope_and_sig_fallback(self):
        with mock.patch.object(dw.time, "time", return_value=1753036283.0):
            url, kwargs = self._emit(dw.emit_outbound, TENANT, None, "one earned sentence",
                                     "2026-07-20T18:52:00Z")
        env = kwargs["json"]
        expected_sig = hashlib.sha256(
            f"{TENANT}|outbound|one earned sentence|{int(1753036283.0 // 5)}".encode()).hexdigest()
        self.assertEqual(env["idempotency_key"], f"sendblue:sig:{expected_sig}")
        self.assertEqual(env["direction"], "outbound")
        self.assertIsNone(env["external_message_id"])
        self.assertEqual(env["text"], "one earned sentence")
        self.assertEqual(env["media_urls"], [])
        self.assertEqual(env["sent_at"], "2026-07-20T18:52:00Z")
        self.assertIsNone(env["status"])
        self.assertEqual(env["artifacts"], [])

    def test_sig_key_formula(self):
        # sha256(f"{tenant}|{direction}|{text}|{int(epoch//5)}") — exactly as specified.
        self.assertEqual(dw._sig("+1555", "inbound", "hi", epoch=1000.9),
                         hashlib.sha256("+1555|inbound|hi|200".encode()).hexdigest())

    def test_status_envelope_is_outbound_upsert_variant(self):
        url, kwargs = self._emit(dw.emit_status, TENANT, "MSG-9", "READ")
        env = kwargs["json"]
        self.assertEqual(env["idempotency_key"], "sendblue:MSG-9")
        self.assertEqual(env["direction"], "outbound")
        self.assertEqual(env["status"], "READ")
        self.assertEqual(env["text"], "")
        self.assertEqual(env["external_message_id"], "MSG-9")
        self.assertEqual(env["media_urls"], [])


class TestSpool(Base):
    def test_failure_spools_then_next_success_flushes(self):
        # 1) network down → the envelope lands in the spool, nothing raises.
        with mock.patch.dict(os.environ, ENV, clear=True), \
             mock.patch.object(dw.requests, "post", side_effect=OSError("net down")) as post:
            dw.emit_outbound(TENANT, None, "spooled reply", "2026-07-20T18:53:00Z")
        self.assertEqual(post.call_count, 1)
        spooled = self.spool_lines()
        self.assertEqual(len(spooled), 1)
        self.assertEqual(spooled[0]["text"], "spooled reply")
        self.assertTrue(spooled[0]["idempotency_key"].startswith("sendblue:sig:"))

        # 2) network back → next send flushes the spooled envelope FIRST, then its own.
        with mock.patch.dict(os.environ, ENV, clear=True), \
             mock.patch.object(dw.requests, "post", return_value=_ok_response()) as post:
            dw.emit_status(TENANT, "MSG-2", "DELIVERED")
        self.assertEqual(post.call_count, 2)
        first, second = post.call_args_list
        self.assertEqual(first.kwargs["json"], spooled[0])          # replayed verbatim
        self.assertEqual(second.kwargs["json"]["idempotency_key"], "sendblue:MSG-2")
        self.assertEqual(self.spool_lines(), [])                    # spool drained atomically

    def test_flush_stops_on_retry_and_keeps_lines(self):
        for i in range(3):
            dw._spool(dw._envelope("outbound", TENANT, f"M-{i}", f"t{i}"))
        with mock.patch.dict(os.environ, ENV, clear=True), \
             mock.patch.object(dw.requests, "post", side_effect=OSError("still down")) as post:
            dw._flush_spool()
        self.assertEqual(post.call_count, 1)                        # stopped at the first retry
        self.assertEqual(len(self.spool_lines()), 3)                # nothing lost


if __name__ == "__main__":
    unittest.main(verbosity=2)
