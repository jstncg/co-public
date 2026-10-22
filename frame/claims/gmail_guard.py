#!/usr/bin/env python3
"""The Gmail guard — read-only eyes on the inbox, the action-space Guard class (8/24).

Sweeps the last two days of every linked account for the defensive classes: renewals
about to bite, deadlines in fine print, commitments made to the member, money leaving.
Writes candidates to ~/.co/guard/<tenant>.json; the morning brief carries the flags.
READ-ONLY BY SCOPE (gmail.readonly) and by law: co never sends mail, ever.

    python3 gmail_guard.py                 # sweep now, print flags
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT_DIR = os.path.expanduser("~/.co/guard")
MAX_SCAN = 40

SYS = """You triage inbox items for one person's guard. Flag ONLY the defensive classes:
subscription renewals or price increases about to hit, real deadlines (lease, filing, RSVP,
expiring offer with a date), commitments someone made TO them, money leaving (charges,
invoices). Ignore newsletters, promos, notifications, social, receipts for things already
known. For each flag: one lowercase line saying the thing and its date if present. At most 5;
zero is the common right answer. Reply ONLY JSON: {"flags": ["...", "..."]}"""


def _access(acct: dict) -> str | None:
    import gcal
    return gcal._access(acct)


def sweep(tenant: str | None = None) -> list[str]:
    # CROSS-MEMBER LEAK (8/28): this read gcal._accounts(), one global directory, so every
    # tenant swept the FOUNDER's mailbox. A second member's brief would have been built from
    # his inbox. accounts_for() returns only what that member linked, and nothing otherwise.
    import gcal
    import llm
    tenant = tenant or os.environ.get("CO_FOUNDER_TENANT", "dennis")
    items = []
    for acct in gcal.accounts_for(tenant):
        tok = _access(acct)
        if not tok:
            continue
        q = urllib.parse.urlencode({"q": "newer_than:2d category:primary", "maxResults": str(MAX_SCAN)})
        try:
            req = urllib.request.Request(
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages?{q}",
                headers={"Authorization": f"Bearer {tok}"})
            ids = [m["id"] for m in (json.load(urllib.request.urlopen(req, timeout=20)).get("messages") or [])]
        except Exception:
            continue
        for mid in ids[:MAX_SCAN]:
            try:
                req = urllib.request.Request(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{mid}"
                    "?format=metadata&metadataHeaders=Subject&metadataHeaders=From",
                    headers={"Authorization": f"Bearer {tok}"})
                m = json.load(urllib.request.urlopen(req, timeout=15))
            except Exception:
                continue
            hdrs = {h["name"]: h["value"] for h in (m.get("payload", {}).get("headers") or [])}
            items.append(f"[{acct['label']}] from: {hdrs.get('From', '?')[:60]} · "
                         f"subject: {hdrs.get('Subject', '?')[:90]} · {m.get('snippet', '')[:120]}")
    if not items:
        return []
    got = llm.ask_json(llm.json_specs(), SYS, "\n".join(items[:80]), max_tokens=300) or {}
    flags = [str(f)[:160] for f in (got.get("flags") or []) if str(f).strip()][:5]
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump({"flags": flags, "swept": dt.datetime.now().isoformat(timespec="seconds")},
              open(os.path.join(OUT_DIR, f"{tenant}.json"), "w"), ensure_ascii=False)
    return flags


def search(query: str, limit: int = 8, tenant: str | None = None) -> list[dict]:
    """Read-only inbox search for the CONVERSATIONAL engine (8/25). The guard has had inbox
    access since this morning, but the agent had no tool for it, so 'go read my emails' got
    'I'm fully locked out' — the never-deny-a-power-you-have law broken by an organ/engine
    gap rather than by the prompt. Returns metadata and snippets; co never sends mail."""
    import gcal
    tenant = tenant or os.environ.get("CO_FOUNDER_TENANT", "dennis")
    out = []
    for acct in gcal.accounts_for(tenant):
        tok = _access(acct)
        if not tok:
            continue
        q = urllib.parse.urlencode({"q": query or "newer_than:7d", "maxResults": str(limit)})
        try:
            req = urllib.request.Request(
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages?{q}",
                headers={"Authorization": f"Bearer {tok}"})
            ids = [m["id"] for m in (json.load(urllib.request.urlopen(req, timeout=20)).get("messages") or [])]
        except Exception:
            continue
        for mid in ids[:limit]:
            try:
                req = urllib.request.Request(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{mid}"
                    "?format=metadata&metadataHeaders=Subject&metadataHeaders=From"
                    "&metadataHeaders=Date&metadataHeaders=To",
                    headers={"Authorization": f"Bearer {tok}"})
                m = json.load(urllib.request.urlopen(req, timeout=15))
            except Exception:
                continue
            h = {x["name"]: x["value"] for x in (m.get("payload", {}).get("headers") or [])}
            # TO is required for in:sent queries: on sent mail From is the member themselves,
            # so a counterpart cannot be identified without it (8/27, the drift detector).
            out.append({"account": acct["label"], "from": h.get("From", "")[:80],
                        "to": h.get("To", "")[:120],
                        "subject": h.get("Subject", "")[:120], "date": h.get("Date", "")[:31],
                        "snippet": (m.get("snippet") or "")[:220]})
        if len(out) >= limit:
            break
    return out[:limit]


def flags(tenant: str) -> list[str]:
    try:
        d = json.load(open(os.path.join(OUT_DIR, f"{tenant}.json")))
        if (d.get("swept") or "") >= (dt.datetime.now() - dt.timedelta(days=2)).isoformat():
            return d.get("flags") or []
    except Exception:
        pass
    return []


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "search":
        print(json.dumps({"ok": True, "results": search(" ".join(sys.argv[2:]))}))
    else:
        for f in sweep():
            print("-", f)
