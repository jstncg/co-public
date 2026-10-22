#!/usr/bin/env python3
"""Deferred watch — "that's a 40-minute one, let me actually watch it."

The kyo pattern (kyo/watch.py), reimplemented on frame's organs. The problem is the
per-sender lock: a long video watched inline makes co MUTE to every other message while
Gemini chews 20-minute windows — minutes of dead air on the one rail that must feel alive.
The ceiling is LATENCY, not cost.

frame's shape (faster than kyo's reconciler, same durability):
  1. read_links hits a video past the threshold → registers here (durable, pending),
     returns a placeholder read so THIS turn replies honestly ("that's an hour — actually
     watching it, back in a bit").
  2. The router spawns a delivery thread immediately: deep_read (any length), one small
     model call to phrase the take in co's voice, sendblue_send + assistant-only record.
     The read also lands in the journal corpus, so THE FINDING can recall it later.
  3. Crash recovery: the tick sweeps records still pending after 25 minutes (process died
     mid-watch) and re-runs them once. The promise survives a restart — that's the whole
     point of writing state before doing work.

Three honesty rules, kyo's, kept verbatim in spirit:
  - say you're deferring (the placeholder tells the turn),
  - deliver the real thing, not the description,
  - if the watch fails twice, say THAT plainly — never silence after a promise.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

STATE_DIR = os.path.expanduser("~/.co/deferred_watch")
DEFER_SECONDS = int(os.environ.get("CO_DEFER_WATCH_SECONDS", "720"))   # 12 min: past one-call territory
SWEEP_AGE = 25 * 60            # pending this long = the watching process died; re-run
MAX_ATTEMPTS = 2

PHRASE_SYS = """You watched a long video someone sent you earlier, and now you're texting them your
take — the text you send after walking out of a movie, not the notes you took inside. Reply with
what THIS video actually earns — pick ONE mode: a real POSITION when you have one (argue with the
one claim worth arguing; you're allowed to think the famous person is wrong); the single useful
EXTRACTION when it's advice/info they'll actually use; the GIFT when you genuinely have something
to ADD that the video doesn't say — the deeper cut, the fact behind it, the thing it connects to
in their life ("so glad you sent this one — did you know…" energy, ONLY when actually felt;
unearned delight is worse than a flat take); "honestly, skip it" when it's thin (a friend saves
you an hour, that's the whole job); or the WATCH-THIS-SPAN verdict when a stretch beats any
summary. Not every video deserves an opinion — forcing one is its own kind of boring. And never
be predictable: if they could guess your reply's shape from the send, pick a different true mode.
One concrete fact as the hook at most, never four packed in a row.
LENGTH LAW: this is a TEXT, not a review — 2 to 4 sentences, under 90 words, whatever mode you
pick. If the take needs more room than that, it's the wrong take; pick the sharper one.

BANNED (the briefing tells): "his actual take is", "the key insight", "the blind spot everyone
has", "what matters here", any colon-headed labeling, any sentence that just relays a third claim.
If it reads like a summary with adjectives, start over — they can get a summary anywhere; they
keep you around for what YOU think. Never quote raw [M:SS] transcript formatting mid-take.

THE TRIAGE VERDICT: they sent it partly to know if it deserves their own eyes. Usually your take IS
the answer (the summary beats the watch). But when a specific stretch genuinely beats any summary —
visual, emotional, or denser than words can carry — SAY SO with a plain span: "actually watch 4:10
to 11:30, that's the part." Most videos don't earn this; when one does, that line is the single most
useful thing you can send. If THEIR ORBIT is provided below and a stretch lands directly on it, aim
the span at them: "the part that's basically about you is 12:00-14:30."

No preamble, no "as promised". If the material is thin or partial, be honest about which part you
got through. Return ONLY JSON: {"take": "<the message>"}"""

FAIL_LINE = ("tried twice to properly watch that long one and it beat me — couldn't get through it. "
             "if there's a part that matters, send a screenshot or the timestamp and i'll read that.")


def _path(tenant: str) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, f"{tenant}.jsonl")


def _records(tenant: str) -> list:
    try:
        with open(_path(tenant)) as f:
            return [json.loads(l) for l in f if l.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def _rewrite(tenant: str, recs: list) -> None:
    tmp = _path(tenant) + ".tmp"
    with open(tmp, "w") as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, _path(tenant))


def register(tenant: str, url: str, note: str, minutes: int) -> str:
    """Durable-first: the pending record exists BEFORE any watching starts."""
    rid = f"dw{int(time.time() * 1000)}"
    recs = _records(tenant)
    # same URL already pending → don't double-watch (they re-sent it, or two links in one text)
    for r in recs:
        if r["url"] == url and r["state"] == "pending":
            return r["id"]
    recs.append({"id": rid, "url": url, "note": note[:200], "minutes": minutes,
                 "state": "pending", "attempts": 0,
                 "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    _rewrite(tenant, recs)
    return rid


def placeholder(note: str, minutes: int) -> str:
    """What this turn's engine sees instead of the full read."""
    return (f"[shared: a {minutes}-MINUTE video ({note or 'no caption'}) — too long to watch mid-reply; "
            f"you're watching it in the background and your NEXT message will be the real take. "
            f"React the way a friend does when handed {minutes} minutes of someone's content: one line, "
            f"with a beat of attitude about the ask itself — the length, the subject, what it says about "
            f"them that they sent it. ('an hour of chamath? bold. gimme a few' energy — but YOURS, from "
            f"what it actually is, never that example.) Do NOT pretend you watched it yet, do NOT use "
            f"stock phrases like 'real read' or 'in a bit' every time — the line should be different "
            f"every single occasion, because it's about THIS video.]")


def _mark(tenant: str, rid: str, **fields) -> None:
    recs = _records(tenant)
    for r in recs:
        if r["id"] == rid:
            r.update(fields)
    _rewrite(tenant, recs)


def _journal_entry(tenant: str, url: str, read: str) -> None:
    """The delivered read joins the corpus in the entry shape journal owns, so recall and the
    nightly weave see the actual content — not the placeholder the share-turn captured."""
    try:
        import journal
        st = journal._load(tenant)
        st.setdefault("entries", []).append({
            "ts": int(time.time()), "date": time.strftime("%Y-%m-%d"),
            "q": None, "text": f"(the long video, watched) {url}",
            "link": f"[shared: {read[:1500]}]"})
        journal._save(tenant, st)
    except Exception:
        pass


def watch_and_deliver(tenant: str, rid: str, send, record) -> bool:
    """The thread body (and the sweep's retry path). `send(text)` and `record(text)` come from
    the caller so this module never imports the router."""
    recs = {r["id"]: r for r in _records(tenant)}
    rec = recs.get(rid)
    if not rec or rec["state"] != "pending":
        return False
    _mark(tenant, rid, attempts=rec["attempts"] + 1, started=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    try:
        import link_read
        # transcript first (7/29): the stored artifact is the verbatim transcript, so follow-up
        # questions ("didn't he mention two phones?") answer from the actual words — a gist read
        # drops exactly the details people come back for.
        read = link_read.yt_transcript(rec["url"], tenant=tenant)
        if not read:
            read = link_read.deep_read(rec["url"])
    except Exception:
        read = None
    if not read:
        if rec["attempts"] + 1 >= MAX_ATTEMPTS:
            _mark(tenant, rid, state="failed")
            send(FAIL_LINE)
            record(FAIL_LINE)
        else:
            _mark(tenant, rid, state="pending")     # sweep retries once more
        return False
    take = _phrase(read, rec.get("note") or "", tenant=tenant)
    if not take:
        # the phrased take IS the deliverable — raw transcript with [M:SS] markers is a worse
        # message than none (live defect 7/30: the SDK was missing from the router venv, _phrase
        # failed silently, and two raw transcripts shipped). Failure here = attempt failure:
        # the sweep retries; two strikes = the honest line. Never the transcript.
        if rec["attempts"] + 1 >= MAX_ATTEMPTS:
            _mark(tenant, rid, state="failed")
            _journal_entry(tenant, rec["url"], read)   # the WATCH succeeded — memory keeps it
            send(FAIL_LINE)
            record(FAIL_LINE)
        else:
            _mark(tenant, rid, state="pending")
        return False
    _mark(tenant, rid, state="done", done=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    _journal_entry(tenant, rec["url"], read)
    send(take)
    record(take)
    try:
        import work
        mins = rec.get("minutes")
        # Name the thing. Five rows of "a 42-minute video, end to end" is wallpaper
        # (founder, 8/7); the receipt that lands is the one that says WHICH video. The
        # read marker's opening is the best title we already hold — no extra fetch.
        title = re.sub(r"^\[?(?:shared|watched)?:?\s*", "", (read or "")).strip().strip("[]")
        title = re.split(r"[.\n—|]", title, 1)[0].strip()[:64]
        what = (f"“{title}” — {mins} min, end to end" if title and mins
                else f"“{title}”, end to end" if title
                else f"a {mins}-minute video, end to end" if mins else "a long video, end to end")
        work.log(tenant, "watched", what,
                 why="so the take you got came from the whole thing", url=rec.get("url"))
    except Exception:
        pass
    return True


def _orbit(tenant: str) -> str:
    """Their live themes (wrapped's daily cache) — tiny, current, exactly what they circle."""
    try:
        import json as _j
        c = _j.load(open(os.path.expanduser(f"~/.co/wrapped/{tenant}.themes.json")))
        return ", ".join(c.get("themes") or [])
    except Exception:
        return ""


def _phrase(read: str, note: str, tenant: str = "") -> str:
    try:
        import asyncio
        import episode_engine as ee
        orb = _orbit(tenant) if tenant else ""
        got = asyncio.run(ee._ask(PHRASE_SYS,
                                  f"CAPTION/CONTEXT: {note}\n"
                                  + (f"THEIR ORBIT (what they keep circling): {orb}\n" if orb else "")
                                  + f"\nWHAT WAS SAID (with timestamps):\n{read[:12000]}",
                                  ee.JUDGE_MODEL, max_tokens=400)) or {}
        t = (got.get("take") or "").strip()
        if t:
            t = t[:700]
            # THE VOICE GATE (8/5): this composer was the ONE send path that never ran
            # disposition. It shipped an em-dashed, capitalized, essay-register message
            # at 08:01 — a different person than the rest of the thread. De-tic first
            # (em-dash → period, the humanizer law), then hold it to the same bar as
            # every other surface; a violating take is no take.
            try:
                import re as _re

                import disposition
                t = _re.sub(r"\s*[—–]\s*", ". ", t)
                if disposition.violations(t, max_chars=1000):
                    return None
            except Exception:
                pass
            return t
    except Exception:
        pass
    return None                                      # a raw transcript is never the message


def sweep(tenant: str, send, record) -> int:
    """Crash recovery, called from the tick: re-run pendings whose watcher died. Returns count run."""
    now = time.time()
    ran = 0
    for r in _records(tenant):
        if r["state"] != "pending" or r["attempts"] >= MAX_ATTEMPTS:
            continue
        try:
            age = now - time.mktime(time.strptime(r["created"], "%Y-%m-%dT%H:%M:%SZ"))
        except ValueError:
            age = SWEEP_AGE + 1
        if age >= SWEEP_AGE:
            watch_and_deliver(tenant, r["id"], send, record)
            ran += 1
    return ran


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else "dennis"
    for r in _records(t):
        print(f"- [{r['state']}] {r['minutes']}min attempts={r['attempts']} {r['url'][:60]}")
