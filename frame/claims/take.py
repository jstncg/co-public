#!/usr/bin/env python3
"""THE TAKE — co is allowed an opinion again, on a bar (8/28).

Founder: "the agent needs to be a bit more witty and opinionated."

The register was never the problem. CO_SYSTEM already demands wit — "a reply that is correct but
no fun is a miss" — and law 6 says make the call, own it, never a menu. The problem is that co
is almost never ALLOWED TO SPEAK. The response ladder (8/22, task #67) gives a plain deposit
silence, so the only messages reaching the member are answers to direct questions, and an answer
is the least witty shape there is. Co is not flat. Co is muted.

That ruling was correct from real data: unrequested prose on every deposit collapsed his weekly
sends 68 → 2. But it removed the bad prose and the good take together, and the distinction is
sharp. What killed depositing was co speaking WITH NOTHING TO SAY — a summary, a compliment, a
restatement of the link. A take is different in kind: a position, a connection to something else
of theirs, a disagreement. It earns the interruption or it does not ship.

So the bar, not the ban:

    A TAKE IS A POSITION, A CONNECTION, OR A DISAGREEMENT. Never a summary, never praise, never
    a question dressed as a thought, never "interesting". If it could be written by someone who
    had not read the thing, it is not a take.

    IT MUST BEAT SILENCE. The judge is asked whether this is worth interrupting for, against a
    default of saying nothing — not whether it is good.

    ONE A DAY, AND MEASURED. Every take is recorded in landed.py, so in a week the question
    "does this help or does it collapse his sends again" is answered by the ledger instead of by
    another argument. That measurement did not exist when the ladder was written.

Off by default. This is the single riskiest change to the member's own usage that co can make.

    python3 take.py <tenant> "<what they sent>"
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STATE = os.path.expanduser("~/.co/take.json")
MAX_A_DAY = 1

TAKE_SYS = """You are co. The member just sent you something without asking a question. You may
answer with a TAKE, or with nothing at all. Silence is the default and it is usually right.

A take is ONE of:
  a position    — where you land on it, owned, possibly wrong
  a connection  — this against something else of theirs you can point to
  a disagreement— the thing is wrong, or the popular read of it is

A take is NEVER: a summary, a compliment, "interesting", a question dressed as a thought, or
anything writable by someone who never opened the thing.

THE TAKE IS ABOUT THE THING, NOT ABOUT THEM. "you're consuming X instead of doing Y" is a scold
wearing a take's clothes, and it is the single most common way this goes wrong. You are two people
talking about an idea, not a coach grading someone. Never tell them what they are really doing,
never diagnose their habits, never use anything you know about them as evidence against them. What
you know about them is there to find the ONE THING OF THEIRS worth putting next to this — that is
what a connection is.

If you have one, write it the way you text: lowercase, short, no preamble, no em-dashes, land it
and stop. Under 20 words. If you have nothing, return "".

Reply ONLY JSON: {"take": "..." or "", "kind": "position|connection|disagreement"}"""

# THE WRITER MAY NOT GRADE ITSELF (8/28). The first build asked for a take and a 0-10 score in one
# call. The scores were noise: one take came back 7, and the same take on the same context came
# back 4 a minute later, so any bar was gating on a random number — at 8 nothing shipped, and at 7
# what shipped was a coin flip. The judge is now a separate call that never saw the instructions
# for writing a take and cannot tell whose it is. It answers one question, against a default of no.
JUDGE_SYS = """A message is about to interrupt someone's day, unprompted, because an assistant had
a thought about something they sent. You decide whether it goes.

Send it ONLY if it tells them something they did not already have: a real position, a connection to
their own stuff, or a disagreement worth having.

Do not send it if it summarises what they sent, praises it or them, restates it in other words,
asks a question, or is the kind of thing anyone could say without reading it. Those are the common
cases and the answer for all of them is no. When it is close, the answer is no — the cost of a
message that says nothing is that they stop sending things at all.

Reply ONLY JSON: {"send": true|false, "why": "a few words"}"""


def _load() -> dict:
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def _save(d: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(d, open(STATE, "w"), ensure_ascii=False)


def rostered(tenant: str) -> bool:
    try:
        import roster
        return roster._rostered(tenant, "CO_TAKE_TENANTS")
    except Exception:
        return False


def spent_today(tenant: str) -> bool:
    return (_load().get(tenant) or {}).get("day") == dt.date.today().isoformat()


def mark(tenant: str) -> None:
    d = _load()
    d[tenant] = {"day": dt.date.today().isoformat()}
    _save(d)


def beats_silence(deposit: str, text: str) -> bool:
    """The independent judge. Shown the take and what prompted it, and nothing about who wrote it
    or what it was trying to be."""
    import llm
    got = llm.ask_json(llm.json_specs(), JUDGE_SYS,
                       f"THEY SENT:\n{(deposit or '')[:900]}\n\nTHE MESSAGE:\n{text}",
                       max_tokens=120) or {}
    return bool(got.get("send"))


def compose(tenant: str, deposit: str, context: str = "") -> str:
    """A take worth the interruption, or "". Never raises: a broken judge means silence, which
    is the behaviour the ladder already guarantees.

    Spends the day's one take on return, not on send. A caller that drops the text on the floor
    burns the allowance, which is the safe direction to fail — the alternative is a cap enforced
    only by every caller remembering to mark, and the first one that forgets sends all day."""
    if not rostered(tenant) or spent_today(tenant):
        return ""
    try:
        import disposition
        import llm
        got = llm.ask_json(llm.json_specs(), TAKE_SYS,
                           f"THEY SENT:\n{(deposit or '')[:1500]}\n\n"
                           f"WHAT ELSE IS THEIRS:\n{(context or '(nothing relevant)')[:900]}",
                           max_tokens=200) or {}
        text = disposition.sanitize(str(got.get("take") or "").strip())
        if not text or disposition.violations(text, max_chars=160):
            return ""
        if not beats_silence(deposit, text):
            return ""
        mark(tenant)
        return text
    except Exception:
        return ""


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    dep = " ".join(sys.argv[2:]) or "https://example.com/some-essay"
    os.environ.setdefault("CO_TAKE_TENANTS", t)          # probe only; the lane stays off in env
    print(repr(compose(t, dep)) or "(silence)")
