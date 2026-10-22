#!/usr/bin/env python3
"""THE WEAVE — co writes the document, you correct it.

The reference layer. Capture is solved (you forward a thing, the eyes read it). Recall is solved (ask
and it answers). What has never existed is somewhere to LOOK — and a browsable archive is the wrong
answer, because nobody browses their own notes. That's why every note app dies: the library metaphor
asks you to go spelunking for something you don't remember having.

So this writes a LIVING DOCUMENT per live thread of thinking instead of an archive:

  YOU NEVER AUTHOR IT. The second you're typing into a blank page it's Notion and it's dead. co
  drafts from what you actually sent; your job is to correct the wrong line, not to fill the page.
  (This is your own vault protocol, written months ago: "Donna is the primary author, Dennis is the
  editor, he should rarely have to type into a markdown file.")

  CORRECTION IS THE POINT, TWICE OVER. It's the verification surface — you cannot check a synthesized
  paragraph against 186 sources, but you can skim a claim with a date on it and fix it in four
  seconds. And it's the reward signal: every fix is training data that only exists because something
  was written down wrong first.

  RECEIPTS OR IT DIDN'T HAPPEN. Every claim carries the dates it came from. A living document without
  receipts is just an LLM talking about you.

Writes into the Obsidian vault you already live in, because the cheapest interface is one you already
have. Wiki-links are real links there, so threads connect on their own over time.

  python3 weave.py            # write/refresh the threads
  python3 weave.py --dry      # print, write nothing
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MODEL = "claude-sonnet-4-6"
FALLBACK = "claude-haiku-4-5"   # a 429 must degrade the prose, never lose the document
VAULT = Path("/Users/main/Projects/Secretary/Secretary-Production/.claude/memory/threads")
MAX_THREADS = 6
MIN_ENTRIES_PER_THREAD = 3

THREADS_SYS = """You are reading everything one person has sent their capture tool, dated, oldest first.

Find the LIVE THREADS: the questions they keep circling. Not topics — questions. "AI" is a topic;
"what is the correct interface for AI" is a thread. A thread is live if they returned to it more than
once and it is not resolved.

Return ONLY JSON: {"threads": [{"title": "<5-9 words, phrased as the question they're actually
asking>", "slug": "<kebab-case>", "entry_dates": ["Jul 03", ...]}]}

Rules:
- At most 6. Fewer is better. A thread with one entry is not a thread.
- Do not invent coherence. If the corpus is scattered, return the few that are real and stop.
- Order by how alive it is: most recently returned-to first."""

DOC_SYS = """You are writing a living document for ONE thread of someone's thinking, from the things
they actually sent their capture tool. They will read it and correct it. That is the entire contract.

Write in markdown. This exact shape, no headers beyond these:

**Where it stands** — 3-5 sentences. What they currently seem to think, in their own vocabulary. Not
a summary of what they saved: a statement of the position they've arrived at. Cite dates inline (Jul 03).

**What they've actually said** — 3-6 bullets. Each is a real thing they sent, dated, compressed to one
line, in chronological order so the development is visible. This is the receipts section; every claim
above must be traceable to something here.

**Unresolved** — 2-3 bullets. The specific questions this thread has not answered yet. Not generic
next steps. The actual open loops, phrased as questions.

**Where it might be wrong** — 1-2 bullets. The strongest case against the position in "Where it
stands", built from tensions in their own material where possible. If two things they saved
contradict, say so and name both dates.

Never flatter. Never psychoanalyze. Never write a sentence you cannot trace to a dated entry. If you
are unsure whether they believe something, write that you are unsure rather than asserting it."""


def _entries(tenant: str = "dennis"):
    p = os.path.expanduser(f"~/.co/journal/{tenant}.json")
    with open(p) as f:
        return (json.load(f) or {}).get("entries", []) or []


def _dated(entries, full: bool = True, cap: int = 0):
    out = []
    for e in entries:
        body = ((e.get("text") or "") + (" " + e["link"] if e.get("link") else "")).replace("\n", " ").strip()
        if not body:
            continue
        when = e.get("date") or ""
        try:
            pretty = time.strftime("%b %d", time.strptime(when, "%Y-%m-%d"))
        except Exception:
            pretty = when
        out.append(f"({pretty}) {body if full else body[:cap]}")
    return "\n".join(out)


async def _ask(system: str, user: str, max_tokens: int = 2000):
    import asyncio as _a
    from anthro import make_client
    client = make_client()
    for model, wait in ((MODEL, 0), (MODEL, 5), (FALLBACK, 0), (FALLBACK, 10)):
        if wait:
            await _a.sleep(wait)
        try:
            r = await client.messages.create(model=model, system=system, max_tokens=max_tokens,
                                             messages=[{"role": "user", "content": user}])
            return "".join(b.text for b in r.content if b.type == "text")
        except Exception as e:
            if not any(k in str(e) for k in ("429", "rate_limit", "overloaded", "529")):
                raise
    raise RuntimeError("model unavailable after retries")


def weave(tenant: str = "dennis", dry: bool = False):
    import asyncio
    entries = _entries(tenant)
    index = _dated(entries, full=False, cap=160)

    raw = asyncio.run(_ask(THREADS_SYS, f"EVERYTHING THEY HAVE SENT:\n\n{index}", 1200))
    m = re.search(r"\{.*\}", raw, re.S)
    threads = (json.loads(m.group(0)).get("threads") if m else []) or []
    threads = [t for t in threads if len(t.get("entry_dates") or []) >= MIN_ENTRIES_PER_THREAD][:MAX_THREADS]
    if not threads:
        print("no live threads — the corpus is too scattered to weave honestly")
        return []

    full = _dated(entries, full=True)
    written = []
    for t in threads:
        body = asyncio.run(_ask(
            DOC_SYS,
            f"THREAD: {t['title']}\n\nEVERYTHING THEY HAVE SENT (the thread's entries are in here, "
            f"along with everything else — use only what belongs to this thread):\n\n{full}", 2000))
        today = time.strftime("%Y-%m-%d")
        doc = (f"---\nthread: {t['title']}\nwoven: {today}\nsource: co, from {len(entries)} captured entries\n"
               f"---\n\n# {t['title']}\n\n"
               f"> co wrote this from what you sent it. Correct anything wrong — the corrections are the point,\n"
               f"> and they're worth more than the document.\n\n{body.strip()}\n")
        path = VAULT / f"{t['slug']}.md"
        if dry:
            print(f"\n{'='*70}\n{path}\n{'='*70}\n{doc}")
        else:
            VAULT.mkdir(parents=True, exist_ok=True)
            path.write_text(doc)
            print(f"  wrote {path.name}  ({len(doc)} chars, {len(t.get('entry_dates') or [])} entries)")
        written.append(path)
    return written


if __name__ == "__main__":
    weave(dry="--dry" in sys.argv)
