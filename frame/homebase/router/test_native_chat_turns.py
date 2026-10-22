import os
import sys
import tempfile
import types
import unittest
import sqlite3
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import sendblue_router as router
import claimstore


class FreshRelationshipSchemaTests(unittest.TestCase):
    def test_partial_sidecar_database_is_promoted_to_a_full_belief_graph(self):
        with tempfile.TemporaryDirectory() as temp:
            path = os.path.join(temp, "claims_fresh.db")
            partial = sqlite3.connect(path)
            partial.execute("CREATE TABLE returns (id INTEGER PRIMARY KEY)")
            partial.close()

            conn = claimstore.connect_path(path)
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}
            columns = {row[1] for row in conn.execute("PRAGMA table_info(claims)")}
            conn.close()

            self.assertTrue({"returns", "claims", "relations", "user_corrections"} <= tables)
            self.assertTrue({"status", "embedding", "salience", "graded", "inferred"} <= columns)


class NativeTurnLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.prior_db = router.APP_TURN_DB
        router.APP_TURN_DB = os.path.join(self.temp.name, "turns.sqlite3")

    def tearDown(self):
        router.APP_TURN_DB = self.prior_db
        self.temp.cleanup()

    def test_a_completed_turn_is_returned_without_executing_again(self):
        turn_id = "0298c5d2-bfed-75e0-b7d1-8a89b7c04240"
        self.assertIsNone(router._claim_app_turn("p15551000999", turn_id, "what changed"))
        with self.assertRaises(router.AppTurnBusy):
            router._claim_app_turn("p15551000999", turn_id, "what changed")

        router._complete_app_turn("p15551000999", turn_id, "the price dropped")

        self.assertEqual(
            router._claim_app_turn("p15551000999", turn_id, "what changed"),
            "the price dropped",
        )
        with self.assertRaises(ValueError):
            router._claim_app_turn("p15551000999", turn_id, "different meaning")

    def test_a_failed_owner_releases_the_turn_for_retry(self):
        turn_id = "0298c5d2-bfed-75e0-b7d1-8a89b7c04241"
        self.assertIsNone(router._claim_app_turn("p15551000999", turn_id, "try this"))
        router._release_app_turn("p15551000999", turn_id)
        self.assertIsNone(router._claim_app_turn("p15551000999", turn_id, "try this"))


class SharedAgentLoopTests(unittest.TestCase):
    def test_fresh_native_member_uses_the_full_promise_and_bookkeeping_stages(self):
        co_react = types.SimpleNamespace(
            LINE=2,
            react=lambda *args, **kwargs: {"tier": 0, "why": "answer", "reaction": None},
            _light_emoji=lambda text: "seen",
        )
        journal = types.SimpleNamespace(_claims_db=lambda tenant: "/tmp/co-native-test.db")
        link_read = types.SimpleNamespace(find_urls=lambda text: [])
        scheduler = types.SimpleNamespace(is_skip_phrase=lambda text: False)
        tz_dynamic = types.SimpleNamespace(update_from_text=lambda db, text: None)
        claimstore_module = types.SimpleNamespace(
            connect_path=lambda db: types.SimpleNamespace(close=lambda: None)
        )
        replies = []

        with mock.patch.dict(sys.modules, {
            "co_react": co_react,
            "journal": journal,
            "link_read": link_read,
            "scheduler": scheduler,
            "tz_dynamic": tz_dynamic,
            "claimstore": claimstore_module,
        }), mock.patch.multiple(
            router,
            _is_onboarded=mock.DEFAULT,
            _style_note=mock.DEFAULT,
            _promise_hint=mock.DEFAULT,
            _start_recall=mock.DEFAULT,
            _situation_hint=mock.DEFAULT,
            _deep_watch_block=mock.DEFAULT,
            _dump_burst=mock.DEFAULT,
            ask_engine=mock.DEFAULT,
            _bookkeep_sync=mock.DEFAULT,
            sendblue_send=mock.DEFAULT,
            sendblue_react=mock.DEFAULT,
        ) as patched:
            patched["_is_onboarded"].return_value = False
            patched["_promise_hint"].return_value = "promise stored"
            patched["_start_recall"].return_value = lambda hint: hint
            patched["_situation_hint"].side_effect = lambda tenant, db, text, burst, enriched, hint: hint
            patched["_deep_watch_block"].return_value = None
            patched["_dump_burst"].return_value = False
            patched["ask_engine"].return_value = "got you"

            router._co_reply(
                "+15551000999",
                "p15551000999",
                "remind me tomorrow?",
                [],
                0,
                deliver=replies.append,
            )

            self.assertEqual(replies, ["got you"])
            patched["_promise_hint"].assert_called_once()
            patched["_bookkeep_sync"].assert_called_once()
            # 9/3: co_react's verdict now leads the hint, so the engine is bound by what the gate
            # decided instead of ignoring it. The promise still has to reach the engine underneath.
            patched["ask_engine"].assert_called_once()
            args, kwargs = patched["ask_engine"].call_args
            self.assertEqual(args, ("+15551000999", "remind me tomorrow?", "p15551000999"))
            self.assertFalse(kwargs["mirror_outbound"])
            self.assertTrue(kwargs["hint"].startswith("NO READ THIS TURN"))
            self.assertIn("promise stored", kwargs["hint"])
            patched["sendblue_send"].assert_not_called()
            patched["sendblue_react"].assert_not_called()


if __name__ == "__main__":
    unittest.main()
