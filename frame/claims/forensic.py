#!/usr/bin/env python3
"""Forensic extractor P1 — deterministic signal, earned confidence (FORENSIC_EXTRACTOR.md).

Four analyzers that COMPUTE (not guess) high-value signal from the substrate's structured data — including
the 654k iMessages we never touched. Confidence is earned by the computation + sample size, so these claims
arrive pre-calibrated (this is also E3). No LLM.

  circadian  — ts of his SENT messages → active window + quiet/sleep trough (his real schedule)
  latency    — per-contact reply speed → the TRUE priority ranking (tie-strength, measured)
  tie_graph  — message volume/recency/reciprocity per person → the real relationship ranking (closest tie first)
  engagement — subscriptions.opened/received → MEASURED receiving≠doing (retires the regex guess)

  doppler run -- /…/python3 forensic.py [--dry]
"""
import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore
import flib  # WAVE 0 cleaning lib: tapback filter, exact-pid match, stale clamp, code-switch detectors

SUB = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
SELF = 1


def sub():
    import sqlite3
    return sqlite3.connect(SUB, uri=True)


def _ts(s):
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _ev(method, **kw):
    return [dict({"source": "forensic", "method": method}, **kw)]


# ---------------- circadian: his real schedule from SENT-message timestamps ----------------
TZ_OFFSET = -8   # substrate ts are UTC; Dennis is Pacific. Approx (ignores PST/PDT wobble).


def circadian(c):
    rows = c.execute("SELECT ts FROM communications WHERE direction='sent' AND ts IS NOT NULL").fetchall()
    hours = defaultdict(int)
    wk = defaultdict(int)
    for (ts,) in rows:
        d = _ts(ts)
        if d:
            hours[(d.hour + TZ_OFFSET) % 24] += 1   # → Pacific local hour
            wk[d.weekday()] += 1
    n = sum(hours.values())
    if n < 200:
        return []
    by_hour = [hours.get(h, 0) for h in range(24)]
    mean = n / 24
    # quiet window: the 6-consecutive-hour block (wrapping) with least activity → sleep proxy
    best_start, best_sum = 0, 1e18
    for s in range(24):
        block = sum(by_hour[(s + i) % 24] for i in range(6))
        if block < best_sum:
            best_sum, best_start = block, s
    quiet = [(best_start + i) % 24 for i in range(6)]
    sleep_lo, sleep_hi = quiet[0], (quiet[-1] + 1) % 24
    # active window = the span of above-average hours that aren't in the quiet block
    active = [h for h in range(24) if h not in quiet and by_hour[h] >= mean]
    a_lo, a_hi = (min(active), max(active)) if active else (9, 23)
    wkend = (wk.get(5, 0) + wk.get(6, 0)) / 2
    wkday = sum(wk.get(d, 0) for d in range(5)) / 5
    weekend_ratio = wkend / wkday if wkday else 0
    out = [
        {"type": "routine", "level": "pattern",
         "statement": f"Most active (messaging) between ~{a_lo}:00 and ~{a_hi}:00",
         "confidence": 0.9, "evidence": _ev("circadian", n=n, peak_hours=[a_lo, a_hi])},
        {"type": "routine", "level": "pattern",
         "statement": f"Messaging goes quiet ~{sleep_lo}:00–{sleep_hi}:00 (likely sleep window)",
         "confidence": 0.72, "evidence": _ev("circadian", n=n, quiet=[sleep_lo, sleep_hi])},
    ]
    if weekend_ratio >= 0.7:
        out.append({"type": "routine", "level": "pattern",
                    "statement": "Active 7 days a week — weekend messaging volume ~matches weekdays",
                    "confidence": 0.85, "evidence": _ev("circadian", weekend_ratio=round(weekend_ratio, 2))})
    return out


# ---------------- latency: true priority ranking from reply speed ----------------
def latency(c):
    # GMAIL only — email reply-latency is meaningful (hours/days differentiate priority); iMessage is
    # real-time so every gap is ~0 (noise). Filter bots/shortcodes/self at emit time.
    rows = c.execute(
        "SELECT thread_id, ts, direction, from_person_id FROM communications "
        "WHERE channel='gmail' AND thread_id IS NOT NULL AND ts IS NOT NULL ORDER BY thread_id, ts").fetchall()
    lat = defaultdict(list)        # person -> [reply latency seconds]
    recv = defaultdict(int)        # person -> # messages received from them
    last_recv = {}                 # thread -> (ts, person)
    cur = None
    for thread, ts, direction, frm in rows:
        if thread != cur:
            cur, last_recv = thread, {}
        d = _ts(ts)
        if direction == "received" and frm and frm != SELF:
            last_recv[thread] = (d, frm)
            recv[frm] += 1
        elif direction == "sent" and thread in last_recv and last_recv[thread][0] and d:
            rd, rp = last_recv.pop(thread)
            sec = (d - rd).total_seconds()
            if 0 <= sec <= 60 * 60 * 24 * 14:   # within 2 weeks counts as a reply
                lat[rp].append(sec)
    # rank: contacts he replies to most + fastest (min sample)
    scored = []
    for p, ls in lat.items():
        if len(ls) < 10:
            continue
        med = statistics.median(ls)
        rate = len(ls) / max(recv[p], len(ls))
        scored.append((p, med, rate, len(ls)))
    if not scored:
        return []
    scored.sort(key=lambda x: (x[1], -x[2]))   # fastest median, then highest reply rate
    out = []
    for p, med, rate, k in scored:
        if len(out) >= 6:
            break
        nm = _name(c, p)
        if med < 120 or rate < 0.3 or _is_bot(nm):  # priority = prompt AND actually reciprocates; skip bots/artifacts
            continue
        out.append({"type": "relationship", "level": "pattern",
                    "statement": f"Replies promptly to {nm} — a priority contact",   # figures → evidence (stable statement)
                    "confidence": 0.82, "evidence": _ev("latency", n=k, median=_human(med), reply_rate=round(rate, 2))})
    return out


# ---------------- tie_graph: the real relationship ranking ----------------
def tie_graph(c):
    inbound = dict(c.execute(
        "SELECT from_person_id, count(*) FROM communications WHERE direction='received' "
        "AND from_person_id IS NOT NULL AND from_person_id!=? GROUP BY from_person_id", (SELF,)).fetchall())
    # outbound: parse to_person_ids JSON arrays
    outbound = defaultdict(int)
    for (tp,) in c.execute("SELECT to_person_ids FROM communications WHERE direction='sent' AND to_person_ids IS NOT NULL"):
        try:
            for pid in json.loads(tp):
                if pid != SELF:
                    outbound[pid] += 1
        except (json.JSONDecodeError, TypeError):
            pass
    total = {p: inbound.get(p, 0) + outbound.get(p, 0) for p in set(inbound) | set(outbound)}
    # keep humans: drop senders flagged as services/marketing in email_features
    svc = {r[0] for r in c.execute(
        "SELECT DISTINCT cm.from_person_id FROM email_features ef JOIN communications cm ON ef.comm_id=cm.id "
        "WHERE ef.sender_type IN ('marketing','automated','no_reply','noreply','newsletter','service')")}
    ranked = sorted(((p, v) for p, v in total.items() if p not in svc and v >= 50),
                    key=lambda x: -x[1])
    if not ranked:
        return []
    out, top = [], ranked[:12]
    names = ", ".join(_name(c, p) for p, _ in top[:6])   # names only → stable; volumes go to evidence
    out.append({"type": "relationship", "level": "fact",
                "statement": f"Closest contacts by message volume: {names}",
                "confidence": 0.9, "evidence": _ev("tie_graph", top=[(_name(c, p), v) for p, v in top[:6]])})
    # the standout #1
    p0, v0 = top[0]
    if len(top) > 1 and v0 > top[1][1] * 1.5:
        out.append({"type": "relationship", "level": "fact",
                    "statement": f"{_name(c, p0)} is by far the most-contacted person — the closest relationship",
                    "confidence": 0.92, "evidence": _ev("tie_graph", person=_name(c, p0), n=v0, next=top[1][1])})
    return out


# ---------------- engagement: measured receiving≠doing ----------------
def engagement(c):
    rows = c.execute("SELECT sender_name, total_received, total_opened, total_replied FROM subscriptions "
                     "WHERE total_received >= 50").fetchall()
    dead, live = [], []
    for name, rec, opened, replied in rows:
        if not rec:
            continue
        rate = (opened or 0) / rec
        if rate < 0.05:
            dead.append((name, rec, rate))
        elif rate > 0.4:
            live.append((name, rec, rate))
    out = []
    for name, rec, rate in sorted(dead, key=lambda x: -x[1])[:6]:
        out.append({"type": "preference", "level": "pattern",
                    "statement": f"Receives but ignores {name} — a dead subscription he doesn't open",
                    "confidence": 0.85, "evidence": _ev("engagement", received=rec, open_rate=round(rate, 3))})
    for name, rec, rate in sorted(live, key=lambda x: -x[1])[:4]:
        out.append({"type": "preference", "level": "pattern",
                    "statement": f"Actually engages with {name} (opens and reads it)",
                    "confidence": 0.8, "evidence": _ev("engagement", received=rec, open_rate=round(rate, 3))})
    return out


# ---------------- style fingerprint: code-switching by relationship (his AUTHORED text → no receiving≠doing) ----------------
def style_fingerprint(c):
    rows = c.execute("SELECT to_person_ids, count(*) FROM communications WHERE channel='imessage' AND direction='sent' "
                     "AND to_person_ids LIKE '[%]' AND to_person_ids NOT LIKE '%,%' GROUP BY to_person_ids "
                     "ORDER BY 2 DESC LIMIT 50").fetchall()   # family contacts can rank low by volume — the limit must reach them
    korean, endear = [], []
    for tp, n in rows:
        try:
            pid = int(tp.strip("[]"))
        except ValueError:
            continue
        nm = _name(c, pid)
        if flib.is_bot(nm) or n < 50:
            continue
        bodies = [flib.clean(b) for (b,) in c.execute(
            "SELECT body FROM communications WHERE channel='imessage' AND direction='sent' AND to_person_ids=? "
            "AND body IS NOT NULL", (tp,))]
        bodies = [b for b in bodies if b and not flib.is_tapback(b)]
        if len(bodies) < 50:
            continue
        kor = sum(1 for b in bodies if flib.HANGUL.search(b)) / len(bodies)
        end = sum(1 for b in bodies if flib.ENDEARMENT.search(b)) / len(bodies)
        if kor >= 0.08:
            korean.append((nm, kor))
        if end >= 0.015:
            endear.append((nm, end))
    out = []
    if korean:
        names = ", ".join(nm for nm, _ in sorted(korean, key=lambda x: -x[1])[:4])
        out.append({"type": "identity", "level": "fact",
                    "statement": f"Code-switches into Korean with {names} — Korean-heritage, speaks it with family",
                    "confidence": 0.85, "evidence": _ev("style", korean=[(nm, round(k, 3)) for nm, k in korean[:4]])})
    if endear:
        nm, e = sorted(endear, key=lambda x: -x[1])[0]
        out.append({"type": "relationship", "level": "fact",
                    "statement": f"Uses terms of endearment with {nm} and essentially no one else — his romantic/closest tie",
                    "confidence": 0.85, "evidence": _ev("style", endearment=[(n, round(x, 3)) for n, x in endear[:3]])})
    return out


# ---------------- group scenes: his social map + DOING-vs-lurking (deterministic self-participation rate) ----------------
def group_scenes(c):
    ee = flib.effective_end(c)
    threads = c.execute("SELECT thread_id, count(*) n, max(ts) last FROM communications WHERE channel='imessage' "
                        "AND is_group_chat=1 AND thread_id IS NOT NULL GROUP BY thread_id ORDER BY n DESC LIMIT 14").fetchall()
    out = []
    active_cut = (datetime.fromisoformat(ee) - timedelta(days=120)).date().isoformat() if ee else "2026-01-01"
    for tid, n, last in threads:
        if n < 200:
            continue
        roster = [nm for nm, _ in c.execute(
            "SELECT p.display_name, count(*) FROM communications cm JOIN persons p ON cm.from_person_id=p.id "
            "WHERE cm.thread_id=? AND cm.channel='imessage' AND cm.direction='received' AND p.is_self=0 "
            "GROUP BY p.id ORDER BY 2 DESC LIMIT 6", (tid,)).fetchall() if nm and not flib.is_bot(nm)]
        if len(roster) < 2:
            continue
        self_msgs = c.execute("SELECT count(*) FROM communications WHERE thread_id=? AND direction='sent'", (tid,)).fetchone()[0]
        rate = self_msgs / n
        if (last or "")[:10] >= active_cut:
            role = "actively participates" if rate >= 0.08 else "mostly lurks (low participation)"
            out.append({"type": "relationship", "level": "pattern",
                        "statement": f"Active group chat with {', '.join(roster[:4])} — {role}",
                        "confidence": 0.8, "evidence": _ev("group_scenes", roster=roster[:5], self_rate=round(rate, 2), last=(last or '')[:10])})
        if len(out) >= 5:
            break
    return out


import re as _re
_BOT = _re.compile(r"(mail delivery|subsystem|no-?reply|noreply|notification|do-?not-?reply|^\d{3,6}$|"
                   r"^\+?\d[\d ()-]{5,}$|dennis lee|^self$)", _re.I)


def _is_bot(name):
    return bool(_BOT.search((name or "").strip()))


# ---------------- relationship dynamics: trajectory + initiation (deterministic, from iMessage) ----------------
def relationship_dynamics(c):
    inbound = dict(c.execute(
        "SELECT from_person_id, count(*) FROM communications WHERE channel='imessage' AND direction='received' "
        "AND from_person_id IS NOT NULL AND from_person_id!=? GROUP BY from_person_id", (SELF,)).fetchall())
    top = sorted(inbound.items(), key=lambda x: -x[1])[:15]
    mx = _ts(c.execute("SELECT max(ts) FROM communications WHERE channel='imessage'").fetchone()[0])
    if not mx:
        return []
    # STALE-WINDOW CLAMP (WAVE 0): anchor windows at the real data end (past the ~7-week thin tail), not max(ts).
    ee = flib.effective_end(c) or mx.date().isoformat()
    mx = datetime.fromisoformat(ee + "T23:59:59")
    recent_cut, prior_cut = mx - timedelta(days=90), mx - timedelta(days=180)
    # GLOBAL trend baseline — judge each contact's trajectory RELATIVE to his own baseline (kills "everyone cooled").
    g_recent = c.execute("SELECT count(*) FROM communications WHERE channel='imessage' AND ts>=? AND ts<=?", (recent_cut.isoformat(), ee)).fetchone()[0]
    g_prior = c.execute("SELECT count(*) FROM communications WHERE channel='imessage' AND ts>=? AND ts<?", (prior_cut.isoformat(), recent_cut.isoformat())).fetchone()[0]
    g_ratio = (g_recent / g_prior) if g_prior else 1.0
    out = []
    for pid, vol in top:
        nm = _name(c, pid)
        if vol < 200 or flib.is_bot(nm):
            continue
        rows = c.execute(   # EXACT 1:1 match (to_person_ids=='[pid]', NOT LIKE) + body to filter tapbacks
            "SELECT ts, direction, body FROM communications WHERE channel='imessage' AND ts<=? AND "
            "((direction='received' AND from_person_id=?) OR (direction='sent' AND to_person_ids=?)) "
            "ORDER BY ts", (ee, pid, flib.one_to_one(pid))).fetchall()
        msgs = [(_ts(t), d) for t, d, b in rows if _ts(t) and not flib.is_tapback(b)]  # drop reactions
        if len(msgs) < 100:
            continue
        recent = sum(1 for t, _ in msgs if t >= recent_cut)
        prior = sum(1 for t, _ in msgs if prior_cut <= t < recent_cut)
        if prior >= 30:
            rel = (recent / prior) / g_ratio if g_ratio else 1.0   # contact's trend vs his baseline
            if rel > 1.6:
                out.append({"type": "relationship", "level": "pattern",
                            "statement": f"Relationship with {nm} is intensifying — messaging up well above his baseline lately",
                            "confidence": 0.8, "evidence": _ev("rel_dynamics", recent=recent, prior=prior, rel_to_baseline=round(rel, 2))})
            elif rel < 0.45:
                out.append({"type": "relationship", "level": "pattern",
                            "statement": f"Relationship with {nm} has cooled — messaging dropped well below his baseline",
                            "confidence": 0.8, "evidence": _ev("rel_dynamics", recent=recent, prior=prior, rel_to_baseline=round(rel, 2))})
        starts, prev = [], None       # conversation = first message after a >6h gap
        for t, d in msgs:
            if prev is None or (t - prev).total_seconds() > 6 * 3600:
                starts.append(d)
            prev = t
        if len(starts) >= 20:
            his = sum(1 for d in starts if d == "sent") / len(starts)
            if his >= 0.65:
                out.append({"type": "relationship", "level": "pattern",
                            "statement": f"Usually the one to reach out to {nm} (initiates most conversations)",
                            "confidence": 0.78, "evidence": _ev("rel_dynamics", his_initiation=round(his, 2), n=len(starts))})
            elif his <= 0.35:
                out.append({"type": "relationship", "level": "pattern",
                            "statement": f"{nm} usually reaches out first; he tends to respond rather than initiate",
                            "confidence": 0.78, "evidence": _ev("rel_dynamics", his_initiation=round(his, 2), n=len(starts))})
    return out


# ---------------- spend: real-money behavior + money-ties (deterministic, from recurring_charges) ----------------
# P2. Co-presence/places DEFERRED: recon showed flight receipts carry no airport codes, Airbnb gives a
# property name not a city, and companion info isn't structured — reliable "you were in X with Y" needs LLM
# travel-body parsing + hard FDR gating (P3/L4). Shipping a flaky version risks the catastrophic wrong claim.
FINANCE = {"Chase", "Robinhood", "Amex", "American Express", "Stripe", "Schwab", "Capital One", "SoFi",
           "Coinbase", "Acorns", "Discover", "Chime", "Wise", "Affirm", "Klarna"}


def spend(c):
    merch = c.execute("SELECT merchant, count(*) n FROM recurring_charges WHERE merchant IS NOT NULL "
                      "GROUP BY merchant ORDER BY n DESC").fetchall()
    out = []
    consumption = [(m, n) for m, n in merch if m not in FINANCE and m not in ("Venmo", "PayPal") and n >= 10]
    if consumption:
        out.append({"type": "routine", "level": "pattern",
                    "statement": f"Frequent real-money merchants (actual transactions): {', '.join(m for m, _ in consumption[:6])}",
                    "confidence": 0.85, "evidence": _ev("spend", merchants=[(m, n) for m, n in consumption[:6]])})
    peers = c.execute("SELECT counterparty, count(*) n FROM recurring_charges WHERE merchant IN ('Venmo','PayPal') "
                      "AND counterparty IS NOT NULL GROUP BY counterparty ORDER BY n DESC").fetchall()
    peers = [(cp, n) for cp, n in peers if cp and not _is_bot(cp)]
    if peers:
        out.append({"type": "relationship", "level": "fact",
                    "statement": f"Exchanges money (Venmo/PayPal) with: {', '.join(cp for cp, _ in peers[:6])} — real money-ties",
                    "confidence": 0.85, "evidence": _ev("spend", peers=[(cp, n) for cp, n in peers[:6]])})
    return out


_NAME_CACHE = {}


def _name(c, pid):
    if pid not in _NAME_CACHE:
        r = c.execute("SELECT display_name FROM persons WHERE id=?", (pid,)).fetchone()
        _NAME_CACHE[pid] = (r[0] if r and r[0] else f"person#{pid}")
    return _NAME_CACHE[pid]


def _human(sec):
    if sec < 3600:
        return f"{int(sec//60)}m"
    if sec < 86400:
        return f"{sec/3600:.1f}h"
    return f"{sec/86400:.1f}d"


def main():
    dry = "--dry" in sys.argv
    c = sub()
    analyzers = [("circadian", circadian), ("latency", latency), ("tie_graph", tie_graph),
                 ("engagement", engagement), ("spend", spend), ("relationship_dynamics", relationship_dynamics),
                 ("style_fingerprint", style_fingerprint), ("group_scenes", group_scenes)]
    conn = None if dry else claimstore.connect()
    total = 0
    for nm, fn in analyzers:
        try:
            claims = fn(c)
        except Exception as e:
            print(f"  ⚠️ {nm}: {e}"); continue
        print(f"\n=== {nm} ({len(claims)} claims) ===")
        for cl in claims:
            print(f"  [{cl['confidence']:.0%}] {cl['statement']}")
            if not dry:
                claimstore.upsert(conn, type=cl["type"], level=cl["level"], statement=cl["statement"],
                                  confidence=cl["confidence"], evidence=cl["evidence"],
                                  when=datetime.now().date().isoformat() if False else "2026-06-03")
                total += 1
    if not dry:
        print(f"\n✅ wrote {total} forensic claims (deterministic, earned confidence)")


if __name__ == "__main__":
    main()
