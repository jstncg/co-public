#!/usr/bin/env python3
"""THE HARVEST CHECK — the call-becomes-work organ, exercised with every seam faked.

harvest.py is the only organ that runs at voice-call teardown, and it is the one place where
a bug is invisible: it never speaks, it swallows every exception by design, and its output is
rows in someone else's store. A broken harvest looks exactly like a quiet call.

So this file checks the four things that actually break, and nothing else:

  IDEMPOTENCE   the watermark is `{db}.harvest.json` keyed on transcript length. Run twice,
                harvest once. Proved by ORGAN CALL COUNT, not by the receipt — a receipt can
                be empty while the organs ran again.
  THE ORDER     the watermark is written AFTER the work. A crash mid-harvest must re-run the
                turns it never reached. Proved by blocking the write and asserting the work
                still happened.
  THE GATE      `_user_turns` takes user turns only, both content shapes, over MIN_ASK.
  ISOLATION     an organ that raises costs its own lane and nothing else. Teardown survives.

OFFLINE, ALWAYS. anthro.make_client and every model path must be unreachable from here, or
this becomes another test that only passes in a shell with a key. harvest imports its organs
LAZILY, inside the functions — which is exactly what lets four fakes in sys.modules stand in
for anchors / find_engine / watch_engine / research_engine before a single import fires. The
transcript and the watermark live in a real temp dir; ~/.co and the real claims dbs are never
opened, and CO_CLAIMS_DB is set before the import so `_paths` can never fall back to writing
into frame/claims/.

    ./evals/harvest_eval.py          # no key, no network, no doppler
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRAME = HERE.parent
sys.path.insert(0, str(FRAME / "claims"))

PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append((name, detail))
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  — {detail}" if detail and not ok else ""))


# ── the fake organs — registered BEFORE harvest is imported ────────────────────────────
CALLS: list[str] = []          # every organ call this process made, in order
BOOM: set[str] = set()         # organs that must raise on this phase
SEEN_SLUGS: list[str] = []     # the tenant slug each organ was handed


def _rec(organ: str):
    CALLS.append(organ)
    if organ in BOOM:
        raise RuntimeError(f"{organ} is down")


class RecallUnavailable(Exception):
    pass


def _extract(db, text):
    _rec("anchors.extract")
    return 1


# find_engine's gate, keyword-shaped. The real one is a model call; the only thing harvest
# depends on is the `kind` it returns, so that is all this stands in for.
def _recall(slug, text):
    _rec("find_engine.recall")
    SEEN_SLUGS.append(slug)
    if "keep an eye" in text:
        return {"kind": "watch", "topic": "gpu prices"}
    if "look into" in text:
        return {"kind": "commission", "topic": "voice agents"}
    if "should i" in text:
        return {"kind": "make_real", "topic": "a decision"}     # deliberately NOT harvested
    return {"kind": "none"}


def _create(slug, text):
    _rec("watch_engine.create")
    SEEN_SLUGS.append(slug)
    return {"what": "gpu prices"}


def _scout(slug):
    _rec("watch_engine.scout")
    SEEN_SLUGS.append(slug)
    return [{"what": "he keeps circling techno"}]


def _commission(slug, text):
    _rec("research_engine.commission")
    SEEN_SLUGS.append(slug)
    return {"topic": "open source voice agents"}


def _fake(name: str, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


_fake("anchors", REQUEST_RE=re.compile(r"remind|tomorrow|at \d"), extract=_extract)
_fake("find_engine", recall=_recall, RecallUnavailable=RecallUnavailable)
_fake("watch_engine", create=_create, scout=_scout)
_fake("research_engine", commission=_commission)

TMP = tempfile.mkdtemp(prefix="harvest_eval_")
os.environ["CO_CLAIMS_DB"] = os.path.join(TMP, "claims_missing.db")   # never frame/claims/

import harvest as H  # noqa: E402  — after the fakes and after CO_CLAIMS_DB


# ── the transcript ─────────────────────────────────────────────────────────────────────
CALL = [
    {"role": "user", "content": "remind me to call the clinic tomorrow at 9"},
    {"role": "assistant", "content": "sure, i will remind you about the clinic tomorrow"},
    {"role": "user", "content": [{"type": "text", "text": "keep an eye on gpu prices for me"},
                                 {"type": "image", "text": "NEVER-HARVESTED"}]},
    {"role": "user", "content": "yeah"},                       # under MIN_ASK — an utterance
    {"role": "user", "content": "look into open source voice agents this week"},
    {"role": "system", "content": "you are co. this system turn is not an ask."},
]
ASKS = ["remind me to call the clinic tomorrow at 9",
        "keep an eye on gpu prices for me",
        "look into open source voice agents this week"]


def seed(name: str, msgs: list) -> str:
    db = os.path.join(TMP, name)
    Path(f"{db}.transcript.json").write_text(json.dumps(msgs))
    H._TENANT_DB = db
    return db


def wm(db: str):
    p = Path(f"{db}.harvest.json")
    return json.loads(p.read_text()) if p.is_file() else None


def main() -> int:
    print(f"HARVEST CHECK — offline, temp dir {TMP}\n")

    # ── the gate ───────────────────────────────────────────────────────────────────────
    print("[1] _user_turns — the only filter between a call and a model call:")
    turns = H._user_turns(CALL)
    check("gate: user turns only, in order, both content shapes", turns == ASKS,
          json.dumps(turns))
    check("gate: an assistant turn is never an ask",
          not any("sure, i will remind" in t for t in turns))
    check("gate: a system turn is never an ask",
          not any(t.startswith("you are co") for t in turns))
    check("gate: block content joins text blocks only, never image/tool blocks",
          "NEVER-HARVESTED" not in " ".join(turns))
    check("gate: MIN_ASK is the floor, not a suggestion",
          H._user_turns([{"role": "user", "content": "a" * (H.MIN_ASK - 1)}]) == [] and
          H._user_turns([{"role": "user", "content": "a" * H.MIN_ASK}]) == ["a" * H.MIN_ASK])
    check("gate: junk content shapes degrade to nothing, never raise",
          H._user_turns([{"role": "user", "content": None},
                         {"role": "user", "content": 7},
                         {"role": "user"}, "not a dict", None]) == [])

    # ── the tenant slug ────────────────────────────────────────────────────────────────
    print("\n[2] _tenant_of — the slug the sibling organs key on:")
    check("tenant: claims_alice.db -> alice", H._tenant_of("/x/y/claims_alice.db") == "alice")
    check("tenant: plain claims.db -> the founder", H._tenant_of("/x/y/claims.db") == "dennis")
    check("tenant: a phone tenant survives the round trip",
          H._tenant_of("/x/claims_p16475550123.db") == "p16475550123")

    # ── a call that never happened ─────────────────────────────────────────────────────
    print("\n[3] no transcript — a text-only member must cost nothing and raise nothing:")
    H._TENANT_DB = os.path.join(TMP, "claims_missing.db")
    n0 = len(CALLS)
    r = H.harvest()
    check("missing: returns the empty receipt, does not raise",
          r == {"anchors": 0, "watches": [], "commissions": [], "scouted": [], "turns": 0},
          json.dumps(r))
    check("missing: reaches no organ", len(CALLS) == n0)
    check("missing: writes no watermark",
          not Path(os.path.join(TMP, "claims_missing.db.harvest.json")).exists())

    # ── --dry ──────────────────────────────────────────────────────────────────────────
    print("\n[4] --dry — classify, create nothing:")
    db = seed("claims_alice.db", CALL)
    n0 = len(CALLS)
    r = H.harvest(dry=True)
    made = [c for c in CALLS[n0:] if c != "find_engine.recall"]
    check("dry: still sees every ask", r["turns"] == 3, json.dumps(r))
    check("dry: classifies (the gate is the point of a dry run)",
          CALLS[n0:].count("find_engine.recall") == 3)
    check("dry: creates NOTHING — no anchor, no watch, no commission, no scout",
          made == [], ", ".join(made))
    check("dry: the watermark does not move", wm(db) is None)

    # ── the real run ───────────────────────────────────────────────────────────────────
    print("\n[5] the real run — a call becomes rows:")
    n0 = len(CALLS)
    r = H.harvest()
    real = CALLS[n0:]
    check("run: the receipt names what it made",
          r == {"anchors": 1, "watches": ["gpu prices"],
                "commissions": ["open source voice agents"],
                "scouted": ["he keeps circling techno"], "turns": 3}, json.dumps(r))
    check("run: the anchor lane is gated on the cheap regex, not on every turn",
          real.count("anchors.extract") == 1, str(real.count("anchors.extract")))
    check("run: the scout runs ONCE per harvest, not once per turn",
          real.count("watch_engine.scout") == 1, str(real.count("watch_engine.scout")))
    check("run: every organ is handed the slug derived from the db path",
          set(SEEN_SLUGS) == {"alice"}, ",".join(sorted(set(SEEN_SLUGS))))
    check("run: the watermark now holds the transcript length", wm(db) == {"n": len(CALL)},
          json.dumps(wm(db)))

    # ── idempotence ────────────────────────────────────────────────────────────────────
    print("\n[6] idempotence — the property that costs money when it breaks:")
    n0 = len(CALLS)
    r2 = H.harvest()
    check("twice: the second run harvests nothing", r2["turns"] == 0, json.dumps(r2))
    check("twice: the second run reaches NO organ — not even the gate",
          CALLS[n0:] == [], ", ".join(CALLS[n0:]))
    check("twice: the watermark did not move", wm(db) == {"n": len(CALL)})

    # ── the next call on the same transcript ───────────────────────────────────────────
    print("\n[7] the next call — only the new turns:")
    grown = CALL + [{"role": "assistant", "content": "got it, i will keep watching that"},
                    {"role": "user", "content": "look into second hand cameras too"}]
    Path(f"{db}.transcript.json").write_text(json.dumps(grown))
    n0 = len(CALLS)
    r3 = H.harvest()
    check("resume: only the turns since the watermark", r3["turns"] == 1, json.dumps(r3))
    check("resume: the old asks are never re-classified",
          CALLS[n0:].count("find_engine.recall") == 1)
    check("resume: the new commission was made",
          r3["commissions"] == ["open source voice agents"] and r3["watches"] == [])
    check("resume: the watermark advanced to the new length", wm(db) == {"n": len(grown)})

    # ── failure isolation ──────────────────────────────────────────────────────────────
    print("\n[8] isolation — teardown must survive a dead organ:")
    db2 = seed("claims_bob.db", CALL)
    BOOM.update({"watch_engine.create", "anchors.extract"})
    try:
        r4 = H.harvest()
    except Exception as e:
        r4 = None
        check("isolation: harvest never raises to the caller", False, f"{type(e).__name__}: {e}")
    BOOM.clear()
    if r4 is not None:
        check("isolation: harvest never raises to the caller", True)
        check("isolation: a dead organ costs its own lane only",
              r4["watches"] == [] and r4["anchors"] == 0 and
              r4["commissions"] == ["open source voice agents"], json.dumps(r4))
        check("isolation: the scout still ran", r4["scouted"] == ["he keeps circling techno"])
        check("isolation: turns that reached a dead organ are still watermarked "
              "(the organs are create-if-absent on their own side)", wm(db2) == {"n": len(CALL)})

    # ── the write order ────────────────────────────────────────────────────────────────
    # The watermark is written LAST on purpose. Block the write and the work must still have
    # happened — if the write ever moves ahead of the loop, a crash there eats the whole call.
    print("\n[9] the write is last — a crash on the watermark never eats the turns:")
    db3 = seed("claims_carol.db", CALL)
    os.mkdir(f"{db3}.harvest.json")          # a directory: write_text raises, read_text raises
    n0 = len(CALLS)
    try:
        r5 = H.harvest()
    except Exception as e:
        r5 = None
        check("order: a failed watermark write never reaches the caller", False,
              f"{type(e).__name__}: {e}")
    if r5 is not None:
        check("order: a failed watermark write never reaches the caller", True)
        check("order: the work ran BEFORE the write — every organ was still called",
              [c for c in CALLS[n0:] if c != "find_engine.recall"] ==
              ["anchors.extract", "watch_engine.create", "research_engine.commission",
               "watch_engine.scout"], ", ".join(CALLS[n0:]))
        check("order: the receipt still reports the work", r5["turns"] == 3, json.dumps(r5))

    # ── the door that stays shut ───────────────────────────────────────────────────────
    print("\n[10] the verbs harvest deliberately does NOT own:")
    db4 = seed("claims_dana.db", [{"role": "user", "content": "should i buy the a7 iv or wait"}])
    n0 = len(CALLS)
    r6 = H.harvest()
    check("scope: make_real is never created silently — an episode needs the member's yes",
          r6 == {"anchors": 0, "watches": [], "commissions": [], "scouted":
                 ["he keeps circling techno"], "turns": 1} and
          "watch_engine.create" not in CALLS[n0:] and
          "research_engine.commission" not in CALLS[n0:], json.dumps(r6))
    check("scope: a gate outage costs the lane, not the harvest", _recall_unavailable(db4))

    print(f"\n{'=' * 60}\nSCORE: {len(PASS)} pass · {len(FAIL)} FAIL")
    for n, d in FAIL:
        print(f"  ✗ {n} — {d}")
    return 1 if FAIL else 0


def _recall_unavailable(_db: str) -> bool:
    """find_engine's own 'no gate today' signal is swallowed, not logged as a failure."""
    db = seed("claims_erin.db", CALL)

    def down(slug, text):
        raise RecallUnavailable("no index")

    sys.modules["find_engine"].recall = down
    try:
        r = H.harvest()
    finally:
        sys.modules["find_engine"].recall = _recall
    return r["turns"] == 3 and r["watches"] == [] and r["commissions"] == [] and \
        wm(db) == {"n": len(CALL)}


if __name__ == "__main__":
    raise SystemExit(main())
