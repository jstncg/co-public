"""An outage on our side must never reach them wearing a reaction.

9/3, founder: "there are so many things that I sent or asked it to explain and it just doesn't
respond or only sends me the eyes instead of even reacting with the eyes. This is horrible."

What was happening: the engine 422'd (the hint exceeded the runtime boundary's 500-char ceiling),
ask_engine returned None, and one line — `reply = r["reaction"] or _light_emoji(text)`, commented
"floor: never silence on input" — texted a bare 👀. So four engine outages today read to him as co
glancing at his message and choosing to say nothing. His "Explain" at 10:52 was one of them.

Three laws pinned here: the hint is clamped rather than allowed to 422, the engine gets one retry,
and a failure sends NO text at all — a real tapback carries the receipt instead.
"""
import sys
from pathlib import Path

ROUTER = Path(__file__).resolve().parents[2] / "frame" / "homebase" / "router"
sys.path.insert(0, str(ROUTER))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "frame" / "claims"))

import rail  # noqa: E402
import sendblue_router as router  # noqa: E402

LIGHT = {"tier": "light", "why": "topical match, not a behavioral claim — a glance, never the vague read"}


def test_the_constraint_fits_under_the_boundary_with_room_to_spare():
    """It was exactly 500, the ceiling, so any second hint pushed the turn into a 422."""
    h = router.verdict_hint(LIGHT)
    assert len(h) < router.MAX_HINT // 2, f"{len(h)} chars leaves no room for a real hint"
    joined = router.join_hint(h, "a promise is stored, due friday, and they are in NYC")
    assert len(joined) <= router.MAX_HINT


def test_the_clamp_matches_the_engines_own_ceiling():
    """Two engines now bound this field and both use 500. The legacy brain counts characters
    (runtime-boundary.ts); the live runtime counts bytes (engine-compat.ts `bounded`,
    Buffer.byteLength). Bytes is the stricter of the two, so the router clamps in bytes and
    satisfies both — but the number itself must stay pinned to whatever they declare."""
    src = (ROUTER / "sendblue_router.py").read_text()
    legacy = (ROUTER.parents[1] / "brain" / "runtime-boundary.ts").read_text()
    assert "MAX_HINT_LENGTH = 500" in legacy
    live = (ROUTER.parents[2] / "packages" / "runtime" / "src" / "engine-compat.ts")
    if live.exists():
        assert 'bounded(body.co_hint, "co_hint", 500)' in live.read_text()
    assert router.MAX_HINT == 500
    assert 'body["co_hint"] = hint' in src


def test_an_overlong_hint_is_trimmed_not_dropped():
    """The verdict leads the string, so a trim takes the situational tail and keeps the law."""
    hint = router.join_hint(router.verdict_hint(LIGHT), "x" * 900)
    clamped = hint if len(hint) <= router.MAX_HINT else hint[:router.MAX_HINT - 1].rstrip() + "…"
    assert len(clamped) <= router.MAX_HINT
    assert clamped.startswith("NO READ THIS TURN")


def test_a_failed_engine_sends_no_text_and_reacts_instead():
    src = (ROUTER / "sendblue_router.py").read_text()
    body = src.split("engine returned nothing twice")[1][:700]
    # and the ❓ goes bare (9/8): 👀 now means "this is interesting", so hanging it on our own
    # outage claims a reaction co never had — the same lie 9/3 removed, one glyph smaller.
    assert 'sendblue_react(message_handle, "question")' in body
    assert 'emoji="👀"' not in body
    assert "return" in body


def test_the_emoji_floor_is_gone_for_good():
    """The one line that produced every bare-eyes text. It must not come back."""
    src = (ROUTER / "sendblue_router.py").read_text()
    assert "_light_emoji(text)   # floor: never silence on input" not in src
    assert "floor: never silence on input" not in src


def test_the_engine_gets_one_retry_before_anything_is_given_up():
    src = (ROUTER / "sendblue_router.py").read_text()
    assert "retrying once" in src


def test_a_custom_emoji_becomes_a_real_reaction_on_linq(monkeypatch):
    seen = {}
    monkeypatch.setattr(rail, "_linq_post",
                        lambda path, body, timeout=20: seen.update(path=path, body=body) or {})
    assert rail.linq_react("m-1", "question", emoji="👀") is True
    assert seen["body"] == {"operation": "add", "type": "custom", "custom_emoji": "👀"}
    assert seen["path"] == "/messages/m-1/reactions"


def test_without_an_emoji_it_is_still_one_of_the_six_types(monkeypatch):
    seen = {}
    monkeypatch.setattr(rail, "_linq_post",
                        lambda path, body, timeout=20: seen.update(body=body) or {})
    rail.linq_react("m-1", "love")
    assert seen["body"] == {"operation": "add", "type": "love"}


def test_a_reaction_that_cannot_send_is_false_not_a_crash(monkeypatch):
    monkeypatch.delenv("LINQ_API_KEY", raising=False)
    assert rail.linq_react("m-1", "question", emoji="👀") is False


def test_the_hint_clamp_uses_the_engines_own_unit(monkeypatch):
    """9/6 09:31, live: "hint clamped 627→500 chars" was immediately followed by
    "co_hint is invalid" and a 422. The engine bounds co_hint with Buffer.byteLength (bytes);
    the router clamped by character count and appended a 3-byte ellipsis, so a 500-character
    hint arrived as 502 bytes and the clamp caused the rejection it existed to prevent."""
    src = (ROUTER / "sendblue_router.py").read_text()
    assert "hint.encode()" in src, "the clamp must measure the same unit the engine measures"
    assert 'hint[:MAX_HINT - 1].rstrip() + "…"' not in src, "the character clamp is the bug"

    for text in ("x" * 900, "á" * 600, "— " * 400):
        raw = text.encode()
        clamped = raw[:router.MAX_HINT - 3].decode("utf-8", "ignore").rstrip() + "..." \
            if len(raw) > router.MAX_HINT else text
        assert len(clamped.encode()) <= router.MAX_HINT, f"{len(clamped.encode())} bytes"


def test_a_split_multibyte_character_does_not_break_the_clamp():
    """Trimming a byte budget can land mid-character; the decode must drop the fragment."""
    raw = ("é" * 400).encode()
    assert len(raw) > router.MAX_HINT
    clamped = raw[:router.MAX_HINT - 3].decode("utf-8", "ignore").rstrip() + "..."
    assert len(clamped.encode()) <= router.MAX_HINT
    clamped.encode().decode("utf-8")          # round-trips: no broken sequence survived
