#!/usr/bin/env python3
"""The voice witness — LiveKit Agents worker that gives the engine a voice + a phone (PROGRAM.md cap 1).

THE CALL (push, not pull — the unlock). The product initiates: in the evening it calls the user over a real
phone number, has a ~10-min conversation through the EXISTING engine, and the transcript feeds BOTH the
flywheel (journal_ingest.py — the user's turns deepen the model) AND the silent ledger (ledger.py — the
witness's reads become falsifiable predictions). Architecture per _private/02_BUILD/LIVEKIT_ARCH.md:

  LiveKit = the harness (WebRTC/SIP transport, STT, turn-detection, interruption, TTS).
  OUR engine = the in-loop brain, reached as an OpenAI-compatible endpoint (WITNESS_LLM_URL → voice/endpoint.py
               on :8088). The worker DOES NOT embed a brain — it points its LLM stage at the endpoint. The
               persona, carried-core, recall, and disposition all live behind that endpoint (the soul is the
               engine; the surface is swappable).

Per-tenant: a call is for ONE user. The tenant id rides the room (job) metadata as {"tenant","phone"}; the
entrypoint reads it, tags every engine request with it (OpenAI `user` field → endpoint.tenant_of), and at
shutdown runs journal_ingest + ledger with that tenant's CO_CLAIMS_DB so they read the right transcript and
write the right store. user #2 is never served user #1's interior (the privacy boundary the endpoint enforces).

──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREDS BOUNDARY — everything below is built to here; the LIVE path is gated on creds NOT yet provisioned.
Marked again at each creds-dependent call site with `# CREDS:`. This file is import-clean WITHOUT livekit
installed (the no-op fallback below), so syntax/import checks pass before any cred exists.

SETUP. STT + TTS run through LiveKit Inference — ONE LiveKit key, no Deepgram/Cartesia accounts.
  pip install "livekit-agents[silero,turn-detector]" livekit-plugins-openai

  env / Doppler:
    LIVEKIT_URL/API_KEY/API_SECRET   provisioned ✓ — covers transport AND STT/TTS (via Inference)
    WITNESS_LLM_URL        our engine, OpenAI-compatible (default http://localhost:8090/v1 — the agent.ts brain, server.ts)
    CO_STT/CO_TTS/CO_VOICE  optional model overrides (default deepgram/flux-general + cartesia/sonic-3)
    LIVEKIT_SIP_TRUNK_ID   STILL NEEDED for OUTBOUND ("it calls you") — an outbound SIP trunk + a number, set up
                           in the LiveKit console (LiveKit-native telephony or BYO Twilio/Telnyx). Inbound (you
                           talk to it via the LiveKit playground) needs NONE of this.

  GO LIVE:
    1. Engine (the brain):  cd diyagi/pi && doppler run -- node donna/server.ts   # serves :8090
    2. Worker (registers with LiveKit, waits for jobs):
         doppler run -- python3 voice/witness_voice.py start
    3. INBOUND test (hear it now, no phone): open the LiveKit Agents Playground, connect to your project, talk.
       OUTBOUND ("it calls you"): doppler run -- python3 voice/witness_voice.py call +1XXXXXXXXXX [tenant]
       (needs LIVEKIT_SIP_TRUNK_ID; scheduler.py fires this on the evening window).
──────────────────────────────────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# The frame checkout. Env-overridable so a dev box runs from its own repo; the default is
# the founder's production path.
ROOT = Path(os.environ.get("CO_FRAME_ROOT", "/Users/main/Projects/Secretary/Secretary-Production/projects/co/frame"))
sys.path.insert(0, str(ROOT / "claims"))

# The engine venv — used to shell journal_ingest + ledger at session end (they run in their own process so a
# slow ingest never blocks call teardown, and so they inherit the per-tenant CO_CLAIMS_DB env we set).
VENV = os.environ.get("CO_FRAME_VENV", "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/.venv/bin/python3")

try:
    from livekit import agents, api, rtc
    from livekit.agents import Agent, AgentSession, JobContext, RunContext, function_tool, inference
    from livekit.plugins import silero
    LIVEKIT = True
except Exception:                       # deps not installed yet — keep the file importable/inspectable
    LIVEKIT = False
    Agent = object
    RunContext = JobContext = object

    def function_tool(fn):              # no-op decorator so the class body parses without livekit-agents
        return fn


# ---------------- the witness as a LiveKit Agent ----------------
# The SOUL is the engine (behind WITNESS_LLM_URL): persona, carried-core, recall, disposition. These Agent
# instructions are a thin, language-law-clean backstop only — they must never reintroduce a brain here, and
# never use the banned vocabulary (assistant / companion / chief-of-staff / friend, except negation).
WITNESS_INSTRUCTIONS = (
    "This is a phone call — the user's journal, aloud. Speak like a person on the phone: warm, dry, short "
    "turns, real opinions, no markdown, no lists. You know this person and you will not flatter them; when "
    "they avoid something, name it. End pointed outward — a thing to do, a person to see — never deeper into "
    "an app. Mark unknown as unknown. The deep knowledge of them comes from the engine; let it lead."
)


class Witness(Agent):
    def __init__(self):
        super().__init__(instructions=WITNESS_INSTRUCTIONS)


# ---------------- per-tenant plumbing (the privacy boundary on the voice surface) ----------------
def _tenant_db(tenant: str) -> str:
    """Resolve a tenant id to the CO_CLAIMS_DB path the Python extractors key off (claimstore.db_path
    convention): the default tenant keeps claims.db; anyone else gets claims_<tenant>.db beside it. The
    session-end ingest/ledger and the endpoint must agree on this path or the flywheel writes the wrong store."""
    import re as _re
    t = (tenant or "").strip().lower()
    if not t or t == "dennis":
        return str(ROOT / "claims" / "claims.db")
    t = _re.sub(r"[^a-z0-9_+\-]", "_", t) or "dennis"
    return str(ROOT / "claims" / f"claims_{t}.db")


def _job_tenant(ctx) -> tuple:
    """Pull (tenant, phone, session_id) off the job/room metadata place_call stamped. Defaults to the
    founder tenant for inbound calls with no metadata (single-user dogfood). session_id is the opaque key of
    the pre-call text thread (the app's in-memory chat); when present, the worker fetches the thread from our
    server so the call opens knowing the app's recent text — without the text ever transit riding LiveKit.
    Never raises."""
    tenant, phone, session_id = "dennis", "", ""
    for src in (getattr(getattr(ctx, "job", None), "metadata", None),
                getattr(getattr(ctx, "room", None), "metadata", None)):
        if src:
            try:
                d = json.loads(src)
                tenant = (d.get("tenant") or tenant)
                phone = (d.get("phone") or phone)
                session_id = (d.get("session_id") or session_id)
            except (json.JSONDecodeError, TypeError):
                pass
    return str(tenant), str(phone), str(session_id)


def _fetch_seed(session_id: str) -> list:
    """Pull the app's pre-call text thread via the server's opaque-id handoff (see POST /api/v1/voice/session).
    The recording id rides LiveKit's dispatch; the thread itself travels only over OUR localhost (or private
    hop), read-once, short-TTL. Best-effort: a miss means the call opens with long-term memory but no thread —
    never a crash."""
    if not session_id:
        return []
    import urllib.request
    url = f"{os.getenv('CO_SESSION_URL', 'http://localhost:3100').rstrip('/')}/api/v1/voice/context/{session_id}"
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            turns = json.loads(r.read().decode("utf-8", "replace")).get("session") or []
        return [{"role": m["role"], "content": str(m.get("content") or "").strip()} for m in turns
                if m.get("role") in ("user", "assistant") and str(m.get("content") or "").strip()]
    except Exception as e:
        print(f"witness_voice: session seed fetch skipped ({e})")
        return []


def _witness_llm(tenant: str, seed: list | None = None):
    """Our engine as the LLM (OpenAI-compatible endpoint, WITNESS_LLM_URL). The `user` field carries the
    tenant so endpoint.tenant_of forks to THIS user's store/brain — keeps the brain ours, not generic, and
    keeps it the right user's. `channel:"voice"` in the body is what the engine keys its lean voice toolset
    off (5-10s dead air otherwise). `seed` = the app's pre-call text thread, injected once as the opening
    messages so the call picks up where the text thread left off (the engine is stateless — the channel sends
    the history, exactly as the rail does). The endpoint streams; TTFT (not total length) is what's perceived."""
    from livekit.plugins import openai  # CREDS: needs livekit-plugins-openai installed
    common = dict(
        base_url=os.getenv("WITNESS_LLM_URL", "http://localhost:8090/v1"),  # the unified agent.ts engine (server.ts)
        model="witness",
        api_key=os.getenv("CO_ENGINE_TOKEN") or os.getenv("WITNESS_LLM_KEY", "frame"),
        user=tenant,                                     # → the engine forks to THIS user's interior
        extra_body={"channel": "voice"},                 # → the engine's voiceTurn path (lean tools)
    )
    seed = [dict(m) for m in (seed or []) if m.get("role") in ("user", "assistant") and str(m.get("content") or "").strip()]
    if not seed:
        return openai.LLM(**common)

    class _SeededVoiceLLM(openai.LLM):
        """Our engine as the LLM, but the app's pre-call thread rides the FIRST call's messages. The
        AgentSession owns the call's own continuity after that — the seed never reinjects."""

        def __init__(self, seed, **kwargs):
            super().__init__(**kwargs)
            self._seed = list(seed)

        def chat(self, *, chat_ctx, **kwargs):
            if self._seed:
                base = time.time() - 3600          # far enough back to sort BEFORE the opening turn
                for i, m in enumerate(self._seed):
                    chat_ctx.add_message(role=m["role"], content=m["content"], created_at=base + i * 0.001)
                self._seed = None
            return super().chat(chat_ctx=chat_ctx, **kwargs)

    return _SeededVoiceLLM(seed, **common)


def _ingest_transcript(session, tenant: str):
    """Write the call transcript where journal_ingest + ledger read it (CO_CLAIMS_DB sibling), then shell
    BOTH against this tenant's store. Runs in the shutdown callback — own process so it never blocks teardown,
    inherits the per-tenant env so it touches only this user's flywheel + ledger. Best-effort: a failed ingest
    must not crash call teardown."""
    db = _tenant_db(tenant)
    transcript_path = Path(f"{db}.transcript.json")
    try:
        history = session.history.to_dict()          # LiveKit session transcript (the full turn log)
        items = history.get("items", history) if isinstance(history, dict) else history
        # normalize to the {role, content} shape journal_ingest / ledger expect (string content)
        msgs = []
        for it in items or []:
            if not isinstance(it, dict):
                continue
            role = it.get("role")
            if role not in ("user", "assistant"):
                continue
            content = it.get("content")
            if isinstance(content, list):
                content = " ".join(str(c.get("text", c) if isinstance(c, dict) else c) for c in content).strip()
            elif not isinstance(content, str):
                content = str(content or "")
            if content.strip():
                msgs.append({"role": role, "content": content.strip()})
        if not msgs:
            return
        # APPEND to the existing transcript (the extractors watermark on length, so each call's new turns get
        # ingested exactly once — idempotent, matches the iMessage/pi transcript convention).
        prior = []
        if transcript_path.exists():
            try:
                prior = json.loads(transcript_path.read_text())
            except (json.JSONDecodeError, OSError):
                prior = []
        transcript_path.write_text(json.dumps(prior + msgs))
    except Exception as e:                            # transcript shape can vary by livekit version — degrade
        print(f"witness_voice: transcript capture skipped ({e})")
        return

    env = dict(os.environ, CO_CLAIMS_DB=db)        # the cross-language tenant handle (claimstore honors it)
    # ORDER MATTERS. journal_ingest first, because harvest's scout rung reads the journal it writes —
    # run the other way round and the implicit half of a call is always one call behind. harvest last
    # for the same reason, and because it is the only one of the three that creates standing work
    # (anchors, watches, commissions): if the flywheel fails, the call is still remembered, and if
    # harvest fails, nothing half-built is left in front of the member.
    for script in ("journal_ingest.py", "ledger.py", "harvest.py"):
        try:
            subprocess.run([VENV, str(ROOT / "claims" / script)], env=env,
                           capture_output=True, timeout=300)
        except Exception as e:
            print(f"witness_voice: {script} at session end failed (non-fatal): {e}")


async def entrypoint(ctx: "JobContext"):
    """Inbound or outbound call → a witness session. STT → our engine (OpenAI-compatible) → TTS, with
    turn-detection + adaptive interruption. On disconnect the transcript feeds journal_ingest (flywheel) AND
    ledger (the silent record) for THIS tenant."""
    await ctx.connect()                                # CREDS: LIVEKIT_URL/API_KEY/API_SECRET
    tenant, _phone, session_id = _job_tenant(ctx)
    seed = _fetch_seed(session_id)                     # the app's pre-call text thread, if any (best-effort)

    # LiveKit Inference: STT + TTS through the LiveKit key (no Deepgram/Cartesia accounts). Models swappable
    # via env. STT = Deepgram Flux (semantic turn detection); TTS = Cartesia Sonic-3 (low latency).
    # v1.6.8 turn API: `turn_detection` is deprecated (silently dropped → "manual", so the agent never
    # hears the end of a turn). `turn_handling` is the live switch — STT endpointing means the reply fires
    # once you stop talking.
    session = AgentSession(
        stt=inference.STT(model=os.getenv("CO_STT", "deepgram/flux-general"), language="en"),
        llm=_witness_llm(tenant, seed=seed),           # OUR engine (WITNESS_LLM_URL must be up)
        tts=inference.TTS(model=os.getenv("CO_TTS", "cartesia/sonic-3"),
                          voice=os.getenv("CO_VOICE", "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc")),
        vad=silero.VAD.load(),                         # local model, no cred
        turn_handling={
            "turn_detection": "stt",
            "interruption": {"enabled": True},
            "preemptive_generation": {"preemptive_tts": True},
        },
    )

    # Feed the flywheel + ledger at hangup. Registered BEFORE start so a quick hangup still ingests.
    # Must return an awaitable — livekit v1.6.8 awaits every shutdown callback (a bare lambda
    # returning None crashed teardown with "object NoneType can't be used in 'await'").
    ctx.add_shutdown_callback(lambda: asyncio.to_thread(_ingest_transcript, session, tenant))

    # Forward the USER's STT back into the room as transcription, so the in-app thread can show what
    # THEY said after the call ends. The agent's own text is already published by the SDK; without this
    # the app would only ever see Kyo's half of the conversation.
    def _publish_user_transcript(ev) -> None:
        if not ev.transcript or not ctx.room.isconnected():
            return
        # The user's mic track — the transcription must reference the track it describes so the
        # app's TranscriptionStreamReceiver keys it to the right participant.
        user_track = next(
            (t.track for p in ctx.room.remote_participants.values()
             for t in p.track_publications.values()
             if t.source == "microphone" and t.track), None)
        track_sid = user_track.sid if user_track else ""
        seg = rtc.TranscriptionSegment(id=str(ev.item_id or ev.speaker_id), text=ev.transcript,
                                       start_time=0, end_time=0, final=ev.is_final, language=ev.language or "")
        tx = rtc.Transcription(participant_identity=ev.speaker_id or ctx.room.local_participant.identity,
                               track_sid=track_sid, segments=[seg])
        try:
            asyncio.create_task(ctx.room.local_participant.publish_transcription(tx))
        except Exception as e:  # best-effort: a failed forward must not break the call
            print(f"witness_voice: user transcript forward failed: {e}")

    session.on("user_input_transcribed", _publish_user_transcript)

    await session.start(agent=Witness(), room=ctx.room)
    # The product initiates → the witness opens the call (a person picks up to silence otherwise). The engine
    # behind the LLM owns the actual words; this just cues it to produce the opening turn.
    await session.generate_reply(
        instructions="Open the call warmly and briefly, like calling someone you know. One short line, then "
                      "ask the one real question that opens them up tonight. No preamble about being an app.")


# ──────────────────────────────────────────────────────────────────────────────────────────────────────
# OUTBOUND — "it calls you" (the push). place_call dials a real number via SIP and dispatches this worker's
# entrypoint into the room. Triggered by voice/scheduler.py on the user's evening window (one call/day).
# ──────────────────────────────────────────────────────────────────────────────────────────────────────
async def place_call(phone_number: str, tenant: str = "dennis", agent_name: str = "witness") -> str:
    """Outbound call. Creates a room, dispatches the entrypoint into it (carrying the tenant via metadata),
    and dials the user's number over the SIP outbound trunk. Returns the room name.

    CREDS: needs LIVEKIT_URL/API_KEY/API_SECRET (the LiveKitAPI client) AND LIVEKIT_SIP_TRUNK_ID (an outbound
    trunk). With no creds this raises at the API call — never silently; callers (scheduler) handle/log it."""
    if not LIVEKIT:
        raise RuntimeError("livekit-agents not installed — see SETUP. (cannot place a call without it)")
    trunk = os.getenv("LIVEKIT_SIP_TRUNK_ID", "")
    if not trunk:
        raise RuntimeError("LIVEKIT_SIP_TRUNK_ID not set — no outbound SIP trunk provisioned (see SETUP).")

    room = f"witness-call-{tenant}-{phone_number[-4:]}"
    metadata = json.dumps({"tenant": tenant, "phone": phone_number})
    lk = api.LiveKitAPI()                              # CREDS: reads LIVEKIT_URL/API_KEY/API_SECRET from env
    try:
        # 1) dispatch the agent into the room (so it's present when the callee picks up), carrying the tenant
        await lk.agent_dispatch.create_dispatch(api.CreateAgentDispatchRequest(
            agent_name=agent_name, room=room, metadata=metadata))
        # 2) dial the user over the outbound SIP trunk → joins the same room → the entrypoint runs the session
        await lk.sip.create_sip_participant(api.CreateSIPParticipantRequest(
            sip_trunk_id=trunk, sip_call_to=phone_number, room_name=room,
            participant_identity=f"caller-{phone_number[-4:]}", wait_until_answered=True))
    finally:
        await lk.aclose()
    return room


def main():
    """CLI: `start` runs the worker (registers with LiveKit, waits for jobs); `call <number> [tenant]` fires
    one outbound call. Import-clean without livekit (prints SETUP and exits 0)."""
    if not LIVEKIT:
        print("livekit-agents not installed — see SETUP at the top of this file. "
              "(file is import-clean; this is the creds-gated scaffold.)")
        return 0
    argv = sys.argv[1:]
    if argv and argv[0] == "call":
        if len(argv) < 2:
            print("usage: witness_voice.py call <phone_number> [tenant]"); return 2
        number = argv[1]
        tenant = argv[2] if len(argv) > 2 else "dennis"
        asyncio.run(place_call(number, tenant=tenant))
        return 0
    # default / `start`: run the agent worker. agent_name must match place_call's dispatch (explicit dispatch).
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint, agent_name="witness"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
