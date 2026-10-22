#!/usr/bin/env python3
"""Open threads — the tiny rolling state the brain carries every turn (7/1 addendum, memory management).

Per tenant: the last ~3 active topics + any stated commitments with dates, in `<claims_db>.threads.json`.
Continuity becomes cheap: the engine (server.ts threadsBlock) and the daily text read THIS instead of
rereading everything. Updated by the router after each send. CHEAP EYES: Gemini flash-lite does the update;
a deterministic theme-counter is the no-LLM fallback. Never raises — a failed update keeps the old state.

DECAY (hard rule): a topic older than 7 days drops off unless it has repeated 3+ times. A commitment
expires 3 days after its due date (or after 21 days if undated). Nothing stale gets carried.

  python3 threads.py <claims_db> "the send text"        # update + print
  python3 threads.py <claims_db>                        # just print current state
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

MAX_TOPICS = 3
MAX_COMMITMENTS = 3

UPDATE_PROMPT = """You maintain a tiny rolling state about one person: their OPEN THREADS (max 3 active topics)
and STATED COMMITMENTS (things THEY said they'd do, with dates when given). You get the previous state and one
new thing they just sent. Return the updated state.

Rules:
- topics: short human labels ("founder-burnout content", "the pipeline rewrite", "trip to portland"). If the
  new send belongs to an existing topic, bump its count and set last to today. Else add it (drop the oldest
  lowest-count topic if over 3). Merge near-duplicates.
- commitments: ONLY when they clearly stated intent ("i'll film one this weekend", "quitting by sept 1").
  due = ISO date if a date/timeframe was given, else "". Never invent a commitment from a link they shared.
- Keep labels/text under 60 chars. No psychoanalysis, just what's live.
Return ONLY JSON: {"topics":[{"label","count","last"}],"commitments":[{"text","due","made"}]}"""


def _path(claims_db: str) -> Path:
    return Path(f"{claims_db}.threads.json")


def load(claims_db: str) -> dict:
    p = _path(claims_db)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"topics": [], "commitments": []}


def _decay(state: dict) -> dict:
    """The 7-day decay + caps, enforced deterministically no matter what the LLM returned."""
    today = dt.date.today()
    topics = []
    for t in state.get("topics", []):
        label = str(t.get("label", ""))[:60].strip()
        if not label:
            continue
        try:
            last = dt.date.fromisoformat(str(t.get("last", ""))[:10])
        except ValueError:
            last = today
        count = int(t.get("count", 1) or 1)
        age = (today - last).days
        if age > 7 and count < 3:
            continue                      # decayed
        if age > 21:
            continue                      # even strong topics go quiet after 3 weeks untouched
        topics.append({"label": label, "count": count, "last": last.isoformat()})
    topics.sort(key=lambda t: (t["last"], t["count"]), reverse=True)

    commitments = []
    for c in state.get("commitments", []):
        text = str(c.get("text", ""))[:80].strip()
        if not text:
            continue
        made = str(c.get("made", ""))[:10] or today.isoformat()
        due = str(c.get("due", ""))[:10]
        try:
            if due and (today - dt.date.fromisoformat(due)).days > 3:
                continue                  # due date passed 3+ days ago — stale
            if not due and (today - dt.date.fromisoformat(made)).days > 21:
                continue                  # undated commitments expire in 3 weeks
        except ValueError:
            due = ""
        commitments.append({"text": text, "due": due, "made": made})

    return {"topics": topics[:MAX_TOPICS], "commitments": commitments[:MAX_COMMITMENTS],
            "updated": dt.datetime.now().isoformat(timespec="seconds")}


def _fallback_update(state: dict, send: str) -> dict:
    """No-LLM path: bump/add a topic keyed by co_react's coarse theme. Commitments need the LLM; skipped."""
    try:
        import co_react
        theme = co_react._theme(send)
    except Exception:
        theme = "other"
    label = {"shipping-avoidance": "shipping avoidance", "founder-identity": "founder identity",
             "quitting": "quitting/leaving", "relationships": "reaching out to people"}.get(theme, "")
    if not label:
        words = re.findall(r"[a-zA-Z]{4,}", send)[:3]
        label = " ".join(words).lower() or "misc"
    today = dt.date.today().isoformat()
    for t in state.setdefault("topics", []):
        if t.get("label") == label:
            t["count"] = int(t.get("count", 1)) + 1
            t["last"] = today
            break
    else:
        state["topics"].append({"label": label, "count": 1, "last": today})
    return state


def _llm_update(state: dict, send: str) -> dict | None:
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        return None
    try:
        import link_read
        client = link_read._gemini_client()
        if not client:
            return None
        payload = json.dumps({"previous_state": {"topics": state.get("topics", []),
                                                 "commitments": state.get("commitments", [])},
                              "they_just_sent": send[:800],
                              "today": dt.date.today().isoformat()})
        out = link_read._gemini_generate(client, [UPDATE_PROMPT, payload])
        if not out:
            return None
        m = re.search(r"\{.*\}", out, re.S)
        if not m:
            return None
        got = json.loads(m.group(0))
        if not isinstance(got.get("topics"), list):
            return None
        return got
    except Exception:
        return None


def update(claims_db: str, send: str, enrichment: str | None = None) -> dict:
    """The one entry point the router calls after capture. Returns the new state (and persists it)."""
    state = load(claims_db)
    text = send + (f"\n{enrichment}" if enrichment else "")
    new = _llm_update(state, text) or _fallback_update(state, send)
    new = _decay(new)
    try:
        tmp = _path(claims_db).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(new, ensure_ascii=False))
        os.replace(tmp, _path(claims_db))
    except OSError:
        pass
    return new


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "claims.db")
    if len(sys.argv) > 2:
        print(json.dumps(update(db, " ".join(sys.argv[2:])), indent=2))
    else:
        print(json.dumps(load(db), indent=2))
