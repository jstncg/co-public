#!/usr/bin/env python3
"""Forensic shared cleaning library (WAVE 0 — every analyzer imports this).

The prospecting workflow found these are the load-bearing calibration fixes; without them the forensic
claims are quietly wrong:
  • TAPBACK filter — iMessage reactions ("Loved"/"Laughed at"/...) QUOTE the original message, so 2.5–10% of
    "sent" rows are someone ELSE'S words. Counting them inflates volume and misattributes content.
  • EXACT recipient match — to_person_ids must equal '[pid]', never LIKE '%pid%' (that leaked group chats
    into 1:1 counts — inflated a contact to 28k).
  • OBJECT-REPLACEMENT char (￼) — attachment placeholder; strip before any length/content measure.
  • STALE-WINDOW clamp — the export is ~7 weeks stale; clamp the analysis window and tag recency "as-of cutoff"
    so "gone quiet" isn't a data artifact.
Plus the HARD EXCLUSIONS the workflow flagged (encode as code, not judgment).
"""
import re

TAPBACK = re.compile(r"^(Loved|Liked|Laughed at|Emphasized|Reacted to|Questioned|Disliked|Removed (a|an))\b", re.I)
OBJREPL = "￼"
HANGUL = re.compile(r"[가-힣ᄀ-ᇿ㄰-㆏]")
ENDEARMENT = re.compile(r"\b(bub|bubs|bubu|babe|baby|my love|love (you|u)|luv u|honey|sweetie|sweetheart|darling|miss (you|u))\b", re.I)
SLANG = re.compile(r"\b(lol|lmao|lmfao|fr|ngl|tbh|bro|bruh|yo|nah|deadass|ngmi|wagmi|imo|idk|tryna|gonna|wanna|finna|af|lowkey|highkey)\b|💀|😭|🔥", re.I)
_BOT = re.compile(r"(mail delivery|subsystem|no-?reply|noreply|notification|do-?not-?reply|^\d{3,6}$|^\+?\d[\d ()-]{5,}$|dennis lee|^self$)", re.I)

# HARD EXCLUSIONS (workflow verdict): email+iMessage cannot reliably support these, and inferring them is the
# highest-harm false-positive class. Analyzers MUST NOT emit claims of these kinds.
EXCLUDED = "net worth / income / holdings / savings-rate; medical conditions / mental-health / meds / therapy / labs; job title or employment certainty (contact ≠ role)"


def is_tapback(body) -> bool:
    return bool(body) and bool(TAPBACK.match(body.strip()))


def clean(body) -> str:
    return (body or "").replace(OBJREPL, "").strip()


def is_bot(name) -> bool:
    return bool(_BOT.search((name or "").strip()))


def one_to_one(pid: int) -> str:
    """SQL value for an exact 1:1 recipient match: to_person_ids = one_to_one(pid). NEVER use LIKE."""
    return f"[{pid}]"


def effective_end(conn, channel="imessage"):
    """The real data end, clamped past the sparse stale tail (drop the top ~2% by date). Returns ISO string.
    Recency/trajectory windows anchor here, and recency claims are tagged 'as-of' this date."""
    import datetime as dt
    rows = [r[0] for r in conn.execute(
        f"SELECT ts FROM communications WHERE channel='{channel}' AND ts IS NOT NULL ORDER BY ts DESC LIMIT 20000").fetchall()]
    if not rows:
        return None
    # the 98th-percentile-from-top date: skip the thinned tail
    idx = min(len(rows) - 1, int(len(rows) * 0.02))
    try:
        return dt.datetime.fromisoformat(rows[idx]).date().isoformat()
    except (ValueError, TypeError):
        return rows[idx][:10]
