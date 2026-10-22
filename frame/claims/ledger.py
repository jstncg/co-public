#!/usr/bin/env python3
"""The silent ledger (PROGRAM.md capability 3) — the asset that makes month six worth more than month one.

journal_ingest extracts what the USER disclosed. This extracts what the WITNESS CLAIMED — every explicit read
or prediction the agent made about the user — and logs it as a falsifiable prediction with a behavioral
resolution criterion. Reality (predict.auto_resolve, behavior-graded, never the user's say-so) settles them
later. The accruing record of "what it predicted, and which reads proved true" is the moat the dead
competitors never built, and the un-fakeable proof for the honest arm.

No user-facing surface (v1). It runs at session end alongside journal_ingest, on the same per-tenant store.

  doppler run -- /…/python3 ledger.py            # extract the witness's reads from the transcript → predictions
Idempotent (watermark on transcript length, per source). Resolution is predict.auto_resolve's job, not this.
"""
import asyncio
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claimstore  # noqa: E402  (predict.db() connects through it → honors CO_CLAIMS_DB)
import predict     # noqa: E402  (the predictions store + behavior-graded auto_resolve)
from anthro import make_client  # noqa: E402

# Per-tenant (CO_CLAIMS_DB keys the whole user) — a stranger's ledger reads ONLY that stranger's transcript,
# never the founder's shared ones (the cross-tenant leak this exists to prevent). Founder/default = the list.
_TENANT = os.getenv("CO_CLAIMS_DB")
if _TENANT:
    TRANSCRIPTS = [Path(f"{_TENANT}.transcript.json")]
    STATE = Path(f"{_TENANT}.ledger.json")
else:
    TRANSCRIPTS = [
        Path.home() / ".co_pi_transcript.json",
        Path.home() / ".co_imessage_transcript.json",
    ]
    STATE = Path.home() / ".co_ledger_state.json"
MODEL = "claude-sonnet-4-6"

SYS = """You are given the WITNESS's side of a conversation (an AI that knows a person and tells them the truth).
Extract every EXPLICIT READ or PREDICTION it made about the user — the specific claims it asserted about who
they are, what they're doing, or what they'll do. These become a falsifiable track record graded later against
the user's actual behavior.

For each read the witness actually made (not the user's words, not generic chitchat, not questions):
- statement: the read, as a falsifiable claim about the user ("avoids X", "will keep taking contract work", "is
  running on fear of admitting failure"). Only reads the witness ASSERTED, not things it asked.
- criterion: the BEHAVIORAL observation that would later confirm or refute it — what the user would have to DO
  or reveal-having-done (never "the user agrees"; resolution is behavior, not say-so).
- horizon_days: when behavior could settle it (7-60).
- confidence: how strongly the witness asserted it (0-1; tentative/hedged reads are low).
- basis: what in the conversation the read was grounded in.

If the witness only asked questions and asserted nothing, return an empty list — do NOT manufacture reads.
Return ONLY JSON: {"reads":[{"statement","criterion","horizon_days","confidence","basis"}]}"""


def _assistant_turns(messages):
    """The WITNESS's turns (role=assistant). content is a string or a list of {type:text,text} blocks."""
    out = []
    for m in messages:
        if not (isinstance(m, dict) and m.get("role") == "assistant"):
            continue
        c = m.get("content")
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
        else:
            text = ""
        if text.strip():
            out.append(text.strip())
    return out


def _collect_new(state: dict):
    sources = dict(state.get("sources", {}))
    turns = []
    for path in TRANSCRIPTS:
        if not path.exists():
            continue
        try:
            msgs = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        seen = sources.get(str(path), 0)
        turns.extend(_assistant_turns(msgs[seen:]))
        sources[str(path)] = len(msgs)
    return turns, {"sources": sources}


async def main():
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    turns, new_state = _collect_new(state)
    if not turns:
        print("ledger: no new witness turns to log"); return
    text = "\n---\n".join(turns)
    client = make_client()
    try:
        r = await client.messages.create(model=MODEL, system=SYS, max_tokens=1500,
                                         messages=[{"role": "user", "content": "THE WITNESS'S TURNS:\n" + text}])
        txt = "".join(b.text for b in r.content if b.type == "text")
        m = re.search(r"\{.*\}", txt, re.S)
        reads = json.loads(m.group(0)).get("reads", []) if m else []
    except Exception as e:
        print(f"ledger extract failed: {e}"); return
    conn = predict.db()
    today = date.today().isoformat()
    n = 0
    for rd in reads:
        stmt = (rd.get("statement") or "").strip()
        if not stmt:
            continue
        h = int(rd.get("horizon_days", 21) or 21)
        try:
            conn.execute(
                "INSERT OR IGNORE INTO predictions(statement,confidence,criterion,basis,horizon_days,created,resolve_by,status) "
                "VALUES(?,?,?,?,?,?,?,'open')",
                (stmt, float(rd.get("confidence", 0.5)), rd.get("criterion", ""), rd.get("basis", ""),
                 h, today, (date.today() + timedelta(days=h)).isoformat()))
            n += 1
        except Exception:
            pass
    conn.commit()
    STATE.write_text(json.dumps(new_state))
    print(f"ledger: logged {n} witness reads as falsifiable predictions (behavior will grade them, never the user)")


if __name__ == "__main__":
    asyncio.run(main())
