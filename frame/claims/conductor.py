#!/usr/bin/env python3
"""The Conductor — the standing background understanding agent (UNDERSTANDING_AGENT.md P1).

Turns the hand-run instruments (extract_claims / embed / contradictions / claimstore lifecycle) into ONE
self-updating model. Compute-on-delta: cheap SQL detects what changed; the LLM fires ONLY on actual new
data or aged-out beliefs. Each invocation processes the delta-since-last-run and EXITS — launchd re-fires
it (robust: survives crashes/reboots, no leak, state in a watermark file).

The loop (per run):
  1. DELTA (cheap SQL): new emails since the watermark. First run primes the watermark (corpus already
     extracted) — no re-processing 45k emails.
  2. EXTRACT (LLM, only if delta>0): claims from the new batch → embed the new ones (cheap) → advance watermark.
  3. MAINTAIN (threshold-gated): rebuild contradiction edges + dedup once enough has changed.
  4. LIFECYCLE (cheap SQL): stale-belief sweep — surface high-value claims aged past their decay window.
  5. LOG what it did. Idle runs cost ~$0 (all SQL, no LLM).

  doppler run -- /…/python3 conductor.py        # one tick (process delta, maintain, exit)
"""
import json
import sqlite3
import subprocess
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import claimstore  # noqa: E402

SUBSTRATE_DB = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
STATE = Path.home() / ".co_conductor_state.json"
LOG = Path.home() / ".co_conductor.log"
VENV = "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/.venv/bin/python3"
DEDUP_EVERY = 200          # new claims before a re-dedup pass
CONTRADICTIONS_EVERY = 150  # new claims before rebuilding (d) edges
EXTRACT_CAP = 2000          # max emails per tick (bound LLM cost)


def log(msg: str):
    line = f"[{date.today().isoformat()}] {msg}"
    print(line)
    try:
        with LOG.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def state() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text())
        except json.JSONDecodeError:
            pass
    return {"watermark": "", "claims_since_dedup": 0, "claims_since_contra": 0, "primed": False, "last_forensic": ""}


def save(s: dict):
    STATE.write_text(json.dumps(s, indent=2))


def latest_email_ts() -> str:
    c = sqlite3.connect(SUBSTRATE_DB, uri=True)
    r = c.execute("SELECT MAX(ts) FROM communications WHERE channel='gmail' AND direction='received'").fetchone()
    return r[0] or ""


def count_new(watermark: str) -> int:
    c = sqlite3.connect(SUBSTRATE_DB, uri=True)
    return c.execute(
        "SELECT COUNT(*) FROM communications WHERE channel='gmail' AND direction='received' AND ts > ?",
        (watermark,)).fetchone()[0]


def run_instrument(name: str, args: list) -> bool:
    """Shell an instrument; the Conductor owns the WHEN, the scripts own the HOW. They degrade on
    rate-limit/errors internally, so a failure here is non-fatal — log and continue."""
    try:
        r = subprocess.run([VENV, str(HERE / name)] + args, capture_output=True, text=True, timeout=1800)
        ok = r.returncode == 0
        tail = (r.stdout or r.stderr or "").strip().splitlines()[-1:] or [""]
        log(f"  {'✓' if ok else '⚠️'} {name} {' '.join(args)} → {tail[0][:90]}")
        return ok
    except Exception as e:
        log(f"  ⚠️ {name} failed: {e}")
        return False


def active_claims() -> int:
    try:
        return claimstore.connect().execute(
            "SELECT COUNT(*) FROM claims WHERE COALESCE(status,'active')!='retired'").fetchone()[0]
    except Exception:
        return 0


def main():
    s = state()
    latest = latest_email_ts()
    log("— conductor tick —")

    # 1. DELTA (cheap SQL)
    if not s.get("primed"):
        # corpus already extracted (6k+ claims) — prime the watermark, don't re-process 45k emails
        s["watermark"] = latest
        s["primed"] = True
        save(s)
        log(f"  primed watermark at {latest[:10]} (corpus already extracted; conductor now tracks deltas)")
    new = count_new(s["watermark"])
    log(f"  delta: {new} new emails since {s['watermark'][:10] or 'epoch'}")

    # 2. EXTRACT (LLM — only on real delta)
    if new > 0:
        before = active_claims()
        if run_instrument("extract_claims.py", [str(min(new + 25, EXTRACT_CAP))]):  # buffer for thread context
            run_instrument("embed.py", [])  # embeds only un-embedded (cheap)
            added = max(0, active_claims() - before)
            s["watermark"] = latest
            s["claims_since_dedup"] += added
            s["claims_since_contra"] += added
            log(f"  extracted ~{added} net new claims")
        save(s)
    else:
        log("  no new email — idle tick (no LLM)")

    # 2b. FORENSIC (deterministic aggregates over structured data incl. the 654k iMessages — cheap, no LLM).
    #     Recomputes circadian / tie-graph / latency / engagement, then EMBEDS (claims are invisible to recall
    #     until embedded — the wiring lesson). Aggregates move slowly → daily cadence is plenty.
    if s.get("last_forensic") != date.today().isoformat():
        if run_instrument("forensic.py", []):
            run_instrument("embed.py", [])   # MUST embed forensic claims or recall_semantic can't see them
            s["last_forensic"] = date.today().isoformat()
            save(s)

    # 3. MAINTAIN (threshold-gated — don't rebuild every tick)
    if s["claims_since_dedup"] >= DEDUP_EVERY:
        if run_instrument("embed.py", ["dedup"]):
            s["claims_since_dedup"] = 0
            save(s)
    if s["claims_since_contra"] >= CONTRADICTIONS_EVERY:
        if run_instrument("contradictions.py", []):
            s["claims_since_contra"] = 0
            save(s)

    # 4. SALIENCE (cheap, deterministic, no LLM): re-rank what DEFINES the user every tick, so the carried
    #    core reads by salience not confidence. Also flag how much of the top core is still ungraded (the
    #    subject-as-grader backlog — high-salience claims the human hasn't confirmed/retired yet).
    try:
        import salience as _sal
        import calibrate_confidence as _cc
        import datetime as _dt
        conn = claimstore.connect()
        # E3: confidence = f(evidence), not LLM vibe — recompute each tick so it stays honest as evidence accrues
        _to = _dt.date.today().toordinal()
        for cid, _o, lvl, ev, g, lv in conn.execute("SELECT id,confidence,level,evidence,graded,last_verified FROM claims WHERE COALESCE(status,'active')!='retired'").fetchall():
            conn.execute("UPDATE claims SET confidence=? WHERE id=?", (_cc.evidence_confidence(ev, lvl, g, lv, _to), cid))
        conn.commit()
        _sal.recompute(conn)
        ungraded = conn.execute(
            "SELECT COUNT(*) FROM claims WHERE COALESCE(status,'active')!='retired' AND graded IS NULL "
            "AND salience >= 0.8").fetchone()[0]
        if ungraded:
            log(f"  salience: re-ranked · {ungraded} high-salience claims ungraded → run grade.py to confirm the core")
    except Exception as e:
        log(f"  ⚠️ salience recompute: {e}")

    # 5. LIFECYCLE (cheap SQL): stale high-value beliefs past their decay window
    try:
        stale = claimstore.stale_claims(claimstore.connect(), date.today().isoformat(), min_conf=0.6, limit=10)
        if stale:
            log(f"  lifecycle: {len(stale)} high-value beliefs stale (oldest {stale[0][0]}d) — flag for re-verify")
            for age, conf, stmt in stale[:3]:
                log(f"      [{conf:.0%}, {age}d] {stmt[:60]}")
        else:
            log("  lifecycle: no stale high-value beliefs")
    except Exception as e:
        log(f"  ⚠️ lifecycle sweep: {e}")

    # 6. PREDICTION LOOP (E9): the engine commits falsifiable predictions; BEHAVIOR (substrate.db deltas)
    #    resolves them — NOT the conversation or the user's verdict (that would be circular sycophancy).
    #    Behavior-resolved predictions are self-earned LABELS → live calibration with no human in the loop.
    try:
        import predict as _pred
        import asyncio as _aio
        pc = _pred.db()
        if s.get("last_predict") != date.today().isoformat()[:7] + ("-W%d" % (date.today().isocalendar()[1])):
            # emit a fresh batch weekly (LLM)
            n = _aio.run(_pred.emit(pc))
            s["last_predict"] = date.today().isoformat()[:7] + ("-W%d" % (date.today().isocalendar()[1]))
            save(s)
            log(f"  prediction: emitted {n} falsifiable predictions (reality will grade → calibration)")
        # resolve the due ones from OBSERVED BEHAVIOR every tick — the non-circular oracle, no asking
        if _pred.pending(pc, due_only=True):
            r = _aio.run(_pred.auto_resolve(pc))
            log(f"  prediction: behavior-resolved {r['right']}✓/{r['wrong']}✗, {r['unresolvable']} abstained, "
                f"{r['still_open']} awaiting signal (graded by substrate behavior, never a verdict)")
        cal = _pred.calibration(pc)
        if cal:
            log(f"  LIVE CALIBRATION (self-earned): ECE {cal['ece']} · overconf {cal['overconfidence']:+} · "
                f"confident-wrong {cal['confident_wrong']}/{cal['n']} · acc {cal['accuracy']}")
    except Exception as e:
        log(f"  ⚠️ prediction loop: {e}")

    log(f"  state: {active_claims()} active claims · watermark {s['watermark'][:10]}")


if __name__ == "__main__":
    main()
