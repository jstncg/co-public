#!/usr/bin/env python3
"""Bits — the running jokes, mined nightly, carried every turn (8/24).

Inside jokes are the compounding interest of the witty property; without a store, every
joke dies at the end of its turn. Mined from the member's thread into
~/.co/bits/<tenant>.json; the engine injects them as RUNNING BITS with the one law that
keeps them alive: use sparingly, never explain, retire what stops landing.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT_DIR = os.path.expanduser("~/.co/bits")
ARCHIVE = os.path.expanduser("~/.co/co_dualwrite_archive.jsonl")
MAX_BITS = 8

SYS = """From this texting thread between co and one person, extract the RUNNING BITS: recurring
jokes, nicknames, playful callbacks, shared shorthand — things that came up more than once and
landed (got engagement, got reused). NOT one-off jokes, NOT facts, NOT sensitive material. For
each: a short handle and the context a future writer needs to deploy it correctly. At most 8;
zero is honest if the thread has none yet. Reply ONLY JSON:
{"bits": [{"handle": "...", "context": "..."}]}"""


def _tenant_of(phone: str) -> str:
    norm = "".join(c for c in (phone or "") if c.isdigit())
    founder = "".join(c for c in os.environ.get("CO_FOUNDER_HANDLE", "") if c.isdigit())
    return os.environ.get("CO_FOUNDER_TENANT", "dennis") if (founder and norm == founder) else f"p{norm}"


def mine(tenant: str) -> int:
    import llm
    try:
        rows = [json.loads(ln) for ln in open(ARCHIVE) if ln.strip()]
    except OSError:
        return 0
    turns = [r for r in rows if _tenant_of(r.get("tenant_phone", "")) == tenant]
    if len(turns) < 40:
        return 0                                   # a thread too young for bits stays bitless
    convo = "\n".join(
        f"{'them' if r.get('direction') == 'inbound' else 'co'}: {(r.get('text') or '')[:160]}"
        for r in turns[-160:] if (r.get("text") or "").strip())
    got = llm.ask_json(llm.json_specs(), SYS, convo[-24000:], max_tokens=500) or {}
    bits = [{"handle": str(b.get("handle") or "")[:60], "context": str(b.get("context") or "")[:160]}
            for b in (got.get("bits") or []) if b.get("handle") and b.get("context")][:MAX_BITS]
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump({"bits": bits, "mined": dt.date.today().isoformat()},
              open(os.path.join(OUT_DIR, f"{tenant}.json"), "w"), ensure_ascii=False)
    return len(bits)


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    print(f"{t}: {mine(t)} bits")
