#!/usr/bin/env python3
"""THE STAFF — groundwork on the thing they keep not doing (the mold's organ, v0).

The wedge in code: find the ONE thing this person keeps circling and not doing, do the
80% that's friction — the digging, the specifics, the draft in their voice, the fact
that kills the fear — and hand it over with the 20% left deliberately undone. The leap
stays theirs (belief 18: self-belief is earned next to proof; the split-is-personal
amendment: TAKE THE FRICTION, NEVER THE MEANING).

Selection is ABSTAIN-BIASED and evidence-bound: the avoided thing must be visible in
their own material (threads circled 2+, commitments made and not closed, an ask that
went quiet). No target in evidence → silence, exit 0, correct outcome. Never invent
homework for someone — that's the to-do-list app this product exists to not be.

The artifact is gift-law compliant: the work itself, receipts in reach, one line of
why-for-them, no lesson, no "you should". It ends with the press-send left explicitly
to them. STAGED BY DEFAULT (<db>.staged_staff.json) — --send is allowlist-gated like
every other organ and spends the shared callback budget (unasked work is organic, not
a kept promise).

Not cron-wired yet, on purpose: the first artifacts get founder eyes before the organ
earns a schedule (the eval-gated culture; quality bar = sees it through).

  python3 staff.py                      # select + build + stage for dennis
  python3 staff.py --tenant dennis --send
  python3 staff.py --dry                # selection only — print the target and stop
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SELECT_SYS = """You are the staff of a personal institution, deciding what groundwork to do tonight
for one member. From their OWN material below, find the ONE thing they keep circling but not doing —
a reach-out unmade, a decision parked, a commitment made and left open, a thing they said they'd do
with no evidence they did it.

HARD RULES:
- The target must be QUOTABLE from their material (their words, with a date). No quote → abstain.
- It must be ACTIONABLE BY RESEARCH AND DRAFTING tonight (finding people/options/facts, drafting a
  message or plan). "Exercise more" is not draftable — skip habits, health, feelings.
- Abstain freely: {"target": null, "why": "<what's missing>"} is a correct and common answer.

Return ONLY JSON:
{"target": "<the avoided thing, one line>" | null,
 "quote": "<their own words>", "quoted_when": "<date if visible>",
 "kind": "reach_out|decision|logistics|other",
 "groundwork": "<what the staff should dig up tonight, one line>",
 "search": "<the ONE web query that gets the load-bearing facts>",
 "why": "<one line>"}"""

BUILD_SYS = """You are the staff of a personal institution, delivering tonight's groundwork to one
member. You did the digging (findings below, with URLs). Now write the DELIVERABLE as one iMessage.

SHAPE (gift law — the work, not a lesson):
- Open with what you did, plainly: "did the groundwork on <thing>" — one line.
- The substance: the 2-3 specifics that matter (names, numbers, the option that wins), each traceable
  to a finding. If the target is a reach-out, include a SHORT draft in their voice (they talk lowercase,
  direct, no corporate). If it's a decision, the one fact that collapses it.
- Kill the fear if you found the fear-killer: one line.
- End by leaving the leap to them, without a pep talk: "the send/call/yes is yours." No questions.
- 60-140 words TOTAL. No bullets, no headers. Text like a sharp friend who did homework.

HARD RULES: every specific must come from a finding or their own material — invent nothing. If the
findings are too thin to say anything real, return {"deliverable": null, "why": "thin"} instead of
padding. Return ONLY JSON: {"deliverable": "<the message>" | null, "why": "<one line>"}"""


def _db(tenant: str) -> str:
    d = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(d, "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")


def _material(tenant: str) -> str:
    """The selection evidence: threads, open commitments, recent journal — their own words."""
    db = _db(tenant)
    bits = []
    try:
        t = json.load(open(f"{db}.threads.json"))
        for tp in (t.get("topics") or [])[:6]:
            bits.append(f"[thread ×{tp.get('count', 1)}, last {tp.get('last', '?')}] {tp.get('label', '')}")
        for c in (t.get("commitments") or [])[:6]:
            due = f", due {c['due']}" if c.get("due") else ""
            bits.append(f"[commitment, made {c.get('made', '?')}{due}] {c.get('text', '')}")
    except Exception:
        pass
    try:
        import journal
        for e in (journal._load(tenant).get("entries") or [])[-25:]:
            tx = (e.get("text") or "").strip()
            if tx and not tx.startswith("[img:"):
                bits.append(f"[{e.get('date', '?')}] {tx[:220]}")
    except Exception:
        pass
    return "\n".join(bits[-40:])


def select(tenant: str) -> dict | None:
    import episode_engine as ee
    mat = _material(tenant)
    if len(mat) < 200:
        return None
    got = asyncio.run(ee._ask(SELECT_SYS, f"THEIR MATERIAL (dated, their words):\n\n{mat}",
                              ee.MODEL, max_tokens=400)) or {}
    if not got.get("target") or not got.get("quote"):
        return None
    return got


def build(tenant: str, sel: dict) -> str | None:
    import episode_engine as ee
    import research_engine as re_
    findings = re_._search(str(sel.get("search") or sel["target"]))
    if not findings:
        return None
    fs = "\n".join(f"- {f['title']} ({f['url']}): {f['snippet']}" for f in findings if f.get("title"))
    got = asyncio.run(ee._ask(
        BUILD_SYS,
        f"THE AVOIDED THING: {sel['target']}\nTHEIR WORDS: \"{sel['quote']}\" ({sel.get('quoted_when', '?')})\n"
        f"KIND: {sel.get('kind')}\nGROUNDWORK ASKED: {sel.get('groundwork')}\n\nFINDINGS:\n{fs}",
        ee.MODEL, max_tokens=600)) or {}
    text = (got.get("deliverable") or "").strip()
    if not text or len(text) < 40:
        return None
    try:
        import disposition
        if disposition.violations(text, max_chars=1000):
            return None
    except Exception:
        pass
    return text


def run(tenant: str = "dennis", send: bool = False, dry: bool = False) -> str:
    db = _db(tenant)
    staged_p = Path(f"{db}.staged_staff.json")
    today = dt.date.today().isoformat()
    try:                                              # once per day, like the other organs
        if staged_p.exists() and json.loads(staged_p.read_text()).get("date") == today and not send:
            return f"[hold] staff already staged today for {tenant}"
    except (OSError, json.JSONDecodeError):
        pass

    sel = select(tenant)
    if not sel:
        return f"[abstain] {tenant} — no avoided thing in evidence (correct outcome)"
    if dry:
        return f"[target] {tenant} — {sel['target']}  (their words: \"{sel['quote']}\")"

    text = build(tenant, sel)
    if not text:
        return f"[abstain] {tenant} — target found ({sel['target'][:60]}) but findings too thin to say anything real"

    staged_p.write_text(json.dumps({"date": today, "target": sel["target"], "quote": sel["quote"],
                                    "text": text}, ensure_ascii=False, indent=1))
    if not send:
        return f"[stage] {tenant} ({sel['target'][:50]}) →\n{text}"

    import co_react
    import daily_text
    mem = f"{db}.co_memory.db"
    if co_react.callback_used_today(mem):
        return f"[hold] {tenant} — callback budget spent (staged; tomorrow's tick can carry it)"
    phone = daily_text.tenant_phone(tenant, daily_text._cfg(Path(db)))
    if not (phone and daily_text._allowlisted(phone)):
        return f"[hold] {tenant} — no allowlisted phone"
    if daily_text._sendblue(phone, text):
        daily_text.record_outbound(tenant, text)
        co_react.mark_callback("staff", mem)
        try:
            import work
            work.log(tenant, "drafted", f"groundwork on: {sel['target'][:90]}",
                     why="you kept circling it — the friction's done, the leap is yours")
        except Exception:
            pass
        return f"[SENT] {tenant} ({sel['target'][:50]})"
    return f"[fail] {tenant} — sendblue failed (still staged)"


if __name__ == "__main__":
    t = "dennis"
    if "--tenant" in sys.argv:
        t = sys.argv[sys.argv.index("--tenant") + 1]
    print(run(t, send="--send" in sys.argv, dry="--dry" in sys.argv))
