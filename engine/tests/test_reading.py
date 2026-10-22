"""The reading's laws (8/22, trigger-detection spec §C): receipts are the member's own words
verified by containment, a thin corpus keeps the mirror dark, and diagnosis language never
ships. The LLM is not under test — the verification around it is."""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "frame" / "claims"))

import reading  # noqa: E402


def test_receipt_grounding_is_containment_not_vibes():
    blob = reading._norm("[2026-08-04] I want to be more like the greats, honestly")
    assert reading._grounded({"quote": "more like the greats"}, blob)
    assert not reading._grounded({"quote": "you admire great people"}, blob)   # paraphrase = fabrication
    assert not reading._grounded({"quote": "like"}, blob)                      # too short to mean anything
    assert not reading._grounded({"quote": "x" * 100}, blob)                   # too long to be a receipt


def test_diagnosis_language_is_screened():
    for bad in ("this is because you're avoiding it", "classic anxious attachment style",
                "that's your trauma talking", "you get triggered by deadlines"):
        assert reading._DIAGNOSIS_RE.search(bad), bad
    for fine in ("you keep circling the gym thing", "every time she comes up, you go quiet"):
        assert not reading._DIAGNOSIS_RE.search(fine), fine


def test_thin_corpus_floor_exists():
    assert reading.MIN_ITEMS >= 30


def test_digests_never_enter_the_corpus():
    assert reading._DIGEST_RE.match("(from our conversations) Dennis plans to …")
    assert not reading._DIGEST_RE.match("thinking about the studio again")


def test_dates_are_spoken_not_ranged():
    assert reading._day("2026-08-04") == "aug 4"
    assert reading._day("") == "?"


def test_the_router_has_the_trigger():
    router = (REPO / "frame" / "homebase" / "router" / "sendblue_router.py").read_text()
    assert "reading as _rd" in router
    assert "reading_dark" in router      # the honest dark-mirror line, never filler
