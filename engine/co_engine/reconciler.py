#!/usr/bin/env python3
"""The reconciler — one spine for everything scheduled (kyo schedule.py's law, frame's runner).

The scheduler is a reconciler, not a pile of timers: durable DESIRED STATE (a json file of
entries) + a durable FIRED-OCCURRENCE ledger + pure math that computes what's due right
now. One cron line runs `reconciler --run` every few minutes; it fires whatever is due and
unfired. Killing a hardcoded cron line stops a job forever with no record; a reconciler
entry is declarative, diffable, and its history is a ledger you can read.

Desired state (frame/reconciler.json):
  {"entries": [{"id": "weave", "kind": "recurring", "time": "04:15", "days": "daily",
                "tz": "America/Los_Angeles", "cmd": "<shell>", "timeout_s": 3600,
                "status": "active"},
               {"id": "one-off", "kind": "once", "at": "2026-08-01T09:00", ...}]}

Ledger (~/.co/reconciler_ledger.jsonl): one line per fired occurrence —
  {"key": "weave@2026-07-30T04:15:00-07:00", "started": ..., "rc": 0, "secs": 41}
The occurrence key is the tz-aware scheduled time, so a rerun after a crash is a no-op and
a missed night shows as a hole in the ledger, not a silent nothing.

Pure core (`due_entries`) has no clock and no I/O — the tests own time entirely.

    python3 reconciler.py             # dry: what is due right now
    python3 reconciler.py --run       # fire what's due (flock-guarded)
    python3 reconciler.py --status    # last outcome per entry
"""
from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

LEDGER = os.path.expanduser("~/.co/reconciler_ledger.jsonl")
LOOKBACK_HOURS = 12          # an occurrence older than this is missed, not due (no 3am pileup at noon)
_DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


# ── pure math ───────────────────────────────────────────────────────────────────────────


def occurrence(entry: dict, now: dt.datetime) -> str | None:
    """The latest scheduled occurrence at or before `now` (within the lookback), as a
    tz-aware ISO key — or None. Pure; `now` must be tz-aware."""
    tz = ZoneInfo(entry.get("tz") or "America/Los_Angeles")
    local = now.astimezone(tz)
    if entry.get("kind") == "once":
        at = dt.datetime.fromisoformat(entry["at"])
        if at.tzinfo is None:
            at = at.replace(tzinfo=tz)
        if at <= now and (now - at) <= dt.timedelta(hours=LOOKBACK_HOURS):
            return at.isoformat()
        return None
    hh, mm = (int(x) for x in (entry.get("time") or "04:00").split(":"))
    days = (entry.get("days") or "daily").lower()
    for back in (0, 1):                                   # today's slot, else yesterday's
        day = (local - dt.timedelta(days=back)).date()
        if days != "daily" and _DAYS.get(day.strftime("%a").lower()[:3], -1) not in {
                _DAYS[d.strip()[:3]] for d in days.split(",") if d.strip()[:3] in _DAYS}:
            continue
        sched = dt.datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz)
        if sched <= local and (local - sched) <= dt.timedelta(hours=LOOKBACK_HOURS):
            return sched.isoformat()
    return None


def due_entries(entries: list, now: dt.datetime, fired_keys: set) -> list:
    """(entry, occurrence_key) pairs due right now and not in the ledger. Pure."""
    out = []
    for e in entries:
        if (e.get("status") or "active") != "active":
            continue
        occ = occurrence(e, now)
        if occ and f"{e['id']}@{occ}" not in fired_keys:
            out.append((e, f"{e['id']}@{occ}"))
    return out


# ── durable state ───────────────────────────────────────────────────────────────────────


def load_entries(path: str) -> list:
    try:
        return (json.loads(open(path).read()) or {}).get("entries") or []
    except (OSError, json.JSONDecodeError):
        return []


def fired_keys(ledger_path: str = LEDGER) -> set:
    try:
        with open(ledger_path) as f:
            return {json.loads(l)["key"] for l in f if l.strip()}
    except (OSError, json.JSONDecodeError, KeyError):
        return set()


def _append_ledger(rec: dict, ledger_path: str = LEDGER) -> None:
    os.makedirs(os.path.dirname(ledger_path), exist_ok=True)
    with open(ledger_path, "a") as f:
        f.write(json.dumps(rec) + "\n")


# ── the runner ──────────────────────────────────────────────────────────────────────────


def run(config_path: str, now: dt.datetime | None = None, execute: bool = True) -> list:
    """Fire everything due. The ledger line is written BEFORE the command runs (rc updated
    after) so a crash mid-job can't double-fire; the hole is visible instead."""
    now = now or dt.datetime.now(dt.timezone.utc)
    results = []
    for entry, key in due_entries(load_entries(config_path), now, fired_keys()):
        if not execute:
            results.append({"key": key, "rc": None, "dry": True})
            continue
        started = time.time()
        _append_ledger({"key": key, "started": dt.datetime.now().isoformat(timespec="seconds"),
                        "rc": None})
        try:
            p = subprocess.run(entry["cmd"], shell=True, capture_output=True, text=True,
                               timeout=int(entry.get("timeout_s") or 3600))
            rc = p.returncode
        except subprocess.TimeoutExpired:
            rc = -9
        except Exception:
            rc = -1
        _append_ledger({"key": key, "started": None, "rc": rc,
                        "secs": int(time.time() - started)})
        results.append({"key": key, "rc": rc, "secs": int(time.time() - started)})
    return results


def status(config_path: str) -> str:
    lines = []
    keys: dict = {}
    try:
        with open(LEDGER) as f:
            for l in f:
                r = json.loads(l)
                eid = r["key"].split("@", 1)[0]
                if r.get("rc") is not None:
                    keys[eid] = r
    except (OSError, json.JSONDecodeError):
        pass
    for e in load_entries(config_path):
        last = keys.get(e["id"])
        lines.append(f"  {e['id']:<14} {(e.get('time') or e.get('at','?')):<8} "
                     f"{'rc=' + str(last['rc']) + ' (' + str(last.get('secs','?')) + 's)' if last else 'never fired'}")
    return "\n".join(lines) or "  (no entries)"


if __name__ == "__main__":
    cfg = os.environ.get("RECONCILER_CONFIG") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "frame", "reconciler.json")
    cfg = os.path.abspath(cfg)
    if "--status" in sys.argv:
        print(status(cfg))
        sys.exit(0)
    execute = "--run" in sys.argv
    if execute:                                   # one runner at a time (same law as the tick)
        lk = open(os.path.expanduser("~/.co/reconciler.lock"), "w")
        try:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            sys.exit(0)
    for r in run(cfg, execute=execute):
        print(f"  {'[dry] ' if r.get('dry') else ''}{r['key']} rc={r.get('rc')}")
