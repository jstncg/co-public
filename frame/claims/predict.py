#!/usr/bin/env python3
"""E9 — the prediction loop. The only non-circular ground truth for a person is PREDICTION: the engine commits
falsifiable claims about the user's near future, REALITY settles them, and resolved predictions become LABELS
that calibrate the engine — with no manual grading.

THE RESOLUTION ORACLE IS BEHAVIOR, NOT THE USER'S VERDICT. This is load-bearing and was the bug that hollowed
the moat: if a prediction is resolved by the user confirming it (or by the model judging its own plausible
story), then a smarter model just produces more *seductive* bets the user ratifies — calibration climbs while
real accuracy doesn't, and "the smarter model wasn't there" becomes a slogan. So resolution is wired ONLY to
exogenous behavioral evidence in substrate.db (sent/received email deltas, purchases/cancellations, calendar,
commitments, forensic anomalies). No human in the loop. The judge ABSTAINS by default ('unresolved') and only
emits a label when observed behavior genuinely settles the criterion — better to earn nothing than to earn a
flattered label. Calibration is computed over behavior-resolved predictions ONLY (manual overrides excluded).

The loop (one tick of it):
  emit()         → from the model's beliefs, generate falsifiable, BEHAVIORALLY-CHECKABLE predictions w/ honest confidence
  pending()      → open predictions (context for reach-out — but the conversation NEVER resolves them)
  auto_resolve() → reality settles the due ones from substrate.db behavior → self-earned LABELS (no verdict, no asking)
  calibration()  → ECE / Brier / confident-wrong over BEHAVIOR-resolved predictions = the live, self-earned calibration

  doppler run -- /…/python3 predict.py --emit            # generate predictions from the current model
  doppler run -- /…/python3 predict.py --auto-resolve     # settle due predictions from observed behavior (the real loop)
  /…/python3 predict.py --status                          # open + the live (behavior-earned) calibration
  /…/python3 predict.py --resolve <id> right|wrong "note" # MANUAL DEV OVERRIDE ONLY — excluded from calibration
"""
import asyncio
import json
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore

# The behavioral source of truth — read-only. Predictions resolve against what the person actually DID here,
# never against what they (or the model) say. If it's missing, predictions stay open rather than get a verdict.
SUBSTRATE_DB = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"

SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY,
    statement TEXT NOT NULL,        -- the falsifiable prediction
    confidence REAL NOT NULL,       -- the engine's confidence (the thing being calibrated)
    criterion TEXT,                 -- the BEHAVIORAL observation that resolves it (no self-report)
    basis TEXT,                     -- the belief it's derived from
    horizon_days INTEGER,
    created TEXT, resolve_by TEXT,
    status TEXT DEFAULT 'open',     -- open | right | wrong | unresolvable
    resolved_at TEXT, note TEXT,
    source TEXT,                    -- how it was resolved: 'behavior' (counts toward calibration) | 'manual' (override, excluded)
    UNIQUE(statement)
);"""

GRACE_DAYS = 14   # how long past resolve_by to keep waiting for behavioral signal before marking 'unresolvable'


def db():
    conn = claimstore.connect()
    conn.executescript(SCHEMA)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(predictions)").fetchall()}
    if "source" not in cols:   # migration for stores created before behavior-graded resolution
        conn.execute("ALTER TABLE predictions ADD COLUMN source TEXT")
        conn.commit()
    return conn


EMIT_SYS = """From these grounded beliefs about a person, generate FALSIFIABLE predictions about their near
future — the kind REALITY settles from their behavior, so they can grade the engine's calibration.

Rules:
- Each prediction MUST be resolvable from OBSERVABLE BEHAVIORAL TRACES alone — things visible in their digital
  exhaust without ever asking them: who they email and how fast, what they buy or cancel, what they book, what
  they ship vs abandon, whether a commitment gets done. The resolution can NEVER depend on the person's opinion
  or self-report (that path is forbidden; it's circular). Bad: "he values growth" / "he'll say he feels stuck."
  Good: "he won't send the investor email he drafted — it'll sit unsent past Friday" / "he'll make a comfort
  purchase (Turo/travel/gear) within 10 days of going quiet on the main project."
- confidence = your HONEST confidence (0-1). We are TESTING whether it's calibrated — do NOT inflate. Mix
  high- and low-confidence predictions, and prefer ones that, if wrong, teach us something real.
- criterion = the EXACT behavioral observation that makes it true vs false (name the trace: a sent/unsent
  email, a charge, a booking, a commitment status, a drop in contact). horizon in days.
- Ground each in one belief (basis).
Return ONLY JSON: {"predictions":[{"statement","confidence","criterion","basis","horizon_days"}]}"""


def _model_context(conn):
    ctx = []
    for stmt, conf in conn.execute(
        "SELECT statement, confidence FROM claims WHERE COALESCE(status,'active')!='retired' "
        "AND level IN ('pattern','frame') ORDER BY COALESCE(salience,0.4) DESC LIMIT 22").fetchall():
        ctx.append(f"[{conf:.0%}] {stmt}")
    return ctx


async def emit(conn, n=6):
    from anthro import make_client
    client = make_client()
    ctx = _model_context(conn)
    if not ctx:
        return 0
    r = await client.messages.create(model="claude-sonnet-4-6", system=EMIT_SYS, max_tokens=1500,
        messages=[{"role": "user", "content": "BELIEFS:\n" + "\n".join(ctx) + f"\n\nGenerate ~{n} falsifiable predictions."}])
    txt = "".join(b.text for b in r.content if b.type == "text")
    m = re.search(r"\{.*\}", txt, re.S)
    preds = json.loads(m.group(0)).get("predictions", []) if m else []
    today = date.today().isoformat()
    for p in preds:
        h = int(p.get("horizon_days", 14) or 14)
        try:
            conn.execute("INSERT OR IGNORE INTO predictions(statement,confidence,criterion,basis,horizon_days,created,resolve_by) "
                         "VALUES(?,?,?,?,?,?,?)",
                         ((p.get("statement") or "").strip(), float(p.get("confidence", 0.5)), p.get("criterion", ""),
                          p.get("basis", ""), h, today, (date.today() + timedelta(days=h)).isoformat()))
        except Exception:
            pass
    conn.commit()
    return len(preds)


def pending(conn, due_only=False):
    q = "SELECT id, statement, confidence, resolve_by FROM predictions WHERE status='open'"
    if due_only:
        q += f" AND resolve_by <= '{date.today().isoformat()}'"
    return conn.execute(q + " ORDER BY resolve_by").fetchall()


# ----------------------------- behavioral resolution (the real loop) -----------------------------

def behavioral_evidence(since: str, until: str = None) -> str:
    """The exogenous behavioral delta from substrate.db over [since, until] — what the person actually DID.
    Metadata-first, bounded, every query guarded (schema drift / empty store must degrade, not crash).
    This is the ONLY input to resolution: no self-report, no conversation, no model-of-its-own-story."""
    until = until or date.today().isoformat()
    out = []
    try:
        sub = sqlite3.connect(SUBSTRATE_DB, uri=True)
    except Exception as e:
        return f"(no behavioral store available: {e})"

    def q(sql, params=()):
        try:
            return sub.execute(sql, params).fetchall()
        except Exception:
            return []

    # communications activity by direction (who they engaged, and the volume — the behavioral pulse)
    comms = q("SELECT direction, COUNT(*) FROM communications WHERE ts >= ? AND ts < ? GROUP BY direction", (since, until + "T99"))
    if comms:
        out.append("COMMS in window: " + ", ".join(f"{d or '?'}={n}" for d, n in comms))
    # notable subjects of SENT mail (revealed action — what they actually pushed out)
    sent = q("SELECT subject FROM communications WHERE ts >= ? AND ts < ? AND direction='sent' "
             "AND COALESCE(subject,'')!='' ORDER BY ts DESC LIMIT 12", (since, until + "T99"))
    if sent:
        out.append("SENT subjects: " + " | ".join((s or "")[:60] for (s,) in sent))
    # money behavior — purchases / cancellations / new recurring charges (comfort-buy + churn signal)
    charges = q("SELECT merchant, direction, amount_usd, raw_subject FROM recurring_charges "
                "WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 15", (since, until + "T99"))
    if charges:
        out.append("CHARGES: " + " | ".join(f"{m or '?'} {d or ''} {('$'+str(a)) if a else ''} {(rs or '')[:40]}".strip()
                                             for m, d, a, rs in charges))
    # life events detected from behavior
    events = q("SELECT kind, detail, detected_at FROM life_events WHERE detected_at >= ? AND detected_at < ? "
               "ORDER BY detected_at DESC LIMIT 10", (since, until + "T99"))
    if events:
        out.append("LIFE EVENTS: " + " | ".join(f"{k}: {(d or '')[:60]}" for k, d, _ in events))
    # commitments and whether they got DONE (follow-through, the (d) made measurable)
    commits = q("SELECT action_text, status, due_date FROM commitments WHERE COALESCE(due_date,'') >= ? "
                "AND COALESCE(due_date,'') < ? ORDER BY due_date DESC LIMIT 12", (since, until + "T99"))
    if commits:
        out.append("COMMITMENTS (due in window): " + " | ".join(f"[{st or '?'}] {(a or '')[:50]}" for a, st, _ in commits))
    # forensic anomalies surfaced in window (baseline-normalized behavioral deltas)
    anoms = q("SELECT kind, observation FROM anomalies WHERE surfaced_at >= ? AND surfaced_at < ? LIMIT 8",
              (since, until + "T99"))
    if anoms:
        out.append("ANOMALIES: " + " | ".join(f"{k}: {(o or '')[:60]}" for k, o in anoms))
    # newly-added subscriptions in window (started-using-X behavior)
    subs = q("SELECT sender_name, topic_category FROM subscriptions WHERE first_seen >= ? AND first_seen < ? LIMIT 10",
             (since, until + "T99"))
    if subs:
        out.append("NEW SUBSCRIPTIONS: " + " | ".join(f"{n or '?'} ({c or '?'})" for n, c in subs))
    sub.close()
    return "\n".join(out) if out else "(no behavioral activity recorded in the window)"


JUDGE_SYS = """You resolve a falsifiable prediction about a person using ONLY the observed BEHAVIORAL evidence
provided (sent/received email, purchases, life events, commitment status, anomalies). You are FORBIDDEN from
using the person's stated opinion, self-report, or any plausible story — only what they demonstrably DID.

Decide the verdict:
- "right"      — the observed behavior CLEARLY confirms the prediction's criterion.
- "wrong"      — the observed behavior CLEARLY contradicts it.
- "unresolved" — the behavioral evidence in this window does NOT settle it (this is the DEFAULT).

Bias hard toward "unresolved". It is far better to earn no label than to confirm a plausible-but-unproven
story — a flattered label is worse than no label, because it corrupts the calibration this exists to measure.
Resolve only when the behavior genuinely settles the criterion. Return ONLY JSON: {"verdict","rationale"}."""


async def _judge(client, statement, criterion, evidence):
    r = await client.messages.create(
        model="claude-sonnet-4-6", system=JUDGE_SYS, max_tokens=350,
        messages=[{"role": "user", "content":
                   f"PREDICTION: {statement}\nRESOLUTION CRITERION (behavioral): {criterion}\n\n"
                   f"OBSERVED BEHAVIOR IN WINDOW (the ONLY admissible evidence):\n{evidence}\n\n"
                   "Verdict?"}])
    txt = "".join(b.text for b in r.content if b.type == "text")
    m = re.search(r"\{.*\}", txt, re.S)
    try:
        d = json.loads(m.group(0)) if m else {}
    except Exception:
        d = {}
    v = (d.get("verdict") or "unresolved").strip().lower()
    if v not in ("right", "wrong", "unresolved"):
        v = "unresolved"
    return v, (d.get("rationale") or "")[:300]


async def auto_resolve(conn, grace_days=GRACE_DAYS):
    """Settle DUE predictions from observed behavior (substrate.db) — the real, non-circular resolution path.
    No verdict is taken from the user or the conversation. Predictions with no behavioral signal stay open
    until grace_days past their horizon, then become 'unresolvable' (an honest non-label), never a guess.
    Returns {resolved, right, wrong, unresolvable, still_open}."""
    due = pending(conn, due_only=True)
    if not due:
        return {"resolved": 0, "right": 0, "wrong": 0, "unresolvable": 0, "still_open": 0}
    from anthro import make_client
    client = make_client()
    today = date.today()
    stats = {"resolved": 0, "right": 0, "wrong": 0, "unresolvable": 0, "still_open": 0}
    for pid, statement, conf, resolve_by in due:
        row = conn.execute("SELECT created, criterion FROM predictions WHERE id=?", (pid,)).fetchone()
        created, criterion = (row[0], row[1]) if row else (None, "")
        evidence = behavioral_evidence(created or (today - timedelta(days=30)).isoformat())
        try:
            verdict, rationale = await _judge(client, statement, criterion or statement, evidence)
        except Exception as e:
            verdict, rationale = "unresolved", f"(judge error: {e})"
        if verdict in ("right", "wrong"):
            resolve(conn, pid, verdict, note=f"auto·behavior: {rationale}", source="behavior")
            stats["resolved"] += 1
            stats[verdict] += 1
        else:
            overdue = (today - datetime.fromisoformat(resolve_by).date()).days if resolve_by else 0
            if overdue > grace_days:   # behavior never settled it → honest non-label, excluded from calibration
                resolve(conn, pid, "unresolvable", note="no behavioral signal in window (abstained)", source="behavior")
                stats["unresolvable"] += 1
            else:
                stats["still_open"] += 1   # give reality more time
    return stats


def resolve(conn, pid, outcome, note="", source="manual"):
    """Write a resolution. source='behavior' = earned from observed behavior (counts toward calibration);
    source='manual' = a dev/CLI override (EXCLUDED from calibration so a human poke can't fake the number)."""
    conn.execute("UPDATE predictions SET status=?, resolved_at=?, note=?, source=? WHERE id=?",
                 (outcome, date.today().isoformat(), note, source, pid))
    conn.commit()


def calibration(conn):
    """The live, self-earned calibration — ECE + Brier + confident-wrong over BEHAVIOR-resolved predictions ONLY.
    Manual overrides are excluded by construction: the number can only be moved by reality, never by a verdict."""
    rows = conn.execute("SELECT confidence, status FROM predictions "
                        "WHERE status IN ('right','wrong') AND COALESCE(source,'')='behavior'").fetchall()
    if not rows:
        return None
    pairs = [(c, 1.0 if s == "right" else 0.0) for c, s in rows]
    n = len(pairs)
    brier = sum((c - o) ** 2 for c, o in pairs) / n
    over = sum(c - o for c, o in pairs) / n
    cw = sum(1 for c, o in pairs if c >= 0.7 and o == 0.0)
    # adaptive-bin ECE
    p = sorted(pairs); ece = 0.0
    for b in range(min(4, n)):
        lo, hi = b * n // 4, (b + 1) * n // 4
        ch = p[lo:hi]
        if ch:
            ece += len(ch) / n * abs(sum(c for c, _ in ch) / len(ch) - sum(o for _, o in ch) / len(ch))
    return {"n": n, "brier": round(brier, 3), "ece": round(ece, 3), "overconfidence": round(over, 3),
            "confident_wrong": cw, "accuracy": round(sum(o for _, o in pairs) / n, 2)}


def main():
    conn = db()
    if "--emit" in sys.argv:
        print(f"emitted {asyncio.run(emit(conn))} predictions (open, awaiting reality)")
    elif "--auto-resolve" in sys.argv:
        stats = asyncio.run(auto_resolve(conn))
        print(f"auto-resolve (behavior-graded): {stats}")
    elif "--resolve" in sys.argv:
        i = sys.argv.index("--resolve")
        resolve(conn, int(sys.argv[i + 1]), sys.argv[i + 2],
                " ".join(sys.argv[i + 3:]) if len(sys.argv) > i + 3 else "", source="manual")
        print("resolved (MANUAL override — excluded from calibration).")
    print("\nOPEN predictions:")
    for pid, stmt, conf, by in pending(conn):
        print(f"  #{pid} [{conf:.0%}, by {by}] {stmt[:74]}")
    cal = calibration(conn)
    print("\nLIVE CALIBRATION (behavior-resolved labels only — never a verdict):")
    print(f"  {cal}" if cal else "  (none behavior-resolved yet — calibration earns itself as reality settles predictions)")


if __name__ == "__main__":
    main()
