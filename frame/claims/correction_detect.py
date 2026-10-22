#!/usr/bin/env python3
"""Corrections, caught in conversation — the one memory move nobody else builds.

Every AI remembers what you said. None of them remember what they got WRONG about you.
That is the unoccupied position, and co was already 90% of the way there without knowing:

  * `user_corrections` exists in every per-tenant claims db
  * `correction_ingest.process()` already retires the wrong claim AND writes a tombstone
    ("User explicitly corrected this — it is NOT true that …") so the model cannot casually
    re-infer it from old transcripts
  * the router already calls process() every turn

And it had ZERO rows on every graph on the box, because its only writer was the viewer's
flag/edit UI — and the viewer is dead. So every correction Justin and Dennis ever made
lived in the thread and reached nothing. This is the missing writer.

WHY IT MATTERS (8/6): a member said "no — A7 V, not IV" and co kept the wrong model. Another
said "i'm currently in eastern time" and the timezone was never stored. A friend who repeats
a corrected mistake is worse than one with no memory at all.

SHAPE
  1. a cheap REGEX PRE-FILTER, so a model call only happens on turns that look like a
     correction (most turns are not)
  2. a small model call that decides WHICH claim was wrong and what the truth is — the
     decision is a judgment, not a pattern, which is the lesson of every regex-routing bug
     found this week
  3. a row in user_corrections; the existing processor does the rest

Fails silent and never blocks a reply. Post-reply bookkeeping only.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

MODEL = os.environ.get("CO_CORRECTION_MODEL", "anthropic/claude-haiku-4-5")
MAX_CANDIDATES = 12

# Cheap gate: does this message even LOOK like a correction? Deliberately generous — a false
# positive costs one small model call, a false negative loses the correction forever.
LOOKS_LIKE = re.compile(
    r"(?i)("
    r"\bno[,.\s—-]|\bnope\b|\bnah\b|"
    r"\bnot\s+(that|it|the|this|quite|really|what)\b|"
    r"\bactually\b|\bi\s+meant\b|\bi\s+said\b|"
    r"\bthat'?s\s+(not|wrong|the\s+other)\b|\bwrong\b|\bincorrect\b|"
    r"\bit'?s\s+\S+\s*,?\s*not\s+\S+|"          # "it's V, not IV"
    r"\S+\s+not\s+\S+|"                          # "A7 V, not IV"
    r"\bi'?m\s+(?:\w+\s+){0,2}(in|on|at)\b|"     # "i'm in NY" AND "i'm currently in eastern time"
    r"\bi\s+(moved|switched|quit|left|changed)\b|"
    r"\bstopped\b|\bdon'?t\s+(anymore|any\s+more)\b|\bno\s+longer\b"
    r")")

DECIDE_SYS = """You detect when someone CORRECTS a wrong belief an AI holds about them.

You get: the person's latest message, a little conversation around it, and a numbered list of
beliefs the AI currently holds. Decide whether the message corrects one of those beliefs.

Reply with ONLY one line:
  none
  wrong|<number>
  edit|<number>|<the corrected statement, in the third person, one sentence>

Rules:
- "wrong" = the belief is simply false now. "edit" = there is a specific replacement fact.
- Only pick a belief the message ACTUALLY contradicts. If nothing on the list matches, say none.
- Disagreeing with your opinion is NOT a correction of a belief. Neither is a new topic.
- A changed circumstance ("i moved to austin", "i stopped running") IS a correction.
Be strict. A false correction retires a true belief, which is worse than missing one."""


def _candidates(conn, member_text: str) -> list:
    """Active claims worth checking, keyword-overlapped against the message and recency-backed."""
    words = {w for w in re.findall(r"[a-z0-9]{4,}", (member_text or "").lower())}
    rows = conn.execute(
        "SELECT id, statement FROM claims WHERE COALESCE(status,'active')!='retired' "
        "AND COALESCE(evidence,'') NOT LIKE '%\"source\": \"canon\"%' "
        "AND type!='correction' ORDER BY COALESCE(last_verified,'') DESC LIMIT 400").fetchall()
    scored = []
    for cid, stmt in rows:
        sw = {w for w in re.findall(r"[a-z0-9]{4,}", (stmt or "").lower())}
        overlap = len(words & sw)
        if overlap:
            scored.append((overlap, cid, stmt))
    scored.sort(reverse=True)
    out = [(cid, stmt) for _, cid, stmt in scored[:MAX_CANDIDATES]]
    if not out:                      # nothing lexical — fall back to the freshest few
        out = [(cid, stmt) for cid, stmt in rows[:6]]
    return out


def detect(claims_db: str, member_text: str, context: str = "") -> dict | None:
    """(action, claim_id, text) or None. Never raises."""
    text = (member_text or "").strip()
    if len(text) < 3 or not LOOKS_LIKE.search(text):
        return None
    if not Path(claims_db).exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{claims_db}?mode=ro", uri=True)
        cands = _candidates(conn, text)
        conn.close()
    except sqlite3.Error:
        return None
    if not cands:
        return None

    listing = "\n".join(f"{i+1}. {s}" for i, (_, s) in enumerate(cands))
    try:
        import llm
        out = llm.complete(
            MODEL, DECIDE_SYS,
            f"CONVERSATION:\n{context[-1200:]}\n\nTHEIR LATEST MESSAGE:\n{text}\n\nBELIEFS:\n{listing}",
            max_tokens=120)
    except Exception:
        return None

    line = re.sub(r"</?[a-z_]+>", "", (out or "")).strip().splitlines()[0] if out else ""
    if not line or line.lower().startswith("none"):
        return None
    parts = [p.strip() for p in line.split("|")]
    action = parts[0].lower()
    if action not in ("wrong", "edit") or len(parts) < 2:
        return None
    try:
        idx = int(re.sub(r"\D", "", parts[1])) - 1
        claim_id, statement = cands[idx]
    except (ValueError, IndexError):
        return None
    replacement = parts[2] if action == "edit" and len(parts) > 2 else ""
    if action == "edit" and not replacement:
        action = "wrong"
    # THE REPLACEMENT IS THE MODEL'S SENTENCE, NOT THEIRS (8/29). Asked mid-conversation about
    # Dan Koe what the member had got wrong, this returned "Dan is building a product called
    # 'co-'" — the member's own act, assigned to the author whose piece he had just deposited.
    # Downstream stamped it at correction tier and it outranked the truth for five days.
    # A correction that is not about the member is not a correction: retire the wrong belief
    # (that part was right) and write nothing in its place.
    if action == "edit" and replacement:
        try:
            import attribution
            if attribution.foreign_subject(_tenant_of(claims_db), replacement):
                action, replacement = "wrong", ""
        except Exception:
            pass
    return {"action": action, "claim_id": claim_id, "text": replacement, "was": statement}


def _tenant_of(claims_db: str) -> str:
    try:
        import attribution
        return attribution.tenant_of(claims_db)
    except Exception:
        return ""


def record(claims_db: str, hit: dict) -> bool:
    """Write the row. correction_ingest.process() (already called by the router) does the rest."""
    try:
        conn = sqlite3.connect(claims_db, timeout=10)
        try:      # legacy dbs predate the column
            conn.execute("ALTER TABLE user_corrections ADD COLUMN origin TEXT DEFAULT 'inferred'")
        except sqlite3.OperationalError:
            pass
        conn.execute(
            "INSERT INTO user_corrections(claim_id, action, text, created_at, processed, origin) "
            "VALUES(?,?,?,?,0,'inferred')",
            (hit["claim_id"], hit["action"], hit.get("text") or None,
             dt.datetime.now().isoformat(timespec="seconds")))
        conn.commit()
        conn.close()
        return True
    except sqlite3.Error:
        return False


def scan(claims_db: str, member_text: str, context: str = "") -> str:
    """Router entry point. Returns a log line, or "" when nothing was corrected."""
    try:
        hit = detect(claims_db, member_text, context)
        if not hit:
            return ""
        if not record(claims_db, hit):
            return ""
        return (f"CORRECTION captured ({hit['action']}): claim {hit['claim_id']} "
                f"{hit['was'][:60]!r}" + (f" -> {hit['text'][:60]!r}" if hit.get("text") else ""))
    except Exception:
        return ""


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "claims.db")
    msg = sys.argv[2] if len(sys.argv) > 2 else "no, A7 V not IV"
    print(scan(db, msg) or "(no correction detected)")
