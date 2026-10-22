#!/usr/bin/env python3
"""The ontology layer — kyo's best structural work, ported onto frame's claim store.

This is the consolidation the monorepo exists for: kyo/server/kyo/ontology.py's semantics
(MASTER.md §15), reimplemented over frame's `claims` schema (claims.db — 27k rows live).
Frame already had half the structure (status, salience, supersedes, inferred, embedding);
this module adds what kyo proved out and frame lacked:

  - the personal ontology: person | event | interest | belief | commitment | tension | period
  - the signal hierarchy as provenance: chat | card | call | photo | share | onboarding
    (stated beats behavioral beats passive — queryable, not just believed)
  - bi-temporality: first_seen/last_verified are RECORD time; event_start/event_end add
    VALID time — when it was true in their life, not when co learned it. VALID TIME IS
    STAMPED, NEVER GUESSED (a wrong date silently vanishes a claim from as_of reads; an
    omission costs nothing).
  - tensions: contradictions are never resolved away — they become `contradicts` edges,
    strengthened by repetition, surfaced as questions, resolved ONLY by the user's word.
  - the forget cascade: forgetting a claim retires its whole supersede chain, retracts
    every inference standing on it (breadth-first over supporting_ids provenance), drops
    embeddings (the vector IS the content), closes tensions standing on the fallen, and
    leaves sha256 tombstones so nothing re-asserts it — or "deleted" is a lie.
  - consumption events: a watched video is ONE event row with segments nested in evidence,
    never 30 claims — a user's whole belief store is single digits, and one podcast must
    not outweigh everything they ever said directly.

Everything is a pure function over a sqlite3 connection from connect(db_path). Zero deps.
Additive migration on open; safe against the live founder db.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone

ONTOLOGY_KINDS = {"person", "event", "interest", "belief", "commitment", "tension", "period"}
SOURCES = {"chat", "card", "call", "photo", "share", "onboarding"}

# Signal hierarchy: active stated > active behavioral > passive consumption.
SOURCE_WEIGHT = {"chat": 1.0, "call": 1.0, "card": 0.9, "onboarding": 0.85,
                 "photo": 0.7, "share": 0.5}
_ONTOLOGY_WEIGHT = {"identity": 1.0, "belief": 1.0, "commitment": 1.0, "person": 1.0,
                    "tension": 1.0, "period": 0.7, "interest": 0.8, "event": 0.6}
_UNTYPED_WEIGHT = 0.7

MAX_CONSUMPTION_SEGMENTS = 60
CONSUMPTION_CONFIDENCE = 0.5
_FORGET_PREFIX = "User asked co to forget this — never reference or re-infer: "
_HEX64 = re.compile(r"[0-9a-f]{64}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def score_salience(source: str = "chat", ontology: str = "", level: str = "fact",
                   evidence_count: int = 1) -> float:
    """How much this claim DEFINES them (0.05-0.95) — not how sure co is that it's true.
    Deterministic and offline by construction; corroboration earns centrality, capped so
    volume can't fake depth."""
    s = SOURCE_WEIGHT.get(source, 0.7)
    s *= _ONTOLOGY_WEIGHT.get(ontology, _UNTYPED_WEIGHT)
    if level == "frame":
        s *= 0.7
    s += min(0.05 * max(0, evidence_count - 1), 0.20)
    return round(min(0.95, max(0.05, s)), 3)


def connect(db_path: str) -> sqlite3.Connection:
    """Open (and additively migrate) a frame claims db. Never destructive."""
    conn = sqlite3.connect(db_path, timeout=15)
    for ddl in (
        "ALTER TABLE claims ADD COLUMN ontology TEXT",
        "ALTER TABLE claims ADD COLUMN source TEXT",
        "ALTER TABLE claims ADD COLUMN event_start TEXT",
        "ALTER TABLE claims ADD COLUMN event_end TEXT",
        "ALTER TABLE relations ADD COLUMN resolved TEXT",
        "ALTER TABLE relations ADD COLUMN resolved_at TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass                                # column exists — migration already ran
    conn.commit()
    return conn


# ── writing ─────────────────────────────────────────────────────────────────────────────


def _upsert(conn: sqlite3.Connection, *, type: str, level: str, statement: str,
            confidence: float, evidence: list, when: str) -> int | None:
    """Frame's UNIQUE(type, statement) upsert: re-asserting unions evidence (corroboration
    is signal, never a duplicate row). Junk statements are rejected, not stored."""
    statement = (statement or "").strip()
    if not statement or statement.lower() in ("(unknown)", "unknown", "none"):
        return None
    row = conn.execute("SELECT id, evidence FROM claims WHERE type=? AND statement=?",
                       (type, statement)).fetchone()
    if row:
        try:
            ev = json.loads(row[1] or "[]")
        except (ValueError, TypeError):
            ev = []
        seen = {json.dumps(e, sort_keys=True) for e in ev}
        for e in evidence:
            if json.dumps(e, sort_keys=True) not in seen:
                ev.append(e)
        conn.execute("UPDATE claims SET evidence=?, last_verified=?, "
                     "confidence=MAX(confidence, ?) WHERE id=?",
                     (json.dumps(ev), when, confidence, row[0]))
        return row[0]
    cur = conn.execute(
        "INSERT INTO claims (type, level, statement, confidence, evidence, first_seen, last_verified) "
        "VALUES (?,?,?,?,?,?,?)",
        (type, level, statement, confidence, json.dumps(evidence), when, when))
    return cur.lastrowid


def record(conn: sqlite3.Connection, fact: str, *, ontology: str = "", source: str = "chat",
           event_start: str = "", event_end: str = "", confidence: float = 0.85,
           level: str = "fact", claim_type: str = "other", evidence: list | None = None,
           when: str = "") -> int | None:
    """Write one belief with the full schema. `when` is RECORD time; event_start/event_end
    are VALID time — fill them only when the user explicitly dated the thing."""
    when = when or _now_iso()
    ontology = ontology if ontology in ONTOLOGY_KINDS else ""
    source = source if source in SOURCES else "chat"
    ev = evidence if evidence is not None else [{"source": source, "date": when, "note": "recorded by co"}]
    cid = _upsert(conn, type=claim_type, level=level, statement=fact,
                  confidence=confidence, evidence=ev, when=when)
    if cid is None:
        return None
    row = conn.execute("SELECT evidence FROM claims WHERE id=?", (cid,)).fetchone()
    try:
        n_ev = len(json.loads(row[0] or "[]")) if row else 1
    except (ValueError, TypeError):
        n_ev = 1
    # CANON IS NEVER SCORED, AT WRITE TIME (2026-08-29). salience.recompute() has cleared canon
    # scores since 8/5, but a sweep is not a law: every canon claim was born with a score and
    # stayed rankable until the next sweep ran. 39 were sitting scored when this was found. A
    # claim that must never be ranked must never be given a rank in the first place.
    sal = None if _is_canon(ev) else score_salience(
        source=source, ontology=ontology, level=level, evidence_count=max(1, n_ev))
    conn.execute(
        "UPDATE claims SET ontology=COALESCE(NULLIF(?,''),ontology), "
        "source=COALESCE(NULLIF(?,''),source), "
        "event_start=COALESCE(NULLIF(?,''),event_start), "
        "event_end=COALESCE(NULLIF(?,''),event_end), salience=? WHERE id=?",
        (ontology, source, event_start, event_end, sal, cid))
    conn.commit()
    return cid


def _is_canon(evidence: list | str | None) -> bool:
    """Doc-derived claims carry {"source": "canon"}. Accepts the parsed list or the raw column."""
    if not evidence:
        return False
    if isinstance(evidence, str):
        return '"source": "canon"' in evidence or '"source":"canon"' in evidence
    return any(isinstance(e, dict) and e.get("source") == "canon" for e in evidence)


def retire(conn: sqlite3.Connection, claim_ids: list, when: str = "", commit: bool = True) -> int:
    """THE ONE DOOR OUT (2026-08-29). Every path that retires a claim comes through here.

    Retirement was scattered across five call sites (forget, correction_ingest, embed's dedup,
    regate, grade) and not one of them cleared salience, so 9,898 dead beliefs sat in the graph
    still carrying the score that decides entry to the carried core. `salience.recompute()` only
    touches live rows, so nothing ever cleaned them: the moment a claim was retired its rank
    froze and became permanent.

    That is the failure the memory-as-compiler argument names. Co's own forget() drops the
    embedding and writes a tombstone, then leaves the ranking intact — retired everywhere except
    the one column that decides whether it gets recalled. One forgotten status filter anywhere
    downstream and a dead belief outranks a live one.

    Retirement now means: dead, unranked, unretrievable. Not one of the three without the others.
    """
    ids = [int(c) for c in claim_ids if c is not None]
    if not ids:
        return 0
    when = when or _now_iso()
    qmarks = ",".join("?" * len(ids))
    conn.execute(f"UPDATE claims SET status='retired', salience=NULL, last_verified=? "
                 f"WHERE id IN ({qmarks})", [when] + ids)
    if commit:
        conn.commit()
    return len(ids)


def record_consumption(conn: sqlite3.Connection, *, title: str, url: str, platform: str = "",
                       when: str = "", segments: list | None = None, liked: bool = False,
                       interest: str = "", verb: str = "watched") -> dict:
    """They CONSUMED something — not that they believe what was in it. ONE event row, at
    most ONE interest row, segments nested in evidence. The verb must match what actually
    happened — 'watched' a four-photo tweet is a small lie, and small lies in the belief
    graph are what wrong callbacks are made of."""
    when = when or _now_iso()
    title = (title or "").strip()[:200] or (url or "").strip()[:200] or "something"
    ev = [{"source": "share", "date": when, "url": (url or "")[:500], "title": title,
           "platform": (platform or "")[:20], "liked": bool(liked),
           "segments": (segments or [])[:MAX_CONSUMPTION_SEGMENTS]}]
    where = f" on {platform}" if platform else ""
    event_id = record(conn, f"{(verb or 'watched').strip()} {title}{where}",
                      ontology="event", source="share", confidence=CONSUMPTION_CONFIDENCE,
                      evidence=ev, when=when, event_start=when[:10], event_end=when[:10])
    interest_id = None
    if interest.strip():
        interest_id = record(conn, interest.strip(), ontology="interest", source="share",
                             confidence=CONSUMPTION_CONFIDENCE, when=when,
                             evidence=[{"source": "share", "date": when, "url": (url or "")[:500]}])
    return {"event": event_id, "interest": interest_id}


# ── tensions ────────────────────────────────────────────────────────────────────────────


def promote_tension(conn: sqlite3.Connection, src: int, dst: int, note: str,
                    confidence: float = 0.6, when: str = "") -> None:
    """Two signals disagree → a contradicts edge (src = the stated value, dst = the
    behavior). Repetition strengthens; it is NEVER auto-merged away."""
    conn.execute(
        "INSERT OR IGNORE INTO relations (src, dst, kind, note, confidence, created) "
        "VALUES (?,?,'contradicts',?,?,?)", (src, dst, note, confidence, when or _now_iso()))
    conn.commit()


def tensions(conn: sqlite3.Connection, limit: int = 5, include_recently_shown: bool = False) -> list:
    """Open tensions, strongest first — the highest-value introspection material there is.
    Excludes resolved edges and edges touching retired claims; rotates away from
    recently-shown by default."""
    order = ("r.confidence DESC" if include_recently_shown
             else "(r.last_shown IS NOT NULL), r.confidence DESC")
    rows = conn.execute(
        "SELECT r.id, r.note, r.confidence, r.last_shown, v.id, v.statement, b.id, b.statement "
        "FROM relations r JOIN claims v ON r.src=v.id JOIN claims b ON r.dst=b.id "
        "WHERE r.kind='contradicts' AND r.resolved IS NULL "
        "AND COALESCE(v.status,'active')!='retired' AND COALESCE(b.status,'active')!='retired' "
        f"ORDER BY {order} LIMIT ?", (limit,)).fetchall()
    keys = ("id", "note", "confidence", "last_shown", "src", "src_statement", "dst", "dst_statement")
    return [dict(zip(keys, r)) for r in rows]


def mark_tension_shown(conn: sqlite3.Connection, relation_id: int, when: str = "") -> None:
    conn.execute("UPDATE relations SET last_shown=? WHERE id=?", (when or _now_iso(), relation_id))
    conn.commit()


def resolve_tension(conn: sqlite3.Connection, relation_id: int, user_word: str, when: str = "") -> None:
    """Only the user's own word closes a tension — stored verbatim on the edge, which
    stays in the store as history."""
    conn.execute("UPDATE relations SET resolved=?, resolved_at=? WHERE id=?",
                 (user_word.strip(), when or _now_iso(), relation_id))
    conn.commit()


# ── bi-temporal reads ───────────────────────────────────────────────────────────────────


def as_of(conn: sqlite3.Connection, date: str, limit: int = 50) -> list:
    """Both-times query: believed AS OF `date` (record time), about things true in their
    life AT `date` (valid time, when known). Empty valid time = always-valid."""
    rows = conn.execute(
        "SELECT id, statement, confidence, ontology, source, first_seen, event_start, event_end, status "
        "FROM claims WHERE first_seen IS NOT NULL AND substr(first_seen,1,10) <= ? "
        "AND (event_start IS NULL OR event_start='' OR substr(event_start,1,10) <= ?) "
        "AND (event_end IS NULL OR event_end='' OR substr(event_end,1,10) >= ?) "
        "ORDER BY confidence DESC LIMIT ?", (date, date, date, limit)).fetchall()
    keys = ("id", "statement", "confidence", "ontology", "source", "first_seen",
            "event_start", "event_end", "status")
    return [dict(zip(keys, r)) for r in rows]


def find_claims(conn: sqlite3.Connection, text: str, limit: int = 6) -> list:
    """Active claims matching `text` (keyword — the forget flow's candidate lookup)."""
    words = [w for w in text.lower().split() if len(w) >= 4] or [text.lower().strip()]
    clauses = " OR ".join("lower(statement) LIKE ?" for _ in words)
    rows = conn.execute(
        f"SELECT id, statement, confidence FROM claims WHERE ({clauses}) "
        f"AND COALESCE(status,'active')!='retired' ORDER BY confidence DESC LIMIT ?",
        ["%" + w + "%" for w in words] + [limit]).fetchall()
    return [{"id": r[0], "statement": r[1], "confidence": r[2]} for r in rows]


# ── the forget cascade ──────────────────────────────────────────────────────────────────


def _dependents(conn: sqlite3.Connection, claim_id: int) -> list:
    """Inferred claims whose evidence stands on claim_id (supporting_ids provenance —
    the convention frame's flywheel adopts going forward)."""
    out = []
    for cid, ev in conn.execute("SELECT id, evidence FROM claims WHERE inferred=1 "
                                "AND COALESCE(status,'active')!='retired'").fetchall():
        try:
            for item in json.loads(ev or "[]"):
                if isinstance(item, dict) and claim_id in (item.get("supporting_ids") or []):
                    out.append(cid)
                    break
        except (ValueError, TypeError):
            continue
    return out


def _supersede_chain(conn: sqlite3.Connection, claim_id: int) -> list:
    """Every id in the supersede chain containing claim_id — the SAME fact across
    revisions. Forgetting any version forgets them all, or an old wording resurfaces."""
    chain, queue, seen = [], [claim_id], {claim_id}
    while queue:
        cid = queue.pop(0)
        chain.append(cid)
        row = conn.execute("SELECT supersedes FROM claims WHERE id=?", (cid,)).fetchone()
        if row and row[0] and row[0] not in seen:
            seen.add(row[0])
            queue.append(row[0])
        for (nid,) in conn.execute("SELECT id FROM claims WHERE supersedes=?", (cid,)).fetchall():
            if nid not in seen:
                seen.add(nid)
                queue.append(nid)
    return chain


def _stmt_key(statement: str) -> str:
    """Tombstone identity: sha256 of the normalized wording — identifies without storing
    a second at-rest copy of the exact string the user asked co to delete."""
    return hashlib.sha256(" ".join((statement or "").split()).lower().encode("utf-8")).hexdigest()


def forget(conn: sqlite3.Connection, claim_id: int, when: str = "") -> dict:
    """Honor "forget I said that" — bulletproof, or it's a trust-extinction event.
    Retires the whole supersede chain, retracts every inference standing on it
    (breadth-first), drops embeddings (the vector IS the content), closes tensions on the
    fallen claims, writes hash tombstones so revive/re-assertion refuses."""
    when = when or _now_iso()
    root = conn.execute("SELECT statement FROM claims WHERE id=?", (claim_id,)).fetchone()
    if not root:
        return {"forgotten": None, "retracted": []}
    statement = root[0]
    chain = _supersede_chain(conn, claim_id)
    to_retire, queue, seen = [], list(chain), set(chain)
    while queue:
        cid = queue.pop(0)
        to_retire.append(cid)
        for dep in _dependents(conn, cid):
            if dep not in seen:
                seen.add(dep)
                queue.append(dep)
    retire(conn, to_retire, when, commit=False)      # dead, unranked, and below: unretrievable
    qmarks = ",".join("?" * len(to_retire))
    conn.execute(f"UPDATE claims SET confidence=0.0 WHERE id IN ({qmarks})", to_retire)
    conn.execute(f"UPDATE claims SET embedding=NULL WHERE id IN ({qmarks})", to_retire)
    conn.execute(
        f"UPDATE relations SET resolved='(retracted: source memory forgotten)', resolved_at=? "
        f"WHERE resolved IS NULL AND (src IN ({qmarks}) OR dst IN ({qmarks}))",
        [when] + to_retire + to_retire)
    worded, stmts = {statement}, [statement]
    for cid in chain[1:]:
        row = conn.execute("SELECT statement FROM claims WHERE id=?", (cid,)).fetchone()
        if row and row[0] and row[0] not in worded:
            worded.add(row[0])
            stmts.append(row[0])
    for s in stmts:
        _upsert(conn, type="forget_marker", level="fact",
                statement=_FORGET_PREFIX + _stmt_key(s), confidence=0.95,
                evidence=[{"source": "user_forget", "date": when}], when=when)
    conn.commit()
    return {"forgotten": statement, "retracted": [c for c in to_retire if c != claim_id]}


def forgotten_spans(conn: sqlite3.Connection) -> list:
    """The verbatim wordings the user asked co to forget — the redaction spans a prompt
    seam scrubs from every prompt source. Read from retired rows matched to tombstone
    hashes (the tombstone itself never quotes the text)."""
    keys, out = set(), []
    for (stmt,) in conn.execute("SELECT statement FROM claims WHERE type='forget_marker'"):
        payload = (stmt or "").split(_FORGET_PREFIX, 1)[-1].strip()
        if not payload:
            continue
        if _HEX64.fullmatch(payload):
            keys.add(payload)
        elif payload not in out:
            out.append(payload)
    if keys:
        for (stmt,) in conn.execute("SELECT statement FROM claims WHERE type!='forget_marker'"):
            if stmt and _stmt_key(stmt) in keys and stmt not in out:
                out.append(stmt)
    return out


def revive(conn: sqlite3.Connection, claim_id: int, when: str = "") -> bool:
    """Un-retire a claim — REFUSED if its wording is tombstoned (forgotten stays forgotten
    until the user's own new assertion, which arrives as a fresh record, not a revive)."""
    row = conn.execute("SELECT statement FROM claims WHERE id=?", (claim_id,)).fetchone()
    if not row:
        return False
    marker = _FORGET_PREFIX + _stmt_key(row[0])
    if conn.execute("SELECT 1 FROM claims WHERE type='forget_marker' AND statement=?",
                    (marker,)).fetchone():
        return False
    conn.execute("UPDATE claims SET status='active', last_verified=? WHERE id=?",
                 (when or _now_iso(), claim_id))
    conn.commit()
    return True


def supersede(conn: sqlite3.Connection, old_id: int, new_id: int, when: str = "") -> bool:
    """The new wording replaces the old; the old row stays as history (the chain IS the
    revision history, and as-of reads that predate the replacement still see it)."""
    if old_id == new_id:
        return False
    conn.execute("UPDATE claims SET supersedes=? WHERE id=?", (old_id, new_id))
    conn.execute("UPDATE claims SET status='superseded', last_verified=? WHERE id=?",
                 (when or _now_iso(), old_id))
    conn.commit()
    return True
