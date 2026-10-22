"""One thought, one reply — however many bubbles it arrived in.

9/2, live: the member sent "I think Gio is just referring to RetardMaxxing tho", co spent 25s
composing, and while it composed they sent the rest of the sentence, "which chamath is a fan of".
Two turns, two replies, one sentence. The 7s burst window cannot reach that case — the second half
lands long after any window would have shut, because composing is slower than typing.

These pin the rule that does reach it: a reply that has been overtaken does not go, its text is
handed to the burst now forming, and the next turn answers the whole thought once.
"""
import os
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import sendblue_router as router

MEMBER = "+15551000200"
KEY = router._norm(MEMBER)


class BurstMerging(unittest.TestCase):
    def setUp(self):
        for d in (router._bursts, router._inflight, router._last_reply_at, router._typing_at):
            d.clear()
        patch = mock.patch.object(threading, "Timer")     # windows never fire on their own here
        self.timer = patch.start()
        self.addCleanup(patch.stop)
        self.turns = []
        proc = mock.patch.object(router, "_process",
                                 side_effect=lambda sender, text, media, t0, handle="", burst_n=1,
                                 transport_name="", external_thread_id="": self.turns.append({
                                     "text": text, "media": media, "burst_n": burst_n,
                                     "transport": transport_name, "thread": external_thread_id,
                                 }))
        proc.start()
        self.addCleanup(proc.stop)

    def send(self, text, media=None, handle=""):
        router._buffer_burst(MEMBER, text, media or [], time.time(), handle)

    def test_two_messages_inside_the_window_are_one_turn(self):
        self.send("i think gio means retardmaxxing tho")
        self.send("which chamath is a fan of")
        router._flush_burst(KEY)
        self.assertEqual(len(self.turns), 1)
        self.assertEqual(self.turns[0]["text"],
                         "i think gio means retardmaxxing tho\nwhich chamath is a fan of")
        self.assertEqual(self.turns[0]["burst_n"], 2)      # "two back to back" survives the join

    def test_a_message_mid_compose_overtakes_the_reply_and_hands_over_its_text(self):
        self.send("i think gio means retardmaxxing tho")
        router._flush_burst(KEY)                            # the turn begins and ends inside this
        self.assertEqual(len(self.turns), 1)

        router._turn_begins(KEY, "i think gio means retardmaxxing tho")   # now it is composing
        self.send("which chamath is a fan of")
        self.assertTrue(router._superseded(KEY), "the reply in flight must be marked overtaken")
        self.assertEqual(router._bursts[KEY]["texts"],
                         ["i think gio means retardmaxxing tho", "which chamath is a fan of"])

        router._turn_ends(KEY)
        router._flush_burst(KEY)
        self.assertEqual(self.turns[-1]["text"],
                         "i think gio means retardmaxxing tho\nwhich chamath is a fan of")

    def test_the_overtaken_text_is_handed_over_exactly_once(self):
        router._turn_begins(KEY, "first half")
        self.send("second")
        self.send("third")
        self.assertEqual(router._bursts[KEY]["texts"], ["first half", "second", "third"])

    def test_a_turn_that_already_replied_is_not_overtaken(self):
        """Back-to-back asks, each already answered, must stay two turns. Merging a replied-to
        message into the next one makes co answer it twice (the eval caught exactly this)."""
        router._turn_begins(KEY, "remind me tomorrow at 4pm to call the plumber")
        self.assertTrue(router._claim_send(KEY))
        self.send("my wrapped")
        self.assertFalse(router._superseded(KEY))
        self.assertEqual(router._bursts[KEY]["texts"], ["my wrapped"])

    def test_the_claim_is_refused_once_the_reply_is_overtaken(self):
        router._turn_begins(KEY, "half a thought")
        self.send("the rest of it")
        self.assertFalse(router._claim_send(KEY), "an overtaken reply must not go out")

    def test_an_untracked_turn_always_sends(self):
        """The app and the proactive lanes have no burst turn; they must never be held."""
        router._inflight.clear()
        self.assertTrue(router._claim_send(KEY))

    def test_a_finished_turn_leaves_nothing_to_overtake(self):
        router._turn_begins(KEY, "done with this one")
        router._turn_ends(KEY)
        self.send("a genuinely new thing")
        self.assertFalse(router._superseded(KEY))
        self.assertEqual(router._bursts[KEY]["texts"], ["a genuinely new thing"])

    def test_a_media_burst_still_counts_every_piece(self):
        self.send("look at these")
        self.send("", media=["https://cdn/1.jpg", "https://cdn/2.jpg"])
        router._flush_burst(KEY)
        self.assertEqual(self.turns[0]["burst_n"], 3)

    def test_the_burst_keeps_provider_and_thread_provenance(self):
        router._buffer_burst(MEMBER, "through linq", [], time.time(), "message-1",
                             "linq", "chat-1")
        router._flush_burst(KEY)
        self.assertEqual(self.turns[0]["transport"], "linq")
        self.assertEqual(self.turns[0]["thread"], "chat-1")


class ProviderWebhookDedup(unittest.TestCase):
    def setUp(self):
        router._sb_seen.clear()

    def test_the_external_message_id_survives_the_five_second_content_bucket(self):
        with mock.patch.object(router, "_sb_seen_save"):
            self.assertTrue(router.claim_inbound_handle("linq-message-1"))
            self.assertFalse(router.claim_inbound_handle("linq-message-1"))
            self.assertTrue(router.claim_inbound_handle("linq-message-2"))


class ContinuationWindow(unittest.TestCase):
    def setUp(self):
        router._last_reply_at.clear()
        router._inflight.clear()

    def test_a_message_they_could_not_have_read_yet_is_a_continuation(self):
        self.assertIsNone(router._continuation(KEY))
        router._claim_send(KEY)
        hint = router._continuation(KEY)
        self.assertIsNotNone(hint)
        self.assertIn("still typing", hint)

    def test_an_ordinary_fast_answer_is_not_a_continuation(self):
        router._claim_send(KEY)
        with mock.patch.object(router, "CONTINUATION_S", 0.0):
            self.assertIsNone(router._continuation(KEY),
                              "a member who read the reply and answered is having a conversation")


class TheFunnelsConsultIt(unittest.TestCase):
    """Every reply leaves through timed_send and enters the record through record_turn. A new
    branch that sends around either is the way this regresses, so both are pinned here."""

    def setUp(self):
        import inspect
        self.src = inspect.getsource(router._co_reply)

    def _nested(self, name):
        """The body of one nested def, to the start of the next one."""
        return self.src.split(f"def {name}")[1].split("\n    def ")[0]

    def test_the_send_funnel_holds_an_overtaken_reply(self):
        self.assertIn("_claim_send(burst_key)", self._nested("timed_send"))

    def test_the_record_funnel_refuses_to_write_an_unsent_reply(self):
        self.assertIn("overtaken()", self._nested("record_turn"))

    def test_sending_claims_the_turn_atomically(self):
        self.assertIn("_claim_send(burst_key)", self.src)

    def test_both_hint_paths_open_with_the_continuation(self):
        self.assertEqual(self.src.count("hint = continuation"), 2, "text path and content path")
        self.assertNotIn("hint = None", self.src)


if __name__ == "__main__":
    unittest.main()
