#!/usr/bin/env python3
"""Two-tier claims — the INFERENCE pass (Phase 1 of the proactive-witness build).

The extractor (extract_claims.py) writes ATOMIC claims: one email, one send, one fact. This runs
periodically OVER a tenant's atomics and the send stream to derive HIGHER-ORDER claims — the third-person
read the person would NOT self-report:

  preoccupation    recurring themes across many sends ("keeps circling how groups form beliefs")
  temporal         behavior over time from send timestamps ("sends escape-content late at night")   [deterministic]
  tension          says X but does/sends Y — a value-claim vs a behavior-claim
  trajectory       from supersede chains — "was A, now B" = how they're changing                     [deterministic detect]
  insecurity       the deep recurring worry — LOW confidence, max care, NEVER surfaced bluntly
  negative_space   what they conspicuously DON'T send / say (the third-person-observer value)
  correlation      time-of-day / mood → behavior (the non-obvious hunt)                              [deterministic + LLM]

Each derived claim is stored inferred=1 with its supporting atomic-claim ids/text as evidence, a confidence,
and it is disconfirmable/correctable through the SAME user_corrections path as any claim (retire by id).
Interpretive derivations are level='frame' (auto-capped ≤0.5, stay tentative); the timestamp-grounded
temporal ones are level='pattern'.

ACTIONABILITY: after deriving, tag_actionability() stamps every actionable claim (atomic or inferred) with
the `kind` the proactive engine consumes (open_loop | conviction[+consequentialist|sacred] | interest |
insecurity | pattern), a `fire_condition`, so the reconciler can pull candidates by lane.

Model: cheap background model via CO_INFER_MODEL (falls back through llm.phrase_specs() → haiku). One
structured synthesis call over a bounded evidence pack; the deterministic derivations use no model at all.

  set -a; source ../.env; set +a
  python3 infer.py                       # run for the founder tenant (dennis), print what it derived
  python3 infer.py --tenant X            # another tenant's graph
  python3 infer.py --tag-only            # just (re)tag actionability, no new derivations
  python3 infer.py --dry                 # derive + print, write NOTHING
"""
import datetime as dt
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import claimstore  # noqa: E402

# ── selection knobs (bounded so a 9k-claim graph costs one cheap call, not thousands) ────────────────
MAX_BEHAVIORAL = 45       # behavioral/value/identity claims fed to the synthesis
MAX_INTERESTS = 20
MAX_TRAJECTORY = 8        # supersede-chain deltas
SENDS_WINDOW_DAYS = 60

# Behavioral / value / identity is where higher-order reads live; a transaction log ("owns an Apple Watch")
# is not. This lexicon selects the substrate the synthesis reasons over.
BEHAVIORAL = re.compile(
    r"\b(avoid|delay|procrastin|comfort|status|impress|founder|identity|becoming|chasing|fear|flinch|"
    r"burnout|overwhelm|wants? to|driven by|struggles?|tends? to|keeps?|instead of|hype|ship|launch|"
    r"first[- ]principles|belief|values?|optimiz|escape|quit|prove|seen as|party trick|comfort)\b", re.I)

INTERESTY = re.compile(
    r"\b(interested in|reading|drawn to|circling|curious|following|obsess|fascinat|explor|studies?|"
    r"into |learning|watches|book|essay|anthropolog|thesis)\b", re.I)

# ── actionability lexicons (deterministic first pass; the synthesis refines convictions) ─────────────
# An OPEN LOOP is a CONCRETE, completable action (often dated) — a to-do, not a life-drive. It must carry
# an action verb or a deadline; "wants to be seen as a founder" is a value/conviction, NOT an open loop
# (the difference between accountability and bubble-pop, and the reactance risk lives here).
OPEN_LOOP = re.compile(
    r"\b(submit|apply(ing)?|file|send|return|reimburs|finish|ship|film|renew|schedule|book|pay|deliver|"
    r"reply to|respond to|sign up|register|cancel|complete|plans? to \w+|committed to \w+|said (he|she|they)'?d|"
    r"deadline|due (by|on|date)|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of|next))\b", re.I)
# A CONVICTION is a STANCE / BELIEF you could examine — not a biographical fact. "driven by status",
# "hates being uncomfortable", "wants to be seen as a founder" qualify; "works in software", "name is
# Dennis", "maintains a GitHub repo" do NOT (the model rightly abstains on those — nothing to open).
CONVICTION = re.compile(
    r"\b(believes?|thinks? (that|the)|driven by|motivated by|values? |convinced|wants? to be seen|"
    r"wants? to be (a |an |the )|first[- ]principles|philosophy|worldview|hates? being|optimizes? for|"
    r"cares (more )?about|prioritizes?|would rather|sees .{2,30} as)\b", re.I)
# Biographical / role / logistics descriptions — an identity FACT, never a conviction to contest.
BIOGRAPHICAL = re.compile(
    r"\b(works? in|working in|pursuing|maintain(s|ing)|active .{0,20}(developer|engineer)|located|name is|"
    r"goes by|email|username|handle|phone|receives?|subscrib|has (a |an )?(account|status|loan|obligation)|"
    r"uses github|repositor|career in|role\b|attends|lives in|member of)\b", re.I)
# sacred = identity / faith / family / core relationships — witness these, NEVER contest.
SACRED = re.compile(
    r"\b(church|faith|god|christ|tabernacle|family|mom|dad|mother|father|sister|brother|"
    r"girlfriend|wife|husband|marriage|kids\b|children|religio|spiritual|core value)\b", re.I)


def _tenant_db(tenant: str) -> Path:
    t = re.sub(r"[^a-z0-9_+\-]", "_", (tenant or "dennis").strip().lower()) or "dennis"
    return HERE / ("claims.db" if t == "dennis" else f"claims_{t}.db")


# ─────────────────────────── the evidence pack (deterministic gather) ───────────────────────────
def _rows(conn, where, args=(), limit=60):
    q = ("SELECT id, type, level, statement, confidence, COALESCE(salience,0.3) sal, "
         "first_seen, last_verified, evidence FROM claims WHERE COALESCE(status,'active')!='retired' "
         "AND id NOT IN (SELECT supersedes FROM claims WHERE supersedes IS NOT NULL) " + where +
         " ORDER BY sal DESC, confidence DESC LIMIT ?")
    keys = ["id", "type", "level", "statement", "confidence", "salience", "first_seen", "last_verified", "evidence"]
    return [dict(zip(keys, r)) for r in conn.execute(q, tuple(args) + (limit,)).fetchall()]


def behavioral_claims(conn, limit=MAX_BEHAVIORAL):
    rows = _rows(conn, "AND (type IN ('value','identity','obligation') OR level IN ('pattern','frame'))",
                 limit=limit * 4)
    out = [r for r in rows if BEHAVIORAL.search(r["statement"])]
    return out[:limit] or rows[:limit]


def interest_claims(conn, limit=MAX_INTERESTS):
    rows = _rows(conn, "AND (type='preference' OR level='pattern')", limit=limit * 5)
    return [r for r in rows if INTERESTY.search(r["statement"])][:limit]


def trajectory_deltas(conn, limit=MAX_TRAJECTORY):
    """Supersede chains where a value/identity/goal belief CHANGED — 'was A, now B'. The old row is the
    superseded one; the new row supersedes it. Only meaningfully-different pairs (not a rephrase)."""
    rows = conn.execute(
        "SELECT new.id, old.statement, new.statement, new.last_verified FROM claims new "
        "JOIN claims old ON new.supersedes = old.id "
        "WHERE new.supersedes IS NOT NULL AND COALESCE(new.status,'active')!='retired' "
        "AND new.type IN ('value','identity','preference','frame') "
        "ORDER BY new.last_verified DESC LIMIT 200").fetchall()
    out = []
    for nid, old_s, new_s, when in rows:
        a, b = (old_s or "").strip(), (new_s or "").strip()
        if not a or not b or a.lower() == b.lower():
            continue
        # skip near-identical rephrasings (high word overlap = not a real change)
        aw, bw = set(re.findall(r"[a-z]{4,}", a.lower())), set(re.findall(r"[a-z]{4,}", b.lower()))
        if aw and bw and len(aw & bw) / min(len(aw), len(bw)) > 0.75:
            continue
        out.append({"id": nid, "from": a[:120], "to": b[:120], "when": when})
        if len(out) >= limit:
            break
    return out


def send_stream(memory_path: str, days=SENDS_WINDOW_DAYS):
    """The raw send stream with timestamps + themes — the substrate for temporal patterns and negative
    space. co_react writes co_sends per tenant; this reads it read-only."""
    if not Path(memory_path).exists():
        return []
    try:
        c = sqlite3.connect(f"file:{memory_path}?mode=ro", uri=True)
        cutoff = (dt.datetime.now() - dt.timedelta(days=days)).isoformat()
        rows = c.execute("SELECT ts, send, tier, theme FROM co_sends WHERE ts>=? AND send IS NOT NULL "
                         "ORDER BY ts", (cutoff,)).fetchall()
        c.close()
        return [{"ts": r[0], "send": r[1], "tier": r[2], "theme": r[3]} for r in rows]
    except Exception:
        return []


# ─────────────────────────── deterministic derivations ───────────────────────────
def _hour(ts: str):
    try:
        return dt.datetime.fromisoformat(ts).hour
    except (ValueError, TypeError):
        return None


ESCAPE_THEMES = {"quitting", "founder-identity"}


def derive_temporal(sends: list) -> list:
    """Timestamp-grounded behavioral regularities (pattern-level — deterministic evidence, not a vibe).
    Returns [{statement, confidence, method, supporting_text}]. Needs enough sends to mean anything."""
    n = len(sends)
    if n < 12:
        return []
    hours = [h for h in (_hour(s["ts"]) for s in sends) if h is not None]
    if len(hours) < 12:
        return []
    out = []
    buckets = {"early (5-9am)": (5, 9), "morning (9-12)": (9, 12), "afternoon (12-17)": (12, 17),
               "evening (17-21)": (17, 21), "late night (21-5)": None}
    def in_late(h):
        return h >= 21 or h < 5
    counts = Counter()
    for h in hours:
        for label, rng in buckets.items():
            if rng is None:
                if in_late(h):
                    counts[label] += 1
            elif rng[0] <= h < rng[1]:
                counts[label] += 1
    top_label, top_n = counts.most_common(1)[0]
    frac = top_n / len(hours)
    if frac >= 0.33:
        out.append({"statement": f"Sends most in the {top_label.split(' (')[0]} — {top_n} of "
                                 f"{len(hours)} recent sends land there",
                    "confidence": round(min(0.8, 0.45 + frac), 2), "method": "temporal",
                    "supporting_text": [f"{len(hours)} timestamped sends, {int(frac*100)}% in {top_label}"]})
    # late-night ESCAPE skew — the non-obvious correlation (mood-window → content type)
    late = [s for s in sends if (_hour(s["ts"]) is not None and in_late(_hour(s["ts"])))]
    if len(late) >= 6:
        esc = sum(1 for s in late if (s.get("theme") in ESCAPE_THEMES))
        if esc and esc / len(late) >= 0.34:
            out.append({"statement": "Late-night sends skew toward escape/quitting content — the after-dark "
                                    "window is where the 'leave it all' thoughts surface",
                        "confidence": round(min(0.5, 0.3 + esc / len(late)), 2), "method": "correlation",
                        "supporting_text": [f"{esc}/{len(late)} late-night sends themed escape/quitting"]})
    return out


def derive_trajectory(deltas: list) -> list:
    out = []
    for d in deltas:
        out.append({"id_hint": d["id"], "statement": f"Shifted from \"{d['from']}\" to \"{d['to']}\" — "
                    "how they're changing, read off the belief-revision trail",
                    "confidence": 0.45, "method": "trajectory",
                    "supporting_text": [f"was: {d['from']}", f"now: {d['to']}"]})
    return out[:4]


# ─────────────────────────── the LLM synthesis (preoccupation / tension / insecurity / negative space) ──
SYNTH_SYS = """You are a third-person observer building a model of ONE person from a bounded pack of things you
already believe about them (their atomic claims, with ids) plus their recent send behaviour. Derive
HIGHER-ORDER reads they would NOT self-report — the value of an outside observer is saying the thing they
can't see about themselves. Ground every derivation in the specific claim ids provided; never invent facts.

Derive across these categories (only where the evidence genuinely supports it — quality over quantity):
- "preoccupation": a recurring theme across many claims/sends (what they keep circling).
- "tension": they SAY X (a value) but DO/SEND Y (a behavior) — cite the value id AND the behavior id.
- "insecurity": the deep recurring worry underneath the pattern. LOW confidence. Phrase with CARE and
  compassion, never as an accusation — this is the most sensitive read and must never be usable as a blunt
  line. When unsure, omit it.
- "negative_space": what they conspicuously DON'T send or talk about, given everything they do circle — the
  telling absence (e.g. talks endlessly about the work, never about rest / the people around them).

For EACH derivation return: category, statement (one sentence, specific, in plain language), confidence
(0-1; insecurity ≤0.35, others ≤0.6), supporting_ids (the claim ids it stands on — REQUIRED, from the pack),
and for a stance also "actionability" (one of: conviction_consequentialist = a strategic/factual belief that
could be pressure-tested; conviction_sacred = identity/values/faith/family, must NOT be contested; none).

Be sparing. 3-6 strong derivations beat 12 weak ones. Return ONLY JSON:
{"derivations":[{"category","statement","confidence","supporting_ids":[int],"actionability"}]}"""


def _synth_model_specs():
    import llm
    primary = os.getenv("CO_INFER_MODEL") or os.getenv("CO_BRAIN_MODEL") or "anthropic/claude-haiku-4-5"
    specs = [primary] + [s for s in llm.phrase_specs() if s != primary]
    return specs


def synthesize(behavioral: list, interests: list, sends: list) -> list:
    """One cheap structured call over the evidence pack → higher-order derivations (preoccupation / tension /
    insecurity / negative_space). [] on any failure (degrade to the deterministic derivations only)."""
    import llm
    if not behavioral:
        return []
    theme_hist = Counter(s.get("theme") for s in sends if s.get("theme") and s["theme"] != "other")
    recent_sends = [s["send"][:120] for s in sends[-25:]]
    pack = {
        "atomic_claims": [{"id": r["id"], "type": r["type"], "level": r["level"],
                           "confidence": round(r["confidence"], 2), "statement": r["statement"][:180]}
                          for r in behavioral],
        "interest_claims": [{"id": r["id"], "statement": r["statement"][:160]} for r in interests],
        "recent_send_themes": dict(theme_hist.most_common(8)),
        "recent_send_samples": recent_sends,
    }
    out = llm.complete_with_fallbacks(_synth_model_specs(), SYNTH_SYS,
                                      json.dumps(pack, ensure_ascii=False)[:14000], max_tokens=1400)
    if not out:
        return []
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return []
    try:
        derivs = json.loads(m.group(0)).get("derivations", [])
    except json.JSONDecodeError:
        return []
    valid_ids = {r["id"] for r in behavioral} | {r["id"] for r in interests}
    clean = []
    for d in derivs:
        cat = d.get("category")
        stmt = (d.get("statement") or "").strip()
        stmt = re.sub(r"\s*\(ids?\s*[\d,\s]+\)", "", stmt).strip()   # ids live in evidence, not the prose
        ids = [i for i in (d.get("supporting_ids") or []) if i in valid_ids]
        if cat not in ("preoccupation", "tension", "insecurity", "negative_space") or not stmt or not ids:
            continue
        d["supporting_ids"], d["statement"] = ids, stmt
        clean.append(d)
    return clean


# ─────────────────────────── write derivations → inferred claims ───────────────────────────
CATEGORY_META = {
    # category      → (type, level, kind, conf_cap)
    "preoccupation":  ("frame", "frame", "interest", 0.5),
    "tension":        ("frame", "frame", None, 0.5),
    "insecurity":     ("frame", "frame", "insecurity", 0.35),
    "negative_space": ("frame", "frame", None, 0.5),
    "temporal":       ("frame", "pattern", "pattern", 0.8),
    "correlation":    ("frame", "pattern", "pattern", 0.5),
    "trajectory":     ("frame", "frame", None, 0.5),
}


def _supporting_from_ids(behavioral, interests, ids):
    byid = {r["id"]: r for r in (behavioral + interests)}
    return [{"id": i, "statement": byid.get(i, {}).get("statement", "")} for i in ids]


def write_derivations(conn, synth, temporal, trajectory, behavioral, interests, when, dry=False) -> list:
    """Persist every derivation as an inferred claim. Returns [(category, statement, confidence, kind, cid)]."""
    logged = []
    def _write(category, statement, confidence, supporting, subkind=None, fire_condition=None):
        typ, level, kind, cap = CATEGORY_META[category]
        conf = min(float(confidence), cap)
        if dry:
            logged.append((category, statement, round(conf, 2), kind, None))
            return
        cid = claimstore.upsert_inferred(conn, type=typ, level=level, statement=statement, confidence=conf,
                                         method=category, supporting=supporting, kind=kind, subkind=subkind,
                                         fire_condition=fire_condition, when=when)
        logged.append((category, statement, round(conf, 2), kind, cid))

    for d in synth:
        cat = d["category"]
        supporting = _supporting_from_ids(behavioral, interests, d["supporting_ids"])
        subkind = fc = None
        act = d.get("actionability")
        if cat == "tension" and act in ("conviction_consequentialist", "conviction_sacred"):
            # a tension that is also a stance: tag it as a conviction for the bubble-pop lane
            CATEGORY_META["tension"] = ("frame", "frame", "conviction", 0.5)
            subkind = "sacred" if act == "conviction_sacred" else "consequentialist"
            fc = {"type": "witness_only"} if subkind == "sacred" else {"type": "unchallenged_days", "n": 14}
        elif cat == "insecurity":
            fc = {"type": "heal_only"}
        _write(cat, d["statement"], d.get("confidence", 0.4), supporting, subkind, fc)
        if cat == "tension":
            CATEGORY_META["tension"] = ("frame", "frame", None, 0.5)   # reset the transient override

    for t in temporal:
        _write(t["method"] if t["method"] in CATEGORY_META else "temporal", t["statement"], t["confidence"],
               [{"id": None, "statement": s} for s in t.get("supporting_text", [])],
               fire_condition={"type": "pattern_moment"})
    for t in trajectory:
        supp = [{"id": t.get("id_hint"), "statement": s} for s in t.get("supporting_text", [])]
        _write("trajectory", t["statement"], t["confidence"], supp)
    return logged


# ─────────────────────────── actionability tagging (every actionable claim) ───────────────────────────
def _classify_kind(r):
    """Deterministic first-pass actionability for an atomic claim. Returns (kind, subkind, fire_condition)
    or (None, None, None). The synthesis already tagged inferred stances; this covers the atomics the
    reconciler's lanes pull from."""
    stmt, typ, level = r["statement"], r["type"], r["level"]
    biographical = bool(BIOGRAPHICAL.search(stmt))
    if (typ == "obligation" or OPEN_LOOP.search(stmt)) and not re.search(r"\b(receives?|subscrib)\b", stmt, re.I):
        # a stated future action → accountability. A dated one fires at the wire; else it's open-ended.
        return "open_loop", None, {"type": "open_ended"}
    # a CONVICTION is a contestable stance — value-type OR belief-lexicon, and NOT a biographical/role fact.
    if (typ == "value" or CONVICTION.search(stmt)) and not biographical:
        if SACRED.search(stmt):
            return "conviction", "sacred", {"type": "witness_only"}   # witness, never contest
        return "conviction", "consequentialist", {"type": "unchallenged_days", "n": 14}
    if (typ == "preference" or INTERESTY.search(stmt)) and not biographical:
        return "interest", None, {"type": "live_interest"}
    if level == "pattern" and BEHAVIORAL.search(stmt) and not biographical:
        return "pattern", None, {"type": "pattern_moment"}
    return None, None, None


def tag_actionability(conn, when, limit=6000, dry=False) -> Counter:
    """Stamp actionability onto the actionable atomic claims (value/identity/obligation/preference/pattern,
    plus anything matching the intent/belief/interest lexicons). Idempotent (only untagged rows; COALESCE
    keeps existing tags). Pure-regex — no per-claim model cost — so it covers the WHOLE actionable set
    rather than a salience-truncated slice (a low-salience value belief must still be tagged). Inferred
    claims were tagged at creation; this is the atomic backfill."""
    # Candidate pool: structural (value/identity/obligation/preference/pattern) PLUS belief-shaped fact
    # claims — the founder's richest convictions ("driven by status", "hates being uncomfortable") live at
    # type=fact/value and would otherwise never be considered. LIKE-gated so we don't scan all 6k facts.
    belief_like = " OR ".join(f"statement LIKE '%{p}%'" for p in
                              ("driven by", "wants to", "hates being", "first-principles", "first principles",
                               "optimizes for", "motivated by", "believes", "values ", "cares about",
                               "wants to be", "sees himself", "sees themselves", "prioritizes"))
    q = ("SELECT id, type, level, statement FROM claims "
         "WHERE COALESCE(status,'active')!='retired' AND COALESCE(inferred,0)=0 AND kind IS NULL "
         "AND id NOT IN (SELECT supersedes FROM claims WHERE supersedes IS NOT NULL) "
         "AND (type IN ('value','identity','obligation','preference') OR level IN ('pattern','frame') "
         f"OR ({belief_like})) LIMIT ?")
    tally = Counter()
    for cid, typ, level, stmt in conn.execute(q, (limit,)).fetchall():
        kind, subkind, fc = _classify_kind({"id": cid, "type": typ, "level": level, "statement": stmt})
        if not kind:
            continue
        tally[kind] += 1
        if not dry:
            claimstore.set_actionability(conn, cid, kind=kind, subkind=subkind, fire_condition=fc)
    return tally


# ─────────────────────────── orchestrator ───────────────────────────
def run(tenant="dennis", dry=False, tag_only=False, verbose=True) -> dict:
    db = _tenant_db(tenant)
    if not db.exists():
        return {"error": f"no claims db for tenant {tenant!r}"}
    # connect() runs the full additive migration (adds inferred/kind/subkind/fire_condition/last_surfaced_at).
    # Pin the explicit db path so we never depend on ambient CO_TENANT/CO_CLAIMS_DB env.
    prev = os.environ.get("CO_CLAIMS_DB")
    os.environ["CO_CLAIMS_DB"] = str(db)
    try:
        conn = claimstore.connect()
    finally:
        if prev is None:
            os.environ.pop("CO_CLAIMS_DB", None)
        else:
            os.environ["CO_CLAIMS_DB"] = prev

    when = dt.date.today().isoformat()
    result = {"tenant": tenant}

    if not tag_only:
        behavioral = behavioral_claims(conn)
        interests = interest_claims(conn)
        sends = send_stream(f"{db}.co_memory.db")
        deltas = trajectory_deltas(conn)
        temporal = derive_temporal(sends)
        trajectory = derive_trajectory(deltas)
        synth = synthesize(behavioral, interests, sends)
        logged = write_derivations(conn, synth, temporal, trajectory, behavioral, interests, when, dry=dry)
        result["derivations"] = logged
        result["counts"] = {"behavioral_in": len(behavioral), "interests_in": len(interests),
                            "sends_in": len(sends), "trajectory_deltas": len(deltas),
                            "synth_out": len(synth), "temporal_out": len(temporal)}

    tally = tag_actionability(conn, when, dry=dry)
    result["tagged"] = dict(tally)
    conn.close()

    if verbose:
        _print(result)
    return result


def _print(result):
    print(f"\n🧠 inference — tenant {result.get('tenant')}   {'(DRY)' if '--dry' in sys.argv else ''}")
    if "error" in result:
        print("  ", result["error"]); return
    if "counts" in result:
        c = result["counts"]
        print(f"   in:  {c['behavioral_in']} behavioral · {c['interests_in']} interests · {c['sends_in']} sends "
              f"· {c['trajectory_deltas']} supersede-deltas")
        print(f"   out: {c['synth_out']} synthesized · {c['temporal_out']} temporal\n")
        for cat, stmt, conf, kind, cid in result.get("derivations", []):
            tag = f" ·{kind}" if kind else ""
            print(f"   [{cat:<13} {conf:.0%}{tag}]  {stmt[:110]}")
    print(f"\n   actionability tagged (atomics): {result.get('tagged') or '(none new — all already tagged)'}")


def main():
    a = sys.argv[1:]
    tenant = a[a.index("--tenant") + 1] if "--tenant" in a else "dennis"
    run(tenant, dry="--dry" in a, tag_only="--tag-only" in a)


if __name__ == "__main__":
    main()
