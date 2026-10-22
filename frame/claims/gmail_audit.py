#!/usr/bin/env python3
"""THE AUDIT — value in the first five minutes, from mail they already had (8/27).

Time to first value is the most reliable killer in consumer products, and co's was measured in
weeks: its whole model of a member had to accrete from things they sent it. This closes that.

The engineering move is to QUERY the archive rather than ingest it. Gmail's search index is
already built and free; co does not need to read four years of mail, it needs ~20 aimed queries
that each return tens of results, fetched metadata-only. Weeks of corpus becomes minutes of API
calls, and none of it needs a model of the person.

The ordering is consumer psychology, not engineering: MONEY first because loss aversion beats
gain and a dollar figure is concrete and impossible to be embarrassed by, then PEOPLE because
that is where the emotional weight is, then EXPIRING because it carries the deadline.

Everything it surfaces is witnessed and unindexed — facts about one person's life that no model
could generate, which is exactly the class that survives everyone having a genie.

    python3 gmail_audit.py <tenant>              # run it, print the number
    python3 gmail_audit.py <tenant> --json       # the structured result
"""
from __future__ import annotations

import concurrent.futures as futures
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT_DIR = os.path.expanduser("~/.co/audit")
PER_QUERY = 40                # results per probe; the classes are narrow, not exhaustive
WORKERS = 8

# The query plan IS the product. Each probe is narrow enough that its hits are almost all real,
# because a broad query returns a corpus and a corpus needs a model to interpret.
PROBES = [
    # ---- money leaving -------------------------------------------------------------
    ("recurring", 'subject:(receipt OR invoice OR "payment to" OR subscription) newer_than:2y'),
    ("trials",    '("your trial" OR "trial ends" OR "trial will end" OR "you will be charged") newer_than:1y'),
    ("increases", '("price increase" OR "updating our prices" OR "change to your subscription" '
                  'OR "new price") newer_than:2y'),
    ("renewals",  '("will renew" OR "auto-renew" OR "renews on" OR "renewal notice") newer_than:1y'),
    # ---- money owed back -----------------------------------------------------------
    ("delays",    '(subject:(delayed OR cancelled) flight) OR "your flight was delayed" newer_than:3y'),
    ("refunds",   '("we have refunded" OR "refund request" OR "return label") newer_than:1y'),
    # ---- expiring value ------------------------------------------------------------
    ("expiring",  '(credit OR voucher OR points OR miles OR "gift card") (expire OR expiring OR expires) '
                  'newer_than:1y'),
    ("docs",      '(passport OR licence OR license OR visa) (expire OR expires OR renewal) newer_than:2y'),
    # ---- promises made -------------------------------------------------------------
    ("promised",  'from:me ("i\'ll follow up" OR "let me get back to you" OR "i\'ll send" '
                  'OR "will circle back" OR "i\'ll intro") newer_than:1y'),
    ("intros",    '(subject:(intro OR introduction OR "connecting you")) newer_than:1y'),
]

CLASS_SYS = """You are auditing one person's mail. You get subject lines and senders for one narrow
class. Extract only CONCRETE, SPECIFIC items — a named service, a named person, a real amount or
date. Merge duplicates hard: twelve monthly receipts from one service is ONE item, not twelve.

Never invent an amount. If the subject does not state one, leave amount empty.

Reply ONLY JSON: {"items":[{"what":"...","who":"...","amount":"","when":"","note":""}]}
what: 4-9 words, lowercase, the thing itself. who: the service or person. amount: as written or "".
when: a date if one is stated, else "". note: at most 10 words, only if it changes the meaning."""


def _access(acct: dict) -> str | None:
    import gcal
    return gcal._access(acct)


def _search(tok: str, q: str, limit: int = PER_QUERY) -> list[str]:
    qs = urllib.parse.urlencode({"q": q, "maxResults": str(limit)})
    try:
        req = urllib.request.Request(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages?{qs}",
            headers={"Authorization": f"Bearer {tok}"})
        j = json.load(urllib.request.urlopen(req, timeout=25))
        return [m["id"] for m in (j.get("messages") or [])]
    except Exception:
        return []


def _meta(tok: str, mid: str) -> dict | None:
    """Metadata only. Bodies are the expensive part and the subject line carries the class."""
    try:
        req = urllib.request.Request(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{mid}"
            "?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date",
            headers={"Authorization": f"Bearer {tok}"})
        m = json.load(urllib.request.urlopen(req, timeout=20))
    except Exception:
        return None
    h = {x["name"]: x["value"] for x in (m.get("payload", {}).get("headers") or [])}
    return {"from": h.get("From", "")[:70], "subject": h.get("Subject", "")[:110],
            "date": h.get("Date", "")[:16], "snippet": (m.get("snippet") or "")[:100]}


def probe(tok: str, name: str, q: str) -> tuple[str, list[dict]]:
    ids = _search(tok, q)
    if not ids:
        return name, []
    with futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        rows = [r for r in ex.map(lambda i: _meta(tok, i), ids) if r]
    return name, rows


def _extract(name: str, rows: list[dict]) -> list[dict]:
    import llm
    if not rows:
        return []
    blob = "\n".join(f"- [{r['date']}] {r['from']} · {r['subject']}" for r in rows[:PER_QUERY])
    got = llm.ask_json(llm.json_specs(), CLASS_SYS, f"CLASS: {name}\n\n{blob}", max_tokens=1400) or {}
    out = []
    for it in (got.get("items") or [])[:12]:
        what = str(it.get("what") or "").strip()[:70]
        if what:
            out.append({"class": name, "what": what, "who": str(it.get("who") or "")[:50],
                        "amount": str(it.get("amount") or "")[:20],
                        "when": str(it.get("when") or "")[:24],
                        "note": str(it.get("note") or "")[:70]})
    return out


def run(tenant: str, probes: list | None = None) -> dict:
    """Every probe against every linked account, in parallel. Minutes, not weeks."""
    import gcal
    probes = probes or PROBES
    found: list[dict] = []
    scanned = 0
    for acct in gcal.accounts_for(tenant):
        tok = _access(acct)
        if not tok:
            continue
        with futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            hits = list(ex.map(lambda p: probe(tok, p[0], p[1]), probes))
        for name, rows in hits:
            scanned += len(rows)
            found.extend(_extract(name, rows))
    res = {"tenant": tenant, "ran": dt.datetime.now().isoformat(timespec="seconds"),
           "scanned": scanned, "items": found}
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(res, open(os.path.join(OUT_DIR, f"{tenant}.json"), "w"), ensure_ascii=False)
    return res


# Loss first, then people, then deadlines — the order is consumer psychology, not engineering.
ORDER = ["recurring", "renewals", "increases", "trials", "delays", "refunds",
         "promised", "intros", "expiring", "docs"]
HEADS = {"recurring": "paying for", "renewals": "renewing", "increases": "went up",
         "trials": "about to charge you", "delays": "owed to you", "refunds": "refunds",
         "promised": "you said you would", "intros": "introductions", "expiring": "expiring",
         "docs": "documents"}


def render(res: dict) -> str:
    by: dict[str, list] = {}
    for it in res.get("items") or []:
        by.setdefault(it["class"], []).append(it)
    out = []
    for k in ORDER:
        if not by.get(k):
            continue
        out.append(f"\n{HEADS[k].upper()}")
        for it in by[k][:8]:
            amt = f"  {it['amount']}" if it["amount"] else ""
            when = f"  ({it['when']})" if it["when"] else ""
            out.append(f"  · {it['what']}{amt}{when}")
    return "\n".join(out) if out else "(nothing found — either a clean inbox or the probes missed)"



# ── STAGE TWO: the number ────────────────────────────────────────────────────────────────────
# Stage one deliberately reads metadata only, which is what makes it fast — and it is why the
# first run produced a LIST rather than a NUMBER. Subject lines almost never state an amount.
# Without the figure the whole loss-aversion argument collapses, so this stage pays for bodies,
# but only for the ~30 items already confirmed to be recurring rather than the 254 scanned.
#
# The amount must appear VERBATIM in the body. The model picks which of the real amounts is the
# charge; it may never produce one. Same containment law the meeting read runs on: an unsourced
# number is worse than no number, because a wrong total is confidently actionable.

import re as _re

MONEY_RE = _re.compile(r"(?:US)?[$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?")
PER_YEAR = {"monthly": 12, "annual": 1, "yearly": 1, "weekly": 52, "quarterly": 4, "once": 0}
MONEY_CLASSES = ("recurring", "renewals", "trials", "increases")

PRICE_SYS = """You are given the AMOUNTS that literally appear in receipts for one service, plus the
subject lines. Decide what this person actually pays and how often.

Choose the amount from the CANDIDATES list only. Never write an amount that is not in that list.
If none of them is the recurring charge (they are shipping costs, totals of other things, credits,
or marketing), return found=false.

cadence must be one of: monthly, annual, weekly, quarterly, once.

Reply ONLY JSON: {"found": true|false, "amount": "$X.XX", "cadence": "monthly", "service": "..."}"""


def _body(tok: str, mid: str) -> str:
    """Decoded text of one message. Bodies are the expensive call, which is why only confirmed
    recurring items get one."""
    import base64
    try:
        req = urllib.request.Request(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{mid}?format=full",
            headers={"Authorization": f"Bearer {tok}"})
        m = json.load(urllib.request.urlopen(req, timeout=25))
    except Exception:
        return ""
    out, stack = [], [m.get("payload") or {}]
    while stack:
        p = stack.pop()
        if p.get("mimeType", "").startswith("text/"):
            d = (p.get("body") or {}).get("data") or ""
            if d:
                try:
                    out.append(base64.urlsafe_b64decode(d + "==").decode("utf-8", "ignore"))
                except Exception:
                    pass
        stack.extend(p.get("parts") or [])
    txt = "\n".join(out)
    txt = _re.sub(r"<[^>]{1,400}>", " ", txt)              # strip tags, keep the text between
    return _re.sub(r"[ \t]{2,}", " ", txt)[:12000]


def _price_one(tok: str, who: str) -> dict | None:
    """One service → what it costs. Searches its own receipts, reads at most two."""
    import llm
    q = f'from:({who}) OR subject:({who}) (receipt OR invoice OR payment OR renew OR charged) newer_than:18m'
    ids = _search(tok, q, limit=3)
    cands, subs = [], []
    for mid in ids[:2]:
        md = _meta(tok, mid)
        if md:
            subs.append(md["subject"])
        body = _body(tok, mid)
        cands.extend(MONEY_RE.findall(body)[:40])
    cands = list(dict.fromkeys(c.strip() for c in cands))[:30]
    if not cands:
        return None
    got = llm.ask_json(llm.json_specs(), PRICE_SYS,
                       f"SERVICE: {who}\nSUBJECTS: {' | '.join(subs[:3])}\n"
                       f"CANDIDATES: {', '.join(cands)}", max_tokens=200) or {}
    amt = str(got.get("amount") or "").strip()
    if not got.get("found") or amt not in cands:
        return None                                        # containment: pick a real one or none
    cad = str(got.get("cadence") or "").lower()
    if cad not in PER_YEAR:
        return None
    return {"who": who, "amount": amt, "cadence": cad, "per_year": PER_YEAR[cad]}


def _num(a: str) -> float:
    try:
        return float(_re.sub(r"[^\d.]", "", a) or 0)
    except ValueError:
        return 0.0


def price(tenant: str, res: dict | None = None) -> dict:
    """The number. Annualised, from amounts that literally appear in the member's own receipts."""
    res = res or json.load(open(os.path.join(OUT_DIR, f"{tenant}.json")))
    import gcal
    accts = [a for a in gcal.accounts_for(tenant) if _access(a)]
    if not accts:
        return {"total": 0, "priced": []}
    tok = _access(accts[0])
    whos, seen = [], set()
    for it in res.get("items") or []:
        w = (it.get("who") or "").strip()
        if it["class"] in MONEY_CLASSES and w and w.lower() not in seen:
            seen.add(w.lower())
            whos.append(w)
    with futures.ThreadPoolExecutor(max_workers=6) as ex:
        priced = [p for p in ex.map(lambda w: _price_one(tok, w), whos[:40]) if p]
    total = sum(_num(p["amount"]) * p["per_year"] for p in priced)
    out = {"total": round(total, 2), "priced": sorted(priced, key=lambda p: -_num(p["amount"]) * p["per_year"])}
    res["price"] = out
    json.dump(res, open(os.path.join(OUT_DIR, f"{tenant}.json"), "w"), ensure_ascii=False)
    return out

if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    if "--price" in sys.argv:
        p = price(t)
        print(f"\n  ${p['total']:,.0f} / year across {len(p['priced'])} priced services\n")
        for x in p["priced"]:
            yr = _num(x["amount"]) * x["per_year"]
            print(f"  {x['who'][:34]:34s} {x['amount']:>10s} {x['cadence']:<10s} ${yr:,.0f}/yr")
        raise SystemExit
    r = run(t)
    if "--json" in sys.argv:
        print(json.dumps(r, indent=1)[:4000])
    else:
        print(f"scanned {r['scanned']} messages · found {len(r['items'])} things")
        print(render(r))
