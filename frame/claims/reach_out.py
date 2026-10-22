#!/usr/bin/env python3
"""The proactive brain — WHEN would a good friend reach out, and WHAT would they say (channel-agnostic).

Wired: LEGACY / unwired. Its only caller was the Donna-era iMessage bridge, which left this repo on
8/5 (now Secretary-Production/donna-bridge/). Superseded by reconciler.py + proactive_tick.py.
Nothing imports this — it is now a pure removal candidate.

The hard, make-or-break half of "it reaches you at various points" (the easy half is the channel — text/voice).
A friend who reaches out at the right moment is magic; one that robo-dials is blocked. So this is CALIBRATED
TO ABSTAIN: it defaults to staying quiet and only fires when there's a genuine, specific, timely reason —
grounded in the live state of the model (open commitments he hasn't closed, a live decision he's avoiding, a
high-value belief gone stale, a real check-in window). Output is a decision + a drafted message; whatever
channel (SMS/Telegram/voice) just delivers it.

  doppler run -- /…/python3 reach_out.py            # evaluate now → {reach_out, message, why}
Channel + cadence wiring (conductor/launchd) comes once a channel is chosen; this is the brain, not the mouth.
"""
import asyncio
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore
from anthro import make_client

STATE = Path.home() / ".co_reachout.json"
MIN_GAP_HRS = 18   # don't reach out more than ~once a day — annoyance floor (the friend, not the spambot)

SYS = """You are the user's thought partner / friend deciding whether to REACH OUT to them right now,
unprompted — and if so, what to say. The bar is HIGH: a good friend reaches out when there's a real, specific,
timely reason; an annoying one pings constantly. DEFAULT TO NOT reaching out.

Reach out only if the live context gives a genuine reason, e.g.: a commitment they made and haven't closed
(name it), a real decision they're avoiding (push gently), a high-value thing worth checking ("still true
that…?"), or a natural reflection moment. If you reach out, write it the way you'd actually text a friend:
short, warm, specific, ONE thing, ends with something that pulls a response. No "just checking in." No menu.

Return ONLY JSON: {"reach_out": bool, "why": "one line", "message": "what you'd say (empty if reach_out=false)",
"urgency": "low|medium|high"}"""


def live_context(conn):
    """The threads a friend would notice: open commitments, avoided decisions, stale high-value beliefs,
    and the highest-salience self-disclosures from recent conversations/journal."""
    ctx = []
    # avoided decisions / open commitments / live threads (from journal + claims)
    for stmt, in conn.execute(
        "SELECT statement FROM claims WHERE COALESCE(status,'active')!='retired' AND "
        "(statement LIKE '%avoid%' OR statement LIKE '%deciding%' OR statement LIKE '%should%' OR "
        "statement LIKE '%commit%' OR statement LIKE '%doesn''t follow through%' OR statement LIKE '%wants to%') "
        "ORDER BY COALESCE(salience,0.4) DESC LIMIT 10").fetchall():
        ctx.append(f"[live thread] {stmt}")
    # stale high-value beliefs worth a check
    try:
        for age, conf, stmt in claimstore.stale_claims(conn, date.today().isoformat(), min_conf=0.7, limit=4):
            ctx.append(f"[possibly stale, {age}d old] {stmt}")
    except Exception:
        pass
    # who he is at the core (so the reach-out is in-character + relevant)
    for stmt, in conn.execute(
        "SELECT statement FROM claims WHERE COALESCE(status,'active')!='retired' AND type IN ('identity','value') "
        "ORDER BY COALESCE(salience,0.4) DESC LIMIT 6").fetchall():
        ctx.append(f"[who he is] {stmt}")
    # due predictions — live threads worth a check-in. The answer does NOT resolve them: resolution is
    # behavior-graded in predict.auto_resolve (substrate.db), never the user's verdict. These are CONTEXT
    # for what a friend would notice, not a quiz whose answer grades the engine.
    try:
        import predict
        for pid, stmt, conf, by in predict.pending(predict.db(), due_only=True)[:3]:
            ctx.append(f"[live thread the model is watching (its guess: {conf:.0%}); behavior will settle it, not his answer] {stmt}")
    except Exception:
        pass
    return ctx


async def main():
    conn = claimstore.connect()
    ctx = live_context(conn)
    if not ctx:
        print(json.dumps({"reach_out": False, "why": "no model yet", "message": "", "urgency": "low"})); return
    client = make_client()
    r = await client.messages.create(
        model="claude-sonnet-4-6", system=SYS, max_tokens=400,
        messages=[{"role": "user", "content": "LIVE CONTEXT (the state of what you know about them):\n" + "\n".join(ctx) +
                   "\n\nShould you reach out right now? Be honest — default to no unless there's a real reason."}])
    txt = "".join(b.text for b in r.content if b.type == "text")
    m = re.search(r"\{.*\}", txt, re.S)
    decision = json.loads(m.group(0)) if m else {"reach_out": False, "why": "parse", "message": "", "urgency": "low"}
    print(json.dumps(decision, indent=2, ensure_ascii=False))
    if decision.get("reach_out"):
        print(f"\n  → WOULD REACH OUT ({decision.get('urgency')}): \"{decision.get('message')}\"")
        print(f"     why: {decision.get('why')}")
    else:
        print(f"\n  → staying quiet (the friend, not the spambot): {decision.get('why')}")


if __name__ == "__main__":
    asyncio.run(main())
