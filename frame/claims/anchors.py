#!/usr/bin/env python3
"""Callback anchors — event-driven proactivity (the 2:45 move).

When they mention a TIMED thing ("pitch at 2 tomorrow", "deciding by friday", "dinner with mom tonight"),
extract it as an anchor with an absolute fire time in THEIR timezone. A due anchor is Co's licence to reach
out unprompted about that specific thing ("how'd the pitch go") — the single most in-it-with-you move the
product has. Events fire a beat AFTER the thing (you ask how it went, not announce it's happening);
deadlines fire ON the day.

Also: ABSENCE anchors — a thread they hit ≥4 times that's gone quiet for 3+ days earns ONE (ever) gentle
callback candidate. Pattern-driven, needs no new data, rides threads.json.

RESTRAINT: extraction is capture-time bookkeeping; FIRING is proactive_tick.py's job, behind the shared
callback budget (one proactive resurface/day — an anchor firing makes tonight's daily text yield
automatically), quiet hours in the tenant's tz, the skip flag, and an abstaining composer.

Store: <claims_db>.anchors.json  {"anchors":[{when, kind, what, quote, created, fired}], "absence_done":[label]}
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Deterministic pre-gate (~0ms): only run the LLM resolver when the text plausibly contains a timed thing.
TIMEY = re.compile(
    r"\b(today|tonight|tomorrow|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"next week|this week(end)?|weekend|\d{1,2}(:\d{2})?\s*(am|pm)|noon|midnight|"
    r"in\s+(a|an|\d+)\s*(half\s+)?(m|min|mins|minutes?|h|hr|hrs|hours?)\b|"
    r"by (the )?(end of|eod|friday|monday|tuesday|wednesday|thursday|weekend)|deadline|due)\b", re.I)
# An EXPLICIT ask ("remind me", "ping me") is a PROMISE, not an interruption: no friend-bar, fires at the
# asked time, and the tick exempts it from the daily proactive budget. Failing to deliver = broken word.
# An explicit ask for co to DO something at a time. Broadened 8/5: Justin said "send this to
# me today at 8:30am", this pattern didn't recognize it as a request, so it was treated as an
# organic mention of a past time and silently dropped — after co had already said "got it."
# Anything of the shape <deliver-verb> ... me ... <time> is a promise being made.
# Re-broadened 8/9: Justin asked "text me IN 10 mins" and "set a reminder for me in 20
# mins" — neither matched ("text me" only knew at/when/tomorrow/tonight/later; "set a
# reminder" wasn't a request shape at all), the gate never let the LLM run, and co said
# "got it, i'll ping you" over a promise that was never scheduled. Twice.
REQUEST_RE = re.compile(
    r"\b(remind me|ping me|text me (at|when|in|tomorrow|tonight|later)|"
    r"(message|msg) me (at|when|in)|set (me )?a reminder|check (in|back) (on|with) me|"
    r"follow up with me|don'?t let me forget|hold me to|"
    r"(send|shoot|share|forward|resend|show|give|bring)\s+(me\b|this\b|that\b|it\b|these\b)"
    r"[^.?!]{0,40}\b(to me|me)?\b[^.?!]{0,40}"
    r"(today|tonight|tomorrow|tmrw|later|in the morning|at \d{1,2})|"
    r"wake me|hit me up|message me)\b", re.I)
# Things that look timed but aren't theirs to follow up on (weather, sports schedules, generic news).
NOT_OURS = re.compile(r"\b(forecast|kickoff|game (is|at)|episode|premiere|sale ends)\b", re.I)

EXTRACT_SYS = """From this text someone sent to a friend, extract any REAL timed events or deadlines in THEIR
OWN life — a meeting, a call, a decision they said they'd make, a thing they're doing. NOT other people's
schedules, not media/sports/weather, not vague aspirations ("someday"), not things already past.

For each (max 2), given NOW in their timezone:
- what: 3-8 words, their words where possible ("the pitch", "dinner with mom", "decide on the offer")
- kind: "event" (happens at a time → follow up AFTER) or "deadline" (decide/finish BY a time → nudge ON it)
- repeat: null, or one of "daily" | "weekdays" | "weekly" | "monthly" when they asked for something
  RECURRING ("every morning", "every monday", "each week", "daily", "every day at 8"). when_iso is
  then the FIRST occurrence. A one-off ask has repeat: null.
- when_iso: the absolute local datetime it happens/is due (resolve "tomorrow 2pm" etc against NOW; a bare
  weekday means the NEXT one; "tonight" = 20:00 today; a deadline day with no time = 18:00 that day)
  ALWAYS RESOLVE FORWARD. A clock time that has already passed today means the NEXT occurrence, not a
  past one: "today at 8:30am" said at 9pm means TOMORROW 08:30. Never emit a when_iso before NOW —
  that request is silently dropped downstream and the person is left with a promise nobody kept.
Return ONLY JSON: {"anchors":[{"what","kind","when_iso","repeat"}]} — empty list if nothing real.
Bar: only things a friend would NATURALLY ask about later. When unsure, leave it out.
EXCEPTION — an explicit ask for YOU to do something at a time ("remind me", "ping me", "don't let me
forget", "send this to me at 8:30", "shoot me that tomorrow"): ALWAYS extract it (the bar does not
apply; they asked, and co will have already said yes). The "what" is the thing to deliver. If they
gave no time, when_iso = tomorrow 09:30 local. kind = "deadline"."""

FOLLOWUP_OFFSET_MIN = 45          # events: fire this long AFTER the moment ("how'd it go")
ABSENCE_QUIET_DAYS = 3            # a hot thread silent this long → one candidate
ABSENCE_MIN_COUNT = 4


def _store_path(claims_db: str) -> str:
    return f"{claims_db}.anchors.json"


def _load(claims_db: str) -> dict:
    p = _store_path(claims_db)
    try:
        return json.loads(open(p).read()) if os.path.exists(p) else {"anchors": [], "absence_done": []}
    except (json.JSONDecodeError, OSError):
        return {"anchors": [], "absence_done": []}


def _save(claims_db: str, st: dict) -> None:
    p = _store_path(claims_db)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, p)


def extract(claims_db: str, text: str) -> int:
    """Capture-time: pull timed anchors out of a send. Cheap gate first; LLM only on a hit. Returns #added."""
    requested = bool(text and REQUEST_RE.search(text))
    if not text or (not TIMEY.search(text) and not requested) or (NOT_OURS.search(text) and not requested):
        return 0
    try:
        import llm
        import tz_dynamic
        now = tz_dynamic.now_in(claims_db)
        out = llm.complete_with_fallbacks(
            llm.phrase_specs(), EXTRACT_SYS,
            f"NOW (their local time): {now.strftime('%A %Y-%m-%d %H:%M')}\n\nTHE TEXT:\n{text[:800]}",
            max_tokens=250)
        m = re.search(r"\{.*\}", out or "", re.S)
        found = json.loads(m.group(0)).get("anchors", []) if m else []
    except Exception:
        return 0
    if not found:
        return 0
    st = _load(claims_db)
    added = 0
    for a in found[:2]:
        try:
            when = dt.datetime.fromisoformat(a["when_iso"])
        except (KeyError, ValueError):
            continue
        # A SCHEDULED INSTANT CARRIES ITS ZONE (8/30). The model returns when_iso however it likes,
        # and a bare wall-clock time was stored bare — so the instant silently inherited whichever
        # machine happened to read it later. `due()` patches it back at read time, which means the
        # value on disk was always ambiguous and the patch was the only thing standing between a
        # tester and a reminder three hours early (8/6). Stamp it once, at birth, in the tenant's
        # own zone; nine legacy anchors across three graphs are repaired by anchors_repair.py.
        if when.tzinfo is None:
            try:
                import tz_dynamic
                from zoneinfo import ZoneInfo
                _name = tz_dynamic.get_tz(claims_db)
                when = when.replace(tzinfo=ZoneInfo(_name)) if _name else when.astimezone()
            except Exception:
                when = when.astimezone()
        what = (a.get("what") or "").strip()
        kind = a.get("kind") if a.get("kind") in ("event", "deadline") else "event"
        if not what:
            continue
        # ROLL FORWARD RATHER THAN DROP (8/5, from Justin's broken 8:30 ping). He asked at
        # 21:44 for "8:30am today"; the model resolved it to a time already 13 hours past,
        # this guard silently dropped it — and co had ALREADY said "got it, pinging you at
        # 8:30am". A promise made and not recorded is the worst failure the product has.
        # An EXPLICITLY REQUESTED time in the past is nearly always the next occurrence.
        now_local = dt.datetime.now(when.tzinfo)
        if when < now_local - dt.timedelta(hours=1):
            if requested:
                while when < now_local:
                    when += dt.timedelta(days=1)
            else:
                continue                 # organic mention of a past thing → not an anchor
        # dedupe: same what-ish on the same day
        key = (what.lower()[:30], when.date().isoformat())
        if any((x["what"].lower()[:30], x["when"][:10]) == key for x in st["anchors"]):
            continue
        # requested reminders fire AT the asked time (a promise); organic events fire after (the follow-up)
        fire = when + dt.timedelta(minutes=FOLLOWUP_OFFSET_MIN) if (kind == "event" and not requested) else when
        rep = a.get("repeat") if a.get("repeat") in ("daily", "weekdays", "weekly", "monthly") else None
        st["anchors"].append({"what": what, "kind": kind, "when": when.isoformat(),
                              "fire": fire.isoformat(), "quote": text[:160], "requested": requested,
                              "repeat": rep,
                              "created": dt.datetime.now().isoformat(timespec="seconds"), "fired": False})
        added += 1
    if added:
        st["anchors"] = st["anchors"][-40:]
        _save(claims_db, st)
    return added


def due(claims_db: str, now=None) -> list:
    """Anchors whose fire time has passed (in the tenant's tz), unfired, not stale (>36h past = missed)."""
    import tz_dynamic
    now = now or tz_dynamic.now_in(claims_db)
    out = []
    for a in _load(claims_db)["anchors"]:
        if a.get("fired"):
            continue
        try:
            fire = dt.datetime.fromisoformat(a["fire"])
            if fire.tzinfo is None:
                fire = fire.replace(tzinfo=now.tzinfo)
        except ValueError:
            continue
        if fire <= now <= fire + dt.timedelta(hours=36):
            out.append(a)
        elif now > fire + dt.timedelta(hours=36):
            mark_fired(claims_db, a, note="stale")     # missed the window — never nag about old news
    return out


def mark_fired(claims_db: str, anchor: dict, note: str = "") -> None:
    """Retire a one-off promise. A RECURRING one is rescheduled to its next occurrence instead —
    'remind me every morning' must survive its own delivery (8/5: co told Justin it had no way to
    do recurring reminders, which was a denial of a power it should have)."""
    st = _load(claims_db)
    for a in st["anchors"]:
        if a.get("what") == anchor.get("what") and a.get("fire") == anchor.get("fire"):
            rep = a.get("repeat")
            if rep and note not in ("stale", "cancelled by user"):
                try:
                    nxt = _next_occurrence(dt.datetime.fromisoformat(a["fire"]), rep)
                    a["fire"] = nxt.isoformat()
                    a["when"] = nxt.isoformat()
                    a["fired"] = False
                    a["last_fired"] = dt.datetime.now().isoformat(timespec="seconds")
                except ValueError:
                    a["fired"] = True
            else:
                a["fired"] = True
            if note:
                a["note"] = note
            break
    _save(claims_db, st)


def _next_occurrence(fire: dt.datetime, repeat: str) -> dt.datetime:
    """The next fire time for a recurring anchor, always strictly in the future."""
    now = dt.datetime.now(fire.tzinfo)
    nxt = fire
    guard = 0
    # ALWAYS advance at least one period: this occurrence just fired, so the next one is by
    # definition later — then keep advancing until it is genuinely in the future.
    first = True
    while (first or nxt <= now) and guard < 400:
        first = False
        guard += 1
        if repeat == "daily":
            nxt += dt.timedelta(days=1)
        elif repeat == "weekdays":
            nxt += dt.timedelta(days=1)
            while nxt.weekday() >= 5:                  # skip sat/sun
                nxt += dt.timedelta(days=1)
        elif repeat == "weekly":
            nxt += dt.timedelta(days=7)
        elif repeat == "monthly":
            m, y = nxt.month + 1, nxt.year
            if m > 12:
                m, y = 1, y + 1
            day = min(nxt.day, 28)                     # never skip a month on the 31st
            nxt = nxt.replace(year=y, month=m, day=day)
        else:
            break
    return nxt


def pending(claims_db: str) -> list:
    """Every live promise, soonest first — what co owes them. The read side of reminders:
    without it co cannot answer "what are you reminding me about?" (8/5)."""
    out = [a for a in _load(claims_db)["anchors"] if not a.get("fired") or a.get("repeat")]
    return sorted(out, key=lambda a: a.get("fire", ""))


def cancel(claims_db: str, needle: str) -> dict | None:
    """Drop a promise by loose text match (their words or co's). Returns the cancelled anchor."""
    needle = (needle or "").strip().lower()
    if len(needle) < 3:
        return None
    st = _load(claims_db)
    for a in sorted(st["anchors"], key=lambda x: x.get("fire", "")):
        if a.get("fired") and not a.get("repeat"):
            continue
        hay = f"{a.get('what','')} {a.get('quote','')}".lower()
        if needle in hay or any(w in hay for w in needle.split() if len(w) > 3):
            a["fired"] = True
            a["repeat"] = None                          # cancelling a recurring kills the series
            a["note"] = "cancelled by user"
            _save(claims_db, st)
            return a
    return None


def absence_candidate(claims_db: str):
    """ONE (ever, per thread) callback for a hot thread gone quiet. Returns {label, count, last} or None."""
    p = f"{claims_db}.threads.json"
    try:
        th = json.loads(open(p).read()) if os.path.exists(p) else {}
    except (json.JSONDecodeError, OSError):
        return None
    st = _load(claims_db)
    today = dt.date.today()
    for t in th.get("topics", []):
        if t.get("count", 0) < ABSENCE_MIN_COUNT or t.get("label") in st["absence_done"]:
            continue
        try:
            last = dt.date.fromisoformat(t.get("last", ""))
        except ValueError:
            continue
        if ABSENCE_QUIET_DAYS <= (today - last).days <= 10:
            return t
    return None


def mark_absence_done(claims_db: str, label: str) -> None:
    st = _load(claims_db)
    if label not in st["absence_done"]:
        st["absence_done"].append(label)
    _save(claims_db, st)


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent / "claims.db")
    if "--extract" in sys.argv:
        i = sys.argv.index("--extract")
        print(f"added {extract(db, sys.argv[i+1])} anchors")
    print("DUE:", json.dumps(due(db), indent=1))
    print("ABSENCE:", absence_candidate(db))
