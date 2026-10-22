"""The target self and the conversion loop (8/25).

Two laws carry the whole design. BECOMING: a trait that co cannot score is a horoscope, so
every trait binds to a metric computed from evidence already held — and the target self is
mined from who they admire in their own words, never asked. CONVERSION: growth gets ZERO new
message budget; it rides the evening slot a commitment isn't using, and the wall."""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import becoming  # noqa: E402
import conversion  # noqa: E402


def test_only_scoreable_traits_ship(tmp_path, monkeypatch):
    # every metric a trait may bind to must be one co actually computes
    src = (CLAIMS / "becoming.py").read_text()
    body = src.split("def metrics")[1].split("def ")[0]
    for key in becoming.METRICS:
        assert f'"{key}"' in body, f"{key} is offered to the composer but never computed"


def test_units_are_declared_so_a_ratio_cannot_be_sixty():
    for key, desc in becoming.METRICS.items():
        assert desc.startswith(("COUNT", "RATIO")), f"{key} has no declared unit"
    assert "RATIO takes a number" in becoming.TRAITS_SYS   # and the composer is told


def test_admiration_is_mined_from_the_whole_record_not_a_recent_slice():
    # the first build returned zero admired people because admiration is rare and old
    assert becoming.ADMIRE_RE.search("i want to be more like naval ravikant")
    assert becoming.ADMIRE_RE.search("the standards that Naval would be impressed by")
    assert not becoming.ADMIRE_RE.search("shipped the router change today")


def test_the_contradiction_never_prints_a_raw_metric():
    assert "never print a raw number" in becoming.CONTRA_SYS.lower()
    assert 'as "you"' in becoming.CONTRA_SYS


def test_the_gap_is_the_aiming_function(tmp_path, monkeypatch):
    monkeypatch.setattr(becoming, "_path", lambda t: str(tmp_path / f"{t}.json"))
    becoming._save("t", {"distances": [
        {"trait": "closed", "metric": "done_per_week", "target": 1, "actual": 1, "gap": 0.0},
        {"trait": "open", "metric": "primary_ratio", "target": 0.7, "actual": 0.1, "gap": 0.86}]})
    g = becoming.gap("t")
    assert g and g["trait"] == "open"        # the largest closable distance, not the first


def test_the_contradiction_survives_a_brief_that_never_sends(tmp_path, monkeypatch):
    monkeypatch.setattr(becoming, "_path", lambda t: str(tmp_path / f"{t}.json"))
    becoming._save("t", {"contradiction": {"is_contradiction": True, "line": "you say x, you do y",
                                           "computed": "2026-08-25", "delivered": False}})
    assert becoming.fresh_contradiction("t")
    assert becoming.fresh_contradiction("t")     # still pending after an abandoned compose
    becoming.commit("t")
    assert becoming.fresh_contradiction("t") is None


def test_conversion_takes_no_new_message_budget():
    tick = (CLAIMS / "proactive_tick.py").read_text()
    # it must sit AFTER the outcomes rung: a commitment to close outranks a thing to recall
    assert tick.index("import outcomes") < tick.index("import conversion")
    assert "conversion.mark_used" in tick          # and spends only after the send lands
    assert "budget_spent" in tick.split("import conversion")[1][:400]


def test_recall_window_is_a_real_memory_test():
    assert conversion.RECALL_MIN_DAYS >= 10       # younger is recognition, not retrieval
    assert conversion.RECALL_MAX_DAYS <= 60       # older is archaeology
    assert conversion.MIN_SPAN_DAYS >= 14         # a connection must cross real time
