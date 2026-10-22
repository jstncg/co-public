#!/usr/bin/env python3
"""Co memory viewer — the record, readable AND correctable.

A mobile-first page per tenant: everything they sent (the feed, with Co's reactions inline),
everything Co holds about them (the memories, grouped and human), and the open threads.
Served on a local port behind an unguessable per-tenant token URL. No accounts.

Editable memory (the Karpathy principle — the user must be able to read AND correct what Co
knows): each claim carries two quiet actions, "not right" and "edit". These are the viewer's
ONLY write: rows in `user_corrections` inside the SAME per-tenant claims db (contract with the
engine agent, which processes them). Everything else stays read-only.

  POST /v/<token>/correct   {"claim_id": int, "action": "wrong"|"edit"|"undo", "text": str?}
    wrong  → flag the claim (strike + "noted")
    edit   → store the user's corrected text (shown as pending)
    undo   → delete the unprocessed correction for that claim

Data (read-only, except user_corrections):
  claims/claims[_<tenant>].db              the model-of-them (claims + confidence + evidence)
  claims/<db>.co_memory.db                 send history + Co's reactions + tiers + themes
  ~/.co/journal/<tenant>.json           the Saga (captures, daily-question answers, link reads)
  ~/.co_<tenant>_sendblue_transcript.json   engine-mode conversation (if any)

Run:  python3 serve.py          (or ./run.sh)   → prints per-tenant token URLs
Env:  VIEWER_PORT (default 8811)
"""
import datetime as dt
import html
import json
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import media_store

HERE = Path(__file__).resolve().parent
CLAIMS_DIR = HERE.parent / "claims"
sys.path.insert(0, str(CLAIMS_DIR))          # so the shared rec grounding gate imports (one gate, no drift)
JOURNAL_DIR = Path("~/.co/journal").expanduser()
TOKENS_PATH = HERE / "tokens.json"
PORT = int(os.environ.get("VIEWER_PORT", "8811"))
DEFAULT_TENANT = "dennis"

# The house shows the tenant's own name only when Co has earned it (default OFF → "Your mind, lately.")
NAME_GREETING = os.environ.get("VIEWER_NAME_GREETING", "").lower() in ("1", "true", "yes")

# Recommendations (the addendum): rare, earned, sourced fetch-first, cached on a slow cadence.
RECS_REFRESH_H = 6          # don't refetch Exa on every load; a rec is stable for hours
RECS_MAX = 2                # hard cap: 1-2 in the whole house, never a feed
EXA_KEY = os.environ.get("EXA_API_KEY", "")


def _load_dotenv():
    """The viewer runs standalone (no doppler) — pull EXA/GEMINI keys from frame/.env if present."""
    global EXA_KEY
    envp = CLAIMS_DIR.parent / ".env"
    if not envp.exists():
        return
    try:
        for ln in envp.read_text().splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k in ("EXA_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
                     "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY") and k not in os.environ:
                os.environ[k] = v
    except OSError:
        pass
    EXA_KEY = os.environ.get("EXA_API_KEY", "")


_load_dotenv()

FEED_CAP = 200          # newest N dated feed items
GROUP_CAP = 12          # claims shown per group
POOL = 400              # rows pulled per group before display-dedup

URL_RE = re.compile(r"https?://[^\s\]]+")
YT_RE = re.compile(r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/)|youtu\.be/)([A-Za-z0-9_-]{6,11})")
SHARED_RE = re.compile(r"\[shared:\s*(.*?)\]\s*$", re.S)
IG_RE = re.compile(r"\[instagram reel[^\]]*\]")

# what co knows — grouping by claim type (possessions counted, not listed: a log, not a memory)
GROUPS = [
    ("who you are", ("identity", "value")),
    ("patterns", ("routine", "preference", "frame", "other", "pattern")),
    ("people", ("relationship",)),
    ("commitments", ("obligation",)),
]
STOP = set("a an the of in on to for and or is are was were has have had with at by from about "
           "into over after before under between out up down off as be been being that this those "
           "these it its their his her you your".split())


# ── tenants + tokens ─────────────────────────────────────────────────────────────────────────────
def _clean(t: str) -> str:
    return re.sub(r"[^a-z0-9_+\-]", "_", (t or "").strip().lower())


def claims_db(tenant: str) -> Path:
    return CLAIMS_DIR / ("claims.db" if tenant == DEFAULT_TENANT else f"claims_{tenant}.db")


def discover_tenants() -> list:
    seen = set()
    if (CLAIMS_DIR / "claims.db").exists():
        seen.add(DEFAULT_TENANT)
    for p in CLAIMS_DIR.glob("claims_*.db"):
        if p.name.endswith(".co_memory.db"):
            continue
        seen.add(_clean(p.name[len("claims_"):-len(".db")]))
    for p in CLAIMS_DIR.glob("claims_*.db.co_memory.db"):
        seen.add(_clean(p.name[len("claims_"):-len(".db.co_memory.db")]))
    if (CLAIMS_DIR / "claims.db.co_memory.db").exists() or (CLAIMS_DIR / "co_memory.db").exists():
        seen.add(DEFAULT_TENANT)
    if JOURNAL_DIR.exists():
        for p in JOURNAL_DIR.glob("*.json"):
            seen.add(_clean(p.stem))
    for p in Path.home().glob(".co_*_sendblue_transcript.json"):
        m = re.match(r"\.co_(.+)_sendblue_transcript\.json$", p.name)
        if m:
            seen.add(_clean(m.group(1)))
    return sorted(t for t in seen if t)


def load_tokens() -> dict:
    try:
        return json.loads(TOKENS_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def tokens_for(tenants: list) -> dict:
    """tenant → token, persisted. New tenants get a token on sight; existing tokens never rotate here."""
    toks = load_tokens()
    changed = False
    for t in tenants:
        if t not in toks:
            toks[t] = secrets.token_urlsafe(12)
            changed = True
    if changed:
        tmp = TOKENS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(toks, indent=2))
        os.replace(tmp, TOKENS_PATH)
        try:
            os.chmod(TOKENS_PATH, 0o600)
        except OSError:
            pass
    return toks


def display_name(tenant: str) -> str:
    if re.fullmatch(r"p\d{7,15}", tenant):          # phone-derived tenant → readable number
        d = tenant[1:]
        if len(d) == 11 and d.startswith("1"):
            return f"+1 {d[1:4]} {d[4:7]} {d[7:]}"
        return "+" + d
    return tenant


# ── data loading (read-only) ─────────────────────────────────────────────────────────────────────
def _ro(path: Path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _rows(path: Path, sql: str, args=()):
    if not path.exists():
        return []
    try:
        c = _ro(path)
        out = c.execute(sql, args).fetchall()
        c.close()
        return out
    except sqlite3.Error:
        return []


def load_sends(tenant: str) -> list:
    """co_sends across this tenant's memory db(s). The default tenant also gets the local demo db."""
    paths = [Path(str(claims_db(tenant)) + ".co_memory.db")]
    if tenant == DEFAULT_TENANT:
        paths.append(CLAIMS_DIR / "co_memory.db")
    out = []
    for p in paths:
        for ts, send, tier, reaction, matched, theme in _rows(
                p, "SELECT ts, send, tier, reaction, matched, theme FROM co_sends ORDER BY ts"):
            out.append({"ts": _parse_ts(ts), "send": send or "", "tier": tier or "none",
                        "reaction": reaction or "", "matched": matched or "", "theme": theme or "other"})
    return out


def load_journal(tenant: str) -> list:
    p = JOURNAL_DIR / f"{tenant}.json"
    try:
        st = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    out = []
    for e in st.get("entries", []):
        ts = e.get("ts")
        out.append({"ts": dt.datetime.fromtimestamp(ts) if isinstance(ts, (int, float)) else None,
                    "text": e.get("text", ""), "q": e.get("q"), "link": e.get("link")})
    return out


def load_transcript(tenant: str) -> list:
    p = Path.home() / f".co_{tenant}_sendblue_transcript.json"
    try:
        msgs = json.loads(p.read_text())
        return msgs if isinstance(msgs, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _parse_ts(s):
    try:
        return dt.datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


# ── the feed: merge sends + journal, newest first ────────────────────────────────────────────────
def _norm_key(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())[:60]


def _split_send(send: str):
    """A co_send stores the ENRICHED text (raw + '\\n[shared: ...]'). Recover both halves."""
    link = None
    m = SHARED_RE.search(send)
    if m:
        link = m.group(0).strip()
        send = send[:m.start()].strip()
    m2 = IG_RE.search(send)
    if m2:
        link = link or m2.group(0)
        send = (send[:m2.start()] + send[m2.end():]).strip()
    return send, link


def build_feed(tenant: str) -> list:
    """Journal captures + co_sends, merged. The same capture usually exists in BOTH (the router stores
    to the journal, then reacts); genuine repeats (same text sent twice) stay as two items."""
    feed, index = [], {}

    def key_of(text, ts):
        d = ts.date().isoformat() if ts else "?"
        return f"{d}|{_norm_key(text)}"

    for j in load_journal(tenant):
        it = {"ts": j["ts"], "text": j["text"], "q": j.get("q"), "link": j.get("link"),
              "tier": None, "reaction": ""}
        feed.append(it)
        index.setdefault(key_of(j["text"], j["ts"]), []).append(it)

    for s in load_sends(tenant):
        raw, link = _split_send(s["send"])
        unmerged = [it for it in index.get(key_of(raw, s["ts"]), []) if it["tier"] is None]
        if unmerged:                                    # same capture seen via journal → merge
            it = unmerged[0]
            it["tier"], it["reaction"] = s["tier"], s["reaction"]
            it["link"] = it.get("link") or link
            it["ts"] = it["ts"] or s["ts"]
        else:
            feed.append({"ts": s["ts"], "text": raw, "q": None, "link": link,
                         "tier": s["tier"], "reaction": s["reaction"]})

    feed.sort(key=lambda x: x["ts"] or dt.datetime.min, reverse=True)
    return feed[:FEED_CAP]


# ── what co knows: grouped, deduped, human ───────────────────────────────────────────────────────
def _words(s: str) -> set:
    s = re.sub(r"\([^)]*\)", " ", s)          # parentheticals are evidence lists, not meaning
    return {w for w in re.findall(r"[a-z0-9']+", s.lower()) if w not in STOP and len(w) > 2}


def _similar(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _conf_word(conf: float, level: str) -> str:
    if level == "frame":
        return "held loosely"
    if conf >= 0.85:
        return "near certain"
    if conf >= 0.65:
        return "confident"
    if conf >= 0.45:
        return "forming"
    return "a hunch"


def _since(first_seen) -> str:
    try:
        d = dt.date.fromisoformat(str(first_seen)[:10])
        return "since " + d.strftime("%b %Y").lower()
    except (ValueError, TypeError):
        return ""


# ── corrections: the viewer's ONLY write (editable memory) ──────────────────────────────────────
# Contract agreed with the engine agent — it consumes these rows (processed=0 → it processes and
# flips the flag). Additive table in the tenant's own claims db; nothing else in the db is ours.
CORRECTIONS_DDL = ("CREATE TABLE IF NOT EXISTS user_corrections ("
                   "id INTEGER PRIMARY KEY, claim_id INTEGER, action TEXT, text TEXT, "
                   "created_at TEXT, processed INTEGER DEFAULT 0)")


def load_corrections(db: Path) -> dict:
    """Unprocessed corrections keyed by claim, latest wins — the render overlay
    ('wrong' = strike, 'edit' = the user's text shown as pending)."""
    out = {}
    for cid, action, text in _rows(db, "SELECT claim_id, action, COALESCE(text,'') FROM user_corrections "
                                       "WHERE processed=0 ORDER BY id"):
        out[cid] = {"action": action, "text": text}
    return out


def save_correction(tenant: str, claim_id: int, action: str, text=None):
    """wrong/edit inserts a row; undo deletes the unprocessed one. The claim must exist in THIS
    tenant's db — per-tenant files make the no-cross-tenant-write check structural."""
    db = claims_db(tenant)
    if not db.exists():
        return 404, {"ok": False, "error": "no memory for this tenant"}
    try:
        conn = sqlite3.connect(db, timeout=5)
        conn.execute(CORRECTIONS_DDL)
        if not conn.execute("SELECT 1 FROM claims WHERE id=?", (claim_id,)).fetchone():
            conn.close()
            return 404, {"ok": False, "error": "unknown claim"}
        # one pending correction per claim: a new mark supersedes the old unprocessed one
        conn.execute("DELETE FROM user_corrections WHERE claim_id=? AND processed=0", (claim_id,))
        rid = None
        if action != "undo":
            rid = conn.execute(
                "INSERT INTO user_corrections (claim_id, action, text, created_at, processed, origin) "
                "VALUES (?,?,?,?,0,'member')",     # typed by the member: the only top-tier source
                (claim_id, action, text, dt.datetime.now().isoformat(timespec="seconds"))).lastrowid
        conn.commit()
        conn.close()
        return 200, {"ok": True, "id": rid}
    except sqlite3.Error as e:
        return 500, {"ok": False, "error": str(e)}


def load_knows(tenant: str) -> dict:
    db = claims_db(tenant)
    out = {"groups": [], "total": 0, "quiet": 0, "tensions": [], "obligations": [], "has_db": db.exists()}
    if not db.exists():
        return out
    corrections = load_corrections(db)
    base = ("FROM claims WHERE COALESCE(status,'active')!='retired' AND COALESCE(graded,'')!='demote'")
    out["total"] = (_rows(db, f"SELECT COUNT(*) {base}") or [(0,)])[0][0]
    out["quiet"] = (_rows(db, f"SELECT COUNT(*) {base} AND type='possession'") or [(0,)])[0][0]

    # extractors keep minting new types (work, passion, ...) — anything unmapped is a who-you-are read
    all_types = {r[0] for r in _rows(db, f"SELECT DISTINCT type {base}")}
    mapped = {t for _, ts in GROUPS for t in ts} | {"possession"}
    groups = [(label, tuple(types) + (tuple(sorted(all_types - mapped)) if label == "who you are" else ()))
              for label, types in GROUPS]

    for label, types in groups:
        q = ",".join("?" * len(types))
        rows = _rows(db,
                     f"SELECT id, statement, level, confidence, evidence, first_seen {base} "
                     f"AND type IN ({q}) ORDER BY (level!='frame') DESC, COALESCE(salience,0.25) DESC, "
                     f"confidence DESC LIMIT {POOL}", list(types))
        picked, picked_words = [], []
        for cid, stmt, level, conf, ev, first in rows:
            w = _words(stmt)
            if any(_similar(w, pw) > 0.5 for pw in picked_words):
                continue
            try:
                nsig = len(json.loads(ev))
            except (json.JSONDecodeError, TypeError):
                nsig = 0
            picked.append({"id": cid, "statement": stmt, "level": level, "conf": conf, "signals": nsig,
                           "since": _since(first), "corr": corrections.get(cid)})
            picked_words.append(w)
            if len(picked) >= GROUP_CAP:
                break
        held = max(0, len(rows) - len(picked)) if len(rows) >= POOL else \
            (_rows(db, f"SELECT COUNT(*) {base} AND type IN ({q})", list(types)) or [(0,)])[0][0] - len(picked)
        out["groups"].append({"label": label, "claims": picked, "held": max(0, held)})

    out["tensions"] = [{"note": n, "conf": c} for c, n in _rows(
        db, "SELECT r.confidence, r.note FROM relations r WHERE r.kind='contradicts' AND r.note!='' "
            "ORDER BY r.confidence DESC LIMIT 4")]
    shown = {c["statement"] for g in out["groups"] if g["label"] == "commitments" for c in g["claims"]}
    out["obligations"] = [
        {"statement": s, "seen": _since(lv).replace("since", "seen")} for s, lv in _rows(
            db, f"SELECT statement, last_verified {base} AND type='obligation' AND level!='frame' "
                f"ORDER BY COALESCE(last_verified,'') DESC LIMIT 20")
        if s not in shown][:8]
    return out


def load_threads(tenant: str, knows: dict) -> dict:
    themes = {}
    for s in load_sends(tenant):
        t = s["theme"]
        if t in ("", "other"):
            continue
        th = themes.setdefault(t, {"count": 0, "last": None, "lines": 0})
        th["count"] += 1
        th["lines"] += 1 if s["tier"] == "line" else 0
        if s["ts"] and (th["last"] is None or s["ts"] > th["last"]):
            th["last"] = s["ts"]
    topics = [{"name": k.replace("-", " "), **v} for k, v in
              sorted(themes.items(), key=lambda kv: kv[1]["count"], reverse=True)]
    return {"topics": topics, "obligations": knows.get("obligations", [])}


# ── rendering ────────────────────────────────────────────────────────────────────────────────────
def esc(s) -> str:
    return html.escape(str(s or ""), quote=True)


def _fmt_day(d: dt.date) -> str:
    return d.strftime("%A, %B %-d").lower()


def _fmt_time(ts: dt.datetime) -> str:
    return ts.strftime("%-I:%M %p").lower()


def _fmt_short(ts) -> str:
    return ts.strftime("%b %-d").lower() if ts else ""


def _link_card(item) -> str:
    """Editorial link card: title from the enrichment, host from the url, yt thumb when derivable."""
    text, link = item.get("text", ""), item.get("link") or ""
    url = next(iter(URL_RE.findall(text)), None) or next(iter(URL_RE.findall(link)), None)
    title = author = host = ""
    if link:
        if "instagram reel" in link:
            title, author = "instagram reel", "not read yet"
        else:
            m = SHARED_RE.search(link) or re.match(r"\[shared:\s*(.*?)\]\s*$", link, re.S)
            inner = m.group(1).strip() if m else link.strip("[]")
            parts = [p.strip() for p in inner.split(" — ") if p.strip()]
            if parts:
                title = parts[0]
                author = next((p for p in parts[1:] if p.lower().startswith("by ")), "")
    if url:
        try:
            host = re.sub(r"^www\.", "", url.split("/")[2])
        except IndexError:
            host = ""
    if not (url or title):
        return ""
    thumb = ""
    yt = YT_RE.search(url or "")
    if yt:
        thumb = f'<img class="thumb" src="https://i.ytimg.com/vi/{esc(yt.group(1))}/hqdefault.jpg" alt="" loading="lazy">'
    title_html = f'<span class="lt">{esc(title[:120])}</span>' if title else f'<span class="lt">{esc(host)}</span>'
    meta = " · ".join(x for x in (esc(author), esc(host)) if x)
    body = f'{thumb}<span class="lbody">{title_html}{f"<span class=lmeta>{meta}</span>" if meta else ""}</span>'
    return (f'<a class="linkcard" href="{esc(url)}">{body}</a>' if url
            else f'<span class="linkcard">{body}</span>')


def _strip_urls(text: str) -> str:
    return re.sub(r"\s{2,}", " ", URL_RE.sub("", text or "")).strip()


def _reaction_html(item) -> str:
    tier, reaction = item.get("tier"), item.get("reaction", "")
    if tier == "line" and reaction:
        return f'<p class="re line"><span class="who">co</span>{esc(reaction)}</p>'
    if tier == "light" and reaction:
        return f'<p class="re light"><span class="who">co</span>{esc(reaction)}</p>'
    if tier in ("none", "silent"):
        return '<p class="re quiet">co stayed quiet</p>'
    return ""


def render_feed(feed: list, transcript: list) -> str:
    if not feed and not transcript:
        return '<p class="empty">nothing sent yet. text co something you scrolled past.</p>'
    out, day = [], None
    for it in feed:
        d = it["ts"].date() if it["ts"] else None
        if d != day:
            day = d
            out.append(f'<h3 class="day">{esc(_fmt_day(d)) if d else "undated"}</h3>')
        q = it.get("q")
        ask = f'<p class="ask">asked: {esc(q)}</p>' if q and str(q).lower() not in ("thought", "none") else ""
        when = f'<span class="when">{esc(_fmt_time(it["ts"]))}</span>' if it["ts"] else ""
        body = esc(_strip_urls(it["text"])) or '<span class="only">(a link)</span>'
        out.append(f'<article class="item">{ask}<p class="sent">{body}{when}</p>'
                   f'{_link_card(it)}{_reaction_html(it)}</article>')
    if transcript:
        out.append('<h3 class="day">earlier, in conversation</h3>')
        convo_day = None
        for m in transcript[-40:]:
            role = "you" if m.get("role") == "user" else "co"
            # transcript turns carry ts since 7/2 (and proactive sends are tagged via=proactive) — show them
            mts = _parse_ts(m.get("ts"))
            if mts and mts.date() != convo_day:
                convo_day = mts.date()
                out.append(f'<h3 class="day">{esc(_fmt_day(convo_day))}</h3>')
            when = f'<span class="when">{esc(_fmt_time(mts))}</span>' if mts else ""
            via = ' <span class="who">(reached out)</span>' if m.get("via", "").startswith("proactive") else ""
            out.append(f'<article class="item convo"><p class="{ "sent" if role == "you" else "re line" }">'
                       f'<span class="who">{role}</span>{via}{esc(m.get("content", ""))}{when}</p></article>')
    return "\n".join(out)


def _claim_li(c: dict) -> str:
    """One claim row with its quiet actions. State comes from the corrections overlay:
    'wrong' = struck + noted, 'edit' = the user's text shown as pending."""
    meta = " · ".join(x for x in (
        _conf_word(c["conf"], c["level"]),
        f'{c["signals"]} signal{"s" if c["signals"] != 1 else ""}' if c["signals"] else "",
        c["since"]) if x)
    stmt = c["statement"]
    if len(stmt) > 200:
        stmt = stmt[:200].rsplit(" ", 1)[0] + "…"
    corr = c.get("corr") or {}
    state = {"wrong": "wrong", "edit": "edited"}.get(corr.get("action"), "")
    tag = {"wrong": "noted", "edited": "pending"}.get(state, "")
    pend = corr.get("text", "") if state == "edited" else ""
    return (f'<li class="cl {state}" data-id="{c["id"]}">'
            f'<span class="stmt">{esc(stmt)}</span>'
            f'<span class="pend">{esc(pend)}</span>'
            f'<span class="cmeta">{esc(meta)}</span>'
            f'<span class="acts"><span class="tag">{tag}</span>'
            f'<a class="act a-wrong" role="button">not right</a>'
            f'<a class="act a-edit" role="button">edit</a>'
            f'<a class="act a-undo" role="button">undo</a></span>'
            f'<span class="editrow"><input class="ebox" type="text" maxlength="500" '
            f'placeholder="say it right">'
            f'<a class="act a-save" role="button">save</a>'
            f'<a class="act a-cancel" role="button">cancel</a></span></li>')


def render_knows(k: dict) -> str:
    if not k["has_db"] or not k["total"]:
        return '<p class="empty">co is still listening. nothing written down yet.</p>'
    parts = [f'<p class="note">{k["total"]:,} observations held. the ones that matter, below. '
             'anything off? mark it not right, or edit it. co takes the correction.</p>']
    for g in k["groups"]:
        if not g["claims"]:
            continue
        parts.append(f'<h3 class="grp">{esc(g["label"])}</h3><ul class="claims">')
        for c in g["claims"]:
            parts.append(_claim_li(c))
        parts.append("</ul>")
        if g["held"] > 0:
            parts.append(f'<p class="held">and {g["held"]:,} more, held quietly.</p>')
    if k["quiet"]:
        parts.append(f'<p class="held">plus {k["quiet"]:,} smaller observations (things owned, places ordered from) '
                     'kept but not worth the page.</p>')
    if k["tensions"]:
        parts.append('<h3 class="grp">held in tension</h3><ul class="tensions">')
        for t in k["tensions"]:
            parts.append(f'<li>{esc(t["note"])}</li>')
        parts.append("</ul>")
    return "\n".join(parts)


def render_threads(th: dict) -> str:
    parts = []
    if th["topics"]:
        parts.append('<h3 class="grp">open topics</h3><ul class="topics">')
        for t in th["topics"]:
            last = f'last {_fmt_short(t["last"])}' if t["last"] else ""
            meta = " · ".join(x for x in (
                f'{t["count"]} send{"s" if t["count"] != 1 else ""}',
                f'{t["lines"]} line{"s" if t["lines"] != 1 else ""} said' if t["lines"] else "", last) if x)
            parts.append(f'<li><span class="stmt">{esc(t["name"])}</span><span class="cmeta">{esc(meta)}</span></li>')
        parts.append("</ul>")
    if th["obligations"]:
        parts.append('<h3 class="grp">commitments on the books</h3><ul class="claims">')
        for o in th["obligations"]:
            parts.append(f'<li><span class="stmt">{esc(o["statement"])}</span>'
                         f'<span class="cmeta">{esc(o["seen"])}</span></li>')
        parts.append("</ul>")
    if not parts:
        return '<p class="empty">no open threads. clean slate.</p>'
    return "\n".join(parts)


CSS = """
:root{--paper:#f6f4ee;--ink:#191611;--muted:#8b8375;--hair:#ddd7ca;--accent:#bd340f}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{background:var(--paper);color:var(--ink);font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
 font-size:17px;line-height:1.55;padding:28px 20px 80px;max-width:41rem;margin:0 auto;
 overflow-wrap:break-word}
a{color:inherit}
.brand{font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:var(--accent);font-weight:600}
h1{font-size:34px;line-height:1.1;font-weight:500;margin:10px 0 6px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:14px;font-style:italic}
nav{margin:22px 0 8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase}
nav a{color:var(--muted);text-decoration:none;margin-right:18px;border-bottom:1px solid var(--hair);padding-bottom:2px}
nav a:active{color:var(--accent)}
section{margin-top:44px}
h2{font-size:13px;letter-spacing:.22em;text-transform:uppercase;font-weight:600;
 border-top:1px solid var(--ink);padding-top:10px}
h2 .num{color:var(--accent);margin-right:10px}
.day{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);
 margin:30px 0 4px;font-weight:500}
.item{padding:14px 0;border-bottom:1px solid var(--hair)}
.item:last-child{border-bottom:none}
.sent{font-size:18px;line-height:1.45}
.when{color:var(--muted);font-size:12px;font-style:normal;margin-left:10px;white-space:nowrap;
 letter-spacing:.06em}
.ask{color:var(--muted);font-size:13px;font-style:italic;margin-bottom:3px}
.only{color:var(--muted);font-style:italic}
.linkcard{display:flex;gap:12px;align-items:center;border:1px solid var(--hair);padding:10px 12px;
 margin:10px 0 2px;text-decoration:none;background:rgba(255,255,255,.45)}
.thumb{width:76px;height:57px;object-fit:cover;filter:grayscale(1) contrast(1.05);flex:none}
.lbody{display:flex;flex-direction:column;gap:2px;min-width:0}
.lt{font-style:italic;font-size:15px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;
 -webkit-box-orient:vertical;overflow:hidden}
.lmeta{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.re{margin-top:9px;font-size:16px}
.re .who{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);
 margin-right:10px;font-style:normal}
.re.line{color:var(--accent)}
.re.light{font-size:18px}
.re.quiet{color:var(--muted);font-size:12px;font-style:italic;letter-spacing:.04em}
.convo{padding:8px 0}
.note{color:var(--muted);font-size:14px;font-style:italic;margin-top:12px}
.grp{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);
 margin:28px 0 6px;font-weight:600}
.claims,.topics,.tensions{list-style:none}
.claims li,.topics li{padding:10px 0;border-bottom:1px solid var(--hair)}
.claims li:last-child,.topics li:last-child{border-bottom:none}
.stmt{display:block;font-size:16px;line-height:1.4}
.cmeta{display:block;margin-top:3px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
 color:var(--muted)}
.tensions li{padding:10px 0 10px 14px;border-left:2px solid var(--accent);margin:10px 0;
 font-size:16px;line-height:1.45;font-style:italic}
.held{color:var(--muted);font-size:13px;font-style:italic;margin:8px 0 0}
.empty{color:var(--muted);font-style:italic;margin-top:14px}
footer{margin-top:60px;border-top:1px solid var(--ink);padding-top:10px;color:var(--muted);
 font-size:12px;font-style:italic}
/* editable memory: quiet text links, generous tap targets, no buttons, no modals */
.acts{display:block;margin-top:2px}
.act{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);
 text-decoration:none;border-bottom:1px solid var(--hair);cursor:pointer;
 display:inline-block;padding:8px 2px;margin-right:16px;-webkit-tap-highlight-color:transparent}
.act:active{color:var(--accent);border-bottom-color:var(--accent)}
.tag{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);
 display:inline-block;padding:8px 2px;margin-right:16px;font-style:italic}
.tag:empty{display:none}
.a-undo{display:none}
.cl.wrong .a-wrong,.cl.wrong .a-edit,.cl.edited .a-wrong{display:none}
.cl.wrong .a-undo,.cl.edited .a-undo{display:inline-block}
.cl.wrong .stmt{text-decoration:line-through;color:var(--muted)}
.pend{display:none}
.cl.edited .stmt{text-decoration:line-through;color:var(--muted);font-size:13px}
.cl.edited .pend{display:block;font-size:16px;line-height:1.4;font-style:italic;margin-top:2px}
.editrow{display:none;margin-top:6px}
.cl.editing .editrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cl.editing .acts{display:none}
.ebox{flex:1 1 12rem;min-width:0;font-family:inherit;font-size:16px;font-style:italic;
 color:var(--ink);background:rgba(255,255,255,.6);border:1px solid var(--hair);
 border-radius:0;padding:10px 10px;outline:none}
.ebox:focus{border-color:var(--accent)}
"""

JS = """
(function(){
  var correct = function(body){
    return fetch(location.pathname.replace(/\\/+$/,'') + '/correct', {method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})
      .then(function(r){ if(!r.ok) throw new Error('save failed'); return r.json(); });
  };
  var setState = function(li, s){
    li.classList.remove('wrong','edited','editing');
    if (s) li.classList.add(s);
    li.querySelector('.tag').textContent = s === 'wrong' ? 'noted' : s === 'edited' ? 'pending' : '';
  };
  document.addEventListener('click', function(e){
    var a = e.target.closest('.act');
    if (!a) return;
    e.preventDefault();
    var li = a.closest('li[data-id]');
    if (!li) return;
    var id = parseInt(li.dataset.id, 10);
    if (a.classList.contains('a-wrong')) {
      correct({claim_id:id, action:'wrong'}).then(function(){ setState(li,'wrong'); }).catch(function(){});
    } else if (a.classList.contains('a-undo')) {
      correct({claim_id:id, action:'undo'}).then(function(){ setState(li,''); }).catch(function(){});
    } else if (a.classList.contains('a-edit')) {
      li.classList.add('editing');
      var box = li.querySelector('.ebox');
      box.value = li.classList.contains('edited') ? li.querySelector('.pend').textContent
                                                  : li.querySelector('.stmt').textContent;
      box.focus();
    } else if (a.classList.contains('a-cancel')) {
      li.classList.remove('editing');
    } else if (a.classList.contains('a-save')) {
      var t = li.querySelector('.ebox').value.trim();
      if (!t) { li.classList.remove('editing'); return; }
      correct({claim_id:id, action:'edit', text:t}).then(function(){
        li.querySelector('.pend').textContent = t;
        setState(li,'edited');
      }).catch(function(){});
    }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('ebox')) {
      e.preventDefault();
      var li = e.target.closest('li[data-id]');
      if (li) li.querySelector('.a-save').click();
    }
  });
})();
"""


def render_recs_provenance(tenant: str) -> str:
    """Debug view of what's actually being served as recs, with full provenance (verbatim title, author,
    the resolving source URL, the generated why, verified flag) so a rec can be independently spot-checked."""
    cache = _load_recs_cache(claims_db(tenant))
    recs = cache.get("recs", [])
    if not recs:
        return '<p class="empty">no recs — restraint (zero rather than an ungrounded source).</p>'
    rows = []
    for r in recs:
        u = esc(r.get("url", ""))
        who = f' · {esc(r.get("author",""))}' if r.get("author") else ""
        flag = "verified ✓" if r.get("verified") else "UNVERIFIED"
        rows.append(
            f'<div style="padding:12px 0;border-bottom:1px solid var(--line)">'
            f'<div><b>{esc(r.get("title",""))}</b>{who}</div>'
            f'<div style="color:var(--muted);font-style:italic">{esc(r.get("why",""))}</div>'
            f'<div style="font-size:13px;margin-top:4px">'
            f'<a href="{u}" target="_blank" rel="noopener">{u}</a>'
            f' · thread: {esc(r.get("topic",""))} · source: {esc(r.get("source","?"))} · {flag}</div></div>')
    return '<div class="recs-prov">' + "\n".join(rows) + "</div>"


def render_ops(tenant: str) -> str:
    """The founder/debug dashboard — the dense record with the correction UI, sim-adjacent internals, and
    the full feed. Lives at /v/<token>/ops (off the calm house)."""
    knows = load_knows(tenant)
    feed = build_feed(tenant)
    transcript = load_transcript(tenant)
    threads = load_threads(tenant, knows)
    name = display_name(tenant)
    n_sends = len(feed)
    dates = [i["ts"] for i in feed if i["ts"]]
    span = f"since {_fmt_short(min(dates))}" if dates else ""
    subbits = " · ".join(x for x in (
        f"{n_sends} send{'s' if n_sends != 1 else ''}" if n_sends else "",
        f"{knows['total']:,} things held" if knows["total"] else "", span) if x)
    now = dt.datetime.now().strftime("%B %-d, %Y · %-I:%M %p").lower()
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>co · the record</title>
<style>{CSS}</style></head>
<body>
<header>
  <div class="brand">co · the record</div>
  <h1>{esc(name)}</h1>
  <p class="sub">{esc(subbits) or "a private page. read-only."}</p>
  <nav><a href="#feed">the feed</a><a href="#knows">what co knows</a><a href="#threads">threads</a><a href="#recs">recs</a></nav>
</header>
<section id="feed"><h2><span class="num">i</span>the feed</h2>
{render_feed(feed, transcript)}
</section>
<section id="knows"><h2><span class="num">ii</span>what co knows</h2>
{render_knows(knows)}
</section>
<section id="threads"><h2><span class="num">iii</span>threads</h2>
{render_threads(threads)}
</section>
<section id="recs"><h2><span class="num">iv</span>recommendations · provenance</h2>
{render_recs_provenance(tenant)}
</section>
<footer>co wrote this. correct it right here, or just by talking. compiled {esc(now)}.</footer>
<script>{JS}</script>
</body></html>"""


# ════════════════════════════════════════════════════════════════════════════════════════════════
#  THE HOUSE — the calm, user-facing page (house_template.html wired to real per-tenant data)
#  Zero debug internals here; sim/tier/ledger live at /ops. Every {{ }} slot filled from the stores.
# ════════════════════════════════════════════════════════════════════════════════════════════════

# Verbatim from house_template.html <style> — the design IS the spec; do not redesign.
HOUSE_CSS = """
:root{
  --paper:#FAF8F3; --paper-2:#F2EEE5; --card:#FFFFFF;
  --butter:#F7EFCF; --butter-ink:#4A4225;
  --ink:#201D18; --muted:#8C857A; --faint:#B4AC9F;
  --line:#E8E3D8; --accent:#35544B; --accent-soft:#7E9A84;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;
  --shadow:0 1px 2px rgba(32,29,24,.03),0 10px 26px -16px rgba(32,29,24,.14);
  --shadow-lift:0 2px 4px rgba(32,29,24,.05),0 18px 34px -18px rgba(32,29,24,.20);
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper)}
.app{min-height:100vh;color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}

.topbar{display:flex;align-items:center;gap:20px;padding:22px clamp(20px,5vw,56px);border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(250,248,243,.86);backdrop-filter:saturate(1.2) blur(10px);z-index:5}
.wordmark{font-family:var(--serif);font-size:23px;letter-spacing:.01em}
.wordmark .dot{color:var(--accent)}
.search{flex:1;max-width:420px;margin:0 auto;font-family:var(--serif);font-style:italic;font-size:16px;color:var(--faint);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:9px 16px}
.avatar{width:32px;height:32px;border-radius:50%;flex:none;background:linear-gradient(150deg,#c9b7a2,#8a7a63);box-shadow:inset 0 0 0 1px rgba(255,255,255,.4)}

.house{max-width:1180px;margin:0 auto;padding:clamp(28px,5vw,52px) clamp(20px,5vw,56px) 80px}
.lede{margin-bottom:34px}
.lede h1{font-family:var(--serif);font-style:italic;font-weight:400;font-size:clamp(30px,5vw,46px);line-height:1.05;margin:0 0 10px;letter-spacing:-.01em;text-wrap:balance}
.lede p{margin:0;color:var(--muted);font-size:14.5px}
.lede p .sep{color:var(--faint);margin:0 8px}

.layout{display:grid;grid-template-columns:1fr;gap:44px}
@media(min-width:1000px){.layout{grid-template-columns:minmax(0,1fr) 296px}}

.gallery{column-count:2;column-gap:22px}
@media(max-width:560px){.gallery{column-count:1}}
.card{break-inside:avoid;margin:0 0 22px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden;transition:transform .22s ease,box-shadow .22s ease}
.card:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift)}
.card .body{padding:20px 21px}
.label{display:flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);font-weight:600;margin-top:14px}
.label .tick{width:5px;height:5px;border-radius:50%;background:var(--accent-soft);flex:none}

.note{background:var(--butter);border-color:#EDE2BE}
.note .line{font-family:var(--serif);font-style:italic;font-size:19px;line-height:1.34;color:var(--butter-ink)}
.note .label{color:#9c8f66}
.note .label .tick{background:#c8b56f}

.thing{display:flex;gap:15px}
.cover{width:58px;height:80px;border-radius:5px;flex:none;box-shadow:0 6px 16px -8px rgba(32,29,24,.5);display:flex;align-items:flex-end;padding:8px;font-family:var(--serif);font-size:10.5px;line-height:1.15;color:#fff}
.cover.book{background:linear-gradient(150deg,#5b6b60,#2f3d35)}
.cover.song{background:linear-gradient(150deg,#b98a86,#5f3f4a);align-items:center;justify-content:center;padding:0}
.cover.song svg{width:24px;height:24px;opacity:.92}
.thing h3{margin:0 0 5px;font-size:15px;font-weight:600;letter-spacing:-.01em}
.thing p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.45}

.photo{position:relative}
.photo .tile{aspect-ratio:4/5;width:100%;display:block;object-fit:cover}
.photo .cap{position:absolute;left:0;right:0;bottom:0;padding:16px 17px 14px;color:#fff;font-size:12.5px;letter-spacing:.02em;background:linear-gradient(to top,rgba(20,17,13,.62),rgba(20,17,13,0))}
.photo .cap b{font-weight:600}

.link .kicker{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:7px}
.link h3{margin:0 0 9px;font-size:15.5px;font-weight:600;letter-spacing:-.01em}
.link p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.5}

/* recommendation — seamless: same card as a sent-thing, the only tell is a quiet spruce "why" */
.why{display:flex;align-items:flex-start;gap:6px;font-size:12.5px;color:var(--accent);line-height:1.4;margin-top:13px;font-weight:500}
.why .spark{width:13px;height:13px;flex:none;margin-top:1px}
.dismiss{margin-top:9px;font-size:11px;color:var(--faint);letter-spacing:.05em;opacity:0;transition:opacity .2s;cursor:pointer;-webkit-tap-highlight-color:transparent}
.card.rec:hover .dismiss{opacity:.9}
@media(hover:none){.dismiss{opacity:.55}}

.thread .body{display:flex;flex-direction:column;gap:11px}
.thread h3{margin:0;font-family:var(--serif);font-size:19px;font-weight:400;letter-spacing:-.01em}
.thread p{margin:0;color:var(--muted);font-size:13.5px}
.chip{align-self:flex-start;font-size:11px;letter-spacing:.05em;color:var(--accent);background:#EAF0EC;border:1px solid #D6E3DA;padding:3px 10px;border-radius:20px;font-weight:600}

.moment .body{display:flex;flex-direction:column;gap:9px}
.bubble{font-size:13.5px;line-height:1.45;padding:9px 13px;border-radius:13px;max-width:88%}
.bubble.you{align-self:flex-end;background:var(--paper-2);color:var(--ink);border-bottom-right-radius:5px}
.bubble.co{align-self:flex-start;background:var(--accent);color:#F4F1E9;border-bottom-left-radius:5px}

.rail{display:flex;flex-direction:column;gap:32px}
.rail h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:0 0 15px}
.threads{display:flex;flex-direction:column;gap:2px}
.trow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line)}
.trow:first-child{border-top:none}
.trow .t{font-family:var(--serif);font-size:16px;letter-spacing:-.01em}
.trow .d{font-size:11.5px;color:var(--faint);letter-spacing:.03em;flex:none;font-variant-numeric:tabular-nums}

.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:5px 4px}
.cal .dow{font-size:10px;color:var(--faint);text-align:center;font-weight:600;letter-spacing:.03em;padding-bottom:3px}
.cal .day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--muted);border-radius:8px;font-variant-numeric:tabular-nums}
.cal .day.on{background:var(--accent);color:#F4F1E9;font-weight:600}
.cal .day.today{box-shadow:inset 0 0 0 1.5px var(--accent);color:var(--ink);font-weight:600}
.cal .day.mute{color:var(--faint);opacity:.5}

.railnote{font-size:12.5px;color:var(--faint);line-height:1.5;padding-top:20px;border-top:1px solid var(--line)}

/* editable memory — quiet per-card action, revealed on hover/tap (matches .dismiss treatment) */
.forget{margin-top:11px;font-size:11px;color:var(--faint);letter-spacing:.05em;opacity:0;transition:opacity .2s;cursor:pointer;-webkit-tap-highlight-color:transparent;font-family:var(--sans)}
.card:hover .forget{opacity:.85}
@media(hover:none){.forget{opacity:.5}}
.note .forget{color:#a99a63}
.photo .forget{position:absolute;top:12px;right:14px;margin:0;color:#fff;opacity:0;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.photo:hover .forget{opacity:.85}
.card.gone{display:none}
.card .done{margin-top:11px;font-size:11px;color:var(--accent-soft);letter-spacing:.05em;font-style:italic;display:none}
.card.forgotten .forget{display:none}
.card.forgotten .done{display:block}

a{color:inherit}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
"""

HOUSE_JS = """
(function(){
  var base = location.pathname.replace(/\\/+$/,'');
  function post(path, body){
    return fetch(base + path, {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)}).then(function(r){ if(!r.ok) throw 0; return r.json(); });
  }
  document.addEventListener('click', function(e){
    var f = e.target.closest('.forget');
    if (f){ e.preventDefault();
      var card = f.closest('.card'); var cid = card && card.getAttribute('data-cid');
      if (!cid) return;
      post('/correct', {claim_id: parseInt(cid,10), action:'wrong'})
        .then(function(){ card.classList.add('forgotten'); }).catch(function(){});
      return;
    }
    var d = e.target.closest('.dismiss');
    if (d){ e.preventDefault();
      var card = d.closest('.card');
      post('/rec_dismiss', {topic: card.getAttribute('data-topic')||'', url: card.getAttribute('data-url')||''})
        .then(function(){ card.classList.add('gone'); }).catch(function(){ card.classList.add('gone'); });
    }
  });
})();
"""

_COVER_GRADS = ["linear-gradient(150deg,#5b6b60,#2f3d35)", "linear-gradient(150deg,#6b5f76,#3a2f4a)",
                "linear-gradient(150deg,#7a6a53,#3d3325)", "linear-gradient(150deg,#4a6570,#28414a)",
                "linear-gradient(150deg,#8a6a5a,#4a2f28)"]


def _grad(seed: str) -> str:
    return _COVER_GRADS[sum(ord(c) for c in (seed or "x")) % len(_COVER_GRADS)]


PHOTO_RE = re.compile(r"\[(photo they sent|screenshot/image they sent|screenshot)"
                      r"(?:\s*\(([^)]*)\))?\s*:\s*(.*?)\]\s*$", re.S)
BOOK_TITLE_RE = re.compile(r'titled\s+"([^"]{2,80})"', re.I)


def _title(s: str, n: int = 64) -> str:
    """A display title: strip URLs, collapse whitespace, cap at a word boundary."""
    s = re.sub(r"https?://\S+", "", s or "").strip()
    s = re.sub(r"\s+", " ", s).strip(" -–—:")
    if len(s) > n:
        s = s[:n].rsplit(" ", 1)[0].rstrip(",:;") + "…"
    return s


def _clean_desc(d: str, limit: int = 90) -> str:
    d = re.sub(r"^\s*(this (image|photo|screenshot) (shows|is|depicts)|the image shows|a photo of|an image of)\s+",
               "", (d or "").strip(), flags=re.I)
    d = re.sub(r"\s+", " ", d).strip().strip(".")
    if len(d) > limit:
        d = d[:limit].rsplit(" ", 1)[0] + "…"
    return d[:1].upper() + d[1:] if d else ""


def _claim_id_for(db: Path, statement: str):
    if not statement:
        return None
    r = _rows(db, "SELECT id FROM claims WHERE statement=? LIMIT 1", (statement,))
    return r[0][0] if r else None


def _rel_when(ts) -> str:
    if not ts:
        return ""
    now = dt.datetime.now()
    secs = (now - ts).total_seconds()
    if secs < 0:
        return "just now"
    if secs < 3600:
        m = max(1, int(secs // 60))
        return f"{m}m ago"
    if secs < 12 * 3600 and ts.date() == now.date():
        h = int(secs // 3600)
        return f"{h}h ago"
    if ts.date() == now.date():
        return "earlier today"
    if ts.date() == (now.date() - dt.timedelta(days=1)):
        return "yesterday"
    days = (now.date() - ts.date()).days
    if days < 7:
        return f"{days}d ago"
    return ts.strftime("%b %-d").lower()


# ── the house's threads come from threads.json (the rich Gemini topics), not co_sends themes ──────
def load_threads_json(tenant: str) -> dict:
    """The rolling open-threads state the engine maintains: real topics in the user's own terms
    ('cultish & post roe books', 'solitude & co-creation') + stated commitments, each with a last-seen
    date for decay. This is what the house rail, thread cards, AND recs are earned from."""
    p = Path(str(claims_db(tenant)) + ".threads.json")
    try:
        st = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return {"topics": [], "commitments": []}
    topics = []
    for t in st.get("topics", []):
        label = (t.get("label") or "").strip()
        if not label:
            continue
        try:
            last = dt.datetime.combine(dt.date.fromisoformat(str(t.get("last"))[:10]), dt.time())
        except (ValueError, TypeError):
            last = None
        topics.append({"name": label, "count": int(t.get("count", 1) or 1), "last": last, "lines": 0})
    commits = [{"text": (c.get("text") or "").strip(), "due": c.get("due")} for c in st.get("commitments", [])
               if (c.get("text") or "").strip()]
    return {"topics": topics, "commitments": commits}


# ── card curation: surface the salient, never dump all 27k ──────────────────────────────────────
def _norm_line(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (t or "").lower()).strip()


def curate_cards(tenant: str, token: str) -> dict:
    """Build the house's card streams from real per-tenant data, curated (recent/salient, deduped)."""
    db = claims_db(tenant)
    sends = load_sends(tenant)
    transcript = load_transcript(tenant)
    corr = load_corrections(db)
    media_names = media_store.list_media(tenant)
    media_i = [0]

    notes, things, photos, links, moments = [], [], [], [], []
    seen_lines = set()

    for s in sorted(sends, key=lambda x: x["ts"] or dt.datetime.min, reverse=True):
        send, tier, reaction = s["send"], s["tier"], s["reaction"]
        when = _rel_when(s["ts"])
        cid = _claim_id_for(db, s["matched"]) if s.get("matched") else None
        pm = PHOTO_RE.search(send)
        url = next(iter(URL_RE.findall(send)), None)
        booktitle = BOOK_TITLE_RE.search(send) if pm else None

        if url or "[shared:" in send:              # a shared link / video / tweet (wins over an incidental
            m = re.search(r"\[shared:\s*(.*?)\]", send, re.S)   # first shared bracket only (non-greedy)
            inner = (m.group(1).strip() if m else "").split(" — ")
            title = inner[0] if inner and inner[0] else (re.sub(r"^www\.", "", url.split("/")[2]) if url else "a link")
            title = re.sub(r"^(tweet|reel|video|post) by @?\w+:\s*", "", title, flags=re.I)
            title = title.split("[")[0]            # drop any trailing bracketed enrichment
            kind = ("video" if YT_RE.search(url or "") else "tweet" if "x.com" in (url or "") or "twitter" in (url or "")
                    else "reel" if "instagram" in (url or "") else "link")
            links.append({"title": _title(title, 72), "read": reaction or (inner[1] if len(inner) > 1 else ""),
                          "kind": kind, "when": when, "url": url or "", "cid": cid})
        elif pm and booktitle:                     # a photographed book → a sent-thing (book cover)
            things.append({"title": booktitle.group(1), "read": reaction or _clean_desc(pm.group(3), 120),
                           "when": when, "kind": "book", "cid": cid})
        elif pm:                                   # a photo / screenshot → photo tile
            title = _clean_desc(pm.group(3))
            captime = (pm.group(2) or "").strip()  # EXIF place/time (never coordinates — _exif_context excludes)
            murl = f"/v/{token}/media/{media_names[media_i[0]]}" if media_i[0] < len(media_names) else ""
            if murl:
                media_i[0] += 1
            photos.append({"title": title or "a moment", "cap": captime, "url": murl,
                           "grad": _grad(title), "when": when, "cid": cid})
        elif send.lstrip().startswith("#"):        # a document they pasted (the Co- essay)
            first = re.sub(r"^#+\s*", "", send.strip().splitlines()[0])[:60]
            things.append({"title": first or "a note", "read": reaction or "", "when": when,
                           "kind": "book", "cid": cid})
        elif tier == "line" and reaction:          # the memorable line Co said (hero content)
            k = _norm_line(reaction)
            if k and k not in seen_lines:
                seen_lines.add(k)
                notes.append({"text": reaction, "when": when, "cid": cid})

    # moments: real self-contained exchanges (a good user turn + a substantive co reply)
    for i in range(len(transcript) - 1):
        u, a = transcript[i], transcript[i + 1]
        if u.get("role") != "user" or a.get("role") != "assistant":
            continue
        ut, at = (u.get("content") or "").strip(), (a.get("content") or "").strip()
        if not (8 <= len(ut) <= 120 and 24 <= len(at) <= 180):
            continue
        if ut.startswith(("[", "#")) or at.lower().startswith(("wrong read", "can't", "still not")):
            continue
        if "?" not in ut and len(ut) < 20:
            continue
        moments.append({"you": ut, "co": at, "when": _rel_when(_parse_ts(a.get("ts")))})

    # de-noise moments: keep the 2 richest, drop near-duplicates of a shown note
    moments = sorted(moments, key=lambda m: len(m["co"]), reverse=True)[:2]

    return {"notes": notes[:6], "things": things[:3], "photos": photos[:2],
            "links": links[:2], "moments": moments, "corr": corr}


# ── recommendations: rare, earned by a live thread, sourced fetch-first, cached, refusable ────────
def _recs_cache_path(db: Path) -> Path:
    return Path(str(db) + ".viewer_recs.json")


def _load_recs_cache(db: Path) -> dict:
    try:
        return json.loads(_recs_cache_path(db).read_text())
    except (OSError, json.JSONDecodeError):
        return {"ts": 0, "recs": [], "dismissed": []}


def _save_recs_cache(db: Path, cache: dict):
    try:
        tmp = Path(str(_recs_cache_path(db)) + ".tmp")
        tmp.write_text(json.dumps(cache))
        os.replace(tmp, _recs_cache_path(db))
    except OSError:
        pass


# ── rec sourcing: GROUNDED FACTS, GENERATED WHY ────────────────────────────────────────────────────
#  Iron law for recs (a rec at a nonexistent source is a credibility disaster — never confabulate):
#    · title / author / url come VERBATIM from the fetched result object (Exa). The LLM never writes or
#      "cleans up" a fact — it only authors the one .why sentence (the connection to the user's thread).
#    · no real, resolving URL + fetched title → no rec. Zero recs is a correct outcome (restraint > filler).
#    · a rec is only cached after the fetched title is string-matched in the real fetched body AND an
#      LLM grounding-verifier confirms the page is the canonical page of ONE real readable work.
def _rec_complete(system: str, user: str, max_tokens: int) -> str:
    """One completion for the rec layer (grounding-verifier + why-line), with a fallback chain that ends
    at the already-funded Gemini key — so the grounding gate never silently collapses to zero on an auth
    hiccup with the primary provider. Returns '' on total failure (callers degrade safely)."""
    try:
        sys.path.insert(0, str(CLAIMS_DIR))
        import llm
    except Exception:
        return ""
    specs = []
    for s in llm.phrase_specs() + ["google/gemini-2.5-flash"]:
        if s not in specs:
            specs.append(s)
    return llm.complete_with_fallbacks(specs, system, user, max_tokens)


# The grounding gate lives in claims/rec_grounding.py now (shared with the proactive EXPOSURE lane so the
# two can never drift). serve keeps these names as thin aliases; the why-line stays local (viewer-specific).
import rec_grounding as _rg  # noqa: E402

_norm = _rg._norm
_title_in_body = _rg._title_in_body
_titles_agree = _rg._titles_agree
_exa_search = _rg._exa_search
_url_resolves = _rg._url_resolves
_verify_work = _rg._verify_work
_rec_blurb = _rg.rec_blurb


def _why_line(label: str, title: str) -> str:
    """The ONE generated sentence: natural English about the user's thread (never the raw slug)."""
    try:
        system = ("Write ONE short, natural sentence (max 14 words) saying why a reading fits someone, based "
                  "ONLY on a recurring theme in their conversations. Start with exactly 'Because you keep circling'. "
                  "Turn the theme into plain human English — never quote the raw theme label, never use '&' or slug "
                  "shorthand, don't name the book. Just the one sentence, nothing else.")
        user = f"Recurring theme (their shorthand): {label}\nReading being suggested: {title}"
        out = (_rec_complete(system, user, max_tokens=40) or "").strip()
        out = out.strip('"').splitlines()[0].strip() if out else ""
        if out.lower().startswith("because"):
            return out[:160]
    except Exception:
        pass
    return "Because it keeps pulling you back."


def _source_one_rec(label: str, dismissed: set):
    """Fetch → gate → ONE grounded rec (facts verbatim from the fetched result), or None.
    Gates, cheapest first: real http url · fetched title present in the page body (grounding) ·
    url actually resolves · LLM verifier confirms ONE real readable work whose title matches the page.
    Nothing passes → None (restraint: zero rather than a fabricated 'book')."""
    query = f"best book or essay about {label} for someone deep in it"
    for cand in _exa_search(query):            # grounded fetch only; a Gemini-grounding fallback would
        title, url = cand["title"], cand["url"]   # append candidates here and pass the SAME gate below
        if (label, url) in dismissed or not url.startswith("http"):
            continue
        if not _title_in_body(title, cand.get("summary", ""), cand.get("text", "")):
            continue                            # title not grounded in the real fetched body → skip
        if not _url_resolves(url):
            continue                            # provenance must actually resolve → skip
        ok, work_title = _verify_work(cand)
        if not ok or not _titles_agree(work_title, title):
            continue                            # not a single real work, or work≠page → skip
        return {"title": title, "author": cand.get("author", ""), "blurb": _rec_blurb(cand),
                "url": url, "source": cand.get("source", "exa"), "verified": True}
    return None


def build_recs(tenant: str, threads: dict) -> list:
    """0-2 recs, each earned by a real open thread, sourced fetch-first + grounding-gated, cached on a
    slow cadence. No thread → no rec. No grounded source → no rec. Restraint > filler."""
    db = claims_db(tenant)
    cache = _load_recs_cache(db)
    dismissed = {(d.get("topic", ""), d.get("url", "")) for d in cache.get("dismissed", [])}
    dismissed_topics = {t for t, _ in dismissed if t}

    fresh = (time.time() - cache.get("ts", 0)) < RECS_REFRESH_H * 3600
    if fresh and cache.get("recs"):
        return [r for r in cache["recs"]
                if (r.get("topic", ""), r.get("url", "")) not in dismissed][:RECS_MAX]

    # earn from real open threads (in the user's own terms), strongest first, skip dismissed topics
    topics = [t for t in threads.get("topics", []) if t["count"] >= 2 and t["name"] not in dismissed_topics]
    recs = []
    for t in topics:
        if len(recs) >= RECS_MAX:
            break
        label = t["name"]
        rec = _source_one_rec(label, dismissed)
        if not rec:
            continue                            # this thread earned no grounded source — that's fine
        rec["topic"] = label
        rec["why"] = _why_line(label, rec["title"])
        recs.append(rec)
    cache = {"ts": time.time(), "recs": recs, "dismissed": cache.get("dismissed", [])}
    _save_recs_cache(db, cache)
    return [r for r in recs if (r.get("topic", ""), r.get("url", "")) not in dismissed][:RECS_MAX]


def dismiss_rec(tenant: str, topic: str, url: str):
    """'not for me' → down-weight this topic/source (the anti-feed guarantee, made real)."""
    db = claims_db(tenant)
    cache = _load_recs_cache(db)
    d = cache.setdefault("dismissed", [])
    if not any(x.get("topic") == topic and x.get("url") == url for x in d):
        d.append({"topic": topic, "url": url, "at": dt.datetime.now().isoformat(timespec="seconds")})
    cache["recs"] = [r for r in cache.get("recs", []) if r.get("url") != url]
    _save_recs_cache(db, cache)
    return 200, {"ok": True}


# ── house card HTML ──────────────────────────────────────────────────────────────────────────────
SPARK = ('<svg class="spark" viewBox="0 0 24 24" fill="#7E9A84">'
         '<path d="M12 0l2.4 9.6L24 12l-9.6 2.4L12 24l-2.4-9.6L0 12l9.6-2.4z"/></svg>')
_SONG_SVG = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3z"/></svg>'


def _cid_attr(cid):
    return f' data-cid="{cid}"' if cid else ""


def _forget(cid):
    if not cid:
        return ""
    return '<div class="forget" role="button" tabindex="0">forget this</div><div class="done">forgotten</div>'


def _card_note(n) -> str:
    return (f'<article class="card note"{_cid_attr(n["cid"])}><div class="body">'
            f'<div class="line">{esc(n["text"])}</div>'
            f'<div class="label"><span class="tick"></span>co noticed · {esc(n["when"])}</div>'
            f'{_forget(n["cid"])}</div></article>')


def _card_thing(t) -> str:
    cover = (f'<div class="cover song">{_SONG_SVG}</div>' if t["kind"] == "song"
             else f'<div class="cover book" style="background:{_grad(t["title"])}">{esc(t["title"])}</div>')
    read = f'<p>{esc(t["read"])}</p>' if t.get("read") else ""
    return (f'<article class="card"{_cid_attr(t["cid"])}><div class="body"><div class="thing">{cover}'
            f'<div><h3>{esc(t["title"])}</h3>{read}</div></div>'
            f'<div class="label"><span class="tick"></span>you sent this · {esc(t["when"])}</div>'
            f'{_forget(t["cid"])}</div></article>')


def _card_photo(p) -> str:
    tile = (f'<img class="tile" src="{esc(p["url"])}" alt="" loading="lazy">' if p["url"]
            else f'<div class="tile" style="background:{p["grad"]}"></div>')
    cap = f'<b>{esc(p["title"])}</b>' + (f'<br>{esc(p["cap"])}' if p.get("cap") else "")
    return (f'<article class="card photo"{_cid_attr(p["cid"])}>{tile}'
            f'<div class="cap">{cap}</div>{_forget(p["cid"])}</article>')


def _card_link(lk) -> str:
    href = f' href="{esc(lk["url"])}"' if lk.get("url") else ""
    tag = "article" if not lk.get("url") else "a"
    read = f'<p>{esc(lk["read"])}</p>' if lk.get("read") else ""
    return (f'<article class="card link"{_cid_attr(lk["cid"])}><div class="body">'
            f'<div class="kicker">you shared · {esc(lk["when"])}</div>'
            f'<h3>{esc(lk["title"])}</h3>{read}'
            f'<div class="label"><span class="tick"></span>{esc(lk["kind"])}</div>'
            f'{_forget(lk["cid"])}</div></article>')


def _card_rec(r) -> str:
    disp = _title(r["title"], 56)             # tidy for the card; verbatim title kept in the store/provenance
    return (f'<article class="card rec" data-topic="{esc(r["topic"])}" data-url="{esc(r.get("url",""))}">'
            f'<div class="body"><div class="thing">'
            f'<div class="cover book" style="background:{_grad(r["title"])}">{esc(disp)}</div>'
            f'<div><h3>{esc(disp)}</h3><p>{esc(r["blurb"])}</p></div></div>'
            f'<div class="why">{SPARK}{esc(r["why"])}</div>'
            f'<div class="dismiss" role="button" tabindex="0">not for me</div></div></article>')


def _card_thread(t) -> str:
    return (f'<article class="card thread"><div class="body">'
            f'<h3>{esc(t["title"])}</h3><p>{esc(t["note"])}</p>'
            f'<span class="chip">open · {esc(t["days"])}d</span></div></article>')


def _card_moment(m) -> str:
    return (f'<article class="card moment"><div class="body">'
            f'<div class="bubble you">{esc(m["you"])}</div>'
            f'<div class="bubble co">{esc(m["co"])}</div>'
            f'<div class="label"><span class="tick"></span>a moment · {esc(m["when"])}</div></div></article>')


def _thread_cards(threads: dict) -> list:
    out = []
    for t in threads.get("topics", [])[:3]:
        days = (dt.datetime.now() - t["last"]).days if t.get("last") else 0
        n = t.get("count", 0)
        note = f'came up {n} time{"s" if n != 1 else ""}, still open'
        out.append({"title": t["name"], "note": note, "days": max(0, days)})
    for c in threads.get("commitments", [])[:1]:
        out.append({"title": c["text"][:48], "note": "you said you'd do this", "days": 0})
    return out


def _interleave(cards: dict, thread_cards: list, recs: list) -> list:
    """Masonry order: butter notes anchor and spread; things/photos/links/moments/threads woven between;
    recs RARE and never clustered (spread across the run)."""
    notes = list(cards["notes"])
    others = []
    # round-robin the non-note streams so kinds alternate
    streams = [list(cards["photos"]), list(cards["things"]), list(cards["links"]),
               list(cards["moments"]), list(thread_cards)]
    kinds = ["photo", "thing", "link", "moment", "thread"]
    while any(streams):
        for i, st in enumerate(streams):
            if st:
                others.append((kinds[i], st.pop(0)))
    seq = []
    ni, oi = 0, 0
    # alternate note, other, note, other … (notes are the hero; keep them frequent)
    while ni < len(notes) or oi < len(others):
        if ni < len(notes):
            seq.append(("note", notes[ni])); ni += 1
        if oi < len(others):
            seq.append(others[oi]); oi += 1
    # splice recs at ~1/3 and ~2/3, never adjacent to each other
    if recs and seq:
        slots = [max(1, len(seq) // 3), min(len(seq), 2 * len(seq) // 3 + 1)]
        for r, pos in zip(recs[:RECS_MAX], slots):
            seq.insert(min(pos, len(seq)), ("rec", r))
    render = {"note": _card_note, "thing": _card_thing, "photo": _card_photo, "link": _card_link,
              "moment": _card_moment, "thread": _card_thread, "rec": _card_rec}
    return [render[k](v) for k, v in seq]


def _calendar_html(active: set) -> tuple:
    now = dt.date.today()
    first = now.replace(day=1)
    import calendar as _cal
    ndays = _cal.monthrange(now.year, now.month)[1]
    lead = (first.weekday() + 1) % 7          # python Mon=0; grid starts Sunday
    cells = ['<div class="dow">S</div><div class="dow">M</div><div class="dow">T</div>'
             '<div class="dow">W</div><div class="dow">T</div><div class="dow">F</div><div class="dow">S</div>']
    for _ in range(lead):
        cells.append('<div class="day mute"></div>')
    for d in range(1, ndays + 1):
        cls = "day"
        if d in active:
            cls += " on"
        if d == now.day:
            cls += " today"
        cells.append(f'<div class="{cls}">{d}</div>')
    return now.strftime("%B"), "\n".join(cells)


def render_house(tenant: str, token: str) -> str:
    db = claims_db(tenant)
    knows = load_knows(tenant)
    threads = load_threads_json(tenant)           # the rich engine topics — rail, thread cards, recs
    cards = curate_cards(tenant, token)
    recs = build_recs(tenant, threads)
    thread_cards = _thread_cards(threads)
    gallery = "\n".join(_interleave(cards, thread_cards, recs)) or \
        '<article class="card"><div class="body"><p style="color:#8C857A;font-style:italic">' \
        'nothing yet. text co something you scrolled past, and it starts filling in.</p></div></article>'

    # lede
    name = display_name(tenant)
    greeting = (f"{esc(name[:1].upper() + name[1:])}, your mind lately."
                if NAME_GREETING and not re.fullmatch(r"\+.*", name) else "Your mind, lately.")
    n_held = knows.get("total", 0)
    all_ts = [s["ts"] for s in load_sends(tenant) if s["ts"]] + \
             [_parse_ts(m.get("ts")) for m in load_transcript(tenant) if _parse_ts(m.get("ts"))]
    last = max((t for t in all_ts if t), default=None)
    last_active = f"last here {_rel_when(last)}" if last else "quietly listening"
    today_str = dt.date.today().strftime("%A, %B %-d")

    # rail threads + calendar
    rail = "\n".join(
        f'<div class="trow"><span class="t">{esc(t["name"])}</span>'
        f'<span class="d">{max(0, (dt.datetime.now() - t["last"]).days) if t.get("last") else 0}d</span></div>'
        for t in threads.get("topics", [])[:6]) or \
        '<div class="trow"><span class="t" style="color:#B4AC9F;font-style:italic">no open threads</span></div>'
    active_days = {t.date().day for t in all_ts if t and t.date().month == dt.date.today().month
                   and t.date().year == dt.date.today().year}
    month, cal = _calendar_html(active_days)

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>co — your mind</title>
<style>{HOUSE_CSS}</style></head>
<body><div class="app">
  <header class="topbar">
    <span class="wordmark">co<span class="dot">.</span></span>
    <span class="search" role="search" tabindex="0">search your mind…</span>
    <span class="avatar" aria-label="you"></span>
  </header>
  <main class="house">
    <div class="lede">
      <h1>{greeting}</h1>
      <p>{esc(today_str)}<span class="sep">·</span>{n_held:,} things held<span class="sep">·</span>{esc(last_active)}</p>
    </div>
    <div class="layout">
      <section class="gallery" aria-label="your thoughts">
{gallery}
      </section>
      <aside class="rail">
        <div><h2>Open threads</h2><div class="threads">
{rail}
        </div></div>
        <div><h2>{esc(month)}</h2><div class="cal" role="grid" aria-label="days you talked">
{cal}
        </div></div>
        <div class="railnote">Co keeps what matters and lets the rest fade. Anything here, you can correct or forget — it's your house.</div>
      </aside>
    </div>
  </main>
</div><script>{HOUSE_JS}</script></body></html>"""


# ── server ───────────────────────────────────────────────────────────────────────────────────────
NOT_FOUND = ("<!doctype html><html><head><meta charset='utf-8'><title>co</title></head>"
             "<body style='font-family:Georgia,serif;padding:40px;color:#444'>"
             "<p style='font-style:italic'>nothing here.</p></body></html>")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: str, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex")
        self.end_headers()
        self.wfile.write(data)

    def _tenant_of_token(self, token: str):
        toks = tokens_for(discover_tenants())        # fresh: new tenants appear without restart
        return next((t for t, tok in toks.items() if secrets.compare_digest(tok, token)), None)

    def _send_bytes(self, code: int, data: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("X-Robots-Tag", "noindex")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/")

        # token-guarded media: /v/<token>/media/<name> → the stored image bytes (photo cards)
        mm = re.fullmatch(r"/v/([A-Za-z0-9_\-]+)/media/([A-Za-z0-9._-]+)", path)
        if mm:
            tenant = self._tenant_of_token(mm.group(1))
            p = media_store.resolve(tenant, mm.group(2)) if tenant else None
            if not p:
                self._send(404, NOT_FOUND)
                return
            try:
                self._send_bytes(200, p.read_bytes(), media_store.content_type(p.name))
            except OSError:
                self._send(404, NOT_FOUND)
            return

        # the founder/debug dashboard, off the calm house
        mo = re.fullmatch(r"/v/([A-Za-z0-9_\-]+)/ops", path)
        if mo:
            tenant = self._tenant_of_token(mo.group(1))
            if not tenant:
                self._send(404, NOT_FOUND)
                return
            try:
                self._send(200, render_ops(tenant))
            except Exception as e:
                self._send(500, f"<pre>viewer error: {esc(e)}</pre>")
            return

        # the house
        m = re.fullmatch(r"/v/([A-Za-z0-9_\-]+)", path)
        token = m.group(1) if m else None
        tenant = self._tenant_of_token(token) if token else None
        if not tenant:
            self._send(404, NOT_FOUND)
            return
        try:
            self._send(200, render_house(tenant, token))
        except Exception as e:                        # never take the page down over one bad row
            self._send(500, f"<pre>viewer error: {esc(e)}</pre>")

    def do_POST(self):
        """The one write: POST /v/<token>/correct  {claim_id, action: wrong|edit|undo, text?}.
        Token scopes the write to its own tenant db; the claim must exist there."""
        path = self.path.split("?", 1)[0].rstrip("/")

        # rec refusal: /v/<token>/rec_dismiss {topic, url} → down-weight (the anti-feed guarantee)
        rd = re.fullmatch(r"/v/([A-Za-z0-9_\-]+)/rec_dismiss", path)
        if rd:
            tenant = self._tenant_of_token(rd.group(1))
            if not tenant:
                self._send(404, '{"ok": false}', "application/json")
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) if n else b"{}")
                code, payload = dismiss_rec(tenant, str(body.get("topic", ""))[:120], str(body.get("url", ""))[:400])
            except (ValueError, TypeError, json.JSONDecodeError):
                code, payload = 400, {"ok": False}
            self._send(code, json.dumps(payload), "application/json")
            return

        m = re.fullmatch(r"/v/([A-Za-z0-9_\-]+)/correct", path)
        tenant = self._tenant_of_token(m.group(1)) if m else None
        if not tenant:
            self._send(404, '{"ok": false, "error": "nothing here"}', "application/json")
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) if n else b"{}")
            claim_id = int(body.get("claim_id"))
            action = str(body.get("action", "")).lower()
            text = body.get("text")
        except (ValueError, TypeError, json.JSONDecodeError):
            self._send(400, '{"ok": false, "error": "bad request"}', "application/json")
            return
        if action not in ("wrong", "edit", "undo"):
            self._send(400, '{"ok": false, "error": "bad action"}', "application/json")
            return
        if action == "edit":
            text = str(text or "").strip()[:500]
            if not text:
                self._send(400, '{"ok": false, "error": "edit needs text"}', "application/json")
                return
        else:
            text = None
        code, payload = save_correction(tenant, claim_id, action, text)
        self._send(code, json.dumps(payload), "application/json")

    def log_message(self, *a):
        pass


def _lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def _tailscale_ip():
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3)
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
    except Exception:
        return None


def main():
    tenants = discover_tenants()
    toks = tokens_for(tenants)
    hosts = [h for h in ("localhost", _lan_ip(), _tailscale_ip()) if h]
    print(f"co viewer · the house · port {PORT}")
    print(f"tenants: {', '.join(tenants) or '(none found)'}\n")
    demo = DEFAULT_TENANT if DEFAULT_TENANT in tenants else None
    order = ([demo] + [t for t in tenants if t != demo]) if demo else tenants
    for t in order:
        star = "  ★ demo" if t == demo else ""
        print(f"  {t}{star}")
        for h in hosts:
            print(f"    house: http://{h}:{PORT}/v/{toks[t]}")
        print(f"    ops:   http://{hosts[0]}:{PORT}/v/{toks[t]}/ops")
    print("\n(the house is calm + user-facing; /ops has the debug internals)")
    print("(tokens persisted in viewer/tokens.json; phone needs same wifi or tailscale)")
    if "--print" in sys.argv:
        return
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
