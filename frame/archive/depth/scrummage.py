#!/usr/bin/env python3
"""SCRUMMAGE — a detective that rummages your email and DYNAMICALLY chases threads.

Not a fixed extractor (one hand-coded question) — an agent with a single email-search tool and a curiosity
directive. It searches freely, notices a thread (an accessory, a recurring sender, a receipt, a rec), forms
a hypothesis, and CHASES it: a watch band → confirm the smartwatch → note "pull health data"; iCloud →
iPhone → find the case → the exact model; Best Buy/Amazon receipts → what they bought. Follows each thread
till it resolves, then the next — hunting the specific, surprising, true things that make you go "how did
you know that?"

This is the agentic v0 that the representational/JEPA model (Substrate) eventually subsumes. But the loop
itself is the dynamic-curiosity unlock.

  doppler run -- /…/substrate/.venv/bin/python3 scrummage.py
"""
import asyncio
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from donna_warm import make_client, MODEL, EMAIL, USER  # noqa: E402

VAULT = Path("/Users/main/Projects/Secretary/Secretary-Production/.claude/memory")
MAX_STEPS = 16


def search_email(query: str) -> str:
    """Gmail search over the archive (gog), trimmed to sender/subject/date the agent can scan."""
    try:
        out = subprocess.run(
            ["gog", "gmail", "search", query, f"--account={EMAIL}", "--json", "--no-input"],
            capture_output=True, text=True, timeout=30).stdout
        threads = (json.loads(out).get("threads") or [])[:20]
        if not threads:
            return f"(no results for: {query})"
        return "\n".join(f"- {t.get('date','')[:10]} | {t.get('from','?')[:35]} | {t.get('subject','')[:75]}"
                         for t in threads)
    except Exception as e:
        return f"(search error: {e})"


TOOLS = [{"name": "search_email",
          "description": "Search the email archive (Gmail query syntax: 'amazon order', 'from:apple', "
                         "'best buy receipt', 'apple watch', 'newer_than:1y', 'returned'). Returns sender/subject/date.",
          "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}]

SYSTEM = (
    f"You are a detective rummaging through {USER}'s email archive to understand them in ways they can't see "
    "about themselves. You have ONE tool: search_email(query).\n\n"
    "METHOD — chase threads dynamically:\n"
    "1. Start broad: orders, receipts, recurring senders, accessories, 'best buy', 'amazon order'.\n"
    "2. When you NOTICE something — an accessory, a recurring sender, a receipt, a recommendation — form a "
    "HYPOTHESIS and SEARCH to chase it. Accessories reveal DEVICES: a watch BAND → they own a smartwatch → "
    "search to confirm which, and note 'pull smartwatch/health data'. An iCloud email → iPhone user → find "
    "the CASE → the exact model. A charger/cable → the device it fits. Use unexpected signals (Amazon recs, "
    "marketplace, accessory/case types, Best Buy/retail receipts).\n"
    "3. Follow each thread until it resolves, THEN chase the next. Spend your searches; be relentless.\n"
    "4. Hunt the SPECIFIC, SURPRISING, TRUE things that make them go 'how did you know that?' — never generic.\n\n"
    "When you've chased enough threads, STOP searching and output a final report:\n"
    "DEVICES — each with the accessory/signal that revealed it + 'data to pull' where relevant (e.g. Apple "
    "Health, Oura).\n"
    "SPOOKS — 3-5 specific 'how did you know that' findings.\n"
    "NEXT THREADS — what you'd chase with more time.\n"
    "Name real things. NO demographic guessing (age/race/gender/etc.) — only what the evidence shows."
)


async def main():
    client = make_client()
    convo = [{"role": "user", "content": "Start rummaging. Chase the threads. Find what I can't see about myself."}]
    print(f"🔍 scrummaging {USER}'s email — chasing threads...\n")
    for step in range(MAX_STEPS):
        r = await client.messages.create(model=MODEL, system=SYSTEM, messages=convo, tools=TOOLS, max_tokens=1200)
        convo.append({"role": "assistant", "content": [b.model_dump() for b in r.content]})
        for b in r.content:
            if b.type == "text" and b.text.strip():
                print(b.text.strip() + "\n")
        if r.stop_reason == "tool_use":
            results = []
            for b in r.content:
                if b.type == "tool_use":
                    q = b.input.get("query", "")
                    print(f"  🔎 search: {q}")
                    results.append({"type": "tool_result", "tool_use_id": b.id, "content": search_email(q)})
            convo.append({"role": "user", "content": results})
            continue
        break  # model produced its final report (no more tool calls)

    report = "".join(b.text for b in r.content if b.type == "text").strip()
    (VAULT / "scrummage.md").write_text(f"# Email scrummage — dynamic findings\n\n{report}\n")
    print(f"\n📂 saved → {VAULT / 'scrummage.md'}")


if __name__ == "__main__":
    asyncio.run(main())
