"""co's accusations need receipts, exactly as co's promises do.

9/2: co shipped "still waiting on that typography redo from four days ago", then escalated to
"typography redo's been sitting since saturday, this is the third design link since then and still
zero screens touched". No such commitment existed anywhere — no anchor, no promise, no claim. When
asked "what typography bro" it answered "fair, don't have that one. made it up, dropping it".

Hard law 2 already required this and nothing enforced it: the send-time gate covered a reminder co
claimed to set, a watch co claimed to run, a note co claimed to write — every one a claim about
CO. A claim about THEIR past shipped unchecked. These pin the other half.
"""
import json
import sys
from pathlib import Path

import pytest

CLAIMS = Path(__file__).resolve().parents[2] / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import receipts  # noqa: E402

REAL = "buy Tuesday's Benson Boone concert tickets"


@pytest.fixture
def db(tmp_path):
    p = tmp_path / "claims.db"
    p.write_text("")
    (tmp_path / "claims.db.anchors.json").write_text(json.dumps(
        {"anchors": [{"what": REAL, "quote": "can you grab the benson boone tickets tuesday",
                      "requested": True}]}))
    return str(p)


def test_the_fabrication_that_shipped_is_held(db):
    """Both sends, verbatim. The duration was spelled out — "four days ago", not "4 days ago" —
    which a digits-only pattern waved straight through on the first pass at this."""
    ok, why = receipts.gate("still waiting on that typography redo from four days ago", db)
    assert ok is False and "still waiting on" in why
    ok2, why2 = receipts.gate(
        "typography redo's been sitting since saturday, this is the third design link since then", db)
    assert ok2 is False and "been sitting since" in why2


def test_an_obligation_they_really_stated_still_ships(db):
    ok, why = receipts.gate(
        "still waiting on those benson boone tickets from four days ago", db)
    assert ok is True, why


def test_an_obligation_with_no_date_is_conversation_not_an_accusation(db):
    """"you said you'd" alone is how people talk. It is the pinned date that makes it a receipt."""
    ok, _ = receipts.gate("you said you'd think about the typography thing", db)
    assert ok is True


def test_a_date_with_no_obligation_is_a_fact_about_the_world(db):
    ok, _ = receipts.gate("blackstone capped redemptions two weeks ago", db)
    assert ok is True


def test_the_other_shape_it_used_the_next_morning(db):
    ok, _ = receipts.gate("you never shipped the screens from last week", db)
    assert ok is False


def test_a_broken_gate_fails_open(tmp_path):
    """A guard that crashes must not mute the product — the existing law, kept."""
    ok, _ = receipts.gate("still waiting on that thing from four days ago",
                          str(tmp_path / "nonexistent.db"))
    assert ok is True


def test_cos_own_promises_are_still_gated(db):
    ok, why = receipts.gate("added it to your notes app", db)
    assert ok is False and "no-capability" in why
