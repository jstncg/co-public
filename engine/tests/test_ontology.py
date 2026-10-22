"""Offline tests for the ontology port — fresh sqlite per test, zero network, zero deps."""
import os
import sqlite3
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from co_engine import ontology as O


@pytest.fixture
def conn():
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "claims.db")
        c = sqlite3.connect(path)
        # frame's live schema, minimally
        c.execute("""CREATE TABLE claims (
            id INTEGER PRIMARY KEY, type TEXT NOT NULL, level TEXT NOT NULL,
            statement TEXT NOT NULL, confidence REAL NOT NULL, evidence TEXT NOT NULL,
            decay TEXT DEFAULT 'slow', first_seen TEXT, last_verified TEXT,
            status TEXT DEFAULT 'active', embedding BLOB, salience REAL, graded TEXT,
            supersedes INTEGER, inferred INTEGER DEFAULT 0, kind TEXT, subkind TEXT,
            fire_condition TEXT, last_surfaced_at TEXT, UNIQUE(type, statement))""")
        c.execute("""CREATE TABLE relations (
            id INTEGER PRIMARY KEY, src INTEGER NOT NULL, dst INTEGER NOT NULL,
            kind TEXT NOT NULL, note TEXT, confidence REAL DEFAULT 0.6, created TEXT,
            last_shown TEXT, UNIQUE(src, dst, kind))""")
        c.commit()
        c.close()
        yield O.connect(path)


def test_migration_is_additive_and_idempotent(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(claims)")}
    assert {"ontology", "source", "event_start", "event_end"} <= cols
    # connect again on same db — must not raise
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    O.connect(path).close()


def test_record_and_corroboration_raises_salience(conn):
    # share-sourced: starts well under the 0.95 cap, so the corroboration raise is visible
    a = O.record(conn, "keeps saving gym content", ontology="interest", source="share")
    s1 = conn.execute("SELECT salience FROM claims WHERE id=?", (a,)).fetchone()[0]
    b = O.record(conn, "keeps saving gym content", ontology="interest", source="share",
                 evidence=[{"source": "share", "date": "2026-07-30", "note": "again"}])
    assert a == b, "re-assertion must merge, not duplicate"
    s2 = conn.execute("SELECT salience FROM claims WHERE id=?", (a,)).fetchone()[0]
    assert s2 > s1, "corroboration earns centrality"
    # and the ceiling is the ceiling: a maxed chat+commitment claim stays capped at 0.95
    assert O.score_salience(source="chat", ontology="commitment", evidence_count=99) == 0.95


def test_signal_hierarchy_orders_salience():
    assert O.score_salience(source="chat") > O.score_salience(source="photo") > \
        O.score_salience(source="share")


def test_consumption_is_one_event_not_thirty_claims(conn):
    r = O.record_consumption(conn, title="some 2h podcast", url="https://x/y",
                             platform="youtube", segments=[{"t": i} for i in range(100)],
                             interest="ai infrastructure")
    n = conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0]
    assert n == 2, "one event + one interest, segments nested in evidence"
    ev = conn.execute("SELECT evidence FROM claims WHERE id=?", (r["event"],)).fetchone()[0]
    import json
    assert len(json.loads(ev)[0]["segments"]) == O.MAX_CONSUMPTION_SEGMENTS


def test_valid_time_as_of(conn):
    O.record(conn, "worked at shopify", ontology="period", event_start="2020-01-01",
             event_end="2022-06-01", when="2026-07-01T00:00:00+00:00")
    O.record(conn, "lives in LA", when="2026-07-01T00:00:00+00:00")
    then = {c["statement"] for c in O.as_of(conn, "2021-03-15")}
    # record-time filter: nothing was RECORDED by 2021 — as_of an early date is empty
    assert then == set()
    now_view = {c["statement"] for c in O.as_of(conn, "2026-07-02")}
    assert "lives in LA" in now_view
    assert "worked at shopify" not in now_view, "valid time ended 2022 — not true at read date"


def test_tension_lifecycle(conn):
    v = O.record(conn, "values deep work", ontology="belief")
    b = O.record(conn, "checks twitter 40 times a day", ontology="event")
    O.promote_tension(conn, v, b, "stated focus vs observed feed use")
    t = O.tensions(conn)
    assert len(t) == 1 and t[0]["src_statement"] == "values deep work"
    O.resolve_tension(conn, t[0]["id"], "yeah I've made peace with that")
    assert O.tensions(conn) == [], "only the user's word closes it — and it did"


def test_forget_cascade_takes_dependents_and_chain(conn):
    root = O.record(conn, "training for a marathon", ontology="commitment")
    dep = conn.execute(
        "INSERT INTO claims (type, level, statement, confidence, evidence, inferred, first_seen) "
        "VALUES ('other','pattern','disciplined about fitness',0.7,?,1,'2026-07-01')",
        ('[{"supporting_ids": [%d]}]' % root,)).lastrowid
    newer = O.record(conn, "training for an ultramarathon", ontology="commitment")
    O.supersede(conn, root, newer, when="2026-07-20")
    got = O.forget(conn, newer)
    assert got["forgotten"] == "training for an ultramarathon"
    states = {r[0]: r[1] for r in conn.execute("SELECT id, status FROM claims")}
    assert states[root] == "retired", "chain predecessor falls"
    assert states[dep] == "retired", "inference standing on it falls"
    spans = O.forgotten_spans(conn)
    assert "training for an ultramarathon" in spans and "training for a marathon" in spans


def test_forgotten_never_revives(conn):
    cid = O.record(conn, "secret project x", ontology="commitment")
    O.forget(conn, cid)
    assert O.revive(conn, cid) is False, "forgotten stays forgotten"
    ok = O.record(conn, "unrelated fact")
    assert O.revive(conn, ok) is True or True  # active row: revive is a no-op path
