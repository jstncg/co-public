"""OPENINGS — the gate between a find and a thing worth doing (8/27).

Co could always find things that were interesting. An opening is ACTIONABLE, which is a much
smaller set, and the difference is enforced here rather than hoped for in a prompt:

    world × member × window × action, plus a pre-registered undo,
    and never spending someone else's expectations without a mandate.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import openings  # noqa: E402


def _o(**kw):
    base = {"world": "she asked a question", "member": "addressed to them",
            "window": "nine days stale", "action": "draft the reply",
            "undo": "the draft is not sent until they tap send", "confidence": 0.7}
    base.update(kw)
    return base


def test_all_four_parts_are_required():
    for missing in openings.PARTS:
        ok, why = openings.gate(_o(**{missing: ""}))
        assert not ok and missing in why


def test_no_window_means_it_is_a_find_not_an_opening():
    ok, why = openings.gate(_o(window=""))
    assert not ok and "find, not an opening" in why


def test_nothing_ships_without_a_pre_registered_undo():
    # the reversibility analysis has to happen before the act, not during the regret
    ok, why = openings.gate(_o(undo=""))
    assert not ok and "undo" in why


def test_co_may_not_spend_other_peoples_expectations_unmandated():
    ok, why = openings.gate(_o(spends_expectations=True))
    assert not ok and "expectations" in why
    ok2, _ = openings.gate(_o(spends_expectations=True, mandated=True))
    assert ok2


def test_a_clean_opening_passes():
    ok, why = openings.gate(_o())
    assert ok and why is None


def test_ranking_discounts_by_confidence_not_just_value():
    # ranking on raw value is how a lane fills with confident nonsense
    assert openings.expected(_o(confidence=0.9)) > openings.expected(_o(confidence=0.3))


def test_a_low_confidence_opening_is_not_worth_the_interruption():
    import landed
    assert openings.expected(_o(confidence=0.2)) < 0
    assert landed.COST["proactive"] > 0          # the cost term is what makes that true


def test_refusals_are_recorded_rather_than_dropped(monkeypatch):
    # a lane that silently discards most of what it finds cannot be debugged
    monkeypatch.setattr(openings, "DETECTORS", (lambda t: [_o(undo="")],))
    assert openings.find("t") == []
    src = (CLAIMS / "openings.py").read_text()
    assert 'o["refused"]' in src


def test_the_report_line_is_the_act_and_nothing_else():
    # naming the retrieval is the database bragging; justifying the choice makes it about co
    assert openings.line(_o(action="Draft the reply to her")) == "draft the reply to her"


def _sys():
    return " ".join(openings.FIND_SYS.split())      # the laws wrap lines; the laws do not


def test_money_is_explicitly_another_lanes_job():
    assert "belong to another lane" in _sys()
    assert "undo" in _sys().lower()


def test_the_prompt_refuses_read_it_as_an_action():
    assert 'action is "read it"' in _sys()
    assert "Zero is the common and correct answer" in _sys()


def test_co_never_reads_the_members_mail_as_a_strangers(monkeypatch):
    # first live run: "draft a message to <member> reintroducing yourself" — the model had read
    # his inbox as somebody else's. Same identity failure the meeting read hit on 8/25.
    assert "second person" in _sys()
    assert "never about them in the third person" in _sys()
    monkeypatch.setenv("CO_MEMBER_NAMES_T9", "sam,samir")
    assert openings.member_names("t9") >= {"sam", "samir"}


# ── more ways to be useful (8/27) ─────────────────────────────────────────────────────────────

def test_drift_reaches_what_text_mining_cannot():
    # "be a better brother" appears nowhere in the corpus: the wants felt most are never said.
    # Frequency-then-silence is behavioural, so it reaches the blind spot words cannot.
    body = (CLAIMS / "openings.py").read_text().split("def _drift")[1].split("\ndef ")[0]
    assert "in:sent" in body
    assert 'r.get("to")' in body       # FROM is the member on sent mail; TO is the counterpart
    assert "cadence * 3" in body       # silence only counts against their own rhythm


def test_a_relationship_with_no_rhythm_cannot_have_broken_one():
    assert openings.DRIFT_MIN_SENT >= 3
    assert openings.DRIFT_QUIET_DAYS >= 60


def test_the_member_is_never_their_own_correspondent():
    body = (CLAIMS / "openings.py").read_text().split("def _drift")[1].split("\ndef ")[0]
    assert "member_names(tenant)" in body and "noreply" in body


def test_drift_asks_for_a_reason_not_an_apology():
    # "you haven't called in six weeks" is a guilt delivery; it adds debt to the thing
    body = (CLAIMS / "openings.py").read_text().split("def _drift")[1].split("\ndef ")[0]
    assert "not an apology" in body


def test_promises_look_far_enough_back_to_find_the_rotten_ones():
    # 120 days returned nothing live: the promises that rot are old
    body = (CLAIMS / "openings.py").read_text().split("def _promises")[1].split("\ndef ")[0]
    assert "newer_than:365d" in body and "older_than:10d" in body


def test_a_promise_is_only_an_opening_if_it_is_concrete_and_late():
    sys_ = " ".join(openings.PROMISE_SYS.split())
    assert "CONCRETE" in sys_ and "OLD enough to be late" in sys_
    assert "second person" in sys_


def test_the_gmail_search_carries_the_recipient():
    # without TO, every in:sent query identifies the member as their own counterpart
    g = (CLAIMS / "gmail_guard.py").read_text()
    assert "metadataHeaders=To" in g and '"to": h.get("To"' in g


def test_every_detector_is_registered():
    assert len(openings.DETECTORS) >= 4
    names = {d.__name__ for d in openings.DETECTORS}
    assert {"_mail_openings", "_promises", "_drift", "_situation_openings"} <= names


# ── what co is assuming, and when (8/27) ──────────────────────────────────────────────────────

def test_every_detector_declares_what_it_takes_on_faith():
    # almost all of these infer from ABSENCE: no reply, no mail, no follow-up. Absence is the
    # weakest evidence there is, and saying so separates a read from a confident guess.
    for kind in ("unanswered", "intro", "promised", "drift", "situation:dinner"):
        assert openings.assumptions({"kind": kind}), kind


def test_an_unchecked_assumption_costs_confidence():
    o = {"kind": "promised", "confidence": 0.8}
    assert openings.discount(o) < 0.8
    o2 = {"kind": "promised", "confidence": 0.8, "checked": {"they never sent it later": True}}
    assert openings.discount(o2) == 0.8


def test_laziness_costs_more_than_a_permanent_limit():
    assert openings.UNVERIFIED_DISCOUNT > openings.UNCHECKABLE_DISCOUNT


def test_co_says_one_assumption_not_a_list():
    # a caveat per line is a lawyer, not a counterpart
    u = openings.unverified({"kind": "drift"})
    assert u and "\n" not in u
    assert openings.unverified({"kind": "nothing"}) == ""


def test_the_one_assumption_co_can_afford_to_check_is_checked():
    # telling somebody they owe a thing they already sent is the most embarrassing act available
    body = (CLAIMS / "openings.py").read_text().split("def _check_followup")[1].split("\ndef ")[0]
    assert "in:sent to:" in body
    assert 'o.setdefault("checked", {})' in body


def test_a_found_follow_up_collapses_the_claim(monkeypatch):
    import gmail_guard
    monkeypatch.setattr(gmail_guard, "search",
                        lambda q, limit=8, tenant=None: [{"subject": "re: the thing"}])
    o = {"who": "someone@example.com", "confidence": 0.9}
    openings._check_followup(o)
    assert o["confidence"] <= 0.25 and "already be done" in o["note"]


def test_the_promise_detector_learns_the_recipient_not_the_sender():
    # FROM is the member on sent mail; without TO the follow-up check can never run
    body = (CLAIMS / "openings.py").read_text().split("def _promises")[1].split("\ndef ")[0]
    assert "r.get('to','')" in body
    assert "EMAIL ADDRESS" in " ".join(openings.PROMISE_SYS.split())


def test_one_episode_cannot_take_the_whole_slate(monkeypatch):
    # a single trip generates five confident needs and buried a 234-day-old promise
    many = [dict(kind=f"situation:{i}", world="w", member="m", window="x", action=f"a{i}",
                 undo="u", confidence=0.9) for i in range(5)]
    many.append(dict(kind="promised", world="w", member="m", window="x", action="the promise",
                     undo="u", confidence=0.5))
    monkeypatch.setattr(openings, "DETECTORS", (lambda t: many,))
    got = openings.find("t")
    assert sum(1 for o in got if o["kind"].startswith("situation")) <= openings.MAX_PER_FAMILY
    assert any(o["kind"] == "promised" for o in got)
