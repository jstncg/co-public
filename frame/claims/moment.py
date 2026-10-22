#!/usr/bin/env python3
"""The meeting read — the first moment-attached message (8/25).

Every other proactive lane composes into the morning brief, which attaches to nothing in the
member's day and asks them to build a ritual around it. This one attaches to something that
was already going to happen: it fires ninety minutes before a meeting, because that is when a
read about the person you're about to see is worth anything at all.

The payload is a READ, not a lookup. join.PERSON_SYS asks for "the most useful NEW thing about
them" and returns a news headline with better manners. This asks what they want out of the
meeting, and it may only answer from what their POSITION and RECENT MOVEMENT actually show.
Two people in the same seat want approximately the same things; what differentiates them is
what just moved. Both are sourceable. Personality is not, and is never guessed at.

The motivation receipt: a want-claim ships only with the fact that produced it, and the fact
must appear VERBATIM in the search results (the containment check reading.py already runs on
its patterns). Unsourced reads are the failure mode this whole organ exists to avoid — the
author of this file assigned a man a fund he does not run, one turn after arguing not to.

    python3 moment.py <tenant>            # what is due right now, composed, not sent
    python3 moment.py <tenant> --all      # ignore the window (staging; never burns)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BURN = os.path.expanduser("~/.co/moment_sent.json")
PENDING = os.path.expanduser("~/.co/moment_pending.json")

LEAD_MIN = 90            # the read lands while there is still time to use it
MAX_A_DAY = 1            # a moment lane that fires twice is a notification stream
MIN_BASIS = 12           # a "fact" shorter than this is a fragment, not evidence
MAX_BASIS = 160

READ_SYS = """You are co, reading a person your member is about to meet. You get search results
about them (each with a date) and, if known, why this person is already in the member's world.

Answer only from the results. Two fields carry the read:

WANT — what this person plausibly wants out of a meeting like this, derived from their POSITION
(what they do, where they sit, what they are visibly trying to build or raise or sell) and from
what RECENTLY MOVED for them. Never from personality, temperament, or vibe. If the results do
not establish a position or a movement, there is no want and you must say so.

BASIS — the exact sentence or phrase FROM THE RESULTS that establishes the want. Copy it
verbatim, 12 to 160 characters. Not your paraphrase. If you cannot copy one, ok is false.

KNOW — the one concrete thing worth walking in knowing. May be the same news the basis rests on.

Write want and know in co's voice: lowercase, plain, short, no em-dashes, no hedging, never
narrating that you searched or watched. Under 120 characters each. Never state a title or role
the results do not show. Guessing someone's seat is the exact failure this field exists to stop.

Reply ONLY JSON: {"ok": true|false, "want": "...", "basis": "...", "know": "...", "url": "..."}"""


def _load(path: str) -> dict:
    try:
        return json.load(open(path))
    except Exception:
        return {}


def _burned(tenant: str) -> set:
    return set(_load(BURN).get(tenant) or [])


def _burn(tenant: str, keys: list[str]) -> None:
    d = _load(BURN)
    d[tenant] = (d.get(tenant) or [])[-300:] + keys
    os.makedirs(os.path.dirname(BURN), exist_ok=True)
    json.dump(d, open(BURN, "w"))


def _norm(s: str) -> str:
    """Whitespace and case only. Anything looser stops being a containment check."""
    return " ".join((s or "").split()).lower()


def _grounded(basis: str, source: str) -> bool:
    """The motivation receipt. Same law reading.py runs on its patterns: the evidence has to be
    findable in the source, verbatim, or the claim does not ship. This is the only thing standing
    between a read and a horoscope delivered with confidence."""
    b = _norm(basis)
    return MIN_BASIS <= len(b) <= MAX_BASIS and b in _norm(source)


def _events(tenant: str) -> list[dict]:
    for p in (f"~/.co/gcal/{tenant}_today.json", "~/.co/gcal/today.json"):
        d = _load(os.path.expanduser(p))
        if d.get("events"):
            return d["events"]
    return []


def due(tenant: str, now: dt.datetime | None = None, ignore_window: bool = False) -> list[dict]:
    """Meetings whose read is due: inside the lead window and not yet started. A read that
    arrives after the handshake is worse than none, so a passed meeting is skipped, never
    queued — and never burned either, since nothing was spent on it."""
    now = now or dt.datetime.now()
    today = now.date().isoformat()
    burned = _burned(tenant)
    out = []
    for ev in _events(tenant):
        start = (ev.get("start") or "")
        if start[:10] != today or len(start) < 16:
            continue
        try:
            at = dt.datetime.fromisoformat(start[:16])
        except ValueError:
            continue
        lead = (at - now).total_seconds() / 60.0
        if not ignore_window and not (0 < lead <= LEAD_MIN):
            continue
        # ONE source for the key. Built in two places it drifts the moment the day is injected
        # rather than read from the clock, and a drifted key means a read that repeats.
        key = f"read:{_norm(ev.get('title') or '')}:{today}"
        if key in burned:
            continue
        out.append({"title": ev.get("title") or "", "at": at, "when": start[11:16], "key": key,
                    "with": ev.get("with") or []})
    out.sort(key=lambda e: e["at"])
    return out


def member_names(tenant: str) -> set:
    """Who the member is, so co never reads the web about them.

    Resolved from the PHONE KEY (identity.py) rather than the tenant handle. The handle only
    worked for the founder, whose handle happens to be his name — for anyone else it is
    p15550001111, and every identity guard shipped today silently came undone."""
    try:
        import identity
        return identity.names(tenant)
    except Exception:
        extra = os.environ.get(f"CO_MEMBER_NAMES_{tenant.upper()}", "")
        return {n.strip().lower() for n in ([tenant] + extra.split(",")) if n.strip()}


def _name(title: str, tenant: str) -> str:
    """The OTHER person in the title. "[HOLD] Rafi <> Dennis" returned "Dennis" on the first
    live run — the member — and co went looking up strangers who share his name. The containment
    gate cannot catch that: the basis would be verbatim from real results about a real person.
    Sourcing and identity are different laws, so this one is enforced in code, not in a prompt
    that has no idea who it is working for."""
    import llm
    mine = member_names(tenant)
    got = llm.ask_json(llm.json_specs(),
                       'Extract the OTHER person\'s name from this calendar event title. The '
                       f'member themselves is one of: {sorted(mine)} — never return that person, '
                       'and never a generic word like "sync", "hold", "block", "1:1". A title '
                       'like "[HOLD] A <> B" names two people; return the one who is NOT the '
                       'member. If no other person is named, return an empty string. Reply ONLY '
                       'JSON: {"name": "..."}',
                       title[:200], max_tokens=80) or {}
    n = str(got.get("name") or "").strip()[:70]
    if len(n) < 3:
        return ""
    parts = {p for p in _norm(n).replace(",", " ").split()}
    return "" if (_norm(n) in mine or parts & mine) else n


FREEMAIL = {"gmail.com", "googlemail.com", "icloud.com", "me.com", "outlook.com", "hotmail.com",
            "yahoo.com", "proton.me", "protonmail.com", "aol.com", "live.com", "msn.com"}


def subject(tenant: str, ev: dict) -> dict | None:
    """WHO the meeting is with. The attendee list is the real answer — an address pins the
    person, their company, and roughly their seat at once, where a title only ever offered a
    first name shared by six strangers. The title is the fallback, not the source."""
    mine = member_names(tenant)
    for a in (ev.get("with") or []):
        email = (a.get("email") or "").lower()
        if "@" not in email:
            continue
        local, _, domain = email.partition("@")
        name = (a.get("name") or "").strip() or local.replace(".", " ").replace("_", " ").title()
        if _norm(name) in mine or {p for p in _norm(name).split()} & mine:
            continue
        org = "" if domain in FREEMAIL else domain
        if len(name) >= 3:
            return {"name": name[:70], "email": email[:120], "org": org[:80]}
    n = _name(ev["title"], tenant)
    return {"name": n, "email": "", "org": ""} if n else None


def _receipt(tenant: str, name: str) -> str:
    """Why this person is already theirs, if co knows. Absent for a stranger, which is fine —
    the read stands on position and movement, not on prior contact."""
    try:
        import entities
        for e in entities.load(tenant).get("entities") or []:
            if e.get("name", "").lower() == name.lower():
                return e.get("why") or ""
    except Exception:
        pass
    return ""


def compose(tenant: str, ev: dict) -> dict | None:
    """One meeting → one read, or nothing. Held PENDING: nothing is spent until it is sent."""
    import disposition
    import join
    import llm
    import wrapped
    sub = subject(tenant, ev)
    if not sub:
        return None
    name = sub["name"]
    q = f"{name} {sub['org']}" if sub["org"] else f"{name} founder role company raised launched"
    results = join._context_search(q)
    if not results:
        return None
    blob = "\n".join(f"- [{r.get('date') or 'undated'}] {r['title']} ({r['url']}): "
                     f"{r.get('snippet', '')[:220]}" for r in results)
    why = _receipt(tenant, name)
    got = llm.ask_json(llm.json_specs(), READ_SYS,
                       f"TODAY: {dt.date.today().isoformat()}\nMEETING: {name} at {ev['when']}\n"
                       + (f"THEY ARE AT: {sub['org']} (from the calendar invite, this is the "
                          f"identity anchor — results about a different {name} are the wrong "
                          f"person and must be ignored)\n" if sub["org"] else
                          f"NO ORGANISATION KNOWN. If the results describe several different "
                          f"people named {name}, you cannot tell which one this is: ok is "
                          f"false.\n")
                       + (f"ALREADY IN THEIR WORLD: {why}\n" if why else "")
                       + f"\nRESULTS:\n{blob}", max_tokens=400) or {}
    if not got.get("ok"):
        return None
    want = disposition.sanitize(str(got.get("want") or "").strip())
    know = disposition.sanitize(str(got.get("know") or "").strip())
    basis = str(got.get("basis") or "").strip()
    if not (want and know):
        return None
    if not _grounded(basis, blob):
        return None                        # unsourced want: held, silently, every time
    if disposition.violations(want, max_chars=160) or disposition.violations(know, max_chars=160):
        return None
    for s in (want, know):
        if s and s[0].isupper():
            pass                           # sanitize already lowers co's register; belt only
    want = want[0].lower() + want[1:] if want else want
    know = know[0].lower() + know[1:] if know else know
    text = f"{name.lower()} at {ev['when']}. what they're after: {want}\nworth knowing: {know}"
    url = str(got.get("url") or "").strip()
    if url and wrapped._url_alive(url):
        text += f"\n{url}"
    return {"key": ev["key"], "text": text, "name": name}


def fresh(tenant: str, now: dt.datetime | None = None,
          ignore_window: bool = False) -> list[dict]:
    """Everything due right now, composed. PENDING until the caller confirms a send landed."""
    reads = []
    for ev in due(tenant, now, ignore_window)[:MAX_A_DAY]:
        got = compose(tenant, ev)
        if got:
            reads.append(got)
    if reads and not ignore_window:
        d = _load(PENDING)
        d[tenant] = [r["key"] for r in reads]
        os.makedirs(os.path.dirname(PENDING), exist_ok=True)
        json.dump(d, open(PENDING, "w"))
    return reads


def commit(tenant: str) -> int:
    """The read landed: burn it so the same meeting is never read twice."""
    d = _load(PENDING)
    keys = d.pop(tenant, []) or []
    if keys:
        _burn(tenant, keys)
        json.dump(d, open(PENDING, "w"))
    return len(keys)


def rostered(tenant: str) -> bool:
    """A new proactive lane is opt-in per tenant, like every other one. Nobody gets a message
    from a lane their member never agreed to."""
    import roster
    return roster._rostered(tenant, "CO_MOMENT_TENANTS")


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    allv = "--all" in sys.argv
    got = fresh(t, ignore_window=allv)
    print("\n\n".join(g["text"] for g in got) if got
          else "(nothing due — no meeting inside the window, or no sourceable read)")
