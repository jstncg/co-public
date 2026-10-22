#!/usr/bin/env python3
"""Becoming — the person they're trying to be, computed from their own admiration (8/25).

Co had no model of the target self, so every lane aimed at "their interests" and the output
read as useful-but-generic. This organ builds the target and exposes it as an aiming function.

THE THREE DESIGN LAWS, each load-bearing:

1. NEVER ASK. The truest specification of who someone wants to be is who they admire and
   WHAT SPECIFICALLY about them — and that is already in their own words. Extract the
   QUALITY, never the person: "thinks in leverage" transfers, "be naval" does not.

2. A TRAIT MUST BE SCOREABLE. Every trait carries a frequency and binds to one metric co can
   actually compute from evidence it already holds. A trait co cannot score is a horoscope,
   so the composer picks only from the fixed list below. This is the whole difference between
   a target and an affirmation.

3. THE PAYLOAD IS THE CONTRADICTION. Distances are useful; the sentence that changes someone
   is where their behavior says they are becoming someone other than who they say. Stated as
   fact, with receipts, once.

    python3 becoming.py <tenant>            # build and print the portrait
    python3 becoming.py <tenant> --gap      # the largest closable gap (the aiming function)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT_DIR = os.path.expanduser("~/.co/becoming")
REFRESH_DAYS = 7

# The only evidence co can honestly score. A trait must bind to one of these or it does not
# ship — this list IS the boundary between a target self and a fortune cookie.
METRICS = {
    "done_per_week": "COUNT per week: things they committed to that actually happened",
    "follow_through": "RATIO 0 to 1: share of commitments that happened rather than slipped",
    "primary_ratio": "RATIO 0 to 1: share of intake that is primary source, not commentary",
    "breadth": "RATIO 0 to 1: share of intake outside their three dominant themes",
    "people_per_week": "COUNT per week: distinct people they actually sat with",
    "deep_blocks_per_week": "COUNT per week: protected blocks of ninety minutes or more",
}

ADMIRE_SYS = """From this person's own words, find who they ADMIRE and exactly WHAT about them.
Only real named people they referenced with respect, aspiration, or comparison to themselves.

For each: the specific transferable QUALITY, phrased as behavior, not adjectives ("ships writing
and nothing else", "does the unscalable thing personally"), plus the verbatim fragment of theirs
that shows it. Skip anyone they merely quoted or shared without aspiration.

At most 6. Reply ONLY JSON:
{"admired": [{"who": "...", "quality": "...", "receipt": "<their words, verbatim, max 15 words>"}]}"""

TRAITS_SYS = """You are composing the TARGET SELF for one person: the operational description of
who they are trying to become. You have the qualities they admire in others and what they say
they want.

Write 4 to 6 TRAITS. Each must be:
  - behavior with a frequency, never an adjective ("ships something public weekly", not "prolific")
  - bound to exactly one metric from the ALLOWED list, whichever most nearly measures it
  - given a target number IN THAT METRIC'S OWN UNITS. A metric marked RATIO takes a number
    between 0 and 1 (0.4, not 40). A metric marked COUNT takes a per-week count (3, not 300).
    Getting the units wrong makes the whole portrait meaningless.

A trait you cannot bind to an allowed metric does not go in. Fewer real traits beats more vague
ones. Reply ONLY JSON:
{"traits": [{"trait": "...", "metric": "<one of the allowed keys>", "target": <number>,
             "from": "<which admired quality or stated want this comes from>"}]}"""

CONTRA_SYS = """You have who this person says they're becoming and what their last ninety days
actually show. Find the ONE contradiction worth saying: a place their behavior is building a
different person than the one they describe.

Speak to THEM, as "you". Two lowercase sentences, as fact, never as judgment, never as advice.
Never name a metric and never print a raw number or ratio: translate it into plain speech
("almost everything you send is someone else's take", not "breadth sits at 0.88"). No em-dashes.
If the behavior genuinely matches the words, say so instead — that is a real and rarer answer.

Reply ONLY JSON: {"contradiction": true|false, "line": "..."}"""


def _path(tenant: str) -> str:
    os.makedirs(OUT_DIR, exist_ok=True)
    return os.path.join(OUT_DIR, f"{tenant}.json")


def load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {}


def _save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False)


# ---------------------------------------------------------------- the measurable half

def metrics(tenant: str, days: int = 90) -> dict:
    """What the last ninety days actually show. Every number here comes from evidence co
    already holds — nothing is self-reported, which is why the distances can be trusted."""
    out = {}
    weeks = max(1.0, days / 7)
    try:
        import outcomes
        recs = [o for o in outcomes._load(tenant).get("outcomes", [])
                if o.get("when", "") >= (dt.date.today() - dt.timedelta(days=days)).isoformat()]
        hit = [o for o in recs if o.get("verdict") == "happened"]
        out["done_per_week"] = round(len(hit) / weeks, 2)
        out["follow_through"] = round(len(hit) / len(recs), 2) if recs else None
    except Exception:
        pass
    try:
        import journal
        cutoff = (dt.date.today() - dt.timedelta(days=days)).isoformat()
        es = [e for e in (journal._load(tenant).get("entries") or [])
              if (e.get("date") or "") >= cutoff and not (e.get("text") or "").startswith("(from our")]
        if es:
            texts = [(e.get("text") or "") for e in es]
            primary = sum(1 for t in texts if re.search(
                r"arxiv|\.pdf|nature\.com|acm\.org|papers?\.|research\.|/blog/|substack|essay", t, re.I))
            out["primary_ratio"] = round(primary / len(texts), 2)
    except Exception:
        pass
    try:
        import wrapped
        d = wrapped._compute(tenant)
        tiles = wrapped._tiles(tenant)
        rooms = wrapped._rooms(tenant, tiles, d.get("orbit") or [])
        if rooms and tiles:
            top3 = sum(len(r.get("items") or []) for r in rooms[:3])
            out["breadth"] = round(max(0.0, 1 - top3 / max(1, len(tiles))), 2)
    except Exception:
        pass
    try:
        cal = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
        evs = cal.get("events", [])
        names = {(ev.get("title") or "").lower() for ev in evs if "<>" in (ev.get("title") or "")}
        out["people_per_week"] = round(len(names) / max(1.0, 2 / 7), 2) if names else 0.0
        longs = 0
        for i, ev in enumerate(evs[:-1]):
            try:
                a = dt.datetime.fromisoformat(ev["start"].replace("Z", "+00:00"))
                b = dt.datetime.fromisoformat(evs[i + 1]["start"].replace("Z", "+00:00"))
                if (b - a).total_seconds() >= 5400:
                    longs += 1
            except Exception:
                continue
        out["deep_blocks_per_week"] = round(longs / max(1.0, 2 / 7), 2)
    except Exception:
        pass
    return {k: v for k, v in out.items() if v is not None}


FIRST_PERSON = re.compile(r"\b(i|i'm|i'd|i've|my|me|myself)\b", re.I)
ADMIRE_RE = re.compile(
    r"\b(want(?:s|ed)? to be (?:more )?like|admire|look up to|respect|impressed by|"
    r"standards? that|be more like|the way (?:he|she|they) |envious|goat|"
    r"aspire|role model|studying how|figure out how (?:he|she|they))\b", re.I)


def _admiration_lines(tenant: str) -> str:
    """Every line the MEMBER wrote that carries an admiration shape, oldest to newest.

    This organ decides who they are trying to become, so it is the one that must never read a
    stranger. It did: a 31,899-character article pasted on 8/24 filled the whole window and the
    portrait came back describing its author. Sourcing now runs through journal.member_material,
    which drops documents and trims every deposit so none can crowd out a season of real ones.

    Filter first, window second: admiration is said once a season, so the whole record is
    scanned and only the MATCHES are windowed. Windowing first buried the one real line."""
    import journal
    hits = [l for l in journal.member_material(tenant, limit=None) if ADMIRE_RE.search(l)]
    return "\n".join(hits[-120:])


# ---------------------------------------------------------------- the portrait

SOURCE_OVERLAP = 0.5         # a paraphrase keeps about half the words; below this it is invention


def _source_is_first_person(receipt: str, lines: str) -> bool:
    """Is the line this fragment came from the member speaking about themselves?

    EXACT QUOTATION WAS THE WRONG PROXY. The prompt asks for at most fifteen words, and the model
    compresses to fit: it returned "hold me to high standards that Naval would be impressed by"
    for a record that reads "hold me to high standards. The standards that Naval or Avi Kant
    would be impressed by". Demanding verbatim rejected every real admiration he has, which is
    how the portrait came back empty — strictly worse than the wrong one it replaced.

    The law was never about quotation. It is that the SOURCE must be the member speaking about
    themselves, so match the fragment to its most likely source line by word overlap and test
    authorship there. A fragment that overlaps no line is still refused: that is invention."""
    words = {w for w in re.split(r"[^a-z0-9']+", (receipt or "").lower()) if len(w) > 2}
    if not words:
        return False
    best, score = None, 0.0
    for line in (lines or "").split("\n"):
        lw = {w for w in re.split(r"[^a-z0-9']+", line.lower()) if len(w) > 2}
        if not lw:
            continue
        overlap = len(words & lw) / len(words)
        if overlap > score:
            best, score = line, overlap
    if best is None or score < SOURCE_OVERLAP:
        return False                          # drawn from nothing they wrote: invention
    return bool(FIRST_PERSON.search(best))


def build(tenant: str, force: bool = False) -> dict:
    """Admiration → qualities → traits bound to metrics → distances → the contradiction."""
    import llm
    st = load(tenant)
    if not force and st.get("refreshed"):
        age = (dt.date.today() - dt.date.fromisoformat(st["refreshed"])).days
        if age < REFRESH_DAYS:
            return st
    import entities
    mat = entities._material(tenant)
    if len(mat) < 400:
        return st
    # FORCE MEANS REBUILD (8/28). This started from the stored list and only ever APPENDED, so
    # `force=True` skipped the freshness check and kept every earlier entry regardless. The
    # portrait built while a 31,899-character pasted article dominated the window therefore
    # survived the corpus fix indefinitely: Dan Koe stayed in the founder's target self for
    # three days after the poison was removed, on a receipt that was the ARTICLE'S TITLE.
    admired = [] if force else (st.get("admired") or [])
    # Admiration is RARE and scattered across months, so a recent window misses it entirely
    # (the first build returned zero admired people from a corpus full of them). Prefilter the
    # WHOLE record by the shapes admiration takes, then let the model read only those lines.
    lines = _admiration_lines(tenant)
    got = llm.ask_json(llm.json_specs(), ADMIRE_SYS, lines[-16000:], max_tokens=900) or {}
    corpus = " ".join(lines.split()).lower()
    seen = {a["who"].lower() for a in admired}
    for a in (got.get("admired") or []):
        who, quality, receipt = (str(a.get(k) or "").strip() for k in ("who", "quality", "receipt"))
        # SOURCING AND ATTRIBUTION ARE SEPARATE LAWS, same as aims.py. Containment proves the
        # words are in the record; first person proves they are the MEMBER admiring somebody
        # rather than a headline they pasted. "How to fix your entire life in 1 day" is a title.
        #
        # The check runs on the SOURCE LINE, not the quoted fragment. The prompt asks for at most
        # fifteen words, so a true receipt is often a clause with no pronoun in it — "the
        # standards that Naval or Avi Kant would be impressed by" comes from "I need you to hold
        # me to high standards...". Testing the fragment rejected every real admiration he has.
        if receipt and not _source_is_first_person(receipt, lines):
            continue
        if who and quality and receipt and who.lower() not in seen:
            admired.append({"who": who[:60], "quality": quality[:120], "receipt": receipt[:120],
                            "when": dt.date.today().isoformat()})
            seen.add(who.lower())
    # A REFRESH THAT FINDS NOTHING MUST NOT ERASE WHAT EXISTS (8/28). The receipt the model
    # returns is a paraphrase and its overlap with the source line varies run to run, so a
    # rebuild can legitimately come back empty — and this used to SAVE that, replacing a correct
    # portrait with a blank one. Empty is strictly worse than stale.
    if not admired and (st.get("admired") or []):
        admired = st["admired"]
    admired = admired[-8:]

    want = ""
    try:
        import wrapped
        ins = wrapped._insight(tenant)
        want = " · ".join((ins.get("goals") or [])[:4]) + " · " + (wrapped.get_aim(tenant) or "")
    except Exception:
        pass
    allowed = "\n".join(f"  {k}: {v}" for k, v in METRICS.items())
    tr = llm.ask_json(llm.json_specs(), TRAITS_SYS,
                      f"ALLOWED METRICS:\n{allowed}\n\nQUALITIES THEY ADMIRE:\n"
                      + "\n".join(f"- {a['quality']} (in {a['who']})" for a in admired)
                      + f"\n\nWHAT THEY SAY THEY WANT:\n{want[:600]}", max_tokens=900) or {}
    traits = []
    for t in (tr.get("traits") or []):
        metric = str(t.get("metric") or "").strip()
        if metric not in METRICS:
            continue                                   # law 2: unscoreable never ships
        try:
            target = float(t.get("target"))
        except (TypeError, ValueError):
            continue
        traits.append({"trait": str(t.get("trait") or "")[:140], "metric": metric,
                       "target": target, "from": str(t.get("from") or "")[:100]})
    if not traits:
        return st                            # same law: keep the last good portrait, save nothing

    now = metrics(tenant)
    distances = []
    for t in traits:
        actual = now.get(t["metric"])
        if actual is None:
            continue
        span = max(abs(t["target"]), 0.01)
        distances.append({**t, "actual": actual,
                          "gap": round((t["target"] - actual) / span, 2)})
    distances.sort(key=lambda d: -d["gap"])

    con = llm.ask_json(llm.phrase_specs(), CONTRA_SYS,
                       "WHO THEY SAY THEY'RE BECOMING:\n"
                       + "\n".join(f"- {d['trait']} (aiming {d['target']} {d['metric']})" for d in distances)
                       + "\n\nWHAT NINETY DAYS SHOW:\n"
                       + "\n".join(f"- {k}: {v}" for k, v in now.items()), max_tokens=250) or {}
    line = str(con.get("line") or "").strip()
    try:
        import disposition
        line = disposition.sanitize(line)
        if disposition.violations(line, max_chars=320):
            line = ""
    except Exception:
        pass

    st = {"admired": admired, "traits": traits, "distances": distances, "metrics": now,
          "contradiction": {"is_contradiction": bool(con.get("contradiction")), "line": line,
                            "computed": dt.date.today().isoformat(),
                            "delivered": (st.get("contradiction") or {}).get("delivered", False)
                            if line == ((st.get("contradiction") or {}).get("line")) else False},
          "refreshed": dt.date.today().isoformat()}
    _save(tenant, st)
    return st


# ---------------------------------------------------------------- what other lanes consume

def gap(tenant: str) -> dict | None:
    """THE AIMING FUNCTION. The largest closable distance, for whoever is choosing what to
    hunt, propose, or ask next. Every lane that aims at 'their interests' should aim here."""
    st = load(tenant)
    for d in (st.get("distances") or []):
        if d.get("gap", 0) > 0.15:
            return d
    return None


def portrait_line(tenant: str) -> str:
    """One sentence of who they're becoming, for prompts that need the aim in context."""
    st = load(tenant)
    ts = [d["trait"] for d in (st.get("distances") or [])][:3]
    return "; ".join(ts)


def fresh_contradiction(tenant: str) -> str | None:
    """Rides the brief's lead, once, then never again unless the read itself changes."""
    st = load(tenant)
    c = st.get("contradiction") or {}
    if c.get("is_contradiction") and c.get("line") and not c.get("delivered"):
        c["pending"] = True
        _save(tenant, st)
        return c["line"]
    return None


def commit(tenant: str) -> int:
    st = load(tenant)
    c = st.get("contradiction") or {}
    if c.pop("pending", False):
        c["delivered"] = True
        _save(tenant, st)
        return 1
    return 0


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    if "--gap" in sys.argv:
        print(json.dumps(gap(t), indent=1))
        raise SystemExit
    st = build(t, force="--force" in sys.argv)
    print("ADMIRED")
    for a in st.get("admired", []):
        print(f"  {a['who'][:22]:22s} {a['quality'][:64]}")
    print("\nBECOMING")
    for d in st.get("distances", []):
        print(f"  {d['trait'][:60]:60s} target {d['target']:<6} actual {d['actual']:<6} gap {d['gap']}")
    print("\nCONTRADICTION")
    print(" ", (st.get("contradiction") or {}).get("line") or "(none)")
