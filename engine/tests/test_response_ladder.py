"""The response ladder is law (8/22, founder-usage-analysis): deposits get an ack or silence,
never prose; only a question earns the take; the unprompted-insight register is retired for
every tenant, founder included. 21 days of the founder's own thread: 147 of co's 150 messages
answered no question, weekly sends collapsed 68→2. These are source laws in the style of
EverySendPathWearsTheBelt — they fail when a retired lane is quietly rewired."""
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROUTER = (REPO / "frame" / "homebase" / "router" / "sendblue_router.py").read_text()
TICK = (REPO / "frame" / "claims" / "proactive_tick.py").read_text()


def test_share_take_has_no_founder_exception():
    # The 7/15 share-floor tenant split is retired: no tenant gets prose for a bare link.
    assert "share_words" not in ROUTER
    assert 'tenant == FOUNDER_TENANT) or ("[voice note' not in ROUTER


def test_questions_still_earn_the_take():
    # The ladder removes takes from deposits, never answers from questions.
    # 9/8: measured on words_only(text), because a "?" in ?si= or ?utm_source= is a URL, not a
    # question, and reading it as one sent co to the engine to speak on a plain share.
    assert '"?" in words_only(text)' in ROUTER


def test_voice_rungs_stay_retired():
    # muse / second opinion / reflection / absence must not send from the tick again.
    for rung in ('mark_callback("muse"', 'mark_callback("second_opinion"',
                 'mark_callback("reflect"', 'mark_callback("absence"'):
        assert rung not in TICK, f"retired voice rung rewired: {rung}"


def test_work_rungs_survive():
    # The purge is register-shaped, not proactivity-shaped: receipts still deliver.
    for rung in ('mark_callback("anchor', 'mark_callback("return"'):
        assert rung in TICK, f"work rung lost in the purge: {rung}"
