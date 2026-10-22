#!/usr/bin/env python3
"""The reading — feedback with receipts, from Tier 1 alone (8/22 trigger-detection spec, §C).

One command produces co's read of the member: patterns named as observations, each carrying
2-3 verbatim receipts from their own deposits and words. The member supplies the provenance
story — co never plays archaeologist. Register laws, enforced here and not just asked for:

  - observation-not-diagnosis: reads are "you keep …", never "because …" or therapy nouns
  - every receipt is the member's own words, verified by containment against the corpus
    (lived.py LAW 1 generalized: ungrounded receipts kill the pattern, fail closed)
  - thin corpus → nothing. A wrong mirror in week one costs more than ten right ones buy.

    python3 reading.py <tenant>            # print
    python3 reading.py <tenant> --send     # send via the proactive door (gate + belt + dedup)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MIN_ITEMS = 30          # below this the mirror stays dark
MAX_ITEMS = 400         # newest first; enough to see a month, small enough to prompt
_DIGEST_RE = re.compile(r"^\(from our conversations\)")
_DIAGNOSIS_RE = re.compile(r"\b(trauma|triggered?|anxiet|attachment style|coping|inner child|"
                           r"self.?worth|because you(?:'re| are| were))\b", re.I)

SYS = """You are co, reading a member back to themselves from their own record. You write like a
sharp friend texting, lowercase, brief, warm. Led with love: growth frame only, never gotcha,
never diagnosis. You NAME what they keep doing or circling, you never explain WHY they do it.

From the record below, find 2 to 4 real patterns. A pattern must be non-obvious (not "you send
links") and specific to this person. For each, give:
  - "read": one sentence, second person, observation only ("you keep …", "every time X, you Y")
  - "receipts": 2 or 3 items, each {"quote": an EXACT substring copied verbatim from one record
    line (8 to 60 chars, their words not yours), "date": that line's date}
Copy quotes character-for-character from the record. A paraphrase is a fabrication.

Return ONLY JSON: {"patterns": [{"read": str, "receipts": [{"quote": str, "date": str}]}],
"closer": one short line inviting correction, like "tell me which of these actually track"}
If the record is too thin or too flat for a real read, return {"patterns": []}."""


def corpus(tenant: str) -> list[dict]:
    """Tier 1 only: their transcript turns + raw journal captures. Never co's digests."""
    import journal
    items = []
    try:
        msgs = json.load(open(journal._transcript_path(tenant)))
    except Exception:
        msgs = []
    for m in msgs:
        if m.get("role") == "user" and (m.get("content") or "").strip():
            items.append({"when": (m.get("ts") or "")[:10], "text": m["content"].strip()})
    for e in (journal._load(tenant).get("entries") or []):
        t = (e.get("text") or "").strip()
        if t and not _DIGEST_RE.match(t):
            items.append({"when": e.get("date", ""), "text": t})
    seen, out = set(), []
    for it in items:
        k = it["text"][:120]
        if k not in seen:
            seen.add(k)
            out.append(it)
    return out[-MAX_ITEMS:]


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def _grounded(receipt: dict, blob: str) -> bool:
    q = _norm(receipt.get("quote", ""))
    return 8 <= len(q) <= 80 and q in blob


def _day(iso: str) -> str:
    """'2026-08-04' → 'aug 4' — spoken before the dash belt can read a date as a range."""
    try:
        d = dt.date.fromisoformat((iso or "")[:10])
        return f"{d.strftime('%b').lower()} {d.day}"
    except ValueError:
        return iso or "?"


def compose(tenant: str) -> str | None:
    """The read, verified. None means the mirror stays dark today — never a generic filler."""
    import disposition
    import llm
    items = corpus(tenant)
    if len(items) < MIN_ITEMS:
        return None
    record = "\n".join(f"[{it['when']}] {it['text'][:400]}" for it in items)
    got = llm.ask_json(llm.phrase_specs(), SYS, record[-60000:], max_tokens=900)
    if not got or not got.get("patterns"):
        return None
    blob = _norm(record)
    kept = []
    for p in got["patterns"][:4]:
        read = (p.get("read") or "").strip()
        if not read or _DIAGNOSIS_RE.search(read):
            continue
        receipts = [r for r in (p.get("receipts") or []) if _grounded(r, blob)][:3]
        if len(receipts) >= 2:
            kept.append((read, receipts))
    if len(kept) < 2:
        return None
    lines = ["been noticing a few things. none of this is a verdict, just what the record shows."]
    for read, receipts in kept:
        cites = " · ".join(f"“{r['quote'].strip()}” ({_day(r.get('date', ''))})" for r in receipts)
        lines.append(f"{read}\n{cites}")
    closer = (got.get("closer") or "tell me which of these actually track").strip()
    if _DIAGNOSIS_RE.search(closer):
        closer = "tell me which of these actually track"
    lines.append(closer)
    text = disposition.sanitize("\n\n".join(lines))
    if disposition.violations(text, max_chars=1600):
        return None
    _cache(tenant, text)
    return text


def _cache_path(tenant: str) -> str:
    d = os.path.expanduser("~/.co/readings")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{tenant}.json")


def _cache(tenant: str, text: str) -> None:
    try:
        json.dump({"text": text, "date": dt.date.today().isoformat()},
                  open(_cache_path(tenant), "w"), ensure_ascii=False)
    except OSError:
        pass


def cached(tenant: str) -> dict | None:
    """The last reading that actually shipped — the world page renders this, never composes."""
    try:
        d = json.load(open(_cache_path(tenant)))
        return d if (d.get("text") or "").strip() else None
    except Exception:
        return None


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: reading.py <tenant> [--send]")
    tenant = sys.argv[1]
    text = compose(tenant)
    if not text:
        print("(the mirror stays dark — thin corpus or no grounded read)")
        return
    if "--send" in sys.argv:
        import daily_text
        phone = daily_text.tenant_phone(tenant, daily_text._cfg(daily_text.tenant_db(tenant)))
        if phone and daily_text._sendblue(phone, text):
            daily_text.record_outbound(tenant, text)
            print(f"sent to {tenant}")
            return
        print("send failed")
        return
    print(text)


if __name__ == "__main__":
    main()
