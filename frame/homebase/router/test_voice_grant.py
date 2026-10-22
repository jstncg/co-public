"""The app's voice grant, held mechanically.

In-app voice is a LiveKit room with the witness agent dispatched into it. Three things can go
wrong silently, and each one has already cost somebody a day somewhere:

  1. The token carries the WRONG TENANT, and the agent loads another member's interior. The
     V2 door mints with a Supabase user id (apps/web/src/lib/voice-room.ts) which is not a rail
     tenant at all — that bug is latent there right now, and these tests are why it cannot
     land here.
  2. The room name is STABLE, so the second call re-enters a live room whose agent dispatch
     already fired, and voice "works once then dies" (livekit/livekit#4390).
  3. A box with no LiveKit grant returns something the app reads as a network failure instead
     of "not configured", and the orb blames the wrong thing.

Skipped wholesale when livekit-api is absent, so the suite still passes on a router box that
has not installed the voice extras (`pip install livekit-api`).
"""
import base64
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import sendblue_router as router

try:
    import livekit.api  # noqa: F401
    HAS_LIVEKIT = True
except ImportError:
    HAS_LIVEKIT = False

CREDS = {
    "LIVEKIT_URL": "wss://co.livekit.cloud",
    "LIVEKIT_API_KEY": "devkey",
    "LIVEKIT_API_SECRET": "secret_at_least_32_chars_long_xxxxx",
}


def claims_of(token: str) -> dict:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


class VoiceGrantWithoutCreds(unittest.TestCase):
    def test_a_box_with_no_livekit_says_so_instead_of_failing(self):
        with mock.patch.dict(os.environ, {"LIVEKIT_URL": "", "LIVEKIT_API_KEY": "",
                                          "LIVEKIT_API_SECRET": ""}):
            code, body = router._voice_grant("dennis")
        self.assertEqual(code, 503, "503 is the app's signal for 'voice isn't configured here'")
        self.assertIn(b"voice_not_configured", body)


@unittest.skipUnless(HAS_LIVEKIT, "livekit-api not installed (pip install livekit-api)")
class VoiceGrantWithCreds(unittest.TestCase):
    def grant(self, tenant="p16475550123"):
        with mock.patch.dict(os.environ, CREDS):
            code, body = router._voice_grant(tenant)
        self.assertEqual(code, 200, body)
        return json.loads(body)

    def test_the_app_gets_exactly_what_it_needs_to_open_a_room(self):
        out = self.grant()
        self.assertEqual(set(out), {"serverUrl", "roomName", "token"},
                         "everything the app needs to open a room, and nothing more")
        self.assertEqual(out["serverUrl"], CREDS["LIVEKIT_URL"])

    def test_the_agent_is_dispatched_with_this_tenant_and_no_other(self):
        out = self.grant("p16475550123")
        dispatch = claims_of(out["token"])["roomConfig"]["agents"][0]
        self.assertEqual(dispatch["agentName"], "witness")
        self.assertEqual(json.loads(dispatch["metadata"]), {"tenant": "p16475550123"},
                         "witness_voice.py:_job_tenant() reads exactly this")

    def test_the_token_only_opens_the_room_it_was_minted_for(self):
        out = self.grant()
        video = claims_of(out["token"])["video"]
        self.assertEqual(video["room"], out["roomName"])
        self.assertTrue(video["roomJoin"])

    def test_every_session_gets_a_fresh_room_or_the_agent_stops_joining(self):
        # LiveKit applies token-embedded dispatch at room CREATION only. A stable room name
        # means call #2 re-enters a live room and no agent is ever dispatched into it.
        rooms = {self.grant("dennis")["roomName"] for _ in range(5)}
        self.assertEqual(len(rooms), 5, "one room per session, never per tenant")

    def test_the_agent_name_follows_the_worker(self):
        # witness_voice.py registers with agent_name="witness"; if the worker is renamed the
        # dispatch has to follow it through env, not a code change.
        with mock.patch.dict(os.environ, {**CREDS, "LIVEKIT_AGENT_NAME": "scribe"}):
            code, body = router._voice_grant("dennis")
        self.assertEqual(code, 200)
        dispatch = claims_of(json.loads(body)["token"])["roomConfig"]["agents"][0]
        self.assertEqual(dispatch["agentName"], "scribe")


if __name__ == "__main__":
    unittest.main()
