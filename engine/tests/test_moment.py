"""The meeting read — the first moment-attached lane (8/25).

Three laws carry it. ATTACHMENT: the read fires inside a lead window before a meeting that is
still ahead, never into a morning batch and never after the handshake. MOTIVATION RECEIPT: a
want-claim ships only with a fact copied verbatim out of the search results, because an
unsourced read is a horoscope delivered in co's voice. BURN ON DELIVERY: composing costs
nothing; only a landed send spends the meeting.
"""
import datetime as dt
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import moment  # noqa: E402


def _cal(tmp_path, monkeypatch, events):
    monkeypatch.setattr(moment, "_events", lambda t: events)
    monkeypatch.setattr(moment, "BURN", str(tmp_path / "burn.json"))
    monkeypatch.setattr(moment, "PENDING", str(tmp_path / "pending.json"))


def test_an_unsourced_want_never_ships():
    src = "- [2026-08-01] Kestrel AI raises seed (http://x): Kestrel AI closed a $4M seed round."
    assert moment._grounded("Kestrel AI closed a $4M seed round", src)
    assert not moment._grounded("he runs a private equity fund", src)   # the exact live failure


def test_a_paraphrase_is_not_a_receipt():
    src = "- [2026-08-01] Larkfield AI shipped its api (http://x): Larkfield AI launched an API today."
    assert not moment._grounded("Larkfield recently released an interface", src)


def test_basis_has_a_floor_and_a_ceiling():
    src = "x" * 400
    assert not moment._grounded("x" * (moment.MIN_BASIS - 1), src)   # a fragment proves nothing
    assert not moment._grounded("x" * (moment.MAX_BASIS + 1), src)   # a wall is not a citation


def test_the_read_fires_in_a_window_not_at_nine_am(tmp_path, monkeypatch):
    now = dt.datetime(2026, 8, 25, 13, 0)
    _cal(tmp_path, monkeypatch, [{"title": "lance", "start": "2026-08-25T14:00"}])
    assert moment.due("t", now)                                    # 60m out: due
    assert not moment.due("t", dt.datetime(2026, 8, 25, 9, 0))     # 5h out: not yet
    assert moment.LEAD_MIN <= 120                                  # a read must still be usable


def test_a_meeting_already_started_is_skipped_not_queued(tmp_path, monkeypatch):
    _cal(tmp_path, monkeypatch, [{"title": "lance", "start": "2026-08-25T14:00"}])
    assert not moment.due("t", dt.datetime(2026, 8, 25, 14, 1))
    assert not moment.due("t", dt.datetime(2026, 8, 25, 17, 0))


def test_yesterdays_meeting_is_not_todays_read(tmp_path, monkeypatch):
    _cal(tmp_path, monkeypatch, [{"title": "lance", "start": "2026-08-24T14:00"}])
    assert not moment.due("t", dt.datetime(2026, 8, 25, 13, 0))


def test_nothing_is_spent_until_the_send_lands(tmp_path, monkeypatch):
    now = dt.datetime(2026, 8, 25, 13, 0)
    _cal(tmp_path, monkeypatch, [{"title": "lance", "start": "2026-08-25T14:00"}])
    monkeypatch.setattr(moment, "compose",
                        lambda t, ev: {"key": ev["key"], "text": "…", "name": "lance"})
    assert moment.fresh("t", now)
    assert moment.due("t", now)          # composed and abandoned: the meeting is still readable
    assert moment.commit("t") == 1
    assert not moment.due("t", now)      # landed: burned, and never read twice


def test_staging_by_hand_cannot_eat_a_real_read(tmp_path, monkeypatch):
    # `python3 moment.py <tenant> --all` in a terminal must not burn the day's meeting; the
    # identical mistake cost a live pre-brief in join.py on 8/25.
    now = dt.datetime(2026, 8, 25, 13, 0)
    _cal(tmp_path, monkeypatch, [{"title": "lance", "start": "2026-08-25T14:00"}])
    monkeypatch.setattr(moment, "compose",
                        lambda t, ev: {"key": ev["key"], "text": "…", "name": "lance"})
    moment.fresh("t", now, ignore_window=True)
    assert moment.commit("t") == 0       # staging staged nothing
    assert moment.due("t", now)


def test_one_read_a_day_is_a_moment_lane_not_a_stream():
    assert moment.MAX_A_DAY == 1


def test_a_new_proactive_lane_is_opt_in_per_tenant(monkeypatch):
    monkeypatch.setenv("CO_MOMENT_TENANTS", "dennis")
    assert moment.rostered("dennis")
    assert not moment.rostered("isabel")
    monkeypatch.delenv("CO_MOMENT_TENANTS")
    assert not moment.rostered("dennis")          # off is the default for everyone


def test_the_brief_stops_pre_briefing_when_the_moment_lane_owns_it(monkeypatch):
    # both lanes live would say the same read twice, once 90 minutes early and once uselessly
    import join
    monkeypatch.setattr(join, "people_today", lambda t: [{"key": "p", "text": "lance at 2"}])
    monkeypatch.setattr(join, "entity_moves", lambda t: [])
    monkeypatch.setenv("CO_MOMENT_TENANTS", "dennis")
    assert join.fresh("dennis") == []
    monkeypatch.delenv("CO_MOMENT_TENANTS")
    assert join.fresh("dennis") == ["lance at 2"]


def test_the_tick_rung_respects_the_budget_and_the_roster():
    tick = (CLAIMS / "proactive_tick.py").read_text()
    rung = tick.split("import moment")[1][:900]
    assert "not budget_spent" in rung and "moment.rostered" in rung
    assert "moment.commit" in rung                       # spends only after the send lands
    # and it outranks the organic finds, because a read before a real meeting is worth more
    assert tick.index("import moment") < tick.index("THE DAILY FINDS")


def test_co_never_reads_the_web_about_its_own_member(monkeypatch):
    # the first live run pulled "Dennis" out of "[HOLD] Rafi <> Dennis" and searched for
    # strangers who share his name. The containment gate cannot catch this — the basis would be
    # verbatim from real results about a real person — so identity is enforced here, in code.
    import llm
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {"name": "Dennis"})
    assert moment._name("[HOLD] Rafi <> Dennis", "dennis") == ""
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {"name": "Dennis Lee"})
    assert moment._name("[HOLD] Rafi <> Dennis Lee", "dennis") == ""   # any part matching
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {"name": "Rafi"})
    assert moment._name("[HOLD] Rafi <> Dennis", "dennis") == "Rafi"


def test_the_invite_resolves_who_not_the_title():
    # "Rafi" matched six strangers and the read correctly refused. The attendee address pins
    # person and company at once, which is why the sync now keeps it.
    ev = {"title": "[HOLD] Rafi <> Dennis",
          "with": [{"email": "rafi@kestrel.example", "name": "Rafi Okoye"}]}
    s = moment.subject("dennis", ev)
    assert s["name"] == "Rafi Okoye" and s["org"] == "kestrel.example"


def test_a_personal_address_gives_a_name_but_never_a_fake_employer():
    ev = {"title": "coffee", "with": [{"email": "rafi.okoye@gmail.com", "name": ""}]}
    s = moment.subject("dennis", ev)
    assert s["name"] == "Rafi Okoye" and s["org"] == ""     # freemail is not an organisation


def test_the_member_is_skipped_even_when_the_invite_lists_them():
    ev = {"title": "1:1", "with": [{"email": "dennis@co.example", "name": "Dennis"},
                                   {"email": "sam@acme.example", "name": "Sam Rivera"}]}
    assert moment.subject("dennis", ev)["name"] == "Sam Rivera"


def test_no_org_means_the_read_must_prove_it_knows_which_person(monkeypatch):
    import join, llm
    monkeypatch.setattr(join, "_context_search",
                        lambda q: [{"title": "t", "url": "http://x.example", "date": "", "snippet": "s"}])
    seen = {}
    monkeypatch.setattr(llm, "ask_json",
                        lambda specs, sys_, user, **k: seen.update(user=user) or {"ok": False})
    moment.compose("dennis", {"title": "rafi", "when": "16:30", "key": "k",
                              "with": [{"email": "rafi@gmail.com", "name": "Rafi"}]})
    assert "NO ORGANISATION KNOWN" in seen["user"]


def test_member_identity_covers_handles_that_are_not_names(monkeypatch, tmp_path):
    # identity resolves from the PHONE KEY now, and must never inherit another tenant's account:
    # before scoping, resolve("t7") returned "dennis" off the box's only linked Gmail
    import identity
    monkeypatch.setattr(identity, "_path", lambda t: str(tmp_path / f"{t}.json"))
    monkeypatch.setattr(identity, "_accounts_for", lambda t: [])
    monkeypatch.setenv("CO_MEMBER_NAMES_T7", "isabel,izzy")
    assert moment.member_names("t7") == {"t7", "isabel", "izzy"}


def test_the_prompt_refuses_to_invent_a_seat():
    s = " ".join(moment.READ_SYS.lower().split())   # the laws wrap lines; the law does not
    assert "never from personality" in s
    assert "verbatim" in s
    assert "role the results do not show" in s      # the Lance-runs-a-fund class
    assert "position" in s and "recently moved" in s
