#!/usr/bin/env python3
"""AIMS — the standing wants, and the quiet work of serving them (8/27).

An implied want is something the member has said more than once and never acted on. The gap
between mention and action IS the want: stated goals get stated once and then pursued or
dropped, while implied wants keep resurfacing precisely because nothing ever happened.

Mining his own corpus proved the diagnosis and moved the problem. The wants were all there, in
his words — "I need to exercise more, my posture is so bad", "I wish you would go watch all the
lecture videos of anthropic engineers", "I want to think more first principles". Co had even
extracted two of them into its ENTITY store, described accurately, and then done nothing with
them. His list had zero items. So detection was never the gap. What was missing is the thing
that turns a noticed want into a standing aim with acts hanging off it.

    THE LINE ON NUDGING. This file changes what is easy and what is in front of the member —
    choice architecture, which is manipulation if it is aimed at goals they did not choose or
    cannot see. Three properties keep it honest, and all three are enforced below rather than
    promised: every aim is quoted VERBATIM from the member's own words, every aim is VISIBLE to
    them, and every aim is REMOVABLE in one tap. Co may never invent an aim, and it may never
    hold one the member has dropped.

    THE STRONGEST NUDGE IS A DEFAULT. Not telling someone to go to the gym — having the hour
    already held, so skipping it takes an act of deletion. That is what ambient means here: the
    aim is served with no message at all, and the member meets it as a changed condition rather
    than as a request.

Known blind spot, and it is where he says it matters most: "brother", "son" and family appear
NOWHERE in want-shaped language across 627 items. The wants a person feels most are the ones
they never say, so text mining structurally cannot reach them. That needs behavioural inference
— who they have stopped talking to — which is the people graph, not this file.

    python3 aims.py <tenant>              # the standing aims and what has served them
    python3 aims.py <tenant> --mine       # re-read the corpus
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DIR = os.path.expanduser("~/.co/aims")
MAX_AIMS = 6                 # a person cannot be aimed at ten things; neither can co
MIN_RECEIPT = 15             # shorter than this is a fragment, not a quote

import re                    # noqa: E402  (kept next to the patterns it serves)

# FILTER FIRST, WINDOW SECOND. The third time this bug appeared today. A want is stated once a
# season, the corpus runs 46k characters, and a 30k tail dropped the most explicit statement in
# the record — "I need to exercise more... my posture is so bad" sat at item 167 of 627 and was
# simply outside the window. Rare signal cannot be sampled from a recent slice.
WANT_RE = re.compile(
    r"\b(i want|i wanna|i need to|i should|i'd like|i'm trying to|trying to|i keep|"
    r"i've been meaning|i wish|want to be|need to be|should be|i care about|my goal)\b", re.I)

# SOURCING AND ATTRIBUTION ARE SEPARATE LAWS. Containment proves the words exist in his record;
# it does not prove they are about HIM. The first live run made "he's growing his own network
# into venture" — his description of someone else — into one of his own aims. A receipt has to
# be first-person to be a statement about the speaker.
FIRST_PERSON = re.compile(r"\b(i|i'm|i'd|i've|my|me|myself)\b", re.I)

# An aim co cannot serve is a horoscope. Each names the class of act that advances it, which is
# also what stops the miner returning "be happier".
SERVICE = {
    "time": "hold hours for it before they are taken",
    "material": "put the thing itself in their world, primary over commentary",
    "practice": "make the next rep the easy option",
    "people": "manufacture occasions, never reminders",
}

MINE_SYS = """From the member's OWN messages, find their STANDING AIMS: things they have said they
want to become or do, that nothing has since happened about.

An aim qualifies only if ALL of these hold:
  SAID BY THEM      you can quote their words verbatim, AND the quote is them speaking about
                    THEMSELVES in the first person. A sentence describing what someone else is
                    doing is never their aim, however admiring. Never infer an aim they did not
                    state.
  UNRESOLVED        it is a direction, not a task they finished
  SERVABLE          one of these can advance it:
                      time      it needs hours held before they are taken
                      material  it needs the thing itself put in front of them
                      practice  it needs the next rep made easy
                      people    it needs an occasion manufactured, never a reminder
  DURABLE           still true in ninety days. Moods and one-off reactions are not aims.

Merge restatements of the same want into ONE aim and keep the most vivid quote. Prefer aims
where they gave a REASON — the reason is the actual aim and the activity is the instrument.

At most 6. Reply ONLY JSON: {"aims": [{"aim": "short, in their voice", "receipt": "their exact
words, verbatim", "service": "time|material|practice|people", "why": "the reason they gave, or
empty"}]}"""


def _path(tenant: str) -> str:
    os.makedirs(DIR, exist_ok=True)
    return os.path.join(DIR, f"{tenant}.json")


def load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {"aims": [], "dropped": []}


def save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False, indent=1)


def _aid(aim: str) -> str:
    return hashlib.sha256(aim.lower().encode()).hexdigest()[:12]


def _grounded(receipt: str, corpus: str) -> bool:
    """The aim must be quotable. Same containment law the reading and the meeting read run on:
    if co cannot find the words in their record, co made them up."""
    r = " ".join((receipt or "").split()).lower()
    return len(r) >= MIN_RECEIPT and r in " ".join(corpus.split()).lower()


def mine(tenant: str) -> int:
    """Fresh aims from their own words only. Anything they have dropped stays dropped — a
    correction the nightly mine can undo is not a correction."""
    import journal
    import llm
    mat = journal.member_material(tenant, limit=None)
    corpus = "\n".join(mat)
    if len(corpus) < 400:
        return 0
    wanting = [m for m in mat if WANT_RE.search(m)]          # filter first...
    blob = "\n".join(wanting[-120:])[-24000:]                # ...window the MATCHES second
    got = llm.ask_json(llm.json_specs(), MINE_SYS, blob or corpus[-24000:], max_tokens=1400) or {}
    st = load(tenant)
    dropped = set(st.get("dropped") or [])
    have = {a["id"]: a for a in st["aims"]}
    today = dt.date.today().isoformat()
    added = 0
    for raw in (got.get("aims") or [])[:MAX_AIMS]:
        aim = str(raw.get("aim") or "").strip()[:120]
        receipt = str(raw.get("receipt") or "").strip()[:300]
        service = str(raw.get("service") or "").strip()
        if not aim or service not in SERVICE:
            continue
        if not _grounded(receipt, corpus):
            continue                       # unquotable: co invented it
        if not FIRST_PERSON.search(receipt):
            continue                       # quotable but about someone else: not their aim
        aid = _aid(aim)
        if aid in dropped:
            continue                       # they said no; the miner does not overrule them
        if aid in have:
            have[aid]["seen"] = today
            continue
        st["aims"].append({"id": aid, "aim": aim, "receipt": receipt, "service": service,
                           "why": str(raw.get("why") or "").strip()[:140],
                           "since": today, "seen": today, "served": []})
        added += 1
    st["aims"] = st["aims"][:MAX_AIMS]
    save(tenant, st)
    return added


def live(tenant: str) -> list[dict]:
    return [a for a in load(tenant).get("aims") or [] if a.get("id")]


def drop(tenant: str, aid: str) -> bool:
    """The member's half. Dropped is REMEMBERED, because mine() reads the same corpus forever and
    would resurrect it by morning."""
    st = load(tenant)
    before = len(st["aims"])
    st["aims"] = [a for a in st["aims"] if a["id"] != aid]
    st["dropped"] = sorted({*(st.get("dropped") or []), aid})[:200]
    save(tenant, st)
    return len(st["aims"]) < before


# A length filter alone drops the words that carry the aim: "gym" is three characters and
# "exercise more" is not what a calendar hold says. Stop-list instead of a length cliff.
_STOP = {"more", "have", "want", "into", "with", "that", "this", "them", "than", "then",
         "some", "just", "like", "will", "from", "your", "yours", "about", "being", "back",
         "make", "made", "does", "done", "very", "really", "think", "thing", "things"}


def _keywords(text: str) -> set:
    return {w.strip(".,!?;:") for w in (text or "").lower().split()
            if len(w) >= 3 and w not in _STOP}


def serves(tenant: str, text: str) -> dict | None:
    """Does this candidate act advance a standing aim? Cheap word overlap on purpose: a model
    call per candidate would make ranking expensive enough to skip, and skipped ranking is how
    the long-horizon term quietly stops applying."""
    t = (text or "").lower()
    best, score = None, 0
    for a in live(tenant):
        words = _keywords(a["aim"] + " " + a.get("why", ""))
        hit = sum(1 for w in words if w in t)
        if hit > score:
            best, score = a, hit
    return best if score >= 2 else None


AIM_BONUS = 0.4          # the long-horizon term: a bet that compounds outranks one that does not


def note_served(tenant: str, aid: str, what: str) -> None:
    st = load(tenant)
    for a in st["aims"]:
        if a["id"] == aid:
            a["served"] = (a.get("served") or [])[-19:] + [
                {"what": what[:120], "at": dt.date.today().isoformat()}]
    save(tenant, st)


# ── AMBIENT SERVICE ───────────────────────────────────────────────────────────────────────────
# Acts that produce NO message. The member meets them as a changed condition rather than as a
# request, which is the only version of this that is ambient rather than a nagging notification.

def ambient(tenant: str) -> list[dict]:
    """What co could quietly do for the standing aims right now. Returns proposals; taking them
    is the caller's decision, and every one carries its undo."""
    out = []
    for a in live(tenant):
        if a["service"] == "time":
            out.append({"aim": a["id"], "kind": "hold",
                        "what": f"hold an hour for: {a['aim']}",
                        "undo": "delete the calendar block", "silent": True})
        elif a["service"] == "material":
            out.append({"aim": a["id"], "kind": "queue",
                        "what": f"put the thing itself in their world: {a['aim']}",
                        "undo": "it sits on the page; nothing was sent", "silent": True})
        elif a["service"] == "practice":
            out.append({"aim": a["id"], "kind": "default",
                        "what": f"make the next rep the easy option: {a['aim']}",
                        "undo": "the default is reversible in one tap", "silent": True})
        elif a["service"] == "people":
            out.append({"aim": a["id"], "kind": "occasion",
                        "what": f"manufacture an occasion, never a reminder: {a['aim']}",
                        "undo": "nothing is sent to anyone without them sending it",
                        "silent": True})
    return out


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    if "--mine" in sys.argv:
        print(f"+{mine(t)} new aims")
    got = live(t)
    if not got:
        print("(no standing aims yet — run with --mine)")
    for a in got:
        print(f"\n  [{a['service']:8s}] {a['aim']}")
        print(f"      their words: “{a['receipt'][:96]}”")
        if a.get("why"):
            print(f"      because:     {a['why'][:80]}")
        print(f"      served {len(a.get('served') or [])}x since {a['since']}")
    if got:
        print("\n  ambient moves available:")
        for m in ambient(t):
            print(f"    · {m['what'][:88]}")
