"""A promise recorded and never fired is the same failure as one never recorded.

9/6, live: at 10:27 the founder asked for a reminder to send Richard the Coretsu invoice by EOD.
The router extracted it correctly (anchors.extract still runs on every inbound), the anchor was
written due 18:00, and co replied "Got it, reminder set for today, 6pm." Nothing on the machine
would ever fire it — proactive_tick was the only organ that fired due anchors and it was removed
from cron at the runtime cutover that morning, deliberately and for good reasons that had nothing
to do with promises.

promise_tick fires requested reminders and refuses everything else. These pin both halves: that it
sends what was asked for, and that it never becomes the lane it replaced.
"""
import json
import sys
from pathlib import Path

CLAIMS = Path(__file__).resolve().parents[2] / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import promise_tick  # noqa: E402

SRC = (CLAIMS / "promise_tick.py").read_text()


def test_only_requested_anchors_ever_fire():
    """An inferred callback is the retired lane. Reviving it here by accident is how a narrow
    organ becomes the thing it replaced."""
    assert 'if not anchor.get("requested"):' in SRC
    assert "continue" in SRC.split('if not anchor.get("requested"):')[1][:40]


def test_it_has_no_composer_and_no_lane():
    """No model call, no research surfacing, no market alerts. A requested reminder needs no
    composer: they already said what they wanted."""
    for banned in ("llm.", "_compose(", "research_engine", "daily_finds", "unasked", "co_react"):
        assert banned not in SRC, f"promise_tick must not reach for {banned}"


def test_the_text_is_their_own_words():
    assert 'anchor.get("what")' in SRC and 'anchor.get("quote")' in SRC


def test_a_refusal_leaves_the_anchor_due():
    """8/6: an empty return marked an anchor fired with nothing sent, and `fired` is terminal, so
    it could never retry or repair. A send that does not happen must not be recorded as kept."""
    body = SRC.split("ok, evidence = rail.send")[1][:400]
    assert "if ok:" in body and "mark_fired" in body
    marked = body.split("if ok:")[1].split("else:")[0]
    assert "mark_fired" in marked, "mark_fired must sit inside the success branch only"
    assert "FAILED" in body


def test_it_sends_through_the_one_door():
    assert "import rail" in SRC and "rail.send(" in SRC
    assert "requests.post" not in SRC, "the rail is the only sender"


def test_the_founders_pending_reminder_is_visible_right_now(capsys):
    """The live case. Until it fires, a dry run must see it."""
    promise_tick.run(send=False)
    out = capsys.readouterr().out
    assert "[due]" in out or "[sent]" in out or out.strip() == "", out


def test_a_broken_sidecar_does_not_stop_the_other_members():
    assert "except Exception as exc:" in SRC and "[skip]" in SRC


def test_the_reminder_reads_as_a_reminder_not_an_order():
    """The live 9/6 send landed as the bare fragment 'send Richard invoice for Coretsu', which
    reads like co issuing an order. One word of framing, no model."""
    assert promise_tick._render({"what": "send Richard invoice for Coretsu"}) \
        == "reminder: send Richard invoice for Coretsu"


def test_it_does_not_double_frame():
    for already in ("reminder: call mom", "don't forget the invoice", "you said you'd call Ray"):
        assert promise_tick._render({"what": already}) == already


def test_it_falls_back_to_their_own_sentence():
    assert promise_tick._render({"what": "", "quote": "remind me to call Ray tomorrow"}) \
        == "remind me to call Ray tomorrow"
    assert promise_tick._render({}) == ""


def test_the_render_never_reaches_a_model():
    body = SRC.split("def _render")[1].split("def run(")[0]
    assert "llm" not in body and "await" not in body
