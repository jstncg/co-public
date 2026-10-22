#!/usr/bin/env python3
"""THE FINDING — ask what you've saved, get what's actually there.

The pull half. THE RETURN pushes something back when it connects; this answers when he asks. Together
they're the payback loop: everything he's ever sent becomes referenceable instead of write-only.

THREE CHOICES THAT MAKE THIS NOT A SEARCH BOX:

1. READ EVERYTHING. NEVER RETRIEVE. The whole corpus is ~13k tokens (181 entries, 63KB) and it stays
   small even at 10x. Top-k retrieval exists because web-scale systems cannot afford to read; at
   personal scale that constraint doesn't apply, and honouring it anyway throws away the one structural
   advantage this has over Notion. Reading all of it is what lets the answer know what ISN'T there,
   how often something recurred, and what got dropped — none of which survive a top-k cut.

2. SYNTHESIS, NOT DOCUMENTS. Twelve links back is a failure: he already remembers eleven of them. The
   answer is the paragraph a friend who read all of it would say, with dates as receipts.

3. THE FINDING ITSELF. Every answer carries one thing he did NOT ask about — a recurrence he hasn't
   named, something he dropped, a contradiction. Searching only ever returns what you thought to ask
   for, and the whole problem is that you don't know what you've forgotten.

Answers ride back as a hint so the ENGINE speaks them in voice — this module supplies substance, never
phrasing. Personality is not negotiable and it lives in one place.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MODEL = os.environ.get("CO_ASK_MODEL", "claude-sonnet-4-6")     # the ASK is the payoff moment
FALLBACK_MODEL = "claude-haiku-4-5"  # a 429 must degrade to a worse answer, never to "nothing found"
MAX_CORPUS_CHARS = 300_000      # ~75k tokens: the whole journal, with room to grow ~5x before paging

GATE_MODEL = "claude-haiku-4-5"   # runs on every inbound: cheap, reads the corpus, decides if it matters

# NO PHRASE LIST. The first version gated recall on a regex of asks I imagined ("what did i save
# about…"), which is overfitting twice over: it misses every phrasing I didn't think of, and it treats
# recall as a MODE you invoke rather than something the thing simply has. A friend who read everything
# doesn't need a magic word, and they also don't recite your archive at you unprompted. So: one cheap
# pass on every message that reads the whole corpus and decides for itself, with the bar set high.
GATE_SYS = """You hold everything one person has ever saved to their capture tool — links, thoughts,
screenshots, voice memos, all dated. They just sent a new message. Decide whether anything they've saved
should come into the reply.

Return ONLY JSON: {"kind": "asked" | "watch" | "make_real" | "commission" | "connects" | "none", "topic": "<what to look up/watch/do, or null>"}

"make_real" — they are asking co to DO something: handle it, find and compare options, set
  something up, draft it, figure out how, get it done. A task with a deliverable, in any phrasing
  ("can you sort out X", "find me the best Y", "help me get Z done"). NOT a question about their
  archive, NOT a request to watch — a request for WORK.

"commission" — they are asking co to research something and report back LATER, with a timeframe
  stated or implied: "look into X and tell me in a few days", "dig into Y this week and get back to
  me", "research Z and tell me what you find this weekend". The deferral is the tell: work now,
  report on a promised day. A do-it-now ask is "make_real"; no research involved = not this.

"watch" — they are asking co to keep an eye on something GOING FORWARD, in any phrasing: "watch
  this", "tell me when", "keep an eye on", "track", "let me know if/when", "remind me when X happens
  (where X is a world event, not a time)". The request is about the future world, not their archive.

"asked" — they are REQUESTING something out of their archive. There must be a request, not merely a
  topic they happen to have saved about. Direct ("what did I save about X") or oblique ("wasn't there
  a thing about X", "didn't I send you something on this", "what have I been into lately"). Phrasing
  does not matter; the request does.
  NOT "asked": stating an opinion, a goal, or a feeling that merely touches a topic in the archive.
  "I want to be more like Naval" is a statement about himself, not a request for his Naval saves. If
  you would have to invent the question, it is not an ask.

"connects" — they are NOT asking, but something specific they saved weeks ago genuinely bears on what
  they just said. The bar here is HIGH and "none" is almost always right. A shared topic is not a
  connection. Say "connects" only when the old item would make them go "oh — right, I did send that."
  Small talk, logistics, and thinking-out-loud are "none".

"none" — the default and the common answer. When unsure, "none"."""

FIND_SYS = """You are the recall layer of someone's personal capture tool. They send it links, thoughts,
screenshots and voice memos; you have ALL of it below, dated. They just asked you something about it.

You are NOT a search engine. Returning a list of matching items is a failure — they already remember most
of what they'd recognize. You are the friend who read every single one and can say what's actually there.

Produce THREE things as JSON:

"answer": the direct substantive answer, 2-5 sentences. Specifics only: what they actually saved, what it
said, what they seemed to be after. Cite dates inline like (Jul 03). If they saved nothing relevant, say
so plainly — never pad, never invent, never stretch a weak match into a strong one.

"receipts": up to 5 of the actual items, each {"date": "Jul 03", "what": "<one compressed line, concrete
enough that they'd recognize it>"}. Ordered by usefulness, not recency.

"finding": USUALLY null. Only fill this when the corpus shows something real they'd want to know and
did not ask about — a recurrence they've never named, something they were deep in and abruptly dropped,
two saved things that contradict each other. It must be specific and traceable. An insight every time is
a tell that you're manufacturing them; most answers should just answer the question and stop.

Never flatter. Never psychoanalyze. Everything you say must be traceable to something below."""


async def _gate(text: str, index: str) -> dict:
    """Cheap relevance pass over the INDEX (one line per entry), not the full corpus.

    7/27: this used to send every entry's full text on EVERY inbound message — ~13k tokens a turn,
    which both slowed the reply and made 429s likely when he sends several messages in a row. Worse,
    a 429 was swallowed into {} and read downstream as 'nothing to recall', so a rate limit was
    INDISTINGUISHABLE from a considered no. That is why recall never fired in production despite the
    gate answering correctly when tested by hand.

    Now: the gate sees a dated one-line-per-entry index and picks; the expensive full read only
    happens after it decides there IS something. Failures raise so the caller can say so."""
    import asyncio as _a
    import llm
    # NO ANTHROPIC CREDENTIAL → the provider-neutral chain (8/13). Without this the gate is the
    # first thing that dies on a machine holding a Gemini key, and because every action verb is
    # behind it, nothing downstream can be tested at all. The caching below is Anthropic-only, so
    # this path is genuinely more expensive per call — which is why it is the fallback and not the
    # default. `None` means the chain produced nothing usable and must raise, NOT return {}: the
    # 7/27 lesson is that a failure indistinguishable from a considered no is how recall goes dark.
    if not llm.have_anthropic():
        got = await _a.to_thread(
            llm.ask_json, llm.json_specs(),
            f"{GATE_SYS}\n\nEVERYTHING THEY HAVE SAVED (one line each):\n\n{index}",
            f"NEW MESSAGE: {text}", 60)
        if got is None:
            raise RecallUnavailable("no anthropic credential and the fallback chain produced nothing")
        return got
    from anthro import make_client
    client = make_client()
    # PROMPT CACHING (system-review #2): the index is identical bytes between captures — it belongs
    # in a cached system block, not re-billed and re-processed per message. With the 5-min TTL this
    # collapses gate latency and cost inside every conversation burst, which is exactly when the
    # gate runs most. The user turn carries ONLY the new message.
    system_blocks = [
        {"type": "text", "text": GATE_SYS},
        {"type": "text", "text": f"EVERYTHING THEY HAVE SAVED (one line each):\n\n{index}",
         "cache_control": {"type": "ephemeral"}},
    ]
    last = None
    for wait in (0, 2, 5):
        if wait:
            await _a.sleep(wait)
        try:
            r = await client.messages.create(
                model=GATE_MODEL, system=system_blocks, max_tokens=60,
                messages=[{"role": "user", "content": f"NEW MESSAGE: {text}"}])
            txt = "".join(b.text for b in r.content if b.type == "text")
            m = re.search(r"\{.*\}", txt, re.S)
            if m:
                return json.loads(m.group(0))
            return {}
        except Exception as e:
            last = e
            if not any(k in str(e) for k in ("429", "rate_limit", "overloaded", "529", "500")):
                break
    raise RecallUnavailable(str(last)[:200] if last else "gate produced no verdict")


def _corpus(tenant: str):
    """The WHOLE journal, dated, oldest first. No filtering, no ranking, no cutoff — see choice 1."""
    p = os.path.expanduser(f"~/.co/journal/{tenant}.json")
    try:
        with open(p) as f:
            entries = (json.load(f) or {}).get("entries", []) or []
    except Exception:
        return "", 0
    lines, total = [], 0
    for e in entries:
        body = (e.get("text") or "").strip()
        link = (e.get("link") or "").strip()
        if link:
            body = f"{body}\n    {link}" if body else link
        if not body:
            continue
        when = e.get("date") or time.strftime("%Y-%m-%d", time.localtime(e.get("ts") or 0))
        try:
            pretty = time.strftime("%b %d", time.strptime(when, "%Y-%m-%d"))
        except Exception:
            pretty = when
        lines.append(f"({pretty}) {body}")
        total += len(body)
    if total > MAX_CORPUS_CHARS:                    # only ever trims the OLDEST, and says so upstream
        while total > MAX_CORPUS_CHARS and lines:
            total -= len(lines.pop(0))
    return "\n\n".join(lines), len(lines)


def _index(tenant: str):
    """One dated line per entry — enough to decide relevance, ~4x cheaper than the full text."""
    p = os.path.expanduser(f"~/.co/journal/{tenant}.json")
    try:
        with open(p) as f:
            entries = (json.load(f) or {}).get("entries", []) or []
    except Exception:
        return "", 0
    lines = []
    for e in entries:
        body = ((e.get("text") or "") + " " + (e.get("link") or "")).replace("\n", " ").strip()
        if not body:
            continue
        when = e.get("date") or ""
        try:
            pretty = time.strftime("%b %d", time.strptime(when, "%Y-%m-%d"))
        except Exception:
            pretty = when
        lines.append(f"({pretty}) {body[:160]}")
    return "\n".join(lines), len(lines)


class RecallUnavailable(Exception):
    """The gate could not reach a verdict (rate limit, outage). NOT the same as 'nothing to recall' —
    the caller must be able to tell those apart, which is exactly what this class exists for."""


async def _ask(question: str, corpus: str):
    """Sonnet, then Sonnet again after a beat, then Haiku. A 429 must never read as 'you saved nothing' —
    that is the one failure mode that would teach him the corpus is empty when it isn't."""
    import asyncio as _a
    # BEFORE `make_client`, not after. Both the import and the constructor fail without a
    # credential — `anthropic` may not even be installed — so a check placed under them is a check
    # that never runs. Same ordering in `_gate`.
    import llm
    # Same fallback as the gate, same reason (8/13). {} here rather than a raise: this is the ANSWER
    # path, and its contract already is "empty means nothing found" — the caller phrases around it.
    if not llm.have_anthropic():
        return await _a.to_thread(
            llm.ask_json, llm.json_specs(),
            f"{FIND_SYS}\n\nEVERYTHING THEY HAVE EVER SAVED:\n\n{corpus}",
            f"THEY ASKED: {question}", 1200) or {}
    from anthro import make_client
    client = make_client()
    system_blocks = [
        {"type": "text", "text": FIND_SYS},
        {"type": "text", "text": f"EVERYTHING THEY HAVE EVER SAVED:\n\n{corpus}",
         "cache_control": {"type": "ephemeral"}},
    ]
    for model, wait in ((MODEL, 3), (MODEL, 0), (FALLBACK_MODEL, 0)):
        try:
            r = await client.messages.create(model=model, system=system_blocks, max_tokens=1200,
                                             messages=[{"role": "user", "content": f"THEY ASKED: {question}"}])
            txt = "".join(b.text for b in r.content if b.type == "text")
            m = re.search(r"\{.*\}", txt, re.S)
            if m:
                return json.loads(m.group(0))
        except Exception as e:
            s = str(e)
            if ("429" in s or "rate_limit" in s or "overloaded" in s or "529" in s) and wait:
                await _a.sleep(wait)
            continue
    return {}


def recall(tenant: str, text: str, mode: str = "inline"):
    """The whole thing, one entry point, no modes. Reads the corpus, decides if it matters, and only
    then spends a real call. Returns {'kind','answer','receipts','finding','n'} or None.

    'asked'    → always answers. They asked; an unanswered ask is the only unforgivable miss.
    'connects' → rate-limited to once a day, because unprompted recall is charming once and nagging
                 twice. This is THE RETURN, arrived at by the same path instead of its own engine.
    Never raises into the reply path."""
    try:
        index, n = _index(tenant)
        # THIN-CORPUS LAW (7/30, caught by the rail eval): a new tenant has nothing to recall FROM,
        # but the ACTION verbs (watch / make_real / commission) need no corpus at all — a street-
        # cohort user's first "keep an eye on X" must work on day one. So: the gate always runs;
        # only asked/connects (which read the corpus) are suppressed while it's thin.
        thin = not index or n < 5
        if thin:
            index = "(they have saved almost nothing yet — a brand-new person)"
        import asyncio
        gate = asyncio.run(_gate(text, index)) or {}
        kind = (gate.get("kind") or "none").lower()
        if thin and kind in ("asked", "connects"):
            return None
        if kind == "make_real":
            return {"kind": "make_real", "topic": gate.get("topic"), "n": 0}
        if kind == "commission":
            return {"kind": "commission", "topic": gate.get("topic"), "n": 0}
        if kind == "watch":
            # not recall's job — hand the verdict to the router, which creates the watch. No corpus
            # read needed: the mandate is about the future world, not the archive.
            return {"kind": "watch", "topic": gate.get("topic"), "n": 0}
        if kind not in ("asked", "connects"):
            return None

        # 7/27 — WHERE each kind belongs, and why they are not the same feature:
        #   'asked'    is an ANSWER. He is waiting for it, so it blocks the reply and is allowed to
        #              cost a real read. Waiting is expected when you asked a question.
        #   'connects' is an INTERRUPTION wearing recall's clothes. It was blocking every reply to
        #              produce something he never asked for, adding ~18s to a text conversation. It
        #              belongs on the proactive path, under the same budget, quiet hours and cap as
        #              every other unprompted send — not inline.
        if mode == "inline" and kind != "asked":
            return None
        if mode == "proactive" and kind != "connects":
            return None
        if kind == "connects" and _connected_recently(tenant):
            return None                                      # unprompted stays rare, always
        corpus, _ = _corpus(tenant)          # full text, only now that it's worth reading
        question = text if kind == "asked" else (
            f"They just said: {text}\nSurface the specific thing they saved that bears on this, and why.")
        got = asyncio.run(_ask(question, corpus)) or {}
        if not (got.get("answer") or "").strip():
            return None
        got.update({"n": n, "kind": kind})
        _mark(tenant, kind)
        return got
    except Exception:
        return None


_STAMP = os.path.expanduser("~/.co/journal/.recall_stamp.json")


def _connected_recently(tenant: str, hours: int = 20) -> bool:
    try:
        with open(_STAMP) as f:
            return (time.time() - float((json.load(f) or {}).get(tenant, 0))) < hours * 3600
    except Exception:
        return False


def _mark(tenant: str, kind: str) -> None:
    if kind != "connects":                                   # only unprompted recall spends the budget
        return
    try:
        d = {}
        if os.path.exists(_STAMP):
            with open(_STAMP) as f:
                d = json.load(f) or {}
        d[tenant] = time.time()
        with open(_STAMP, "w") as f:
            json.dump(d, f)
    except Exception:
        pass


def _defang(t: str) -> str:
    """User-derived text riding INSIDE a directive hint reads as data, not structure (kyo 649489d):
    angle brackets become look-alikes so a saved entry can't forge a block or a fake directive."""
    return str(t).replace("<", "\u2039").replace(">", "\u203a")


def hint_line(res: dict) -> str:
    """Substance for the engine. It phrases; we never do."""
    rec = "\n".join(f"  - ({_defang(r.get('date',''))}) {_defang(r.get('what',''))}"
                    for r in (res.get("receipts") or [])[:5] if isinstance(r, dict))
    finding = _defang((res.get("finding") or "").strip())
    return (
        "[THE FINDING — they asked what they've saved. You read all {n} entries. Ground your reply in "
        "THIS and nothing else; keep the dates, they're the proof you actually looked.\n"
        "  answer: {a}\n"
        "{r}"
        "{f}"
        "  Say it in your voice, tight. Lead with the answer. Dates stay. Do NOT list everything — the "
        "receipts are support, not the point. A finding, if there is one, lands last as an aside, once — \
never as a lecture, never stretched. THE ARTIFACT BUBBLE LAW: if you hand back a saved LINK, the "
        "bare URL goes LAST, alone, after a blank line — its own message bubble, nothing else in it "
        "(that's how the preview card renders; a URL inside a sentence stays dead blue text).]"
    ).format(
        n=res.get("n", 0), a=(res.get("answer") or "").strip(),
        r=(f"  they saved:\n{rec}\n" if rec else ""),
        f=(f"  the finding (they did NOT ask this): {finding}\n" if finding else ""),
    )


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "what have i saved about interfaces"
    print(f"ask: {q}\n")
    got = find("dennis", q)
    print(json.dumps(got, indent=2) if got else "(nothing found)")
