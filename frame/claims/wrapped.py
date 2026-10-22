#!/usr/bin/env python3
"""The wrapped artifact — "a link they can click and see the trends of what they're sending."

Agreed v1 (Dennis x Justin, 7/30 call): a consolidated place that shows a person their own
stream — timeline, platforms, themes, what co is watching for them. Served by the router at
GET /w/<slug> through the public funnel; co texts the link when asked ("show me my wrapped").

Design laws:
  - THRESHOLD-TRIGGERED, not calendar-triggered: Justin assumes churn in 2-3 days, so a
    weekly wrapped misses the churn window. The page exists from the ~10th capture and the
    link can land day one. (The weekly ritual can ride the reconciler later if it earns it.)
  - Offline-safe: the page always renders from pure computation. The one model touch is the
    ORBIT (theme names) — cached 24h, keyword fallback when the model is unreachable, never
    blocking the page render beyond its own call.
  - Self-contained HTML: inline CSS, phone-first (it opens from iMessage), dark-mode aware.
  - The slug is HMAC(tenant), unguessable and stable — the page shows THEIR data only.

    python3 wrapped.py [tenant]        # generate + print path and public URL
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import date as dt_date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The dash half of the outbound belt, on co-authored card prose too (founder, 8/7: no em-dashes in
# the feed bullets either). `dedash`, not `sanitize`: a card is not a text bubble, so it keeps the
# period the closing-period rule takes off a message.
from disposition import VOICE_RULE, dedash  # noqa: E402  (needs the sys.path line above)
import rail  # noqa: E402

CACHE_DIR = os.path.expanduser("~/.co/wrapped")
CACHE_TTL = 600
_PLATFORMS = [("instagram", re.compile(r"instagram\.com", re.I)),
              ("youtube", re.compile(r"youtu\.?be", re.I)),
              ("tiktok", re.compile(r"tiktok\.com", re.I)),
              ("x", re.compile(r"(twitter|x)\.com", re.I))]
_STOP = set("""the a an and or but of to in on for with at by from is are was were be been it its this
that these those i im me my you your he she they them we us our what which who when where how why not
no yes so just like really very actually kind sort thing things stuff also there here have has had do
does did done can could would should will going gonna want wanna got get lol yeah okay ok oh out up
about into over after before more most some any all one two if then than as sent shared screenshot
image shows video clip photo theyre dont its thats https http instagram youtube tiktok twitter com
person people background play button text white black red blue wearing visible screen shot logo
speaking camera video watch reel post tweet page profile shirt features caption title says appears
looking standing sitting holding left right top bottom overlay onscreen frame thumbnail on-screen
icon slide reads read other need time know knows showing description shown username handle likes
comments followers interface app displays display date words line something someone make way good
first last next new well much many made give go see say said see-through""".split())


def slug(tenant: str) -> str:
    # One secret shared with the edge (8/10 ruling) — the old "co" fallback made every world
    # URL computable from a phone number, so no key means no slugs.
    key = os.environ.get("CO_RAIL_SLUG_SECRET") or os.environ.get("WEBHOOK_TOKEN")
    if not key:
        raise RuntimeError("CO_RAIL_SLUG_SECRET unset — refusing to mint world slugs")
    return hmac.new(key.encode(), f"wrapped:{tenant}".encode(), hashlib.sha256).hexdigest()[:20]


def tenant_for_slug(s: str) -> str | None:
    d = os.path.expanduser("~/.co/journal")
    try:
        for fn in os.listdir(d):
            if fn.endswith(".json"):
                t = fn[:-5]
                if hmac.compare_digest(slug(t), s):
                    return t
    except OSError:
        pass
    return None


def public_url(tenant: str) -> str:
    base = (os.environ.get("WEBHOOK_PUBLIC_URL") or "").split("/hook")[0].rstrip("/")
    return f"{base}/w/{slug(tenant)}" if base else f"/w/{slug(tenant)}"


def _entries(tenant: str) -> list:
    try:
        j = json.load(open(os.path.expanduser(f"~/.co/journal/{tenant}.json")))
        return j.get("entries") or []
    except (OSError, json.JSONDecodeError):
        return []


def _sys_entry(text: str) -> bool:
    """Internal bookkeeping that landed in the journal (canon-ingest digests, watch notes) —
    real memory, wrong for VISUAL surfaces: the world shows THEIR world, never co's plumbing
    (my-world law, call-003). Recall and the orbit still read the full journal."""
    return (text or "").lstrip().startswith("(from our conversations)")


def _db_rows(tenant: str, sql: str) -> list:
    import sqlite3
    db = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
    if not os.path.exists(db):
        return []
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        rows = c.execute(sql).fetchall()
        c.close()
        return rows
    except Exception:
        return []


def _tiles(tenant: str, limit: int = 120) -> list:
    """EVERYTHING they've sent, as tiles (8/1: "not just the pictures but everything"). A link
    with a cached thumbnail becomes an image tile; a thought, a voice note, or a photo whose
    source has expired becomes a TYPOGRAPHIC tile — the words are the picture. A world holds
    all of it or it isn't their world."""
    import thumbs
    out, seen = [], set()
    for e in reversed(_entries(tenant)):
        if len(out) >= limit:
            break
        txt = (e.get("text") or "").strip()
        if _sys_entry(txt):
            continue
        read = (e.get("link") or "")[9:400].strip("[] ")
        date = e.get("date", "")
        urls = [u.rstrip(".,)") for u in re.findall(r"https?://[^\s\]]+", txt)]
        imgs = [m for m in re.findall(r"\[img:([0-9a-f]{6,16})\]", txt)]
        note = re.sub(r"https?://\S+", "", re.sub(r"\[[^\]]*\]", "", txt)).strip()
        placed = False
        for u in urls:                                     # links with a face
            if u in seen:
                continue
            seen.add(u)
            if not thumbs.cached(u):
                continue
            host = re.sub(r"https?://(www\.)?([^/]+).*", r"\2", u)
            kind = ("youtube" if "youtu" in host else "instagram" if "instagram" in host
                    else "x" if host in ("x.com", "twitter.com") else host.split(".")[0])
            out.append({"url": u, "key": thumbs.key_for(u), "kind": kind, "date": date, "ts": _iso_ts(e),
                        "note": (note or read)[:110], "desc": f"{note} {read}".strip()[:260]})
            placed = True
        for k in imgs:                                     # what THEY photographed (kept at capture)
            if k in seen:
                continue
            seen.add(k)
            out.append({"url": "", "key": k, "kind": "yours", "date": date, "ts": _iso_ts(e),
                        "note": (note or read)[:110], "desc": f"{note} {read}".strip()[:260]})
            placed = True
        if placed or not (note or read):
            continue
        body = note or read                                 # a thought / voice note / expired photo
        kind = ("voice" if "voice note" in txt else "photo" if ("photo they sent" in txt or
                "screenshot/image" in txt) else "thought")
        out.append({"url": urls[0] if urls else "", "key": "", "kind": kind, "date": date, "ts": _iso_ts(e),
                    "note": body[:180], "desc": f"{note} {read}".strip()[:260]})
    return out


TODAY_SYS = """You are co, and this is the person's day. Write their prep, the message a
teammate who is genuinely on their side sends first thing. You have their real state below;
use ONLY it. Never invent a meeting, a deadline, or a feeling they didn't show you.

Return ONLY JSON:
{"read": "<one sentence on where they actually are right now, earned from what they sent,
not a horoscope. If last night's stream says something (they were up late, deep in one thing,
scattered across five), say it plainly and warmly.>",
 "one_thing": "<THE one thing worth doing today, specific enough to start in the next hour.
Pull it from their goals/moves/aim/open episode. Never invent a task.>",
 "setup": ["<2-3 concrete setup notes: what to do first, what to protect, what to skip today.
Short. Practical. Their vocabulary.>"],
 "then": "<one short line about what today makes possible if it goes well. No hype, no
'crush it', no motivational poster.>"}

Voice: a sharp friend texting, lowercase-leaning, no corporate speak, no bullet-point
lecture, never 'let's dive in'. On their side always, which means honest, not flattering.
""" + VOICE_RULE


def _left_today() -> str:
    """tiimo's honest time — the day says how much of itself is left, never nags."""
    import datetime as dt
    now = dt.datetime.now()
    mins = (24 * 60) - (now.hour * 60 + now.minute)
    if mins <= 0:
        return ""
    h, m = divmod(mins, 60)
    return f"{h}h {m}m left of today" if h else f"{m}m left of today"


def _today(tenant: str, block: bool = False) -> dict:
    """The daily prep — co inside the world, setting them up. Cached per DAY, non-blocking
    (a cache miss renders nothing and computes in the background; tomorrow's is ready when
    they open it). Every input is real state; the model only phrases."""
    cp = os.path.join(CACHE_DIR, f"{tenant}.today.json")
    today_s = time.strftime("%Y-%m-%d")
    try:
        c = json.load(open(cp))
        if c.get("date") == today_s and c.get("one_thing"):
            return c
    except (OSError, json.JSONDecodeError):
        pass
    if not block:
        import threading
        if not _REFRESHING.get(f"t:{tenant}"):
            _REFRESHING[f"t:{tenant}"] = True

            def _bg():
                try:
                    _today(tenant, block=True)
                finally:
                    _REFRESHING.pop(f"t:{tenant}", None)
            threading.Thread(target=_bg, daemon=True).start()
        return {}
    try:
        import asyncio
        import episode_engine as ee
        ins = _insight(tenant, block=True)
        nw = _now(tenant)
        es = _entries(tenant)[-18:]
        # No entries and no goals corners the model into a day-long cached horoscope (8/10) —
        # an empty day is honest.
        if not es and not (ins.get("goals") or []):
            return {}
        recent = "\n".join(
            f"- ({e2.get('date','')}) " + re.sub(r"\s+", " ", ((e2.get("text") or "")[:110] + " "
            + (e2.get("link") or "")[:110])).strip() for e2 in es)
        state = []
        for r in nw.get("live", []) + nw.get("waiting", []):
            state.append(f"- {r['t']}: {r['s']}")   # no dash even in the INPUT: it teaches the tic
        aim = get_aim(tenant)
        got = asyncio.run(ee._ask(
            TODAY_SYS,
            f"TODAY IS {time.strftime('%A, %B %-d')}.\n"
            + (f"WHAT THEY SAID THEY'RE FIGURING OUT: {aim}\n" if aim else "")
            + f"THEIR GOALS:\n" + "\n".join(f"- {g}" for g in ins.get("goals") or []) + "\n"
            + "THE MOVES CO ALREADY DRAFTED:\n" + "\n".join(
                f"- {pl['goal']}: {pl['move']} (watch for: {pl['watch_for']})"
                for pl in (ins.get("plan") or [])) + "\n"
            + "LIVE STATE:\n" + "\n".join(state) + "\n"
            + f"RISING: {', '.join(nw.get('rising') or [])} · COOLING: {', '.join(nw.get('cooling') or [])}\n"
            + f"THE LAST THINGS THEY SENT:\n{recent}",
            ee.MODEL, max_tokens=700)) or {}
        # The belt goes on HERE, where the day is written, not at the app's serializer: the page
        # renders this same dict, and every field wears the rule rather than the two somebody
        # remembered to wrap by hand. Cached already clean, so it survives a restart.
        out = {"date": today_s, "read": dedash(str(got.get("read") or "")[:300]),
               "one_thing": dedash(str(got.get("one_thing") or "")[:220]),
               "setup": [dedash(str(x)[:140]) for x in (got.get("setup") or [])][:3],
               "then": dedash(str(got.get("then") or "")[:180])}
        if out["one_thing"]:
            os.makedirs(CACHE_DIR, exist_ok=True)
            json.dump(out, open(cp, "w"))
        return out
    except Exception:
        return {}


def done_path(tenant: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, f"{tenant}.done.json")


def get_done(tenant: str) -> bool:
    try:
        d = json.load(open(done_path(tenant)))
        return d.get("date") == time.strftime("%Y-%m-%d") and bool(d.get("done"))
    except (OSError, json.JSONDecodeError):
        return False


def set_done(tenant: str, done: bool = True) -> None:
    """They marked the day's one thing. The night follow-up reads this, so co can ask about
    the thing they actually did instead of guessing."""
    json.dump({"date": time.strftime("%Y-%m-%d"), "done": bool(done), "ts": time.time()},
              open(done_path(tenant), "w"))


def _serendipity(tenant: str, tiles: list) -> dict:
    """mymind keeps a whole tab for it: something from your own mind, surfaced unbidden. It is
    THE RETURN made voluntary — you pull the lever instead of waiting to be interrupted. Rotates
    daily, deterministic (the date is the seed, so it's the same all day, new tomorrow)."""
    if not tiles:
        return {}
    import hashlib as _h
    seed = int(_h.sha1((tenant + time.strftime("%Y-%m-%d")).encode()).hexdigest()[:8], 16)
    old = [t for t in tiles if t.get("date") and t["date"] < time.strftime("%Y-%m-%d")]
    pool = old or tiles
    return pool[seed % len(pool)]


def _year_dots(tenant: str) -> list:
    """one year's move: the year as dots, days you paid attention filled. Ambient, no chrome,
    no gamification — just the texture of a year of noticing."""
    import datetime as dt
    from collections import Counter
    days = Counter(e.get("date") for e in _entries(tenant) if e.get("date"))
    today = dt.date.today()
    start = dt.date(today.year, 1, 1)
    return [days.get((start + dt.timedelta(days=i)).isoformat(), 0)
            for i in range((today - start).days + 1)]


def _now(tenant: str) -> dict:
    """THE STATE — what a world has that an album doesn't (8/1: "this looks more like a photo
    album"). An album is artifacts, past tense, organized. A world is NOW: things in motion,
    what changed since you looked, what's waiting on you, what's rising and what's going cold.
    All deterministic — this block must never be a model's opinion."""
    import datetime as dt
    import sqlite3
    st = {"live": [], "waiting": [], "since": [], "rising": [], "cooling": [], "last": None}
    db = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
    # what co is doing right now
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        w = c.execute("SELECT what FROM watches WHERE status='active'").fetchall()
        if w:
            st["live"].append({"i": "eye", "t": f"watching {len(w)} things for you",
                               "s": " · ".join(x[0][:34] for x in w[:3])})
        ep = c.execute("SELECT what, state FROM episodes WHERE state IN ('proposed','approved') "
                       "ORDER BY id DESC LIMIT 1").fetchone()
        if ep:
            st["waiting"].append({"i": "bolt", "t": "waiting on your yes" if ep[1] == "proposed" else "on it now",
                                  "s": ep[0][:90]})
        c.close()
    except Exception:
        pass
    try:                                             # promises with a date attached
        import anchors
        a = anchors._load(db)
        soon = []
        for x in a.get("anchors", []):
            if x.get("fired"):
                continue
            try:
                when = dt.datetime.fromisoformat(x.get("fire") or x.get("when"))
            except (ValueError, TypeError):
                continue
            days = (when.date() - dt.date.today()).days
            if 0 <= days <= 10:
                soon.append((days, x.get("what", "")[:70]))
        for days, what in sorted(soon)[:2]:
            when_s = "today" if days == 0 else "tomorrow" if days == 1 else f"in {days} days"
            st["live"].append({"i": "clock", "t": what, "s": f"lands {when_s}"})
    except Exception:
        pass
    try:                                             # a long watch in flight right now
        import json as _j
        recs = [_j.loads(l) for l in open(os.path.expanduser(f"~/.co/deferred_watch/{tenant}.jsonl")) if l.strip()]
        pend = [r for r in recs if r.get("state") == "pending"]
        if pend:
            st["live"].append({"i": "play", "t": f"watching a {pend[-1].get('minutes','long')}-minute video",
                               "s": "the read lands in your thread"})
    except Exception:
        pass
    # what changed since they last opened their world
    vp = os.path.join(CACHE_DIR, f"{tenant}.visit.json")
    last = None
    try:
        last = json.load(open(vp)).get("ts")
    except (OSError, json.JSONDecodeError):
        pass
    es = _entries(tenant)
    if last:
        new = [e for e in es if (e.get("ts") or 0) > last]
        if new:
            st["since"].append(f"{len(new)} new since you last looked")
        st["last"] = last
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        json.dump({"ts": time.time()}, open(vp, "w"))
    except OSError:
        pass
    # the current: what's rising, what's gone quiet (7 days vs the 21 before it)
    import datetime as _dt
    today = _dt.date.today()
    def bucket(lo, hi):
        out = []
        for e in es:
            try:
                d = _dt.date.fromisoformat(e.get("date", ""))
            except ValueError:
                continue
            if lo <= (today - d).days < hi:
                out.append(((e.get("text") or "") + " " + (e.get("link") or "")).lower())
        return " ".join(out)
    recent, prior = bucket(0, 7), bucket(7, 28)
    try:
        cp = os.path.join(CACHE_DIR, f"{tenant}.themes.json")
        themes = json.load(open(cp)).get("themes") or []
    except (OSError, json.JSONDecodeError):
        themes = []
    for th in themes:
        toks = [w for w in re.findall(r"[a-z]{4,}", th.lower())][:2]
        if not toks:
            continue
        r = sum(recent.count(t) for t in toks)
        p2 = sum(prior.count(t) for t in toks) / 3.0
        if r >= 2 and r > p2 * 1.5:
            st["rising"].append(th)
        elif p2 >= 1.5 and r == 0:
            st["cooling"].append(th)
    st["rising"], st["cooling"] = st["rising"][:3], st["cooling"][:3]
    return st


def _rooms(tenant: str, tiles: list, orbit: list) -> list:
    """A WORLD HAS ROOMS (mobbin study, 8/1: Pinterest/Are.na/AllTrails all make the named
    collection the unit, not the item — and each board is also a standing query that keeps
    filling itself). co's advantage: nobody has to file anything. The orbit already names the
    rooms; this assigns each captured thing to one. Cached against the tile set."""
    if not tiles or not orbit:
        return []
    sig = hashlib.sha1(("v2|" + "|".join(t["key"] for t in tiles[:60]) + "|" + "|".join(orbit)).encode()).hexdigest()[:12]
    cp = os.path.join(CACHE_DIR, f"{tenant}.rooms.json")
    try:
        c = json.load(open(cp))
        if c.get("sig") == sig:
            return c["rooms"]
    except (OSError, json.JSONDecodeError):
        pass
    try:
        import asyncio
        import episode_engine as ee
        listing = "\n".join(f"{i}. [{t['kind']}] {t.get('desc') or t['note']}" for i, t in enumerate(tiles))
        got = asyncio.run(ee._ask(
            "Each numbered item is something one person saved. Put each into exactly one of THEIR "
            "themes (or omit it if it fits none). For each theme also write a WHISPER: one short, "
            "concrete first-move line grounded in what they actually saved (their vocabulary, no "
            "self-help scent, under 12 words: 'price the sauna kit from that reel', not 'pursue "
            "your dreams'). Return ONLY JSON: {\"rooms\": [{\"theme\": "
            "\"<theme, copied verbatim from the list>\", \"items\": [<numbers>], \"whisper\": \"...\"}]}. "
            "Place as MANY items as you honestly can, most things belong somewhere. Every theme "
            "holding 2+ items must appear. It is fine for a room to hold 15. " + VOICE_RULE,
            f"THEIR THEMES:\n" + "\n".join(f"- {o}" for o in orbit) + f"\n\nWHAT THEY SAVED:\n{listing[:7000]}",
            ee.JUDGE_MODEL, max_tokens=1200)) or {}
        rooms = []
        for r in (got.get("rooms") or []):
            idxs = [int(i) for i in (r.get("items") or []) if isinstance(i, (int, str)) and str(i).isdigit()]
            idxs = [i for i in idxs if 0 <= i < len(tiles)][:24]
            if r.get("theme") and len(idxs) >= 2:
                # Named and whispered by a model, so both wear the dash rule at birth — the page
                # and the app read this same cache and neither may ship the tic.
                rooms.append({"theme": dedash(str(r["theme"])[:40]), "items": idxs,
                              "whisper": dedash(str(r.get("whisper") or "")[:90])})
        rooms.sort(key=lambda r: -len(r["items"]))
        rooms = rooms[:8]
        if rooms:
            os.makedirs(CACHE_DIR, exist_ok=True)
            json.dump({"sig": sig, "rooms": rooms}, open(cp, "w"))
        return rooms
    except Exception:
        return []


def _compute(tenant: str) -> dict:
    es = _entries(tenant)
    days = Counter(e["date"] for e in es if e.get("date"))
    weeks: Counter = Counter()
    for d, n in days.items():
        try:
            wk = datetime.strptime(d, "%Y-%m-%d")
            weeks[(wk - timedelta(days=wk.weekday())).strftime("%b %d")] += n
        except ValueError:
            pass
    plat = Counter()
    for e in es:
        t = (e.get("text") or "")
        for name, rx in _PLATFORMS:
            if rx.search(t):
                plat[name] += 1
                break
        else:
            plat["thoughts" if "http" not in t else "links"] += 1
    words = Counter()
    for e in es:
        raw = (e.get("text") or "") + " " + (e.get("link") or "")
        raw = re.sub(r"https?://\S+", " ", raw)                  # URLs are plumbing, not themes
        raw = re.sub(r"\[(screenshot/image|photo|clip|voice note)[^:\]]*:", " ", raw)
        for w in re.findall(r"[a-zA-Z][a-zA-Z'-]{3,}", raw.lower()):
            if w.replace("'", "") not in _STOP:
                words[w] += 1
    orbit_kw = [w for w, _ in words.most_common(10)]
    orbit = _themes(tenant, es) or orbit_kw
    finds = [e for e in es if e.get("link")][-4:]
    # ASKED watches only on user-facing surfaces (8/5). Six of ten actives were SCOUT
    # inventions shown beside real requests with no distinction, so "watching 9 things"
    # listed commitments the person never made. co's own ideas are offers, not promises.
    watches = _db_rows(tenant, "SELECT what, status FROM watches WHERE status='active' AND COALESCE(origin,'asked')='asked' LIMIT 6")
    # The app's chip renders co's STATE, not the member's instruction played back
    # (teardown 8/7: "a watch that never shows its current reading is indistinguishable
    # from a watch that isn't running") — label + since + last_checked + a short reading.
    watch_rows = _db_rows(tenant, "SELECT what, created_at, last_checked, last_state FROM watches "
                                  "WHERE status='active' AND COALESCE(origin,'asked')='asked' LIMIT 6")
    episodes = _db_rows(tenant, "SELECT what, state FROM episodes ORDER BY id DESC LIMIT 4")
    span = (es[0]["date"], es[-1]["date"]) if es else ("", "")
    return {"n": len(es), "span": span, "weeks": weeks, "plat": plat,
            "orbit": orbit, "finds": finds,
            "watches": watches, "watch_rows": watch_rows, "episodes": episodes,
            "active_days": len(days), "peak": days.most_common(1)[0] if days else ("", 0)}


def _themes(tenant: str, es: list) -> list:
    """The orbit, named by a model in THEIR vocabulary — cached 24h; None on any failure
    (the keyword fallback renders instead). One haiku call per tenant per day, worst case."""
    cp = os.path.join(CACHE_DIR, f"{tenant}.themes.json")
    try:
        c = json.load(open(cp))
        if time.time() - c.get("ts", 0) < 86400 and c.get("themes"):
            return c["themes"]
    except (OSError, json.JSONDecodeError):
        pass
    try:
        import asyncio
        import episode_engine as ee
        lines = []
        for e2 in es[-150:]:
            t2 = re.sub(r"https?://\S+", "", (e2.get("text") or ""))[:80].strip()
            l2 = (e2.get("link") or "")[:120]
            if t2 or l2:
                lines.append(f"- {t2} {l2}")
        got = asyncio.run(ee._ask(
            "This is one person's capture stream — links, thoughts, videos they sent their co. "
            "Name the 6-8 themes they keep circling, 1-3 words each, THEIR vocabulary (specific: "
            "'RL training', 'car design' — never 'technology', 'content'). "
            'Return ONLY JSON: {"themes": ["..."]}',
            "\n".join(lines)[:9000], ee.JUDGE_MODEL, max_tokens=200)) or {}
        th = [str(x)[:28] for x in (got.get("themes") or [])][:8]
        if th:
            os.makedirs(CACHE_DIR, exist_ok=True)
            json.dump({"ts": time.time(), "themes": th}, open(cp, "w"))
            return th
    except Exception:
        pass
    return None


def _insight(tenant: str, block: bool = False) -> dict:
    """Goals + patterns-they-might-not-see, one model call, cached 24h. NON-BLOCKING by default
    (7/31: a fresh tenant's first app.json hung 30-60s on this): cache miss returns empty NOW and
    computes on a background thread — the next fetch is rich. block=True for CLI/tests."""
    cp = os.path.join(CACHE_DIR, f"{tenant}.insight.json")
    try:
        c = json.load(open(cp))
        if time.time() - c.get("ts", 0) < 86400:
            return c
    except (OSError, json.JSONDecodeError):
        pass
    if not block:
        import threading
        if not _REFRESHING.get(f"i:{tenant}"):
            _REFRESHING[f"i:{tenant}"] = True

            def _bg():
                try:
                    _insight(tenant, block=True)
                finally:
                    _REFRESHING.pop(f"i:{tenant}", None)
            threading.Thread(target=_bg, daemon=True).start()
        return {"ts": 0, "goals": [], "patterns": [], "plan": []}
    out = {"ts": time.time(), "goals": [], "patterns": [], "plan": []}
    try:
        import asyncio
        import episode_engine as ee
        es = _entries(tenant)[-150:]
        lines = []
        for e2 in es:
            t2 = re.sub(r"https?://\S+", "", (e2.get("text") or ""))[:100].strip()
            l2 = (e2.get("link") or "")[:100]
            if t2 or l2:
                lines.append(f"- ({e2.get('date','')}) {t2} {l2}")
        claims = _db_rows(tenant, "SELECT statement FROM claims WHERE COALESCE(status,'active')='active' "
                                  "ORDER BY salience DESC LIMIT 30")
        got = asyncio.run(ee._ask(
            "This is one person's capture stream and what their co believes about them. Extract:\n"
            '1. "goals": 2-4 things they are ACTUALLY building toward — stated or strongly implied, '
            "their vocabulary, aspirational register (\"starting the fund\" not \"career development\").\n"
            '2. "patterns": 1-3 true observations they might not have noticed about themselves. '
            "Each is an OBJECT: {\"read\": \"<the observation, specific and warm — the feeling to "
            "hit is SEEN, never analyzed>\", \"receipts\": [<the 1-4 DATES from the stream below "
            "that this stands on, exactly as shown>], \"alternative\": \"<one other honest reading "
            "of the same evidence>\"}. A read with no receipts is forbidden. "
            "ABSTAIN via empty lists when the data is thin — a wrong guess is worse than none.\n"
            '3. "plan": for each goal, ONE concrete physical next move (doable this week, specific) '
            "and one emotional watch-for (the pattern that usually stops them). Same abstain law.\n"
            'Return ONLY JSON: {"goals": ["..."], "patterns": ["..."], '
            '"plan": [{"goal": "...", "move": "...", "watch_for": "..."}]}',
            "WHAT THEY'VE SENT:\n" + "\n".join(lines)[:8000] +
            "\n\nWHAT CO BELIEVES:\n" + "\n".join(r[0] for r in claims)[:2000],
            ee.MODEL, max_tokens=1800)) or {}
        out["goals"] = [str(x)[:90] for x in (got.get("goals") or [])][:4]
        pats = []
        for x in (got.get("patterns") or [])[:3]:
            if isinstance(x, dict) and x.get("read") and (x.get("receipts") or []):
                pats.append({"read": str(x["read"])[:200],
                             "receipts": [str(r)[:20] for r in (x.get("receipts") or [])][:4],
                             "alternative": str(x.get("alternative") or "")[:160]})
        out["patterns"] = [p2 for p2 in pats if p2["read"] not in _killed(tenant)]
        out["plan"] = [{"goal": str(pl.get("goal") or "")[:90], "move": str(pl.get("move") or "")[:140],
                        "watch_for": str(pl.get("watch_for") or "")[:140]}
                       for pl in (got.get("plan") or [])][:4]
        if out["goals"] or out["patterns"] or out["plan"]:
            os.makedirs(CACHE_DIR, exist_ok=True)     # an all-empty result is a FAILED call, never
            json.dump(out, open(cp, "w"))              # cached — retry next render instead of 24h of blank
    except Exception:
        pass
    return out


_REFRESHING: dict = {}


def _killed(tenant: str) -> set:
    """Reads the user marked WRONG — never rendered again (the verdict loop's teeth)."""
    out = set()
    try:
        with open(os.path.expanduser(f"~/.co/app_verdicts/{tenant}.jsonl")) as f:
            for line in f:
                try:
                    v = json.loads(line)
                except ValueError:
                    continue
                if v.get("verdict") == "wrong" and v.get("read"):
                    out.add(str(v["read"])[:200])
    except OSError:
        pass
    return out


def aim_path(tenant: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, f"{tenant}.aim.json")


def get_aim(tenant: str) -> str:
    """What they said they're figuring out TODAY — expires with the day."""
    try:
        a = json.load(open(aim_path(tenant)))
        if a.get("date") == time.strftime("%Y-%m-%d"):
            return str(a.get("text") or "")[:200]
    except (OSError, json.JSONDecodeError):
        pass
    return ""


def set_aim(tenant: str, text: str) -> None:
    """Setting the aim re-aims TODAY's finds immediately (the cache dies with it)."""
    json.dump({"date": time.strftime("%Y-%m-%d"), "text": str(text)[:200]}, open(aim_path(tenant), "w"))
    try:
        os.remove(os.path.join(CACHE_DIR, f"{tenant}.finds.json"))
    except OSError:
        pass


def _watch_chips(d: dict) -> list:
    """Structured watch chips: co's state, not the member's sentence. label + note
    ("since jul 28 · checked 2h ago · <reading>"). Falls back to label-only rows."""
    import datetime as _dt
    out = []
    for row in (d.get("watch_rows") or []):
        what, created, checked, state = (list(row) + [None] * 4)[:4]
        bits = []
        try:
            if created:
                c = _dt.datetime.fromisoformat(str(created).replace("Z", "+00:00"))
                bits.append(f"since {c.strftime('%b %-d').lower()}")
            if checked:
                k = _dt.datetime.fromisoformat(str(checked).replace("Z", "+00:00"))
                h = max(0, int((_dt.datetime.now(_dt.timezone.utc) - k).total_seconds() // 3600))
                bits.append("checked just now" if h == 0 else
                            f"checked {h}h ago" if h < 48 else f"checked {h // 24}d ago")
        except Exception:
            pass
        if state:
            # the reading, shortest useful slice — a number if one exists
            m = re.search(r"\$[\d,]+(?:\.\d+)?", str(state))
            bits.append(m.group(0) if m else str(state)[:40].strip())
        out.append({"label": _watch_label(what or ""), "note": " · ".join(bits)})
    if not out:  # older payload shape (no watch_rows) — labels only
        out = [{"label": _watch_label(w), "note": ""} for w, _ in d.get("watches") or []]
    return out


def _watch_label(w: str) -> str:
    """A watch renders as a CHIP, so the label is the topic, not the member's command
    back at them ("keep an eye on the sony a7 iv price, tell me when it d…" → "sony a7
    iv price"). Strip the ask-verbs and the tell-me clause; keep the thing watched."""
    s = re.sub(r"^(?:please\s+)?(?:keep an eye on|keep watching|keep track of|watch(?: for)?|"
               r"track|monitor|follow)\s+(?:the\s+)?", "", (w or "").strip(), flags=re.I)
    s = re.split(r"[,;]?\s*(?:and\s+)?(?:tell|let|ping|text|alert|notify)\s+me\b", s, 1,
                 flags=re.I)[0]
    return (s.strip(" ,.;") or w or "").strip()[:60]


def _catchworthy(kind: str, clean: str, url, thumb) -> bool:
    """An entry earns an archive card iff it is an artifact: a link, an image, a voice
    note, or a text with enough body to be a thought (not an utterance). The floor is
    deliberately crude — the honest fix is capture-vs-chat provenance at ingest — but it
    kills the worst failure: the archive echoing the member's own chat lines back."""
    if url or thumb or kind == "voice":
        return True
    body = (clean or "").strip()
    return len(body) >= 80 and not body.endswith("?")


def _url_alive(url: str) -> bool:
    """HEAD-check a find before it reaches the feed — a dead link is worse than no card."""
    try:
        import requests
        r = requests.head(url, timeout=6, allow_redirects=True,
                          headers={"User-Agent": "Mozilla/5.0 (co-radar)"})
        if r.status_code in (405, 403):  # hosts that reject HEAD get one GET
            r = requests.get(url, timeout=6, stream=True,
                             headers={"User-Agent": "Mozilla/5.0 (co-radar)"})
        return r.status_code < 400
    except Exception:
        return False


def _finds(tenant: str, goals: list, orbit: list, block: bool = False) -> list:
    """3-4 pieces of content aimed at THEIR goals — the aspirational feed's first breath.
    web_search-backed, cached 24h, silently absent on failure (the page never breaks)."""
    cp = os.path.join(CACHE_DIR, f"{tenant}.finds.json")
    aim = get_aim(tenant)
    try:
        c = json.load(open(cp))
        if time.time() - c.get("ts", 0) < 86400 and c.get("finds") and c.get("aim", "") == aim:
            # Belted on the way OUT, not only on the way in: a find cached before the rule existed
            # would otherwise keep its em-dash for another 24h.
            return [{**f, "why": dedash(f.get("why") or "")} for f in c["finds"]]
    except (OSError, json.JSONDecodeError):
        pass
    if not goals and not orbit:
        return []
    if not block:
        import threading
        if not _REFRESHING.get(f"f:{tenant}"):
            _REFRESHING[f"f:{tenant}"] = True

            def _bg():
                try:
                    _finds(tenant, goals, orbit, block=True)
                finally:
                    _REFRESHING.pop(f"f:{tenant}", None)
            threading.Thread(target=_bg, daemon=True).start()
        return []
    try:
        import asyncio
        import episode_engine as ee
        sys_prompt = (
            "Find 3-4 SPECIFIC pieces of content (a talk, an essay, an interview, a thread) this "
            "person would genuinely value. MIX LAW: at most half may serve their goals/aim; the "
            "rest is pure curiosity from their orbit, the thing they'd click at 11pm, no lesson "
            "attached. A feed that is all growth is predictable and dead (founder, 8/1). "
            "RECENCY LAW: every find comes FROM your web_search results, never from memory. "
            "what you remember without searching is stale by definition. Prefer this month over "
            "this year; a 2024 resource list is a failure. For each: a title, the url, and one "
            'short clause on why it\'s for THEM (their vocabulary, no self-help scent). '
            + VOICE_RULE + ' Return ONLY JSON: '
            '{"finds": [{"title": "...", "url": "...", "why": "..."}]}')
        user_prompt = ((f"WHAT THEY ARE FIGURING OUT TODAY (aim everything at this): {aim}\n" if aim else "")
                       + f"THEIR GOALS: {'; '.join(goals)}\nTHEIR ORBIT: {', '.join(orbit)}")
        tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 4}]
        got, searched = asyncio.run(ee._ask(sys_prompt, user_prompt, ee.MODEL, max_tokens=700,
                                            tools=tools, return_trace=True))
        if got and not searched:  # a search costume over training memory — one retry, then absent
            got, searched = asyncio.run(ee._ask(
                "You did not search. " + sys_prompt, user_prompt, ee.MODEL, max_tokens=700,
                tools=tools, return_trace=True))
        if not searched:
            return []
        got = got or {}
        finds = [{"title": str(f.get("title") or "")[:90], "url": str(f.get("url") or "")[:300],
                  "why": dedash(str(f.get("why") or "")[:120])} for f in (got.get("finds") or [])[:4]
                 if f.get("url")]
        finds = [f for f in finds if _url_alive(f["url"])]
        # image-forward, same as catches: fetch a thumb per find (we're already in the
        # background refresh here) so the app's radar tiles carry the artifact's face
        # instead of a wash (founder, 8/7: thumbnails)
        for f in finds:
            try:
                import thumbs as _th
                if _th.fetch(f["url"]):
                    f["thumb"] = _th.key_for(f["url"])
            except Exception:
                pass
        if finds:
            os.makedirs(CACHE_DIR, exist_ok=True)
            json.dump({"ts": time.time(), "finds": finds, "aim": aim}, open(cp, "w"))
        return finds
    except Exception:
        return []


def _unesc(s: str) -> str:
    """Historical captures were HTML-escaped 1-2 deep at ingest; unescape to fixpoint so
    display-time escaping is the only escaping."""
    s = s or ""
    for _ in range(3):
        u = html.unescape(s)
        if u == s:
            break
        s = u
    return s



# ---------------- THE PAGE (8/24 redesign: one surface, liquid glass on warm paper) ----------------
# No tabs. Three strata — needs you / on your behalf / the record — under one statement,
# over one ambient field, with one command dock. CSS is a plain string: no brace-doubling.
PAGE_CSS = """
:root{
  --bg:#eef0ef; --ink:#14171c; --dim:#7d858f; --accent:#b8561f; --go:#2f7150;
  /* glass: a real material, not a grey fill. It needs a field behind it to refract. */
  --card:rgba(255,255,255,.55); --card-2:rgba(255,255,255,.74);
  --rim:rgba(255,255,255,.9); --rim-2:rgba(255,255,255,.55);
  --hair:rgba(20,23,28,.09); --shade:rgba(22,32,52,.10);
  --f1:#cfd9cc; --f2:#e6d7c6; --f3:#c9d4e2; --f4:#e3d3d8; --f5:#dfe0cd;
  /* one metrically matched superfamily, optical sizes built in, zero bytes, never flashes */
  --serif:ui-serif,"New York","Iowan Old Style",Palatino,Georgia,serif;
  --ui:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
  --disp:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,monospace;
  --w-body:400; --w-strong:600; --track:0;      /* dark mode drops a step: halation */
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#0f1113; --ink:#eef1f4; --dim:#7e8791; --accent:#e0894f; --go:#6fbd94;
    --card:rgba(38,44,54,.58); --card-2:rgba(46,53,64,.76);
    --rim:rgba(255,255,255,.15); --rim-2:rgba(255,255,255,.08);
    --hair:rgba(255,255,255,.09); --shade:rgba(0,0,0,.45);
    --f1:#2c3a33; --f2:#3a3128; --f3:#26313f; --f4:#382b31; --f5:#333527;
    --w-body:380; --w-strong:530; --track:.008em; }
}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:var(--bg)}
body{font:var(--w-body) 13.5px/1.5 var(--ui);color:var(--ink);background:transparent;
  letter-spacing:var(--track);
  padding:0 clamp(18px,5vw,64px) calc(112px + env(safe-area-inset-bottom));
  -webkit-font-smoothing:antialiased;overflow-x:hidden;position:relative}
/* the field the glass refracts — many-hued and muted, never a two-stop tech gradient */
body::before{content:"";position:fixed;inset:-25%;z-index:-1;pointer-events:none;
  background:
    radial-gradient(38% 30% at 14% 12%,var(--f1) 0%,transparent 62%),
    radial-gradient(34% 28% at 82% 8%,var(--f2) 0%,transparent 60%),
    radial-gradient(42% 34% at 68% 52%,var(--f3) 0%,transparent 62%),
    radial-gradient(30% 26% at 20% 62%,var(--f4) 0%,transparent 60%),
    radial-gradient(36% 30% at 50% 92%,var(--f5) 0%,transparent 62%);
  filter:blur(8px);opacity:.85}
.num,.card .v,.wc i{font-variant-numeric:tabular-nums}
.nav{max-width:1080px;margin:0 auto;padding:calc(24px + env(safe-area-inset-top)) 0 0;
  display:flex;align-items:center;gap:26px}
.mark{font-family:var(--serif);font-style:italic;font-size:21px;cursor:pointer}
/* the mode switch is chrome, so it floats and blurs instead of sitting in the layout */
.modes{position:fixed;left:50%;transform:translateX(-50%);
  bottom:calc(18px + env(safe-area-inset-bottom));z-index:40;display:flex;gap:3px;padding:5px;
  border-radius:999px;font-size:12.5px;color:var(--dim);
  background:var(--card);-webkit-backdrop-filter:blur(26px) saturate(180%);
  backdrop-filter:blur(26px) saturate(180%);border:1px solid var(--rim-2);
  box-shadow:inset 0 1px 0 var(--rim),0 10px 34px var(--shade)}
.modes b,.modes span{cursor:pointer;padding:7px 15px;border-radius:999px;font-weight:var(--w-body);
  color:var(--dim);white-space:nowrap;transition:color .15s,background .15s}
.modes b{color:var(--ink);font-weight:var(--w-strong);background:var(--card-2);
  box-shadow:inset 0 1px 0 var(--rim)}
.shelfline{max-width:1080px;margin:52px auto 24px;font-family:var(--serif);
  font-size:clamp(21px,3vw,27px);font-weight:400;letter-spacing:-.012em;line-height:1.28;
  max-width:min(1080px,34ch)}
/* Cosmos grid discipline: tight gutters, imagery carries the wall, tiles wear no chrome */
.grid{max-width:1080px;margin:0 auto;column-count:3;column-gap:10px}
@media(max-width:900px){.grid{column-count:2;column-gap:8px}}
.p{break-inside:avoid;margin-bottom:10px}
/* the front is co's reads, not the wall: fewer columns, real air, cards meant to be read */
.grid.lead{column-count:2;column-gap:16px;margin-top:6px}
.grid.lead .p{margin-bottom:16px}
@media(max-width:760px){.grid.lead{column-count:1}}
/* archive is a real destination but the least important one: last, dimmer, set apart */
.modes .arch{margin-left:6px;padding-left:13px;color:color-mix(in srgb,var(--dim) 75%,transparent);
  border-left:1px solid var(--hair);border-radius:0 999px 999px 0}
.modes .arch:hover{color:var(--ink)}
/* the front is co's reads, not the wall: fewer columns, real air, cards can be read */
.grid.lead{column-count:2;column-gap:16px;margin-top:6px}
.grid.lead .p{margin-bottom:16px}
@media(max-width:760px){.grid.lead{column-count:1}}
.p .im{width:100%;border-radius:9px;display:block;background-size:cover;background-position:center;
  background-color:color-mix(in srgb,var(--ink) 6%,transparent)}
.p a{color:inherit;text-decoration:none}
.p .cap{font-size:11px;color:var(--dim);margin-top:7px;letter-spacing:.012em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card{background:var(--card);border-radius:20px;padding:22px 20px;
  -webkit-backdrop-filter:blur(26px) saturate(180%);
  backdrop-filter:blur(26px) saturate(180%);border:1px solid var(--rim-2);
  box-shadow:inset 0 1px 0 var(--rim),0 10px 30px var(--shade)}
.card .k{font-size:10px;font-weight:var(--w-strong);letter-spacing:.15em;text-transform:uppercase;
  color:var(--dim);margin-bottom:11px}
.card .k.hot{color:var(--accent)}
.card .t{font-size:15px;font-weight:500;line-height:1.45;letter-spacing:-.01em}
.card .s{font-size:12px;color:var(--dim);margin-top:5px}
.card .b{display:inline-block;margin:15px 8px 0 0;font-size:11.5px;font-weight:590;
  letter-spacing:.012em;cursor:pointer;background:var(--card-2);color:var(--accent);
  border:1px solid var(--rim-2);border-radius:999px;padding:8px 16px;
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  box-shadow:inset 0 1px 0 var(--rim);transition:transform .15s}
.card .b:active{transform:scale(.95)}
.card .b.q{background:color-mix(in srgb,var(--ink) 7%,transparent);color:var(--ink)}
.tick .s{color:var(--go);font-weight:500}
.readcard{font-family:var(--serif);font-style:italic;font-size:16.5px;line-height:1.55;font-weight:400}
.readcard .t{font-family:var(--serif);font-size:16.5px;font-weight:400}
details.fold summary{list-style:none;cursor:pointer;font-size:11.5px;font-weight:600;color:var(--dim);margin-top:12px}
details.fold summary::-webkit-details-marker{display:none}
.fulltext{font-size:13px;font-style:normal;font-family:var(--ui);line-height:1.6;color:var(--ink);
  padding-top:10px;white-space:pre-line}
.searchwrap{max-width:1080px;margin:18px auto 0}
.search{width:100%;max-width:420px;background:var(--card);
  -webkit-backdrop-filter:blur(20px) saturate(170%);backdrop-filter:blur(20px) saturate(170%);
  border:1px solid var(--rim-2);outline:none;border-radius:999px;padding:11px 18px;
  font:var(--w-body) 13.5px var(--ui);color:var(--ink);letter-spacing:var(--track);
  box-shadow:inset 0 1px 0 var(--rim)}
.search::placeholder{color:var(--dim)}
.search:focus{background:var(--card-2);box-shadow:inset 0 1px 0 var(--rim),0 0 0 1.5px var(--accent)}
.foot{max-width:1080px;margin:60px auto 0;text-align:center;color:var(--dim);font-size:11.5px;line-height:1.7}
.pane{display:none}.pane.on{display:block}
.rback{font-size:12.5px;font-weight:600;color:var(--dim);max-width:1080px;margin:20px auto 0;cursor:pointer}
h2{font-family:var(--serif);font-size:25px;font-weight:400;letter-spacing:-.012em;
  max-width:1080px;margin:10px auto}
.masonry{max-width:1080px;margin:14px auto 0;column-count:3;column-gap:22px}
@media(max-width:900px){.masonry{column-count:2}}
.mt{display:block;break-inside:avoid;margin-bottom:22px;border-radius:14px;overflow:hidden;
  text-decoration:none;color:inherit;-webkit-touch-callout:none;user-select:none}
.mt img{width:100%;display:block;border-radius:14px}
.mt span{display:block;font-size:11px;color:var(--dim);padding:8px 2px 0}
.mtx{display:block;background:var(--card);border-radius:14px;padding:20px;font-size:13.5px;line-height:1.55;
  box-shadow:0 1px 2px rgba(30,20,5,.04),0 12px 32px rgba(30,20,5,.07)}
.rhero{display:none}
.rwhisper{max-width:1080px;margin:6px auto 0;font-size:12.5px;color:var(--dim);font-style:italic}
.card.tw{padding:18px 18px 16px}
.twh{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.av{width:26px;height:26px;border-radius:99px;background-size:cover;background-position:center;
  background-color:color-mix(in srgb,var(--ink) 8%,transparent);flex:none}
.twh b{font-size:12.5px;font-weight:600}
.twh .x{margin-left:auto;font-size:13px;color:var(--dim)}
.twx{font-size:13.5px;line-height:1.5;letter-spacing:-.005em}
.card.vid{padding:0;overflow:hidden}
.vth{aspect-ratio:16/9;background-size:cover;background-position:center;position:relative}
.dur{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.72);color:#fff;
  font-size:10.5px;font-weight:600;border-radius:5px;padding:3px 7px}
.vbody{padding:13px 16px 15px}
.vt{font-size:13.5px;font-weight:600;line-height:1.35;letter-spacing:-.01em}
.vc{font-size:11.5px;color:var(--dim);margin-top:4px}
.card.quote{background:#fdf4c2;font-family:var(--serif);font-style:italic;font-size:15px;line-height:1.55;border-radius:2px}
@media (prefers-color-scheme:dark){.card.quote{background:#3a3420;color:#ece5ce}}
.card.quote .who{font:600 9.5px var(--ui);font-style:normal;letter-spacing:.12em;text-transform:uppercase;
  color:#b5a24e;margin-top:12px}
.card.becoming .bline{display:flex;gap:10px;align-items:baseline;padding:7px 0;font-size:13.5px;
  border-top:1px solid color-mix(in srgb,var(--ink) 6%,transparent)}
.card.becoming .bline:first-of-type{border-top:0}
.bm{font-size:12px;font-weight:700;flex:none;width:12px}
.bm.happened{color:var(--go)}
.bm.partial{color:var(--dim)}
.bm.didnt{color:var(--accent)}
.card.becoming .s{margin-top:12px}
.cats{max-width:1080px;margin:-12px auto 26px;display:flex;gap:18px;flex-wrap:wrap;
  font-size:12px;color:var(--dim);align-items:baseline}
.cats .catl{font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:color-mix(in srgb,var(--dim) 60%,transparent)}
.cats span{cursor:pointer}
.cats span:hover{color:var(--ink)}
.cats b{color:var(--accent);cursor:pointer}
/* your world — the watched set, quiet by default. It is a standing roster, not a feed, so it
   reads as one line of type rather than a row of cards competing with the wall below. */
.world{max-width:1080px;margin:-6px auto 26px;display:flex;gap:10px 16px;flex-wrap:wrap;
  align-items:baseline}
.world .catl{font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:color-mix(in srgb,var(--dim) 60%,transparent);width:100%;margin-bottom:2px}
.wc{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;color:var(--dim);
  padding:4px 10px;border-radius:999px;background:var(--card);border:1px solid var(--rim-2);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);transition:color .15s}
.wc b{color:var(--ink);font-weight:var(--w-body)}
.wc i{display:none}                       /* the receipt lives in the hover title, not the band */
.wc u{text-decoration:none;cursor:pointer;opacity:0;color:var(--dim);padding:0 3px;
  transition:opacity .15s}
.wc:hover u{opacity:.55}
.wc u:hover{opacity:1;color:var(--accent)}
.wc.gone{display:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""
PAGE_JS = """
const MODES={everything:'',needs:'need',byco:'co'};
function setMode(m,el){document.querySelectorAll('.modes b,.modes span').forEach(x=>{
  const on=x===el; x.outerHTML=(on?'<b':'<span')+' onclick="setMode(\''+x.dataset.m+'\',this)" data-m="'+x.dataset.m+'">'+x.textContent+(on?'</b>':'</span>');});
  document.querySelectorAll('.p').forEach(p=>{
    const k=p.dataset.kind||'';
    if(m.startsWith('r')&&m.length>1){const rid=m.slice(1);
      const rs=(p.dataset.rooms||'').split(',');
      p.style.display=(k==='keep'&&rs.includes(rid))?'':'none';return;}
    const want=MODES[m]??'';
    p.style.display=(!want||k===want)?'':'none';});}
function filt(){const q=(document.getElementById('gq').value||'').toLowerCase().trim();
  document.querySelectorAll('.p').forEach(p=>{
    const t=p.textContent.toLowerCase();
    p.style.display=(!q||t.includes(q))?'':'none';});}
async function dockAdd(){const el=document.getElementById('gq');const v=(el.value||'').trim();if(!v)return;
  el.disabled=true;el.value='';
  try{const r=await fetch('__REL__/list',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({action:'add',text:v})});
  el.placeholder=r.ok?'on the list. co picks it up from here':'could not reach co';
  if(r.ok)setTimeout(()=>location.reload(),900);}catch(e){el.placeholder='could not reach co';}
  el.disabled=false;}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&document.activeElement.id==='gq')dockAdd();});
async function closeItem(id,btn){try{const r=await fetch('__REL__/list',{method:'POST',
headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'close',id:id})});
if(r.ok){const d=btn.closest('.p');if(d)d.style.display='none';}}catch(e){}}
async function mark(btn){try{await fetch('__REL__/done',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({done:true})});if(btn){btn.textContent='done';btn.closest('.p').style.opacity=.55;}}catch(e){}}
async function dropEnt(x){const c=x.closest('.wc');if(!c)return;const n=c.dataset.n;
c.classList.add('gone');try{await fetch('__REL__/world',{method:'POST',
headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'drop',name:n})});}
catch(e){c.classList.remove('gone');}}
function show(id){document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
const el=document.getElementById(id);if(el)el.classList.add('on');window.scrollTo({top:0,behavior:'instant'});}
function go(n){if(n===0){show('world');return;}show('p'+n);}
"""


def render(tenant: str) -> str:
    """The world as a native-feeling iOS surface. Not a webpage with tabs — an app: SF type
    scale and tracking, grouped inset cards, a blurred floating tab bar (glass on the web),
    tap-scale feedback, safe-area insets, momentum scroll. Add-to-home-screen makes it real."""
    d = _compute(tenant)
    e = html.escape
    ins = _insight(tenant)
    ffs = _finds(tenant, ins.get("goals") or [], d["orbit"])
    aim = get_aim(tenant)
    number = rail.from_number()
    base = public_url(tenant)          # absolute — only for og:image (previews need it)
    rel = f"/w/{slug(tenant)}"         # host-relative — everything the PAGE itself loads

    wk = sorted(d["weeks"].items(), key=lambda kv: datetime.strptime(kv[0] + " 2026", "%b %d %Y"))[-8:]
    while len(wk) < 8:
        wk.insert(0, ("", 0))
    mx = max([n for _, n in wk] + [1])
    bars = "".join(f'<i style="height:{max(3, int(n / mx * 40))}px"></i>' for _, n in wk)

    orbit = "".join(f'<b>{e(w)}</b>' for w in d["orbit"])
    goals = "".join(f'<div class="row"><div class="t">{e(g)}</div></div>' for g in ins.get("goals") or [])
    moves = "".join(
        f'<div class="row"><div class="t">{e(pl["goal"])}</div>'
        f'<div class="s">{e(pl["move"])}</div>'
        f'<div class="s dim">watch for · {e(pl["watch_for"])}</div></div>'
        for pl in ins.get("plan") or [] if pl.get("goal"))
    pats = "".join(
        f'<div class="row"><div class="t serif">{e(pp["read"])}</div>'
        f'<div class="s dim">{e(" · ".join(pp["receipts"]))}'
        + (f' — could also be: {e(pp["alternative"])}' if pp.get("alternative") else "") + "</div></div>"
        for pp in ins.get("patterns") or [] if isinstance(pp, dict))
    feed = "".join(
        f'<a class="row link" href="{e(f_["url"])}"><div class="t">{e(f_["title"])}</div>'
        f'<div class="s dim">{e(f_["why"])}</div></a>' for f_ in ffs)
    # THE WORTH FILTER (8/24, founder: "think about how useless all of that information is").
    # The mind shows KEPT THINGS, never exhaust: an image earns its tile; a text-only tile
    # must be a real standalone thought. Chat fragments, bare reactions, and any leaked
    # engine-directive text never render — conversation lives in the thread, not the archive.
    def _worth_tile(t: dict) -> bool:
        note = _unesc(t.get("note") or "").strip()
        if re.search(r"say so plainly|never ask|couldn't be opened", note, re.I):
            return False                                  # a directive is not a memory
        if t.get("key"):
            return True                                   # imagery always earns the wall
        if t.get("url"):
            return len(note) >= 40                        # a link needs at least a real caption
        return len(note) >= 90                            # a bare thought must stand alone

    tiles = [t for t in _tiles(tenant) if _worth_tile(t)]
    rooms = _rooms(tenant, tiles, d["orbit"])
    now = _now(tenant)
    tdy = _today(tenant)
    _ico = {"eye": '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
            "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
            "bolt": '<path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9z"/>',
            "play": '<circle cx="12" cy="12" r="9"/><path d="M10 8.5 16 12l-6 3.5v-7z"/>'}

    def _live(rows, cls="liverow"):
        return "".join(
            f'<div class="{cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{_ico.get(r["i"], "")}</svg>'
            f'<div><div class="lt">{e(r["t"])}</div><div class="ls">{e(r["s"])}</div></div></div>'
            for r in rows)

    # THE LIST (v2-the-list + web-first ruling 8/22): the member's words verbatim, six states,
    # the work found out by their volition — <details> is the tap, nothing is ever pushed open.
    list_html = ""
    try:
        import list_engine as _le
        _items = _le.live(tenant)
        _closed_n = sum(1 for i in _le.project(tenant) if i["state"] == "closed")
        _stamp = {"open": "open", "scoped": "scoped", "working": "working",
                  "needs-you": "needs you", "done-by-co": "done by co"}
        _rows = []
        for it in _items:
            work = []
            if it.get("plan"):
                work.append(f'<div class="ls"><b>the plan</b> {e(it["plan"])}</div>')
            if it.get("needs"):
                work.append(f'<div class="ls"><b>needs you</b> {e(it["needs"])}</div>')
            for r in it.get("receipts") or []:
                _ru = r.get("url")
                _rw = e(r.get("what") or "")
                work.append(f'<div class="ls">✓ ' + (f'<a href="{e(_ru)}">{_rw}</a>' if _ru else _rw)
                            + "</div>")
            for cm in (it.get("comments") or [])[-4:]:
                work.append(f'<div class="ls dim">{e(cm.get("text") or "")}</div>')
            if it.get("next_check"):
                work.append(f'<div class="ls dim">co looks again · {e(it["next_check"])}</div>')
            if not work:
                work.append('<div class="ls dim">held. co hasn\'t touched this yet.</div>')
            work.append(f'<button class="lclose" onclick="closeItem(\'{e(it["id"])}\',this)">'
                        'close it</button>')
            dot = '<i class="ldot"></i>' if it["state"] == "working" else ""
            src = ' <span class="lsrc">co proposed</span>' if it["source"] == "co-proposed" else ""
            _rows.append(
                f'<details class="li"><summary><span class="lst lst-{it["state"]}">{dot}'
                f'{e(_stamp.get(it["state"], it["state"]))}</span>'
                f'<span class="lt">{e(it["text"])}</span>{src}</summary>'
                f'<div class="lwork">{"".join(work)}</div></details>')
        _sub = "your words, worked. tap one to see what co did" if _rows else ""
        _addf = ('<div class="capture"><input id="ladd" placeholder="what do you want handled…" '
                 'autocomplete="off"><button onclick="addItem()">add</button></div>')
        if _rows or True:
            list_html = ('<div class="k">the list</div>'
                         + (f'<div class="ks">{_sub}</div>' if _sub else "")
                         + _addf
                         + (f'<section class="lsec">{"".join(_rows)}</section>' if _rows else
                            '<section><div class="row"><div class="t">nothing on it yet</div>'
                            '<div class="s dim">say what you want handled, in your own words. '
                            'co scopes it, works it, and shows receipts.</div></div></section>')
                         + (f'<div class="rwhisper">{_closed_n} closed</div>' if _closed_n else ""))
    except Exception:
        list_html = ""

    # THE READING — the last one that shipped, rendered as printed matter. Never composed here.
    reading_html = ""
    try:
        import reading as _rdg
        _rd = _rdg.cached(tenant)
        if _rd:
            _paras = "".join(f'<div class="row"><div class="t serif">{e(p)}</div></div>'
                             for p in _rd["text"].split("\n\n") if p.strip())
            reading_html = ('<div class="k">the reading</div>'
                            f'<div class="ks">from your own record · {e(_rd.get("date", ""))} · '
                            'text co “my reading” for a fresh one</div>'
                            f'<section>{_paras}</section>')
    except Exception:
        reading_html = ""

    # NEEDS ATTENTION + THE DAY (8/24): the two most useful things co knows finally reach
    # the page — guard flags from the inbox and the next 48h from the linked calendar.
    guard_html = ""
    day_html = ""
    if tenant == "dennis":
        try:
            import gmail_guard as _gg
            _gf = _gg.flags(tenant)
            if _gf:
                _rows_g = "".join(f'<div class="row"><div class="t">{e(g)}</div></div>' for g in _gf)
                guard_html = (f'<div class="k">needs attention</div>'
                              f'<div class="ks">caught by the inbox guard · read only</div>'
                              f'<section>{_rows_g}</section>')
        except Exception:
            pass
        try:
            _cal = json.load(open(os.path.expanduser("~/.co/gcal/today.json")))
            _evs = (_cal.get("events") or [])[:8]
            if _evs:
                _rows_d = "".join(
                    f'<div class="row"><div class="s dim" style="margin:0 0 2px">'
                    f'{e(ev["start"][5:16].replace("T", " · "))}</div>'
                    f'<div class="t">{e(ev["title"])}'
                    + (' <span class="lsrc">held by co</span>' if ev.get("made_by_co") else "")
                    + "</div></div>" for ev in _evs)
                day_html = (f'<div class="k">the day</div><div class="ks">next 48 hours, live from '
                            f'your calendar</div><section>{_rows_d}</section>')
        except Exception:
            pass

    today_html = ""
    if tdy.get("one_thing"):
        setup = "".join(f'<div class="sline">{e(x)}</div>' for x in tdy.get("setup") or [])
        today_html = (
            f'<div class="today"><div class="tday">{e(time.strftime("%A").lower())} · your day'
            f'<em>{_left_today()}</em></div>'
            + (f'<div class="tread">{e(tdy["read"])}</div>' if tdy.get("read") else "")
            + f'<div class="tone{" done" if get_done(tenant) else ""}">'
            + f'<span>the one thing</span>{e(tdy["one_thing"])}'
            + f'<button class="mark" onclick="mark()">{"done ✓" if get_done(tenant) else "mark it done"}</button></div>'
            + (f'<div class="tsetup">{setup}</div>' if setup else "")
            + (f'<div class="tthen">{e(tdy["then"])}</div>' if tdy.get("then") else "")
            + "</div>")

    staff_html = ""
    try:
        import work as _work
        _sv = {"watched": "play", "read": "clock", "checked": "bolt", "found": "bolt",
               "researched": "clock", "drafted": "bolt"}
        _rows = [{"i": _sv.get(w["verb"], "bolt"),
                  "t": w["what"], "s": (w.get("why") or w["verb"])}
                 for w in _work.recent(tenant, n=5, days=7)]
        if _rows:
            staff_html = ('<div class="k">while you were living</div>'
                          '<div class="ks">what co did, unasked — the receipts</div>'
                          f'<div class="nowcard">{_live(_rows)}</div>')
    except Exception:
        staff_html = ""

    ser = _serendipity(tenant, tiles)
    ser_html = ""
    if ser:
        body = (f'<div class="serimg" style="background-image:url({rel}/t/{ser["key"]})"></div>'
                if ser.get("key") else f'<div class="sertx">{e(_unesc(ser["note"])[:220])}</div>')
        when = e(ser.get("date") or "")
        ser_html = (f'<div class="k">serendipity</div><div class="ks">something from your mind, '
                    f'{when}</div><a class="sercard"' + (f' href="{e(ser["url"])}"' if ser.get("url") else "")
                    + f'>{body}</a>')
    ydots = _year_dots(tenant)
    ymax = max(ydots + [1])
    year_html = "".join(
        f'<i style="opacity:{0.10 + min(n, ymax) / ymax * 0.85:.2f}"></i>' if n else '<i class="e"></i>'
        for n in ydots)

    live_html = _live(now["live"])
    wait_html = _live(now["waiting"], "liverow wait")
    current = ""
    if now["rising"] or now["cooling"]:
        rise = "".join(f'<span class="up">↑ {e(x)}</span>' for x in now["rising"])
        cool = "".join(f'<span class="down">↓ {e(x)}</span>' for x in now["cooling"])
        current = f'<div class="current">{rise}{cool}</div>'

    crowns = get_crowns(tenant)
    roomof = {}                                  # tile object -> room ids (survives the re-front)
    for n_, r_ in enumerate(rooms):
        for i_ in r_["items"]:
            roomof.setdefault(id(tiles[i_]), []).append(n_)

    def _mosaic(idxs, theme=""):
        pool = [tiles[i] for i in idxs]
        ck = crowns.get(theme)
        if ck:
            pool.sort(key=lambda t: 0 if t["key"] == ck else 1)
        four = [t for t in pool if t["key"]][:4] or pool[:4]
        cells = "".join(
            (f'<i style="background-image:url({rel}/t/{t["key"]})"></i>' if t["key"]
             else f'<i class="itx">{e(_unesc(t["note"])[:40])}</i>') for t in four)
        return f'<div class="mos">{cells}</div>'

    def _rcover(r):
        # The shelf tile (Cosmos grammar, founder 8/22): ONE strong cover, not a contact sheet.
        # Crown wins, else the first tile with an image; a room with no imagery keeps the mosaic.
        ck = crowns.get(r["theme"])
        key = ck if ck and any(tiles[i]["key"] == ck for i in r["items"]) else \
            next((tiles[i]["key"] for i in r["items"] if tiles[i]["key"]), "")
        if key:
            return f'<i class="rcov" style="background-image:url({rel}/t/{key})"></i>'
        return _mosaic(r["items"], r["theme"])

    room_cards = "".join(
        f'<a class="room" onclick="go({n + 1})">{_rcover(r)}'
        f'<div class="rn">{e(r["theme"])}</div><div class="rc">{len(r["items"])} things</div></a>'
        for n, r in enumerate(rooms))

    def _rhero(r):
        # the title card (dreamboard spec 8/4: machine picks the hero, long-press re-crowns)
        ck = crowns.get(r["theme"])
        key = ck if ck and any(tiles[i]["key"] == ck for i in r["items"]) else \
            next((tiles[i]["key"] for i in r["items"] if tiles[i]["key"]), "")
        wh = f'<div class="rwhisper">{e(r.get("whisper") or "")}</div>' if r.get("whisper") else ""
        if key:
            return (f'<div class="rhero" style="background-image:url({rel}/t/{key})">'
                    f'<div class="rtitle">{e(r["theme"])}</div></div>{wh}')
        return f'<h2>{e(r["theme"])}</h2>{wh}'

    room_panes = "".join(
        '<div class="pane" id="p{n}"><div class="rback" onclick="go(0)">‹ world</div>'
        '{hero}<div class="ks" style="margin:2px 0 12px 4px">{ct} things you\'ve sent · hold one to make it the cover</div>'
        '<div class="masonry">{tl}</div></div>'.format(
            n=n + 1, hero=_rhero(r), ct=len(r["items"]),
            tl="".join(
                ('<a class="mt" data-theme="{th}" data-key="{k}"'.format(th=e(r["theme"]), k=tiles[i]["key"] or "")
                 + (f' href="{e(tiles[i]["url"])}"' if tiles[i]["url"] else "") + '>'
                 + (f'<img src="{rel}/t/{tiles[i]["key"]}" loading="lazy">' if tiles[i]["key"]
                    else f'<span class="mtx">{e(_unesc(tiles[i]["note"])[:180])}</span>')
                 + (f'<span>{e(_unesc(tiles[i]["note"])[:70])}</span>' if (tiles[i]["key"] and tiles[i]["note"]) else "")
                 + "</a>") for i in r["items"]))
        for n, r in enumerate(rooms))

    photo_kinds = ("youtube", "instagram", "tiktok")
    hero_t = next((t for t in tiles if t["kind"] in photo_kinds and t["key"]), None)
    if hero_t and tiles and tiles[0] is not hero_t:
        tiles = [hero_t] + [t for t in tiles if t is not hero_t]

    # The mind as one wide masonry (Cosmos's canvas, 8/22): every tile, chip-filterable.
    mind_masonry = ('<div class="masonry wide">' + "".join(
        '<a class="mt" data-rooms="{rm}"{href}>{body}{cap}</a>'.format(
            rm=",".join(str(x) for x in roomof.get(id(t), [])),
            href=f' href="{e(t["url"])}"' if t["url"] else "",
            body=(f'<img src="{rel}/t/{t["key"]}" loading="lazy">' if t["key"]
                  else f'<span class="mtx">{e(_unesc(t["note"])[:180])}</span>'),
            cap=(f'<span>{e(_unesc(t["note"])[:70])}</span>'
                 if (t["key"] and t["note"]) else ""))
        for t in tiles) + "</div>") if tiles else ""

    def _story_stack(ts):
        # one News-style card: hero image on top when the lead has one, headline rows under it
        rows = []
        for j, t in enumerate(ts):
            chip = e(t["kind"])
            meta = e(t["date"][5:]) if t.get("date") else ""
            head = e(_unesc(t["note"] or (t["url"] or "").split("//")[-1])[:170])
            href = f' href="{e(t["url"])}"' if t["url"] else ""
            rm = ",".join(str(x) for x in roomof.get(id(t), []))
            if j == 0 and t["key"]:
                rows.append(
                    f'<a class="story shero" data-rooms="{rm}"{href}>'
                    f'<div class="himg" style="background-image:url({rel}/t/{t["key"]})"></div>'
                    f'<div class="hbody"><span class="src">{chip}</span><div class="hh big">{head}</div>'
                    + (f'<div class="hm">{meta}</div>' if meta else "") + "</div></a>")
            else:
                th = f'<i style="background-image:url({rel}/t/{t["key"]})"></i>' if t["key"] else ""
                rows.append(
                    f'<a class="story" data-rooms="{rm}"{href}><div class="sbody"><span class="src">{chip}</span>'
                    f'<div class="hh">{head}</div>'
                    + (f'<div class="hm">{meta}</div>' if meta else "") + f"</div>{th}</a>")
        return f'<section class="feed">{"".join(rows)}</section>'

    stacks = "".join(_story_stack(tiles[i:i + 4]) for i in range(0, len(tiles), 4))
    reads = "".join(
        f'<div class="row"><div class="s">{e(_unesc((f.get("link") or "")[9:200].strip("[] ")))}</div></div>'
        for f in reversed(d["finds"]))
    watches = "".join(f'<div class="row"><div class="s">{e(w[:100])}</div></div>' for w, _ in d["watches"])
    eps = "".join(f'<div class="row"><div class="s">{"✓" if st == "done" else "·"} {e(w[:100])}</div></div>'
                  for w, st in d["episodes"])

    def card(title, body, sub=""):
        if not body:
            return ""
        return (f'<div class="k">{title}</div>' + (f'<div class="ks">{sub}</div>' if sub else "")
                + f'<section>{body}</section>')

    empty = ('<div class="k">your world</div><section><div class="row"><div class="t">this fills in as you send things</div>'
             '<div class="s dim">a reel that hit. a thought at 1am. a voice note in the car. co holds all of it '
             'and hands it back when it matters.</div></div></section>')

    # ---------- YOUR WORLD (8/25) ----------
    # The page showed everything co PRODUCED and nothing co HOLDS. Asked "where is my world",
    # the honest answer was that the watched set — the actual model of their world, every item
    # carrying the receipt that makes it theirs — rendered nowhere. Seeing it is also the only
    # way to correct it: before this the set self-cleaned by miss-count and the member had no
    # say at all.
    def _roster(t: str) -> str:
        try:
            import entities as _en
            ents = [x for x in _en.load(t).get("entities") or [] if x.get("name")]
        except Exception:
            return ""
        if not ents:
            return ""
        order = {"person": 0, "company": 1, "product": 2, "place": 3, "event": 4}
        ents.sort(key=lambda x: (order.get(x.get("kind"), 9), -x.get("mentions", 1)))
        rows = "".join(
            f'<span class="wc" data-n="{e(x["name"].lower())}" '
            f'title="{e((x.get("why") or "")[:90])}">'
            f'<b>{e(x["name"][:34])}</b>'
            f'<u onclick="dropEnt(this)" title="not my world">×</u></span>'
            for x in ents[:24])
        return (f'<div class="world"><span class="catl">your world</span>{rows}</div>')

    _world_band = _roster(tenant)

    # ---------- THE GALLERY (8/24 pick): one wall — decisions, tickets, and curated imagery ----------
    # Quality gates what ships: an image tile needs a REAL thumbnail; captions are composed
    # (room — weekday), never raw note text; text exhaust cannot reach the wall at all.
    cards = []          # each: (kind, html) — kind in need|co|keep for the mode filter
    if tdy.get("one_thing") and not get_done(tenant):
        cards.append(("need",
            '<div class="card"><div class="k hot">today</div>'
            f'<div class="t">{e(tdy["one_thing"][:160])}</div>'
            '<button class="b" onclick="mark(this)">done</button></div>'))
    if tenant == "dennis":
        try:
            import gmail_guard as _gg
            for g in _gg.flags(tenant)[:3]:
                cards.append(("need",
                    '<div class="card"><div class="k hot">needs you</div>'
                    f'<div class="t">{e(g[:1].upper() + g[1:150])}</div>'
                    '<div class="s">caught in your inbox</div></div>'))
        except Exception:
            pass
    try:
        import list_engine as _le2
        for it in _le2.live(tenant):
            if it["state"] in ("open", "scoped", "needs-you"):
                sub = it.get("needs") or it.get("plan") or "co scopes it next"
                cards.append(("need",
                    '<div class="card"><div class="k hot">needs you</div>'
                    f'<div class="t">{e(it["text"][:150])}</div><div class="s">{e(sub[:100])}</div>'
                    f'<button class="b" onclick="closeItem(\'{e(it["id"])}\',this)">done</button></div>'))
            elif it["state"] == "done-by-co":
                rec = (it.get("receipts") or [{}])[0].get("what") or "work attached"
                cards.append(("co",
                    '<div class="card tick"><div class="k">done for you</div>'
                    f'<div class="t">{e(it["text"][:140])}</div><div class="s">✓ {e(rec[:100])}</div>'
                    f'<button class="b q" onclick="closeItem(\'{e(it["id"])}\',this)">close it</button></div>'))
            elif it["state"] == "working":
                cards.append(("co",
                    '<div class="card tick"><div class="k">working</div>'
                    f'<div class="t">{e(it["text"][:140])}</div>'
                    f'<div class="s">● {e((it.get("plan") or "running")[:100])}</div></div>'))
    except Exception:
        pass
    for w, _st in (d.get("watches") or [])[:3]:
        cards.append(("co",
            '<div class="card tick"><div class="k">watching</div>'
            f'<div class="t">{e(_watch_label(w)[:140])}</div><div class="s">● standing, no move yet</div></div>'))
    try:
        _wp = os.path.expanduser(f"~/.co/work/{tenant}.jsonl")
        _wl = [json.loads(x) for x in open(_wp).readlines()[-12:]][::-1] if os.path.exists(_wp) else []
        # A receipt nobody can read is worse than no card. Video work logs its label as a raw
        # transcript fragment ('"00:00 ] Everyone thinks that we're just waiting..." - 88 min'),
        # which read as co's ACCOMPLISHMENTS at the top of the page once the wall moved away.
        # Timestamp artefacts and bare quote-fragments are noise; drop them, keep real work.
        def _readable(t: str) -> bool:
            t = (t or "").strip()
            return bool(t) and not t[:1] in '"\u201c' and not re.search(r"\d:\d\d|\[\d|M:SS", t)
        _wl = [w for w in _wl if _readable(w.get("what"))]
        for w2 in _wl[:3]:
            cards.append(("co",
                '<div class="card tick"><div class="k">done for you</div>'
                f'<div class="t">{e((w2.get("what") or "")[:130])}</div>'
                f'<div class="s">✓ {e(w2.get("verb") or "")} · {e((w2.get("ts") or "")[5:10])}</div></div>'))
    except Exception:
        pass
    # THE BECOMING STRIP (8/24): what was said against what actually happened. The only card
    # on the wall that reports on the member's life rather than co's work.
    try:
        import outcomes as _oc
        _recent = _oc.recent(tenant)
        if _recent:
            _mark = {"happened": "✓", "partial": "~", "didnt": "✗"}
            _rows = "".join(
                f'<div class="bline"><span class="bm {o["verdict"]}">{_mark.get(o["verdict"], "·")}</span>'
                f'<span>{e((o.get("what") or "")[:70])}</span></div>' for o in _recent)
            _hit = sum(1 for o in _recent if o["verdict"] == "happened")
            cards.append(("co",
                '<div class="card becoming"><div class="k">what actually happened</div>'
                f'{_rows}<div class="s">{_hit} of {len(_recent)} in the last two weeks</div></div>'))
    except Exception:
        pass
    # WHO YOU'RE BECOMING (8/25): the target self, and the honest distance to it. The only
    # card that states a direction rather than a fact.
    try:
        import becoming as _bc2
        _st2 = _bc2.load(tenant)
        _ds = (_st2.get("distances") or [])[:4]
        if _ds:
            _rows2 = "".join(
                f'<div class="bline"><span class="bm {"didnt" if d["gap"] > .5 else ("partial" if d["gap"] > .15 else "happened")}">'
                f'{"·" if d["gap"] > .15 else "✓"}</span>'
                f'<span>{e(d["trait"][:64])}</span></div>' for d in _ds)
            _diet = ""
            try:
                import conversion as _cv2
                _d2 = _cv2.diet(tenant)
                if _d2:
                    _diet = f'<div class="s">{e(_d2)}</div>'
            except Exception:
                pass
            cards.append(("co",
                '<div class="card becoming"><div class="k">who you\'re becoming</div>'
                f'{_rows2}{_diet}</div>'))
    except Exception:
        pass
    # THE THROUGH-LINE: synthesis across their own archive, or what they now believe.
    try:
        import conversion as _cv3
        _cd = _cv3.card(tenant)
        if _cd:
            _label = "the through-line" if _cd["kind"] == "connection" else \
                f"what you now believe about {_cd.get('subject', 'this')[:40]}"
            cards.append(("co",
                f'<div class="card readcard"><div class="k" style="font-style:normal">{e(_label)}</div>'
                f'{e(_cd["text"][:600])}</div>'))
    except Exception:
        pass
    try:
        import reading as _rdg2
        _rd2 = _rdg2.cached(tenant)
        if _rd2:
            _paras = [p for p in _rd2["text"].split("\n\n") if p.strip()]
            _pat = _paras[1] if len(_paras) > 2 else _paras[0]
            _line = _pat.split("“")[0].strip().rstrip(",")
            cards.append(("co",
                '<div class="card readcard"><div class="k" style="font-style:normal">co\'s read</div>'
                f'{e(_line[:1].upper() + _line[1:220])}.'
                '<details class="fold"><summary>the full reading</summary>'
                f'<div class="fulltext">{e(_rd2["text"])}</div></details></div>'))
    except Exception:
        pass

    _weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    def _tile_cap(t: dict) -> str:
        theme = next((rooms[i]["theme"] for i in roomof.get(id(t), []) if i < len(rooms)), "")
        day = ""
        try:
            day = _weekdays[dt_date.fromisoformat(t.get("date") or "").weekday()]
        except Exception:
            pass
        bits = [x for x in (theme.lower(), day) if x]
        return " — ".join(bits) if bits else "kept"

    # Tiles render by WHAT THEY ARE (8/24, founder): a tweet composes like the iMessage
    # preview (avatar, handle, the words), a video like its player card (thumb, duration,
    # title, channel), a thought like a page of their own hand. Never just the profile pic.
    _TWEET_RE = re.compile(r"^tweet @([\w]+)(?:\s*\((?:article|video|image)[^)]*\))?:\s*(.*)", re.S)
    _VID_RE = re.compile(r"(\d+)[- ]MINUTE video \((.+?) — by (.+?) —", re.I)

    def _rooms_attr(t: dict) -> str:
        return ",".join(str(x) for x in roomof.get(id(t), []))

    gallery_tiles = []
    for t in tiles:
        note = _unesc(t.get("note") or "").strip()
        href = f' href="{e(t["url"])}"' if t.get("url") else ""
        dr = _rooms_attr(t)
        mtw = _TWEET_RE.match(note)
        mvid = _VID_RE.search(note)
        if mtw:
            handle, body = mtw.group(1), re.sub(r"https?://\S+", "", mtw.group(2)).strip()
            if len(body) < 12 or re.search(r"can.t be opened|the post links to|JS-wa", body, re.I):
                continue                                 # bare links and engine limit-text never render
            av = (f'<span class="av" style="background-image:url({rel}/t/{t["key"]})"></span>'
                  if t.get("key") else '<span class="av"></span>')
            gallery_tiles.append(
                f'<div class="p" data-kind="keep" data-rooms="{dr}"><a{href}><div class="card tw">'
                f'<div class="twh">{av}<b>@{e(handle)}</b><span class="x">𝕏</span></div>'
                f'<div class="twx">{e(body[:280])}</div></div></a>'
                f'<div class="cap">{e(_tile_cap(t))}</div></div>')
            continue
        if mvid and t.get("key"):
            mins, title, channel = mvid.group(1), mvid.group(2), mvid.group(3)
            gallery_tiles.append(
                f'<div class="p" data-kind="keep" data-rooms="{dr}"><a{href}><div class="card vid">'
                f'<div class="vth" style="background-image:url({rel}/t/{t["key"]})">'
                f'<span class="dur">{e(mins)} min</span></div>'
                f'<div class="vbody"><div class="vt">{e(title[:90])}</div>'
                f'<div class="vc">{e(channel[:50])}</div></div></div></a>'
                f'<div class="cap">{e(_tile_cap(t))}</div></div>')
            continue
        if t.get("key"):
            gallery_tiles.append(
                f'<div class="p" data-kind="keep" data-rooms="{dr}"><a{href}>'
                f'<span class="im" style="background-image:url({rel}/t/{t["key"]});aspect-ratio:{"4/5" if len(gallery_tiles) % 3 == 0 else ("1/1" if len(gallery_tiles) % 3 == 1 else "4/3")}"></span></a>'
                f'<div class="cap">{e(_tile_cap(t))}</div></div>')
            continue
        # THOUGHTS return to the wall (founder ask): their own words, on their own paper.
        clean = re.sub(r"\[[^\]]*\]|https?://\S+", "", note).strip()
        # Yellow paper is for THEIR words only: third-person summaries (Name — The piece
        # reports…) are co's reads of artifacts, not the member's hand — they stay off.
        summaryish = bool(re.match(r"^[A-Z][\w']+ [A-Z][\w']+ —", clean)) or \
            re.search(r"\b(reports that|the piece|this (video|clip|article) (is|shows|discusses))\b", clean, re.I)
        if len(clean) >= 60 and not summaryish and not clean.lower().startswith(("a page", "an article")):
            gallery_tiles.append(
                f'<div class="p" data-kind="keep" data-rooms="{dr}"><div class="card quote">'
                f'{e(clean[:300])}'
                f'<div class="who">you · {e(_tile_cap(t))}</div></div></div>')

    # THE SPLIT (8/26). The wall is ~85 things the member ALREADY SAW — they sent every one of
    # them. It cannot teach anybody anything by construction, and interleaving it with co's
    # reads buried the only lines on the page worth reading. So the tiles become an archive one
    # tap away, and the front carries only what they do NOT already know: co's read of them,
    # what needs them, what is coming, what co did. Same test as the send gate — could they
    # have produced this themselves? Then it is not the first screen.
    need_cards = [c for k, c in cards if k == "need"]
    co_cards = [c for k, c in cards if k == "co"]
    front = [f'<div class="p" data-kind="need">{c}</div>' for c in need_cards]
    front += [f'<div class="p" data-kind="co">{c}</div>' for c in co_cards]
    wall = list(gallery_tiles)

    _fonts = ""
    # the front stopped being the wall, so it stops being called the wall
    _week_line = ("What you'd have missed" if front
                  else "Nothing needs you today")
    return ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<title>co</title>'
            f'<meta property="og:image" content="{e(base)}/card.png">'
            '<meta name="apple-mobile-web-app-capable" content="yes">'
            '<meta name="apple-mobile-web-app-title" content="co">'
            '<meta name="theme-color" content="#fbfaf8">'
            f'<link rel="apple-touch-icon" href="{rel}/icon.png">'
            f'<link rel="manifest" href="{rel}/manifest.json">'
            "<style>" + PAGE_CSS + "</style></head><body>"
            '<div class="pane on" id="world">'
            '<div class="nav"><span class="mark" onclick="go(0)">co</span></div>'
            f'<div class="shelfline">{_week_line}</div>'
            + _world_band
            + f'<div class="grid lead">{"".join(front)}</div>'
            + ('<div class="foot">nothing needs you and nothing moved. '
               'that is co working, not co idle</div>' if not front else "")
            + '<div class="modes"><b onclick="setMode(\'everything\',this)" data-m="everything">everything</b>'
            '<span onclick="setMode(\'needs\',this)" data-m="needs">needs you</span>'
            '<span onclick="setMode(\'byco\',this)" data-m="byco">by co</span>'
            '<span class="arch" onclick="show(\'archive\')">archive</span></div>'
            "</div>"
            # THE ARCHIVE: everything they sent, one tap away and never in the way.
            + '<div class="pane" id="archive">'
              '<div class="nav"><span class="mark" onclick="go(0)">co</span></div>'
              '<div class="searchwrap"><input id="gq" class="search" '
              'placeholder="Search everything you have sent…" autocomplete="off" oninput="filt()"></div>'
            + (('<div class="cats"><span class="catl">threads</span>'
                + "".join(f'<span onclick="setMode(\'r{n}\',this)" data-m="r{n}">{e(r["theme"].lower())}</span>'
                          for n, r in list(enumerate(rooms))[:4] if len(r["items"]) >= 3)
                + "</div>") if any(len(r["items"]) >= 3 for r in rooms[:4]) else "")
            + f'<div class="grid">{"".join(wall)}</div>'
            + '<div class="foot">this page is yours alone. the link is unguessable</div>'
              '<div class="modes"><span onclick="show(\'world\')">← today</span></div>'
              "</div>"
            + room_panes
            + "<script>" + PAGE_JS.replace("__REL__", rel) + "</script></body></html>")


def card_png(tenant: str) -> bytes:
    """The wrapped card as a PNG — the artifact as a MESSAGE BUBBLE. iMessage renders it inline
    (Sendblue media_url) and it doubles as the link's og:image, so both artifact rungs share one
    render. Dark, typographic, screenshot-shaped: the bubble IS the distribution."""
    from PIL import Image, ImageDraw, ImageFont
    d = _compute(tenant)
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), "#141312")
    dr = ImageDraw.Draw(img)

    def font(size, bold=False):
        try:
            return ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", size,
                                      index=1 if bold else 0)
        except OSError:
            return ImageFont.load_default()

    ACC, DIM, FG = "#8fb8a0", "#8a867f", "#ece9e4"
    dr.text((64, 56), "your stream", font=font(56, bold=True), fill=FG)
    def _pretty(iso):
        try:
            return datetime.strptime(iso, "%Y-%m-%d").strftime("%b %-d")
        except ValueError:
            return iso
    dr.text((64, 128), f"{_pretty(d['span'][0])} – {_pretty(d['span'][1])}   ·   held by co",
            font=font(26), fill=DIM)
    dr.text((64, 200), str(d["n"]), font=font(110, bold=True), fill=ACC)
    n_w = dr.textlength(str(d["n"]), font=font(110, bold=True))
    dr.text((64 + n_w + 24, 262), f"things sent · {d['active_days']} active days",
            font=font(30), fill=DIM)
    dr.text((64, 388), "THE ORBIT", font=font(22), fill=DIM)
    y = 430
    x = 64
    for w in d["orbit"][:8]:
        wd = dr.textlength(w, font=font(34, bold=True)) + 44
        if x + wd > W - 64:
            x = 64
            y += 62
        if y > H - 80:
            break
        dr.text((x, y), w, font=font(34, bold=True), fill=ACC)
        x += wd
    dr.text((W - 64 - dr.textlength("co", font=font(30, bold=True)), H - 70),
            "co", font=font(30, bold=True), fill=DIM)
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def icon_png() -> bytes:
    """The app icon: 'co' on the dark ground — one identity everywhere (tab, home screen, card)."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (512, 512), "#141312")
    dr = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 230, index=1)
    except OSError:
        f = ImageFont.load_default()
    w = dr.textlength("co", font=f)
    dr.text(((512 - w) / 2, 512 / 2 - 150), "co", font=f, fill="#8fb8a0")
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def manifest(tenant: str) -> str:
    return json.dumps({
        "name": "co", "short_name": "co",
        "start_url": public_url(tenant), "scope": public_url(tenant),
        "display": "standalone", "background_color": "#141312", "theme_color": "#141312",
        "icons": [{"src": f"{public_url(tenant)}/icon.png", "sizes": "512x512", "type": "image/png"}]})


def get_card_cached(tenant: str) -> bytes:
    os.makedirs(CACHE_DIR, exist_ok=True)
    p = os.path.join(CACHE_DIR, f"{tenant}.card.png")
    try:
        if os.path.exists(p) and time.time() - os.path.getmtime(p) < CACHE_TTL:
            return open(p, "rb").read()
    except OSError:
        pass
    b = card_png(tenant)
    try:
        tmp = p + ".tmp"
        open(tmp, "wb").write(b)
        os.replace(tmp, p)
    except OSError:
        pass
    return b


def _iso_ts(entry: dict) -> str:
    """The moment it was actually kept. Journal entries have carried an epoch `ts` since the first
    write, but only `date` was ever read here, so every memory in the archive claimed noon and the
    app drew "at 12:00 PM" under all of them. Falls back to midday for an entry with no epoch."""
    import datetime as _dt
    ts = entry.get("ts")
    if isinstance(ts, (int, float)) and ts > 0:
        return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{entry.get('date', '2026-01-01')}T12:00:00Z"


def _app_list(tenant: str) -> list:
    """THE LIST for the app (v2-the-list): live items, member's words untouched, receipts along."""
    try:
        import list_engine as _le
        out = []
        for it in _le.live(tenant):
            out.append({
                "id": it["id"], "text": it["text"], "state": it["state"],
                "source": it["source"], "section": it["section"],
                "plan": it.get("plan"), "needs": it.get("needs"),
                "nextCheck": it.get("next_check"),
                "receipts": [{"what": r.get("what"), "url": r.get("url")}
                             for r in (it.get("receipts") or [])],
                "comments": [{"actor": c.get("actor"), "text": c.get("text")}
                             for c in (it.get("comments") or [])[-6:]],
                "created": datetime.fromtimestamp(it["created"]).isoformat(timespec="seconds"),
                "updated": datetime.fromtimestamp(it["updated"]).isoformat(timespec="seconds"),
            })
        return out
    except Exception:
        return []


def app_state(tenant: str) -> str:
    """The iOS app's one feed (apps/ios/Co) — catches, me, radar off the same organs as the
    page. The slug is the credential; the shapes mirror RouterAPI.swift's DTOs."""
    import uuid
    d = _compute(tenant)
    ins = _insight(tenant)
    ffs = _finds(tenant, ins.get("goals") or [], d["orbit"])
    catches = []
    _forgot = forgotten_ids(tenant)
    for e2 in [x for x in _entries(tenant) if not _sys_entry(x.get("text") or "")][-40:][::-1]:
        txt = (e2.get("text") or "").strip()
        url = None
        m = re.search(r"https?://\S+", txt)
        if m:
            url = m.group(0)
        kind = "voice" if "[voice note" in txt else ("url" if url else "text")
        clean = re.sub(r"https?://\S+", "", re.sub(r"\[[^\]]*\]", "", txt)).strip()
        # Belted at the assignment, not at the dict: the card's TITLE falls back to this same
        # string when the member sent a bare link, so a dash in co's read reached the title too.
        read = dedash((e2.get("link") or "").strip()[:400])
        # Unwrap the [shared: …] enrichment marker; never render engine directives ("say so
        # plainly…") or a read that merely restates the member's own words as co's take.
        mshared = re.match(r"^\[shared:\s*(.*?)\]?$", read, re.S)
        if mshared:
            read = mshared.group(1).strip()
        if read.startswith("[") or ("couldn't" in read and "plainly" in read):
            read = ""
        thumb = None                                    # image-forward cards (News+ grammar, 8/4)
        mk = re.search(r"\[img:([0-9a-f]{6,16})\]", txt)
        if mk:
            thumb = mk.group(1)
        elif url:
            try:
                import thumbs as _th
                if _th.cached(url):
                    thumb = _th.key_for(url)
            except Exception:
                pass
        # A card must be an ARTIFACT — a link, an image, a voice note, or a thought with
        # enough body to stand alone. Bare chat fragments ("Tomorrow", a question to co)
        # were echoing the member's own texts back at them as archive (founder, 8/7:
        # "a bunch of useless text"). Conversation lives in chat; the archive holds things.
        if not _catchworthy(kind, clean, url, thumb):
            continue
        cid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"co:{tenant}:{e2.get('ts')}"))
        if cid in _forgot:
            continue
        title = clean[:70] or read[:70]
        if read and read[:70].strip().lower() == title.strip().lower():
            read = ""                                   # a read that IS the title is duplication
        catches.append({
            "id": cid,
            "ts": _iso_ts(e2), "kind": kind, "url": url,
            "title": title,
            # `read` is co's own read of the artifact and becomes the card's bullet in the app;
            # `text`/`title` are the member's words and are left exactly as they typed them.
            "text": clean[:300] or None, "read": read or None, "thumb": thumb})
    tdy = _today(tenant)                                # the today tab (app charter, 8/4)
    wdb = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
    try:
        wk = json.load(open(f"{wdb}.wake.json")) if os.path.exists(f"{wdb}.wake.json") else {}
    except (OSError, json.JSONDecodeError):
        wk = {}
    return json.dumps({
        "me": {"orbit": d["orbit"], "goals": ins.get("goals") or [],
               "patterns": ins.get("patterns") or [], "aim": get_aim(tenant),
               "watching": [_watch_label(w) for w, _ in d["watches"]],
               "n": d["n"], "span": list(d["span"]),
               "number": rail.from_number()},
        "today": {"read": tdy.get("read") or None, "one_thing": tdy.get("one_thing") or None,
                  "setup": tdy.get("setup") or [], "then": tdy.get("then") or None,
                  "done": get_done(tenant)},
        "overnight": ({"thread": wk.get("thread"), "line": wk.get("line"), "url": wk.get("url")}
                      if wk.get("send") else None),
        "catches": catches,
        "staff": _staff(tenant),
        "sensitive": _app_sensitive(tenant),
        "projects": _app_projects(tenant),
        "rooms": _app_rooms(tenant, d["orbit"]),
        "list": _app_list(tenant),
        "lived": _lived(tenant),
        "radar": {"finds": ffs, "watching": _watch_chips(d)}}, ensure_ascii=False)


def _lived(tenant: str) -> dict:
    """The flagship loop's output half (lived.py): what actually changed in their week
    because of something they sent, and their verdict on whether it belonged. Every
    other key here is accumulation or conclusion; this one is consequence."""
    try:
        import lived as _lv
        return _lv.app_view(tenant)
    except Exception:
        return {"live": [], "proposed": [], "settled": 0, "endorsed": 0}


def forgotten_path(tenant: str) -> str:
    db = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
    return f"{db}.forgotten.json"


def forgotten_ids(tenant: str) -> set:
    try:
        return set(json.load(open(forgotten_path(tenant))))
    except (OSError, json.JSONDecodeError):
        return set()


def record_forget(tenant: str, payload: dict) -> bool:
    """The member forgets an artifact — the trash in the app, made TRUE. Before this door
    existed the app deleted from its in-memory array only, and the 'deleted' memory came
    back on the next fetch (8/9 walkthrough): the one lie this surface cannot afford.
    Append-only tombstones; the raw journal keeps its entry (memory is not rewritten),
    but every member-facing surface — catches, archive, search — excludes it."""
    fid = str(payload.get("id") or "").strip()
    if not fid:
        return False
    ids = forgotten_ids(tenant)
    ids.add(fid)
    try:
        json.dump(sorted(ids), open(forgotten_path(tenant), "w"))
        return True
    except OSError:
        return False


def record_lived(tenant: str, payload: dict) -> bool:
    """Member actions on a lived test. co proposes; ONLY this path installs, reverses,
    or closes — the authority ladder is enforced by there being no other door."""
    try:
        import lived as _lv
    except Exception:
        return False
    action = str(payload.get("action") or "")
    tid = str(payload.get("id") or "")
    if action == "accept":
        return _lv.accept(tenant, tid)
    if action == "decline":
        return _lv.decline(tenant, tid)
    if action == "reverse":
        return _lv.reverse(tenant, tid)
    if action == "verdict":
        return _lv.verdict(tenant, tid, str(payload.get("value") or ""),
                           str(payload.get("words") or ""))
    return False


def _app_rooms(tenant: str, orbit: list) -> list:
    """The world's rooms for the app (call-003: Inside-Out — 'go into your own head and see
    the different worlds'; NOT a graph). Self-contained: each room ships its members (thumb
    key / note / url) so the app never has to re-derive tile membership. Rides the same
    _rooms cache as the page — cheap on hit, one JUDGE call only when the world changed."""
    try:
        tiles = _tiles(tenant)
        out = []
        for r in _rooms(tenant, tiles, orbit):
            members = []
            for i in r["items"][:24]:
                t = tiles[i]
                members.append({"key": t["key"] or None, "note": (t.get("note") or "")[:110],
                                "url": t["url"] or None, "kind": t.get("kind") or "note", "ts": t.get("ts"),
                                "date": t.get("date") or None})
            out.append({"theme": r["theme"], "whisper": r.get("whisper") or None,
                        "count": len(r["items"]), "members": members})
        return out
    except Exception:
        return []


def _staff(tenant: str) -> list:
    """The work ledger's recent window — 'many hands, one ledger' (institution law #2).
    The app renders these as the staff clocking in; empty list = nothing claimed, no filler.
    Receipts carry the artifact's face when we hold one — the row that says WHICH thing."""
    out = []
    try:
        import work
        for e in work.recent(tenant, n=12):
            # `what` and `why` are co's phrasing of its own work and both render on Home, so both
            # wear the dash rule (8/7).
            row = {"ts": e.get("ts"), "verb": e.get("verb"), "what": dedash(e.get("what") or ""),
                   "why": dedash(e.get("why") or ""), "url": e.get("url")}
            # FINDING vs ACTIVITY (teardown 8/7: "six pieces of noise visually equal to
            # the one thing worth money"). A finding leads with its payload — strip the
            # "a watch fired:" preamble; the row IS the fire.
            what = row["what"] or ""
            if what.startswith("a watch fired:"):
                row["kind"] = "finding"
                row["what"] = what[len("a watch fired:"):].strip()
            else:
                row["kind"] = "finding" if e.get("verb") == "found" else "activity"
            if row["url"]:
                try:
                    import thumbs as _th
                    if _th.cached(row["url"]):
                        row["thumb"] = _th.key_for(row["url"])
                except Exception:
                    pass
            # One event, one receipt — a watch judging "changed" on consecutive ticks double-logs
            # (the duplicate watch-fire pair, 8/10). Newest row wins; word-overlap is the same-event test.
            words = {w for w in re.findall(r"[a-z]{3,}", (row["what"] or "").lower())}
            dup = any(r2["verb"] == row["verb"] and words and r2["_w"]
                      and len(words & r2["_w"]) / len(words | r2["_w"]) >= 0.4 for r2 in out)
            row["_w"] = words
            if not dup:
                out.append(row)
        for r2 in out:
            r2.pop("_w", None)
    except Exception:
        pass
    return out


def _sensitive_when(fire, now) -> str:
    """A fire time said the way a friend says it. The window is 36h back to 72h forward, so a
    weekday name is never ambiguous (three days out cannot collide with today) and a clock time
    only earns its place on today and tomorrow, where it changes what the member does next."""
    days = (fire.date() - now.date()).days
    clock = fire.strftime("%-I:%M%p").lower()
    if days < 0:
        return "yesterday"
    if days == 0:
        return f"today at {clock}"
    if days == 1:
        return f"tomorrow at {clock}"
    return fire.strftime("%A").lower()


def _app_sensitive(tenant: str) -> list:
    """The things with a clock on them, as one strip at the top of the app. Two organs already
    hold time pressure and neither had a member-facing read: anchors (a promise with an absolute
    fire time) and watches that just moved. Nearest in time first, hard cap 5 — a strip that
    scrolls is a list, and a list is exactly what this rail exists in order not to be.

    `app` is only ever "invite" or "messages". No location signal exists anywhere in this
    backend, so a "maps" item would be an invention, and an invented address is the one kind of
    wrong that walks the member to the wrong door."""
    import datetime as _dt
    import uuid
    now = _dt.datetime.now()
    out = []
    db = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
    try:
        import anchors as _an
        # anchors.due owns the staleness rule (past its fire by more than 36h = missed, not
        # pending, and it retires the anchor on the way past). Take its verdict for the past
        # side rather than re-deciding it here, and scan the store for the future side.
        try:
            rows = list(_an.due(db))
        except Exception:
            rows = []                                   # no tz organ / no store — future side still stands
        rows += [a for a in _an._load(db).get("anchors", []) if not a.get("fired")]
        seen = set()
        for a in rows:
            what = (a.get("what") or "").strip()
            try:
                fire = _dt.datetime.fromisoformat(a.get("fire") or a.get("when") or "")
            except (TypeError, ValueError):
                continue
            # Wall clock, both sides. Anchors are written in the member's tz and this process
            # runs in the server's; the offset is worth less than the crash a naive/aware
            # comparison costs, and the phrasing below is only ever day-grained.
            fire = fire.replace(tzinfo=None)
            secs = (fire - now).total_seconds()
            if not what or not (-36 * 3600 <= secs <= 72 * 3600):
                continue
            key = (what.lower()[:40], fire.isoformat()[:16])
            if key in seen:                             # due() and the store overlap by design
                continue
            seen.add(key)
            when_s = _sensitive_when(fire, now)
            due_s = "due " if a.get("kind") == "deadline" else ""
            out.append({
                # The what plus the fire time is the anchor's own identity (extract dedupes on
                # exactly that pair), so the id survives every tick that does not move the time.
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"co:{tenant}:anchor:{key[0]}:{key[1]}")),
                "line": dedash(f"{what[:80]}, {due_s}{when_s}"),
                "app": "messages", "url": None, "_k": abs(secs)})
    except Exception:
        pass
    try:
        import calendar
        for wid, what, target, state, checked, fires in _db_rows(
                tenant, "SELECT id, what, target, last_state, last_checked, fire_count FROM watches "
                        "WHERE fire_count > 0 AND last_checked IS NOT NULL "
                        "ORDER BY last_checked DESC LIMIT 20"):
            try:
                # timegm, NOT mktime: last_checked is UTC and the Z is real (8/9 audit).
                age = time.time() - calendar.timegm(time.strptime(checked, "%Y-%m-%dT%H:%M:%SZ"))
            except (TypeError, ValueError):
                continue
            if not 0 <= age <= 72 * 3600:
                continue
            url = (target or "").strip() if str(target or "").startswith("http") else None
            said = (state or "").strip()[:90]
            out.append({
                # fire_count, not last_checked: a watch is re-checked on its cadence whether or
                # not anything happened, so keying on the check would mint a new id every tick.
                # A new FIRE genuinely is a new thing to look at, and earns a new id.
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"co:{tenant}:watch:{wid}:{fires}")),
                "line": dedash(f"{_watch_label(what or '')} moved" + (f": {said}" if said else "")),
                "app": "invite" if url else "messages", "url": url, "_k": age})
    except Exception:
        pass
    # One rule for both sources: nearest to now wins, whichever side of now it sits on. A
    # deadline four hours out and a watch that fired an hour ago are the same kind of urgent.
    out.sort(key=lambda x: x["_k"])
    for x in out:
        x.pop("_k", None)
    return out[:5]


def _app_projects(tenant: str) -> list:
    """The standing work — what co is carrying, with the receipts under each one. Spine is the
    two organs that hold a commitment across days: watches (open ended, keep looking) and
    commissions (closed, a report on a promised day). The work ledger supplies the activity, so
    this view writes nothing and stores nothing; it is a read of things that already happened.

    No "awaiting" is ever emitted. Nothing in these organs records a block ON THE MEMBER — a
    watch waits on the world, a commission waits on its own due date — and claiming the member
    owes co something they were never asked for is a worse lie than a missing state."""
    import uuid
    out = []
    try:
        # 'fired' is excluded: it is a watch mid-flight between firing and being retired, and it
        # already shows up on the sensitive rail. done/dead are kept because a finished project
        # is still the work co did, and it reads as closed rather than vanishing overnight.
        for wid, what, care, state, status in _db_rows(
                tenant, "SELECT id, what, care, last_state, status FROM watches "
                        "WHERE status IN ('active','done','dead') "
                        "ORDER BY status='active' DESC, id DESC LIMIT 12"):
            bits = [b for b in [(care or "").strip(), (state or "").strip()[:120]] if b]
            out.append({"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"co:{tenant}:watch:{wid}")),
                        "name": dedash(_watch_label(what or "")),
                        "summary": dedash(" · ".join(bits))[:200],
                        "status": "working" if status == "active" else "done"})
    except Exception:
        pass
    try:
        d = os.path.expanduser(f"~/.co/research/{tenant}")
        for fn in sorted(os.listdir(d), reverse=True):
            if not fn.endswith(".json"):
                continue
            try:
                rec = json.load(open(os.path.join(d, fn)))
            except (OSError, json.JSONDecodeError):
                continue
            topic = str(rec.get("topic") or "").strip()
            if not topic:
                continue
            due = str(rec.get("due") or "")[:10]
            try:
                day = datetime.strptime(due, "%Y-%m-%d").strftime("%b %-d").lower()
            except ValueError:
                day = ""
            bits = [b for b in [str(rec.get("angle") or "").strip(), f"back {day}" if day else ""] if b]
            out.append({"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"co:{tenant}:research:{rec.get('id') or fn}")),
                        "name": dedash(topic[:60]),
                        "summary": dedash(" · ".join(bits))[:200],
                        # The record carries no delivered flag: delivery rides the anchor rail and
                        # is recorded there, not here. The promised day passing IS the delivery,
                        # so a past due date reads as done rather than as work still in flight.
                        "status": "done" if day and due < time.strftime("%Y-%m-%d") else "working"})
    except Exception:
        pass
    out = out[:12]
    try:
        import work
        ledger = work.recent(tenant, n=60)
    except Exception:
        ledger = []
    for p in out:
        # The same crude word-overlap test _staff uses to spot one event logged twice, pointed
        # at a different question: does this ledger line belong to this project. Deliberately a
        # membership test and not a score — the ceiling is that a project named with common
        # words collects lines it did not earn, and the honest fix is the organs stamping a
        # project id on the entry when they log it, which nothing does today.
        name_w = {w for w in re.findall(r"[a-z]{3,}", (p["name"] or "").lower())}
        acts = []
        for e in ledger if name_w else []:
            what = dedash(e.get("what") or "")
            if not (name_w & set(re.findall(r"[a-z]{3,}", what.lower()))):
                continue
            acts.append({"id": str(uuid.uuid5(uuid.NAMESPACE_URL,
                                              f"co:{tenant}:work:{e.get('ts')}:{what[:60]}")),
                         # `ts` is passed through exactly as the ledger wrote it, the same as the
                         # staff key does — one ledger, one timestamp shape, one decoder.
                         "ts": e.get("ts"), "verb": e.get("verb"), "what": what,
                         "why": dedash(e.get("why") or "") or None, "url": e.get("url")})
            if len(acts) >= 20:
                break
        p["activity"] = acts[::-1]                      # ledger is newest first; a project reads forward
    return out


def record_capture(tenant: str, payload: dict) -> bool:
    """The app/share-extension capture → the SAME journal as texts. One memory, three doors."""
    try:
        import journal
        bits = []
        if payload.get("text"):
            bits.append(str(payload["text"])[:1000])
        if payload.get("url"):
            bits.append(str(payload["url"])[:500])
        if payload.get("userNote"):
            bits.append(f"[their note: {str(payload['userNote'])[:300]}]")
        if payload.get("whyAnswer"):
            bits.append(f"[why it caught them: {str(payload['whyAnswer'])[:300]}]")
        if not bits:
            return False
        journal.capture(tenant, " ".join(bits))
        return True
    except Exception:
        return False


def record_verdict(tenant: str, payload: dict) -> None:
    """Pattern verdicts / radar mutes from the app — the reward stream's app-side lane."""
    try:
        os.makedirs(os.path.expanduser("~/.co/app_verdicts"), exist_ok=True)
        with open(os.path.expanduser(f"~/.co/app_verdicts/{tenant}.jsonl"), "a") as f:
            f.write(json.dumps({"ts": time.time(), **{k: str(v)[:200] for k, v in payload.items()}}) + "\n")
    except OSError:
        pass


def search_entries(tenant: str, q: str) -> str:
    """Server-side search over EVERYTHING they've ever sent (8/4: the app searches the
    whole journal, not the 40-entry window app.json carries)."""
    import uuid
    q = (q or "").strip().lower()
    out = []
    if len(q) >= 2:
        for e2 in reversed(_entries(tenant)):
            txt = (e2.get("text") or "")
            read = dedash(e2.get("link") or "")     # the title falls back to it, same as app_state
            if q in txt.lower() or q in read.lower():
                url = None
                m = re.search(r"https?://\S+", txt)
                if m:
                    url = m.group(0)
                clean = re.sub(r"https?://\S+", "", re.sub(r"\[[^\]]*\]", "", txt)).strip()
                thumb = None
                mk = re.search(r"\[img:([0-9a-f]{6,16})\]", txt)
                if mk:
                    thumb = mk.group(1)
                elif url:
                    try:
                        import thumbs as _th
                        if _th.cached(url):
                            thumb = _th.key_for(url)
                    except Exception:
                        pass
                kind2 = "voice" if "[voice note" in txt else ("url" if url else "text")
                if not _catchworthy(kind2, clean, url, thumb):
                    continue
                oid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"co:{tenant}:{e2.get('ts')}"))
                if oid in forgotten_ids(tenant):
                    continue
                out.append({"id": oid,
                            "ts": _iso_ts(e2),
                            "kind": kind2,
                            "url": url, "title": (_unesc(clean)[:80] or _unesc(read)[9:80].strip("[] ")),
                            "text": _unesc(clean)[:240] or None,
                            "read": _unesc(read)[:240] or None, "thumb": thumb})
                if len(out) >= 60:
                    break
    return json.dumps({"results": out}, ensure_ascii=False)


def get_crowns(tenant: str) -> dict:
    """Per-room chosen hero image (dreamboard spec, 8/4: the 10-second ownership ritual).
    theme -> thumb key, set by long-press on a tile in that room."""
    try:
        return json.load(open(os.path.join(CACHE_DIR, f"{tenant}.crowns.json")))
    except (OSError, json.JSONDecodeError):
        return {}


def set_crown(tenant: str, theme: str, key: str) -> bool:
    if not theme or not re.fullmatch(r"[0-9a-f]{6,16}", key or ""):
        return False
    os.makedirs(CACHE_DIR, exist_ok=True)
    c = get_crowns(tenant)
    c[str(theme)[:40]] = key
    p = os.path.join(CACHE_DIR, f"{tenant}.crowns.json")
    json.dump(c, open(p + ".tmp", "w"))
    os.replace(p + ".tmp", p)
    try:
        os.remove(os.path.join(CACHE_DIR, f"{tenant}.html"))   # the page must show it now
    except OSError:
        pass
    return True


def get_cached(tenant: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    p = os.path.join(CACHE_DIR, f"{tenant}.html")
    try:
        if os.path.exists(p) and time.time() - os.path.getmtime(p) < CACHE_TTL:
            return open(p).read()
    except OSError:
        pass
    h = render(tenant)
    try:
        tmp = p + ".tmp"
        open(tmp, "w").write(h)
        os.replace(tmp, p)
    except OSError:
        pass
    return h


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else "dennis"
    get_cached(t)
    print(f"{os.path.join(CACHE_DIR, t + '.html')}\n{public_url(t)}")
