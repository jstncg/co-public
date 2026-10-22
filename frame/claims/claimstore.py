#!/usr/bin/env python3
"""Claim store — the substrate primitive (SUBSTRATE_PLAN v0.1).

Memory as AUDITABLE BELIEFS, not embeddings/chunks. Every belief is a typed claim with confidence +
evidence pointers + decay, so you can reason over it, update it, and SHOW the user why Donna thinks
what she thinks. profile/possessions/scrummage become extractors that write here.

Three levels of inference (the guardrail is load-bearing):
  fact     — concrete, evidence-backed ("owns an Apple Watch")
  pattern  — behavior over time, repeated obs ("buys stuff when burnt out")
  frame    — interpretive, DANGEROUS — never asserted, always tentative ("maybe optimizing status over curiosity")

SQLite, local. Schema is the contract; the extractor (extract_claims.py) fills it.
"""
import json
import os
import re as _re
import sqlite3
from pathlib import Path

DB_DIR = Path(__file__).resolve().parent
DB = DB_DIR / "claims.db"            # legacy single-tenant store = the default tenant ("dennis")
DEFAULT_TENANT = "dennis"


def db_path(tenant=None) -> Path:
    """Per-tenant belief stores. The model of a person is the most intimate data in the system —
    tenant separation is a CORRECTNESS requirement, not a feature (user #2 must never be served
    user #1's interior). Default tenant keeps the existing claims.db; anyone else gets their own
    claims_<tenant>.db (cold start; schema auto-created by connect)."""
    # Explicit path override (CO_CLAIMS_DB) — the cross-language tenant handle the TS memory.ts also reads,
    # so the agent (TS) and the ledger/extractors (Python) write to the SAME per-tenant db. Takes precedence.
    explicit = os.getenv("CO_CLAIMS_DB")
    if explicit:
        return Path(explicit)
    t = (tenant or os.getenv("CO_TENANT") or DEFAULT_TENANT).strip().lower()
    t = _re.sub(r"[^a-z0-9_+\-]", "_", t) or DEFAULT_TENANT
    return DB if t == DEFAULT_TENANT else DB_DIR / f"claims_{t}.db"

LEVELS = {"fact", "pattern", "frame"}
# "value" = something the user SAYS matters (stated goals/values, from the vault). Behavior types
# (routine/possession/obligation/preference) are what they ACTUALLY do. The (d) lives in the gap:
# a `contradicts` edge between a value-claim and a behavior-claim.
TYPES = {"value", "possession", "routine", "relationship", "preference", "obligation", "identity", "frame", "other"}
REL_KINDS = {"contradicts", "supports", "refines"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS claims (
    id            INTEGER PRIMARY KEY,
    type          TEXT NOT NULL,           -- possession/routine/relationship/preference/obligation/identity/frame/other
    level         TEXT NOT NULL,           -- fact | pattern | frame
    statement     TEXT NOT NULL,           -- the belief, in plain language
    confidence    REAL NOT NULL,           -- 0..1
    evidence      TEXT NOT NULL,           -- JSON: [{"email_id","date","from","subject"}...]
    decay         TEXT DEFAULT 'slow',     -- slow|medium|fast (how fast this belief goes stale)
    first_seen    TEXT,
    last_verified TEXT,
    supersedes    INTEGER,                 -- claim id this row replaces (changed fact, chain = history)
    UNIQUE(type, statement)
);
CREATE INDEX IF NOT EXISTS idx_claims_type  ON claims(type);
CREATE INDEX IF NOT EXISTS idx_claims_level ON claims(level);
CREATE INDEX IF NOT EXISTS idx_claims_conf  ON claims(confidence);
CREATE INDEX IF NOT EXISTS idx_claims_supersedes ON claims(supersedes);

-- User-correction contract (7/2): the VIEWER writes rows here (flag/edit UI); correction_ingest.py and the
-- engine (memory.ts) process them. action='wrong' → the claim is never used again; action='edit' → the
-- user's text becomes a NEW high-confidence claim superseding the old (user-stated = first-class signal).
CREATE TABLE IF NOT EXISTS user_corrections (
    id          INTEGER PRIMARY KEY,
    claim_id    INTEGER NOT NULL,
    action      TEXT NOT NULL,           -- 'wrong' | 'edit'
    text        TEXT,                    -- the user's replacement text (edit)
    created_at  TEXT,
    processed   INTEGER DEFAULT 0
);

-- Edges between claims. The (d) engine = `contradicts` edges from a value-claim to a behavior-claim.
-- `note` holds the materialized contradiction line (the thing Donna would say). `last_shown` lets the
-- surfacer rotate / not repeat — the (d) becomes a cheap, persistent, grounded query, not a re-derivation.
CREATE TABLE IF NOT EXISTS relations (
    id          INTEGER PRIMARY KEY,
    src         INTEGER NOT NULL,        -- claim id (the value, for contradicts)
    dst         INTEGER NOT NULL,        -- claim id (the behavior)
    kind        TEXT NOT NULL,           -- contradicts | supports | refines
    note        TEXT,                    -- the materialized line (for contradicts: the (d) Donna would say)
    confidence  REAL DEFAULT 0.6,
    created     TEXT,
    last_shown  TEXT,
    UNIQUE(src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_rel_kind ON relations(kind);
"""


DECAY_DAYS = {"slow": 365, "medium": 120, "fast": 30}   # how long before a belief wants re-verification


def _migrate(conn):
    """Additive migrations for pre-existing dbs (never rewrites rows)."""
    try:
        conn.execute("ALTER TABLE claims ADD COLUMN supersedes INTEGER")
    except Exception:
        pass  # already there


def connect_path(path):
    """Open one exact belief-graph path and make the full schema real

    A fresh relationship can acquire sidecar tables from returns or episodes before its
    first claim exists, so file existence is never proof that the belief graph was initialized
    """
    conn = sqlite3.connect(Path(path))
    _migrate(conn)
    conn.executescript(SCHEMA)
    # migration: status column (active|retired) — beliefs are retired, never deleted (stay auditable)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(claims)").fetchall()}
    if "status" not in cols:
        conn.execute("ALTER TABLE claims ADD COLUMN status TEXT DEFAULT 'active'")
        conn.commit()
    if "embedding" not in cols:
        conn.execute("ALTER TABLE claims ADD COLUMN embedding BLOB")   # voyage-4-lite float32, for dedup + semantic recall
        conn.commit()
    # P2: salience ≠ confidence. confidence = "how sure am I this is true"; salience = "how much does this
    # DEFINE them". A 100%-confident Krispy-Kreme-account is high-conf, near-zero salience. The carried core
    # ranks by salience, not confidence (UNDERSTANDING_AGENT.md P2). `graded` = the subject's verdict (ground
    # truth) — overrides the computed score.
    if "salience" not in cols:
        conn.execute("ALTER TABLE claims ADD COLUMN salience REAL")     # 0..1, computed by salience.py
        conn.commit()
    if "graded" not in cols:
        conn.execute("ALTER TABLE claims ADD COLUMN graded TEXT")        # keep|boost|demote (subject-as-grader)
        conn.commit()
    # TWO-TIER CLAIMS (infer.py) + ACTIONABILITY (reconciler.py). Higher-order claims derived ACROSS the
    # atomics (preoccupations / temporal patterns / tensions / trajectory / candidate insecurities) mark
    # inferred=1 and carry their supporting atomic-claim ids in `evidence` (kind:"inference"). Every claim —
    # atomic or inferred — gets an actionability `kind` the proactive engine consumes, a `fire_condition`
    # (when it becomes worth acting on), and `last_surfaced_at` (flag once, then drop — never repeat).
    for col, ddl in (("inferred", "INTEGER DEFAULT 0"),   # 1 = higher-order, derived across atomics
                     ("kind", "TEXT"),                    # open_loop|conviction|interest|insecurity|pattern
                     ("subkind", "TEXT"),                 # conviction: consequentialist|sacred
                     ("fire_condition", "TEXT"),          # JSON: {"type":..., ...}
                     ("last_surfaced_at", "TEXT")):       # ISO ts a proactive lane last fired on this claim
        if col not in cols:
            conn.execute(f"ALTER TABLE claims ADD COLUMN {col} {ddl}")
            conn.commit()
    return conn


def connect(tenant=None):
    return connect_path(db_path(tenant))


def recall_semantic(conn, query, limit=8, return_meta=False):
    """Semantic recall — find claims by MEANING, not keyword (Flaw #4). Embeds the query (voyage-4-lite),
    brute-force cosine over stored claim embeddings. Falls back to keyword recall() if embeddings/numpy
    aren't available. ms at ~14k claims.

    return_meta=True → (numbered_text, meta) where meta = [{"n","level","confidence","statement"}...].
    The numbering lets an answer CITE which claims it used, and the per-claim level is what bounds
    synthesis confidence (synth_calib): evidence structure, not stated vibe."""
    try:
        import numpy as np
        import embed as _e
        rows = conn.execute("SELECT statement, level, confidence, evidence, embedding, salience, graded FROM claims "
                            "WHERE embedding IS NOT NULL AND COALESCE(status,'active')!='retired' "
                            # canon is co's own docs, not a fact about them (8/29): excluded here as
                            # well as un-embedded at the source, because this reader forgot for 3 weeks
                            "AND COALESCE(evidence,'') NOT LIKE '%\"source\": \"canon\"%' "
                            "AND COALESCE(graded,'')!='demote'").fetchall()  # E6: demoted claims excluded from recall
        if not rows:
            return recall(conn, query, limit)
        M = np.array([np.frombuffer(r[4], dtype=np.float32) for r in rows])
        M = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-9)
        q = np.asarray(_e.voyage([query], input_type="query")[0], dtype=np.float32)
        q = q / (np.linalg.norm(q) + 1e-9)
        sims = M @ q
        # E6 recall bias (TUNED): RELEVANCE (cosine) leads; credibility is a TIE-BREAK, not an override.
        # The old +0.20 graded boost was ~half the cosine range → it buried highly-relevant forensic claims
        # under merely-confirmed ones. Now: a small nudge for trustworthy provenance — subject-CONFIRMED
        # (graded) AND deterministically-computed (forensic) get equal, modest credibility (they're both
        # "earned," not vibed). Salience still favors what defines him.
        sal = np.array([(r[5] if r[5] is not None else 0.3) for r in rows])
        gbonus = np.array([(0.08 if r[6] == "boost" else 0.04 if r[6] == "keep" else 0.0) for r in rows])
        fbonus = np.array([(0.06 if "forensic" in (r[3] or "") else 0.0) for r in rows])  # deterministic = earned
        score = sims + 0.10 * sal + gbonus + fbonus
        top = score.argsort()[::-1][:limit]
        out, meta = [], []
        for n, i in enumerate(top, 1):
            stmt, level, conf, ev = rows[i][0], rows[i][1], rows[i][2], rows[i][3]
            tag = " (tentative)" if level == "frame" else ""
            mark = " ✓confirmed" if rows[i][6] in ("boost", "keep") else (" ·computed" if "forensic" in (ev or "") else "")
            prefix = f"{n}. " if return_meta else "- "
            out.append(f"{prefix}[{conf:.0%} {level}{tag}{mark}] {stmt}  ·sim {sims[i]:.2f}")
            meta.append({"n": n, "level": level, "confidence": conf, "statement": stmt})
        text = "\n".join(out)
        return (text, meta) if return_meta else text
    except Exception:
        txt = recall(conn, query, limit)   # keyword fallback (no per-claim meta available)
        return (txt, []) if return_meta else txt


def disconfirm(conn, statement, evidence, when, drop=0.35):
    """Evidence AGAINST a belief lowers its confidence (the lifecycle — beliefs move both ways, not just
    up). Best-match by statement; appends counter-evidence; retires the claim if confidence falls through
    the floor (kept in the store, marked retired — auditable, never silently deleted)."""
    row = conn.execute("SELECT id, confidence, evidence FROM claims WHERE statement=?", (statement,)).fetchone()
    if not row:  # fuzzy fallback: match on the first few words
        key = "%" + " ".join(statement.split()[:4]) + "%"
        row = conn.execute("SELECT id, confidence, evidence FROM claims WHERE statement LIKE ? "
                           "ORDER BY confidence DESC LIMIT 1", (key,)).fetchone()
    if not row:
        return None
    cid, conf, ev = row
    ev_list = json.loads(ev) + [dict(evidence, contradicts=True)] if isinstance(evidence, dict) else json.loads(ev)
    new_conf = max(0.0, conf - drop)
    status = "retired" if new_conf < 0.15 else "active"
    conn.execute("UPDATE claims SET confidence=?, evidence=?, last_verified=?, status=? WHERE id=?",
                 (round(new_conf, 3), json.dumps(ev_list), when, status, cid))
    conn.commit()
    return {"id": cid, "confidence": round(new_conf, 3), "status": status}


def stale_claims(conn, today, min_conf=0.5, limit=20):
    """High-value beliefs past their decay window — what wants re-verification. The system re-checks
    instead of trusting a 2024 fact forever. `today` is an ISO date string."""
    import datetime as _dt
    t = _dt.date.fromisoformat(today).toordinal()
    out = []
    for cid, stmt, conf, decay, lv in conn.execute(
            "SELECT id, statement, confidence, decay, last_verified FROM claims "
            "WHERE status='active' AND confidence>=? AND last_verified IS NOT NULL", (min_conf,)).fetchall():
        try:
            age = t - _dt.date.fromisoformat(lv[:10]).toordinal()
        except (ValueError, TypeError):
            continue
        if age > DECAY_DAYS.get(decay, 365):
            out.append((age, conf, stmt))
    out.sort(reverse=True)
    return out[:limit]


def upsert(conn, *, type, level, statement, confidence, evidence, decay="slow", when=None):
    """Insert a claim, or MERGE into an existing one (same type+statement): bump confidence toward
    the higher value, union the evidence, refresh last_verified. Beliefs strengthen with corroboration."""
    type = type if type in TYPES else "other"
    level = level if level in LEVELS else "fact"
    # GUARDRAIL (enforced in code, not trusted to the prompt): frame-level beliefs are interpretive and
    # dangerous — hard-cap their confidence so they can never read as asserted fact. The model labeled a
    # frame claim 0.65; clamp it. Frames stay tentative by construction.
    if level == "frame":
        confidence = min(float(confidence), 0.5)
    row = conn.execute("SELECT id, confidence, evidence FROM claims WHERE type=? AND statement=?",
                       (type, statement)).fetchone()
    ev_new = evidence if isinstance(evidence, list) else [evidence]
    if row:
        cid, conf_old, ev_old = row
        ev = {json.dumps(e, sort_keys=True): e for e in (json.loads(ev_old) + ev_new)}  # dedup
        # corroboration nudges confidence up (toward 1), never below the prior
        conf = max(conf_old, confidence, min(1.0, conf_old + 0.1 * len(ev_new)))
        conn.execute("UPDATE claims SET confidence=?, evidence=?, last_verified=? WHERE id=?",
                     (round(conf, 3), json.dumps(list(ev.values())), when, cid))
    else:
        cur = conn.execute(
            "INSERT INTO claims(type,level,statement,confidence,evidence,decay,first_seen,last_verified)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (type, level, statement, round(float(confidence), 3), json.dumps(ev_new), decay, when, when))
        cid = cur.lastrowid
    conn.commit()
    return cid


def upsert_inferred(conn, *, type, level, statement, confidence, method, supporting,
                    kind=None, subkind=None, fire_condition=None, decay="medium", when=None):
    """A HIGHER-ORDER claim derived ACROSS atomics (infer.py). Same lifecycle/dedup as upsert (so the
    user-correction path retires it exactly like any claim), but marked inferred=1 with its provenance:
    `method` (preoccupation|temporal|tension|trajectory|insecurity|negative_space|correlation) and
    `supporting` = the atomic claim ids/text it stands on. Evidence is disconfirmable by construction —
    the supporting ids let a reader (and the viewer's flag/edit UI) see WHY the model inferred it.

    Returns the claim id. Interpretive methods should pass level='frame' (auto-capped ≤0.5, stays tentative);
    a timestamp-grounded regularity passes level='pattern'."""
    type = type if type in TYPES else "frame"
    level = level if level in LEVELS else "frame"
    if level == "frame":
        confidence = min(float(confidence), 0.5)         # the frame guardrail (mirror of upsert)
    ev = [{"kind": "inference", "method": method,
           "supporting_ids": [s.get("id") for s in supporting if isinstance(s, dict)],
           "supporting_text": [(s.get("statement") if isinstance(s, dict) else str(s))[:140]
                               for s in supporting][:8]}]
    fc = json.dumps(fire_condition) if isinstance(fire_condition, (dict, list)) else fire_condition
    row = conn.execute("SELECT id, confidence, evidence FROM claims WHERE type=? AND statement=?",
                       (type, statement)).fetchone()
    if row:
        cid, conf_old, ev_old = row
        conf = max(conf_old, float(confidence))
        merged = json.loads(ev_old) + ev
        conn.execute("UPDATE claims SET confidence=?, evidence=?, last_verified=?, inferred=1, "
                     "kind=COALESCE(?,kind), subkind=COALESCE(?,subkind), fire_condition=COALESCE(?,fire_condition) "
                     "WHERE id=?",
                     (round(conf, 3), json.dumps(merged), when, kind, subkind, fc, cid))
    else:
        cur = conn.execute(
            "INSERT INTO claims(type,level,statement,confidence,evidence,decay,first_seen,last_verified,"
            "inferred,kind,subkind,fire_condition) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)",
            (type, level, statement, round(float(confidence), 3), json.dumps(ev), decay, when, when,
             kind, subkind, fc))
        cid = cur.lastrowid
    conn.commit()
    return cid


def set_actionability(conn, claim_id, kind=None, subkind=None, fire_condition=None):
    """Tag a claim (atomic or inferred) so the proactive engine can consume it. COALESCE keeps any field
    passed None untouched — a re-tag never erases an existing tag it isn't changing."""
    fc = json.dumps(fire_condition) if isinstance(fire_condition, (dict, list)) else fire_condition
    conn.execute("UPDATE claims SET kind=COALESCE(?,kind), subkind=COALESCE(?,subkind), "
                 "fire_condition=COALESCE(?,fire_condition) WHERE id=?", (kind, subkind, fc, claim_id))
    conn.commit()


def mark_surfaced(conn, claim_id, when):
    """A proactive lane just fired on this claim — record it so it never repeats (flag once, then drop)."""
    conn.execute("UPDATE claims SET last_surfaced_at=? WHERE id=?", (when, claim_id))
    conn.commit()


def actionable(conn, kind, *, min_conf=0.0, limit=50):
    """Claims of a given actionability kind, freshest-verified first — the reconciler's per-lane candidate
    pull. Retired + user-superseded rows are excluded (a corrected belief never re-fires)."""
    rows = conn.execute(
        "SELECT id, type, level, statement, confidence, subkind, fire_condition, last_surfaced_at, "
        "first_seen, last_verified, evidence, inferred FROM claims "
        "WHERE kind=? AND confidence>=? AND COALESCE(status,'active')!='retired' "
        "AND id NOT IN (SELECT supersedes FROM claims WHERE supersedes IS NOT NULL) "
        "ORDER BY COALESCE(last_verified, first_seen) DESC, confidence DESC LIMIT ?",
        (kind, min_conf, limit)).fetchall()
    keys = ["id", "type", "level", "statement", "confidence", "subkind", "fire_condition",
            "last_surfaced_at", "first_seen", "last_verified", "evidence", "inferred"]
    return [dict(zip(keys, r)) for r in rows]


def add_relation(conn, src, dst, kind, note="", confidence=0.6, when=None):
    """Edge between two claims. For contradicts: src=value-claim, dst=behavior-claim, note=the (d) line."""
    kind = kind if kind in REL_KINDS else "supports"
    conn.execute(
        "INSERT OR IGNORE INTO relations(src,dst,kind,note,confidence,created) VALUES(?,?,?,?,?,?)",
        (src, dst, kind, note, round(float(confidence), 3), when))
    conn.commit()


def surface_contradiction(conn, when=None):
    """The (d), as a cheap persistent query: the strongest contradiction edge not shown recently.
    Returns the materialized note (what Donna would say) + the two claims behind it, or None."""
    row = conn.execute(
        "SELECT r.id, r.note, r.confidence, v.statement, b.statement "
        "FROM relations r JOIN claims v ON r.src=v.id JOIN claims b ON r.dst=b.id "
        "WHERE r.kind='contradicts' "
        "ORDER BY (r.last_shown IS NOT NULL), r.confidence DESC LIMIT 1").fetchone()
    if not row:
        return None
    rid, note, conf, value, behavior = row
    if when:
        conn.execute("UPDATE relations SET last_shown=? WHERE id=?", (when, rid))
        conn.commit()
    return {"note": note, "confidence": conf, "value": value, "behavior": behavior}


def claims_by_types(conn, types):
    q = ",".join("?" * len(types))
    return conn.execute(
        f"SELECT id, type, statement, confidence FROM claims WHERE type IN ({q}) ORDER BY confidence DESC",
        list(types)).fetchall()


def top_claims(conn, limit=24) -> str:
    """Highest-confidence facts + patterns — the persistent 'what I know about you' for the
    conversation system prompt. Frames excluded here (tentative; surfaced only via recall when relevant)."""
    rows = conn.execute(
        "SELECT statement, type, confidence FROM claims WHERE level IN ('fact','pattern') "
        "AND COALESCE(status,'active')!='retired' ORDER BY confidence DESC LIMIT ?", (limit,)).fetchall()
    return "\n".join(f"- [{c:.0%}] ({t}) {s}" for s, t, c in rows)


def recall(conn, term, limit=8) -> str:
    """Keyword recall across the belief graph — what Donna knows related to `term`. Returns
    statement + confidence + a level tag (frames flagged tentative) + evidence count."""
    like = f"%{term}%"
    rows = conn.execute(
        "SELECT statement, level, confidence, evidence FROM claims "
        "WHERE (statement LIKE ? OR type LIKE ?) AND COALESCE(status,'active')!='retired' "
        "ORDER BY confidence DESC LIMIT ?",
        (like, like, limit)).fetchall()
    if not rows:
        return f"(nothing in the belief graph about '{term}')"
    out = []
    for stmt, level, conf, ev in rows:
        tag = " (tentative)" if level == "frame" else ""
        n = len(json.loads(ev))
        out.append(f"- [{conf:.0%}{tag}] {stmt} ({n} signal{'s' if n != 1 else ''})")
    return "\n".join(out)


def dump_markdown(conn) -> str:
    """The audit interface — what Donna thinks she knows, with the evidence behind each line.
    This is the trust layer (and how you grade the store)."""
    out = ["# Claim store — what Donna believes (auditable)\n"]
    n = conn.execute("SELECT count(*) FROM claims").fetchone()[0]
    out.append(f"_{n} claims_\n")
    for typ in ["possession", "routine", "relationship", "preference", "obligation", "identity", "frame", "other"]:
        rows = conn.execute(
            "SELECT statement, level, confidence, evidence FROM claims WHERE type=? ORDER BY confidence DESC",
            (typ,)).fetchall()
        if not rows:
            continue
        out.append(f"\n## {typ.capitalize()}")
        for stmt, level, conf, ev in rows:
            tag = " ⚠️tentative" if level == "frame" else ""
            evs = json.loads(ev)
            cite = "; ".join(f"{e.get('from','?')[:24]}/{e.get('subject','')[:34]}" for e in evs[:2])
            out.append(f"- [{conf:.0%}{tag}] {stmt}\n    ↳ {len(evs)} signal(s): {cite}")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    conn = connect()
    print(dump_markdown(conn))
