"""Offline tests for the reconciler's pure core — the tests own time entirely."""
import datetime as dt
import os
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from co_engine import reconciler as R

LA = ZoneInfo("America/Los_Angeles")
WEAVE = {"id": "weave", "kind": "recurring", "time": "04:15", "days": "daily",
         "tz": "America/Los_Angeles", "cmd": "true"}


def test_due_after_slot_not_before():
    before = dt.datetime(2026, 7, 30, 4, 0, tzinfo=LA)
    after = dt.datetime(2026, 7, 30, 4, 30, tzinfo=LA)
    assert R.due_entries([WEAVE], before, set()) == []
    due = R.due_entries([WEAVE], after, set())
    assert len(due) == 1 and due[0][1] == "weave@2026-07-30T04:15:00-07:00"


def test_fired_key_makes_rerun_noop():
    now = dt.datetime(2026, 7, 30, 4, 30, tzinfo=LA)
    key = "weave@2026-07-30T04:15:00-07:00"
    assert R.due_entries([WEAVE], now, {key}) == []


def test_lookback_swallows_ancient_occurrences():
    much_later = dt.datetime(2026, 7, 30, 23, 30, tzinfo=LA)   # 19h after the 04:15 slot
    assert R.due_entries([WEAVE], much_later, set()) == []


def test_day_filter():
    fri_only = dict(WEAVE, id="rollup", days="fri", time="09:00")
    fri = dt.datetime(2026, 7, 31, 9, 30, tzinfo=LA)           # a Friday
    thu = dt.datetime(2026, 7, 30, 9, 30, tzinfo=LA)
    assert len(R.due_entries([fri_only], fri, set())) == 1
    assert R.due_entries([fri_only], thu, set()) == []


def test_once_fires_once():
    once = {"id": "probe", "kind": "once", "at": "2026-07-30T10:00", "tz": "America/Los_Angeles",
            "cmd": "true"}
    now = dt.datetime(2026, 7, 30, 10, 5, tzinfo=LA)
    due = R.due_entries([once], now, set())
    assert len(due) == 1
    assert R.due_entries([once], now, {due[0][1]}) == []


def test_paused_entry_never_fires():
    paused = dict(WEAVE, status="paused")
    now = dt.datetime(2026, 7, 30, 4, 30, tzinfo=LA)
    assert R.due_entries([paused], now, set()) == []
