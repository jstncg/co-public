#!/usr/bin/env python3
"""The propose lane — co formulates the want; the member only ever says yes or no (8/24).

The binding spec (v2-the-list §co-proposed, merged 8/12): naming an outcome is an elite
act; answering yes/no is universal. This lane converts co from a thing you fill in to a
thing you approve — the wedge's core mechanic, live.

LAWS, all enforced in code:
  - FIRING RULE (internal, never shown): a countable pattern PLUS a real window, or no
    proposal. Generators ranked: repetition → stall → window. Counts gate the fire and
    NEVER appear in the message.
  - MESSAGE SHAPE: don't cite evidence, use it. Situation as a friend would say it →
    suggestion as a question → optional sweetener. Never a menu, never "i noticed".
  - Max ONE proposal a day, max THREE live. A no kills it AND down-weights the generating
    pattern. Silence is not a yes: it stays proposed, re-proposable once, months later.
  - A yes becomes a list item (source co-proposed) and enters the normal work loop.
  - SHIP GATE: a judge scores every draft against the being-their-face bar; below bar,
    silence. Tenant roster: CO_PROPOSE_TENANTS (unset = founder only).

    python3 propose_lane.py <tenant>            # stage
    python3 propose_lane.py <tenant> --send     # live
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STORE_DIR = os.path.expanduser("~/.co/propose")
MAX_LIVE = 3
REPROPOSE_DAYS = 60
STALL_DAYS = 5
EVENING = (17, 21)
QUALITY_BAR = 8

COMPOSE_SYS = """You are co, texting one person you know deeply. From the pattern and the window
below, propose ONE MOVE. Not advice, not a plan, not a menu — a single small physical thing they
could actually do inside the next 48 hours, sized to one sitting, reversible, with the friction
already removed. Name the concrete when and where when you know it. The shape: the situation as
a sharp friend would say it, then the move as a question, then optionally one line that makes
yes cheaper.

Good: "you're free 10:15 to 11. the run-through once, out loud, in the car. want it held?"
Good: "gym's on the way back from the 4pm. bag's already in your trunk. going?"
Bad: anything that starts with "i noticed", anything citing counts, anything asking them to
plan, reflect, think about, or consider. Never a list. Never two questions.

Lowercase texting register, no em-dashes, under 200 characters. Reply ONLY JSON:
{"text": "..."} or {"text": null} if no honest single move exists here."""

JUDGE_SYS = """Score this proposed text 1-10 against one bar: would it land as a sharp friend who
knows them, or as a bot doing surveillance? Deduct hard for: citing evidence or counts, "i
noticed", generic-anyone phrasing, advice-shaped instead of question-shaped, any hint of a menu,
creepiness, over-familiarity beyond the material shown. Reply ONLY JSON: {"score": n, "why": "..."}"""

YESNO_SYS = """A proposal question was texted to someone. Classify their reply. Reply ONLY JSON:
{"verdict": "yes" | "no" | "unclear"}. yes = agreement/acceptance in any casual form. no =
decline, deflection, or pushback. unclear = anything else."""


def _path(tenant: str) -> str:
    os.makedirs(STORE_DIR, exist_ok=True)
    return os.path.join(STORE_DIR, f"{tenant}.json")


def _load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {"proposals": [], "down_weights": {}}


def _save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False)


def _allowed(tenant: str) -> bool:
    allow = [t.strip() for t in os.environ.get("CO_PROPOSE_TENANTS", "").split(",") if t.strip()]
    return tenant in allow if allow else tenant == os.environ.get("CO_FOUNDER_TENANT", "dennis")


def _live(st: dict) -> list[dict]:
    return [p for p in st["proposals"] if p.get("status") in ("sent", "silent")]


def _sent_today(st: dict) -> bool:
    today = dt.date.today().isoformat()
    return any((p.get("created") or "")[:10] == today for p in st["proposals"])


# ---------------------------------------------------------------- generators

def _candidates(tenant: str, st: dict) -> list[dict]:
    """Countable pattern + real window, ranked repetition → stall → window. Each candidate:
    {key, pattern, window}. Down-weighted keys need a stronger showing to fire again."""
    out = []
    dw = st.get("down_weights", {})
    burned = {p.get("key") for p in st["proposals"] if p.get("status") in ("sent", "silent", "no")}
    today = dt.date.today()
    try:
        import wrapped
        d = wrapped._compute(tenant)
        # REPETITION: a theme they keep circling, still warm (the rooms already count it).
        tiles = wrapped._tiles(tenant)
        rooms = wrapped._rooms(tenant, tiles, d.get("orbit") or [])
        for r in rooms[:4]:
            n = len(r.get("items") or [])
            need = 4 + 2 * dw.get(f"rep:{r['theme']}", 0)
            if n >= need and f"rep:{r['theme']}" not in burned:
                out.append({"key": f"rep:{r['theme']}",
                            "pattern": f"they keep circling '{r['theme']}' ({n} recent sends)",
                            "window": "this weekend is open ground"})
    except Exception:
        pass
    try:
        # STALL: a list item they named, then never touched.
        import list_engine
        for it in list_engine.live(tenant):
            if it["state"] not in ("open", "scoped"):
                continue
            age = (dt.datetime.now().timestamp() - it["updated"]) / 86400
            key = f"stall:{it['id']}"
            if age >= STALL_DAYS + 3 * dw.get(key, 0) and key not in burned:
                out.append({"key": key,
                            "pattern": f"they put '{it['text'][:80]}' on their own list {int(age)} days ago and haven't moved",
                            "window": "a small first step fits any evening this week"})
    except Exception:
        pass
    try:
        # THE GAP (8/24, Abelique): real empty time tomorrow, against something they want. The
        # most doable proposal there is, because the when is already answered.
        cal = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
        evs = sorted((e for e in cal.get("events", []) if e.get("start")), key=lambda e: e["start"])
        for i, ev in enumerate(evs[:6]):
            try:
                s = dt.datetime.fromisoformat(ev["start"].replace("Z", "+00:00"))
            except Exception:
                continue
            prev_end = None
            if i:
                try:
                    prev_end = dt.datetime.fromisoformat(evs[i - 1]["start"].replace("Z", "+00:00")) \
                        + dt.timedelta(hours=1)
                except Exception:
                    prev_end = None
            gap_start = prev_end or (s - dt.timedelta(hours=2))
            mins = int((s - gap_start).total_seconds() // 60)
            key = f"gap:{s.date().isoformat()}:{s.hour}"
            if 40 <= mins <= 180 and key not in burned and not dw.get(key):
                out.append({"key": key,
                            "pattern": "they keep saying they want time for their own work and never take it",
                            "window": (f"{mins} genuinely empty minutes before '{ev['title'][:40]}' "
                                       f"on {s.strftime('%A')} at {gap_start.strftime('%-I:%M')}")})
                break
    except Exception:
        pass
    try:
        # WINDOW: a promised date coming at them inside 3 days (anchors know).
        import anchors
        import journal
        st_a = anchors._load(journal._claims_db(tenant))
        for a in st_a.get("anchors", []):
            if a.get("fired"):
                continue
            try:
                when = dt.datetime.fromisoformat(a["when"]).date()
            except Exception:
                continue
            key = f"win:{(a.get('what') or '')[:40]}"
            if 0 <= (when - today).days <= 3 and key not in burned and not dw.get(key):
                out.append({"key": key,
                            "pattern": f"'{a.get('what')}' is theirs and it lands {when.isoformat()}",
                            "window": f"{(when - today).days} days out"})
    except Exception:
        pass
    return out


# ---------------------------------------------------------------- compose + judge

def compose(tenant: str) -> dict | None:
    """One proposal, judged, or None. Every abstention is silent by design."""
    import llm
    st = _load(tenant)
    if _sent_today(st) or len(_live(st)) >= MAX_LIVE:
        return None
    for cand in _candidates(tenant, st):
        got = llm.ask_json(llm.phrase_specs(), COMPOSE_SYS,
                           f"PATTERN: {cand['pattern']}\nWINDOW: {cand['window']}", max_tokens=200) or {}
        text = got.get("text")
        if not text or str(text).lower() == "null":
            continue
        import disposition
        text = disposition.sanitize(str(text).strip())
        if disposition.violations(text, max_chars=240) or re.search(r"\bi noticed\b|\d+ (times|sends)", text, re.I):
            continue
        judge = llm.ask_json(llm.json_specs(), JUDGE_SYS, text, max_tokens=120) or {}
        score = judge.get("score")
        if not isinstance(score, (int, float)) or score < QUALITY_BAR:
            continue
        return {"key": cand["key"], "text": text, "score": score}
    return None


# ---------------------------------------------------------------- verdict sweep

def sweep_replies(tenant: str) -> list[str]:
    """Yesterday's proposal meets today's thread: yes → list item; no → down-weight; else silent."""
    import llm
    st = _load(tenant)
    out = []
    open_props = [p for p in st["proposals"] if p.get("status") == "sent"]
    if not open_props:
        return out
    try:
        import journal
        turns = json.load(open(journal._claims_db(tenant) + ".transcript.json"))
    except Exception:
        return out
    for p in open_props:
        after = [t for t in turns if t.get("role") == "user"
                 and (t.get("ts") or "") > (p.get("created") or "")][:3]
        if not after:
            if (dt.datetime.now() - dt.datetime.fromisoformat(p["created"])).days >= 2:
                p["status"] = "silent"                       # not a yes; re-proposable much later
            continue
        reply = " / ".join((t.get("content") or "")[:120] for t in after)
        got = llm.ask_json(llm.json_specs(), YESNO_SYS,
                           f"proposal: {p['text']}\ntheir replies after it: {reply}", max_tokens=60) or {}
        v = got.get("verdict")
        if v == "yes":
            try:
                import list_engine
                iid = list_engine.add(tenant, p["text"][:200], source="co-proposed")
                if iid:
                    p["item_id"] = iid           # the item now rides the normal work loop
            except Exception:
                pass
            p["status"] = "yes"
            out.append(f"yes:{p['key']}")
        elif v == "no":
            p["status"] = "no"
            st["down_weights"][p["key"]] = st["down_weights"].get(p["key"], 0) + 1
            out.append(f"no:{p['key']} (down-weighted)")
    _save(tenant, st)
    return out


# ---------------------------------------------------------------- the lane

def run_tenant(tenant: str, send: bool = False) -> str:
    if not _allowed(tenant):
        return f"[skip] {tenant} — not on the propose roster"
    moved = sweep_replies(tenant)
    prefix = f"(verdicts: {', '.join(moved)}) " if moved else ""
    import daily_text
    import tz_dynamic
    now = tz_dynamic.now_in(str(daily_text.tenant_db(tenant)))
    if not (EVENING[0] <= now.hour < EVENING[1]):
        return f"[hold] {prefix}{tenant} — outside the evening window ({now.hour}h local)"
    got = compose(tenant)
    if not got:
        return f"[abstain] {prefix}{tenant} — nothing clears the bar"
    if not send:
        return f"[stage] {prefix}{tenant} (score {got['score']}) → {got['text']!r}"
    phone = daily_text.tenant_phone(tenant, daily_text._cfg(daily_text.tenant_db(tenant)))
    if phone and daily_text._sendblue(phone, got["text"]):
        daily_text.record_outbound(tenant, got["text"])
        st = _load(tenant)
        st["proposals"].append({"id": uuid.uuid4().hex[:10], "key": got["key"], "text": got["text"],
                                "created": dt.datetime.now().isoformat(timespec="seconds"),
                                "status": "sent", "outcome_log": []})
        _save(tenant, st)
        return f"[SENT] {prefix}{tenant} → {got['text']!r}"
    return f"[fail] {tenant} — send failed"


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    print(run_tenant(t, send="--send" in sys.argv))
