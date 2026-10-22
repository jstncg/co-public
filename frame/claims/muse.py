"""THE MUSE LOOP — a deposited thought gets an ack now and an expansion later.

Founder, in-conversation (8/9): "when I say things like this, I wish you would just say
noted or react with a checkmark … and in the background keep expanding on this thread and
come back to me with insights and patterns and things I don't know rather than slop."

The pattern already exists for videos (deferred_watch: ack → watch fully → deliver the
take). This is the same covenant for THOUGHTS:

  1. inbound musing → queue here + hint the engine to ACK (the engine still judges;
     a musing that's secretly a question gets answered like one)
  2. overnight (or next expansion pass) → expand against their OWN graph: patterns,
     collisions with things they've said, the thing they don't know. ABSTAIN-BIASED:
     a musing with nothing real to add expands to nothing, and silence is the correct
     delivery. Echoing their thought back with more words is the slop being replaced.
  3. delivery rides the existing morning/proactive machinery — one expansion at a time,
     budget-respecting, never a second unprompted essay in the same day.

State: <db>.muse.json {queued: [{ts, text}], ready: [{ts, source, insight}]}.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MAX_QUEUE = 12
MAX_READY = 3
MIN_LEN = 90          # shorter than this is chat, not a thesis

# Declarative thinking-out-loud: no question, no link, no ask, enough body to be a thought.
_URLISH = re.compile(r"https?://", re.I)
_ASKY = re.compile(r"\?|^\s*(can|could|would|will|should|do|does|did|is|are|what|when|where|"
                   r"who|why|how)\b", re.I)


def _path(tenant: str) -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    db = os.path.join(base, "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
    return f"{db}.muse.json"


def _load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except (OSError, json.JSONDecodeError):
        return {"queued": [], "ready": []}


def _save(tenant: str, st: dict) -> None:
    tmp = _path(tenant) + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, _path(tenant))


def looks_like_musing(text: str) -> bool:
    """Deterministic gate for the QUEUE side. Liberal on purpose — expansion abstains when
    there's nothing real, so a false queue costs nothing. The ACK decision is the
    engine's, with full context; this never touches the reply."""
    t = (text or "").strip()
    if len(t) < MIN_LEN or _URLISH.search(t):
        return False
    if _ASKY.search(t):
        return False
    try:
        import anchors
        if anchors.REQUEST_RE.search(t):
            return False
    except Exception:
        pass
    return True


def queue(tenant: str, text: str) -> bool:
    st = _load(tenant)
    st["queued"] = (st.get("queued") or [])[-(MAX_QUEUE - 1):]
    st["queued"].append({"ts": dt.datetime.now().isoformat(timespec="seconds"),
                         "text": text.strip()[:1200]})
    _save(tenant, st)
    return True


ACK_HINT = ("MUSING DEPOSIT: they're thinking out loud, not asking. If you agree it's a "
            "deposit, the whole reply is an ack — 'noted', a 👍 reaction, four words max, "
            "NO analysis, NO expansion, NO question back. The expansion happens offline and "
            "returns later with something they don't already know. (Their own words: 'say "
            "noted … and come back with insights and patterns, not slop.') If it's actually "
            "a question or an ask wearing a musing's clothes, answer it normally.")


EXPAND_SYS = """A member of a personal institution dropped this thought to think out loud. Overnight, the
institution's job is to EXPAND it — against THEIR OWN prior threads (below) and the real world.

Return ONE insight they do not already have: a pattern across their own musings, a collision with
something else they believe, a named precedent (person/company/study — checkable, real), or the
strongest counter-case. NEVER a summary or a restatement — they wrote the thought, they don't need
it back. NEVER generic wisdom. If you have nothing that would genuinely surprise or sharpen them,
return exactly {"insight": null} — silence is the correct product.

Return ONLY JSON: {"insight": "<2-4 sentences, texting register, lowercase-leaning>" | null}"""


def expand(tenant: str) -> int:
    """Expansion pass (nightly, or any quiet moment). Moves queued → ready. Abstains freely."""
    st = _load(tenant)
    if not st.get("queued"):
        return 0
    try:
        import episode_engine as ee
        import claimstore
        conn = claimstore.connect(tenant)
        try:
            core = claimstore.top_claims(conn, limit=16)
        finally:
            conn.close()
    except Exception:
        return 0
    import asyncio
    made = 0
    keep = []
    for m in st["queued"]:
        try:
            got = asyncio.run(ee._ask(
                EXPAND_SYS,
                f"WHAT THEY HOLD (their graph, for collisions):\n{core}\n\n"
                f"THE MUSING ({m['ts'][:10]}):\n{m['text']}",
                ee.MODEL, max_tokens=400,
                tools=[{"type": "web_search_20250305", "name": "web_search",
                        "max_uses": 2}])) or {}
            insight = (got.get("insight") or "").strip() if isinstance(got, dict) else ""
            if insight:
                st["ready"] = (st.get("ready") or [])[-(MAX_READY - 1):]
                st["ready"].append({"ts": m["ts"], "source": m["text"][:140],
                                    "insight": insight[:600]})
                made += 1
            # expanded-or-abstained either way: the musing leaves the queue
        except Exception:
            keep.append(m)          # transient failure: try again next pass
    st["queued"] = keep
    _save(tenant, st)
    return made


def take_ready(tenant: str) -> dict | None:
    """Pop one delivery for the morning/proactive path. Caller owns budget and sending."""
    st = _load(tenant)
    if not st.get("ready"):
        return None
    out = st["ready"].pop(0)
    _save(tenant, st)
    return out
