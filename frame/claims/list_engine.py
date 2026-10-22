#!/usr/bin/env python3
"""The list — the member's wants, worked (v2-the-list, 8/12; built 8/22 on the web-first ruling).

ONE object model: an item is the member's words verbatim, in one of six states, and it never
dies silently — it resolves, drops with a stated reason, or holds with a named next_check.

Event-sourced like lived.py: an append-only `list_events` table in the tenant's claims db,
projected on read. The laws live in the projection, not in caller discipline:

  - `open`       captured, untouched
  - `scoped`     co attached a plan comment (what it WOULD do); no work yet
  - `working`    requires a live job ref — the green dot is never faked (sev-0 law)
  - `needs-you`  blocked on something only the member has; the only state that may text
  - `done-by-co` requires receipts; NOT "done" — the member closes
  - `closed`     member's verdict, member's tap only (lived.py LAW 2/4)

Co may add (`co-proposed`), comment, and reorder. Deleting member items is not a thing.
Member text is stored once and never rewritten — renderers belt their own copy.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid

SECTIONS = ["struggles", "research", "people", "wants"]     # closed renders from state
STATES = {"open", "scoped", "working", "needs-you", "done-by-co", "closed", "dropped"}
SOURCES = {"member-app", "member-chat", "co-proposed"}
MEMBER_EVENTS = {"close", "reorder"}                        # only the member's door records these


def _db(tenant: str) -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")


def _conn(tenant: str) -> sqlite3.Connection:
    c = sqlite3.connect(_db(tenant))
    c.execute("""CREATE TABLE IF NOT EXISTS list_events (
        id INTEGER PRIMARY KEY, ts REAL NOT NULL, item TEXT NOT NULL,
        ev TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL)""")
    return c


def _append(tenant: str, item: str, ev: str, actor: str, data: dict) -> None:
    c = _conn(tenant)
    c.execute("INSERT INTO list_events (ts, item, ev, actor, data) VALUES (?,?,?,?,?)",
              (time.time(), item, ev, actor, json.dumps(data, ensure_ascii=False)))
    c.commit()
    c.close()


# ---------------------------------------------------------------- writes

def add(tenant: str, text: str, source: str = "member-app", section: str = "wants") -> str | None:
    text = (text or "").strip()
    if not text or source not in SOURCES:
        return None
    iid = uuid.uuid4().hex[:12]
    actor = "co" if source == "co-proposed" else "member"
    _append(tenant, iid, "add", actor,
            {"text": text[:600], "source": source,
             "section": section if section in SECTIONS else "wants"})
    return iid


def comment(tenant: str, iid: str, text: str, actor: str = "co") -> None:
    if (text or "").strip():
        _append(tenant, iid, "comment", actor, {"text": text.strip()[:400]})


def scope(tenant: str, iid: str, plan: str) -> None:
    """Co says what it WOULD do. A plan is a comment with consequences, so it requires words."""
    if (plan or "").strip():
        _append(tenant, iid, "scope", "co", {"plan": plan.strip()[:400]})


def set_working(tenant: str, iid: str, job_ref: str) -> bool:
    """The green dot needs a live job row behind it — no ref, no state."""
    if not (job_ref or "").strip():
        return False
    _append(tenant, iid, "working", "co", {"job_ref": job_ref.strip()})
    return True


def needs_you(tenant: str, iid: str, what: str) -> None:
    if (what or "").strip():
        _append(tenant, iid, "needs_you", "co", {"what": what.strip()[:300]})


def done_by_co(tenant: str, iid: str, receipts: list[dict]) -> bool:
    """Receipts or it didn't happen — the same discipline the send gate enforces."""
    receipts = [r for r in (receipts or []) if (r.get("what") or "").strip()]
    if not receipts:
        return False
    _append(tenant, iid, "done", "co", {"receipts": receipts[:12]})
    return True


def drop(tenant: str, iid: str, reason: str) -> bool:
    """Co may retire its own dead ends, but never silently and never a member's item —
    refused at the write AND ignored in the projection, so neither path can drift alone."""
    if not (reason or "").strip():
        return False
    it = next((i for i in project(tenant) if i["id"] == iid), None)
    if not it or it["source"] != "co-proposed" or it["state"] == "closed":
        return False
    _append(tenant, iid, "drop", "co", {"reason": reason.strip()[:300]})
    return True


def hold(tenant: str, iid: str, next_check: str) -> None:
    """An item that waits names WHEN co looks again."""
    if (next_check or "").strip():
        _append(tenant, iid, "hold", "co", {"next_check": next_check.strip()[:120]})


def close(tenant: str, iid: str, words: str = "") -> None:
    """Member only — the door is the only caller that records this event."""
    _append(tenant, iid, "close", "member", {"words": (words or "").strip()[:200]})


def reorder(tenant: str, ids: list[str]) -> None:
    ids = [i for i in (ids or []) if isinstance(i, str)][:200]
    if ids:
        _append(tenant, "*", "reorder", "member", {"ids": ids})


# ---------------------------------------------------------------- projection

def project(tenant: str) -> list[dict]:
    if not os.path.exists(_db(tenant)):
        return []
    c = _conn(tenant)
    rows = c.execute("SELECT ts, item, ev, actor, data FROM list_events ORDER BY id").fetchall()
    c.close()
    items: dict[str, dict] = {}
    order: list[str] = []
    for ts, iid, ev, actor, raw in rows:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if ev == "add":
            items[iid] = {"id": iid, "text": data.get("text", ""), "state": "open",
                          "source": data.get("source", "member-app"),
                          "section": data.get("section", "wants"),
                          "created": ts, "updated": ts, "comments": [], "receipts": [],
                          "plan": None, "needs": None, "job_ref": None,
                          "next_check": None, "closed_words": None, "drop_reason": None}
            order.append(iid)
            continue
        if ev == "reorder":
            known = [i for i in data.get("ids", []) if i in items]
            order = known + [i for i in order if i not in known]
            continue
        it = items.get(iid)
        if not it:
            continue
        it["updated"] = ts
        if ev == "comment":
            it["comments"].append({"ts": ts, "actor": actor, "text": data.get("text", "")})
        elif ev == "scope" and it["state"] in ("open", "scoped"):
            it["plan"] = data.get("plan")
            it["state"] = "scoped"
        elif ev == "working" and data.get("job_ref") and it["state"] not in ("closed", "dropped"):
            it["job_ref"] = data["job_ref"]
            it["state"] = "working"
        elif ev == "needs_you" and it["state"] not in ("closed", "dropped"):
            it["needs"] = data.get("what")
            it["state"] = "needs-you"
        elif ev == "done" and data.get("receipts") and it["state"] not in ("closed", "dropped"):
            it["receipts"].extend(data["receipts"])
            it["state"] = "done-by-co"
        elif ev == "hold":
            it["next_check"] = data.get("next_check")
        elif ev == "drop" and actor == "co" and it["source"] == "co-proposed" \
                and it["state"] not in ("closed",):
            # Co retires only what co proposed. Member items are never deleted (spec law).
            it["drop_reason"] = data.get("reason")
            it["state"] = "dropped"
        elif ev == "close" and actor == "member":
            it["closed_words"] = data.get("words") or None
            it["state"] = "closed"
    return [items[i] for i in order if i in items]


def live(tenant: str) -> list[dict]:
    return [i for i in project(tenant) if i["state"] not in ("closed", "dropped")]


def record(tenant: str, payload: dict) -> bool:
    """The member's door (/w/<slug>/list) — the only writer that speaks with member authority."""
    action = (payload or {}).get("action")
    if action == "add":
        return bool(add(tenant, str(payload.get("text") or ""), source="member-app",
                        section=str(payload.get("section") or "wants")))
    if action == "close":
        iid = str(payload.get("id") or "")
        if iid and any(i["id"] == iid for i in project(tenant)):
            close(tenant, iid, str(payload.get("words") or ""))
            return True
        return False
    if action == "comment":
        iid = str(payload.get("id") or "")
        txt = str(payload.get("text") or "")
        if iid and txt.strip() and any(i["id"] == iid for i in project(tenant)):
            comment(tenant, iid, txt, actor="member")
            return True
        return False
    if action == "reorder":
        ids = payload.get("ids")
        if isinstance(ids, list) and ids:
            reorder(tenant, [str(i) for i in ids])
            return True
        return False
    return False
