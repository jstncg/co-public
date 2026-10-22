#!/usr/bin/env python3
"""The promise tick — fires reminders the member explicitly asked for, and nothing else.

Wired: LIVE cron (*/5). Created 2026-09-06 after a live broken promise.

WHY THIS EXISTS AND WHY IT IS NARROW.

At the 9/6 cutover the runtime took over the founder's conversation and `proactive_tick` was
removed from cron, correctly: its own record was 13 unprompted sends in 45 days scoring -2.65 on
landed.py's objective, one lane speaking, zero acts. Nobody wanted those back.

But `proactive_tick` was also the only thing that fired due anchors. The router still EXTRACTS
them on every inbound (sendblue_router:926), so at 10:27 that morning "Remind me to send Richard an
invoice for Coretsu by EOD today" was recorded correctly, due 18:00, and co replied "Got it,
reminder set for today, 6pm." Nothing on the machine would ever fire it. The promise was made,
recorded, and orphaned — and `A promise made and not recorded is the worst failure the product has`
is already written in this tree; a promise recorded and never fired is the same failure with better
bookkeeping.

So this fires promises and refuses everything else. It is not a lane. It has no composer, no
research surfacing, no market alerts, no RETURN, no budget to spend on being interesting. A
requested reminder is the one proactive class that can never be a nag, because they asked for it in
their own words.

TWO LAWS CARRIED FORWARD FROM THE ORGAN IT REPLACES.

A requested reminder needs no model. They already said what they wanted, so it is rendered
deterministically from their own words. On 8/6 a tester's reminder disappeared because an empty
model return marked the anchor fired with nothing sent, and `fired` is terminal, so it could never
retry or repair.

The anchor is marked fired only on proof of a send. rail.send returns (ok, evidence); a refusal
leaves the anchor due so the next tick tries again. Held is held, but held is not kept.

    python3 promise_tick.py            # dry run: prints what is due
    python3 promise_tick.py --send     # fires them
"""
from __future__ import annotations

import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _tenants() -> list[str]:
    """Every tenant holding a claims database. A promise belongs to the member who made it."""
    here = os.path.dirname(os.path.abspath(__file__))
    out = []
    for name in sorted(os.listdir(here)):
        if not name.startswith("claims") or not name.endswith(".db"):
            continue
        stem = name[:-3]
        out.append(os.environ.get("CO_FOUNDER_TENANT", "dennis") if stem == "claims"
                   else stem.removeprefix("claims_"))
    return out


def _claims_db(tenant: str) -> str:
    import journal
    return journal._claims_db(tenant)


def _render(anchor: dict) -> str:
    """Their words, framed as the reminder they asked for. No model.

    The anchor stores the ask as a bare verb phrase — "send Richard invoice for Coretsu" — because
    that is what the extractor pulls out of "remind me to X". Sent raw it lands as an imperative
    fragment from co, which reads like co giving an order rather than keeping a promise. One word of
    framing turns it back into what it is. Deterministic on purpose: a requested reminder is the one
    proactive class that needs no composer, and a model here could only make it wrong.
    """
    what = (anchor.get("what") or "").strip()
    if not what:
        # Fall back to their own sentence, which already reads as a sentence.
        return (anchor.get("quote") or "").strip()
    what = what.rstrip(".")
    lowered = what.lower()
    # Already framed by the extractor, or already a sentence about them — leave it alone.
    if lowered.startswith(("reminder", "remember", "don't forget", "dont forget", "you ")):
        return what
    return f"reminder: {what}"


def run(send: bool = False, now: dt.datetime | None = None) -> int:
    import anchors
    import daily_text

    fired = 0
    for tenant in _tenants():
        db = _claims_db(tenant)
        try:
            due = anchors.due(db, now)
        except Exception as exc:                       # a broken sidecar must not stop the others
            print(f"  [skip] {tenant}: {exc}", file=sys.stderr)
            continue
        for anchor in due:
            # ONLY what they asked for. Everything else this tick sees, it leaves alone: an
            # inferred callback is the lane that was retired, and reviving it here by accident is
            # exactly how a narrow organ becomes the thing it replaced.
            if not anchor.get("requested"):
                continue
            text = _render(anchor)
            if not text:
                continue
            from pathlib import Path
            phone = daily_text.tenant_phone(tenant, daily_text._cfg(Path(db)))
            if not phone:
                print(f"  [hold] {tenant}: no phone — {text[:60]!r}", file=sys.stderr)
                continue
            if not send:
                print(f"  [due]  {tenant} {anchor.get('when','')[:16]} — {text[:70]!r}")
                fired += 1
                continue
            import rail
            # gated=False: they asked for this in their own words, so it is not subject to the
            # dedup and shape holds that exist to ration unrequested prose. The belt and the
            # receipt gate still apply inside rail.send.
            ok, evidence = rail.send(phone, text, gated=False)
            if ok:
                anchors.mark_fired(db, anchor)
                fired += 1
                print(f"  [sent] {tenant} — {text[:70]!r} ({evidence})")
            else:
                # Left due on purpose. The next tick retries; a promise is not voided by a refusal.
                print(f"  [FAILED] {tenant} — {text[:60]!r}: {evidence}", file=sys.stderr)
    return fired


def main() -> int:
    send = "--send" in sys.argv
    n = run(send=send)
    stamp = dt.datetime.now().isoformat(timespec="seconds")
    print(f"promise tick {'SEND' if send else 'DRY'} — {stamp} — {n} promise(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
