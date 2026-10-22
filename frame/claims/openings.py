#!/usr/bin/env python3
"""OPENINGS — how co finds a thing worth doing (8/27).

Co has always been able to find things that are INTERESTING. This finds things that are
ACTIONABLE, which is a different and much smaller set, and the difference is a gate rather than
a better search. An opening has four parts, and missing any one makes it a newsletter item:

    a fact about the WORLD  ×  a fact about the MEMBER  ×  a WINDOW  ×  an ACTION that exists

No window means it can wait, and anything that can wait should go through the ordinary send gate
where most finds correctly die. No action means it is a find wearing a suit.

Two laws are enforced here rather than hoped for:

    NO OPENING WITHOUT A PRE-REGISTERED UNDO. If co cannot state how the act is reversed before
    taking it, it does not take it. This forces the reversibility analysis to happen at compose
    time instead of during the regret — the same shape as the receipt gate.

    CO SPENDS ITS OWN EFFORT FREELY AND NEVER OTHER PEOPLE'S EXPECTATIONS. "Reversible" is the
    wrong test: reversible FOR THE MEMBER is not reversible IN THE WORLD. A waitlist costs
    nobody anything. A seat out of fourteen means a host is now counting on them, and a no-show
    is a story other people tell.

The first detectors are aimed at SOCIAL CAPITAL rather than money, deliberately. Money-back is
the other lane's job, calendar prep already exists as the meeting read, and the unanswered ask is
the highest-regret category a person has: invisible from the inside, concrete to act on, and
present in everyone's mail from day one.

    python3 openings.py <tenant>          # what co could do right now, ranked
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PARTS = ("world", "member", "window", "action")
MAX_CANDIDATES = 6
MAX_PER_FAMILY = 2       # no single episode or lane may monopolise what co surfaces

FIND_SYS = """You look at THE MEMBER's own mail for OPENINGS — things they can still act on.

The member is named below. This is their inbox: every message was sent TO them or BY them.
Write every action addressed to THEM, in the second person ("reply to X", "ask Y whether"),
never about them in the third person. The first live run produced "draft a message to <member>
reintroducing yourself" — the model had read their mail as a stranger's, which is the same
identity failure the meeting read hit on 8/25. Sourcing and identity are separate laws.

An opening needs all four:
  WORLD   what is true out there (they asked you something, they made an intro, a date is coming)
  MEMBER  why it is theirs (it is addressed to them, they were introduced, they promised it)
  WINDOW  why it matters NOW (it is going stale, the date approaches, it is already overdue)
  ACTION  the single concrete thing that would resolve it, doable by drafting or asking

Only these kinds:
  unanswered   someone asked them something directly and never got an answer
  intro        someone made an introduction and they never replied to it
  promised     they said they would send or do something and did not

NOT openings: newsletters, receipts, notifications, marketing, anything automated, anything
already resolved, anything where the action is "read it". Money, renewals and charges belong to
another lane — skip them entirely.

For each, write ACTION as the concrete move ("reply to X accepting the intro to Y"), and UNDO as
how it is reversed ("the draft is not sent until they tap send"). If you cannot state an undo,
it is not an opening.

At most 5. Zero is the common and correct answer. Reply ONLY JSON:
{"openings": [{"kind": "...", "who": "...", "world": "...", "member": "...", "window": "...",
"action": "...", "undo": "...", "confidence": 0.0}]}"""


def member_names(tenant: str) -> set:
    """Who the member is, so co never reads their mail as a stranger's. Same source the meeting
    read uses — one identity for the whole system, not one per organ."""
    try:
        import moment
        return moment.member_names(tenant)
    except Exception:
        return {tenant}


def _hid(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:14]


# ── WHAT CO IS ASSUMING ───────────────────────────────────────────────────────────────────────
# Almost every detector here infers from ABSENCE: no reply means unanswered, no mail means
# drifted, no follow-up means the promise is unkept. Absence is the weakest evidence there is,
# and stating it is the difference between a read and a guess wearing a confidence score.
#
# Each assumption is CHECKABLE or it is not. A checkable one that has not been checked discounts
# confidence and gets said out loud; an uncheckable one is a permanent limit on the claim and is
# also said out loud. Silence about an assumption is the failure mode — three times today co
# assumed data in his record was ABOUT him and was wrong each time.
ASSUMES = {
    "unanswered": [("they never answered it elsewhere — by phone, in person, on another thread",
                    False)],
    "intro":      [("the introduction was not taken up somewhere co cannot see", False)],
    "promised":   [("they never sent it later", True)],
    "drift":      [("email cadence is the relationship — they may speak weekly by phone", False)],
    "situation:": [("the booking still stands and was not cancelled", True)],
}

UNVERIFIED_DISCOUNT = 0.15       # a checkable assumption left unchecked is worth less
UNCHECKABLE_DISCOUNT = 0.08      # a permanent limit costs less than laziness


def assumptions(o: dict) -> list[dict]:
    """What this opening is taking on faith, declared rather than implied."""
    kind = str(o.get("kind") or "")
    for k, rows in ASSUMES.items():
        if kind == k or kind.startswith(k):
            return [{"claim": c, "checkable": ch,
                     "checked": bool(o.get("checked", {}).get(c))} for c, ch in rows]
    return []


def discount(o: dict) -> float:
    """Confidence after paying for what co has not verified."""
    c = float(o.get("confidence") or 0)
    for a in assumptions(o):
        if a["checked"]:
            continue
        c -= UNVERIFIED_DISCOUNT if a["checkable"] else UNCHECKABLE_DISCOUNT
    return max(c, 0.0)


def unverified(o: dict) -> str:
    """The load-bearing assumption worth saying out loud, or empty. One, never a list — a
    caveat per line is a lawyer, not a counterpart."""
    open_ = [a for a in assumptions(o) if not a["checked"]]
    return open_[0]["claim"] if open_ else ""


def gate(o: dict) -> tuple[bool, str | None]:
    """(ok, why_refused). The four parts, the undo, and the expectations rule — checked at the
    door, because a law that lives only in a prompt is a suggestion."""
    for p in PARTS:
        if not str(o.get(p) or "").strip():
            return False, f"no {p}: a find, not an opening"
    if not str(o.get("undo") or "").strip():
        return False, "no pre-registered undo"
    if o.get("spends_expectations") and not o.get("mandated"):
        return False, "would spend someone else's expectations without a mandate"
    if not (0.0 <= float(o.get("confidence") or 0) <= 1.0):
        return False, "confidence out of range"
    return True, None


def expected(o: dict, tenant: str = "") -> float:
    """What this is worth under the objective: the outcome it could cause, discounted by how
    likely co is to be right, minus what interrupting costs. Ranking by raw value is how a lane
    fills up with confident nonsense.

    Plus the LONG-HORIZON TERM (8/27): an act that advances a standing aim outranks an equally
    good act that does not. This is what makes co's bets correlated instead of independent —
    twenty individually-good moves pointed nowhere is a concierge; the same twenty pointed at one
    aim is strategy. It is also the only place the objective sees past this week."""
    import landed
    base = (landed.VALUE["acted"] * discount(o)) - landed.COST["proactive"]
    if tenant:
        try:
            import aims
            a = aims.serves(tenant, f"{o.get('action','')} {o.get('world','')}")
            if a:
                o["serves_aim"] = a["id"]
                return base + aims.AIM_BONUS
        except Exception:
            pass
    return base


def _mail_openings(tenant: str) -> list[dict]:
    """The social-capital detectors. Aimed queries against Gmail's index rather than an ingest:
    the index is already built, and twenty tens-of-results queries beat reading four years."""
    import gmail_guard
    import llm
    seen, items = set(), []
    for q in ("newer_than:90d older_than:3d is:read -in:sent -category:promotions "
              "-category:social (\"what do you think\" OR \"let me know\" OR \"?\")",
              "newer_than:120d older_than:3d (intro OR introducing OR \"connecting you\" "
              "OR \"meet my friend\") -in:sent -category:promotions"):
        for r in gmail_guard.search(q, limit=12, tenant=tenant):
            k = (r.get("subject", "") + r.get("from", ""))[:80]
            if k in seen:
                continue
            seen.add(k)
            items.append(f"from: {r.get('from','')[:60]} · subject: {r.get('subject','')[:80]} · "
                         f"{r.get('date','')[:16]} · {r.get('snippet','')[:180]}")
    if not items:
        return []
    who = ", ".join(sorted(member_names(tenant))) or tenant
    got = llm.ask_json(llm.json_specs(), FIND_SYS,
                       f"TODAY: {dt.date.today().isoformat()}\nTHE MEMBER IS: {who}\n"
                       f"(everything below is THEIR inbox)\n\n" + "\n".join(items[:40]),
                       max_tokens=1200) or {}
    out = []
    for raw in (got.get("openings") or [])[:5]:
        o = {k: str(raw.get(k) or "").strip()[:200] for k in
             ("kind", "who", "world", "member", "window", "action", "undo")}
        o["confidence"] = min(max(float(raw.get("confidence") or 0), 0.0), 1.0)
        # A draft is co's own effort. It becomes someone else's expectation only when sent, and
        # the member is the one who sends it.
        o["spends_expectations"] = False
        o["id"] = _hid(tenant, o["kind"], o["who"], o["action"][:60])
        out.append(o)
    return out


DRIFT_MIN_SENT = 4           # fewer than this and there was never a rhythm to break
DRIFT_QUIET_DAYS = 75        # a gap that would embarrass you if someone pointed at it


def _drift(tenant: str) -> list[dict]:
    """WHO HAS GONE QUIET. The blind spot named in aims.py: the wants a person feels most are the
    ones they never say, so "be a better brother" appears nowhere in the corpus and cannot be
    mined from words. It CAN be inferred from behaviour — someone they used to write to every few
    weeks and have not in months.

    Frequency then silence, counted locally from sent-mail metadata. Gmail cannot aggregate, so
    co counts a few hundred headers itself. On sent mail the counterpart is the TO header; FROM is
    the member, which is what made the first run return nothing."""
    import email.utils as eu
    from collections import defaultdict
    import gmail_guard
    sent = defaultdict(list)
    mine = {m.lower() for m in member_names(tenant)}
    for r in gmail_guard.search("in:sent newer_than:730d -category:promotions",
                               limit=300, tenant=tenant):
        try:
            when = eu.parsedate_to_datetime(r.get("date", ""))
        except Exception:
            continue
        if not when:
            continue
        for raw in (r.get("to") or "").split(",")[:3]:
            addr = eu.parseaddr(raw)[1].lower()
            if not addr or "@" not in addr:
                continue
            if any(m in addr for m in mine) or "noreply" in addr or "no-reply" in addr:
                continue
            sent[addr].append(when.date())
    out, today = [], dt.date.today()
    for addr, dates in sent.items():
        ds = sorted(dates)
        if len(ds) < DRIFT_MIN_SENT:
            continue                          # no rhythm existed, so none was broken
        quiet = (today - ds[-1]).days
        if quiet < DRIFT_QUIET_DAYS:
            continue
        cadence = max((ds[-1] - ds[0]).days, 1) / len(ds)
        if quiet < cadence * 3:
            continue                          # still inside their normal rhythm with this person
        out.append({
            "kind": "drift", "who": addr,
            "world": f"you wrote to them {len(ds)} times, about every {int(cadence)} days",
            "member": "their own sent mail",
            "window": f"{quiet} days silent, {int(quiet / max(cadence, 1))}x the usual gap",
            "action": f"find a reason to write to {addr.split('@')[0]} that is not an apology",
            "undo": "nothing is sent; it is a draft until they send it",
            "confidence": min(0.4 + min(len(ds), 12) * 0.04, 0.85),
            "spends_expectations": False,
            "id": _hid(tenant, "drift", addr),
        })
    out.sort(key=lambda o: -o["confidence"])
    return out[:3]


PROMISE_SYS = """These are messages THE MEMBER SENT. Find promises they made and appear not to have
kept: "I'll send you", "let me get back to you", "I'll introduce you", "I'll take a look".

An opening only if it is CONCRETE (a specific thing owed to a specific person), OLD enough to be
late, and still worth doing. Skip pleasantries, skip anything that reads as already done.

ACTION is what would discharge it, written to the member in the second person. UNDO is always
that the draft is not sent until they send it.

At most 4. Zero is common. Reply ONLY JSON: {"openings": [{"kind": "promised", "who": "...",
"world": "...", "member": "...", "window": "...", "action": "...", "undo": "...",
"confidence": 0.0}]}

WHO must be the recipient's EMAIL ADDRESS from the to: field, not their first name — co checks
whether the thing was sent later and cannot look anybody up by first name."""


def _promises(tenant: str) -> list[dict]:
    """WHAT THEY SAID THEY WOULD DO. The highest-regret class after the unanswered ask, and the
    one nobody can see from the inside: a promise you made is invisible to you the moment you
    stop thinking about it, and extremely visible to the person waiting."""
    import gmail_guard
    import llm
    items = []
    for r in gmail_guard.search(
            # 120d returned nothing: the promises that rot are OLD. A year back, still late.
            "in:sent newer_than:365d older_than:10d (\"i'll send\" OR \"i will send\" OR "
            "\"get back to you\" OR \"i'll introduce\" OR \"let me check\" OR "
            "\"i'll take a look\" OR \"i'll follow up\")", limit=20, tenant=tenant):
        # TO, not FROM: on sent mail FROM is the member. The same bug drift had, and it left
        # the follow-up check unable to run because it never learned the recipient's address.
        items.append(f"sent {r.get('date','')[:16]} · to: {r.get('to','')[:60]} · "
                     f"{r.get('subject','')[:70]} · {r.get('snippet','')[:180]}")
    if not items:
        return []
    who = ", ".join(sorted(member_names(tenant))) or tenant
    got = llm.ask_json(llm.json_specs(), PROMISE_SYS,
                       f"TODAY: {dt.date.today().isoformat()}\nTHE MEMBER IS: {who}\n\n"
                       + "\n".join(items[:30]), max_tokens=1000) or {}
    out = []
    for raw in (got.get("openings") or [])[:4]:
        o = {k: str(raw.get(k) or "").strip()[:200] for k in
             ("kind", "who", "world", "member", "window", "action", "undo")}
        o["kind"] = "promised"
        o["confidence"] = min(max(float(raw.get("confidence") or 0), 0.0), 1.0)
        o["spends_expectations"] = False
        o["id"] = _hid(tenant, "promised", o["who"], o["action"][:60])
        o["tenant"] = tenant
        _check_followup(o)
        out.append(o)
    return out


def _check_followup(o: dict) -> None:
    """THE ONE ASSUMPTION CO CAN AFFORD TO CHECK. A promise detector that never looks for the
    follow-up is asserting a negative from silence, and telling somebody they owe a thing they
    already sent is the most embarrassing act on the whole board.

    Cheap: one query for later sent mail to the same person. Found means the promise is probably
    discharged and this is not an opening; not found leaves the assumption CHECKED rather than
    merely assumed, which is a different claim."""
    import email.utils as eu
    import gmail_guard
    who = eu.parseaddr(o.get("who") or "")[1] or (o.get("who") or "").strip()
    if "@" not in who:
        return                                  # cannot check without an address; stays assumed
    later = gmail_guard.search(f"in:sent to:{who} newer_than:30d", limit=3,
                               tenant=o.get("tenant") or "")
    o.setdefault("checked", {})["they never sent it later"] = True
    if later:
        o["confidence"] = min(float(o.get("confidence") or 0), 0.25)
        o["note"] = "you have written to them since; this may already be done"


def _situation_openings(tenant: str) -> list[dict]:
    """A trip is not one opening, it is a dozen at different distances. situations.py generates
    them; they leave through this gate like everything else."""
    import situations
    return situations.as_detector(tenant)


DETECTORS = (_mail_openings, _promises, _drift, _situation_openings)


def find(tenant: str) -> list[dict]:
    """Every detector, gated and ranked. Refusals are kept on the object rather than dropped —
    a lane that silently discards most of what it finds cannot be debugged."""
    cands: list[dict] = []
    for det in DETECTORS:
        try:
            cands.extend(det(tenant))
        except Exception as e:
            print(f"  ({det.__name__} error: {e})", file=sys.stderr)
    kept = []
    for o in cands:
        ok, why = gate(o)
        o["refused"] = None if ok else why
        if ok:
            o["expected"] = round(expected(o, tenant), 3)
            kept.append(o)
    kept.sort(key=lambda x: -x["expected"])
    # ONE EPISODE MUST NOT TAKE THE WHOLE SLATE (8/27). A single trip generates five needs, all
    # confident, and they crowded out a 234-day-old promise and three drifted relationships.
    # Rank within a family, then take across families — otherwise the loudest situation in the
    # member's life is the only thing co ever mentions.
    per, spread = {}, []
    for o in kept:
        fam = str(o.get("kind", "")).split(":")[0]
        if per.get(fam, 0) >= MAX_PER_FAMILY:
            continue
        per[fam] = per.get(fam, 0) + 1
        spread.append(o)
    return spread[:MAX_CANDIDATES]


def line(o: dict) -> str:
    """The report surface, collapsed (8/27): the act, and nothing explaining it. Naming the
    retrieval is the database bragging, and justifying the choice makes the act about co."""
    return o["action"][0].lower() + o["action"][1:] if o.get("action") else ""


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    got = find(t)
    if not got:
        print("(no openings — nothing out there can still be acted on, which is the common answer)")
    for o in got:
        print(f"  [{o['kind']:10s} {o['expected']:+.2f}] {line(o)}")
        print(f"      window: {o['window'][:70]}")
        print(f"      undo:   {o['undo'][:70]}")
