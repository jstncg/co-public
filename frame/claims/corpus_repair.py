#!/usr/bin/env python3
"""CORPUS REPAIR — make the graph mostly the member again (2026-08-29).

The founder sent a piece arguing that agent quality comes from memory architecture rather
than the base model, and that aggressive forgetting is the trust story. co failed that test
in its own eval output, which had been printing the failure for weeks as advisory noise:

    truth: the live graph is mostly the member, not co's own docs
        dennis: 4292 canon vs 202 real
    truth: retired beliefs carry no salience
        dennis: 9898

Three findings behind those two lines:

  1. RETIREMENT NEVER CLEARED THE RANK. Five call sites retired claims and not one nulled
     salience, and salience.recompute() only touches live rows, so a claim's rank froze on
     death and stayed forever. Even forget() — which drops the embedding and writes a
     tombstone — left it. Fixed at the source: ontology.retire() is now the one door out.

  2. CANON WAS SCORED AT WRITE TIME. record() gave every claim a salience including co's
     own docs; recompute() cleared them on its next pass. Between those two moments they
     were rankable, and 39 were sitting scored when this ran. Fixed: never scored at all.

  3. CANON OWNED THE VECTOR INDEX. 4,127 of 4,328 embedded live claims were co's product
     documentation against 201 real ones, and neither claimstore.recall_semantic() nor
     co_react filtered it. Every semantic recall about the member was answering out of the
     engineering spec at 20:1 odds. Fixed: canon is not embedded, and both readers filter.

This repairs what those bugs already wrote. It does NOT delete anything: salience and
embedding are derived columns, canon claims keep their statements, their evidence, and
their keyword findability. Embeddings regenerate from embed.py if this is ever reversed.

    python3 corpus_repair.py             # dry run — counts only, touches nothing
    python3 corpus_repair.py --write     # apply
    python3 corpus_repair.py --write --db claims_<tenant>.db
"""
from __future__ import annotations

import os
import sqlite3
import sys

CANON = '%"source": "canon"%'

STEPS = [
    ("retired claims still carrying a rank",
     "SELECT count(*) FROM claims WHERE COALESCE(status,'active')='retired' AND salience IS NOT NULL",
     "UPDATE claims SET salience=NULL WHERE COALESCE(status,'active')='retired' AND salience IS NOT NULL"),
    ("live canon claims carrying a rank",
     f"SELECT count(*) FROM claims WHERE COALESCE(status,'active')!='retired' "
     f"AND salience IS NOT NULL AND COALESCE(evidence,'') LIKE '{CANON}'",
     f"UPDATE claims SET salience=NULL WHERE COALESCE(status,'active')!='retired' "
     f"AND salience IS NOT NULL AND COALESCE(evidence,'') LIKE '{CANON}'"),
    ("canon claims holding a vector-index slot",
     f"SELECT count(*) FROM claims WHERE embedding IS NOT NULL "
     f"AND COALESCE(evidence,'') LIKE '{CANON}'",
     f"UPDATE claims SET embedding=NULL WHERE embedding IS NOT NULL "
     f"AND COALESCE(evidence,'') LIKE '{CANON}'"),
    ("legacy claims wearing the member's authority for a model's sentence",
     "SELECT count(*) FROM claims WHERE COALESCE(evidence,'') LIKE '%user_correction%' "
     "AND first_seen < '2026-08-29'",
     "UPDATE claims SET evidence=REPLACE(evidence,'\"user_correction\"','\"correction_inferred\"'), "
     "confidence=MIN(COALESCE(confidence,0.75),0.75) "
     "WHERE COALESCE(evidence,'') LIKE '%user_correction%' AND first_seen < '2026-08-29'"),
]


def survey(conn) -> dict:
    q = lambda s: conn.execute(s).fetchone()[0]
    live = "COALESCE(status,'active')!='retired'"
    return {
        "recallable_member": q(f"SELECT count(*) FROM claims WHERE {live} AND embedding IS NOT NULL "
                               f"AND COALESCE(evidence,'') NOT LIKE '{CANON}'"),
        "recallable_canon": q(f"SELECT count(*) FROM claims WHERE {live} AND embedding IS NOT NULL "
                              f"AND COALESCE(evidence,'') LIKE '{CANON}'"),
        "ranked_member": q(f"SELECT count(*) FROM claims WHERE {live} AND salience IS NOT NULL "
                           f"AND COALESCE(evidence,'') NOT LIKE '{CANON}'"),
        "ranked_dead": q("SELECT count(*) FROM claims WHERE COALESCE(status,'active')='retired' "
                         "AND salience IS NOT NULL"),
    }


def report(tag: str, s: dict) -> None:
    total = s["recallable_member"] + s["recallable_canon"]
    share = (100.0 * s["recallable_member"] / total) if total else 100.0
    print(f"  {tag}")
    print(f"     semantic recall pool : {s['recallable_member']} member / {s['recallable_canon']} canon "
          f"({share:.0f}% member)")
    print(f"     ranked (carried core): {s['ranked_member']} member, {s['ranked_dead']} dead-but-ranked")


def main(argv: list[str]) -> int:
    write = "--write" in argv
    db = "claims.db"
    if "--db" in argv:
        db = argv[argv.index("--db") + 1]
    db = db if os.path.isabs(db) else os.path.join(os.path.dirname(os.path.abspath(__file__)), db)
    if not os.path.exists(db):
        print(f"no such graph: {db}")
        return 1

    conn = sqlite3.connect(db)
    print(f"corpus repair — {os.path.basename(db)}{'' if write else '  (DRY RUN)'}\n")
    report("before", survey(conn))
    print()
    for label, count_sql, fix_sql in STEPS:
        n = conn.execute(count_sql).fetchone()[0]
        if not n:
            print(f"  ✓ {label}: none")
            continue
        if write:
            conn.execute(fix_sql)
            conn.commit()
            print(f"  → {label}: {n} cleared")
        else:
            print(f"  · {label}: {n} would clear")
    if write:
        print()
        report("after", survey(conn))
    conn.close()
    print("\n" + ("done." if write else "dry run — rerun with --write to apply."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
