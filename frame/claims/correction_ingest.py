#!/usr/bin/env python3
"""User-correction ingest (7/2) — the user's edits to their own memory are FIRST-CLASS signal.

The viewer's flag/edit UI writes rows into `user_corrections` in the per-tenant claims db (the contract:
id, claim_id, action 'wrong'|'edit', text, created_at, processed). This processor honors them:

  action='wrong' → the claim's confidence is zeroed and it is retired: it never appears in recall,
                   carried core, or the reaction gate again. A tombstone claim ("user corrected: it is
                   NOT true that …") is written so the model can't casually re-infer the same thing
                   from old transcripts — the correction reaches the model like a remembered fact.
  action='edit'  → the user's text becomes a NEW claim (confidence 0.95, evidence=user_correction)
                   with supersedes=old_id. The old claim stays in the db (history: "used to X, now Y"
                   stays queryable via the supersede chain) but every read path excludes superseded rows.

Runs in the router's post-reply bookkeeping pass; the engine (memory.ts) runs the same semantics on
recall so a correction made mid-conversation lands before the next reply. Idempotent (processed=1).

  python3 correction_ingest.py <claims_db>          # process pending corrections, print what happened
"""
import datetime as dt
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "engine"))
from co_engine import ontology as O

sys.path.insert(0, str(Path(__file__).resolve().parent))
import attribution as _attr

CORRECTIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_corrections (
    id          INTEGER PRIMARY KEY,
    claim_id    INTEGER NOT NULL,
    action      TEXT NOT NULL,
    text        TEXT,
    created_at  TEXT,
    processed   INTEGER DEFAULT 0
);
"""


def _ensure(conn: sqlite3.Connection) -> None:
    conn.executescript(CORRECTIONS_SCHEMA)
    try:
        conn.execute("ALTER TABLE claims ADD COLUMN supersedes INTEGER")
    except sqlite3.OperationalError:
        pass  # already migrated
    # WHO WROTE THE CORRECTION (8/29). Rows used to be indistinguishable, so a replacement
    # sentence composed by a model got stamped with the member's own authority. Legacy rows
    # default to 'inferred' because every row on the box was written by correction_detect.
    try:
        conn.execute("ALTER TABLE user_corrections ADD COLUMN origin TEXT DEFAULT 'inferred'")
    except sqlite3.OperationalError:
        pass


def process(claims_db: str) -> list:
    """Honor all unprocessed corrections. Returns a list of human-readable actions taken (empty = none)."""
    if not Path(claims_db).exists():
        return []
    done = []
    conn = sqlite3.connect(claims_db, timeout=10)
    try:
        _ensure(conn)
        today = dt.date.today().isoformat()
        rows = conn.execute(
            "SELECT id, claim_id, action, text, COALESCE(origin,'inferred') "
            "FROM user_corrections WHERE processed=0 ORDER BY id").fetchall()
        tenant = _attr.tenant_of(claims_db)
        for cid, claim_id, action, text, origin in rows:
            old = conn.execute("SELECT type, level, statement FROM claims WHERE id=?", (claim_id,)).fetchone()
            if not old:
                conn.execute("UPDATE user_corrections SET processed=1 WHERE id=?", (cid,))
                done.append(f"#{cid}: claim {claim_id} missing — marked processed")
                continue
            ctype, level, statement = old
            # PROVENANCE IS NOT A COURTESY TITLE (8/29). `user_correction` is the highest-trust
            # source co has: corrections override, and the vault says check them before any
            # factual claim. Only the member typing into the viewer earns it. correction_detect
            # infers a correction from conversation with a model call, and the sentence it writes
            # is the MODEL's, so it lands one tier down and cannot outrank a claim it contradicts.
            by_member = origin == "member"
            ev = json.dumps([{"source": "user_correction" if by_member else "correction_inferred",
                              "date": today}])
            conf = 0.95 if by_member else 0.75
            if action == "wrong":
                conn.execute("UPDATE claims SET confidence=0 WHERE id=?", (claim_id,))
                O.retire(conn, [claim_id], today, commit=False)   # dead means unranked too
                # the tombstone: the correction reaches the model as a remembered fact, so it never
                # re-asserts (or re-infers) the flagged thing. Retrieved on topic; never carried in core.
                conn.execute(
                    "INSERT OR IGNORE INTO claims(type,level,statement,confidence,evidence,decay,"
                    "first_seen,last_verified,status,supersedes) VALUES(?,?,?,?,?,'slow',?,?,'active',?)",
                    ("correction", "fact",
                     f"User explicitly corrected this — it is NOT true that: {statement}",
                     0.9 if by_member else 0.75, ev, today, today, claim_id))
                done.append(f"#{cid}: WRONG → retired claim {claim_id} ({statement[:50]!r}) + tombstone")
            elif action == "edit" and (text or "").strip():
                # THE SUBJECT MUST BE THE MEMBER. On 8/24 this path stored "Dan is building a
                # product called 'co-'" at 0.95 — the member's own act pinned on the author of an
                # article he had deposited, outranking the true claim (27247) at 0.782. A
                # correction is co being told about the member; a sentence about somebody else
                # cannot be one, whoever wrote it.
                who = _attr.foreign_subject(tenant, text.strip()) if tenant else ""
                if who:
                    done.append(f"#{cid}: REFUSED → correction subject is {who!r}, not the member: "
                                f"{text.strip()[:60]!r}")
                    conn.execute("UPDATE user_corrections SET processed=1 WHERE id=?", (cid,))
                    continue
                conn.execute(
                    "INSERT OR IGNORE INTO claims(type,level,statement,confidence,evidence,decay,"
                    "first_seen,last_verified,status,supersedes) VALUES(?,?,?,?,?,'slow',?,?,'active',?)",
                    (ctype, level if level in ("fact", "pattern") else "fact", text.strip(),
                     conf, ev, today, today, claim_id))
                done.append(f"#{cid}: EDIT → claim {claim_id} superseded by {text.strip()[:50]!r}")
            else:
                done.append(f"#{cid}: unknown action {action!r} — marked processed")
            conn.execute("UPDATE user_corrections SET processed=1 WHERE id=?", (cid,))
        conn.commit()
        # a processed correction invalidates the carried-core cache (the portrait may cite the old fact)
        if rows:
            core = Path(f"{claims_db}.core.md")
            if core.exists():
                try:
                    core.unlink()
                except OSError:
                    pass
    finally:
        conn.close()
    return done


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent / "claims.db")
    out = process(db)
    print("\n".join(out) if out else "(no pending corrections)")
