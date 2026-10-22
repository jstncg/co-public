#!/usr/bin/env python3
"""Calendar — co's eyes on the day and the Time class's hand (8/24).

Reads every linked account's next 48 hours into ~/.co/gcal/today.json on the tick (the
engine injects it as THE DAY); writes exactly one kind of thing: an event on the member's
OWN calendar, title + instructions in the body — the action-space Time class. Never
invites anyone else, never touches other calendars.

    python3 gcal.py sync                   # refresh the day cache
    python3 gcal.py hold "first stream" 2026-08-28T20:00 45 "no title, delete the vod after"
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

GOOGLE_DIR = os.path.expanduser("~/.co/google")
CACHE = os.path.expanduser("~/.co/gcal/today.json")


def accounts_for(tenant: str) -> list[dict]:
    """The member's OWN linked accounts. ~/.co/google/<tenant>/ when it exists; the flat legacy
    directory only for the founder, whose tokens predate per-member linking. Anyone else with no
    directory gets nothing — inheriting another member's mailbox is the worst possible default."""
    scoped = os.path.join(GOOGLE_DIR, tenant or "")
    if tenant and os.path.isdir(scoped):
        out = []
        for f in sorted(os.listdir(scoped)):
            if f.endswith(".json"):
                try:
                    d = json.load(open(os.path.join(scoped, f)))
                    if d.get("refresh_token"):
                        d["label"] = f[:-5]
                        out.append(d)
                except Exception:
                    continue
        return out
    return _accounts() if tenant == os.environ.get("CO_FOUNDER_TENANT", "dennis") else []


def _accounts() -> list[dict]:
    out = []
    try:
        for f in sorted(os.listdir(GOOGLE_DIR)):
            if f.endswith(".json"):
                d = json.load(open(os.path.join(GOOGLE_DIR, f)))
                if d.get("refresh_token"):
                    d["label"] = f[:-5]
                    out.append(d)
    except OSError:
        pass
    return out


def _access(acct: dict) -> str | None:
    data = urllib.parse.urlencode({
        "client_id": acct["client_id"], "client_secret": acct["client_secret"],
        "refresh_token": acct["refresh_token"], "grant_type": "refresh_token",
    }).encode()
    try:
        j = json.load(urllib.request.urlopen(
            urllib.request.Request("https://oauth2.googleapis.com/token", data=data), timeout=15))
        return j.get("access_token")
    except Exception:
        return None


def _get(token: str, url: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def sync(tenant: str | None = None) -> int:
    """Next 48h across THIS MEMBER's linked accounts → the day cache the engine carries.

    Read the flat directory for everyone and a second member's calendar cache would have been
    the founder's day (8/28)."""
    tenant = tenant or os.environ.get("CO_FOUNDER_TENANT", "dennis")
    now = dt.datetime.now(dt.timezone.utc)
    events = []
    for acct in accounts_for(tenant):
        tok = _access(acct)
        if not tok:
            continue
        q = urllib.parse.urlencode({
            "timeMin": now.isoformat(), "timeMax": (now + dt.timedelta(hours=48)).isoformat(),
            "singleEvents": "true", "orderBy": "startTime", "maxResults": "20",
        })
        try:
            j = _get(tok, f"https://www.googleapis.com/calendar/v3/calendars/primary/events?{q}")
        except Exception:
            continue
        for e in j.get("items", []):
            start = (e.get("start") or {}).get("dateTime") or (e.get("start") or {}).get("date") or ""
            # Attendees resolve WHO the meeting is with. A title says "Rafi"; the attendee says
            # rafi@<company>, which pins the person, the company, and roughly the seat in one
            # field. Dropping it forced the meeting read to guess from a first name, and it
            # correctly refused to (8/25). Self is excluded: co never reads up on its member.
            people = []
            for a in (e.get("attendees") or []):
                em = (a.get("email") or "").strip().lower()
                if em and not a.get("self") and not a.get("resource"):
                    people.append({"email": em[:120], "name": (a.get("displayName") or "")[:70]})
            events.append({"account": acct["label"], "start": start,
                           "title": (e.get("summary") or "(untitled)")[:90],
                           "with": people[:6],
                           "made_by_co": "[co]" in (e.get("description") or "")})
    events.sort(key=lambda e: e["start"])
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump({"synced": now.isoformat(timespec="seconds"), "events": events[:24]}, open(CACHE, "w"))
    return len(events)


def hold(title: str, start_iso: str, minutes: int, instructions: str = "",
         account: str | None = None, tenant: str | None = None) -> dict:
    """The Time class: one held hour on THEIR calendar, instructions in the body.
    Returns {ok, receipt|why} — the receipt is the event link, machine-checkable."""
    # WRITES to a calendar. Unscoped, a second member's held hour landed on the FOUNDER's
    # calendar — the worst version of this bug, because it is visible to a third party.
    accts = accounts_for(tenant or os.environ.get("CO_FOUNDER_TENANT", "dennis"))
    if account:
        accts = [a for a in accts if a["label"] == account] or accts
    if not accts:
        return {"ok": False, "why": "no linked google account — run google_link.py first"}
    acct = accts[0]
    tok = _access(acct)
    if not tok:
        return {"ok": False, "why": f"token refresh failed for {acct['label']}"}
    try:
        start = dt.datetime.fromisoformat(start_iso)
    except ValueError:
        return {"ok": False, "why": f"bad start time {start_iso!r} — ISO like 2026-08-28T20:00"}
    end = start + dt.timedelta(minutes=max(10, min(minutes, 8 * 60)))
    body = json.dumps({
        "summary": title[:120],
        "description": (instructions[:800] + "\n\n[co] held on your say-so — delete to undo") if instructions
                        else "[co] held on your say-so — delete to undo",
        "start": {"dateTime": start.isoformat(), "timeZone": os.environ.get("CO_DEFAULT_TZ", "America/Los_Angeles")},
        "end": {"dateTime": end.isoformat(), "timeZone": os.environ.get("CO_DEFAULT_TZ", "America/Los_Angeles")},
    }).encode()
    req = urllib.request.Request(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        data=body, headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    try:
        j = json.load(urllib.request.urlopen(req, timeout=20))
    except Exception as e:
        return {"ok": False, "why": f"calendar refused: {e}"}
    link = j.get("htmlLink") or j.get("id", "")
    try:
        import work
        work.log(os.environ.get("CO_FOUNDER_TENANT", "dennis"), "drafted",
                 f"held {title[:60]} at {start_iso}", url=link)
    except Exception:
        pass
    sync(tenant)
    return {"ok": True, "receipt": link}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "hold":
        print(json.dumps(hold(sys.argv[2], sys.argv[3], int(sys.argv[4]),
                              sys.argv[5] if len(sys.argv) > 5 else "")))
    else:
        print(f"synced {sync()} events")
