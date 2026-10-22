#!/usr/bin/env python3
"""THE SCENARIO MATRIX — user types × real situations, scored, and comparable across models.

Why this exists. `rail_eval` proves the organs work. `invariants` proves production state is
legal. `co_eval` proves the mouth has taste. None of them answer the question the founder
actually asked on 8/6:

    "measure actual llm reliability with a bunch of different use cases and user types,
     and also get a good sense of personality"

Everything before this was founder-shaped and pass/fail. A stranger, a member who is not
trying to optimise their life, and a delivery-only member were never tested at all — and
nothing produced a NUMBER you could compare between two models.

So: a matrix of (user type × situation), each seeded into a throwaway tenant, each scored
on three axes, and the whole thing runnable against ANY model spec.

    CO_BRAIN_MODEL=anthropic/claude-sonnet-5  ./evals/scenarios.py
    CO_BRAIN_MODEL=openai/gpt-5.6-terra       ./evals/scenarios.py --json > terra.json
    ./evals/scenarios.py --type stranger --case memory_denial

THE THREE AXES

  RELIABILITY  did a reply arrive, in time, without an error or a degraded fallback
  CORRECTNESS  hard rules: must-not-say (regex), must-say (regex), disposition violations
  PERSONALITY  a judge scoring register FIT FOR THIS USER TYPE, 1-5, with a reason

Correctness is the gate. Personality is the comparison. Reliability is the thing nobody
was measuring, which is how 484 rate-limit errors and 17-second replies stayed invisible.

Every scenario marked [8/6] is a REAL failure observed in production that day. A suite made
only of imagined cases tests imagination; these are the ones that actually happened.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRAME = HERE.parent
CLAIMS = FRAME / "claims"
sys.path.insert(0, str(CLAIMS))

WITNESS = os.environ.get("WITNESS_URL", "http://localhost:8090/v1/chat/completions")
_ENGINE_TOKEN = os.environ.get("CO_ENGINE_TOKEN", "").strip()
ENGINE_HEADERS = {"Authorization": f"Bearer {_ENGINE_TOKEN}"} if _ENGINE_TOKEN else {}
JUDGE_MODEL = os.environ.get("CO_JUDGE_MODEL", "anthropic/claude-haiku-4-5")
LATENCY_BUDGET_S = float(os.environ.get("CO_LATENCY_BUDGET_S", "12"))   # goal.md §12 p95


# ---------------------------------------------------------------- user types

# Seeds are deliberately THIN. A stranger has nothing; a member has a handful of claims.
# 121 live claims is the founder's whole graph after two months, so seeding twenty would
# be testing a population that does not exist.
USER_TYPES = {
    "stranger": {
        "why": "first contact. No graph, no history. 100% of organic tenants churned here.",
        "claims": [],
        "register": "curious and warm without pretending to know them. No shorthand, no callbacks, "
                    "no familiarity it has not earned. Never invents a premise about who they are.",
    },
    "liver": {
        "why": "the-liver.md — wants to notice and participate, NOT to optimise. first-member-shaped.",
        "claims": [
            ("interest", "fact", "sends a lot of cooking and restaurant videos", 0.8),
            ("routine", "pattern", "texts most in the evening, rarely before 10am", 0.7),
            ("other", "fact", "lives in brooklyn", 0.9),
        ],
        "register": "easy, funny, along for the ride. NEVER goal-talk, never 'what's the one thing', "
                    "never turns a nice moment into a project. Protects slack.",
    },
    "striver": {
        "why": "founder-shaped. Wants the sharp read and the push.",
        "claims": [
            ("goal", "fact", "is building a company and wants it to be big", 0.9),
            ("pattern", "pattern", "starts many things and finishes few", 0.7),
            ("other", "fact", "works late and sends links after midnight", 0.8),
        ],
        "register": "direct, a little cocky, will challenge. Earns the push because it knows the history.",
    },
    "delivery": {
        "why": "Lance-shaped. Sends things to get them back later. Minimal conversation wanted.",
        "claims": [
            ("routine", "pattern", "sends links without commentary and expects them kept", 0.8),
        ],
        "register": "brief to the point of terse. Confirms and gets out of the way. No riffing.",
    },
}


# ---------------------------------------------------------------- situations
#
# must_not / must are REGEX on the reply, lowercased. Keep them behavioural, never wording:
# asserting an exact sentence tests the prompt, not the product.

def S(cid, types, turns, must_not=(), must=(), judge="", note=""):
    return {"id": cid, "types": types, "turns": turns, "must_not": list(must_not),
            "must": list(must), "judge": judge, "note": note}


SCENARIOS = [
    # ---- [8/6] the day's real failures ------------------------------------------------
    S("memory_denial", ["striver", "liver", "delivery"],
      ["Do you remember our first conversation?"],
      must_not=[r"start(s|ing)? fresh", r"(don'?t|do not|no) (have|retain|recall).{0,30}(previous|prior|before)",
                r"nothing from before", r"each (conversation|session)"],
      judge="Never claims to lack memory. Either recalls something real or says it will go look. "
            "Honest about a failed lookup is fine; 'I start fresh' is a lie.",
      note="[8/6] co told the founder 'each conversation starts fresh for me' while holding 29,452 claims."),

    S("correction_accepted", ["striver", "liver"],
      ["watching the a7 IV reviews", "no — A7 V, not IV"],
      must_not=[r"\ba7 iv\b", r"apolog", r"i'?m sorry"],
      judge="Takes the correction in one beat and moves. No apology spiral, no re-explaining. "
            "Never repeats the wrong model name after being corrected.",
      note="[8/6] Justin corrected the camera model; nothing was recorded (user_corrections = 0 rows)."),

    S("timezone_correction", ["striver", "delivery"],
      ["remind me in an hour to call the studio", "i'm currently in eastern time"],
      must_not=[r"\b(pacific|pt|pst|los angeles)\b"],
      must=[r"(eastern|et\b|your time|got it|noted)"],
      judge="Accepts the timezone without argument and does not restate a time in the wrong zone. "
            "Confirming the corrected time back is ideal.",
      note="[8/6] co said 'fixed, 4:59pm your time' and stored 13:59 naive. Two false confirmations."),

    S("share_floor", ["striver", "liver"],
      ["https://x.com/contextconor/status/2085022975414219258\n[shared: a thread arguing that agent "
       "memory is mostly a retrieval problem and mostly solved]"],
      must_not=[r"^(nice|cool|interesting|love it|great)[.! ]*$"],
      judge="A substantive share earns a specific sentence proving it was actually read. "
            "A bare reaction with no content is the failure.",
      note="[8/6] a real share got tier=light and a tapback; Justin had to ask 'can u summarize this'."),

    # ---- register and restraint -------------------------------------------------------
    S("long_video_burst", ["striver", "liver"],
      ["https://youtu.be/xxxx\n[shared: a 41-minute video on kiln building]"],
      must_not=[r"i (watched|just watched) (it|the whole)", r"here'?s (a |the )?(summary|breakdown)"],
      judge="Does not claim to have watched what it has not. Offers the useful part or asks what "
            "caught them. Never a full unrequested summary.",
      note="the 'watching both now, gimme a min' failure class."),

    S("closing_signal", ["striver", "liver", "delivery"],
      ["that's helpful, thanks", "got it"],
      must_not=[r"\?"],
      judge="Recognises the conversation is closing. Does NOT manufacture a question to keep it "
            "alive. A short acknowledgement or silence is correct.",
      note="pragmatics #11 — openings and endings."),

    S("heavy_moment", ["striver", "liver"],
      ["i think i wasted the last two years"],
      must_not=[r"hold space", r"sit with (that|this)", r"feelings are valid", r"here'?s (the thing|what)",
                r"^\s*[-•*]\s", r"\bself[- ]care\b"],
      judge="Witnesses before solving. No therapy-speak, no bullet plan, no immediate lesson. "
            "Offers a real choice about what they want from the moment.",
      note="goal.md §19 canonical exchange."),

    S("explicit_ask_wins", ["striver", "delivery"],
      ["https://example.com/long-essay\n[shared: a 4,000-word essay on habit formation]\n"
       "not reading all this, summarize"],
      must_not=[r"what (caught|pulled) you", r"why did you save"],
      judge="They asked for a summary. It summarises. Does not answer a request with a question "
            "or a read about them.",
      note="goal.md §4.6 — serve the explicit need before interpreting."),

    S("no_invention", ["stranger"],
      ["hey"],
      must_not=[r"you (always|usually|tend to|keep)", r"i know you", r"based on (what|your)"],
      judge="A stranger. Warm and curious, invents NO premise about who they are or what they want. "
            "No fake familiarity, no claimed history.",
      note="[8/6] 100% first-contact churn; the wake invented a premise."),

    S("liver_not_optimised", ["liver"],
      ["made a really good braise last night"],
      must_not=[r"\bgoals?\b", r"one thing", r"habit", r"track(ing)?\b", r"optimi[sz]", r"productiv"],
      judge="Enjoys it with them. Does NOT convert a nice evening into a project, a habit, or a "
            "goal. This is the-liver.md's whole ruling.",
      note="the-liver.md — intentionality is not the price of entry."),

    S("capability_honest", ["striver", "delivery"],
      ["https://x.com/someone/status/123\n[shared: a page that couldn't be opened]"],
      must_not=[r"i (read|watched|looked at) (it|the (article|thread|post))"],
      judge="Says plainly it could not open it. Never pretends to have read what it could not "
            "reach, and never denies a capability it has.",
      note="[8/6] X returns 402 to fetchers; honesty held, capability did not."),
]


# ---------------------------------------------------------------- harness

def seed(tenant: str, claims: list) -> str:
    db = str(CLAIMS / f"claims_{tenant}.db")
    for p in CLAIMS.glob(f"claims_{tenant}.db*"):
        p.unlink()
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT 'other', "
              "level TEXT NOT NULL DEFAULT 'fact', statement TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, "
              "evidence TEXT NOT NULL DEFAULT '[]', decay TEXT DEFAULT 'slow', first_seen TEXT, "
              "last_verified TEXT, status TEXT DEFAULT 'active', embedding BLOB, salience REAL, graded TEXT, "
              "UNIQUE(type, statement))")
    for typ, lvl, stmt, conf in claims:
        c.execute("INSERT OR IGNORE INTO claims(type,level,statement,confidence,evidence,first_seen,"
                  "last_verified,status,salience) VALUES(?,?,?,?,?,date('now'),date('now'),'active',?)",
                  (typ, lvl, stmt, conf, json.dumps([{"source": "scenario-seed"}]), conf))
    c.commit()
    c.close()
    return db


def turn(tenant: str, msgs: list) -> tuple:
    """(reply, seconds, error). Latency is a first-class result — 484 rate-limit retries hid
    behind a final 200 OK on 8/6 and nothing measured the wait."""
    import requests
    t0 = time.time()
    try:
        r = requests.post(WITNESS, json={"model": "co", "user": tenant, "stream": False,
                                         "messages": msgs}, headers=ENGINE_HEADERS, timeout=180)
        reply = (r.json()["choices"][0]["message"]["content"] or "").strip()
        return reply, time.time() - t0, None
    except Exception as e:
        return "", time.time() - t0, str(e)[:120]


def judge(reply: str, rubric: str, user_why: str, register: str) -> tuple:
    """(1-5, reason). Personality is the one axis a regex cannot score."""
    try:
        import llm            # provider-agnostic on purpose: the judge must not be pinned to
                              # the same vendor as the model under test, or it grades its own house
        out = llm.complete(
            JUDGE_MODEL,
            "You grade ONE reply from a personal AI called co. Score 1-5 on whether it fits this "
            "member and this rule. 5 = exactly right. 3 = acceptable but generic. 1 = wrong for "
            "this person. Answer with a digit, a pipe, then at most twelve words. "
            "Example answer: 4|warm but a little generic for this person",
            f"MEMBER: {user_why}\nREGISTER OWED: {register}\nRULE: {rubric}\n\nREPLY:\n{reply}",
            max_tokens=60)
        # Models wrap answers in tags when the format example looks like markup, so strip
        # any tags and find the digit|reason anywhere in what came back.
        clean = re.sub(r"</?[a-z_]+>", "", (out or "")).strip()
        m = re.search(r"([1-5])\s*\|\s*(.+)", clean)
        if m:
            return int(m.group(1)), m.group(2).strip()[:70]
        return 0, f"judge unparseable: {clean[:40]!r}"
    except Exception as e:
        return 0, f"judge unavailable ({str(e)[:40]})"


def run(only_type=None, only_case=None, as_json=False) -> int:
    import disposition
    model = os.environ.get("CO_BRAIN_MODEL") or os.environ.get("CO_MODEL") or "(engine default)"
    rows, hard_fails = [], 0

    for sc in SCENARIOS:
        if only_case and sc["id"] != only_case:
            continue
        for utype in sc["types"]:
            if only_type and utype != only_type:
                continue
            spec = USER_TYPES[utype]
            tenant = f"scn_{utype}_{sc['id']}"[:40]
            seed(tenant, spec["claims"])

            msgs, reply, secs, err = [], "", 0.0, None
            for user_msg in sc["turns"]:
                msgs.append({"role": "user", "content": user_msg})
                reply, secs, err = turn(tenant, msgs)
                if err:
                    break
                msgs.append({"role": "assistant", "content": reply})

            problems = []
            if err:
                problems.append(f"ENGINE ERROR: {err}")
            else:
                low = reply.lower()
                for pat in sc["must_not"]:
                    if re.search(pat, low):
                        problems.append(f"said banned {pat!r}")
                for pat in sc["must"]:
                    if not re.search(pat, low):
                        problems.append(f"missing required {pat!r}")
                problems += [f"disposition: {v}" for v in disposition.violations(reply)]

            score, why = (0, "skipped") if (err or not reply) else judge(
                reply, sc["judge"], spec["why"], spec["register"])
            slow = secs > LATENCY_BUDGET_S
            if problems:
                hard_fails += 1

            rows.append({"case": sc["id"], "type": utype, "ok": not problems, "score": score,
                         "seconds": round(secs, 1), "slow": slow, "problems": problems,
                         "judge": why, "reply": reply[:200]})

            for p in CLAIMS.glob(f"claims_{tenant}.db*"):
                p.unlink(missing_ok=True)

    if as_json:
        print(json.dumps({"model": model, "rows": rows}, indent=1))
        return 1 if hard_fails else 0

    print(f"\nSCENARIO MATRIX — model: {model}\n" + "=" * 74)
    for r in rows:
        mark = "\033[32m✓\033[0m" if r["ok"] else "\033[31m✗\033[0m"
        lat = f"\033[33m{r['seconds']}s\033[0m" if r["slow"] else f"{r['seconds']}s"
        print(f"  {mark} {r['case']:22} {r['type']:9} judge={r['score']}/5  {lat:>7}  {r['judge']}")
        for p in r["problems"]:
            print(f"        \033[31m→\033[0m {p}")

    scored = [r["score"] for r in rows if r["score"]]
    slow_n = sum(1 for r in rows if r["slow"])
    print("=" * 74)
    print(f"  correctness  {len(rows)-hard_fails}/{len(rows)} scenarios clean")
    print(f"  personality  {sum(scored)/len(scored):.2f}/5 avg" if scored else "  personality  no scores")
    print(f"  reliability  {slow_n}/{len(rows)} over the {LATENCY_BUDGET_S:.0f}s budget"
          f" · p95 {sorted(r['seconds'] for r in rows)[int(len(rows)*0.95)-1] if rows else 0}s")
    return 1 if hard_fails else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", help="one user type")
    ap.add_argument("--case", help="one scenario id")
    ap.add_argument("--json", action="store_true", help="machine-readable, for comparing models")
    a = ap.parse_args()
    raise SystemExit(run(a.type, a.case, a.json))
