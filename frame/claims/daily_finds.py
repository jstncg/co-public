#!/usr/bin/env python3
"""The daily finds — co sweeps the world against their live wants and texts the brief (8/23).

Founder ask, verbatim shape: "look for more things and send them to me like a daily brief."
Not coaching, not reflection — DELIVERY class: found objects with receipts, aimed by the
corpus (orbit, goals, the list, watches, fresh deposits), never by a generic interest graph.

Laws:
  - queries come from THEIR live material; no material, no brief (abstain beats filler)
  - every find is liveness-checked and NEVER repeated (a sent URL is burned forever)
  - at most one brief a day, morning window, their timezone
  - one message, three finds max, each one why-line in co's voice plus the bare link
  - tenant-gated: CO_DAILY_FINDS_TENANTS (unset = founder only) — a stranger never gets one

    python3 daily_finds.py <tenant>            # stage: print what would send
    python3 daily_finds.py <tenant> --send     # deliver via the gated proactive door
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SENT_PATH = os.path.expanduser("~/.co/daily_finds_sent.json")
STATE_PATH = os.path.expanduser("~/.co/daily_finds_state.json")
MAX_ITEMS = 3
MORNING = (8, 11)          # local send window, inclusive-exclusive

DESKS_DIR = os.path.expanduser("~/.co/desks")

QUERY_SYS = """From this person's live material, write 4 web-search queries that would surface
things THEY would save today: new releases, essays, tools, events, people doing the thing they
are trying to do. Specific beats broad; current beats evergreen. Reply ONLY JSON:
{"queries": ["...", "...", "...", "..."]}"""

DESK_QUERY_SYS = """You run one desk of a personal institution: a standing expert beat serving one
person's becoming. Given the desk's beat and who the person is, write 2 web-search queries that
would surface TODAY'S most relevant developments on this beat for this person. Specific, current,
primary sources. Reply ONLY JSON: {"queries": ["...", "..."]}"""

INTENT_QUERY_SYS = """From this person's recent sends, infer the 1-2 live INTENTS behind them
(what they are actually trying to do or become, not what they literally said). For each intent,
write one web-search query for the thing they DON'T KNOW THEY SHOULD KNOW: the prerequisite, the
pitfall, the tool, or the precedent adjacent to their intent that they haven't asked about.
Never a query for what they already sent. Reply ONLY JSON: {"queries": ["...", "..."]}"""


def desks(tenant: str) -> list[dict]:
    """The member's standing desks (~/.co/desks/<tenant>.json) — each an expert beat serving a
    becoming. No file = no desks; the brief falls back to corpus-derived queries."""
    try:
        j = json.load(open(os.path.join(DESKS_DIR, f"{tenant}.json")))
        return [d for d in (j.get("desks") or []) if (d.get("name") and d.get("beat"))][:8]
    except Exception:
        return []

PICK_SYS = """You are co, texting one person a tiny morning brief of found things. From the
candidates, pick the {n} MOST worth their attention given who they are. For each: one lowercase
why-line in co's voice (specific to THEM, never 'you might like'; no em-dashes, no lists), then
the url. Skip anything stale, thin, or off-target; fewer is fine, zero is fine. Reply ONLY JSON:
{{"picks": [{{"why": "...", "url": "..."}}]}}"""


def _load(path: str) -> dict:
    try:
        return json.load(open(path))
    except Exception:
        return {}


def _save(path: str, d: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(d, open(path, "w"))


def _burned(tenant: str) -> set:
    return set(_load(SENT_PATH).get(tenant) or [])


def _burn(tenant: str, urls: list[str]) -> None:
    d = _load(SENT_PATH)
    d[tenant] = (d.get(tenant) or [])[-800:] + urls
    _save(SENT_PATH, d)


MUTE_PATH = os.path.expanduser("~/.co/daily_finds_mute.json")


def muted_until(tenant: str) -> str:
    return _load(MUTE_PATH).get(tenant) or ""


def mute(tenant: str, days: int = 7) -> str:
    """One text mutes the lane. Bounded by design: silence should never become permanent
    by accident — it lapses, and one 'resume' ends it early."""
    until = (dt.date.today() + dt.timedelta(days=max(1, min(days, 60)))).isoformat()
    d = _load(MUTE_PATH)
    d[tenant] = until
    _save(MUTE_PATH, d)
    return until


def unmute(tenant: str) -> None:
    d = _load(MUTE_PATH)
    d.pop(tenant, None)
    _save(MUTE_PATH, d)


def _sent_today(tenant: str) -> bool:
    return _load(STATE_PATH).get(tenant) == dt.date.today().isoformat()


def _mark_today(tenant: str) -> None:
    d = _load(STATE_PATH)
    d[tenant] = dt.date.today().isoformat()
    _save(STATE_PATH, d)


def _allowed(tenant: str) -> bool:
    allow = [t.strip() for t in os.environ.get("CO_DAILY_FINDS_TENANTS", "").split(",") if t.strip()]
    return tenant in allow if allow else tenant == os.environ.get("CO_FOUNDER_TENANT", "dennis")


def _material(tenant: str) -> str:
    """Their live wants, from every store that holds one. Thin material → empty → no brief."""
    parts = []
    try:
        import wrapped
        ins = wrapped._insight(tenant)
        d = wrapped._compute(tenant)
        if ins.get("goals"):
            parts.append("building toward: " + " · ".join(ins["goals"][:4]))
        if d.get("orbit"):
            parts.append("keeps circling: " + " · ".join(d["orbit"][:6]))
        aim = wrapped.get_aim(tenant)
        if aim:
            parts.append(f"aimed at: {aim}")
        if d.get("watches"):
            parts.append("watching: " + " · ".join(w for w, _ in d["watches"][:4]))
    except Exception:
        pass
    try:
        import list_engine
        live = [i["text"] for i in list_engine.live(tenant)][:6]
        if live:
            parts.append("on the list: " + " · ".join(live))
    except Exception:
        pass
    try:
        import journal
        es = [e.get("text") or "" for e in (journal._load(tenant).get("entries") or [])[-15:]]
        fresh = [t[:120] for t in es if t and not t.startswith("(from our conversations)")][-6:]
        if fresh:
            parts.append("sent lately: " + " · ".join(fresh))
    except Exception:
        pass
    try:
        import gmail_guard
        gf = gmail_guard.flags(tenant)
        if gf:
            parts.append("inbox guard flags: " + " · ".join(gf))
    except Exception:
        pass
    return "\n".join(parts)


def compose(tenant: str) -> str | None:
    """The brief, or None. Every reason to say nothing is honored silently."""
    import disposition
    import llm
    material = _material(tenant)
    if len(material) < 80:
        return None
    dks = desks(tenant)
    queries: list[str] = []
    if dks:
        # Desk mode: each standing beat contributes its own eye on the world.
        for d in dks[:5]:
            got = llm.ask_json(llm.json_specs(), DESK_QUERY_SYS,
                               f"DESK: {d['name']}\nBEAT: {d['beat']}\n\nWHO THEY ARE:\n{material[:1200]}",
                               max_tokens=150) or {}
            queries.extend(str(x) for x in (got.get("queries") or [])[:2] if str(x).strip())
    else:
        q = llm.ask_json(llm.json_specs(), QUERY_SYS, material, max_tokens=250) or {}
        queries = [str(x) for x in (q.get("queries") or []) if str(x).strip()][:4]
    # The didn't-know-you-should-know hunt (8/24): intent inferred from the sends themselves,
    # then the ADJACENT critical thing — prerequisite, pitfall, precedent — they never asked for.
    try:
        iq = llm.ask_json(llm.json_specs(), INTENT_QUERY_SYS, material, max_tokens=150) or {}
        queries.extend(str(x) for x in (iq.get("queries") or [])[:2] if str(x).strip())
    except Exception:
        pass
    if not queries:
        return None
    import research_engine
    import wrapped
    burned = _burned(tenant)
    seen: set = set()
    candidates = []
    for query in queries:
        for f in research_engine._search(query):
            u = f.get("url") or ""
            if not u or u in burned or u in seen:
                continue
            seen.add(u)
            candidates.append(f)
    candidates = candidates[:20]
    if not candidates:
        return None
    blob = "\n".join(f"- {c['title']} ({c['url']}): {c.get('snippet', '')[:180]}" for c in candidates)
    got = llm.ask_json(llm.phrase_specs(), PICK_SYS.format(n=MAX_ITEMS),
                       f"WHO THEY ARE:\n{material}\n\nCANDIDATES:\n{blob}", max_tokens=500) or {}
    picks = []
    for p in (got.get("picks") or [])[:MAX_ITEMS]:
        u = str(p.get("url") or "").strip()
        why = disposition.sanitize(str(p.get("why") or "").strip())
        if not u or not why or u in burned:
            continue
        if not wrapped._url_alive(u):
            continue
        picks.append({"why": why, "url": u})
    if not picks:
        return None
    body = "\n\n".join(f"{p['why']}\n{p['url']}" for p in picks)
    lead = ""
    try:
        # THE JOIN leads (8/25): their world crossed with the world moving. Time-critical
        # first — a person they see today outranks anything they could read later.
        import join as _join
        for j in _join.fresh(tenant)[:2]:
            lead += j + "\n\n"
    except Exception:
        pass
    try:
        # The identity contradiction outranks everything: it is the one sentence about who
        # they are actually becoming, and it fires rarely.
        import becoming as _bc
        _con = _bc.fresh_contradiction(tenant)
        if _con:
            lead += _con + "\n\n"
    except Exception:
        pass
    try:
        # A popped assumption is the highest-value sentence co can write when nothing moved.
        import assumptions
        pops = assumptions.fresh_pops(tenant)
        if pops:
            lead += pops[0] + "\n\n"
    except Exception:
        pass
    try:
        import gmail_guard
        gf = gmail_guard.flags(tenant)
        if gf:
            lead += "heads up: " + " · ".join(gf[:3]) + "\n\n"
    except Exception:
        pass
    text = f"{lead}morning finds\n\n{body}"
    if disposition.violations(text, max_chars=1300):
        return None
    return text


def run_tenant(tenant: str, send: bool = False) -> str:
    if not _allowed(tenant):
        return f"[skip] {tenant} — not on the daily-finds roster"
    mu = muted_until(tenant)
    if mu and mu >= dt.date.today().isoformat():
        return f"[skip] {tenant} — briefs muted until {mu}"
    if _sent_today(tenant):
        return f"[skip] {tenant} — already briefed today"
    import daily_text
    import tz_dynamic
    db = str(daily_text.tenant_db(tenant))
    now = tz_dynamic.now_in(db)
    if not (MORNING[0] <= now.hour < MORNING[1]):
        return f"[hold] {tenant} — outside the morning window ({now.hour}h local)"
    text = compose(tenant)
    if not text:
        _mark_today(tenant)                      # an honest empty spends the day; no retry spam
        return f"[abstain] {tenant} — nothing worth their attention today"
    if not send:
        return f"[stage] {tenant} → {text[:120]!r}"
    phone = daily_text.tenant_phone(tenant, daily_text._cfg(daily_text.tenant_db(tenant)))
    if phone and daily_text._sendblue(phone, text):
        daily_text.record_outbound(tenant, text)
        _mark_today(tenant)
        urls = [ln.strip() for ln in text.split("\n") if ln.startswith("http")]
        _burn(tenant, urls)                      # burned on DELIVERY, never on compose
        for _mod in ("join", "assumptions", "becoming"):      # everything composed spends only on delivery
            try:
                __import__(_mod).commit(tenant)
            except Exception:
                pass
        try:
            import work
            for u in urls:
                work.log(tenant, "found", "morning find delivered", url=u)
        except Exception:
            pass
        return f"[SENT] {tenant} → {text[:100]!r}"
    return f"[fail] {tenant} — send failed"


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    print(run_tenant(t, send="--send" in sys.argv))
