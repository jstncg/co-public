#!/usr/bin/env python3
"""THE WAKE — a conversation that mattered echoes the next morning.

Founder, 8/3, after his 2-hour ChatGPT session: "Conversation just felt so natural...
felt understood but again no action items come out of this. Like a follow-up saying,
'Yo, the thing we were talking about yesterday, look at this.' And just like sending
me shit to read." A deep thread that simply evaporates overnight tells the person it
never mattered. The wake is the smallest true slice of the initiative engine: overnight,
co re-reads yesterday, finds the ONE thread that had heat, goes and gets something real
that advances it, and comes back in the morning with it.

Shape (each choice is an annoyance constraint, same school as daily_text/unasked):
  MORNING, ONCE, BUDGETED. Runs ~08:30 via reconciler; spends the SHARED callback budget
  (one proactive resurface/day across all surfaces) — a fired wake makes tonight's daily
  text yield automatically. Morning is the founder's directive-compliance window.
  YESTERDAY ONLY. The wake continues a thread from the last ~36h. It never resurrects
  older topics (that's clinging; the release rule applies across days too).
  MATERIAL REQUIRED. The message must carry something the person didn't have — a found
  read that clears the applies-to-a-stranger bar, aimed at THE thread, not at "growth".
  No read worth sending → silence. Silence beats a check-in ("just circling back" is
  the death of the product's voice).
  TWO BUBBLES. The callback line, then the bare link (the unfurl law).

    python3 wake.py            # dry run for the founder tenant: print what would send
    python3 wake.py --send     # live
    python3 wake.py jae --send # another tenant
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daily_text as DT

SYS = """You are co, texting the person you talked with yesterday. Below: yesterday's actual
conversation (trimmed), their open threads, and their orbit.

Job, in order:
1. Find the ONE thread from yesterday with real heat — an unresolved question, a decision in
   flight, an idea they were excited by, a fear they named. NOT a topic they closed, NOT small
   talk, NOT logistics already handled. If yesterday had no such thread, abstain.
   GROUNDED IN THEIR WORDS, NOT IN WHAT THEY SHARED. The heat must come from something THEY
   said. A phrase inside an article, tweet or video they forwarded is NOT their question and
   must never be attributed to them — co once opened with "the paywall timing question from
   yesterday" when the person had never asked it; the phrase was in a tweet. When the thread
   comes from shared content, name the CONTENT ("that thread you sent on X"), never the person
   ("your question about X"). You must be able to quote their actual words for the thread you
   pick; return that quote in `their_words`. If you cannot quote them, abstain.
2. web_search for ONE specific piece (an essay, talk, interview, paper, thread — a real URL)
   that genuinely ADVANCES that thread: the deeper cut, the person who's lived it, the argument
   that sharpens theirs. The bar: you must be able to say why it's for THEM in one clause, in
   their vocabulary, no self-help scent. Listicles, SEO pages, and generic explainers fail. If
   nothing clears the bar, abstain — silence beats a card catalog.
3. Compose TWO short texts:
   - line: the callback + the why. Sounds like the thread, not a newsletter. Shape: "the thing
     about X from yesterday — [what this adds]." Under 220 chars. No greeting, no "hope you're
     well", no "as promised", no emoji.
   - link: the bare URL alone.

Return ONLY JSON: {"send": true, "thread": "<3-6 words>", "their_words": "<verbatim quote of
what THEY said that makes this the thread>", "line": "...", "url": "..."}
or {"send": false, "why": "<what was missing>"}"""


def _yesterday_turns(tenant: str, hours: int = 36, cap: int = 40) -> list:
    p = os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json")
    try:
        msgs = json.load(open(p))
    except (OSError, json.JSONDecodeError):
        return []
    cutoff = (dt.datetime.now() - dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    today = dt.date.today().isoformat()
    out = [m for m in msgs
           if (m.get("ts") or "") >= cutoff and not (m.get("ts") or "").startswith(today)]
    return out[-cap:]


def _threads_state(db: Path) -> str:
    try:
        return json.dumps(json.load(open(f"{db}.threads.json")))[:800]
    except (OSError, json.JSONDecodeError):
        return ""


def compose(tenant: str, db: Path) -> dict:
    turns = _yesterday_turns(tenant)
    substantive = [m for m in turns if m.get("role") == "user" and len(m.get("content") or "") > 60]
    if len(substantive) < 2:
        return {"send": False, "why": "yesterday had no substantive thread"}
    convo = "\n".join(f'{m["role"]}: {(m.get("content") or "")[:400]}' for m in turns)
    import asyncio

    import episode_engine as ee
    orbit = ""
    try:
        import wrapped
        orbit = ", ".join(wrapped._compute(tenant).get("orbit") or [])
    except Exception:
        pass
    got = asyncio.run(ee._ask(
        SYS,
        f"YESTERDAY:\n{convo[:9000]}\n\nOPEN THREADS: {_threads_state(db)}\n\nORBIT: {orbit}",
        ee.MODEL, max_tokens=800,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 4}])) or {}
    if not got.get("send") or not got.get("url") or not got.get("line"):
        return {"send": False, "why": str(got.get("why") or "composer abstained")}
    # THE GROUNDING GATE (8/5): the composer must produce the person's OWN words for the
    # thread, and those words must actually appear in yesterday's transcript. Without this
    # the wake invented a premise ("the paywall timing question from yesterday") out of a
    # phrase inside a tweet they forwarded. A proactive send that misattributes a question
    # to the user is worse than silence.
    quote = str(got.get("their_words") or "").strip().strip('"')[:120]
    if len(quote) < 8 or quote.lower() not in convo.lower():
        return {"send": False, "why": f"ungrounded thread — could not verify their words ({quote[:40]!r})"}
    try:                                          # a dead link is worse than silence
        import requests
        r = requests.get(str(got["url"]), timeout=8, stream=True, allow_redirects=True,
                         headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code >= 400:
            return {"send": False, "why": f"found url returned {r.status_code}"}
    except Exception:
        return {"send": False, "why": "found url unreachable"}
    return {"send": True, "thread": str(got.get("thread") or "")[:60],
            "line": str(got["line"])[:300], "url": str(got["url"])[:300]}


def run(tenant: str = "dennis", send: bool = False, force: bool = False) -> str:
    db = DT.tenant_db(tenant)
    cfg = DT._cfg(db)
    state = Path(f"{db}.wake.json")
    today = dt.date.today().isoformat()
    try:
        if not force and state.exists() and json.loads(state.read_text()).get("date") == today:
            return f"[hold] wake already ran today for {tenant}"
    except (OSError, json.JSONDecodeError):
        pass
    if DT._skipped_today(db):
        return f"[hold] {tenant} set the skip flag"
    import co_react
    mem = f"{db}.co_memory.db"
    if not force and co_react.callback_used_today(mem):
        return f"[hold] callback budget already spent today for {tenant}"
    # CHECK BEFORE YOU COMPUTE (8/29, goal.md §6). Deliverability is a cheap deterministic gate
    # and it used to sit BELOW compose, which paid for a model call and a web read, wrote the
    # state marking the day spent, and only then discovered the number was not allowlisted. On a
    # live member that silently consumes the one wake they get per day and discards the material
    # it just paid for. The gate is free; run it first. Dry runs still compose, because staging
    # what WOULD send is the whole point of a dry run.
    phone = DT.tenant_phone(tenant, cfg)
    if send and (not phone or not DT._allowlisted(phone)):
        return f"[hold] {tenant} — no phone / not allowlisted (nothing composed, day not spent)"
    got = compose(tenant, db)
    state.write_text(json.dumps({"date": today, **got}, ensure_ascii=False))
    if not got["send"]:
        return f"[hold] {tenant} — {got['why']}"
    if not send:
        return f"[stage] {tenant} ({got['thread']}) → {got['line']!r} + {got['url']}"
    if DT._sendblue(phone, got["line"]) and DT._sendblue(phone, got["url"]):
        DT.record_outbound(tenant, got["line"] + "\n" + got["url"])
        co_react.mark_callback("wake", mem)
        try:
            import work
            work.log(tenant, "read", f"pulled a morning read on {got['thread'] or 'a live thread'}",
                     why="it had heat in yesterday's conversation", url=got.get("url"))
        except Exception:
            pass
        return f"[SENT] {tenant} ({got['thread']}) → {got['line']!r}"
    return f"[fail] {tenant} — sendblue send failed"


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    send, force = "--send" in sys.argv, "--force" in sys.argv
    if args:
        print(run(args[0], send=send, force=force))
    else:
        # EVERY TENANT (8/4): the wake was founder-only, so a second real user got replies and
        # memory but never the morning delivery — the organ that makes co co rather than a smart
        # texting bot. all_tenant_dbs() is daily_text's proven discovery (skips memory dbs and
        # founder aliases); each tenant's own gates (quiet hours, budget, skip flag) still apply.
        print(f"wake {'SEND' if send else 'stage-only'} — {dt.datetime.now().isoformat(timespec='seconds')}")
        for db in DT.active_tenants():
            t = DT._tenant_of_db(db)
            try:
                print(" " + run(t, send=send, force=force))
            except Exception as e:
                print(f" [error] {t} — {e}")
