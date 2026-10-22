#!/usr/bin/env python3
"""Retroactively apply the RECEIVING≠DOING gate to the EXISTING graph.

The extractor gate (email_class) stops NEW false behavioral claims. But the graph already holds thousands
extracted before the gate. This re-classifies each active claim's evidence and retires the ones the gate
would now block: a behavioral/identity claim whose evidence is ENTIRELY receiving-class email. Deterministic,
no LLM. Retired (not deleted) — auditable, reversible.

  doppler run -- /…/python3 regate.py [--dry]
"""
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "engine"))
from co_engine import ontology as _O
import claimstore
from email_class import classify, receiving_violation

WHEN = date.today().isoformat()


def main():
    dry = "--dry" in sys.argv
    conn = claimstore.connect()
    rows = conn.execute(
        "SELECT id, statement, evidence, graded FROM claims WHERE COALESCE(status,'active')!='retired'").fetchall()
    retire, samples = [], []
    for cid, stmt, ev_json, graded in rows:
        if graded in ("boost", "keep"):
            continue  # subject-confirmed — never auto-retire
        try:
            ev = json.loads(ev_json)
        except (json.JSONDecodeError, TypeError):
            continue
        if not ev:
            continue
        # all evidence emails classify as receiving (inbound push)?
        labels = [classify(e.get("subject", ""), e.get("from", "")) for e in ev]
        all_receiving = bool(labels) and all(r for _, r in labels)
        if all_receiving and receiving_violation(stmt or ""):
            retire.append(cid)
            if len(samples) < 12:
                samples.append(stmt[:64])
    print(f"{'[DRY] ' if dry else ''}retroactive gate: {len(retire)} of {len(rows)} active claims are "
          f"behavioral-from-receiving-only → retire")
    for s in samples:
        print(f"    – {s}")
    if not dry and retire:
        _O.retire(conn, retire, WHEN, commit=False)
        conn.commit()
        print(f"  ✓ retired {len(retire)} (auditable; reversible)")


if __name__ == "__main__":
    main()
