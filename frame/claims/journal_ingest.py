#!/usr/bin/env python3
"""Journal ingest — the conversation IS the journal (the flywheel that makes it a journal, not a chat).

After a thought-partner session, take the USER's own turns (self-disclosure = the richest signal there is —
authored, no receiving≠doing) and extract calibrated claims into the belief graph. So every conversation
deepens the model, which makes the next conversation know them better. This is the loop the whole project
concluded is the highest-value source (elicitation), productized.

  doppler run -- /…/python3 journal_ingest.py            # ingest new user turns since last run
Called automatically at session end by the agent. Idempotent (watermark on transcript length).
"""
import asyncio
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore
from anthro import make_client

# Per-tenant (CO_CLAIMS_DB keys the whole user): a stranger's flywheel reads ONLY that stranger's
# transcript, never the founder's. Founder/default = the shared surfaces. Each file has ONE writer, so
# per-source watermarks stay race-free.
_TENANT = os.getenv("CO_CLAIMS_DB")
if _TENANT:
    TRANSCRIPTS = [Path(f"{_TENANT}.transcript.json")]
    STATE = Path(f"{_TENANT}.journal.json")
else:
    TRANSCRIPTS = [
        Path.home() / ".co_pi_transcript.json",          # the pi thought-partner agent
        Path.home() / ".co_imessage_transcript.json",    # the iMessage bridge (witness in pocket)
    ]
    STATE = Path.home() / ".co_journal_ingest.json"
MODEL = "claude-haiku-4-5"

SYS = """Extract AUDITABLE CLAIMS about the USER from THEIR OWN words in a conversation with their thought
partner. This is self-disclosure — authored by them, so high-signal — but stay calibrated:
- Extract ONLY what the USER said about themselves / their life / goals / feelings / relationships / habits.
  Ignore the assistant's words and generic chit-chat.
- type: value | identity | preference | relationship | routine | goal | frame | other
- level: fact (stated directly) | pattern (a recurring thing about them) | frame (interpretive — DANGEROUS)
- Self-stated facts/values = confidence 0.8-0.9. frame-level = ≤0.5, phrase tentatively, only on real basis.
- NEVER infer demographics. If they were just musing/asking, not disclosing, skip it.
Return ONLY JSON: {"claims":[{"type","level","statement","confidence"}]}"""


def _user_turns(messages):
    """User turns only. pi stores content as a list of blocks ({type:'text',text:...}) or a string."""
    out = []
    for m in messages:
        if not (isinstance(m, dict) and m.get("role") == "user"):
            continue
        c = m.get("content")
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
        else:
            text = ""
        text = text.strip()
        if text and not text.startswith("[relevant to what they just said]"):
            out.append(text)
    return out


def _collect_new_turns(state: dict):
    """Across all transcript sources, gather user turns past each source's watermark. Returns
    (turns, new_state). Backward-compatible with the old {"n": int} (pi transcript) state shape."""
    sources = dict(state.get("sources", {}))
    if "n" in state and str(TRANSCRIPTS[0]) not in sources:   # migrate legacy single-watermark state
        sources[str(TRANSCRIPTS[0])] = state["n"]
    turns = []
    for path in TRANSCRIPTS:
        if not path.exists():
            continue
        try:
            msgs = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        seen = sources.get(str(path), 0)
        turns.extend(_user_turns(msgs[seen:]))
        sources[str(path)] = len(msgs)
    return turns, {"sources": sources}


async def main():
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    turns, new_state = _collect_new_turns(state)
    if not turns:
        print("journal: nothing new to ingest"); return
    text = "\n".join(f"- {t}" for t in turns)
    client = make_client()
    try:
        r = await client.messages.create(model=MODEL, system=SYS, max_tokens=1500,
                                         messages=[{"role": "user", "content": "USER'S OWN WORDS THIS SESSION:\n" + text}])
        txt = "".join(b.text for b in r.content if b.type == "text")
        m = re.search(r"\{.*\}", txt, re.S)
        claims = json.loads(m.group(0)).get("claims", []) if m else []
    except Exception as e:
        print(f"journal ingest LLM failed: {e}"); return
    conn = claimstore.connect()
    when = date.today().isoformat()
    n = 0
    for c in claims:
        stmt = (c.get("statement") or "").strip()
        if not stmt:
            continue
        claimstore.upsert(conn, type=c.get("type", "other"), level=c.get("level", "fact"),
                          statement=stmt, confidence=float(c.get("confidence", 0.7)),
                          evidence=[{"source": "journal", "date": when, "note": "said it in conversation"}], when=when)
        n += 1
    STATE.write_text(json.dumps(new_state))
    # embed the new claims so the NEXT conversation can recall them (close the flywheel)
    try:
        import subprocess
        subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "embed.py")],
                       capture_output=True, timeout=120)
    except Exception:
        pass
    print(f"journal: deepened the model with {n} claims from this session (the conversation became the journal)")


if __name__ == "__main__":
    asyncio.run(main())
