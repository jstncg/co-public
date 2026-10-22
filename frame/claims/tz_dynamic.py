#!/usr/bin/env python3
"""Dynamic per-tenant timezone (7/2) — where they ARE, not where the config says.

Signals, strongest first: explicit natural language ("i'm in DC", "just landed in london", "set my
timezone to Tokyo") detected pre-reply in the router; fresh photo EXIF GPS (a photo taken in the last
~24h); else the configured tz (textcfg/callcfg); else LA. Stored per tenant in `<claims_db>.tz.json`
{"tz","source","set"} — read by the NOW block (engine), the phrase register, the daily-text window.
(Session boundaries are duration-based — a 4h gap is a 4h gap in any timezone — so they need no tz.)
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

DEFAULT_TZ = os.environ.get("CO_DEFAULT_TZ", "America/Los_Angeles")

# deterministic place → IANA (the common cases; unknown places fall to the LLM resolver)
PLACE_TZ = {
    "dc": "America/New_York", "washington": "America/New_York", "washington dc": "America/New_York",
    "nyc": "America/New_York", "new york": "America/New_York", "brooklyn": "America/New_York",
    "manhattan": "America/New_York", "boston": "America/New_York", "miami": "America/New_York",
    "atlanta": "America/New_York", "philly": "America/New_York", "philadelphia": "America/New_York",
    "chicago": "America/Chicago", "austin": "America/Chicago", "dallas": "America/Chicago",
    "houston": "America/Chicago", "nashville": "America/Chicago", "new orleans": "America/Chicago",
    "denver": "America/Denver", "salt lake": "America/Denver", "phoenix": "America/Phoenix",
    "la": "America/Los_Angeles", "los angeles": "America/Los_Angeles", "sf": "America/Los_Angeles",
    "san francisco": "America/Los_Angeles", "seattle": "America/Los_Angeles",
    "portland": "America/Los_Angeles", "san diego": "America/Los_Angeles", "vegas": "America/Los_Angeles",
    "honolulu": "Pacific/Honolulu", "hawaii": "Pacific/Honolulu",
    "london": "Europe/London", "paris": "Europe/Paris", "berlin": "Europe/Berlin",
    "amsterdam": "Europe/Amsterdam", "lisbon": "Europe/Lisbon", "madrid": "Europe/Madrid",
    "rome": "Europe/Rome", "dublin": "Europe/Dublin", "zurich": "Europe/Zurich",
    "tokyo": "Asia/Tokyo", "seoul": "Asia/Seoul", "singapore": "Asia/Singapore",
    "hong kong": "Asia/Hong_Kong", "bali": "Asia/Makassar", "bangkok": "Asia/Bangkok",
    "dubai": "Asia/Dubai", "mumbai": "Asia/Kolkata", "delhi": "Asia/Kolkata",
    "sydney": "Australia/Sydney", "melbourne": "Australia/Melbourne", "auckland": "Pacific/Auckland",
    "mexico city": "America/Mexico_City", "toronto": "America/Toronto", "vancouver": "America/Vancouver",
    "sao paulo": "America/Sao_Paulo", "buenos aires": "America/Argentina/Buenos_Aires",
}

# "i'm in X" family — the stoplist lives in the resolver (a table/LLM miss = no change)
PLACE_RE = re.compile(
    r"\b(?:i'?m in|just landed in|landed in|just got to|arrived in|back in|here in|touch(?:ed)? down in)"
    r"\s+([A-Za-z][A-Za-z .']{1,28}?)(?:\s+(?:this|for|until|till|next|rn|now|today|tonight|btw)\b|[,.!?]|$)",
    re.I)
SET_RE = re.compile(r"\bset (?:my )?time ?zone to\s+([A-Za-z_/ ]{2,40})", re.I)


def _path(claims_db: str) -> Path:
    return Path(f"{claims_db}.tz.json")


def get_tz(claims_db: str) -> str | None:
    try:
        p = _path(claims_db)
        if p.exists():
            tz = (json.loads(p.read_text()).get("tz") or "").strip()
            if tz:
                return tz
    except (json.JSONDecodeError, OSError):
        pass
    return None


def set_tz(claims_db: str, tz: str, source: str) -> None:
    from zoneinfo import ZoneInfo
    ZoneInfo(tz)                                             # validate or raise
    tmp = Path(f"{_path(claims_db)}.tmp")
    tmp.write_text(json.dumps({"tz": tz, "source": source[:120],
                               "set": dt.datetime.now().isoformat(timespec="seconds")}))
    os.replace(tmp, _path(claims_db))


def _llm_place_tz(place: str) -> str | None:
    """Unknown place → IANA tz via a one-line cheap call. 'NONE' (not a place) → None."""
    try:
        import llm
        # full flash, not lite: this path only fires on table misses (rare), and lite flubs geography
        out = llm.complete("google/gemini-2.5-flash",
                           "If the given text names a real city/region/country a person could be in, reply with "
                           "ONLY its IANA timezone id (e.g. Europe/London). Be precise about the actual place "
                           "named. If it is not a place, reply NONE.",
                           place, max_tokens=20)
        out = (out or "").strip()
        if out and out.upper() != "NONE" and "/" in out and " " not in out:
            from zoneinfo import ZoneInfo
            ZoneInfo(out)
            return out
    except Exception:
        pass
    return None


def detect(text: str) -> tuple | None:
    """(tz, source) if the message carries a location/timezone signal, else None. Table hit = instant;
    unknown phrases go to the LLM resolver, which also rejects non-places ('i'm in trouble')."""
    m = SET_RE.search(text or "")
    if m:
        cand = m.group(1).strip().replace(" ", "_")
        try:
            from zoneinfo import ZoneInfo
            ZoneInfo(cand)
            return cand, f"asked: {m.group(0)[:60]}"
        except Exception:
            got = _llm_place_tz(m.group(1))
            if got:
                return got, f"asked: {m.group(0)[:60]}"
    m = PLACE_RE.search(text or "")
    if m:
        place = m.group(1).strip().lower().rstrip(".")
        if place in PLACE_TZ:
            return PLACE_TZ[place], f"said: {m.group(0)[:60]}"
        got = _llm_place_tz(place)
        if got:
            return got, f"said: {m.group(0)[:60]}"
    return None


def update_from_text(claims_db: str, text: str) -> str | None:
    """Router pre-reply hook: cheap regex gate; writes the store on a resolved signal. Returns tz or None."""
    hit = detect(text)
    if not hit:
        return None
    tz, source = hit
    if get_tz(claims_db) != tz:
        try:
            set_tz(claims_db, tz, source)
            return tz
        except Exception:
            return None
    return tz


def now_in(claims_db: str, cfg_tz: str | None = None) -> dt.datetime:
    """Tenant-local now: dynamic store → configured → default."""
    from zoneinfo import ZoneInfo
    for tz in (get_tz(claims_db), cfg_tz, DEFAULT_TZ):
        if tz:
            try:
                return dt.datetime.now(ZoneInfo(tz))
            except Exception:
                continue
    return dt.datetime.now()


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--detect":
        print(detect(" ".join(sys.argv[2:])))
    elif len(sys.argv) > 1:
        print(get_tz(sys.argv[1]) or "(none)", "| now:", now_in(sys.argv[1]).isoformat())
