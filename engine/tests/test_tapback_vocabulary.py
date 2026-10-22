"""A mark is a whole sentence, and 👍 is a sentence that ends the turn (9/8).

8/26 read the marks as co's own processing stages and 9/5 kept that frame, so they fired at
receipt on every send: 👍 received, 👀 read. Both stages are true of everything co is sent, so
both fired always, and a signal that fires always is not a signal — 8/7's objection to the
thumbs-up, which 9/5 answered by adding a second mark with the same defect. Worse, a receipt has
to be issued before the ladder runs, so the 👍 landed in front of every reply co then wrote.

9/8 (founder: "thumbs up is a sign of received, so whenever you send thumbs up, there should
usually not be a reply afterwards ... thumbs up alone is enough signal"):

  👍  the WHOLE answer. Fires only from the branch that chose silence. Never beside words.
  👀  surprise — a source they have never sent co before. A fact about THEM, not about co's
      plumbing, so it is decided at receipt and is free to come with a reply.

The restraint 8/26 won is untouched: co still answers almost nothing in words. What changed is
that the mark no longer competes with the answer.
"""
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROUTER = REPO / "frame" / "homebase" / "router"
sys.path.insert(0, str(REPO / "frame" / "claims"))
sys.path.insert(0, str(ROUTER))

import sendblue_router as R  # noqa: E402


def test_a_plain_deposit_is_filed_out_loud():
    # 8/26 made the deposit silent; 9/5 put the floor back ("there was literally no reaction").
    # pick_tapback still names the deposit's mark — 9/8 only moved WHEN it is allowed to fire.
    assert R.pick_tapback("https://example.com/a-thing") == "like"
    assert R.pick_tapback("this one is interesting") == "like"


def test_the_thumbs_up_is_the_whole_answer_and_never_precedes_one():
    # THE 9/8 RULING. The receipt path must not POST the bare like: at receipt nothing knows
    # whether the ladder is about to speak, and "cool, saw it" one second before a real reply is
    # co talking over itself. Only mark_received — reached from the branch that chose silence —
    # may send it.
    src = (ROUTER / "sendblue_router.py").read_text()
    ack = src.split("def send_ack")[1].split("\n    def mark_received")[0]
    assert 'immediate = "" if ack_mark == "like" and not ack_emoji else ack_mark' in ack
    assert "sendblue_react(message_handle, immediate" in ack
    assert "sendblue_react(message_handle, ack_mark)" not in ack      # the 9/5 receipt, gone

    got = src.split("def mark_received")[1].split("\n    # ACK IMMEDIATELY")[0]
    assert 'ack_mark != "like"' in got                   # ‼️/❤️ have their own mark already
    # `final_mark` alone is not a bail: _do can leave the verdict owed and POST nothing
    assert "if final_mark and marked.is_set():" in got
    verdict = [l for l in got.splitlines() if l.strip().startswith("if owed or")][0]
    assert "final_mark" in verdict, "an owed-but-unlanded verdict must still ship the ❓"
    assert "elif marked.is_set():" in got                 # the eyes landed and the read was good
    assert "sendblue_react(message_handle, kind)" in got   # "like", or ❓ if the read failed

    # and it is called from exactly one place: the terminal restraint branch of _content_respond
    assert src.split("def _content_respond")[1].count('mark_received(owed="?" in words_only(text))') == 1
    held = src.split("THE MARK IS THE WHOLE ANSWER")[1][:1100]
    assert 'sent = mark_received(owed=' in held and '_log_timing(tenant, "held"' in held
    # and it records the MARK, never an emoji: `ack` used to put a bare 👀 in the transcript
    assert '"(marked it received, no words)"' in held
    code = "\n".join(l for l in held.splitlines() if not l.strip().startswith("#"))
    assert "👀" not in code, "an emoji reached the transcript again"


def test_silence_from_the_engine_uses_the_same_writer_as_silence_from_the_ladder():
    """[SILENCE] POSTed its own bare 👍, gated only on `marked` — which the receipt POST used to
    set for every deposit. Once the bare 👍 started waiting, that guard stopped closing and this
    became a SECOND writer: on a media-all-failed send it could overwrite the ❓ with "cool, saw
    it" on something co could not open. Same rule, one writer."""
    src = (ROUTER / "sendblue_router.py").read_text()
    sil = src.split("silence with a receipt")[1][:900]
    assert "if is_imessage and mark_received and not final_mark:" in sil
    assert 'mark_received(owed="?" in words_only(text))' in sil   # the SAME check the ladder makes
    # the raw POST survives ONLY for text-only sends, which have no read to verify
    assert "not mark_received and not marked.is_set()" in sil
    # and both guards are in scope for it: they are declared beside `marked`, not in the content path
    head = src.split("ONE WRITER PER MESSAGE")[1].split("def timed_send")[0]
    assert "final_mark: List[tuple] = []" in head and "mark_received = None" in head
    assert src.count("final_mark: List[tuple] = []") == 1


def test_the_question_outranks_the_eyes():
    """A novel host is the one most likely to fail to open, so exempting the eyes from the ❓
    correction left exactly the sends that needed correcting wearing "co found this interesting"."""
    src = (ROUTER / "sendblue_router.py").read_text()
    got = src.split("def mark_received")[1].split("\n    # ACK IMMEDIATELY")[0]
    guard = [l for l in got.splitlines() if l.strip().startswith("if not is_imessage")][0]
    assert "ack_emoji" not in guard, "the eyes must not gate the correction"
    assert got.index("is_a_real_read") < got.index("elif marked.is_set()")


def test_a_failed_mark_still_degrades_to_nothing_not_to_a_text():
    # 8/29: three failed tapback POSTs reached a member as three bubbles containing one eye each,
    # and their next active day went 6 turns down to 2. The new writer must obey the same law.
    src = (ROUTER / "sendblue_router.py").read_text()
    got = src.split("def mark_received")[1].split("\n    # ACK IMMEDIATELY")[0]
    assert "sendblue_send" not in got
    assert "no text fallback" in got


def test_an_ask_reads_as_on_it():
    for t in ("remind me friday", "keep an eye on this", "can you find the pricing",
              "cancel that", "follow up with him"):
        assert R.pick_tapback(t) == "emphasize", t


def test_both_question_tests_read_the_same_string_the_same_way():
    """`owed` was stripped and ANSWER-FIRST was not, so one function decided "is this a question"
    two different ways — and the unstripped one sent co to the ENGINE to speak on a plain share,
    which is the restraint violation, not just a wrong mark."""
    src = (ROUTER / "sendblue_router.py").read_text()
    resp = src.split("def _content_respond")[1]
    answer_first = [l for l in resp.splitlines() if l.strip().startswith('if "?" in')]
    assert answer_first, "ANSWER-FIRST branch not found"
    for line in answer_first:
        assert "words_only(text)" in line, line.strip()
    assert 'if "?" in text:' not in src


def test_a_url_is_not_something_they_said():
    """_ASK_RE matched the literal "watch" in youtube.com/watch and "track" in spotify/track, so
    EVERY youtube and spotify deposit wore ‼️ "on it, expect something back" and then got silence.
    The same class bit the 9/8 `owed` check via "?" in ?si= and ?utm_source=."""
    for t in ("https://www.youtube.com/watch?v=abc", "https://open.spotify.com/track/xyz",
              "https://x.com/a/status/1?s=20", "https://www.youtube.com/watch?v=1&t=3"):
        assert R.pick_tapback(t) == "like", t
        assert "?" not in R.words_only(t), t
    # a real ask still reads as one, link or no link
    assert R.pick_tapback("watch this for me https://youtube.com/watch?v=1") == "emphasize"
    assert R.pick_tapback("what do you make of this? https://x.co/a") == "like"
    assert "?" in R.words_only("what do you make of this? https://x.co/a")


def test_an_explicit_action_outranks_the_text():
    assert R.pick_tapback("https://example.com/x", action="acting") == "emphasize"


def test_co_admits_it_could_not_see():
    assert R.pick_tapback("https://example.com/x", action="unclear") == "question"


def test_tone_still_wins_for_people_not_jobs():
    assert R.pick_tapback("lmao that's incredible") == "laugh"
    assert R.pick_tapback("honestly i'm cooked, today was brutal") == "love"


def test_co_never_reaches_for_dislike():
    src = (ROUTER / "sendblue_router.py").read_text()
    body = src.split("def pick_tapback")[1].split("\ndef ")[0]
    assert "dislike" not in body


def test_a_blind_ack_is_corrected_rather_than_left_standing():
    # an ‼️ or 👀 fires before the read, so it can turn out to be a claim co could not back
    src = (ROUTER / "sendblue_router.py").read_text()
    up = src.split("UPGRADE THE TAPBACK")[1][:600]
    assert "media_failed" in up and "not media_enrich" in up
    assert '"question"' in up


def test_our_own_outage_never_wears_a_reaction():
    # 9/3 stopped co texting a bare 👀 when the engine died; 9/8 also takes the glyph off the ❓,
    # because 👀 now claims interest. And the crash floor must not send a text bubble at all.
    src = (ROUTER / "sendblue_router.py").read_text()
    assert 'emoji="👀"' not in src
    assert 'sendblue_send(sender, "👀")' not in src
    empty = src.split("engine returned nothing twice")[1][:600]
    assert 'sendblue_react(message_handle, "question")' in empty


def test_the_mark_actually_fires_from_silence_and_actually_does_not_from_words():
    """The rest of this file reads the source. This one RUNS it.

    Every guard here is a string match against sendblue_router.py, which proves the line is
    written and nothing about whether it is reached — and the 9/8 rule is entirely about which
    branch reaches it. So: drive _content_respond down each exit and watch the mark."""
    import unittest.mock as mock

    def drive(*, tier="light", text="https://example.com/x", enriched="[shared: a page]",
              engine_reply="", take=""):
        marks, said = [], []
        with mock.patch.object(R, "_deep_watch_block", return_value=None), \
             mock.patch.object(R, "_mission_moment", return_value=False), \
             mock.patch.object(R, "_take_line", return_value=take), \
             mock.patch.object(R, "ask_engine", return_value=engine_reply), \
             mock.patch.object(R, "_record_turn"), mock.patch.object(R, "_log_send"), \
             mock.patch.object(R, "_log_timing"), \
             mock.patch.dict(sys.modules, {"co_react": mock.MagicMock(
                 LINE="line", react=mock.Mock(return_value={
                     "tier": tier, "reaction": "the one line", "why": "", "how": ""}))}):
            R._content_respond("+1", "t", text, enriched, True, "c.db", "m.db", {}, 0.0,
                               lambda r: said.append(r), "👀", None,
                               record_turn=lambda u, r: None,
                               mark_received=lambda owed=False: marks.append(owed) or "like")
        return marks, said

    # SILENCE → the mark, carrying the enrichment so it can tell a read from a failure
    marks, said = drive()
    assert said == [] and marks == [False], (marks, said)

    # a question that reached silence means the engine gave nothing twice — words were OWED and
    # never came, so the mark must not be the one that says "that is my whole answer"
    marks, said = drive(text="what is this? https://x.co/a", engine_reply="")
    assert said == [] and marks == [True], (marks, said)
    # but a "?" that is only a URL query string is NOT a question co failed to answer
    marks, said = drive(text="https://x.com/a/status/1?s=20")
    assert said == [] and marks == [False], (marks, said)

    # WORDS → no mark. Each of the three branches that can speak over a deposit.
    for kw in ({"tier": "line"},                                   # the rare one-liner
               {"text": "what do you make of this? https://x.co/a", "engine_reply": "a take"},
               {"take": "an unprompted opinion"}):
        marks, said = drive(**kw)
        assert len(said) == 1 and marks == [], (kw, marks, said)


def test_the_mark_tells_a_read_from_a_failure_at_runtime():
    """mark_received is a closure over the turn, so the only honest test builds the turn. This
    pins the 👍/❓ split on the actual enrichment strings link_read emits."""
    import unittest.mock as mock
    import link_read

    def mark_for(enrichment, *, ack_mark="like", already=False, final=None, owed=False):
        # the closure's exact body, kept in one place: if this drifts the source assert catches it
        if ack_mark != "like":
            return None
        if final and already:
            return "landed"                      # the verdict is on the message; report, do not repeat
        if owed or final or not link_read.is_a_real_read(enrichment):
            return "question"
        return None if already else "like"

    assert mark_for("[shared: a dense page on scaling laws]") == "like"
    assert mark_for("[shared: a page that couldn't be opened — say so plainly]") == "question"
    assert mark_for("[shared: a 41-MINUTE video (x) — too long to watch mid-reply]") == "question"
    assert mark_for("[shared: a dense page]", already=True) is None   # the eyes landed, read good
    assert mark_for("anything", ack_mark="emphasize") is None         # ‼️ has words coming
    assert mark_for("anything", final=[("question", "")], already=True) == "landed"
    # a question that reached silence was never answered: 👍 would claim it was
    assert mark_for("[shared: a dense page]", owed=True) == "question"
    # THE ❓ OUTRANKS THE EYES. A novel host is the one MOST likely to fail to open, so exempting
    # the eyes left exactly the sends that needed correcting wearing "co found this interesting".
    assert mark_for(None, already=True) == "question"
    # AND A VERDICT THAT NEVER LANDED IS NOT A BAIL. _do POSTs nothing when the read outruns its
    # 90s wait, or when an eyes POST failed before it — final_mark set, message bare, no mark.
    assert mark_for("[shared: a page]", final=[("question", "")]) == "question"
    assert mark_for("[shared: a page]", final=[("question", "")], already=True) == "landed"
    # AN EMPTY ENRICHMENT IS NOT A READ. enriched prepends their raw text, so passing it made
    # is_a_real_read true whenever capture threw — a 👍 on a link co never opened.
    assert mark_for(None) == "question" and mark_for("") == "question"
    assert link_read.is_a_real_read("https://vimeo.com/123") is True    # why `enriched` was wrong
    # and the real closure agrees on shape: it reads is_a_real_read and posts `kind`
    src = (ROUTER / "sendblue_router.py").read_text()
    got = src.split("def mark_received")[1].split("\n    # ACK IMMEDIATELY")[0]
    assert "link_read.is_a_real_read(enrichment)" in got


def test_typing_is_never_shown_when_co_will_say_nothing():
    # a typing bubble runs up to 45s on Sendblue, has no stop call at all on Linq, and auto-stops
    # only on a send. Firing it for a turn that ends in a tapback promises words that never come.
    assert R.will_speak("https://arxiv.org/abs/2509.01234", []) is False
    assert R.will_speak("check this out https://example.com/x", []) is False
    # words are still coming for a question, an ask, or an attachment — and for plain text, which
    # the TEXT-ONLY FAST PATH always answers.
    assert R.will_speak("https://example.com/x what do you make of this?", []) is True
    assert R.will_speak("look into https://example.com/x", []) is True
    assert R.will_speak("", ["https://cdn.example.com/a.jpg"]) is True
    assert R.will_speak("just shipped it", []) is True


def test_the_call_site_that_actually_fired_is_the_one_that_is_gated():
    # the 8/26 guard in the content path was correct and DEAD: _process fired the indicator for
    # every inbound in MODE co, 600 lines above it. Testing the predicate alone let that revert
    # silently, so this pins the call site. The content-path guard is gone as a duplicate POST —
    # same predicate, same arguments, same turn.
    src = (ROUTER / "sendblue_router.py").read_text()
    assert 'if MODE == "co" and will_speak(text, media_urls):' in src
    assert 'if MODE == "co":\n        sendblue_typing' not in src
    assert "if is_imessage and will_speak(text, media_urls):\n        sendblue_typing" not in src


def test_the_slowest_speaking_path_keeps_its_bubble():
    # the deep watch re-watches every clip with the full prompt and is the longest wait in the
    # product — and none of its triggers are asks. Suppressing typing there was the regression
    # this predicate nearly shipped: _deep_watch_block's own docstring says the bubble covers it.
    for t in ("tldr https://arxiv.org/abs/1", "explain this https://x.co/a",
              "summarize this https://x.co/a", "break this down https://x.co/a",
              "go deeper https://x.co/a", "did he mention the pricing https://x.co/a"):
        assert R.will_speak(t, []) is True, t


def test_will_speak_fails_toward_the_bubble():
    # it runs in _process ABOVE the try that owns the floor ack, and _flush_burst's wrapper is
    # try/finally with no except — a raise here would take the whole reply with it.
    import unittest.mock as mock
    with mock.patch.object(R, "pick_tapback", side_effect=RuntimeError("boom")):
        assert R.will_speak("https://example.com/x", []) is True


def test_the_eyes_only_ship_on_the_rail_that_can_carry_them():
    # on Sendblue the emoji arg is dropped, so the eyes would arrive as a plain 'like' — not a
    # degraded glyph but the wrong sentence, since 👍 is terminal and 👀 is not. Apple's tapback
    # format also has distinct add and remove codes and a repeat tap is a REMOVE, so the worst
    # case deletes the mark. Unmeasured against the live API, so it stays off there.
    import unittest.mock as mock
    import co_react
    with mock.patch.object(co_react, "novel_source", return_value=True):
        for rail_name, expected in (("linq", True), ("sendblue", False)):
            with mock.patch.dict(os.environ, {"CO_RAIL": rail_name}):
                assert R.eyes_worthy("https://never-seen.example/x", "m.db") is expected, rail_name
    # and a novelty check that raises costs the eyes, never the send
    with mock.patch.dict(os.environ, {"CO_RAIL": "linq"}), \
         mock.patch.object(co_react, "novel_source", side_effect=RuntimeError("boom")):
        assert R.eyes_worthy("https://x.co/a", "m.db") is False


def test_the_eyes_are_surprise_and_not_a_read_receipt():
    # 9/8: co reads everything it is sent, so a mark reporting the read fires always and reports
    # co's plumbing. The read-verdict eyes are gone; nothing may put them back on is_a_real_read.
    src = (ROUTER / "sendblue_router.py").read_text()
    assert "UPGRADE THE TAPBACK TO THE EYES" not in src
    assert 'final_mark.append(("like", EYES))' not in src
    # decided at receipt instead, off their own history, so it can sit beside a reply
    assert 'ack_emoji = EYES if ack_mark == "like" and eyes_worthy(text, memory_path) else ""' in src
    assert R.EYES == "👀"


def test_novelty_is_measured_against_their_own_sends_and_needs_a_shelf():
    # "i have never seen you send something like this" is a claim about THEM, so it is a host
    # absent from their send history — and it is only a claim once there is a history. In week one
    # every link is a first, so an unfloored check would fire on all of them and say nothing.
    import sqlite3, tempfile, datetime as dt
    import co_react
    with tempfile.TemporaryDirectory() as d:
        db = os.path.join(d, "co_memory.db")
        seen = "https://youtube.com/watch?v=%d"
        assert co_react.novel_source(seen % 0, db) is False        # no file, no claim
        c = co_react._memory(db)
        now = dt.datetime.now().isoformat()
        for i in range(co_react.NOVEL_FLOOR - 1):
            c.execute("INSERT INTO co_sends (ts, send, tier, reaction, matched, theme) "
                      "VALUES (?,?,?,?,?,?)", (now, seen % i, "light", "", "", "other"))
        c.commit()
        # one short of the floor: co has not seen enough of them to be surprised by anything
        assert co_react.novel_source("https://arxiv.org/abs/2509.1", db) is False
        c.execute("INSERT INTO co_sends (ts, send, tier, reaction, matched, theme) "
                  "VALUES (?,?,?,?,?,?)", (now, seen % 99, "light", "", "", "other"))
        c.commit(); c.close()
        assert co_react.novel_source("https://arxiv.org/abs/2509.1", db) is True    # a new source
        assert co_react.novel_source("https://www.youtube.com/watch?v=x", db) is False  # www too
        assert co_react.novel_source("just thinking out loud", db) is False   # no link, no source
        assert co_react.novel_source("", db) is False


def test_the_thumbs_up_never_claims_a_read_that_failed():
    # the 9/5 eyes checked is_a_real_read before claiming co opened the thing. Moving the mark off
    # the receipt path left a hole exactly there: a LINK that failed to open reaches the same
    # silent branch and, unlike media, has no ❓ from the read loop. "cool, saw it" on a page co
    # never opened is the receipt-gate law broken in the channel that has no words to soften it.
    src = (ROUTER / "sendblue_router.py").read_text()
    got = src.split("def mark_received")[1].split("\n    # ACK IMMEDIATELY")[0]
    assert "link_read.is_a_real_read(enrichment)" in got
    assert "sendblue_react(message_handle, kind)" in got


def test_one_thread_owns_every_mark_on_a_message():
    # the ack, the ❓ for an unreadable attachment and the 👀 for a good read were three unordered
    # daemon threads against one handle. That only looked safe while a deposit earned no ack: at
    # HEAD the ack returned early and POSTed nothing, so the ❓ raced nothing. Giving the deposit a
    # 👍 woke the race — 6-22s for the ack vs p50 ~10s for the read — so it is one thread now.
    src = (ROUTER / "sendblue_router.py").read_text()
    assert src.count("threading.Thread(target=lambda: sendblue_react(") == 0
    ack = src.split("def send_ack")[1].split("\n    # ACK IMMEDIATELY")[0]
    assert "read_known.wait(" in ack                     # the ack POST comes first, always
    assert "return                      # a mark that never landed has nothing to upgrade" in ack
    assert "final_mark[0]" in ack


def test_silence_never_downgrades_a_mark_that_already_stands():
    # [SILENCE] posts its own 👍 as a receipt (7/31). It runs AFTER the read, so on a deposit that
    # earned 👀 it would put the weaker claim back — and the receipt it wants is already there.
    src = (ROUTER / "sendblue_router.py").read_text()
    sil = src.split("silence with a receipt")[1][:600]
    assert "not marked.is_set()" in sil


def test_the_eyes_need_a_read_not_a_string():
    # link_read flags a failed open with a full sentence, and a long video with a placeholder for
    # a watch that has not happened. Both are non-empty, so truthiness would mark them read.
    import link_read
    assert link_read.is_a_real_read("[shared: a dense page on scaling laws]") is True
    for flag in ("[shared: a page that couldn't be opened — say so plainly]",
                 "[shared: a youtube video that couldn't be watched right now]",
                 "[shared: a 41-MINUTE video (x) — too long to watch mid-reply]",
                 "", "   "):
        assert link_read.is_a_real_read(flag) is False, flag
    # a mixed batch claims nothing: one good read plus one flag is still not "co read this"
    assert link_read.is_a_real_read("[shared: a real read] [shared: a tweet that couldn't be "
                                    "opened]") is False
    src = (ROUTER / "sendblue_router.py").read_text()
    got = src.split("def mark_received")[1].split("\n    # ACK IMMEDIATELY")[0]
    assert "link_read.is_a_real_read(enrichment)" in got


def test_every_unread_flag_link_read_emits_is_covered():
    # the flags are prose written for the model, so a new failure branch is one string literal away
    # from silently reading as a successful read. This is the pin.
    import link_read
    src = (Path(link_read.__file__)).read_text()
    body = src.split("def read_links")[1].split("\ndef ")[0]
    for line in body.splitlines():
        if "[shared: a" in line and "couldn" in line.lower():
            assert any(f in line for f in link_read.UNREAD_FLAGS), line.strip()
    # THE ONE THIS FILTER MISSED (9/8). The video-link failure is written f"[shared: {deep or ...}"
    # so it never matched "[shared: a", and it carried a CURLY apostrophe while UNREAD_FLAGS holds
    # a straight one — so every failed tiktok/vimeo/twitch read counted as a successful read, and
    # the router marks a successful read 👍 "cool, saw it".
    assert any(f in link_read.LINK_UNREADABLE for f in link_read.UNREAD_FLAGS)
    assert link_read.is_a_real_read(f"[shared: {link_read.LINK_UNREADABLE}]") is False
    # scoped to the EMITTING lines: the naive `body` slice runs past read_links and swallows
    # LINK_UNREADABLE's own definition, so it read as covered even when nothing used it.
    emits = [l for l in body.splitlines() if "reads.append" in l]
    assert any("LINK_UNREADABLE" in l for l in emits), "the video failure must use the named literal"
    for line in body.splitlines():
        if "couldn" in line.lower() and "[shared:" in line:
            assert any(f in line for f in link_read.UNREAD_FLAGS) or "LINK_UNREADABLE" in line, line.strip()
    # and the deferred placeholder, which lives in another module entirely
    import deferred_watch
    assert link_read.is_a_real_read(deferred_watch.placeholder("a talk", 41)) is False
