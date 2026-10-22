"""The audit: value in the first five minutes (8/27).

Time to first value was measured in weeks because co's model had to accrete from what the member
sent it. The audit closes that by QUERYING the archive instead of ingesting it — Gmail's index is
already built, so ~20 aimed probes return tens of results each, metadata-only. Live run: 254
messages, 74 items, 35 seconds, on an inbox co had never read past two days of.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import gmail_audit as A  # noqa: E402


def test_probes_are_narrow_enough_to_need_no_model_of_the_member():
    # a broad query returns a corpus, and a corpus needs a model to interpret — the exact thing
    # a cold-start member does not have yet
    for name, q in A.PROBES:
        assert "newer_than" in q, f"{name} is unbounded in time"
        assert len(q) > 30, f"{name} is too broad to be self-interpreting"


def test_loss_leads_the_ordering():
    # loss aversion beats gain: money out before promises before deadlines
    assert A.ORDER[0] == "recurring"
    assert A.ORDER.index("recurring") < A.ORDER.index("promised")
    assert A.ORDER.index("promised") < A.ORDER.index("expiring")


def test_every_ordered_class_has_a_heading_and_a_probe():
    names = {n for n, _ in A.PROBES}
    for k in A.ORDER:
        assert k in A.HEADS, f"{k} renders without a heading"
        assert k in names, f"{k} is ordered but never probed"


def test_amounts_are_never_invented():
    assert "Never invent an amount" in A.CLASS_SYS
    assert "leave amount empty" in A.CLASS_SYS


def test_duplicates_collapse_hard():
    # twelve monthly receipts from one service is one subscription, not twelve findings
    assert "Merge duplicates hard" in A.CLASS_SYS


def test_it_reads_metadata_not_bodies():
    src = (CLAIMS / "gmail_audit.py").read_text()
    body = src.split("def _meta")[1].split("\ndef ")[0]
    assert "format=metadata" in body


def test_render_is_honest_when_it_finds_nothing():
    out = A.render({"items": []})
    assert "nothing found" in out and "probes missed" in out


# ── stage two: the number ────────────────────────────────────────────────────────────────────

def test_an_amount_must_appear_verbatim_in_the_receipt(monkeypatch):
    # a wrong total is confidently actionable, which makes it worse than no total. The model
    # picks which real amount is the charge; it may never produce one.
    import llm
    monkeypatch.setattr(A, "_search", lambda tok, q, limit=3: ["m1"])
    monkeypatch.setattr(A, "_meta", lambda tok, m: {"subject": "your receipt"})
    monkeypatch.setattr(A, "_body", lambda tok, m: "you paid $45.00 this month")
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {
        "found": True, "amount": "$99.00", "cadence": "monthly"})       # not in the body
    assert A._price_one("tok", "Mobbin") is None
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {
        "found": True, "amount": "$45.00", "cadence": "monthly"})       # in the body
    assert A._price_one("tok", "Mobbin")["amount"] == "$45.00"


def test_an_unknown_cadence_is_refused(monkeypatch):
    import llm
    monkeypatch.setattr(A, "_search", lambda tok, q, limit=3: ["m1"])
    monkeypatch.setattr(A, "_meta", lambda tok, m: {"subject": "s"})
    monkeypatch.setattr(A, "_body", lambda tok, m: "$45.00")
    monkeypatch.setattr(llm, "ask_json", lambda *a, **k: {
        "found": True, "amount": "$45.00", "cadence": "whenever"})
    assert A._price_one("tok", "x") is None


def test_a_one_off_purchase_annualises_to_zero():
    assert A.PER_YEAR["once"] == 0
    assert A.PER_YEAR["monthly"] == 12 and A.PER_YEAR["annual"] == 1


def test_only_confirmed_money_classes_get_an_expensive_body_fetch():
    # stage one is metadata-only on purpose; bodies are paid for ~30 items, not the 254 scanned
    assert set(A.MONEY_CLASSES) <= set(A.ORDER)
    assert "intros" not in A.MONEY_CLASSES and "expiring" not in A.MONEY_CLASSES
