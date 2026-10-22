"""situation.py — reading the sharing act, not just the thing shared.

Founder ruling (2026-08-06 voice session), which killed the mode-picker:

    "correction on the like one click preference update. I think that's dumb. That
    makes it feel like an AI. It should feel more human… Learn from the context, not
    from forms or buttons."

    "some clues include like how long the video is… if they're sending like five
    things back to back to back, they're probably scrolling Instagram right now…
    there's also like other context clues like the time at which someone sends
    something… they read before bed and like the vibe is like reading during that
    hour. So it's like they're more likely to read long things."

    "I don't know if it can straight be pure length, but I think we're getting closer."

That last line is the whole design. **Extraction is deterministic; the mapping to
intent is not.** So this organ does NOT decide what the member wants. It surfaces the
metadata a person would have noticed without being told — duration, burst shape, local
hour, the gap since they last spoke — and hands it to the relationship mind with a
tentative read attached and permission to disagree with it.

That is the Sherlock rule from the same session: notice far more than you say, and let
the noticing be private machinery rather than a lecture.

Four laws, and they are why this file has no database:

  1. NO STORAGE. A situation read is an expiring hypothesis about ONE moment, never a
     preference learned about a person. Nothing here persists, so nothing here can
     harden into "you are someone who doesn't watch long videos" after one Tuesday.
  2. NO FORM. The read is acted on, never offered. The hint explicitly forbids asking
     the member which mode they want — deciding wrong and being corrected in words is
     the human move; a menu is the AI move.
  3. EXPLICIT NEED WINS. If they actually asked for something, the situation is
     colour, not a veto. `goal.md` §4.6: serve the request before reading the room.
  4. WEAK READS STAY QUIET. Below the confidence floor this emits nothing at all. A
     confident wrong read is worse than no read, and an unsure one is just noise in
     the tail of the prompt where the register budgets live.
"""
from __future__ import annotations

import re

# Provisional thresholds. They exist to make the metadata legible, NOT to decide —
# the raw numbers ride in the hint so the mind can disagree with the bucket.
LONG_SECONDS = 12 * 60          # past here a video stops being a drive-by
VERY_LONG_SECONDS = 25 * 60
LONG_WORDS = 1200               # a real read, not a post
VERY_LONG_WORDS = 3000
BURST_SCROLLING = 3             # three-plus in one window reads as mid-feed
CONFIDENCE_FLOOR = 0.35         # below this, say nothing

# A direct ask outranks every inference here (LAW 3).
_ASK_RE = re.compile(
    r"(\?|^\s*(what|why|how|when|where|who|which|can|could|should|would|is|are|do|does|did|will)\b"
    r"|\b(summarize|summarise|explain|tldr|tl;dr|break (?:this|it) down|thoughts|what do you think)\b)",
    re.I)


def _hhmm(hour: int) -> str:
    return f"{hour % 12 or 12}{'am' if hour < 12 else 'pm'}"


def _daypart(hour: int) -> tuple[str, str]:
    """(label, what it tends to mean). Deliberately coarse — this is a hint, not a model
    of their life, and a tenant with real rhythm data should override it later."""
    if 0 <= hour < 6:
        return "late night", "either winding down or can't sleep"
    if 6 <= hour < 9:
        return "early morning", "getting going, usually short attention"
    if 11 <= hour < 14:
        return "midday", "possibly a break, some room to actually look at something"
    if 21 <= hour < 24:
        return "night", "the hour people actually read longer things"
    return "daytime", "probably between things"


def read(*, texts: list[str] | None = None, media_count: int = 0,
         artifact: dict | None = None, hour: int | None = None,
         gap_s: float | None = None, burst: int | None = None) -> dict:
    """Facts about the sharing act plus a tentative read. Pure — no I/O, no storage.

    texts        the burst's messages, in order
    media_count  attachments in the same burst
    artifact     {"kind": str, "seconds": int|None, "words": int|None} when the eyes
                 already know what was shared; None when they don't
    hour         the member's LOCAL hour (caller resolves the timezone)
    gap_s        seconds since their previous message, when known
    burst        explicit send count, for callers that have already joined the texts —
                 the router coalesces a burst into one string, and "five back to back"
                 is a fact about the person that must survive that join
    """
    texts = [t for t in (texts or []) if (t or "").strip()]
    burst = burst if burst is not None else len(texts) + max(0, media_count)
    joined = " ".join(texts)
    asked = bool(_ASK_RE.search(joined))

    facts: list[str] = []
    reads: list[str] = []
    conf = 0.0

    # --- the artifact -----------------------------------------------------------
    long_thing = False
    if artifact:
        secs, words = artifact.get("seconds"), artifact.get("words")
        kind = artifact.get("kind") or "thing"
        if isinstance(secs, (int, float)) and secs > 0:
            mins = int(secs // 60)
            facts.append(f"{mins}-min {kind}")
            if secs >= VERY_LONG_SECONDS:
                long_thing, conf = True, conf + 0.35
            elif secs >= LONG_SECONDS:
                long_thing, conf = True, conf + 0.25
        elif isinstance(words, (int, float)) and words > 0:
            facts.append(f"~{int(words)}-word {kind}")
            if words >= VERY_LONG_WORDS:
                long_thing, conf = True, conf + 0.3
            elif words >= LONG_WORDS:
                long_thing, conf = True, conf + 0.2

    # --- the burst --------------------------------------------------------------
    scrolling = burst >= BURST_SCROLLING
    if burst > 1:
        facts.append(f"{burst} in one go")
    if scrolling:
        conf += 0.25
        reads.append("they're mid-feed right now, not sitting down with this")

    # --- the clock --------------------------------------------------------------
    if hour is not None:
        label, meaning = _daypart(int(hour) % 24)
        facts.append(f"{_hhmm(int(hour) % 24)} their time")
        if long_thing:
            conf += 0.15
            if 21 <= int(hour) % 24 < 24:
                reads.append(f"{label} — {meaning}, so a long one might actually land")
            elif scrolling:
                reads.append(f"{label} — {meaning}")
            else:
                reads.append(f"{label} — {meaning}")

    # --- the tentative read -----------------------------------------------------
    if long_thing and scrolling:
        reads.insert(0, "they almost certainly have not watched this themselves")
        conf += 0.1
    elif long_thing:
        reads.insert(0, "long enough that they may want the useful part, not a recap")

    if gap_s is not None and gap_s > 6 * 3600 and burst == 1 and not asked:
        reads.append("first thing they've sent in a while")
        conf += 0.05

    conf = min(conf, 0.95)
    if conf < CONFIDENCE_FLOOR or not facts:
        return {"confident": False, "hint": "", "facts": facts, "reads": reads,
                "asked": asked, "confidence": round(conf, 2)}

    return {"confident": True, "asked": asked, "confidence": round(conf, 2),
            "facts": facts, "reads": reads, "hint": hint_line(facts, reads, asked)}


def hint_line(facts: list[str], reads: list[str], asked: bool) -> str:
    """The directive. Facts first so the mind can overrule the read; the no-menu law last,
    because the tail is where the model weights hardest. Kept well under the 500-char cap
    the engine enforces on co_hint."""
    head = "SITUATION (what a person would have noticed, not a verdict): " + " · ".join(facts) + "."
    body = (" Read: " + "; ".join(reads[:2]) + ".") if reads else ""
    if asked:
        tail = (" They ASKED for something — answer that first; this is only colour for how "
                "much and how long.")
    else:
        tail = (" Act on this instead of asking about it: decide how to treat it, say the "
                "assumption in passing if it helps (\"this looks long, i can pull what "
                "matters\"), and never offer them a menu of what you could do.")
    out = head + body + tail
    return out[:480]


def for_turn(tenant: str, texts: list[str], *, media_count: int = 0,
             artifact: dict | None = None, claims_db: str | None = None,
             gap_s: float | None = None, burst: int | None = None) -> str:
    """Router-facing wrapper: resolves their local hour, returns a hint or "".

    Fails silent and empty — a situation read is a nicety, and an organ that can break a
    turn to deliver one has its priorities wrong.
    """
    hour = None
    try:
        import tz_dynamic
        if claims_db:
            hour = tz_dynamic.now_in(str(claims_db), None).hour
    except Exception:
        hour = None
    if hour is None:
        try:
            import datetime as _dt
            hour = _dt.datetime.now().hour
        except Exception:
            return ""
    try:
        return read(texts=texts, media_count=media_count, artifact=artifact,
                    hour=hour, gap_s=gap_s, burst=burst).get("hint") or ""
    except Exception:
        return ""
