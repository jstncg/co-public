#!/usr/bin/env python3
"""Outbound call — co dials you (8/3: "I also need phone calls").

The voice rail's brain IS the text rail's brain: the VAPI assistant "co" runs custom-llm
against the funnel proxy (/vapi/<token>/chat/completions → engine :8090), so a call and a
text are the same mind with the same memory, laws, and voice. This module just gets the
line up. Used by the router's "call me" command; later by the wake/debrief loops.

    python3 call_out.py                # calls the founder
    python3 call_out.py +15551234567   # calls a number
"""
from __future__ import annotations

import json
import os
import sys


def place(to: str, first: str | None = None) -> dict:
    """Dial. `first` overrides the opening line — a placed call should announce its reason
    ('hey, it's co — about the thing from yesterday'), not open with a naked 'hey'."""
    import requests
    key = os.environ.get("VAPI_API_KEY", "")
    aid = os.environ.get("CO_VAPI_ASSISTANT_ID", "")
    pid = os.environ.get("CO_VAPI_PHONE_ID", "")
    if not (key and aid and pid):
        return {"ok": False, "why": "VAPI env missing (VAPI_API_KEY / CO_VAPI_ASSISTANT_ID / CO_VAPI_PHONE_ID)"}
    payload = {"assistantId": aid, "phoneNumberId": pid, "customer": {"number": to}}
    if first:
        payload["assistantOverrides"] = {"firstMessage": first[:280]}
    try:
        r = requests.post("https://api.vapi.ai/call", timeout=20,
                          headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                          json=payload)
        d = r.json() if r.content else {}
        return {"ok": r.status_code < 300, "id": d.get("id"), "status": d.get("status"),
                "why": None if r.status_code < 300 else str(d)[:300]}
    except Exception as e:
        return {"ok": False, "why": str(e)[:200]}


if __name__ == "__main__":
    to = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_HANDLE", "")
    print(json.dumps(place(to) if to else {"ok": False, "why": "no number (arg or CO_FOUNDER_HANDLE)"}))
