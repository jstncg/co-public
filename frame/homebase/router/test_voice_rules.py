"""The voice rules, held mechanically (8/7 founder session).

Each of these was a live complaint, and each one had already been written into prompt prose that the
model was free to lose. Prose asks; these assert. If one fails, the behavior it names is back.
"""
import inspect
import json
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import sendblue_router as router
import co_react
import disposition
import rail
from disposition import dedash


def sent_content(text):
    """What Sendblue actually receives for `text` — the belt's output, read off the wire."""
    with mock.patch.object(router.requests, "post") as post:
        post.return_value = mock.Mock(status_code=200, raise_for_status=mock.Mock())
        router.sendblue_send("+15555550123", text)
    return post.call_args.kwargs["json"]["content"]


class OutboundIsSanitized(unittest.TestCase):
    """Every outbound word passes through sendblue_send, so the belt goes there and nowhere else."""

    _sent_content = staticmethod(sent_content)

    def test_em_dash_never_reaches_the_wire(self):
        self.assertEqual(self._sent_content("i pulled it up — here it is"),
                         "i pulled it up, here it is")

    def test_ascii_surrogate_never_reaches_the_wire(self):
        self.assertEqual(self._sent_content("one thing -- another"), "one thing, another")

    def test_ordinary_text_is_untouched(self):
        self.assertEqual(self._sent_content("bet, i'll ping you in 20"), "bet, i'll ping you in 20")

    def test_blank_line_bubble_split_survives(self):
        """A blank line is how one reply becomes two text messages (brain.ts). Collapsing it here
        would silently merge every two-beat reply into one bubble."""
        self.assertEqual(self._sent_content("first beat\n\nsecond beat"), "first beat\n\nsecond beat")

    def test_urls_are_not_mangled(self):
        url = "https://apps.apple.com/us/app/some-app-name/id123"
        self.assertEqual(self._sent_content(f"check {url}"), f"check {url}")

    def test_a_range_speaks_its_span(self):
        """The range exception is retired (8/13, "no dash of any kind"): a span is spoken, not
        punctuated. 'monday to friday' is how a person texts a week; no dash survives to the wire."""
        self.assertEqual(self._sent_content("free monday–friday"), "free monday to friday")
        self.assertEqual(self._sent_content("takes 5–10 mins"), "takes 5 to 10 mins")
        self.assertEqual(self._sent_content("2020–2024 was the run"), "2020 to 2024 was the run")

    def test_send_survives_a_broken_sanitizer(self):
        """The belt must never be able to drop a message. If disposition dies, send raw."""
        with mock.patch.object(disposition, "sanitize", side_effect=RuntimeError("boom")):
            self.assertEqual(self._sent_content("still gets there"), "still gets there")


class ProvenSendIsCanonical(unittest.TestCase):
    def _provider_modules(self):
        return {
            "journal": types.SimpleNamespace(_claims_db=lambda _tenant: "/tmp/co-test.db"),
            "receipts": types.SimpleNamespace(gate=lambda _content, _db: (True, "ok")),
        }

    def test_linq_mirrors_the_handle_that_status_callbacks_name(self):
        dualwrite = types.SimpleNamespace(emit_outbound=mock.Mock(), utc_iso=lambda: "now")
        with mock.patch.dict(sys.modules, self._provider_modules()), \
             mock.patch.object(rail, "provider", return_value="linq"), \
             mock.patch.object(rail, "transport", return_value=(True, "linq-message-1")), \
             mock.patch.object(router, "co_dualwrite", dualwrite):
            self.assertTrue(router.sendblue_send("+15555550123", "it landed"))
        dualwrite.emit_outbound.assert_called_once_with(
            "+15555550123", "linq-message-1", "it landed", "now", transport="linq",
        )

    def test_sendblue_keeps_its_returned_handle_too(self):
        dualwrite = types.SimpleNamespace(emit_outbound=mock.Mock(), utc_iso=lambda: "now")
        response = mock.Mock(raise_for_status=mock.Mock(), json=mock.Mock(
            return_value={"message_handle": "sendblue-message-1"},
        ))
        with mock.patch.dict(sys.modules, self._provider_modules()), \
             mock.patch.object(rail, "provider", return_value="sendblue"), \
             mock.patch.object(router.requests, "post", return_value=response), \
             mock.patch.object(router, "co_dualwrite", dualwrite):
            self.assertTrue(router.sendblue_send("+15555550123", "it landed"))
        dualwrite.emit_outbound.assert_called_once_with(
            "+15555550123", "sendblue-message-1", "it landed", "now", transport="sendblue",
        )


class TheLastBeatStaysOpen(unittest.TestCase):
    """A text that ends on a hard period reads as a door closing (founder, 8/7: co's texts are "too
    serious"). The persona has asked for this since v1 and the model dropped it on every long reply."""

    _sent_content = staticmethod(sent_content)

    def test_the_closing_period_never_reaches_the_wire(self):
        self.assertEqual(self._sent_content("that's the whole thing."), "that's the whole thing")

    def test_interior_periods_are_kept(self):
        self.assertEqual(self._sent_content("i looked. it's live."), "i looked. it's live")

    def test_a_question_keeps_its_mark(self):
        self.assertEqual(self._sent_content("worth it?"), "worth it?")
        self.assertEqual(self._sent_content("go do it!"), "go do it!")

    def test_every_bubble_opens_not_just_the_last(self):
        """A blank line is two separate messages, so the FIRST one closes just as hard."""
        self.assertEqual(self._sent_content("first beat.\n\nsecond beat."),
                         "first beat\n\nsecond beat")

    def test_a_held_beat_keeps_its_ellipsis(self):
        self.assertEqual(self._sent_content("unless..."), "unless...")

    def test_an_abbreviation_keeps_the_period_that_spells_it(self):
        """Initialisms AND the multi-letter ones — 'etc' and 'Inc' are misspellings, and the
        single-letter chain the guard started as did not catch them (8/7 review)."""
        for text in ["door's open till 5 p.m.", "that's the whole move, e.g.",
                     "and the rest of it, etc.", "the quote is from Acme Inc.",
                     "ask approx.", "that's a Dr."]:
            self.assertEqual(self._sent_content(text), text)

    def test_a_real_answer_is_not_an_abbreviation(self):
        """The words that LOOK like the list but are the sentence: 'no' is an answer, 'co' is us."""
        self.assertEqual(self._sent_content("the answer is no."), "the answer is no")
        self.assertEqual(self._sent_content("that's on me, not co."), "that's on me, not co")

    def test_a_dash_at_the_bubble_SEAM_does_not_merge_two_texts(self):
        """The belt moved upstream of send_reply's split, so the whitespace-hungry dash rule could
        eat the blank line and turn a two-beat reply into one message (8/7 review)."""
        self.assertEqual(self._sent_content("i'd skip it —\n\nunless the mill moves"),
                         "i'd skip it,\n\nunless the mill moves")

    def test_the_dash_rule_still_holds_with_it(self):
        self.assertEqual(self._sent_content("i pulled it up — it's live."), "i pulled it up, it's live")


class EveryAppSurfaceWearsTheBeltToo(unittest.TestCase):
    """The app is a SECOND wire and it never touches sendblue_send: the native reply goes back over
    HTTP, and the app's thread re-reads the transcript. A belt on the Sendblue path alone left the app
    showing the dash and the period the iMessage bubble never had."""

    ENGINE_SAID = "pulled it up — it's live. "

    def test_incremental_cutover_never_crosses_tenant_cells(self):
        with mock.patch.object(router, "_RUNTIME_TENANTS", frozenset({"dennis"})), \
             mock.patch.object(router, "WITNESS_URL", "http://runtime/v1/chat/completions"), \
             mock.patch.object(router, "WITNESS_FALLBACK_URL", "http://legacy/v1/chat/completions"):
            self.assertEqual(router._engine_url("dennis"), "http://runtime/v1/chat/completions")
            self.assertEqual(router._engine_url("another-member"), "http://legacy/v1/chat/completions")

    def test_incremental_cutover_fails_closed_without_a_fallback(self):
        with mock.patch.object(router, "_RUNTIME_TENANTS", frozenset({"dennis"})), \
             mock.patch.object(router, "WITNESS_FALLBACK_URL", ""):
            with self.assertRaises(RuntimeError):
                router._engine_url("another-member")

    def _ask_engine(self):
        payload = {"choices": [{"message": {"content": self.ENGINE_SAID}}]}
        with mock.patch.object(router, "_seed_history"), \
             mock.patch.object(router, "_append_transcript") as appended, \
             mock.patch.object(router, "_stamp_history", side_effect=lambda prior, db: prior), \
             mock.patch.object(router.requests, "post") as post:
            post.return_value = mock.Mock(raise_for_status=mock.Mock(),
                                          json=mock.Mock(return_value=payload))
            reply = router.ask_engine("+15555550123", "hey", "dennis", record_history=False)
        return reply, appended

    def test_the_engine_reply_is_belted_before_it_is_returned(self):
        reply, _ = self._ask_engine()
        self.assertEqual(reply, "pulled it up, it's live")

    def test_the_transcript_the_app_reads_back_is_belted(self):
        _, appended = self._ask_engine()
        self.assertEqual(appended.call_args.args[1], "pulled it up, it's live")

    def test_the_routers_own_lines_are_belted_on_the_way_into_history(self):
        """"got it. tomorrow." never passes an engine, and the app reads it out of the transcript."""
        with mock.patch.object(router, "_seed_history"), \
             mock.patch.object(router, "_append_transcript") as appended:
            router._record_turn("+15555550123", "dennis", "not tonight", "got it. tomorrow.",
                                mirror_outbound=False)
        self.assertEqual(appended.call_args.args[1], "got it. tomorrow")

    def test_the_native_chat_route_belts_what_it_returns(self):
        """The collector's joined reply is belted at the route, which is the app's actual wire."""
        route = Path(router.__file__).read_text().split('"/api/app/chat"')[1].split("\n\n\n")[0]
        self.assertIn("_belt(", route)

    def test_the_thread_the_app_renders_is_belted_and_in_order(self):
        """chat.json is read on EVERY open, so the belt here reaches replies that shipped before the
        rules existed. Oldest first is the render order and the app anchors its landing to the end."""
        transcript = [{"role": "user", "content": "did you find it — the good one?", "ts": "t0"},
                      {"role": "assistant", "content": "found it — it's live.", "ts": "t1"},
                      {"role": "system", "content": "ignored", "ts": "t2"},
                      {"role": "assistant", "content": "", "ts": "t3"},
                      {"role": "assistant", "content": "worth it?", "ts": "t4"}]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(transcript, f)
        try:
            with mock.patch.object(router, "_transcript_path", return_value=f.name):
                thread = router.app_thread("dennis")
        finally:
            os.unlink(f.name)
        self.assertEqual([m["text"] for m in thread],
                         ["did you find it — the good one?", "found it, it's live", "worth it?"])
        self.assertEqual([m["isKyo"] for m in thread], [False, True, True])

    def test_the_thread_preserves_old_and_new_carrier_provenance(self):
        transcript = [
            {"role": "user", "content": "before", "ts": "t0"},
            {"role": "assistant", "content": "after", "ts": "t1", "transport": "linq"},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(transcript, f)
        try:
            with mock.patch.object(router, "_transcript_path", return_value=f.name):
                thread = router.app_thread("dennis")
        finally:
            os.unlink(f.name)
        self.assertEqual([message["transport"] for message in thread], ["sendblue", "linq"])

    def test_new_transcript_rows_record_the_selected_carrier(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("[]")
        try:
            with mock.patch.object(router, "_transcript_path", return_value=f.name), \
                 mock.patch.dict(os.environ, {"CO_RAIL": "linq"}):
                router._append_transcript("hello", "hey", "dennis")
            rows = json.loads(Path(f.name).read_text())
        finally:
            os.unlink(f.name)
        self.assertEqual([row["transport"] for row in rows], ["linq", "linq"])

    def test_the_belt_can_never_drop_a_reply(self):
        with mock.patch.object(disposition, "sanitize", side_effect=RuntimeError("boom")):
            self.assertEqual(router._belt("still gets there."), "still gets there.")


class TapbackIsNeverUniform(unittest.TestCase):
    """SUPERSEDES TapbackIsNeverALike (8/26). The old rule banned 👍 because Sendblue had no
    mark-as-read API, so the tapback WAS the read receipt and fired on ~everything — and a
    thumbs-up on everything is the limpest possible receipt. True until co started asking for
    status callbacks on every send path (cf329916): DELIVERED/READ now arrive on the wire, so
    the tapback is free to carry meaning instead of doubling as a receipt.

    The original concern survives and is what this class now enforces: the information is in the
    DIFFERENCE, never in the mark. A uniform ‼️ carries no bits. A 👍/‼️ split carries one that
    actually predicts whether co is coming back."""

    def test_funny_still_laughs(self):
        self.assertEqual(router.pick_tapback("lmao this is unreal"), "laugh")

    def test_no_single_tapback_answers_everything(self):
        got = {router.pick_tapback(t) for t in
               ["just shipped it", "lmao", "i'm cooked today", "look at this",
                "remind me friday", "https://example.com", "keep an eye on octen"]}
        self.assertGreaterEqual(len(got), 4, f"tapbacks collapsed to {got}")

    def test_a_plain_deposit_is_filed_out_loud(self):
        # 9/5: the deposit gets 👍 (received) and never nothing — "the reason i felt ignored is
        # because there was literally no reaction". An ask still reads as ‼️, co is coming back.
        self.assertEqual(router.pick_tapback("https://example.com"), "like")
        self.assertEqual(router.pick_tapback("keep an eye on this"), "emphasize")

    def test_a_mark_that_cannot_be_delivered_never_becomes_a_text(self):
        # 8/29: three failed tapback POSTs arrived at a member as three bubbles holding one eye
        # emoji. The fallback is silence — no text, ever, from the thread that writes marks.
        src = Path(router.__file__).read_text()
        body = src.split("def send_ack")[1].split("\n    # ACK IMMEDIATELY")[0]
        self.assertNotIn("sendblue_send", body)
        self.assertNotIn("timed_send", body)
        self.assertIn("no text fallback", body)

    def test_co_still_never_gives_a_thumbs_down(self):
        for text in ["just shipped it", "lmao", "feeling rough today", "look at this",
                     "", "quit my job", "https://example.com"]:
            self.assertNotEqual(router.pick_tapback(text), "dislike")


class CountsNeverReachTheMouth(unittest.TestCase):
    """The run count is a GATE signal. It decides whether a line fires; it is never spoken."""

    def test_count_hint_is_gone(self):
        self.assertFalse(hasattr(co_react, "count_hint"),
                         "count_hint is back; it bypasses gate() and announces the tally")

    def test_router_no_longer_reads_a_count(self):
        self.assertNotIn("_cr.count_hint", Path(router.__file__).read_text())

    def test_constructor_never_prefixes_an_ordinal(self):
        match = {"statement": "you avoid shipping when it is nearly done", "level": "pattern",
                 "confidence": 0.8, "ev_n": 3}
        for repeat in range(0, 6):
            line = co_react._constructor("another rewrite before launch", match,
                                         repeat, "shipping-avoidance")
            for banned in ["third", "fourth", "fifth", "time this week", "th time"]:
                self.assertNotIn(banned, line.lower(), f"tally leaked at repeat={repeat}: {line!r}")

    def test_run_count_still_computed_for_the_gate(self):
        """Removing the mouth must not remove the signal."""
        self.assertTrue(callable(co_react.send_run_count))


class DeadReadReceiptPathIsGone(unittest.TestCase):
    def test_mark_read_helper_removed(self):
        self.assertFalse(hasattr(router, "sendblue_mark_read"),
                         "mark-as-read is not a Sendblue route; the call 404s and self-disables")

    def test_inbound_read_status_still_collected(self):
        """The OUTBOUND direction is impossible, the INBOUND one works and feeds the proactive gate."""
        self.assertIn("status_callback", Path(router.__file__).read_text())


class EverySendPathWearsTheBelt(unittest.TestCase):
    """The router is not the only process that texts. proactive_tick (anchors and reminders),
    reconciler, the daily text, cold_open and the journal question all POST to send-message
    themselves, in a second process. A belt on only one of them is not a belt. This test fails
    when a NEW direct sender is added without one, which is the way this regresses."""

    CLAIMS = Path(__file__).resolve().parents[2] / "claims"

    def _direct_senders(self):
        return [p for p in self.CLAIMS.glob("*.py")
                if "api/send-message" in p.read_text() or "linqapp.com/api/partner" in p.read_text()]

    def test_the_scan_actually_finds_the_senders(self):
        """Guards the guard: a broken path would make the tests below pass on an empty list."""
        self.assertTrue(self.CLAIMS.is_dir(), f"claims dir not found at {self.CLAIMS}")
        found = {p.name for p in self._direct_senders()}
        self.assertIn("rail.py", found, f"scanned and found: {found}")

    def test_rail_is_the_only_direct_sender(self):
        """8/31: daily_text, cold_open and journal each POSTed their own send-message, so each
        chose accidentally how guarded it was — all three wore the belt and none wore the abstain
        guard, the shape hold, dedup or the receipt gate. One door now. A new file POSTing directly
        is the way that regresses, and it fails here."""
        found = {p.name for p in self._direct_senders()}
        self.assertEqual(found, {"rail.py"},
                         f"only rail.py may POST to send-message; also found: {found - {'rail.py'}}")

    def test_no_direct_sender_skips_sanitize(self):
        offenders = [p.name for p in self._direct_senders()
                     if "disposition.sanitize" not in p.read_text()]
        self.assertEqual(offenders, [], f"these POST to send-message without sanitizing: {offenders}")

    def test_the_proactive_choke_point_sanitizes(self):
        """Everything proactive reaches the wire through rail.send, so the guard lives there."""
        import rail
        src = Path(rail.__file__).read_text()
        self.assertIn("disposition.sanitize", src)
        self.assertIn("_belt(content)", src.split("def send(")[1][:600])

    def test_the_choke_point_carries_every_gate(self):
        """The belt alone is not the guard set. These four were on daily_text._sendblue and were
        bypassed by two senders; they must survive the move."""
        import rail
        src = Path(rail.__file__).read_text()
        for gate in ("disposition.refusal", "_sent_before", "receipts.gate", "450"):
            self.assertIn(gate, src, f"rail.py lost the {gate} gate")


class DispositionBeltHoldsItsContract(unittest.TestCase):
    def test_sanitize_is_idempotent(self):
        once = disposition.sanitize("a — b -- c")
        self.assertEqual(once, disposition.sanitize(once))

    def test_sanitized_text_clears_the_em_dash_violation(self):
        self.assertNotIn("em-dash/en-dash", disposition.violations(disposition.sanitize("a — b")))


class TheAppReadsWhatCoWrites(unittest.TestCase):
    """app.json is the app's whole vocabulary and none of it goes through the message belt. The
    rule goes on where co's words are BORN, so the page and the app can't disagree, and so the
    member's own text is never touched: rewriting what they typed is data alteration, not voice."""

    def setUp(self):
        import wrapped
        self.wrapped = wrapped

    def test_the_prompts_that_write_app_copy_carry_the_rule(self):
        """Behaviour, not a source-text count: read the prompt each phraser really sends. An
        earlier version of this test counted occurrences of "VOICE_RULE" and stayed green while
        the room whisper silently lost it."""
        rooms_src = inspect.getsource(self.wrapped._rooms)
        finds_src = inspect.getsource(self.wrapped._finds)
        self.assertIn(disposition.VOICE_RULE, self.wrapped.TODAY_SYS)
        self.assertIn("VOICE_RULE", rooms_src)
        self.assertIn("VOICE_RULE", finds_src)

    def test_no_prompt_demonstrates_the_tic_it_bans(self):
        """A prompt that uses an em-dash teaches the model to use one, whatever it says: the rooms
        prompt banned the dash and demonstrated one two clauses later. Reads the string constants
        the function actually sends, skipping the docstring, which is for us and not for it."""
        self.assertNotRegex(self.wrapped.TODAY_SYS, r"[—–]", "TODAY_SYS")
        for fn in (self.wrapped._rooms, self.wrapped._finds, self.wrapped._today):
            sent = [c for c in fn.__code__.co_consts[1:] if isinstance(c, str)]
            for literal in sent:
                self.assertNotRegex(literal, r"[—–]", f"{fn.__name__} prompt copy")

    def test_a_memory_is_stamped_when_it_was_kept_not_at_noon(self):
        """Journal entries have carried an epoch since the first write, but only `date` was read
        here, so every memory in the archive claimed 12:00 PM."""
        self.assertEqual(self.wrapped._iso_ts({"ts": 1786148215, "date": "2026-08-07"}),
                         "2026-08-08T00:16:55Z")
        self.assertEqual(self.wrapped._iso_ts({"date": "2026-08-07"}), "2026-08-07T12:00:00Z")

    def test_the_members_own_words_are_never_rewritten(self):
        """The belt is co's rule for co's prose. A member who texts an em-dash must read it back
        exactly as they typed it, and lived's `because` is a verbatim quote by law."""
        typed = "cutting the studio — it is dead weight"
        self.assertEqual(dedash(typed), "cutting the studio, it is dead weight")
        src = inspect.getsource(self.wrapped.app_state)
        self.assertNotIn("dedash(clean", src)
        self.assertIn('"text": clean[:300] or None', src)


if __name__ == "__main__":
    unittest.main()
