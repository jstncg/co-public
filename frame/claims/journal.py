#!/usr/bin/env python3
"""The journal — the simplest version of the product (daily question + low-friction capture).

A different TYPE of question each day. You answer or you don't. Random thoughts welcome anytime. It mostly just
HOLDS what you say (a light ack, sometimes nothing) and reflects ONLY when it actually sees something true —
the abstain discipline as a feature: silence over a forced reply, a real read over chatter. Answers accumulate
into your compiled list (your Saga); the per-tenant transcript feeds journal_ingest so the graph deepens; the
reflection fires on what you've actually told it. Not multi-turn, not needy.

Channel-agnostic: the iMessage router calls on_message(tenant, text); a daily job calls send_daily_question().

  doppler run -- /…/python3 journal.py --question dennis        # show today's question for a tenant
  doppler run -- /…/python3 journal.py --reflect dennis         # force a reflection attempt (the read)
"""
import asyncio
import json
import os
import random
import re
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

JOURNAL_DIR = os.path.expanduser("~/.co/journal")
os.makedirs(JOURNAL_DIR, exist_ok=True)
CLAIMS_DIR = str(Path(__file__).resolve().parent)

# A different TYPE each day. The question is the agenda (kills the dead-conversation problem) and the prompt
# (kills the blank page). Deeper than BeReal, never a chore, never therapy-homework.
QUESTION_BANK = {
    "current": [
        "what's been quietly taking up space in your head lately?",
        "what's the thing you keep meaning to deal with and keep not?",
        "how are you actually doing — not the version you'd tell most people.",
    ],
    "reflective": [
        "what's something you changed your mind about this year?",
        "what did you used to want that you don't anymore?",
        "what's a belief you hold that you mostly inherited rather than chose?",
    ],
    "values": [
        "what's something you'd never compromise on, even when it costs you?",
        "what do you respect in people that you wish you had more of?",
        "what's a line you've drawn that you're glad you drew?",
    ],
    "memory": [
        "what's a small moment from this year you keep coming back to?",
        "when did you last feel completely like yourself?",
        "what's a thing someone said to you once that still lives in your head?",
    ],
    "relational": [
        "who'd you think about today that you didn't reach out to?",
        "who's been on your mind, and what's stopping you from saying so?",
        "who in your life actually gets the real you?",
    ],
    "aspiration": [
        "what's something you want that you've never said out loud?",
        "if the next year went unreasonably well, what happened?",
        "what would you try if you knew no one would find out you tried?",
    ],
    "fork": [
        "what's the thing everyone assumes you'll do — and the one you actually think about?",
        "what's the safe path you're on, and the one you keep glancing at?",
    ],
    "playful": [
        "what's a weirdly specific thing that makes you irrationally happy?",
        "what's the most 'you' thing you did this week?",
        "what's a tiny opinion you'd defend to the death?",
    ],
    "challenge": [
        "what have you been avoiding, and what's the real reason?",
        "where are you choosing comfortable over right, right now?",
    ],
}
TYPES = list(QUESTION_BANK.keys())
REFLECT_EVERY = 5     # only ATTEMPT a reflection once every N captures — calm, not needy
ACKS = ["mm. noted.", "got it.", "okay, that's a good one.", "i hear you.", "logged. 🤍", "yeah. okay."]


# ----------------------------- per-tenant store (the compiled list = the Saga) ----------------------------
def _store_path(tenant: str) -> str:
    return os.path.join(JOURNAL_DIR, f"{tenant}.json")


def _load(tenant: str) -> dict:
    p = _store_path(tenant)
    if os.path.exists(p):
        try:
            return json.loads(open(p).read())
        except (json.JSONDecodeError, OSError):
            pass
    return {"entries": [], "asked": [], "since_reflect": 0}


def _save(tenant: str, st: dict) -> None:
    tmp = _store_path(tenant) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, _store_path(tenant))


def provision(tenant: str) -> bool:
    """Create the journal if absent — wrapped.tenant_for_slug resolves worlds by its presence."""
    if os.path.exists(_store_path(tenant)):
        return False
    os.makedirs(JOURNAL_DIR, exist_ok=True)
    _save(tenant, _load(tenant))
    return True


def _claims_db(tenant: str) -> str:
    return os.path.join(CLAIMS_DIR, "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")


def _transcript_path(tenant: str) -> str:
    # The format journal_ingest reads (per-tenant), so answers deepen the graph the reflection fires on.
    return _claims_db(tenant) + ".transcript.json"


# ── THE MEMBER'S OWN WORDS (8/25) ─────────────────────────────────────────────
# Founder law: nothing that is not a co iMessage interaction may corrupt the model of the
# member. Two halves, because one is not enough. SOURCE: co's own documents and anything
# fetched off the web are not the member. AUTHORSHIP: a pasted article arrived over iMessage
# and is still not their words — sending a thing is an act, its body is not a statement.
#
# The failure this fixes was not a junk ratio, it was CROWDING. Miners read the last ~18k
# characters; one 31,899-character article pasted yesterday filled that entire window, so the
# organ that decides who the member wants to become read a stranger's blog post and answered
# with the stranger. Hence PER_ITEM: no single deposit may outweigh a season of real ones.

# PER_ITEM was 1200 with the comment "this member writes long and means it" — a number tuned to
# one person. Someone who texts in fragments would have had a cap forty times their median, and
# someone who writes essays would have been clipped mid-thought. It adapts now: a generous
# multiple of THEIR OWN median, inside fixed bounds so neither extreme can break the window.
PER_ITEM_MIN, PER_ITEM_MAX, PER_ITEM_DEFAULT = 400, 2000, 1200
DOC_CHARS = 4000        # past this it is a document someone wrote, not a message they sent


def per_item(tenant: str) -> int:
    """A cap set by how this member actually writes, not by how the founder does."""
    try:
        lens = sorted(len((e.get("text") or "")) for e in (_load(tenant).get("entries") or []))
        if len(lens) < 20:
            return PER_ITEM_DEFAULT
        med = lens[len(lens) // 2]
        return max(PER_ITEM_MIN, min(PER_ITEM_MAX, int(med * 2.5)))
    except Exception:
        return PER_ITEM_DEFAULT

_NOT_MEMBER = (
    re.compile(r"^\s*#{1,3}\s", re.M),                 # co's own briefs and specs
    re.compile(r"^\s*\(from our conversations\)"),     # co's digests, quoted back
    re.compile(r"See new posts|^Conversation\s*$|Show (?:more|this) (?:replies|thread)", re.M),
    re.compile(r"^\s*Article\s*$", re.M),              # pasted reader-view chrome
)


# co narrates what it sees INSIDE the member's own deposit: "[screenshot/image they sent: a
# black-and-white portrait of a man...]". The deposit is theirs, the narration is co's, and
# leaving it in is how a television anchor's face in a screenshot became a watched entity.
# Strip the narration, keep the deposit — dropping the whole item would lose the act of sending.
_MARK = (r"they sent|screenshot|image shows|this image|video clip|this video|post includes|"
         r"the (?:image|photo|screenshot)|shared:|tweet @|transcript:")
_ANNOTATION = (
    # bracket form, the common one. Parens nest inside it ("[photo they sent (taken sat...)]"),
    # so only nested BRACKETS are excluded, never parens.
    re.compile(rf"\[[^\[\]]{{0,4000}}?(?:{_MARK})[^\[\]]{{0,4000}}?\]", re.I | re.S),
    re.compile(rf"\([^()]{{0,4000}}?(?:{_MARK})[^()]{{0,4000}}?\)", re.I | re.S),
)


def scrub_annotations(text: str) -> str:
    """Remove co's own descriptions from otherwise member-authored text."""
    t = text or ""
    for p in _ANNOTATION:
        t = p.sub(" ", t)
    return re.sub(r"[ \t]{2,}", " ", t).strip()


def is_member_authored(text: str) -> bool:
    """False for anything the member did not type: co's documents, fetched pages, and the
    article chrome that comes with a paste. Cheap and conservative on purpose — a wrongly
    kept document poisons every read, a wrongly dropped message costs one data point."""
    t = (text or "").strip()
    if not t or len(t) > DOC_CHARS:
        return False
    return not any(p.search(t) for p in _NOT_MEMBER)


_ARTIFACT = re.compile(r"\[(photo|screenshot|image|video|clip|voice note|shared)[^\]]{0,400}\]", re.I)


def deposits(tenant: str, limit: int | None = None) -> list[dict]:
    """WHAT THEY SENT, as co's OBSERVATION — never as their words (8/28).

    scrub_annotations strips co's narration so a caption can never be mistaken for a statement,
    and that is right. But an entry that is ONLY a photo has nothing left after scrubbing, so
    the act vanishes too: co lost every trace that he sent a picture of a book in July.

    Both facts are true and they belong in different tiers. "He sent a photo of The Mind Is Flat
    on 14 July" is an observation co may recall. "He read it and believes X" is a claim it may
    never make. This returns the first kind, labelled, so retrieval can ask about the thing he
    actually sent instead of about a book he has never heard of."""
    out = []
    try:
        for e in (_load(tenant).get("entries") or []):
            raw = (e.get("text") or "").strip()
            m = _ARTIFACT.search(raw)
            if not m:
                continue
            out.append({"date": (e.get("date") or "")[:10],
                        "kind": m.group(1).lower(),
                        "observed": " ".join(m.group(0).strip("[]").split())[:220],
                        "said": scrub_annotations(raw)[:200]})
    except Exception:
        pass
    return out if limit is None else out[-limit:]


def member_material(tenant: str, limit: int | None = 140) -> list[str]:
    """THE one door every organ that models the member reads from. Their iMessage turns and
    their own captures, each trimmed so no deposit can crowd out the rest, oldest to newest.

    limit=None returns the WHOLE record. Organs looking for something rare (who they admire is
    said once a season, not weekly) must filter first and window second — windowing first hid
    the founder's only real admiration line behind four hundred newer messages."""
    out = []
    cap = per_item(tenant)
    try:
        for e in (_load(tenant).get("entries") or []):
            t = scrub_annotations(e.get("text") or "")
            if is_member_authored(t):
                out.append(t[:cap])
    except Exception:
        pass
    try:
        for m in json.load(open(_transcript_path(tenant))):
            if m.get("role") != "user":
                continue                                # co's own replies are never evidence
            t = scrub_annotations(m.get("content") or "")
            if is_member_authored(t):
                out.append(t[:cap])
    except Exception:
        pass
    return out if limit is None else out[-limit:]


def _feed_ingest(tenant: str, text: str) -> None:
    """Append the captured text as a user turn to the per-tenant transcript (journal_ingest extracts later)."""
    p = _transcript_path(tenant)
    try:
        msgs = json.loads(open(p).read()) if os.path.exists(p) else []
    except (json.JSONDecodeError, OSError):
        msgs = []
    msgs.append({"role": "user", "content": text, "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(msgs[-200:], f, ensure_ascii=False)
    os.replace(tmp, p)


# ----------------------------- the daily question ---------------------------------------------------------
def daily_question(tenant: str, day_index: int | None = None) -> str:
    st = _load(tenant)
    if day_index is None:
        day_index = len(st.get("asked", []))
    qtype = TYPES[day_index % len(TYPES)]            # rotate the TYPE each day
    asked = set(st.get("asked", []))
    pool = [q for q in QUESTION_BANK[qtype] if q not in asked] or QUESTION_BANK[qtype]
    # deterministic-ish pick within type, avoiding recent repeats
    q = pool[day_index % len(pool)]
    st.setdefault("asked", []).append(q)
    _save(tenant, st)
    return q


# ----------------------------- capture ------------------------------------------------------------------
def prior_send(tenant: str, text: str):
    """Did they send this exact link before? Returns (date, days_ago) or None.
    The cheapest proof of memory in the system: no model call, no embedding — a re-send is
    also the strongest interest signal a person emits without meaning to."""
    import re as _re
    urls = _re.findall(r"https?://[^\s]+", text or "")
    if not urls:
        return None
    def _key(u):
        u = u.split("?")[0].rstrip("/")
        m = _re.search(r"(?:youtu\.be/|[?&]v=|/shorts/|/reel/|/p/|/status/)([A-Za-z0-9_-]{6,})", u)
        return m.group(1) if m else u
    keys = {_key(u) for u in urls}
    try:
        st = _load(tenant)
    except Exception:
        return None
    import datetime as _dt
    for e in (st.get("entries") or [])[:-1]:
        for u in _re.findall(r"https?://[^\s]+", e.get("text") or ""):
            if _key(u) in keys:
                d = e.get("date") or ""
                try:
                    ago = (_dt.date.today() - _dt.date.fromisoformat(d)).days
                except ValueError:
                    ago = 0
                return (d, ago)
    return None


def capture(tenant: str, text: str, in_reply_to: str | None = None, on_defer=None,
            feed_transcript: bool = True) -> str | None:
    """Store the entry (the Saga), feed ingest, and return the link enrichment (if any) so the caller can
    reuse it (e.g. co_react relating the SEND to the model-of-you) without re-reading the link.
    on_defer threads through to read_links: a video past the threshold is registered for a background
    watch instead of muting the sender's thread for minutes (deferred_watch.py).
    feed_transcript=False for SYSTEM captures (canon digests): they belong in the journal corpus for
    recall, NEVER in the conversation record — 8/4 live defect: digests masqueraded as user turns,
    flooded the history window, and the engine answered the digests instead of the person."""
    link = None
    try:
        import link_read
        link = link_read.read_links(text, on_defer=on_defer)   # long video → deferred, placeholder returned
    except Exception:
        link = None
    st = _load(tenant)
    entry = {"ts": int(time.time()), "date": date.today().isoformat(), "q": in_reply_to, "text": text}
    if link:
        entry["link"] = link[:1500]          # full read goes to the caller/reply; the corpus keeps the gist
    st.setdefault("entries", []).append(entry)
    st["since_reflect"] = st.get("since_reflect", 0) + 1
    _save(tenant, st)
    if feed_transcript:
        _feed_ingest(tenant, text + (f"\n{link}" if link else ""))
    return link


# ----------------------------- the reflection (abstain-gated read) ----------------------------------------
REFLECT_SYS = """You are someone's journal that actually listens. Below are things this person has told you over
time. Find ONE specific, true, non-obvious thing to reflect back — a pattern or connection across what they
ACTUALLY said that they might not have noticed themselves. The kind of line that makes someone go quiet because
it's right. Warm, on their side, held lightly as a guess.

HARD RULES:
- Ground it ONLY in what they told you. No generic horoscope ("you're a deep thinker"), no advice, no therapy
  jargon, no flattery. Specific or nothing.
- If there is NOT yet a specific, true, non-obvious read — if you'd be reaching — return null. Silence is the
  right answer more often than not. A forced reflection is worse than none.
Return ONLY JSON: {"reflection": "<one or two sentences>"} or {"reflection": null}"""


def _recent_entries(tenant: str, n: int = 25) -> list:
    return [e for e in _load(tenant).get("entries", []) if e.get("text")][-n:]


async def reflect(tenant: str) -> str | None:
    entries = _recent_entries(tenant)
    if len(entries) < 3:
        return None     # too early — stay quiet, let it accumulate
    corpus = "\n".join(f"- ({e.get('q') or 'thought'}) {e['text']}" + (f" {e['link']}" if e.get('link') else "")
                       for e in entries)
    try:
        from anthro import make_client
        client = make_client()
        r = await client.messages.create(model="claude-haiku-4-5", system=REFLECT_SYS, max_tokens=220,
                                          messages=[{"role": "user", "content": f"THINGS THEY'VE TOLD YOU:\n{corpus}"}])
        m = re.search(r"\{.*\}", "".join(b.text for b in r.content if b.type == "text"), re.S)
        ref = (json.loads(m.group(0)).get("reflection") if m else None)
    except Exception as e:
        print(f"  (reflect error: {e})", file=sys.stderr)
        return None
    if not ref or not str(ref).strip() or str(ref).strip().lower() == "null":
        return None
    return str(ref).strip()


# ----------------------------- the one entry point the channel calls --------------------------------------
def on_message(tenant: str, text: str, in_reply_to: str | None = None) -> str | None:
    """Capture every message. Mostly hold it (a light ack, sometimes nothing). Reflect ONLY when there's a
    real read and the calm cadence allows. Returns the reply text, or None to stay silent."""
    capture(tenant, text, in_reply_to)
    st = _load(tenant)
    if st.get("since_reflect", 0) >= REFLECT_EVERY:
        ref = asyncio.run(reflect(tenant))
        if ref:
            st["since_reflect"] = 0
            _save(tenant, st)
            return ref
    # not reflecting this turn: a light ack, or (sometimes) nothing at all — calm, not needy.
    return None if random.random() < 0.25 else random.choice(ACKS)


def send_daily_question(tenant: str, to_number: str) -> bool:
    """The daily ritual: pick today's question and send it via Sendblue. Cron this once/day per tester."""
    import requests
    q = daily_question(tenant)
    import rail
    ok, why = rail.send(to_number, q)
    print(f"  {'✅ sent todays question to ' + to_number + ': ' + q if ok else '⚠️ held: ' + why}")
    return ok


def main():
    a = sys.argv[1:]
    if "--question" in a:
        print(daily_question(a[a.index("--question") + 1]))
    elif "--reflect" in a:
        print(asyncio.run(reflect(a[a.index("--reflect") + 1])) or "(stayed quiet — no specific true read yet)")
    elif "--send-daily" in a:
        i = a.index("--send-daily")
        send_daily_question(a[i + 1], a[i + 2])
    else:
        print("usage: journal.py --question <tenant> | --reflect <tenant> | --send-daily <tenant> <number>")


if __name__ == "__main__":
    main()
