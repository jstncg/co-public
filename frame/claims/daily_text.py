#!/usr/bin/env python3
"""The daily proactive text v0 — one text per tenant per day, drawn from THEIR life, or nothing.

Wired: NOT scheduled directly (the */15 17-21 cron is gone; reconciler took the evening slot). Also the shared send-helper imported by proactive_tick / reconciler /
unasked_delivery. To be subsumed by reconciler.py (the canonical spine) — see ARCHITECTURE.md §3.

The manufactured recurring trigger (V1_PRODUCT_SPEC), text-shaped until the EOD call ships. Sources, in
priority order (the ONLY legitimate resurfacing triggers, 7/1 addendum):
  1. a stated commitment whose date has arrived ("you said friday. did the coffee shop one get filmed?")
  2. an open thread from the last ~2 days — continue it, never recall it
  3. a real question that continues their story (from the freshest strong topic)
Silence beats filler: no threads + no commitments = no text today. Also skipped: not onboarded, skip flag
set ("not tonight"), already texted today, callback budget already spent, outside the tenant's window.

Modeled on voice/scheduler.py: process-and-exit, filesystem state beside the tenant's claims db —
  <db>.textcfg.json    {"phone","window_start","window_end","tz","enabled"}   (defaults: 6-9pm local)
  <db>.skip            'not tonight' flag (shared with the call scheduler)
  <db>.lasttext.json   one text/day watermark
  <db>.staged_daily.json   what WOULD be sent (staging mode output)
Composition: strongest available Claude with the Co disposition; validated against the shared banned-
patterns list (disposition.py); abstains on any failure. The send path is Sendblue, allowlist-gated.

  python3 daily_text.py                    # stage for every tenant due NOW (writes staged files, prints)
  python3 daily_text.py --send             # actually send via Sendblue (allowlisted handles only)
  python3 daily_text.py --tenant X --force # ignore window/watermark for one tenant (still stages unless --send)
Cron: every 15 min through the evening, with --send once live.
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

CLAIMS_DIR = HERE
DEFAULT_TENANT = "dennis"
ONBOARDED_CLAIMS = 3
# The founder's phone maps to the founder tenant (mirror of the router's P0 fix): proactive paths draw on
# claims.db + his dynamic tz, and the stale stranger-tenant db (claims_p<founder>.db) is never read.
FOUNDER_HANDLE = "".join(c for c in os.environ.get("CO_FOUNDER_HANDLE", "") if c.isdigit())
FOUNDER_TENANT = os.environ.get("CO_FOUNDER_TENANT", "dennis")


def _is_founder_alias(tenant: str) -> bool:
    """True for the founder's orphaned stranger-tenant id (p<digits> / <digits>) — always excluded."""
    return "".join(c for c in tenant if c.isdigit()) == FOUNDER_HANDLE and tenant != FOUNDER_TENANT

try:
    from zoneinfo import ZoneInfo
except Exception:                       # pragma: no cover
    ZoneInfo = None

COMPOSE_SYS = """You are Co, texting first. One person sends you their life (thoughts, links, videos) and once a
day you send ONE text that continues THEIR story. You are given what's live in their life (open threads,
commitments, recent sends) and the local time. Write the one text, or abstain.

WHAT MAKES IT LAND: it's a continuation, not a recall. "did the coffee shop one get filmed?" is right.
"remember that tweet you sent about quitting?" is surveillance and is dead. Pick the ONE thing: a commitment
whose date arrived, or the freshest open thread. Reference it the way a friend would, casually, as shared
context. State it or ask it plainly. Warm under the edge, a little cocky, on their side.

THE TEXTURE (a friend flicking something at you, never a service): playful, specific-to-them,
riff-inviting. "watchu know about X" energy. Sometimes the point is just the laugh. Never
"just checking in", never a status report, never a card catalog.

THE PARALLEL (a second allowed shape, use it when their live thread rhymes with something real): the
did-you-know that's actually about THEM. "did you know chesky reviewed every airbnb host photo himself
for years. basically what you're doing with the onboarding" — a REAL specific (name/number/mechanism you
are sure of), one line, tied to their open thread, asks for nothing. A gift, not a bid: it lands even if
they never reply. If you're not certain the fact is true, don't use this shape. Never trivia for its own
sake; the parallel exists because of what THEY'RE in the middle of.

HARD RULES:
- ONE text, under 160 characters. One question max (zero is fine).
- BANNED recommendation-engine tells: "based on your", "you might enjoy/like", "i found something",
  "i came across", "recommend", "check out", "worth a read".
- lowercase-leaning, contractions, fragments fine. two humans texting. match the evening register.
- NEVER: em-dashes (the — character), bullet lists, "not X, it's Y", rule-of-three, emoji spam, sycophancy,
  "just checking in", "how are you doing today", therapy-speak, assistant-speak, romance.
- If nothing is genuinely live (no commitment due, no real open thread), ABSTAIN. Silence beats filler.
Return ONLY JSON: {"text":"<the text>"} or {"text":null}"""


def tenant_db(tenant: str) -> Path:
    t = re.sub(r"[^a-z0-9_+\-]", "_", (tenant or DEFAULT_TENANT).strip().lower()) or DEFAULT_TENANT
    return CLAIMS_DIR / ("claims.db" if t == DEFAULT_TENANT else f"claims_{t}.db")


def _tenant_of_db(db: Path) -> str:
    m = re.match(r"claims_(.+)\.db$", db.name)
    return m.group(1) if m else DEFAULT_TENANT


def tenant_phone(tenant: str, cfg: dict) -> str:
    """Phone from textcfg, else the founder mapping, else recovered from the tenant id (+1714… → p1714…)."""
    if cfg.get("phone"):
        return cfg["phone"]
    if tenant == FOUNDER_TENANT and FOUNDER_HANDLE:
        return "+" + FOUNDER_HANDLE
    if re.fullmatch(r"p\d{7,15}", tenant):
        return "+" + tenant[1:]
    return ""


# ---------------- gates (all deterministic, no LLM) ----------------
def _cfg(db: Path) -> dict:
    p = Path(f"{db}.textcfg.json")
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _now_local(cfg: dict, db: Path | None = None) -> dt.datetime:
    """Tenant-local now: dynamic tz store first (where they ARE), then configured, then default."""
    if db is not None:
        try:
            import tz_dynamic
            return tz_dynamic.now_in(str(db), cfg.get("tz"))
        except Exception:
            pass
    tz = cfg.get("tz", "America/Los_Angeles")
    if tz and ZoneInfo:
        try:
            return dt.datetime.now(ZoneInfo(tz))
        except Exception:
            pass
    return dt.datetime.now()


def _parse_clock(s, default_h):
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", str(s or "").strip().lower())
    if not m:
        return dt.time(default_h, 0)
    h = int(m.group(1)) + (12 if m.group(3) == "pm" and int(m.group(1)) != 12 else 0)
    if m.group(3) == "am" and int(m.group(1)) == 12:
        h = 0
    return dt.time(h, int(m.group(2) or 0)) if 0 <= h <= 23 else dt.time(default_h, 0)


def _texted_today(db: Path) -> bool:
    p = Path(f"{db}.lasttext.json")
    try:
        return p.exists() and json.loads(p.read_text()).get("date") == dt.date.today().isoformat()
    except (json.JSONDecodeError, OSError):
        return False


def _skipped_today(db: Path) -> bool:
    p = Path(f"{db}.skip")
    try:
        return p.exists() and p.read_text().strip() == dt.date.today().isoformat()
    except OSError:
        return False


def _claim_count(db: Path) -> int:
    import sqlite3
    if not db.exists():
        return 0
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        n = c.execute("SELECT COUNT(*) FROM claims WHERE COALESCE(status,'active')!='retired'").fetchone()[0]
        c.close()
        return int(n)
    except Exception:
        return 0


def due_decision(db: Path, force: bool = False) -> dict:
    tenant = _tenant_of_db(db)
    cfg = _cfg(db)
    phone = tenant_phone(tenant, cfg)
    why = []
    if not cfg.get("enabled", True):
        why.append("daily text disabled in textcfg")
    if _claim_count(db) < ONBOARDED_CLAIMS:
        why.append("not onboarded (needs 3+ claims)")
    if _skipped_today(db):
        why.append("'not tonight' flag set")
    if _texted_today(db):
        why.append("already texted today")
    now = _now_local(cfg, db)
    start = _parse_clock(cfg.get("window_start"), 18)
    end = _parse_clock(cfg.get("window_end"), 21)
    if not (start <= now.time() <= end):
        why.append(f"outside window {start.strftime('%H:%M')}-{end.strftime('%H:%M')} (now {now.strftime('%H:%M')})")
    if force:
        why = []
    return {"tenant": tenant, "due": not why, "why": "; ".join(why) or "in window, due", "phone": phone,
            "now": now}


# ---------------- the material (threads + commitments + recent sends) ----------------
def gather(db: Path) -> dict | None:
    """What's genuinely live for this tenant. None = nothing worth texting about (silence)."""
    import threads as threads_mod
    st = threads_mod.load(str(db))
    today = dt.date.today()
    due_commitments = []
    for c in st.get("commitments", []):
        try:
            if c.get("due") and dt.date.fromisoformat(c["due"]) <= today:
                due_commitments.append(c)
        except ValueError:
            pass
    fresh_topics = []
    for t in st.get("topics", []):
        try:
            age = (today - dt.date.fromisoformat(t.get("last", ""))).days
        except ValueError:
            continue
        if age <= 2 and not re.search(r"check-?in|misc|general", t.get("label", ""), re.I):
            fresh_topics.append(t)
    recent = []
    try:
        import sqlite3
        c = sqlite3.connect(f"file:{db}.co_memory.db?mode=ro", uri=True)
        cutoff = (dt.datetime.now() - dt.timedelta(days=2)).isoformat()
        recent = [r[0] for r in c.execute(
            "SELECT send FROM co_sends WHERE ts>=? ORDER BY id DESC LIMIT 5", (cutoff,)).fetchall()]
        c.close()
    except Exception:
        pass
    if not due_commitments and not fresh_topics:
        return None
    return {"commitments_due": due_commitments, "open_threads": fresh_topics,
            "their_recent_sends": [s[:150] for s in recent]}


# ---------------- compose (strongest available Claude, validated, abstains) ----------------
def compose(material: dict, now: dt.datetime) -> str | None:
    """Provider-swappable (llm.py chain). The abstain discipline is honored only when it's CONSISTENT:
    one null can be sampling noise on a clearly-live thread, so we sample twice before going silent."""
    import disposition
    import llm
    payload = dict(material)
    payload["their_local_time"] = now.strftime("%A %I:%M %p").replace(" 0", " ")
    for _attempt in range(2):
        txt = llm.complete_with_fallbacks(llm.phrase_specs(), COMPOSE_SYS, json.dumps(payload), max_tokens=150)
        if not txt:
            return None                           # providers unavailable
        m = re.search(r"\{.*\}", txt, re.S)
        text = (json.loads(m.group(0)).get("text") if m else None)
        if not text or str(text).lower() == "null":
            continue                              # abstain — confirm it once before going silent
        text = disposition.sanitize(str(text))
        if disposition.violations(text, max_chars=200):
            return None                           # failed the banned-patterns gate — silence beats slop
        return text
    return None


# ---------------- send / stage ----------------
def _allowlisted(phone: str) -> bool:
    """OPEN MODE (7/31): proactive follows conversational access — anyone who can text co can
    receive its kept promises. Blocklist still wins; CO_CLOSED=1 restores the invite gate.
    CO_PROACTIVE_HANDLES, when set, binds proactive sends even in open mode (8/10)."""
    try:
        import json as _j
        blocked = _j.load(open(os.path.expanduser("~/.co/blocklist.json"))).get("numbers") or []
        norm = "".join(c for c in (phone or "") if c.isdigit() or c == "+")
        if any(norm == "".join(c for c in h if c.isdigit() or c == "+") for h in blocked):
            return False
    except Exception:
        pass
    prox = [h.strip() for h in os.environ.get("CO_PROACTIVE_HANDLES", "").split(",") if h.strip()]
    if prox:
        norm_p = "".join(c for c in (phone or "") if c.isdigit() or c == "+")
        return any(norm_p == "".join(c for c in h if c.isdigit() or c == "+")
                   or norm_p.endswith("".join(c for c in h if c.isdigit()).lstrip("+")) for h in prox)
    if os.environ.get("CO_CLOSED") != "1":
        return True
    handles = [h.strip() for h in os.environ.get("CO_TEST_HANDLES", "").split(",") if h.strip()]
    try:
        import json as _j
        handles += _j.load(open(os.path.expanduser("~/.co/allowlist.json"))).get("numbers") or []
    except Exception:
        pass
    norm = lambda x: "".join(c for c in x if c.isdigit() or c == "+")  # noqa: E731
    return bool(handles) and any(norm(phone) == norm(h) or norm(phone).endswith(norm(h).lstrip("+"))
                                 for h in handles)


def record_outbound(tenant: str, text: str) -> None:
    """Append a proactive send to the SAME per-tenant conversation transcript the engine reads (the router's
    _transcript_path convention). THE GASLIGHT FIX (7/2, live): the daily text said 'same dance', the engine had
    no record of it, and Co told the founder 'i didn't say that, what are you quoting?' — a proactive surface
    must never say words the conversation brain doesn't own. Every proactive sender calls this after a send."""
    try:                                       # system-review #5: proactive words reach the canonical
        import sys as _sys                     # record too — the mirror was silently missing exactly
        _sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "homebase", "router"))
        import co_dualwrite as _cdw
        _phone = tenant_phone(tenant, _cfg(tenant_db(tenant)))
        if _phone:
            _cdw.emit_outbound(_phone, None, text, _cdw.utc_iso())
    except Exception:
        pass
    try:
        path = os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json")
        msgs = []
        if os.path.exists(path):
            try:
                msgs = json.loads(open(path).read())
            except (json.JSONDecodeError, OSError):
                msgs = []
        msgs.append({"role": "assistant", "content": text,
                     "ts": dt.datetime.now().isoformat(timespec="seconds"), "via": "proactive"})
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(msgs, f)
        os.replace(tmp, path)
    except Exception as e:
        print(f"  ⚠️ transcript record failed (engine won't know it said this!): {e}")


_SENT_GUARD = os.path.expanduser("~/.co/sent_guard.json")
_SENT_GUARD_HOURS = int(os.environ.get("CO_SEND_DEDUP_HOURS", "24"))


def _sent_guard_key(phone: str, content: str) -> str:
    """Normalized, so capitalization/whitespace can't defeat the dedup (the capital-B audit)."""
    import hashlib
    norm = re.sub(r"\s+", " ", (content or "").lower()).strip()
    return hashlib.sha256(f"{phone}|{norm}".encode()).hexdigest()[:32]


def _sent_before(phone: str, content: str) -> bool:
    try:
        d = json.load(open(_SENT_GUARD))
    except Exception:
        d = {}
    cutoff = dt.datetime.now().timestamp() - _SENT_GUARD_HOURS * 3600
    d = {k: v for k, v in d.items() if v >= cutoff}
    hit = _sent_guard_key(phone, content) in d
    if not hit:
        return False
    try:
        json.dump(d, open(_SENT_GUARD, "w"))
    except OSError:
        pass
    return True


def _mark_sent(phone: str, content: str) -> None:
    try:
        d = json.load(open(_SENT_GUARD))
    except Exception:
        d = {}
    d[_sent_guard_key(phone, content)] = dt.datetime.now().timestamp()
    try:
        json.dump(d, open(_SENT_GUARD, "w"))
    except OSError:
        pass


def _tenant_for_phone(phone: str) -> str:
    """Same mapping the receipt gate uses: the founder's handle resolves to their tenant, everyone
    else to p<digits>."""
    norm = "".join(c for c in (phone or "") if c.isdigit())
    founder = "".join(c for c in os.environ.get("CO_FOUNDER_HANDLE", "") if c.isdigit())
    return os.environ.get("CO_FOUNDER_TENANT", "dennis") if (founder and norm == founder) else f"p{norm}"


def _sendblue(phone: str, content: str) -> bool:
    """Kept as a bool for its fifteen callers; the gates and the transport live in rail.py now."""
    import rail
    ok, why = rail.send(phone, content)
    if not ok:
        print(f"  [held] {why}")
    return ok

def run_tenant(db: Path, send: bool, force: bool) -> str:
    d = due_decision(db, force=force)
    tenant = d["tenant"]
    if not d["due"]:
        return f"[hold] {tenant:<16} — {d['why']}"
    # the callback budget is shared with co_react (max ONE resurface/day, whatever the surface)
    import co_react
    mem = f"{db}.co_memory.db"
    if co_react.callback_used_today(mem) and not force:
        return f"[hold] {tenant:<16} — callback budget already spent today"
    material = gather(db)
    if not material:
        return f"[hold] {tenant:<16} — nothing genuinely live (silence beats filler)"
    text = compose(material, d["now"])
    if not text:
        return f"[hold] {tenant:<16} — composer abstained or failed the gate"
    staged = {"date": dt.date.today().isoformat(), "text": text, "phone": d["phone"],
              "material": material, "staged_at": dt.datetime.now().isoformat(timespec="seconds")}
    Path(f"{db}.staged_daily.json").write_text(json.dumps(staged, ensure_ascii=False, indent=1))
    if not send:
        return f"[stage] {tenant:<16} → {text!r}"
    if not d["phone"]:
        return f"[hold] {tenant:<16} — staged but no phone known"
    if not _allowlisted(d["phone"]):
        return f"[hold] {tenant:<16} — staged but {d['phone']} not in CO_TEST_HANDLES"
    if _sendblue(d["phone"], text):
        Path(f"{db}.lasttext.json").write_text(json.dumps({"date": dt.date.today().isoformat(), "text": text}))
        record_outbound(tenant, text)          # the engine must own its own words (the 'same dance' gaslight fix)
        co_react.mark_callback("daily_text", mem)
        return f"[SENT] {tenant:<16} → {text!r}"
    return f"[fail] {tenant:<16} — sendblue send failed (will retry next tick)"


# The ONE definition of a real member. Written three separate times before this (here, the
# invariants, the scenario matrix) and wrong in at least one of them every time — the
# proactive tick was spending every 15-minute cycle iterating probe2, smoketest_eval,
# repairtest1 and a dozen other fixtures while real members sat behind them in the list.
#
# A test tenant is: a reserved-555 phone, or any name that is not a phone number at all
# (probe*, smoketest*, eval*, scn_*, …). The founder is real; everything else must look
# like an actual handle.
_TEST_TENANT = re.compile(r"^(p1555|p?15555)|^(probe|smoketest|eval|scn_|test|len|mode|repair|"
                          r"restore|doctor|apptest|demo|jae)", re.I)


def is_real_member(tenant: str) -> bool:
    """True for the founder and for anything shaped like a genuine phone handle."""
    t = (tenant or "").strip()
    if t == FOUNDER_TENANT:
        return True
    if _TEST_TENANT.match(t):
        return False
    return bool(re.fullmatch(r"p\d{7,15}", t))


def all_tenant_dbs(include_test: bool = False) -> list:
    dbs = [CLAIMS_DIR / "claims.db"] if (CLAIMS_DIR / "claims.db").exists() else []
    dbs += sorted(CLAIMS_DIR.glob("claims_*.db"))
    out = []
    for d in dbs:
        if d.name.endswith(".co_memory.db"):
            continue
        t = _tenant_of_db(d)
        if _is_founder_alias(t):
            continue                    # the founder's orphaned stranger db — tombstoned, never proactive
        if not include_test and not is_real_member(t):
            continue                    # fixtures never receive a proactive send
        out.append(d)
    return out


def active_tenants(days: int = 7) -> list:
    """The dbs a SCHEDULED organ should spend on: a deliverable number AND recent activity.

    8/4, when the delivery organs went multi-tenant (the wake was founder-only, so a second real
    user got replies and memory but never a morning delivery — a texting bot, not co). Eval and
    test tenants carry plausible-looking numbers, so a phone check alone still burns a model call
    per dormant database. Recency is the honest second filter: the wake reads yesterday, and a
    tenant with no yesterday has nothing to wake about."""
    out = []
    for db in all_tenant_dbs():
        t = _tenant_of_db(db)
        try:
            if not tenant_phone(t, _cfg(db)):
                continue
            p = os.path.expanduser(f"~/.co/journal/{t}.json")
            if not os.path.exists(p):
                continue
            entries = json.load(open(p)).get("entries") or []
            last = (entries[-1].get("date") if entries else "") or ""
            if last and (dt.date.today() - dt.date.fromisoformat(last)).days <= days:
                out.append(db)
        except Exception:
            continue
    return out


def main():
    a = sys.argv[1:]
    send = "--send" in a
    force = "--force" in a
    if "--tenant" in a:
        dbs = [tenant_db(a[a.index("--tenant") + 1])]
    else:
        dbs = all_tenant_dbs()
    print(f"daily_text {'SEND' if send else 'stage-only'} tick — {dt.datetime.now().isoformat(timespec='seconds')}")
    for db in dbs:
        print(" " + run_tenant(db, send, force))


if __name__ == "__main__":
    main()
