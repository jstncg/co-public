#!/usr/bin/env python3
"""THE REGISTER EVAL — is co worth texting, measured on what it actually said.

Why this exists. On 9/2 the founder read a week of co's replies and said: "the responses are
overfit on pattern identification and action orientation. Not everything requires an action. In
fact most don't." He was right, and NOTHING in the suite could have found it. `rail_eval` proves
the organs work. `invariants` proves production state is legal. `scenarios` scores synthetic cases
one at a time. All three were green through the entire drift, because the defect does not live in
any single reply — it lives in the DISTRIBUTION of replies. One message ending in a demand is
fine. Forty in a row is a nag, and being a nag is the one failure this product does not survive.

So this reads co's real transcript, takes the last N (member, co) exchanges, and scores the five
things the founder named:

  CONCISE      length per bubble and beats per reply, against the shape gate
  NOT-ANNOYING the DEMAND RATE — how often a reply ends by asking them to do or answer something.
               Law 11 says most messages need no next step; this is the number that says whether
               the law holds.
  OVERFIT      the MOVE DISTRIBUTION. Every reply is one move; if any single move is most of the
               week, co has one trick. Plus how often two replies in a row make the same move,
               which the prompt bans outright.
  EXPANDING    did co put something in front of them they did not already have — a name, a number,
               a source, a fact from the world — or did it hand their own words back rearranged.
               Measured twice: deterministically (new proper nouns/numbers/urls absent from their
               message) and by judge.
  HELPFUL      judged, 1-5.

TWO INSTRUMENTS ON PURPOSE. The deterministic half cannot flake and cannot flatter. The judged
half sees what a regex cannot. Where they disagree, believe the deterministic one and read the
judge's reason. The judge NEVER wrote the reply it grades and is not pinned to the same vendor —
the take lane taught that a writer scoring its own work returns 7 then 4 on identical input.

    ./evals/register.py                  # last 40 exchanges, founder tenant
    ./evals/register.py --n 80           # a longer window
    ./evals/register.py --tenant p1416…  # a member
    ./evals/register.py --no-judge       # deterministic only, no API cost
    ./evals/register.py --json           # machine-readable, for tracking week over week

GATES are co's own laws turned into numbers, not taste. Each one names the law it enforces.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "claims"))
sys.path.insert(0, str(HERE.parent / "homebase" / "router"))

JUDGE_MODEL = os.environ.get("CO_JUDGE_MODEL", "anthropic/claude-haiku-4-5")
MAX_BUBBLE = 450          # frame/brain/server.ts
MAX_BEATS = 3

# The moves co can make. A reply is exactly one of these, and the point of naming them is that a
# healthy week uses most of them. "read" and "demand" are the two the founder found co stuck on.
MOVES = ["answer", "addition", "read", "demand", "hype", "presence", "ack"]
MOVE_HELP = (
    "answer   = they asked something, co answered it\n"
    "addition = co added something they did not have: a fact, a source, a connection\n"
    "read     = co named a pattern or an intent about THEM\n"
    "demand   = co told them to do something, or asked a question they must now answer\n"
    "hype     = co reacted with real feeling to their moment\n"
    "presence = co acknowledged the thing and stayed with it, asking and prescribing nothing\n"
    "ack      = a bare receipt: 'got it', 'on it', a like")

JUDGE_SYS = (
    "You grade ONE exchange from a personal AI called co, which a person texts their life to.\n"
    "co's rules: most messages need no next step and no question; noticing something and stopping "
    "is a complete message; a read that ends in a demand every time is a nag.\n\n"
    "Classify co's MOVE as exactly one of:\n" + MOVE_HELP + "\n\n"
    "Then score three axes 1-5:\n"
    "helpful   5 = it did something real for them. 3 = fine but generic. 1 = wasted their attention.\n"
    "expanding 5 = it put something in front of them they did not have and could not easily have "
    "found. 3 = mildly new. 1 = it handed their own words back.\n"
    "nag       5 = an unasked-for demand or lecture they now owe an answer to. 3 = a light ask. "
    "1 = it asked nothing of them. LOWER IS BETTER on this axis.\n\n"
    'Reply ONLY JSON: {"move":"...","helpful":N,"expanding":N,"nag":N,"why":"at most 12 words"}')

# Second-person pattern claims — the "read" move's fingerprint, catchable without a model.
_READ_RE = re.compile(
    r"\b(you'?ve (been|sent|said|done)|you always|you keep|you never|you'?re (dodging|avoiding|doing)"
    r"|leaves you|that'?s (your|the) (third|fourth|second)|third .* (this week|in a row)"
    r"|that'?s (three|four|five) this|the actual (ask|question)|every time you)\b", re.I)
# An imperative ask in the final beat: the demand's fingerprint.
_IMPERATIVE_RE = re.compile(
    r"^(go|ship|pick|name|send|write|call|text|do|try|open|start|stop|read|watch|book|ask|tell|paste|put|"
    r"answer|choose|decide|make|take|give|show)\b", re.I)
_HEDGE_ASK_RE = re.compile(r"\b(can you|could you|why don'?t you|you should|worth (doing|a)|try to)\b", re.I)
# The register drops the mark: "what's the pull there" is a question with no "?". The same shape
# regex as brain/server.ts asksBack, run on the last sentence rather than the last beat, so the
# eval counts at least what the gate counts.
_Q_SHAPE_RE = re.compile(
    r"^(what|why|how|when|where|which|who|whose)\b(?=.*([’']s\b|\b(is|are|do|did|can|could|would|should|have|has)\b))"
    r"|(^|[.,;!]\s*)((so|and|but|or|ok|okay|wait),?\s+)?(is|are|was|were|do|does|did|can|could|would|will|should|has|have)"
    r"\s+(it|that|this|he|she|they|you|we|there|i)\b", re.I)
_URLISH = re.compile(r"https?://|\bwww\.")
_PROPER = re.compile(r"\b[A-Z][a-zA-Z]{2,}\b")
_NUMBER = re.compile(r"\b\d[\d,.]*\b")


def beats(reply: str) -> list:
    return [b.strip() for b in (reply or "").split("\n\n") if b.strip()]


def is_demand(reply: str) -> bool:
    """Does this reply end by putting work on them? The last SENTENCE of the last beat is what they
    are left holding — and that is where co puts the ask. Anchoring on the start of the beat missed
    every real case ("which still leaves you dodging the actual ask. name the domain" scored clean),
    which is how a 5% demand rate came back on a week the founder called a nag."""
    bs = beats(reply)
    if not bs:
        return False
    tail = [x.strip() for x in re.split(r"(?<=[.!?])\s+", bs[-1].strip()) if x.strip()]
    last = tail[-1] if tail else ""
    return bool(last.endswith("?") or _IMPERATIVE_RE.match(last) or _HEDGE_ASK_RE.search(last)
                or _Q_SHAPE_RE.search(last))


def new_material(member: str, reply: str) -> bool:
    """Did co name anything the member's own message did not already contain? A cheap, honest floor
    for world-expanding: not proof it was worth saying, but proof it came from outside them."""
    theirs = set(_PROPER.findall(member or "")) | set(_NUMBER.findall(member or ""))
    mine = set(_PROPER.findall(reply or "")) | set(_NUMBER.findall(reply or ""))
    return bool(_URLISH.search(reply or "")) or bool(mine - theirs)


def exchanges(tenant: str, n: int) -> list:
    """The last n (member, co) pairs from the transcript the router actually writes."""
    path = os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json")
    if not os.path.exists(path):
        raise SystemExit(f"no transcript for tenant {tenant!r} at {path}")
    turns = json.loads(open(path).read())
    out = []
    for i in range(len(turns) - 1):
        a, b = turns[i], turns[i + 1]
        if a.get("role") == "user" and b.get("role") == "assistant":
            reply = (b.get("content") or "").strip()
            if reply and reply != "(read it; chose not to reply)":
                out.append({"member": (a.get("content") or "").strip(), "co": reply,
                            "ts": b.get("ts", "")})
    return out[-n:]


def judge_one(member: str, reply: str) -> dict:
    import llm
    try:
        out = llm.complete(JUDGE_MODEL, JUDGE_SYS,
                           f"THEY SENT:\n{member[:1200]}\n\nCO REPLIED:\n{reply[:1200]}",
                           max_tokens=120)
        m = re.search(r"\{.*\}", re.sub(r"</?[a-z_]+>", "", out or ""), re.S)
        d = json.loads(m.group(0)) if m else {}
        if d.get("move") not in MOVES:
            d["move"] = "?"
        return d
    except Exception as e:
        return {"move": "?", "why": f"judge unavailable ({str(e)[:40]})"}


def run(tenant: str, n: int, use_judge: bool) -> dict:
    rows = exchanges(tenant, n)
    if not rows:
        raise SystemExit(f"no exchanges for {tenant}")
    for r in rows:
        bs = beats(r["co"])
        r["beats"] = len(bs)
        r["longest"] = max((len(b) for b in bs), default=0)
        r["demand"] = is_demand(r["co"])
        r["names_pattern"] = bool(_READ_RE.search(r["co"]))
        r["new_material"] = new_material(r["member"], r["co"])
        if use_judge:
            r.update(judge_one(r["member"], r["co"]))

    N = len(rows)
    moves = [r.get("move", "?") for r in rows]
    repeats = sum(1 for i in range(1, N) if moves[i] != "?" and moves[i] == moves[i - 1])
    counted = [m for m in moves if m != "?"]
    top_move, top_share = "?", 0.0
    if counted:
        top_move = max(set(counted), key=counted.count)
        top_share = counted.count(top_move) / len(counted)

    def avg(key):
        vals = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
        return round(statistics.mean(vals), 2) if vals else None

    return {
        "tenant": tenant, "n": N, "rows": rows,
        "concise": {"median_longest_bubble": int(statistics.median(r["longest"] for r in rows)),
                    "over_cap": round(sum(r["longest"] > MAX_BUBBLE for r in rows) / N, 3),
                    "median_beats": statistics.median(r["beats"] for r in rows),
                    "over_beats": round(sum(r["beats"] > MAX_BEATS for r in rows) / N, 3)},
        "annoying": {"demand_rate": round(sum(r["demand"] for r in rows) / N, 3),
                     "names_pattern_rate": round(sum(r["names_pattern"] for r in rows) / N, 3),
                     "nag": avg("nag")},
        "overfit": {"top_move": top_move, "top_move_share": round(top_share, 3),
                    "consecutive_repeat": round(repeats / max(1, N - 1), 3),
                    "distribution": {m: counted.count(m) for m in MOVES if counted.count(m)}},
        "expanding": {"new_material_rate": round(sum(r["new_material"] for r in rows) / N, 3),
                      "judged": avg("expanding")},
        "helpful": avg("helpful"),
    }


# Each gate names the law it enforces. A gate with no law behind it is taste wearing a number.
GATES = [
    ("concise: bubbles under the cap", lambda s: s["concise"]["over_cap"] <= 0.05,
     "shape gate, server.ts MAX_BUBBLE=450", lambda s: f'{s["concise"]["over_cap"]:.0%} over'),
    ("concise: at most three beats", lambda s: s["concise"]["over_beats"] <= 0.05,
     "shape gate, MAX_BEATS=3", lambda s: f'{s["concise"]["over_beats"]:.0%} over'),
    ("not annoying: most replies ask nothing", lambda s: s["annoying"]["demand_rate"] < 0.40,
     "hard law 11 — action is earned, never default",
     lambda s: f'{s["annoying"]["demand_rate"]:.0%} end in a demand'),
    ("not annoying: reads stay occasional", lambda s: s["annoying"]["names_pattern_rate"] < 0.25,
     "hard law 7 — one send proves nothing; naming their pattern is rationed",
     lambda s: f'{s["annoying"]["names_pattern_rate"]:.0%} name a pattern at them'),
    ("no overfit: no single move owns the week",
     lambda s: None if s["overfit"]["top_move"] == "?" else s["overfit"]["top_move_share"] < 0.45,
     "co has more than one move or it is a machine",
     lambda s: f'{s["overfit"]["top_move"]} is {s["overfit"]["top_move_share"]:.0%}'),
    ("no overfit: never the same move twice running",
     lambda s: None if s["overfit"]["top_move"] == "?" else s["overfit"]["consecutive_repeat"] < 0.25,
     "CO_SYSTEM: never the same move twice in a row",
     lambda s: f'{s["overfit"]["consecutive_repeat"]:.0%} repeat the last move'),
    ("expanding: co still brings outside material", lambda s: s["expanding"]["new_material_rate"] >= 0.25,
     "a floor against collapse — the RATE itself is the scoreboard, not the law",
     lambda s: f'{s["expanding"]["new_material_rate"]:.0%} carry new material'),
]
JUDGED_GATES = [
    ("helpful (judged)", lambda s: (s["helpful"] or 0) >= 3.3, "3 is generic; below that is wasted attention",
     lambda s: f'{s["helpful"]}/5'),
    ("expanding (judged)", lambda s: (s["expanding"]["judged"] or 0) >= 3.0, "1 = handed their own words back",
     lambda s: f'{s["expanding"]["judged"]}/5'),
    ("not a nag (judged, lower is better)", lambda s: (s["annoying"]["nag"] or 5) <= 2.5,
     "5 = an unasked-for demand they now owe an answer to", lambda s: f'{s["annoying"]["nag"]}/5'),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", default=os.environ.get("CO_FOUNDER_TENANT", "dennis"))
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--show", type=int, default=0, help="print this many scored exchanges")
    a = ap.parse_args()

    s = run(a.tenant, a.n, not a.no_judge)
    if a.json:
        print(json.dumps({k: v for k, v in s.items() if k != "rows"}, indent=1))
        return 0

    print(f"REGISTER EVAL — {s['n']} exchanges, tenant {s['tenant']}"
          f"{'' if not a.no_judge else '  (deterministic only)'}")
    print(f"\n  concise    longest bubble {s['concise']['median_longest_bubble']} median, "
          f"{s['concise']['median_beats']} beats median")
    print(f"  annoying   {s['annoying']['demand_rate']:.0%} end in a demand, "
          f"{s['annoying']['names_pattern_rate']:.0%} name a pattern at them")
    print(f"  overfit    {s['overfit']['distribution']}")
    print(f"  expanding  {s['expanding']['new_material_rate']:.0%} carry material from outside them")
    if not a.no_judge:
        print(f"  judged     helpful {s['helpful']}/5 · expanding {s['expanding']['judged']}/5 · "
              f"nag {s['annoying']['nag']}/5")

    print()
    gates = GATES + ([] if a.no_judge else JUDGED_GATES)
    failed = skipped = 0
    for name, test, law, detail in gates:
        try:
            ok = test(s)
        except Exception:
            ok = False
        # None means the instrument was not run. A gate that PASSES on absent data is worse than
        # no gate: it reports health it never measured.
        mark = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
        skipped += ok is None
        failed += ok is False
        print(f"  {mark}  {name:44} {detail(s):<28} [{law}]")

    for r in s["rows"][-a.show:] if a.show else []:
        print(f"\n  --- {r.get('ts','')} {r.get('move','?')} "
              f"h{r.get('helpful','-')} e{r.get('expanding','-')} n{r.get('nag','-')} "
              f"{r.get('why','')}\n  THEM: {r['member'][:100]}\n    CO: {r['co'][:160]}")

    print(f"\nREGISTER: {len(gates) - failed - skipped} pass · {skipped} skipped · {failed} FAIL")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
