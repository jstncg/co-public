#!/usr/bin/env python3
"""MAKE REAL — the episode loop. The third verb, and the lab's primary instrument (the-lab.md:
TEST is senior; a resolved episode is an experiment on the self; the receipt is identity evidence).

An episode is a want with a plan attached: draft → their yes → the reversible work → a receipt in
the thread → the outcome probe. v0 authority is LADDER LEVEL 2 (PREPARE) with a toe on 3: co does
every safe step — research, comparison, drafts, the exact next move — and hands back a decision
packet. It does not spend, send to third parties, or commit. The phone/browser hands raise the
ceiling later; the LOOP is what ships today, because the loop is what produces receipts and
outcomes, and those are the two empty tables every thesis doc leans on.

States: draft -> proposed -> approved -> done | declined | dead
  - proposed: the packet is in the thread, waiting on their word. ONE pending episode at a time —
    a queue of open asks is nagging with extra steps.
  - approved: they said yes; the prepared work is delivered as the receipt.
  - declined: their no is recorded verbatim — a no is a label, not a failure (desire-states: a want
    that dies under a real test was exposure).
  - outcome: probed once, later, via the requested-reminder rail — an identity probe, never a
    satisfaction survey ("what did doing this tell you about what you actually want?").
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

MODEL = os.environ.get("CO_WORK_MODEL", "claude-sonnet-4-6")    # work products: spend where the work is
JUDGE_MODEL = os.environ.get("CO_JUDGE_MODEL", "claude-haiku-4-5")  # verdicts: cheap, structured

PLAN_SYS = """Someone asked their co to MAKE something REAL — handle it, find it, set it up, get it
done. Your job: do every REVERSIBLE step in your head and produce the decision packet. You cannot
browse; you plan from what's given and general knowledge, and you say plainly which facts need live
verification.

Return ONLY JSON:
{"what": "<the episode, one line, their words>",
 "plan": ["<step already safe to consider done (research/comparison/reasoning)>", ...],
 "packet": "<the decision packet as ONE text message: what you found/prepared, the concrete next
move, what it costs (money/time), what could go wrong, and THE QUESTION — what you'll do on their
yes. Text-message register, no headers, no bullets. End with the ask.>",
 "needs_live": ["<fact that must be verified in the world before acting, or empty>"],
 "beyond_authority": "<anything they asked for that exceeds prepare-and-draft (spending, sending to
third parties, booking) — named honestly, or null>"}"""

APPROVAL_SYS = """A proposal is pending. Their new message arrived. Did they approve it, decline it,
or is this about something else entirely?
Return ONLY JSON: {"verdict": "yes" | "no" | "unrelated", "note": "<their words that decide it, compressed>"}
"yes" needs real assent (yes/do it/go/book it/sounds good). "no" is any refusal or redirect of the
plan. Everything else — including questions ABOUT the plan — is "unrelated" (the conversation
continues; the proposal stays pending)."""


def _db(tenant: str) -> str:
    d = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(d, "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")


def _conn(tenant: str):
    c = sqlite3.connect(_db(tenant), timeout=10)
    c.execute("""CREATE TABLE IF NOT EXISTS episodes (
        id          INTEGER PRIMARY KEY,
        what        TEXT NOT NULL,
        state       TEXT DEFAULT 'proposed',   -- proposed | approved | done | declined | dead
        plan_json   TEXT,
        packet      TEXT,
        receipt     TEXT,
        decline_note TEXT,
        outcome     TEXT,
        created_at  TEXT NOT NULL,
        decided_at  TEXT,
        done_at     TEXT
    )""")
    c.commit()
    return c


async def _ask(system: str, user: str, model: str, max_tokens: int = 900, tools=None,
               return_trace: bool = False):
    # return_trace: also report whether the model actually USED a tool — an offered
    # web_search the model skipped is how stale training-memory answers wear a search costume.
    import asyncio as _a
    from anthro import make_client
    client = make_client()

    def _out(parsed, used):
        return (parsed, used) if return_trace else parsed

    for m, wait in ((model, 0), (model, 3), (JUDGE_MODEL, 0)):
        if wait:
            await _a.sleep(wait)
        try:
            kw = {"tools": tools} if tools else {}
            r = await client.messages.create(model=m, system=system, max_tokens=max_tokens,
                                             messages=[{"role": "user", "content": user}], **kw)
            used_tools = any(getattr(b, "type", "") not in ("", "text") for b in r.content)
            t = "".join(b.text for b in r.content if b.type == "text")
            g = re.search(r"\{.*\}", t, re.S)
            if g:
                try:
                    return _out(json.loads(g.group(0)), used_tools)
                except json.JSONDecodeError:
                    pass
            # TRUNCATION REPAIR (7/31): a response cut at max_tokens used to throw away the
            # whole answer — every organ silently returned nothing (caught when patterns-with-
            # receipts outgrew its budget). Salvage the complete prefix instead.
            raw = t[t.find("{"):] if "{" in t else ""
            # try only REAL boundaries (last N closing tokens), newest first — bounded work.
            bounds = [i + 1 for i, ch in enumerate(raw) if ch in "}]"][-40:]
            for cut in reversed(bounds):
                frag = raw[:cut].rstrip().rstrip(",")
                for closer in ("", "}", "]}", "}]}", "}]}}"):
                    try:
                        return _out(json.loads(frag + closer), used_tools)
                    except json.JSONDecodeError:
                        continue
        except Exception as e:
            if not any(k in str(e) for k in ("429", "rate_limit", "overloaded", "529")):
                raise
    return _out(None, False)


def pending(tenant: str):
    """The one open proposal, or None. One at a time is the law."""
    try:
        c = _conn(tenant)
        try:
            row = c.execute("SELECT id, what, packet, created_at FROM episodes WHERE state='proposed' "
                            "ORDER BY id DESC LIMIT 1").fetchone()
            return {"id": row[0], "what": row[1], "packet": row[2], "created_at": row[3]} if row else None
        finally:
            c.close()
    except Exception:
        return None


def propose(tenant: str, ask: str, context: str = ""):
    """Compile the ask into a decision packet. Returns {'packet','what','beyond'} or None.
    Refuses (returns the pending one) if a proposal is already open — one at a time."""
    try:
        import asyncio
        if pending(tenant):
            p = pending(tenant)
            return {"packet": None, "what": p["what"], "already_open": True}
        got = asyncio.run(_ask(PLAN_SYS, (f"CONTEXT (what co knows, may be empty):\n{context[:2000]}\n\n"
                                          f"THE ASK:\n{ask}"), MODEL)) or {}
        if not (got.get("packet") or "").strip():
            return None
        c = _conn(tenant)
        try:
            c.execute("INSERT INTO episodes (what, plan_json, packet, created_at) VALUES (?,?,?,?)",
                      ((got.get("what") or ask[:200]),
                       json.dumps({"plan": got.get("plan") or [], "needs_live": got.get("needs_live") or []}),
                       got["packet"][:1500], time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
            c.commit()
        finally:
            c.close()
        return {"packet": got["packet"][:1500], "what": got.get("what") or ask[:200],
                "beyond": got.get("beyond_authority"), "needs_live": got.get("needs_live") or []}
    except Exception:
        return None


def judge_reply(tenant: str, text: str):
    """A proposal is pending and a message arrived: approve / decline / unrelated.
    On approve: state->approved, returns {'verdict':'yes', 'episode':...}. Caller delivers the
    receipt. On decline: recorded verbatim (a no is a label). Unrelated: conversation continues."""
    try:
        import asyncio
        p = pending(tenant)
        if not p:
            return None
        # RESILIENT VERDICT (7/31): a rate-limited judge used to return None → their "yes" was
        # read as ordinary chat and the episode sat pending forever. The approval is the moment
        # the whole loop rests on; it gets real retries.
        got = {}
        for attempt in range(3):
            got = asyncio.run(_ask(APPROVAL_SYS,
                                   f"PENDING PROPOSAL:\n{p['packet'][:800]}\n\nTHEIR MESSAGE:\n{text[:500]}",
                                   JUDGE_MODEL, max_tokens=120)) or {}
            if got.get("verdict"):
                break
            time.sleep(1.5 * (attempt + 1))
        v = (got.get("verdict") or "unrelated").lower()
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        c = _conn(tenant)
        try:
            if v == "yes":
                c.execute("UPDATE episodes SET state='approved', decided_at=? WHERE id=?", (now, p["id"]))
                c.commit()
                return {"verdict": "yes", "episode": p}
            if v == "no":
                c.execute("UPDATE episodes SET state='declined', decided_at=?, decline_note=? WHERE id=?",
                          (now, str(got.get("note") or text)[:300], p["id"]))
                c.commit()
                return {"verdict": "no", "episode": p}
            return {"verdict": "unrelated", "episode": p}
        finally:
            c.close()
    except Exception:
        return None


RECEIPT_SYS = """They just said YES to a proposal their co prepared. The reversible work is done;
now write THE RECEIPT — the follow-up text that lands in the thread a moment after "on it."

You get the original ask, the plan, and LIVE EVIDENCE gathered just now for the facts that needed
verification. Write ONE text message: what checked out (with the load-bearing link if there is one),
what changed from the plan if anything, the single concrete next move that is now theirs, and be
plainly honest about anything that could NOT be verified — an honest gap beats a confident guess.
Text-message register. No headers, no bullets, no preamble. Under 900 characters.
Return ONLY JSON: {"receipt": "<the message>"}"""


def _exa(q: str, n: int = 3):
    """Live lookup for a needs_live fact. Same rail the watches ride."""
    import requests
    try:
        r = requests.post("https://api.exa.ai/search",
                          headers={"x-api-key": os.environ.get("EXA_API_KEY", ""),
                                   "Content-Type": "application/json"},
                          json={"query": q, "numResults": n, "type": "auto",
                                "contents": {"highlights": {"numSentences": 3}}}, timeout=25)
        r.raise_for_status()
        out = []
        for h in (r.json().get("results") or [])[:n]:
            hl = " ".join(h.get("highlights") or [])[:400]
            out.append(f"- {h.get('title','')} ({h.get('url','')}): {hl}")
        return "\n".join(out)
    except Exception as e:
        return f"(lookup failed: {e})"


def execute(tenant: str, episode_id: int):
    """The approved work, v0: verify every needs_live fact live (Exa), then compile the receipt.
    Returns the receipt text or None. Caller sends it and calls complete()."""
    try:
        import asyncio
        c = _conn(tenant)
        try:
            row = c.execute("SELECT what, plan_json, packet FROM episodes WHERE id=?", (episode_id,)).fetchone()
        finally:
            c.close()
        if not row:
            return None
        what, plan_raw, packet = row
        try:
            plan = json.loads(plan_raw or "{}")
        except Exception:
            plan = {}
        if isinstance(plan, list):                       # pre-execute rows stored a bare list
            plan = {"plan": plan, "needs_live": []}
        evidence = []
        for q in (plan.get("needs_live") or [])[:3]:
            found = _exa(str(q))
            if not found.startswith("(lookup failed"):
                evidence.append(f"NEEDED: {q}\nFOUND:\n{found}")
        # web_search rides the receipt call itself — needs_live gets verified even when Exa is
        # down (it 402'd the day this shipped; the fallback caught a $500 stale price in testing)
        needs = [str(q) for q in (plan.get("needs_live") or [])[:3]]
        got = asyncio.run(_ask(RECEIPT_SYS,
                               (f"THE ASK:\n{what}\n\nTHE PLAN:\n"
                                f"{json.dumps(plan.get('plan') or [], indent=0)[:1200]}\n\n"
                                f"THE PROPOSAL THEY APPROVED:\n{packet[:1000]}\n\n"
                                f"FACTS THAT NEED LIVE VERIFICATION (search for any not covered "
                                f"by evidence below):\n" + ("\n".join(f"- {q}" for q in needs) or "(none)") +
                                f"\n\nPRE-GATHERED EVIDENCE:\n" +
                                ("\n\n".join(evidence) if evidence else "(none — search yourself)")),
                               MODEL, max_tokens=1500,
                               tools=[{"type": "web_search_20250305", "name": "web_search",
                                       "max_uses": 4}])) or {}
        r = (got.get("receipt") or "").strip()
        return r[:1200] if r else None
    except Exception:
        return None


def complete(tenant: str, episode_id: int, receipt: str):
    """The receipt lands: state->done, and the outcome probe is scheduled as a REQUESTED anchor
    (a kept promise, next-day) — the identity probe, asked once, never re-asked."""
    try:
        c = _conn(tenant)
        try:
            c.execute("UPDATE episodes SET state='done', receipt=?, done_at=? WHERE id=?",
                      (receipt[:1000], time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), episode_id))
            c.commit()
            what = c.execute("SELECT what FROM episodes WHERE id=?", (episode_id,)).fetchone()[0]
        finally:
            c.close()
        try:
            import datetime as dt
            import anchors
            st = anchors._load(_db(tenant))
            when = (dt.datetime.now() + dt.timedelta(hours=22)).replace(microsecond=0)
            st.setdefault("anchors", []).append({
                "what": f"episode outcome: {what[:80]}", "kind": "deadline",
                "when": when.isoformat(), "fire": when.isoformat(),
                "quote": "what did doing this tell you about what you actually want?",
                "requested": True,                # a promise: the probe rides the kept-promise rail
                "created": dt.datetime.now().isoformat(timespec="seconds"), "fired": False})
            anchors._save(_db(tenant), st)
        except Exception:
            pass                                   # probe is best-effort; the receipt is the point
        return True
    except Exception:
        return False


def record_outcome(tenant: str, episode_id: int, outcome: str):
    try:
        c = _conn(tenant)
        try:
            c.execute("UPDATE episodes SET outcome=? WHERE id=?", (outcome[:500], episode_id))
            c.commit()
        finally:
            c.close()
        return True
    except Exception:
        return False


def listing(tenant: str) -> str:
    try:
        c = _conn(tenant)
        try:
            rows = c.execute("SELECT id, what, state, created_at FROM episodes ORDER BY id DESC LIMIT 10").fetchall()
        finally:
            c.close()
        if not rows:
            return "no episodes yet."
        return "\n".join(f"- [{st}] {w[:70]} ({ca[:10]})" for _, w, st, ca in rows)
    except Exception:
        return "no episodes yet."


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--list":
        print(listing("dennis"))
    elif args:
        got = propose("dennis", " ".join(args))
        print(json.dumps(got, indent=2) if got else "(could not compile an episode)")
    else:
        print(listing("dennis"))
