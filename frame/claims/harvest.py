#!/usr/bin/env python3
"""Session harvest — a call becomes WORK, not just a memory.

The gap this closes (Justin, 2026-08-12 call): "I want to call co, talk about anything, and from
then co pulls things from that conversation and just starts working on it." Every organ needed for
that already existed — anchors (timed things), watch_engine (standing promises about the world),
research_engine (commissions) — and all three were wired into ONE door: sendblue_router.py, the
iMessage rail. A voice call ran journal_ingest and ledger at teardown and nothing else, so talking
deepened the model but never started any work.

This is the same three verbs, hung off the transcript instead of off an inbound text. The router
still owns the reply path — nothing here speaks. It only creates rows.

  the classifier is find_engine.recall's gate, unchanged: it already returns
  watch | commission | make_real | connects | none, and the action verbs need no corpus.

  anchors run on their own cheap regex first (anchors.REQUEST_RE), the way the router gates them,
  so a call full of ordinary talk costs zero model calls on that lane.

  the scout runs LAST, once. It reads ~/.co/journal/<tenant>.json, which journal_ingest has just
  filled with this call's turns — so the implicit half ("he keeps circling techno") gets picked up
  without anybody having to say "watch this".

Idempotent: watermark on transcript length, same convention as journal_ingest, so running twice
harvests once. Never raises to the caller — a failed harvest must not break call teardown.

  doppler run -- CO_CLAIMS_DB=/…/claims_x.db python3 harvest.py          # harvest new turns
  doppler run -- CO_CLAIMS_DB=/…/claims_x.db python3 harvest.py --dry    # classify, create nothing
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

_TENANT_DB = os.getenv("CO_CLAIMS_DB")

# Bound the cost of one call. A ten-minute session is ~40 user turns; the gate is a small model
# call per turn, so the cap is what keeps a rambling call from being the expensive one. Newest
# turns win — if a call overruns the cap, the asks made at the end are the ones still live.
MAX_TURNS = 40
# Under this length a turn is an utterance, not an ask ("yeah", "no totally", "hm"). Gating on it
# is free and removes most of the corpus before any model sees it.
MIN_ASK = 12


def _paths(tenant: str | None):
    """(transcript, watermark) for this tenant. CO_CLAIMS_DB is the cross-language tenant handle and
    takes precedence, exactly as claimstore and journal_ingest resolve it."""
    db = _TENANT_DB
    if not db:
        here = os.path.dirname(os.path.abspath(__file__))
        db = os.path.join(here, "claims.db" if (tenant or "dennis") == "dennis"
                          else f"claims_{tenant}.db")
    return Path(f"{db}.transcript.json"), Path(f"{db}.harvest.json"), db


def _tenant_of(db: str) -> str:
    """The tenant slug the sibling organs key on. `claims_x.db` -> `x`; plain `claims.db` -> the
    founder. Derived from the db path rather than passed in, so a caller that only has the env
    handle (which is every caller) cannot pass a slug that disagrees with the file it writes."""
    stem = Path(db).stem
    return stem[len("claims_"):] if stem.startswith("claims_") else "dennis"


def _user_turns(messages: list) -> list:
    """The USER's turns only. LiveKit and pi both store content as a string or a list of blocks."""
    out = []
    for m in messages:
        if not (isinstance(m, dict) and m.get("role") == "user"):
            continue
        c = m.get("content")
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = " ".join(b.get("text", "") for b in c
                            if isinstance(b, dict) and b.get("type") == "text")
        else:
            text = ""
        text = text.strip()
        if len(text) >= MIN_ASK:
            out.append(text)
    return out


def harvest(tenant: str | None = None, dry: bool = False) -> dict:
    """Turn everything said since the last harvest into rows. Returns a receipt dict; never raises."""
    made = {"anchors": 0, "watches": [], "commissions": [], "scouted": [], "turns": 0}
    try:
        transcript, state_path, db = _paths(tenant)
        if not transcript.exists():
            return made
        try:
            msgs = json.loads(transcript.read_text())
        except (json.JSONDecodeError, OSError):
            return made
        try:
            seen = json.loads(state_path.read_text()).get("n", 0)
        except (json.JSONDecodeError, OSError):
            seen = 0
        if len(msgs) <= seen:
            return made

        turns = _user_turns(msgs[seen:])[-MAX_TURNS:]
        made["turns"] = len(turns)
        slug = _tenant_of(db)

        for text in turns:
            # A turn that is a timed reminder belongs to anchors, and to anchors ONLY. Running both
            # lanes blind on the same sentence made "I have a pitch thursday at 2pm, remind me the
            # morning of" into an anchor AND a kind=date watch (probe, 8/13), which is two pings for
            # one promise. Anchors own the clock; a watch is about the WORLD changing.
            timed = _anchor(db, text, made, dry)
            _act(slug, text, made, dry, skip_watch=timed)

        # The implicit half, once per harvest rather than once per turn. The scout is capped at
        # SCOUT_MAX active offers by watch_engine itself, so calling it often is cheap and safe.
        if not dry:
            try:
                import watch_engine
                made["scouted"] = [w.get("what") for w in (watch_engine.scout(slug) or [])]
            except Exception as e:
                print(f"harvest: scout skipped ({e})")

        if not dry:
            # Watermark AFTER the work, not before: a crash mid-harvest must re-run the turns it
            # never got to, and every verb below is create-if-absent on the organ's own side.
            state_path.write_text(json.dumps({"n": len(msgs)}))
        return made
    except Exception as e:                     # teardown must survive anything this does
        print(f"harvest failed (non-fatal): {e}")
        return made


def _anchor(db: str, text: str, made: dict, dry: bool) -> bool:
    """Timed things in their life -> callback anchors. Gated on the cheap regex first, the way
    sendblue_router gates it, so ordinary conversation never reaches the model on this lane.

    Returns whether this turn is a TIMED one, which is what suppresses the watch verb for it. The
    regex match is the signal, not the extraction count: a turn that asks for a reminder is a timed
    turn even when the extractor declines to place it, and letting a failed extraction fall through
    to the watch lane would resurrect the double-ping by the back door."""
    try:
        import anchors
        if not anchors.REQUEST_RE.search(text):
            return False
        if dry:
            made["anchors"] += 1
            return True
        made["anchors"] += anchors.extract(db, text) or 0
        return True
    except Exception as e:
        print(f"harvest: anchor extract skipped ({e})")
        return False


def _act(slug: str, text: str, made: dict, dry: bool, skip_watch: bool = False) -> None:
    """The three action verbs, off find_engine's own gate. `make_real` and `connects` are
    deliberately NOT handled here: an episode is a proposal that needs the member's yes on the
    reply path, and this module has no reply path. Creating one silently would put a decision in
    front of them that nobody asked out loud."""
    try:
        import find_engine
        try:
            res = find_engine.recall(slug, text)
        except find_engine.RecallUnavailable:
            return
        kind = (res or {}).get("kind")
        if kind == "watch":
            # The anchor lane already claimed this sentence. A commission is still allowed through
            # below: "remind me friday, and look into X" is two real asks, and only the reminder
            # half is the one anchors owns.
            if skip_watch:
                return
            if dry:
                made["watches"].append(res.get("topic") or text[:60])
                return
            import watch_engine
            w = watch_engine.create(slug, text)
            if w and w.get("what"):
                made["watches"].append(w["what"])
        elif kind == "commission":
            if dry:
                made["commissions"].append(res.get("topic") or text[:60])
                return
            import research_engine
            c = research_engine.commission(slug, text)
            if c and c.get("topic"):
                made["commissions"].append(c["topic"])
    except Exception as e:
        print(f"harvest: action verb skipped ({e})")


def main() -> None:
    dry = "--dry" in sys.argv
    tenant = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
    r = harvest(tenant, dry=dry)
    print(json.dumps(r, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
