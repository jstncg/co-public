#!/usr/bin/env python3
"""The proactive engine — a defer-and-hold RECONCILER (Phase 2 of the proactive-witness build).

Wired: CANONICAL proactive spine (newest). Imported by co_eval; NOT yet cron-wired — daily_text /
proactive_tick / unasked_delivery are the three paths cron runs today (see ARCHITECTURE.md §3).

Jae-style reconciler semantics on the raw stack (in-process, no framework): a durable DESIRED-STATE
(the held candidate) + a FIRED-LEDGER (per-claim last_surfaced_at + a per-lane ledger in co_memory.db),
idempotent, at-most-once, and biased HARD toward silence. Zero sends is a correct outcome.

Grounded in RESEARCH_proactive_witness.md — restraint is the moat, not a constraint:

  tick(tenant) per cron beat:
    gates            skip flag → quiet hours → shared callback budget (≤1 proactive resurface/day, ALL
                     surfaces) → the SEAM gate (defer-and-hold: not at a breakpoint → hold, try later).
    cheap pre-filter pure logic: is ANY lane even live? nothing → silence, no model spend.
    three lanes      ACCOUNTABILITY (open_loops)  — flag ONCE at the wire, as an informational MIRROR,
                                                    never policing/"you must" (control triggers reactance,
                                                    Deci/Ryan; Gneezy — the damage is irreversible). Then drop.
                     EXPOSURE       (interests)   — fetch-first GROUNDED (Exa→verify-resolves via the shared
                                                    rec_grounding gate); real title+author+url, never a
                                                    hallucinated source. The burst.
                     BUBBLE-POP     (convictions) — SOCRATIC elicitation, make the USER generate the counter
                                                    (Broockman/Kalla deep-canvassing; Bail 2018 — the
                                                    adversarial counter BACKFIRES). consequentialist →
                                                    challenge; SACRED → witness, never contest.
    score + gate     relevance × novelty × timing × worth-interrupting. At most ONE fires; usually none.
    model-agnostic   pure-logic scan, best model (llm.phrase_specs) for the compose. Habit-safe: NEVER
                     nags "send me stuff" (Stawarz 2015 — the prompt must not become the user's cue).

  python3 reconciler.py                    # stage-only: every tenant, print what WOULD fire (or silence)
  python3 reconciler.py --tenant dennis --explain     # one tenant, show every lane's live/held/why
  python3 reconciler.py --tenant dennis --seam        # pretend NOW is a seam (demo the fire, still no send)
  python3 reconciler.py --send             # real sends (CO_TEST_HANDLES allowlist-gated, like daily_text)
"""
import datetime as dt
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import claimstore  # noqa: E402
import disposition  # noqa: E402

# ── knobs ────────────────────────────────────────────────────────────────────────────────────────────
QUIET_START, QUIET_END = dt.time(21, 30), dt.time(9, 0)   # tenant-local (mirror of proactive_tick)
UNCHALLENGED_DAYS = 14        # a conviction is "openable" only if untouched this long
DISENGAGED_MIN = 30           # a proactive push is a SEPARATE bid — only at a boundary, not mid-thread
WORTH_BAR = 0.50              # a candidate must clear this to be worth interrupting for
MAX_COMPOSE_ATTEMPTS = 3      # only the TOP few get an (expensive) compose. Don't dig for something to say —
EXPOSURE_COOLDOWN_D = 6       # don't re-expose the same interest thread within a week

# Control language = the reactance trigger (research). Accountability MIRRORS, never commands. Instant fail.
CONTROL = re.compile(r"(?i)\byou (must|need to|have to|should|gotta|better)\b|\bdon'?t forget\b|"
                     r"\bmake sure\b|\bget it done\b|\bno excuses\b|\bstop (procrastin|avoiding)\b|"
                     r"\bwhy haven'?t you\b|\bcome on\b")
# Adversarial-counter tells = the Bail-2018 backfire shape. Bubble-pop must ELICIT, never assert the counter.
ADVERSARIAL = re.compile(r"(?i)\b(actually|in fact|the truth is|studies show|research shows|you'?re wrong|"
                         r"the (real|opposite) (answer|view|truth)|but consider that|the counter(argument)?|"
                         r"here'?s why (that'?s|you'?re) (wrong|mistaken)|the evidence says)\b")


# ── state paths ──────────────────────────────────────────────────────────────────────────────────────
def _tenant_db(tenant: str) -> Path:
    t = re.sub(r"[^a-z0-9_+\-]", "_", (tenant or "dennis").strip().lower()) or "dennis"
    return HERE / ("claims.db" if t == "dennis" else f"claims_{t}.db")


def _desired_path(db: Path) -> Path:
    return Path(f"{db}.reconciler.json")


def _load_desired(db: Path) -> dict:
    try:
        return json.loads(_desired_path(db).read_text())
    except (OSError, json.JSONDecodeError):
        return {"held": None}


def _save_desired(db: Path, state: dict) -> None:
    try:
        tmp = Path(str(_desired_path(db)) + ".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False))
        os.replace(tmp, _desired_path(db))
    except OSError:
        pass


def _fired_ledger(memory_path: str):
    c = sqlite3.connect(memory_path)
    c.execute("CREATE TABLE IF NOT EXISTS reconciler_fired (id INTEGER PRIMARY KEY, ts TEXT, lane TEXT, "
              "claim_id INTEGER, ref TEXT, text TEXT)")
    c.commit()
    return c


def _already_fired_ref(memory_path: str, ref: str) -> bool:
    """Exposure/url idempotency: have we ever sent this exact ref (a url) to this tenant?"""
    if not Path(memory_path).exists() or not ref:
        return False
    c = _fired_ledger(memory_path)
    row = c.execute("SELECT 1 FROM reconciler_fired WHERE ref=? LIMIT 1", (ref,)).fetchone()
    c.close()
    return bool(row)


def _record_fired(memory_path: str, lane: str, claim_id, ref: str, text: str) -> None:
    c = _fired_ledger(memory_path)
    c.execute("INSERT INTO reconciler_fired (ts, lane, claim_id, ref, text) VALUES (?,?,?,?,?)",
              (dt.datetime.now().isoformat(timespec="seconds"), lane, claim_id, ref, text))
    c.commit()
    c.close()


# ── the cost-of-interruption signal (cheap, per-user, from time + activity) ──────────────────────────
def cost_signal(claims_db: str) -> dict:
    """A cheap per-user cost-of-interruption read (Horvitz BusyBody flavour, from time + the send stream).
    A SEAM is a low-load boundary: an evening lull or a weekend late-morning, NOT during likely-commute/
    driving hours, and only once they've DISENGAGED (no send for a while — a proactive push mid-thread is
    weird). Conservative by design: when unsure, it is not a seam (err toward silence)."""
    try:
        import tz_dynamic
        now = tz_dynamic.now_in(claims_db)
    except Exception:
        now = dt.datetime.now()
    h, wd = now.hour + now.minute / 60, now.weekday()
    weekend = wd >= 5
    is_quiet = now.time() >= QUIET_START or now.time() < QUIET_END
    # likely commuting/driving — never fire here (research: never mid-drive)
    likely_driving = (not weekend) and (7.5 <= h < 9.0 or 17.0 <= h < 18.5)
    # seam windows: the evening lull (any day) and the weekend late-morning
    in_window = (19.0 <= h < 21.0) or (weekend and 9.5 <= h < 12.0)
    mins_since = _mins_since_last_send(f"{claims_db}.co_memory.db")
    disengaged = mins_since is None or mins_since >= DISENGAGED_MIN
    is_seam = in_window and not likely_driving and not is_quiet and disengaged
    reason = ("quiet hours" if is_quiet else "likely driving/commute" if likely_driving
              else "not a seam window" if not in_window
              else f"mid-thread (last send {mins_since}m ago)" if not disengaged else "seam")
    return {"now": now, "is_quiet": is_quiet, "is_seam": is_seam, "likely_driving": likely_driving,
            "in_window": in_window, "mins_since_send": mins_since, "reason": reason,
            "seam_quality": 0.9 if (weekend and in_window) else 0.7 if in_window else 0.0}


def _mins_since_last_send(memory_path: str):
    if not Path(memory_path).exists():
        return None
    try:
        c = sqlite3.connect(f"file:{memory_path}?mode=ro", uri=True)
        row = c.execute("SELECT ts FROM co_sends ORDER BY id DESC LIMIT 1").fetchone()
        c.close()
        if not row or not row[0]:
            return None
        last = dt.datetime.fromisoformat(row[0])
        return int((dt.datetime.now() - last).total_seconds() // 60)
    except Exception:
        return None


# ── lane 1: ACCOUNTABILITY (open loops → an informational mirror, flagged ONCE at the wire) ───────────
def _days_until(due: str):
    try:
        return (dt.date.fromisoformat(due[:10]) - dt.date.today()).days
    except (ValueError, TypeError):
        return None


def lane_accountability(conn, claims_db: str) -> list:
    """Open loops that are AT THE WIRE and not yet surfaced. Sources: dated commitments in threads.json
    (the freshest 'you said you'd do X') + open_loop-tagged claims. Fires once → dropped."""
    cands = []
    # dated commitments from the rolling thread state
    try:
        import threads as threads_mod
        st = threads_mod.load(claims_db)
        for c in st.get("commitments", []):
            due = c.get("due")
            d = _days_until(due) if due else None
            at_wire = (d is not None and d <= 0)          # due today or overdue = the wire
            if not due:
                continue
            cands.append({"lane": "accountability", "claim_id": None, "ref": f"commit:{c['text'][:40]}",
                          "what": c["text"], "due": due, "at_wire": at_wire,
                          "relevance": 0.9 if at_wire else 0.4})
    except Exception:
        pass
    # open_loop claims (a stated future action); dated ones at the wire, else low relevance
    for r in claimstore.actionable(conn, "open_loop", min_conf=0.5, limit=30):
        if r.get("last_surfaced_at"):
            continue                                       # flagged once already → dropped forever
        fc = _parse_fc(r.get("fire_condition"))
        due = fc.get("date") if fc.get("type") == "due" else None
        d = _days_until(due) if due else None
        at_wire = (d is not None and d <= 0)
        cands.append({"lane": "accountability", "claim_id": r["id"], "ref": f"claim:{r['id']}",
                      "what": r["statement"], "due": due, "at_wire": at_wire,
                      "relevance": 0.85 if at_wire else 0.35})
    # only AT-THE-WIRE items are live for this lane — otherwise silence (never a preemptive nag)
    return [c for c in cands if c["at_wire"]]


ACCOUNT_SYS = """You are Co. Someone told you they'd do a thing, and the moment has arrived. Send ONE short
text that simply REFLECTS it back — a mirror, not a manager. You are a friend who remembered, not a boss
checking a box.

HARD RULES (this is the whole game — controlling language backfires and the damage doesn't undo):
- NEVER command or police: no "you must / need to / should / don't forget / make sure / get it done".
- No guilt, no "why haven't you", no stakes you invented. Just name the thing, lightly, as feedback.
- It's informational: "today's the northwind reimbursement day, yeah?" lands; "make sure you submit it!" is dead.
- One line, under 140 chars, lowercase-leaning, one question max (zero is fine). No emoji unless it fits.
Return ONLY the text (or exactly ABSTAIN if nothing lands as a clean mirror)."""


def compose_accountability(cand: dict) -> str | None:
    import llm
    payload = f"They said they'd: {cand['what']}\nThe date on it: {cand.get('due') or 'today'}"
    out = llm.complete_with_fallbacks(llm.phrase_specs(), ACCOUNT_SYS, payload, max_tokens=60)
    return _finish(out, extra_bad=CONTROL)


# ── lane 2: EXPOSURE (interests → a grounded find, real source, verified to resolve) ─────────────────
def lane_exposure(conn, claims_db: str, memory_path: str) -> list:
    """Live interest threads worth an exposure burst. Freshest interest/preoccupation, not exposed recently.
    The GROUNDING (a real resolving source) happens at fire time via the shared rec_grounding gate."""
    cands = []
    seen = set()
    # prefer the rolling threads (the freshest 'what they're circling'), then interest-tagged claims
    labels = []
    try:
        import threads as threads_mod
        for t in threads_mod.load(claims_db).get("topics", []):
            if t.get("count", 0) >= 2 and not re.search(r"check-?in|misc|general", t.get("label", ""), re.I):
                labels.append({"label": t["label"], "claim_id": None, "relevance": min(0.9, 0.4 + 0.1 * t["count"])})
    except Exception:
        pass
    for r in claimstore.actionable(conn, "interest", min_conf=0.4, limit=20):
        lbl = _interest_label(r["statement"])
        if lbl:
            labels.append({"label": lbl, "claim_id": r["id"], "relevance": 0.4,
                           "last_surfaced_at": r.get("last_surfaced_at")})
    for x in labels:
        key = x["label"].lower()
        if key in seen:
            continue
        seen.add(key)
        cands.append({"lane": "exposure", "claim_id": x["claim_id"], "ref": None,
                      "label": x["label"], "relevance": x["relevance"]})
    return cands[:4]


def _interest_label(stmt: str) -> str:
    """Pull a searchable theme out of an interest claim ('Interested in how groups form beliefs' → the noun)."""
    m = re.search(r"(?:interested in|reading|drawn to|circling|curious about|into|studies?|following)\s+(.{4,60})",
                  stmt, re.I)
    lbl = (m.group(1) if m else stmt)[:60].strip(" .,-")
    return lbl if len(lbl) >= 4 else ""


EXPOSURE_SYS = """You are Co, texting first with a FIND: one real thing (a book or essay) adjacent to what this
person keeps circling, that they didn't know existed. You are given the theme and a VERIFIED real source
(title, author, url — all real, already fetched and resolved). Write the one text.

THE TEXTURE (a friend flicking something at you, never a recommendation engine):
- Tie it to the SPECIFIC thing they circle, in their terms. Name the real title + author. Include the url.
- lowercase-leaning, under 240 chars, one find only, invites a riff (a hook or a dare), never a review.
BANNED (rec-engine tells, instant death): "based on your", "you might enjoy/like", "i found something",
"i came across", "recommend", "check out", "worth a read", "adding to your list", "since you're interested".
Do NOT alter the title/author/url — they are facts, verbatim. Return ONLY the text (or ABSTAIN)."""


def compose_exposure(cand: dict, memory_path: str) -> tuple:
    """Ground first (real resolving source via the shared gate), then compose. Returns (text, url) or
    (None, None). EXA out of credits / no grounded source → (None, None): silent, never a fake source."""
    import rec_grounding
    rec = rec_grounding.source_one_rec(cand["label"])
    if not rec or _already_fired_ref(memory_path, rec["url"]):
        return None, None
    return compose_from_source(cand["label"], rec)


def compose_from_source(label: str, rec: dict) -> tuple:
    """Compose the exposure text from an ALREADY-GROUNDED source (title/author/url are real + verified to
    resolve upstream). The url MUST survive verbatim into the text (grounded provenance); if the model drops
    it, append once, else abstain. Returns (text, url) or (None, None)."""
    import llm
    payload = json.dumps({"they_circle": label, "verified_source": {
        "title": rec["title"], "author": rec.get("author", ""), "url": rec["url"], "about": rec.get("blurb", "")}})
    out = llm.complete_with_fallbacks(llm.phrase_specs(), EXPOSURE_SYS, payload, max_tokens=120)
    text = _finish(out, extra_bad=_REC_ENGINE)
    if not text:
        return None, None
    if rec["url"] not in text:
        text = f"{text} {rec['url']}"                      # provenance is non-negotiable — carry the real url
    return (text, rec["url"]) if rec["url"] in text else (None, None)


_REC_ENGINE = re.compile(r"(?i)based on your|you might (enjoy|like)|i found something|i came across|recommend"
                         r"|check out|worth a read|adding to your list|since you'?re interested")


# ── lane 3: BUBBLE-POP (convictions → Socratic elicitation; sacred = witness, never contest) ──────────
def lane_bubblepop(conn) -> list:
    """Consequentialist convictions gone unchallenged long enough to be worth a Socratic opening. SACRED
    convictions are EXCLUDED here by construction (they are witnessed, never contested)."""
    cands = []
    for r in claimstore.actionable(conn, "conviction", min_conf=0.5, limit=40):
        if r.get("subkind") == "sacred":
            continue                                       # never contest identity/values/faith/family
        fc = _parse_fc(r.get("fire_condition"))
        if fc.get("type") != "unchallenged_days":
            continue
        last = r.get("last_surfaced_at")
        days = _days_since(last) if last else 999
        if days < fc.get("n", UNCHALLENGED_DAYS):
            continue                                       # challenged recently → let it breathe (corrections decay; space them)
        cands.append({"lane": "bubblepop", "claim_id": r["id"], "ref": f"claim:{r['id']}",
                      "belief": r["statement"], "relevance": min(0.85, 0.5 + 0.35 * r["confidence"]),
                      "days_unchallenged": days})
    return cands


BUBBLE_SYS = """You are Co. This person holds a belief (below). You are NOT here to argue the other side —
piping someone the opposing view HARDENS the belief (it reads as an attack on who they are). Instead, ask
ONE genuine, non-judgmental question that makes THEM examine it — the mirror, not the megaphone.

Good moves (pick ONE, make it specific to their belief):
- "how does that actually work, mechanically?" (explain-how deflates borrowed confidence)
- "did you reason your way to that, or inherit it?"
- "what would have to be true for the opposite to be right?"
- "where'd that one come from originally?"

HARD RULES:
- ASK, never TELL. No counter-argument, no "actually", no "studies show", no facts marshalled against them.
- Non-judgmental, curious, on their side. Contempt is the kill switch.
- One line, one question, under 160 chars, lowercase-leaning. A real question, not a rhetorical gotcha.
Return ONLY the text (or exactly ABSTAIN if there's no honest, non-adversarial opening)."""


def compose_bubblepop(cand: dict) -> str | None:
    import llm
    out = llm.complete_with_fallbacks(llm.phrase_specs(), BUBBLE_SYS,
                                      f"Their belief: {cand['belief']}", max_tokens=70)
    text = _finish(out, extra_bad=ADVERSARIAL)
    if not text or "?" not in text:               # Socratic means it ASKS — no question, no fire
        return None
    return text


# ── shared compose finish (sanitize + disposition gate + lane-specific banned pattern) ───────────────
def _finish(out: str | None, extra_bad: re.Pattern | None = None) -> str | None:
    t = (out or "").strip().strip('"')
    if not t or "ABSTAIN" in t.upper():
        return None
    t = disposition.sanitize(t)
    if disposition.violations(t, max_chars=240):
        return None
    if extra_bad and extra_bad.search(t):
        return None
    return t


def _parse_fc(fc):
    if isinstance(fc, dict):
        return fc
    try:
        return json.loads(fc) if fc else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _days_since(iso: str):
    try:
        return (dt.datetime.now() - dt.datetime.fromisoformat(iso)).days
    except (ValueError, TypeError):
        return 999


# ── scoring (relevance × novelty × timing × worth-interrupting) ──────────────────────────────────────
LANE_WEIGHT = {"accountability": 1.0, "exposure": 0.9, "bubblepop": 0.85}


def score(cand: dict, cost: dict) -> float:
    relevance = cand.get("relevance", 0.4)
    novelty = 1.0                                          # not-surfaced-before is enforced upstream (ledger)
    timing = cost.get("seam_quality", 0.0)
    worth = LANE_WEIGHT.get(cand["lane"], 0.7)
    return round(relevance * novelty * (0.5 + 0.5 * timing) * worth, 3)


# ── the tick ───────────────────────────────────────────────────────────────────────────────────────
def prefilter(conn, claims_db: str, memory_path: str) -> dict:
    """CHEAP, pure-logic: which lanes are even live right now? Nothing live → silence, zero model spend."""
    acct = lane_accountability(conn, claims_db)
    expo = lane_exposure(conn, claims_db, memory_path)
    bubble = lane_bubblepop(conn)
    return {"accountability": acct, "exposure": expo, "bubblepop": bubble}


def tick(tenant: str, send: bool = False, explain: bool = False, force_seam: bool = False,
         lane_filter: str | None = None) -> dict:
    db = _tenant_db(tenant)
    claims_db = str(db)
    memory_path = f"{claims_db}.co_memory.db"
    out = {"tenant": tenant, "fired": None, "held": None, "silence": None, "lanes": {}, "trace": []}
    def trace(s):
        out["trace"].append(s)

    if not db.exists():
        out["silence"] = "no claims db"
        return out

    # gates, cheapest first (mirror of proactive_tick / daily_text)
    import daily_text
    if daily_text._skipped_today(db):
        out["silence"] = "skip flag ('not tonight')"
        return out
    import co_react
    cost = cost_signal(claims_db)
    if force_seam:                                        # demo: treat NOW as a strong seam for scoring too
        cost["is_seam"] = True
        cost["seam_quality"] = max(cost["seam_quality"], 0.85)
    if cost["is_quiet"] and not force_seam:
        out["silence"] = f"quiet hours ({cost['now'].strftime('%H:%M')} local)"
        return out
    if co_react.callback_used_today(memory_path):
        out["silence"] = "shared callback budget spent today (≤1 proactive resurface/day, all surfaces)"
        return out

    conn = claimstore.connect(tenant)                    # db_path(tenant) → claims.db | claims_<tenant>.db
    try:
        lanes = prefilter(conn, claims_db, memory_path)
        out["lanes"] = {k: len(v) for k, v in lanes.items()}
        live = [c for lane in lanes.values() for c in lane]
        if not live:
            out["silence"] = "no lane live (nothing due, nothing fresh, nothing openable) — correct silence"
            return out

        # SEAM gate (defer-and-hold): if NOW isn't a breakpoint, HOLD the best candidate and try later.
        seam = force_seam or cost["is_seam"]
        if not seam:
            best = _best(live, cost)
            _save_desired(db, {"held": _slim(best), "since": dt.datetime.now().isoformat(timespec="seconds")})
            out["held"] = {"lane": best["lane"], "why": best.get("what") or best.get("label") or best.get("belief", "")[:60]}
            out["silence"] = f"held for a seam ({cost['reason']}) — defer-and-hold"
            return out

        # at a seam: score, then compose ONLY the top few that clear the bar (compose is the expensive step;
        # don't iterate 30 beliefs hunting for one that sticks — that IS digging for something to say). First
        # clean compose fires; the rest is silence. Optional --lane pins one lane for a demonstration.
        if lane_filter:
            live = [c for c in live if c["lane"] == lane_filter]
        ranked = sorted(live, key=lambda c: score(c, cost), reverse=True)
        attempts = 0
        for cand in ranked:
            s = score(cand, cost)
            if s < WORTH_BAR:
                trace(f"{cand['lane']}: score {s} < bar {WORTH_BAR} — not worth interrupting; stop")
                break                                      # ranked desc: nothing below clears either
            if attempts >= MAX_COMPOSE_ATTEMPTS:
                trace(f"used {attempts} compose attempts, none clean — err toward silence")
                break
            attempts += 1
            text, ref, cid = _compose_lane(cand, memory_path)
            if not text:
                trace(f"{cand['lane']}: composer abstained/ungrounded — silence beats slop")
                continue
            out["candidate"] = {"lane": cand["lane"], "score": s, "text": text, "ref": ref}
            if not send:
                out["fired"] = {"lane": cand["lane"], "score": s, "text": text, "staged": True}
                _stage(db, cand["lane"], text, ref)
                _clear_held(db)
                return out
            if _deliver(tenant, db, text):
                _record_fired(memory_path, cand["lane"], cid, ref or "", text)
                if cid:
                    claimstore.mark_surfaced(conn, cid, dt.datetime.now().isoformat(timespec="seconds"))
                co_react.mark_callback(f"reconciler:{cand['lane']}", memory_path)
                daily_text.record_outbound(tenant, text)     # the engine must own its own words
                _clear_held(db)
                out["fired"] = {"lane": cand["lane"], "score": s, "text": text, "sent": True}
                return out
            out["silence"] = "send failed (candidate stays live for next tick)"
            return out
        out["silence"] = "nothing cleared the worth-interrupting bar — silence"
        return out
    finally:
        conn.close()


def _compose_lane(cand, memory_path):
    """Compose the right lane. Returns (text, ref, claim_id)."""
    if cand["lane"] == "accountability":
        return compose_accountability(cand), cand.get("ref"), cand.get("claim_id")
    if cand["lane"] == "exposure":
        text, url = compose_exposure(cand, memory_path)
        return text, url, cand.get("claim_id")
    if cand["lane"] == "bubblepop":
        return compose_bubblepop(cand), cand.get("ref"), cand.get("claim_id")
    return None, None, None


def _best(cands, cost):
    return sorted(cands, key=lambda c: score(c, cost), reverse=True)[0]


def _slim(c):
    return {k: c.get(k) for k in ("lane", "claim_id", "ref", "what", "label", "belief", "due", "relevance")}


def _stage(db, lane, text, ref):
    Path(f"{db}.staged_reconciler.json").write_text(json.dumps(
        {"date": dt.date.today().isoformat(), "lane": lane, "text": text, "ref": ref}, ensure_ascii=False, indent=1))


def _clear_held(db):
    _save_desired(db, {"held": None})


def _deliver(tenant, db, text) -> bool:
    import daily_text
    phone = daily_text.tenant_phone(tenant, daily_text._cfg(db))
    if not (phone and daily_text._allowlisted(phone)):
        return False
    return daily_text._sendblue(phone, text)


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────
def _print(out):
    t = out["tenant"]
    lanes = out.get("lanes", {})
    lane_s = " ".join(f"{k}={v}" for k, v in lanes.items()) or "-"
    print(f"\n🫧 reconciler — {t}   lanes[{lane_s}]")
    for tr in out.get("trace", []):
        print(f"     · {tr}")
    if out.get("fired"):
        f = out["fired"]
        verb = "SENT" if f.get("sent") else "STAGE"
        print(f"   🔔 [{verb}] {f['lane']} (score {f['score']}) → {f['text']!r}")
    elif out.get("held"):
        print(f"   ⏸  HELD {out['held']['lane']}: {out['held']['why']!r}  ({out.get('silence')})")
    else:
        print(f"   · silence: {out.get('silence')}")


def main():
    a = sys.argv[1:]
    send = "--send" in a
    explain = "--explain" in a
    force_seam = "--seam" in a
    lane_filter = a[a.index("--lane") + 1] if "--lane" in a else None
    import daily_text
    if "--tenant" in a:
        tenants = [a[a.index("--tenant") + 1]]
    else:
        tenants = ["dennis"] + [t for t in (p.name[len("claims_"):-len(".db")]
                                            for p in sorted(HERE.glob("claims_*.db"))
                                            if not p.name.endswith(".co_memory.db"))
                                if not daily_text._is_founder_alias(t)]
    print(f"reconciler {'SEND' if send else 'stage-only'}{' +force-seam' if force_seam else ''} "
          f"— {dt.datetime.now().isoformat(timespec='seconds')}")
    for t in tenants:
        try:
            _print(tick(t, send=send, explain=explain, force_seam=force_seam, lane_filter=lane_filter))
        except Exception as e:
            import traceback
            print(f"  [err] {t}: {e}")
            if explain:
                traceback.print_exc()


if __name__ == "__main__":
    main()
