#!/usr/bin/env python3
"""THE RETURN — hand something back at the moment it lands (goal.md A1/A10, §28.1).

Capture earns the relationship; the PAYBACK is the product. Everything before this shipped was the
deposit side: the eyes read what gets sent, the flywheel turns conversations into claims. Nothing ever
came back. This is the other half.

Shape (deliberate, and each choice is a constraint on annoyance):
  ECHO-TRIGGERED, NEVER SCHEDULED. A return rides on a message he already sent, inside the reply he was
  already getting. It is not a push, so it cannot trip quiet hours or spend the weekly cap (§18), and it
  can never arrive at a moment he didn't open.
  A HIGH BAR, AND SILENCE IS THE DEFAULT. A weak return is worse than no return: it teaches him the
  feature is noise. Old enough to be forgotten, close enough to be uncanny, or nothing.
  THE RETURN IS THE QUESTION; HIS REACTION IS THE LABEL. Every surfaced return is recorded, and his next
  message is read as the verdict on it. That is the reward signal nobody else can buy — it does not exist
  until something asks for it, which is why the corrections table sat empty for its whole life.

Deposits come from the journal (~/.co/journal/<tenant>.json): what he actually sent, carrying the
eyes' read of any link. Claims are ABOUT him; deposits are FROM him, and a return has to hand back a
thing, not a conclusion.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MODEL = "claude-haiku-4-5"

MIN_AGE_DAYS = float(os.environ.get("CO_RETURN_MIN_AGE_DAYS", 7))    # forgotten, not "earlier today"
CANDIDATES = 24            # lexical prefilter width before the model judges
MIN_CONFIDENCE = 0.72      # below this it stays silent — precision over recall, always
COOLDOWN_HOURS = 20        # at most one return a day; the move is rare or it is noise
MIN_DEPOSIT_CHARS = 40     # "ok" is not a deposit

_STOP = {
    "the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "but", "not", "have", "has",
    "how", "what", "why", "its", "it's", "from", "they", "them", "there", "then", "than", "about", "into",
    "just", "like", "can", "will", "would", "could", "should", "want", "need", "get", "got", "one", "all",
    "out", "who", "when", "where", "some", "more", "most", "much", "very", "really", "think", "know",
    "https", "http", "www", "com", "shared",
}

JUDGE_SYS = """You decide whether to hand someone back something they sent their thought-partner WEEKS AGO,
because what they just said connects to it.

The bar is HIGH. Silence is the correct answer most of the time. Say yes ONLY when the old deposit would
make them go "oh — right, I did send that," and it genuinely sharpens what they're on about NOW.

Say NO when:
- the link is topical but shallow ("both about AI", "both about work") — a shared subject is not a connection
- the old item is something they obviously still remember or reference constantly
- it would read as the app showing off its memory rather than being useful
- you're reaching in any way at all

Say YES when the old deposit is a genuine echo: the same underlying question resurfacing, a thing they were
drawn to before and are now circling from another angle, a prediction or worry that just came true, an
answer they already found and forgot.

Return ONLY JSON:
{"index": <int or null>, "why": "<one sentence, plain, why THIS matters to what they just said — speak about
them in second person, no preamble>", "confidence": <0-1>}
null index means nothing is worth returning."""


# ── store ────────────────────────────────────────────────────────────────────────────────────────────
def _db(tenant: str) -> str:
    d = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(d, "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")


def _conn(tenant: str):
    c = sqlite3.connect(_db(tenant), timeout=10)
    c.execute("""CREATE TABLE IF NOT EXISTS returns (
        id            INTEGER PRIMARY KEY,
        deposit_ts    INTEGER NOT NULL,
        deposit_text  TEXT NOT NULL,
        why           TEXT,
        confidence    REAL,
        trigger_text  TEXT,
        surfaced_at   TEXT NOT NULL,
        reaction      TEXT,              -- hit | miss | unclear (the label)
        reaction_text TEXT,
        reacted_at    TEXT
    )""")
    c.execute("CREATE INDEX IF NOT EXISTS returns_recent ON returns(surfaced_at)")
    c.commit()
    return c


def _journal_entries(tenant: str) -> list:
    p = os.path.expanduser(f"~/.co/journal/{tenant}.json")
    try:
        with open(p) as f:
            return (json.load(f) or {}).get("entries", []) or []
    except Exception:
        return []


# ── candidate selection ──────────────────────────────────────────────────────────────────────────────
def _words(s: str) -> set:
    return {w for w in re.findall(r"[a-z0-9']{3,}", (s or "").lower()) if w not in _STOP}


def _prefilter(entries: list, text: str, used_ts: set, now: float) -> list:
    """Cheap lexical narrowing so the judge sees the plausible few, not the whole journal. Deliberately
    generous — the model does the real discrimination; this only keeps the prompt honest in size."""
    q = _words(text)
    cutoff = now - MIN_AGE_DAYS * 86400
    scored = []
    for e in entries:
        ts = e.get("ts") or 0
        if ts > cutoff or ts in used_ts:
            continue                                        # too fresh to have been forgotten, or already used
        body = (e.get("text") or "") + " " + (e.get("link") or "")
        if len(body.strip()) < MIN_DEPOSIT_CHARS:
            continue
        w = _words(body)
        if not w:
            continue
        overlap = len(q & w)
        # age is a mild bonus: the older thing is the more surprising return
        scored.append((overlap + min((now - ts) / 86400, 60) / 200.0, ts, body))
    scored.sort(reverse=True)
    return [(ts, body) for _, ts, body in scored[:CANDIDATES]]


def _recent_return(c) -> bool:
    row = c.execute("SELECT surfaced_at FROM returns ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return False
    try:
        return (time.time() - time.mktime(time.strptime(row[0], "%Y-%m-%dT%H:%M:%SZ"))) < COOLDOWN_HOURS * 3600
    except Exception:
        return False


# ── the ask ──────────────────────────────────────────────────────────────────────────────────────────
async def _judge(text: str, cands: list):
    from anthro import make_client
    listing = "\n".join(f"[{i}] ({time.strftime('%b %d', time.localtime(ts))}) {body[:400]}"
                        for i, (ts, body) in enumerate(cands))
    client = make_client()
    r = await client.messages.create(
        model=MODEL, system=JUDGE_SYS, max_tokens=400,
        messages=[{"role": "user", "content": f"THEY JUST SAID:\n{text[:1200]}\n\nTHINGS THEY SENT WEEKS AGO:\n{listing}"}])
    txt = "".join(b.text for b in r.content if b.type == "text")
    m = re.search(r"\{.*\}", txt, re.S)
    return json.loads(m.group(0)) if m else {}


def find_return(tenant: str, text: str):
    """The whole feature, one call. Returns {'deposit','why','when','id'} or None (the common case).
    NEVER raises into the reply path: a broken return must cost nothing but itself."""
    try:
        if os.environ.get("CO_RETURN") == "off" or len(text or "") < 12:
            return None
        entries = _journal_entries(tenant)
        if len(entries) < 20:                                # not enough deposited to owe anything back
            return None
        c = _conn(tenant)
        try:
            if _recent_return(c):
                return None
            used = {r[0] for r in c.execute("SELECT deposit_ts FROM returns")}
            cands = _prefilter(entries, text, used, time.time())
            if not cands:
                return None

            import asyncio
            verdict = asyncio.run(_judge(text, cands)) or {}
            idx, conf = verdict.get("index"), float(verdict.get("confidence") or 0)
            if idx is None or not isinstance(idx, int) or not (0 <= idx < len(cands)) or conf < MIN_CONFIDENCE:
                return None

            ts, body = cands[idx]
            why = (verdict.get("why") or "").strip()
            cur = c.execute(
                "INSERT INTO returns (deposit_ts, deposit_text, why, confidence, trigger_text, surfaced_at) "
                "VALUES (?,?,?,?,?,?)",
                (ts, body[:2000], why, conf, (text or "")[:500], time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
            c.commit()
            return {"id": cur.lastrowid, "deposit": body, "why": why,
                    "when": time.strftime("%b %d", time.localtime(ts)), "confidence": conf}
        finally:
            c.close()
    except Exception:
        return None


def hint_line(ret: dict) -> str:
    """What the engine sees. A HINT, not a script — the voice is the engine's, always. The failure mode
    this guards against is a bolted-on paragraph that reads like a different app talking."""
    return ("[THE RETURN — they sent you this on {when}, and it connects to what they just said: "
            "\"{dep}\"\n  why it matters now: {why}\n  Work it into your reply as a person would ('you sent "
            "me that thing about X back in {when}...'). ONE mention, naturally placed, then move on. If it "
            "doesn't fit what you're actually saying, drop it entirely — a forced callback is worse than "
            "none.]").format(when=ret["when"], dep=ret["deposit"][:600].replace("\n", " "), why=ret["why"])


# ── the label ────────────────────────────────────────────────────────────────────────────────────────
_HIT = re.compile(r"\b(yes|yeah|yep|exactly|right|forgot|damn|oh shit|wow|good (one|call|catch)|"
                  r"nice|that'?s it|true|totally|holy)\b", re.I)
_MISS = re.compile(r"\b(no|nope|not (really|why|it)|wrong|irrelevant|random|weird|huh|what\?|"
                   r"unrelated|doesn'?t (fit|connect)|stop)\b", re.I)


def record_reaction(tenant: str, reply_text: str, window_minutes: int = 45):
    """Read the next message as the verdict on the last return. Cheap and lexical on purpose: a model
    call here would cost a turn of latency to label something a regex gets right most of the time, and a
    wrong label is recoverable — an unlabelled one is gone forever."""
    try:
        c = _conn(tenant)
        try:
            row = c.execute("SELECT id, surfaced_at FROM returns WHERE reaction IS NULL "
                            "ORDER BY id DESC LIMIT 1").fetchone()
            if not row:
                return None
            rid, surfaced = row
            try:
                age = time.time() - time.mktime(time.strptime(surfaced, "%Y-%m-%dT%H:%M:%SZ"))
            except Exception:
                age = 0
            if age > window_minutes * 60:                    # they moved on; an unanswered return is not a miss
                return None
            t = reply_text or ""
            label = "hit" if _HIT.search(t) else "miss" if _MISS.search(t) else "unclear"
            c.execute("UPDATE returns SET reaction=?, reaction_text=?, reacted_at=? WHERE id=?",
                      (label, t[:500], time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), rid))
            c.commit()
            return label
        finally:
            c.close()
    except Exception:
        return None


def stats(tenant: str = "dennis") -> dict:
    c = _conn(tenant)
    try:
        rows = dict(c.execute("SELECT COALESCE(reaction,'pending'), count(*) FROM returns GROUP BY 1").fetchall())
        rows["total"] = c.execute("SELECT count(*) FROM returns").fetchone()[0]
        return rows
    finally:
        c.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--stats":
        print(json.dumps(stats(), indent=2))
    else:
        got = find_return("dennis", " ".join(args) or "thinking about what makes an interface actually correct")
        print(json.dumps(got, indent=2) if got else "(no return — silence is the default)")
