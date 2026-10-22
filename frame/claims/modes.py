#!/usr/bin/env python3
"""Tenant modes — the register dial (8/4). Three settings, all three now occupied by real people.

    thread    (default)  full conversation laws — the founder's door.
    capture   receipts only, no conversation push — Justin's door (call-002: "you don't
              want to text into the void"; input never demands conversation).
    delivery  bare drops, ZERO questions, zero reply-expectation — the delivery member's door
              (user-research-005: "I am sure I'd use except the text" → "can you help
              set me up sometime"). Texts are social debts he clears fast; co must never
              become another creditor. Deliveries still flow — that IS the product for
              him — but nothing co sends may ask, probe, or expect.

The dial changes REGISTER, never memory: all modes share the same journal, graph, eyes,
wake, finds. It's one mind with different door manners (the doors thesis, call-002/003).

Store: ~/.co/tenants.json  {"<tenant>": {"mode": "delivery", "note": "..."}}
Absent tenant or file → "thread". Never raises.

    python3 modes.py lance delivery     # set
    python3 modes.py lance              # get
"""
from __future__ import annotations

import json
import os

PATH = os.path.expanduser("~/.co/tenants.json")
MODES = ("thread", "capture", "delivery")


def get(tenant: str) -> str:
    try:
        m = (json.load(open(PATH)).get(tenant) or {}).get("mode")
        return m if m in MODES else "thread"
    except Exception:
        return "thread"


def set_mode(tenant: str, mode: str, note: str = "") -> bool:
    if mode not in MODES:
        return False
    try:
        d = {}
        if os.path.exists(PATH):
            try:
                d = json.load(open(PATH))
            except (OSError, json.JSONDecodeError):
                d = {}
        d.setdefault(tenant, {})["mode"] = mode
        if note:
            d[tenant]["note"] = note
        tmp = PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        os.replace(tmp, PATH)
        return True
    except Exception:
        return False


def directive(tenant: str) -> str:
    """The engine-facing law for this tenant's mode. '' for thread (no extra law needed)."""
    m = get(tenant)
    if m == "delivery":
        return ("DELIVERY-ONLY TENANT: this person wants what you bring, never a conversation. "
                "NEVER ask them a question. NEVER end with anything that expects a reply. No "
                "'thoughts?', no 'want more?', no 'lmk'. Drops are bare and warm: the line, the "
                "link, done. If they text you first, answer plainly and stop — still no questions. "
                "Silence is always legal.")
    if m == "capture":
        return ("CAPTURE-ONLY TENANT: this person uses you as a place to put things, not someone "
                "to talk to. Receipts stay minimal (a light touch or nothing). Never push a "
                "conversation, never ask follow-ups on a capture. Answer direct questions "
                "normally, then stop.")
    return ""


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 3:
        ok = set_mode(sys.argv[1], sys.argv[2], " ".join(sys.argv[3:]))
        print(f"{sys.argv[1]} → {sys.argv[2]}" if ok else f"bad mode (choose from {MODES})")
    elif len(sys.argv) == 2:
        print(get(sys.argv[1]))
    else:
        try:
            print(json.dumps(json.load(open(PATH)), indent=1))
        except Exception:
            print("{} (no tenants.json yet — everyone defaults to thread)")
