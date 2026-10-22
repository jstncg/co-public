#!/usr/bin/env python3
"""The second opinion — "was thinking about our convo yesterday, looked into it more…" (7/15).

The slept-on-it move: the single highest-register proactive text a thinking friend sends. Overnight, pick
ONE recent exchange with real substance (a decision, a thesis, an open question — never logistics), hand
it back to the witness engine (which holds the memory, the voice, and the search tool) for actual
homework, and text first ONLY if the homework produced something genuinely additive. A second opinion
that adds nothing is spam wearing a smart costume — ABSTAIN is the default, not the exception.

Gates (enforced by the caller, proactive_tick):
  morning window (the "woke up thinking about it" feel) → shared one-per-day callback budget →
  read-receipt gate → min gap between second opinions → one attempt per day (an abstain is an answer).

Sources: the router's durable transcript (both sides of the conversation) for material; co_sends for
recency (transcript turns carry no timestamps — if nothing arrived in RECENT_HOURS, there is no
"yesterday's convo" to sleep on).
"""
import datetime as dt
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

WITNESS_URL = os.environ.get("WITNESS_URL", "http://localhost:8090/v1/chat/completions")
_ENGINE_TOKEN = os.environ.get("CO_ENGINE_TOKEN", "").strip()
ENGINE_HEADERS = {"Authorization": f"Bearer {_ENGINE_TOKEN}"} if _ENGINE_TOKEN else {}
RECENT_HOURS = 36            # no sends within this window → nothing to sleep on
GAP_DAYS = 2                 # never two second opinions inside this window
WINDOW_TURNS = 30            # the "recent conversation" the selector reads
MAX_LEN = 500

PICK_SYS = """From this recent conversation between one person and their thinking-partner Co, pick the ONE
exchange that deserves a slept-on-it follow-up tomorrow morning — a decision they're weighing, a thesis
they floated, a question left open, a thing they're building. NOT logistics, NOT small talk, NOT anything
already fully resolved.
Return ONLY JSON: {"topic": "<3-8 words>", "their_words": "<the 1-2 sentences THEY said that matter most,
verbatim>", "open_edge": "<what's genuinely unresolved, one sentence>"} or {"topic": null} if nothing
qualifies. The bar: would a sharp friend actually still be thinking about this tomorrow? When unsure, null."""

TASK = """[overnight task — not a message from them] Yesterday you two talked about: {topic}.
They said: "{their_words}". The open edge: {open_edge}.
You slept on it. Do the homework NOW: think harder than you could mid-conversation, search if it earns a
receipt (a fact, a precedent, a person, a number), check what you know of them. Then write the text you'd
send first thing — the "was thinking about our convo yesterday" move, in your own words (NEVER that exact
stock phrase twice in a row; vary how you open). One genuine addition: a sharper take, an honest reversal
("actually i pushed back on X, i think i was wrong"), a found receipt. 1-3 short bubbles, texting voice.
No questions required; the gift is the thought.
If the homework produced nothing genuinely additive — nothing they'd screenshot or act on — reply exactly
ABSTAIN. Abstaining is success."""


def _state_path(claims_db: str) -> str:
    return f"{claims_db}.secondop.json"


def _state(claims_db: str) -> dict:
    p = _state_path(claims_db)
    try:
        return json.loads(open(p).read()) if os.path.exists(p) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save(claims_db: str, st: dict) -> None:
    tmp = _state_path(claims_db) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, _state_path(claims_db))


def gates_ok(claims_db: str, now: dt.datetime) -> bool:
    """Morning window, recency, gap, one-attempt-a-day. Cheap checks only — no LLM."""
    if not (9 <= now.hour < 12):
        return False
    st = _state(claims_db)
    today = now.date().isoformat()
    if st.get("attempted") == today:
        return False
    last = st.get("sent", "")
    if last and (now.date() - dt.date.fromisoformat(last)).days < GAP_DAYS:
        return False
    try:                        # anything actually said recently? (co_sends carries the timestamps)
        conn = sqlite3.connect(f"{claims_db}.co_memory.db")
        row = conn.execute("select max(ts) from co_sends").fetchone()
        conn.close()
        if not row or not row[0]:
            return False
        newest = dt.datetime.fromisoformat(row[0])
        if (now.replace(tzinfo=None) - newest).total_seconds() > RECENT_HOURS * 3600:
            return False
    except Exception:
        return False
    return True


def _transcript_window(tenant: str) -> str:
    p = os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json")
    try:
        msgs = json.loads(open(p).read())[-WINDOW_TURNS:]
    except (json.JSONDecodeError, OSError):
        return ""
    return "\n".join(f"{'THEM' if m.get('role') == 'user' else 'CO'}: {m.get('content', '')[:400]}"
                     for m in msgs)


def candidate(tenant: str) -> dict | None:
    """The one exchange worth sleeping on, or None. Haiku-graded, null-biased."""
    window = _transcript_window(tenant)
    if len(window) < 400:              # too little conversation to have a convo-about-the-convo
        return None
    try:
        import llm
        out = llm.complete_with_fallbacks(llm.phrase_specs(), PICK_SYS, window[-8000:], max_tokens=220)
        m = re.search(r"\{.*\}", out or "", re.S)
        c = json.loads(m.group(0)) if m else {}
    except Exception:
        return None
    return c if c.get("topic") and c.get("their_words") else None


def compose(tenant: str, cand: dict) -> str | None:
    """The homework, done by the full brain (memory + search + the voice). None on ABSTAIN/failure."""
    try:
        import requests
        body = {"model": "co", "stream": False, "user": tenant,
                "messages": [{"role": "user", "content": TASK.format(
                    topic=cand["topic"], their_words=cand["their_words"][:300],
                    open_edge=cand.get("open_edge", "")[:200])}]}
        r = requests.post(WITNESS_URL, json=body, headers=ENGINE_HEADERS, timeout=120)
        r.raise_for_status()
        text = (r.json()["choices"][0]["message"]["content"] or "").strip()
    except Exception:
        return None
    if not text or "ABSTAIN" in text.upper()[:40] or len(text) > MAX_LEN:
        return None
    import disposition
    return None if disposition.violations(text, max_chars=MAX_LEN) else text


def mark_attempted(claims_db: str, now: dt.datetime) -> None:
    st = _state(claims_db)
    st["attempted"] = now.date().isoformat()
    _save(claims_db, st)


def mark_sent(claims_db: str, now: dt.datetime, topic: str) -> None:
    st = _state(claims_db)
    st["sent"] = now.date().isoformat()
    st["last_topic"] = topic
    _save(claims_db, st)


if __name__ == "__main__":
    tenant = sys.argv[1] if len(sys.argv) > 1 else "dennis"
    db = str(Path(__file__).parent / (f"claims_{tenant}.db" if tenant != "dennis" else "claims.db"))
    c = candidate(tenant)
    print("CANDIDATE:", json.dumps(c, indent=1))
    if c:
        print("\nCOMPOSED:", compose(tenant, c))
