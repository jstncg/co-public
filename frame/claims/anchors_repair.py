#!/usr/bin/env python3
"""ANCHOR REPAIR — the two promise laws, applied to what production already wrote (2026-08-30).

Both invariants had been failing for weeks as advisory noise:

    promise: every scheduled instant carries a timezone     8 naive
    promise: a requested reminder is never marked kept unsent   1

A NAIVE INSTANT. `fire`/`when` were stored exactly as the model returned them, so a bare wall-clock
time inherited whichever machine read it back. due() patches tzinfo at read time, which is why
nothing broke loudly — and why a tester's reminder went off three hours early on 8/6. The write
path stamps the tenant's zone at birth now; this repairs the rows written before it did.

A PROMISE MARKED KEPT AND NEVER SENT. mark_fired(note="composer abstained") wrote fired=True with
nothing delivered. That is the worst state in the system: co believes it kept a promise it broke.
Repaired by clearing `fired`, so the anchor is honestly unkept rather than dishonestly kept.

    python3 anchors_repair.py            # dry run
    python3 anchors_repair.py --write
"""
from __future__ import annotations

import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
TZ_OK = re.compile(r"(Z|[+-]\d{2}:?\d{2})$")


def _zone(db: str):
    from zoneinfo import ZoneInfo
    try:
        import tz_dynamic
        name = tz_dynamic.get_tz(db)
        if name:
            return ZoneInfo(name), name
    except Exception:
        pass
    return ZoneInfo("America/Los_Angeles"), "America/Los_Angeles (default)"


def main(argv: list[str]) -> int:
    write = "--write" in argv
    naive = kept = 0
    for path in sorted(glob.glob(os.path.join(HERE, "claims*.db.anchors.json"))):
        db = path[:-len(".anchors.json")]
        try:
            doc = json.load(open(path))
        except (OSError, json.JSONDecodeError):
            continue
        anchors = doc.get("anchors") or []
        if not anchors:
            continue
        zone, zname = _zone(db)
        touched = False
        for a in anchors:
            import datetime as dt
            for field in ("fire", "when"):
                v = str(a.get(field) or "")
                if v and not TZ_OK.search(v):
                    try:
                        stamped = dt.datetime.fromisoformat(v).replace(tzinfo=zone).isoformat()
                    except ValueError:
                        continue
                    naive += 1
                    touched = True
                    if write:
                        a[field] = stamped
            if a.get("requested") and a.get("fired") and "abstain" in str(a.get("note") or "").lower():
                kept += 1
                touched = True
                print(f"  kept-unsent: {os.path.basename(db)[7:20]} {str(a.get('what'))[:44]!r}")
                if write:
                    a["fired"] = False
                    a["missed"] = True      # never sent, window closed: honest third state
                    a["note"] = f"{a.get('note','')} | 8/30 repair: composer abstained, nothing was sent"
        if touched and write:
            json.dump(doc, open(path, "w"), ensure_ascii=False, indent=1)
            print(f"  wrote {os.path.basename(path)} (zone {zname})")
    verb = "repaired" if write else "would repair"
    print(f"\n{verb}: {naive} naive instant(s), {kept} falsely-kept promise(s)")
    if not write:
        print("dry run — rerun with --write to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
