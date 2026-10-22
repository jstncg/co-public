"""lived.py — the lived TEST: the output half of the flagship loop.

The loop (goal-v4 §0.2): a member sends something that resonates → co places it →
distinguishes impulse from durable intent → and, when the evidence and authority are
sufficient, ONE REVERSIBLE CHANGE enters their actual week → co follows it through
reality → the member says whether life got more chosen or just more busy.

Everything else in the app is accumulation (catches) or conclusion (me / radar /
rooms). This organ owns the part that was missing: what actually CHANGED because of
something they sent, whether it is still in effect, how to undo it, and their verdict.

Laws, enforced here in code and not in a prompt:

  1. PROVENANCE  a test cannot be proposed without a verbatim quote that really
                 appears in this tenant's record. Fails CLOSED when the record can't
                 be read. (the-architecture.md covenant floor)
  2. AUTHORITY   co proposes; only the MEMBER installs. Nothing in this module can
                 move a test to `live` on co's say-so, and no code path promotes a
                 proposal into a mandate. (the authority ladder)
  3. REVERSIBLE  every live test carries its undo, and reverse() always works while
                 live. A change you cannot take back was never a test.
  4. ENDORSED    only the member closes. co cannot declare its own work successful,
                 and `expired` never counts as a win. (the outcome contract)
  5. MORTAL      unanswered tests expire; live tests are capped. This surface is a
                 handful of live changes, never a backlog. (matters are not a list)

Storage is an append-only event log per tenant with a projection over it, so a
reversal, a re-verdict, and a wrong read all stay in the history instead of
overwriting it.

  ~/.co/lived/<tenant>.jsonl
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid

ROOT = os.path.expanduser("~/.co/lived")

# a member answers, or it dies. an unanswered test is not a success.
VERDICT_CEILING_DAYS = 14
# a proposal the member never accepted goes stale fast — co asked, they passed.
PROPOSAL_CEILING_DAYS = 5
# the surface is a handful of live changes. never a backlog.
MAX_LIVE = 3
# and co may not pile up asks either.
MAX_PROPOSED = 2

STATES = ("proposed", "live", "endorsed", "busy", "wrong_read", "reversed",
          "declined", "expired")
# the member's verdict vocabulary: did this belong in my life?
VERDICTS = {
    "chosen": "endorsed",       # yes — life got more mine
    "busy": "busy",             # it happened and it just added load
    "wrong": "wrong_read",      # co misread what I wanted
}


def _path(tenant: str) -> str:
    os.makedirs(ROOT, exist_ok=True)
    return os.path.join(ROOT, f"{tenant}.jsonl")


def _append(tenant: str, ev: dict) -> None:
    ev["ts"] = time.time()
    with open(_path(tenant), "a") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")


def _events(tenant: str) -> list[dict]:
    p = _path(tenant)
    if not os.path.exists(p):
        return []
    out = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


# ---------------------------------------------------------------- provenance

def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _record_paths(tenant: str) -> list[str]:
    """Where the member's own words live. Mirrors journal/wrapped rather than
    re-deriving, so a rename there cannot silently un-ground this gate."""
    out = [os.path.expanduser(f"~/.co/journal/{tenant}.json")]
    try:
        import journal
        out.append(journal._transcript_path(tenant))
    except Exception:
        pass
    out.append(os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json"))
    return out


def _record_text(tenant: str) -> str | None:
    """Everything the member actually said, for the provenance check. None (not "")
    when no record could be read — the caller must fail closed on that."""
    blobs: list[str] = []
    read_any = False
    for p in _record_paths(tenant):
        if not os.path.exists(p):
            continue
        try:
            with open(p) as f:
                doc = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        read_any = True
        if isinstance(doc, dict):                       # journal store
            for e in doc.get("entries") or []:
                if isinstance(e, dict):
                    blobs.append(str(e.get("text") or ""))
        elif isinstance(doc, list):                     # transcript turns
            for turn in doc:
                if isinstance(turn, dict) and turn.get("role") == "user":
                    blobs.append(str(turn.get("content") or ""))
    if not read_any:
        return None
    return _norm(" \n ".join(blobs))


def grounded(tenant: str, quote: str) -> bool:
    """LAW 1. The quote must really be something they said. Fails closed."""
    q = _norm(quote)
    if len(q) < 8:
        return False
    rec = _record_text(tenant)
    if rec is None:
        return False
    return q in rec


# ---------------------------------------------------------------- projection

def _project(tenant: str) -> dict[str, dict]:
    tests: dict[str, dict] = {}
    for ev in _events(tenant):
        tid = ev.get("id")
        kind = ev.get("ev")
        if not tid:
            continue
        if kind == "propose":
            tests[tid] = {
                "id": tid,
                "state": "proposed",
                "created": ev["ts"],
                "updated": ev["ts"],
                "resonance": ev.get("resonance", ""),
                "quality": ev.get("quality", ""),
                "change": ev.get("change", ""),
                "undo": ev.get("undo", ""),
                "question": ev.get("question", ""),
                "origin_quote": ev.get("quote", ""),
                "origin_url": ev.get("url") or None,
                "matter_id": ev.get("matter_id") or None,   # null until matters land
                "authority": "prepared",
                "verdict": None,
                "verdict_words": None,
                "history": [{"state": "proposed", "ts": ev["ts"]}],
            }
            continue
        t = tests.get(tid)
        if not t:
            continue
        def move(state: str) -> None:
            t["state"] = state
            t["updated"] = ev["ts"]
            t["history"].append({"state": state, "ts": ev["ts"]})
        if kind == "accept":
            # LAW 2: only a member action reaches here, and only from `proposed`.
            if t["state"] == "proposed":
                t["authority"] = "member_installed"
                move("live")
        elif kind == "decline" and t["state"] == "proposed":
            move("declined")
        elif kind == "reverse" and t["state"] == "live":
            move("reversed")
        elif kind == "verdict" and t["state"] in ("live", "reversed"):
            t["verdict"] = ev.get("value")
            t["verdict_words"] = ev.get("words") or None
            move(VERDICTS.get(str(ev.get("value")), "busy"))
        elif kind == "expire" and t["state"] in ("proposed", "live"):
            move("expired")
    return tests


def _live(tests: dict[str, dict]) -> list[dict]:
    return [t for t in tests.values() if t["state"] == "live"]


def _proposed(tests: dict[str, dict]) -> list[dict]:
    return [t for t in tests.values() if t["state"] == "proposed"]


# ---------------------------------------------------------------- lifecycle

def propose(tenant: str, *, resonance: str, quality: str, change: str, undo: str,
            question: str, quote: str, url: str | None = None,
            matter_id: str | None = None) -> dict:
    """co proposes ONE reversible change. Never installs it (LAW 2).

    resonance — what they encountered
    quality   — the specific thing that may have caught them, NOT wholesale
                admiration of the source (§5.3 taste-becoming-action)
    change    — the one reversible thing that would enter their week
    undo      — how it comes back out, in the member's terms
    question  — what this test would actually teach
    quote     — their own words that justify it (verbatim, checked)
    """
    for field, val in (("resonance", resonance), ("quality", quality),
                       ("change", change), ("undo", undo), ("question", question)):
        if not (val or "").strip():
            return {"ok": False, "why": f"missing {field}"}
    if not grounded(tenant, quote):
        return {"ok": False, "why": "no provenance — that quote is not in their record"}

    expire_due(tenant)
    tests = _project(tenant)
    if len(_live(tests)) >= MAX_LIVE:
        return {"ok": False, "why": f"{MAX_LIVE} changes already live — let one resolve"}
    if len(_proposed(tests)) >= MAX_PROPOSED:
        return {"ok": False, "why": "a proposal is already waiting on them"}
    # never propose the same change twice (fire-once).
    n = _norm(change)
    for t in tests.values():
        if _norm(t["change"]) == n and t["state"] in ("proposed", "live"):
            return {"ok": False, "why": "already proposed"}

    tid = str(uuid.uuid4())
    _append(tenant, {"ev": "propose", "id": tid, "resonance": resonance.strip()[:200],
                     "quality": quality.strip()[:200], "change": change.strip()[:200],
                     "undo": undo.strip()[:200], "question": question.strip()[:200],
                     "quote": quote.strip()[:300], "url": (url or "")[:500] or None,
                     "matter_id": matter_id})
    return {"ok": True, "id": tid}


def accept(tenant: str, tid: str) -> bool:
    """MEMBER action. The only door from proposed → live (LAW 2)."""
    t = _project(tenant).get(tid)
    if not t or t["state"] != "proposed":
        return False
    if len(_live(_project(tenant))) >= MAX_LIVE:
        return False
    _append(tenant, {"ev": "accept", "id": tid})
    return True


def decline(tenant: str, tid: str) -> bool:
    t = _project(tenant).get(tid)
    if not t or t["state"] != "proposed":
        return False
    _append(tenant, {"ev": "decline", "id": tid})
    return True


def reverse(tenant: str, tid: str) -> bool:
    """LAW 3. Always available while live."""
    t = _project(tenant).get(tid)
    if not t or t["state"] != "live":
        return False
    _append(tenant, {"ev": "reverse", "id": tid})
    return True


def verdict(tenant: str, tid: str, value: str, words: str = "") -> bool:
    """LAW 4. The member closes it. There is no co-side path to `endorsed`."""
    if value not in VERDICTS:
        return False
    t = _project(tenant).get(tid)
    if not t or t["state"] not in ("live", "reversed"):
        return False
    _append(tenant, {"ev": "verdict", "id": tid, "value": value,
                     "words": (words or "").strip()[:300]})
    return True


def expire_due(tenant: str) -> int:
    """LAW 5. Unanswered dies. Expired is never a win."""
    now = time.time()
    n = 0
    for t in _project(tenant).values():
        age = now - t["updated"]
        if t["state"] == "live" and age > VERDICT_CEILING_DAYS * 86400:
            _append(tenant, {"ev": "expire", "id": t["id"]})
            n += 1
        elif t["state"] == "proposed" and age > PROPOSAL_CEILING_DAYS * 86400:
            _append(tenant, {"ev": "expire", "id": t["id"]})
            n += 1
    return n


# ---------------------------------------------------------------- surfaces

def app_view(tenant: str) -> dict:
    """What the app renders. Live changes and open proposals only — the closed ones
    are history, and history is not a to-do list."""
    expire_due(tenant)
    tests = _project(tenant)

    def dto(t: dict) -> dict:
        return {"id": t["id"], "state": t["state"], "resonance": t["resonance"],
                "quality": t["quality"], "change": t["change"], "undo": t["undo"],
                "question": t["question"], "because": t["origin_quote"],
                "url": t["origin_url"],
                "days": int((time.time() - t["updated"]) // 86400)}

    live = sorted(_live(tests), key=lambda t: t["updated"])
    prop = sorted(_proposed(tests), key=lambda t: t["updated"])
    settled = [t for t in tests.values()
               if t["state"] in ("endorsed", "busy", "wrong_read", "reversed")]
    return {
        "live": [dto(t) for t in live],
        "proposed": [dto(t) for t in prop],
        # one honest line of history, so the member can see it has been real before
        "settled": len(settled),
        "endorsed": len([t for t in settled if t["state"] == "endorsed"]),
    }


def pending_verdict(tenant: str) -> list[dict]:
    """Live tests old enough to be worth one ask. The caller still owes the gates
    (budget, pressure, timing) — being due is not permission to speak."""
    out = []
    for t in _live(_project(tenant)):
        if time.time() - t["updated"] > 3 * 86400:
            out.append(t)
    return out


def resolutions(tenant: str, days: int = 30) -> dict:
    """goal-v4 §15.1 metric 7, computed honestly: the denominator is every test the
    member actually installed, and expiry counts against us, never for us."""
    cutoff = time.time() - days * 86400
    tests = [t for t in _project(tenant).values() if t["updated"] >= cutoff]
    installed = [t for t in tests
                 if any(h["state"] == "live" for h in t["history"])]
    return {
        "proposed": len(tests),
        "installed": len(installed),
        "endorsed": len([t for t in installed if t["state"] == "endorsed"]),
        "busy": len([t for t in installed if t["state"] == "busy"]),
        "wrong_read": len([t for t in installed if t["state"] == "wrong_read"]),
        "reversed": len([t for t in installed if t["state"] == "reversed"]),
        "expired": len([t for t in installed if t["state"] == "expired"]),
        "declined": len([t for t in tests if t["state"] == "declined"]),
    }


def summary_line(tenant: str) -> str:
    """One line for the engine's context: what is actually live in their week."""
    live = _live(_project(tenant))
    if not live:
        return ""
    bits = [f'"{t["change"]}" ({int((time.time()-t["updated"])//86400)}d)' for t in live[:MAX_LIVE]]
    return "IN THEIR WEEK RIGHT NOW (you put it there, they can undo it): " + "; ".join(bits)


# ---------------------------------------------------------------- cli

def main(argv: list[str]) -> int:
    """One implementation of the laws, callable from the engine (brain/brain.ts) without
    a second copy of them in TypeScript.

        lived.py propose <tenant> '<json>'   → {"ok":bool,...}
        lived.py view <tenant>               → app_view
        lived.py metric <tenant> [days]      → resolutions
        lived.py summary <tenant>            → one context line
        lived.py sweep <tenant>              → expire_due
    """
    if len(argv) < 3:
        print(json.dumps({"ok": False, "why": "usage: lived.py <cmd> <tenant> [arg]"}))
        return 2
    cmd, tenant, rest = argv[1], argv[2], argv[3:]
    if cmd == "propose":
        try:
            p = json.loads(rest[0]) if rest else {}
        except (IndexError, json.JSONDecodeError):
            print(json.dumps({"ok": False, "why": "bad json"}))
            return 2
        print(json.dumps(propose(
            tenant, resonance=str(p.get("resonance", "")), quality=str(p.get("quality", "")),
            change=str(p.get("change", "")), undo=str(p.get("undo", "")),
            question=str(p.get("question", "")), quote=str(p.get("quote", "")),
            url=p.get("url"), matter_id=p.get("matter_id"))))
    elif cmd == "view":
        print(json.dumps(app_view(tenant)))
    elif cmd == "metric":
        print(json.dumps(resolutions(tenant, int(rest[0]) if rest else 30)))
    elif cmd == "summary":
        print(summary_line(tenant))
    elif cmd == "sweep":
        print(json.dumps({"expired": expire_due(tenant)}))
    else:
        print(json.dumps({"ok": False, "why": f"unknown cmd {cmd}"}))
        return 2
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(main(sys.argv))
