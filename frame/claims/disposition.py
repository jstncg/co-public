#!/usr/bin/env python3
"""The disposition's banned-patterns checker — ONE list, shared by the phrasers and the eval.

Everything Co sends out (the co_react line, the daily text, engine replies under eval) runs through
`violations(text)`. The eval (co_eval.py) greps with the same list, so "the prompt says don't" and "the
gate checks that it didn't" can never drift apart. Pure stdlib, no deps, importable from anywhere.
"""
import re

# ── the banned list (V1 spec + the 7/1 addenda) ────────────────────────────────────────────────────
EM_DASH = re.compile(r"[—–]|\s--\s")               # em/en-dash AND the ascii " -- " surrogate
BULLET = re.compile(r"(?m)^\s*([-*•]|\d+[.)])\s+\S")       # list markers = a memo, not a text
BOLD_HEADER = re.compile(r"(?m)\*\*.+?\*\*|^#{1,6}\s")     # markdown emphasis/headers

# The contrast-tic family (the AI tell): "it's not X, it's Y" / "isn't X, it's Y" / "you're not X, you're Y"
# / "less because X and more because Y". The you're-form was originally exempt as the hero move; revoked 7/2
# after live runs showed the template stamped into MOST replies once the it's-form was blocked. Say the Y.
NOT_X_BUT_Y = re.compile(
    r"\b(?:it'?s|that'?s|this is) not (?:a |an |the |about |just )?[^.!?\n]{1,48}?[,;.] (?:it'?s|that'?s|this is)\b"
    r"|\bisn'?t (?:really |actually |just |only )?(?:a |an |the |about )?[^.!?\n]{1,70}?[,;] (?:it'?s|that'?s)\b"
    r"|\bnot just (?:a |an |the )?\w[^.!?\n]{0,40}?\bbut\b"
    r"|\byou'?re not (?:a |an |the |just |actually |really |here )?[^.!?\n]{1,60}?[,;.] you'?re\b"
    r"|\byou aren'?t [^.!?\n]{1,60}?[,;.] you'?re\b"
    r"|\bless because [^.!?\n]{1,60}? (?:and )?more because\b", re.I)

BANNED_PHRASES = [
    "great question", "you're so right", "you are so right", "i'm here for you", "i am here for you",
    "let me know if", "how can i help", "what can i do for you", "is there anything else",
    "happy to help", "hope this helps", "i understand your frustration", "as an ai", "i'm just an ai",
    "here's the thing", "the real question is", "let me break this down", "my read:", "here's what i",
    "i'm here whenever", "always here", "here if you need",
]

# One emoji CLUSTER (base char + any ZWJ/variation-selector continuation, e.g. 😮‍💨) counts once.
_E = "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F0FF←-⇿❤]"
_EMOJI = re.compile(f"{_E}(?:[‍️]{_E}?)*")

THERAPY = re.compile(r"(?i)\b(hold space|sit with (that|this|it)|honor (your|that)|your feelings are valid|"
                     r"it'?s okay to feel|be gentle with yourself|self[- ]care|do some reflection)\b")

# MEMORY DENIAL — the worst sentence co can produce, because memory IS the product.
# 8/6, verbatim to the founder: "i don't have anything from before this session, no. each
# conversation starts fresh for me on that side." At that moment co held 29,452 claims and a
# full transcript. The recall lookup had been dropped by the latency guard, the model was
# handed silence, and it concluded — reasonably — that it was a stateless chatbot.
#
# This is the capability-denial class the canon already named (goal.md A5.1: "a denial of a
# capability it actually has ... enforce mechanically with a reply gate, not prompt prose
# alone"). That guard existed for links and never for memory. It does now.
MEMORY_DENIAL = re.compile(
    r"(?i)("
    r"start(s|ing)? (fresh|over|from scratch)|"
    r"(don'?t|do not|can'?t|cannot|won'?t) (have|retain|recall|remember|keep|access)[^.!?]{0,40}"
    r"(previous|prior|past|earlier|before|last) (conversation|session|chat|time)|"
    r"(no|not any|zero) (memory|record|history|context) (of|from|before)|"
    r"nothing from before|"
    r"each (conversation|session|chat) (is|starts)|"
    r"between (conversations|sessions)[^.!?]{0,20}(don'?t|do not|no)"
    r")")


# AI-tell vocabulary, the high-signal subset (jalaalrd/anti-ai-slop-writing, adjudicated
# 8/9 — sources: CMU 2025, Wikipedia's Signs of AI Writing). Long-form only: these words
# barely occur in texting register, but a morning read or muse expansion wearing "delve"
# or "testament to" is co sounding like the slop it exists to replace.
SLOP_WORDS = re.compile(
    r"\b(delv(e|es|ing)|tapestry|testament to|pivotal|crucial|intricate|meticulous(ly)?|"
    r"underscore[sd]?|multifaceted|foster(ing)?|leverag(e|ing)|utiliz(e|ing)|seamless(ly)?|"
    r"transformative|groundbreaking|game.chang(er|ing)|unprecedented|in essence|"
    r"in today's \w+ (world|landscape|era)|it'?s worth noting|at its core|"
    r"when it comes to|at the end of the day|in a nutshell)\b", re.I)


def slop_structure(text: str) -> list:
    """Structural AI tells, measurable and register-safe. Applied only to LONG outputs
    (the deliverables: morning reads, muse expansions, research digests) — short texting
    fragments are the genre and stay exempt. The two rhythm checks are the ones detection
    studies rank highest; word lists alone miss them."""
    v = []
    t = (text or "").strip()
    if len(t) < 250:
        return v
    m = SLOP_WORDS.search(t)
    if m:
        v.append(f"AI-tell vocabulary ({m.group(0)!r})")
    if len(t) < 400:            # rhythm checks need real length to mean anything
        return v
    # uniform sentence length: >=4 consecutive sentences inside a tight band reads as
    # machine cadence ("the single most measurable AI signal")
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", t) if len(s.strip()) > 8]
    if len(sents) >= 4:
        run = 1
        for a, b in zip(sents, sents[1:]):
            la, lb = len(a.split()), len(b.split())
            run = run + 1 if abs(la - lb) <= 2 else 1
            if run >= 4:
                v.append("uniform sentence cadence (4+ same-length sentences)")
                break
    # rule-of-three stacking: two or more "X, Y, and Z" triples in one piece
    triples = re.findall(r"\b\w[\w' -]{1,24}, \w[\w' -]{1,24},? and \w[\w' -]{1,24}\b", t)
    if len(triples) >= 2:
        v.append(f"rule-of-three stacking ({len(triples)} triples)")
    return v


# A COMPOSER THAT CANNOT COMPOSE RETURNS NOTHING (8/29). On 8/03 a real member received, as an
# unprompted message: "Not enough specific personal context to make a sharp, grounded addition
# that's actually about THEM." That is a model explaining its own abstain, and the caller shipped it
# because it treated any non-empty string as a message. Their next reply took 5h51m, the slowest of
# any proactive that week.
#
# Scoped to the PROACTIVE door on purpose. In conversation "i don't know" is legal and law 1 requires
# it. Unprompted, a message about co's own inability is never worth the interruption, because silence
# was sitting right there and costs nothing.
_REFUSAL = re.compile(
    r"^\s*(?:sorry[,.\s]*)?(?:i\s+)?(?:do\s?n[o']t|cannot|can[o']t|could\s?n[o']t)\s+"
    r"(?:have|find|see|make|offer|say|add)\b"
    r"|^\s*(?:there(?:'s| is)\s+)?not enough\b"
    r"|\bnot enough (?:specific |personal |real |grounded )*(?:context|material|signal|detail|information)\b"
    r"|\bto (?:make|offer|give) a (?:sharp|grounded|specific|useful|real)\b"
    r"|\bnothing (?:specific|grounded|true|useful|worth (?:saying|sending))\b"
    r"|\b(?:i|co) (?:have|has) (?:nothing|no) (?:to say|specific|useful)\b",
    re.I)


def refusal(text: str) -> str:
    """Is this an abstain wearing prose? Returns the matched shape, or "". Proactive path only."""
    m = _REFUSAL.search(text or "")
    return m.group(0).strip()[:60] if m else ""


def violations(text: str, *, max_chars: int = 450, max_questions: int = 1, max_emoji: int = 1) -> list:
    """All banned-pattern violations in one outbound message. Empty list = clean."""
    v = []
    t = text or ""
    if EM_DASH.search(t):
        v.append("em-dash/en-dash")
    if BULLET.search(t):
        v.append("bullet list")
    if BOLD_HEADER.search(t):
        v.append("bold/markdown header")
    m = NOT_X_BUT_Y.search(t)
    if m:
        v.append(f"'not X, it's Y' construction ({m.group(0)[:40]!r})")
    low = t.lower()
    for p in BANNED_PHRASES:
        if p in low:
            v.append(f"banned phrase {p!r}")
    if t.count("?") > max_questions:
        v.append(f"{t.count('?')} questions (max {max_questions})")
    n_emoji = len(_EMOJI.findall(t))
    if n_emoji > max_emoji:
        v.append(f"{n_emoji} emoji (max {max_emoji})")
    if THERAPY.search(t):
        v.append("therapy-speak")
    m = MEMORY_DENIAL.search(t)
    if m:
        # Never softened, never rate-limited: co denying it remembers is the product denying
        # itself. If the lookup genuinely failed, the honest line is "let me pull it up",
        # never "each conversation starts fresh".
        v.append(f"MEMORY DENIAL ({m.group(0)[:48]!r}) — co has history; say so or say you'll go get it")
    if len(t) > max_chars:
        v.append(f"{len(t)} chars (max {max_chars})")
    v.extend(slop_structure(t))
    return v


def clean(text: str, **kw) -> bool:
    return not violations(text, **kw)


_ORDERED = {
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
}


def dedash(text: str) -> str:
    """The dash half of the belt, for ONE bubble: NO dash of any kind ships (founder ruling 8/11 —
    the 8/7 range exception is retired). Ranges read aloud ("5 to 10"), compounds open up
    ("check in"), spaced dashes become the comma they were imitating. URLs, emails and handles
    are masked first so links survive. Split out from `sanitize` so surfaces that are NOT a text
    bubble can wear the dash rule without the closing-period rule; route whole replies through
    `sanitize`, which splits bubbles first."""
    urls: list[str] = []

    def _mask(m):
        urls.append(m.group(0))
        return f"\x00{len(urls) - 1}\x00"

    t = re.sub(r"\S*(?:://|www\.)\S*|\S+@\S+", _mask, text or "")
    # A RANGE IS DIGITS (8/29). This matched \w on both sides, so any dash sitting tight between two
    # WORDS was read as a range and spoken as "to": co shipped "Redemption crisis deepening to CVS
    # Lane and others now gating withdrawals" to the founder, which is not a sentence. A tight dash
    # between words is the comma it was imitating, and the rule below already turns it into one.
    t = re.sub(r"(?<=\d)[—–](?=\d)", " to ", t)          # a numeric range is spoken, not punctuated
    # A word range is a span between two members of an ordered set. "monday–friday" is one and
    # speaks its span; "deepening—CVS Lane" is not and is the comma it was imitating. Narrowing
    # this to digits alone on 8/29 fixed the second and broke the first.
    t = re.sub(r"\b([A-Za-z]+)[—–]([A-Za-z]+)\b",
               lambda m: f"{m.group(1)} to {m.group(2)}"
               if {m.group(1).lower(), m.group(2).lower()} <= _ORDERED
               else f"{m.group(1)}, {m.group(2)}", t)
    t = re.sub(r"\s*[—–]\s*", ", ", t)
    t = t.replace(" -- ", ", ").replace("**", "")
    t = re.sub(r"(?<=\d)\s*-\s*(?=\d)", " to ", t)       # 5-10 → 5 to 10
    t = re.sub(r"[ \t]+-[ \t]+", ", ", t)                # spaced hyphen was an em dash in disguise
    t = t.replace("-", " ")                              # compounds open: check-in → check in
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\x00(\d+)\x00", lambda m: urls[int(m.group(1))], t)
    return t.strip()


# The abbreviations that ARE their own period — cutting that one misspells the word rather than
# opening the beat. The chain covers initialisms (p.m., e.g., U.S.); the list covers the words a
# text actually lands on, which the chain misses because their letters aren't single (8/7 review:
# "etc." was shipping as "etc"). NOT "no." or "co." — those are a real answer and a real name.
_ABBREV_TAIL = re.compile(r"(?:\b[a-z]\.){2,}$"
                          r"|\b(?:etc|vs|inc|ltd|approx|dept|est|mr|mrs|ms|dr|jr|sr)\.$", re.I)


def _open_beat(bubble: str) -> str:
    """Drop the hard period ONE bubble ends on. `?` and `!` stay, and so does an ellipsis (a held
    beat, not a full stop); interior sentences keep their periods.

    The persona has asked for this since v1 ("Every final text bubble ends without a period") and the
    model dropped it whenever a reply ran long (founder, 8/7: co's texts read too serious). Prose
    asks; this enforces.
    """
    t = bubble.rstrip()
    if t.endswith(".") and not t.endswith("..") and not _ABBREV_TAIL.search(t):
        return t[:-1]
    return bubble


# The two tics that have to be prevented rather than repaired. `dedash` rewrites the first after the
# fact; nothing can rewrite the second, because turning "it's not X, it's Y" into a sentence that
# still means something is a rewrite, not a substitution. Prompts that generate copy the app shows
# paste this in so the model never makes either one. NOT_X_BUT_Y above is the matching detector.
VOICE_RULE = ("Never use an em-dash or en-dash. Never use the contrast frame "
              "(\"it's not X, it's Y\", \"not just X but Y\"): say the Y and stop.")


def sanitize(text: str) -> str:
    """The mechanical belt (mirror of the engine's) for anything co SAYS: fix the fixable before
    validating — dashes and markdown out, then the closing period off the last beat. Rhetorical bans
    stay validation-only.

    Runs per BUBBLE. A blank line is where one reply becomes two texts (brain.ts), and the belt moved
    upstream of that split when it moved to the reply's birth — so a dash sitting at the seam would
    have been eaten along with the blank line, silently merging two messages into one (8/7 review).
    """
    return "\n\n".join(_open_beat(dedash(b)) for b in (text or "").split("\n\n"))


if __name__ == "__main__":
    import sys
    t = " ".join(sys.argv[1:]) or sys.stdin.read()
    bad = violations(t)
    print("\n".join(f"✗ {b}" for b in bad) if bad else "clean")
    sys.exit(1 if bad else 0)
