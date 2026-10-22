#!/usr/bin/env python3
"""IDENTITY — who the member is, keyed on their phone number (8/28).

Three times today co mistook somebody else's data for the member's: it searched the web for his
own name off a calendar title, turned his description of another founder's ambition into his own
aim, and claimed a friend's forwarded itinerary as his trip. Each fix passed identity in
explicitly, and each fix worked ONLY FOR HIM — because his tenant handle happens to be his name:

    member_names('dennis')       -> ['dennis']            works, by accident
    member_names('p15550001111') -> ['p15550001111']      a phone, not a name

So every guard shipped today comes undone for the second member. That is the actual blocker
between here and anyone else using this, and it is not a config problem: nobody should have to
type their own name into an env file.

THE PHONE NUMBER IS THE KEY and everything else hangs off it. The tenant already derives from the
number; this resolves the rest from what the member has already connected, with no new scopes and
no questions asked:

    emails   Gmail's users/me/profile, which gmail.readonly already permits
    names    the calendar self-attendee's displayName when present, else the address local part
    phone    the tenant itself

An env override survives for the cases discovery cannot reach (a handle that is not a name and no
linked mail), but it is the fallback, not the mechanism.

    python3 identity.py <tenant>
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DIR = os.path.expanduser("~/.co/identity")
STALE_DAYS = 14              # cheap to refresh, and a member's own name rarely moves


def _path(tenant: str) -> str:
    os.makedirs(DIR, exist_ok=True)
    return os.path.join(DIR, f"{tenant}.json")


def _load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {}


def phone(tenant: str) -> str:
    """The key. p15550001111 -> +15550001111; the founder's comes from his handle."""
    if re.fullmatch(r"p\d{7,15}", tenant or ""):
        return "+" + tenant[1:]
    return os.environ.get("CO_FOUNDER_HANDLE", "") if tenant == os.environ.get(
        "CO_FOUNDER_TENANT", "dennis") else ""


def _accounts_for(tenant: str) -> list:
    """Linked Google accounts belonging to THIS member, and no one else.

    gcal._accounts() lists one global directory, so every tenant resolved to whichever account
    happens to be linked on the box — a second member would have inherited the founder's name and
    address wholesale (caught live: identity.resolve('t7') returned 'dennis'). Never inherit
    another tenant's identity: a per-tenant directory if one exists, the flat directory only for
    the founder, and nothing at all otherwise."""
    import gcal
    scoped = os.path.join(os.path.expanduser("~/.co/google"), tenant)
    if os.path.isdir(scoped):
        out = []
        for fn in sorted(os.listdir(scoped)):
            if fn.endswith(".json"):
                try:
                    d = json.load(open(os.path.join(scoped, fn)))
                    if d.get("refresh_token"):
                        d["label"] = fn[:-5]
                        out.append(d)
                except Exception:
                    continue
        return out
    if tenant == os.environ.get("CO_FOUNDER_TENANT", "dennis"):
        return gcal._accounts()
    return []                                  # unlinked member: no identity is better than a wrong one


def _from_local_part(addr: str) -> set:
    """432dennis@example.com -> {dennis}. Digits and separators are noise; what is left is usually
    what people call them."""
    local = (addr or "").split("@")[0].lower()
    out = set()
    for part in re.split(r"[._\-+0-9]+", local):
        if len(part) >= 3:
            out.add(part)
    return out


def resolve(tenant: str, force: bool = False) -> dict:
    """Discover and cache. Never raises: an organ that cannot resolve identity must still run,
    it just runs with less."""
    st = _load(tenant)
    if st and not force:
        try:
            if (dt.date.today() - dt.date.fromisoformat(st.get("at", "1970-01-01"))).days < STALE_DAYS:
                return st
        except ValueError:
            pass
    emails, names = set(), set()
    try:
        import gcal
        import urllib.request
        for acct in _accounts_for(tenant):
            tok = gcal._access(acct)
            if not tok:
                continue
            try:                                    # gmail.readonly covers users.getProfile
                r = urllib.request.Request(
                    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                    headers={"Authorization": f"Bearer {tok}"})
                addr = (json.load(urllib.request.urlopen(r, timeout=15)) or {}).get("emailAddress")
                if addr:
                    emails.add(addr.lower())
                    names |= _from_local_part(addr)
            except Exception:
                pass
    except Exception:
        pass
    # the self-attendee carries a real displayName when the member is invited to anything
    try:
        cal = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
        for e in cal.get("events") or []:
            for a in (e.get("with") or []):
                if a.get("self") and a.get("name"):
                    names |= {w.lower() for w in str(a["name"]).split() if len(w) >= 3}
    except Exception:
        pass
    extra = os.environ.get(f"CO_MEMBER_NAMES_{tenant.upper()}", "")
    names |= {n.strip().lower() for n in extra.split(",") if n.strip()}
    if not re.fullmatch(r"p\d{7,15}", tenant or ""):
        names.add(tenant.lower())                   # a handle that is a name is still evidence
    st = {"tenant": tenant, "phone": phone(tenant), "emails": sorted(emails),
          "names": sorted(n for n in names if n), "at": dt.date.today().isoformat()}
    try:
        json.dump(st, open(_path(tenant), "w"), ensure_ascii=False, indent=1)
    except OSError:
        pass
    return st


def names(tenant: str) -> set:
    """Every string that means "the member". Used to keep co from reading the web about them,
    reading their own mail as a stranger's, or claiming their own address as a correspondent."""
    return set(resolve(tenant).get("names") or []) or {tenant.lower()}


def emails(tenant: str) -> set:
    return set(resolve(tenant).get("emails") or [])


def is_me(tenant: str, s: str) -> bool:
    """Is this string the member? Matches an address exactly, or any name token."""
    t = (s or "").strip().lower()
    if not t:
        return False
    if "@" in t:
        return any(e in t for e in emails(tenant))
    parts = {p for p in re.split(r"[^a-z]+", t) if p}
    return bool(parts & names(tenant)) or t in names(tenant)


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    print(json.dumps(resolve(t, force="--force" in sys.argv), indent=1))
