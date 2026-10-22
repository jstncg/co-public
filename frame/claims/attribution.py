#!/usr/bin/env python3
"""ATTRIBUTION — whose life is this claim about? (2026-08-29)

co stored, at 0.95 confidence and with the highest provenance it has:

    "Dan is building a product called 'co-' and positioning themselves as CEO."

Dan Koe is a writer whose article the founder deposited. The founder is the one building co-.
The true claim existed the whole time (27247, 7/2, "User is building a product called 'co-'")
and lost, because it was scored 0.782 and the false one was scored 0.95.

Nothing here was a retrieval bug. The claim was WRITTEN wrong, by taking the member's own act
and pinning it on the name that was loudest in the surrounding context. This is the third time
today the same class has surfaced (the meeting read pulled the member's own name off a calendar
title; aims turned another founder's ambition into his). Containment proves a sentence exists.
It never proves the sentence is ABOUT HIM. Those are separate laws and only the first was ever
enforced on this path.

So: before a claim about the member is written, its SUBJECT must resolve to the member.

The check is deliberately narrow and deterministic, because it gates a write path and an
invariant. It flags exactly one shape: a proper name in the subject slot that identity rejects.
Everything co actually writes about the member reads as "User …", "They …", or a bare predicate
("Values X", "Interested in Y", "Has resumed Z") — none of which trip it. A claim genuinely
about somebody else in the member's life is NOT an error, so the caller decides what a
third-party subject means; this module only reports whose name is in front.

    python3 attribution.py                    # sweep the founder's graph, report only
    python3 attribution.py --db claims_x.db
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# A name in the subject slot is a capitalized word followed by a verb that takes a subject.
# "Dan is building…" trips. "Values depth over breadth" does not: `values` is the verb itself,
# and no verb follows it. The verb list is closed on purpose — an open-ended part-of-speech
# guess would misfire on the bare-predicate style that most member claims are written in.
_SUBJECT = re.compile(
    r"^\s*(?:the\s+)?([A-Z][a-zA-Z]+)(?:'s)?\s+"
    r"(?:is|are|was|were|has|have|had|does|do|did|will|would|can|could|should|"
    r"says?|said|thinks?|thought|wants?|wanted|builds?|built|building|runs?|ran|"
    r"works?|worked|believes?|believed|feels?|felt|prefers?|preferred|likes?|liked|"
    r"needs?|needed|plans?|planned|started|stopped|keeps?|kept|seems?|seemed|"
    r"uses?|used|owns?|owned|lives?|lived|moved|joined|left|sent|sees?|saw)\b")

# Subject words that mean "the member" no matter the tenant. co's extractors write in this
# vocabulary, so these are the common case, not an edge case.
_MEMBER_WORDS = {"user", "member", "they", "he", "she", "them", "his", "her", "their",
                 "the", "this", "that", "someone", "somebody", "one", "you"}

# Words that open a sentence looking exactly like a name and are not one. The first sweep
# flagged "May have a pattern of sharing without follow-through" as a claim about a person
# called May, because a modal in the subject slot is indistinguishable from a name by shape
# alone. A write gate and an invariant both hang off this, so precision wins over recall:
# missing one bad claim costs one bad claim, while a false catch blocks a true one forever.
_NOT_A_NAME = {
    # modals and auxiliaries
    "may", "might", "must", "can", "could", "would", "should", "shall", "will", "does",
    "do", "did", "has", "have", "had", "is", "are", "was", "were", "been", "being",
    # the predicate-first vocabulary co's own extractors write in
    "values", "wants", "believes", "thinks", "feels", "keeps", "uses", "owns", "lives",
    "works", "runs", "builds", "sends", "follows", "enjoys", "prefers", "likes", "needs",
    "plans", "seems", "appears", "tends", "resonates", "finds", "sees", "reads", "shares",
    "treats", "considers", "describes", "expressed", "mentioned", "said", "asked", "noted",
    "started", "stopped", "moved", "joined", "left", "resumed", "engaged", "drawn",
    "interested", "concerned", "frustrated", "excited", "worried", "aware", "prone",
    "currently", "recently", "often", "usually", "always", "never", "sometimes", "still",
}


def subject(statement: str) -> str:
    """The proper name in the subject slot, or "" when the subject is the member or implied."""
    m = _SUBJECT.match(statement or "")
    if not m:
        return ""
    name = m.group(1)
    low = name.lower()
    return "" if low in _MEMBER_WORDS or low in _NOT_A_NAME else name


def foreign_subject(tenant: str, statement: str) -> str:
    """The name this claim is about when that name is NOT the member. "" means it is safe to
    write as a fact about them.

    Fails OPEN on an unresolvable identity: a member whose name co cannot discover must not
    have every claim about them rejected. The cost of a missed catch is one bad claim; the cost
    of a false catch is co silently refusing to learn anything about a new member."""
    name = subject(statement)
    if not name:
        return ""
    try:
        import identity
        if identity.is_me(tenant, name):
            return ""
        if not identity.names(tenant):
            return ""
    except Exception:
        return ""
    return name


def tenant_of(claims_db: str) -> str:
    """claims.db → the founder; claims_<t>.db → <t>. The same mapping the invariants use."""
    base = os.path.basename(claims_db)
    if base == "claims.db":
        return os.environ.get("CO_FOUNDER_TENANT", "dennis")
    return base[7:-3] if base.startswith("claims_") and base.endswith(".db") else ""


def sweep(claims_db: str, limit: int = 0) -> list:
    """Every live claim whose subject is somebody other than the member. Report only."""
    t = tenant_of(claims_db)
    if not t or not os.path.exists(claims_db):
        return []
    conn = sqlite3.connect(f"file:{claims_db}?mode=ro", uri=True)
    rows = conn.execute(
        "SELECT id, statement, confidence, COALESCE(evidence,'') FROM claims "
        "WHERE COALESCE(status,'active')!='retired' "
        "AND COALESCE(evidence,'') NOT LIKE '%\"source\": \"canon\"%'").fetchall()
    conn.close()
    out = []
    for cid, stmt, conf, ev in rows:
        name = foreign_subject(t, stmt or "")
        if name:
            out.append({"id": cid, "who": name, "confidence": conf,
                        "correction": "user_correction" in ev, "statement": stmt})
    out.sort(key=lambda r: (-r["correction"], -(r["confidence"] or 0)))
    return out[:limit] if limit else out


if __name__ == "__main__":
    db = "claims.db"
    if "--db" in sys.argv:
        db = sys.argv[sys.argv.index("--db") + 1]
    db = db if os.path.isabs(db) else os.path.join(os.path.dirname(os.path.abspath(__file__)), db)
    hits = sweep(db)
    print(f"attribution sweep — {os.path.basename(db)} (tenant {tenant_of(db)!r})\n")
    if not hits:
        print("  every live claim has the member as its subject.")
        raise SystemExit
    for h in hits:
        tag = " ⟵ CORRECTION-TIER" if h["correction"] else ""
        print(f"  {h['id']}  [{h['confidence']}]  about {h['who']!r}{tag}")
        print(f"        {str(h['statement'])[:104]}")
    print(f"\n{len(hits)} claim(s) about someone other than the member. Report only — some are "
          f"legitimately about people in their life; the correction-tier ones are not.")
