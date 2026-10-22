#!/usr/bin/env python3
"""The when-to-call scheduler (PROGRAM.md cap 1, the SIMPLE v1 trigger).

NOT calibrated proactivity (that's v2 — explicitly forbidden here). Dead simple and robust:
  • each user picks an evening window (a start/end clock time, their timezone),
  • at most ONE call per day,
  • the user can text "not tonight" to skip today (the text rail flips a per-tenant flag),
  • on fire it calls place_call() in voice/witness_voice.py (SIP outbound → the engine answers).

Process-and-exits every run — launchd/cron re-fires it (robust: survives reboots/crashes, no resident loop,
all state in files). Fire it often (every ~5-15 min through the evening); each run is cheap and decides per
user whether NOW is inside their window, not-yet-called-today, and not skipped.

PER-TENANT (the CO_CLAIMS_DB convention). A user's whole state keys off their claims-db path:
    <db>                      the tenant's belief store (e.g. claims_alice.db)
    <db>.callcfg.json         {"phone","window_start","window_end","tz","enabled"}  — who/when to call
    <db>.skip                 today's date (YYYY-MM-DD) → "not tonight" for today (text rail writes this)
    <db>.lastcall.json        {"date": "YYYY-MM-DD"} → enforces one call/day
Default tenant ("dennis") = claims/claims.db (+ siblings). Each run sweeps every <db>.callcfg.json it finds,
so onboarding a user is just dropping a callcfg beside their store. NO database; the filesystem is the state.

──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREDS BOUNDARY: this file is fully runnable WITHOUT any creds — it computes who-to-call-now deterministically
and is import-clean without livekit. The ONLY creds-gated step is the actual place_call() (SIP/LiveKit), which
lives in witness_voice.py and is marked there. Run `scheduler.py --dry-run` to see who WOULD be called with no
creds at all. Going live = provision the witness_voice SETUP creds, then point launchd/cron at this file.

  launchd/cron, every 10 min in the evening:
    doppler run -- /…/substrate/.venv/bin/python3 voice/scheduler.py        # one tick: call whoever is due
    doppler run -- /…/substrate/.venv/bin/python3 voice/scheduler.py --dry-run   # decide only, never dial
──────────────────────────────────────────────────────────────────────────────────────────────────────────

The text rail wires "not tonight" by importing set_skip():
    from scheduler import set_skip;  set_skip(tenant="alice")     # marks today skipped for that user
"""
import json
import os
import re
import sys
from datetime import date, datetime, time as dtime
from pathlib import Path

ROOT = Path("/Users/main/Projects/Secretary/Secretary-Production/projects/co/frame")
CLAIMS_DIR = ROOT / "claims"
DEFAULT_TENANT = "dennis"
DEFAULT_DB = CLAIMS_DIR / "claims.db"

SKIP_WORDS = {"not tonight", "skip tonight", "not today", "skip today", "rain check", "raincheck"}

# Optional ZoneInfo — degrade to naive local time if tzdata is unavailable (still correct on the host's tz).
try:
    from zoneinfo import ZoneInfo
except Exception:                       # pragma: no cover
    ZoneInfo = None


# ---------------- per-tenant path resolution (mirrors claimstore.db_path / witness_voice._tenant_db) ----------------
def tenant_db(tenant: str) -> Path:
    """tenant id → claims-db path (the CO_CLAIMS_DB handle). Default tenant keeps claims.db; others get
    claims_<tenant>.db. CO_CLAIMS_DB env overrides everything (single-tenant dogfood)."""
    explicit = os.getenv("CO_CLAIMS_DB")
    if explicit and not tenant:
        return Path(explicit)
    t = (tenant or os.getenv("CO_TENANT") or DEFAULT_TENANT).strip().lower()
    t = re.sub(r"[^a-z0-9_+\-]", "_", t) or DEFAULT_TENANT
    return DEFAULT_DB if t == DEFAULT_TENANT else CLAIMS_DIR / f"claims_{t}.db"


def _cfg_path(db: Path) -> Path:      return Path(f"{db}.callcfg.json")
def _skip_path(db: Path) -> Path:     return Path(f"{db}.skip")
def _lastcall_path(db: Path) -> Path: return Path(f"{db}.lastcall.json")


def _tenant_of_db(db: Path) -> str:
    """Recover the tenant id from a claims-db path, so logs/place_call get the right id."""
    if db.resolve() == DEFAULT_DB.resolve():
        return DEFAULT_TENANT
    m = re.match(r"claims_(.+)\.db$", db.name)
    return m.group(1) if m else DEFAULT_TENANT


# ---------------- the "not tonight" skip flag (set by the text rail) ----------------
def set_skip(tenant: str = "", db: Path = None, day: str = None) -> Path:
    """Mark today (or `day`) as 'not tonight' for a tenant — the text rail calls this when the user texts a
    skip phrase. Writes the date into <db>.skip. Idempotent. Returns the flag path."""
    db = db or tenant_db(tenant)
    day = day or date.today().isoformat()
    p = _skip_path(db)
    p.write_text(day)
    return p


def is_skip_phrase(text: str) -> bool:
    """True if a user message is a 'not tonight' skip (the text rail's match helper)."""
    t = (text or "").strip().lower().rstrip(".!")
    return t in SKIP_WORDS or any(w in t for w in ("not tonight", "skip tonight", "rain check"))


def _is_skipped_today(db: Path) -> bool:
    p = _skip_path(db)
    if not p.exists():
        return False
    try:
        return p.read_text().strip() == date.today().isoformat()
    except OSError:
        return False


def _called_today(db: Path) -> bool:
    p = _lastcall_path(db)
    if not p.exists():
        return False
    try:
        return json.loads(p.read_text()).get("date") == date.today().isoformat()
    except (json.JSONDecodeError, OSError):
        return False


def _mark_called(db: Path):
    _lastcall_path(db).write_text(json.dumps({"date": date.today().isoformat(),
                                              "at": datetime.now().isoformat(timespec="seconds")}))


# ---------------- the window decision (deterministic, no creds) ----------------
def _now_in_tz(tz: str) -> datetime:
    if tz and ZoneInfo:
        try:
            return datetime.now(ZoneInfo(tz))
        except Exception:
            pass
    return datetime.now()


def _parse_clock(s: str, default: dtime) -> dtime:
    """'21:00' / '9:00pm' / '21' → a time. Falls back to default on garbage."""
    s = (s or "").strip().lower()
    if not s:
        return default
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", s)
    if not m:
        return default
    h = int(m.group(1)); mins = int(m.group(2) or 0); ap = m.group(3)
    if ap == "pm" and h != 12:
        h += 12
    elif ap == "am" and h == 12:
        h = 0
    if not (0 <= h <= 23 and 0 <= mins <= 59):
        return default
    return dtime(h, mins)


def _in_window(now: datetime, start: dtime, end: dtime) -> bool:
    """Is `now` inside [start, end]? Same-day windows only (evening windows don't cross midnight in v1; if
    end <= start we treat it as a degenerate config and use a 1-hour window from start)."""
    t = now.time()
    if end <= start:                 # malformed/equal — be safe, treat as a short window from start
        end = dtime((start.hour + 1) % 24, start.minute)
        if end <= start:
            return t >= start
    return start <= t <= end


def due_decision(db: Path) -> dict:
    """Pure decision for ONE tenant: should we place the evening call right now? No side effects, no creds.
    Returns {tenant, call: bool, reason, phone}."""
    tenant = _tenant_of_db(db)
    cfg_path = _cfg_path(db)
    if not cfg_path.exists():
        return {"tenant": tenant, "call": False, "reason": "no callcfg (not onboarded for calls)", "phone": ""}
    try:
        cfg = json.loads(cfg_path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        return {"tenant": tenant, "call": False, "reason": f"bad callcfg ({e})", "phone": ""}

    phone = (cfg.get("phone") or "").strip()
    if not cfg.get("enabled", True):
        return {"tenant": tenant, "call": False, "reason": "calls disabled in callcfg", "phone": phone}
    if not phone:
        return {"tenant": tenant, "call": False, "reason": "no phone in callcfg", "phone": ""}
    if _is_skipped_today(db):
        return {"tenant": tenant, "call": False, "reason": "user said 'not tonight' (skip flag set today)", "phone": phone}
    if _called_today(db):
        return {"tenant": tenant, "call": False, "reason": "already called today (one call/day)", "phone": phone}

    start = _parse_clock(cfg.get("window_start"), dtime(20, 0))   # default evening window 8–9pm
    end = _parse_clock(cfg.get("window_end"), dtime(21, 0))
    now = _now_in_tz(cfg.get("tz", ""))
    if not _in_window(now, start, end):
        return {"tenant": tenant, "call": False,
                "reason": f"outside window {start.strftime('%H:%M')}–{end.strftime('%H:%M')} "
                          f"(now {now.strftime('%H:%M')} {cfg.get('tz','local')})", "phone": phone}
    return {"tenant": tenant, "call": True, "reason": "in window, not called today, not skipped", "phone": phone}


def _all_tenant_dbs() -> list:
    """Every tenant store with a callcfg beside it (+ the default store). CO_CLAIMS_DB env pins to one."""
    explicit = os.getenv("CO_CLAIMS_DB")
    if explicit:
        return [Path(explicit)]
    dbs = []
    if _cfg_path(DEFAULT_DB).exists():
        dbs.append(DEFAULT_DB)
    founder_digits = "".join(c for c in os.getenv("CO_FOUNDER_HANDLE", "") if c.isdigit())
    for cfg in sorted(CLAIMS_DIR.glob("claims_*.db.callcfg.json")):
        db = Path(str(cfg)[:-len(".callcfg.json")])
        if "".join(c for c in db.name if c.isdigit()) == founder_digits:
            continue                    # founder rides the default tenant, never his orphaned p-db
        dbs.append(db)
    return dbs


def _place_call(phone: str, tenant: str):
    """The ONE creds-gated step — defer the import so the rest of this file stays import-clean without livekit.
    CREDS: see witness_voice SETUP (LIVEKIT_*, SIP trunk). Raises here if creds/livekit are missing; main()
    catches and logs so one tenant's missing creds can't take down the sweep."""
    sys.path.insert(0, str(ROOT / "voice"))
    import witness_voice                         # noqa: E402 (deferred — keeps scheduler import-clean)
    import asyncio
    asyncio.run(witness_voice.place_call(phone, tenant=tenant))


def main():
    dry = "--dry-run" in sys.argv or "-n" in sys.argv
    show = "--list" in sys.argv
    placed = 0
    for db in _all_tenant_dbs():
        d = due_decision(db)
        tag = "CALL" if d["call"] else "skip"
        masked = (d["phone"][:-4].translate({ord(c): "•" for c in "0123456789"}) + d["phone"][-4:]) if d["phone"] else "(none)"
        print(f"[{tag}] {d['tenant']:<12} {masked:<16} — {d['reason']}")
        if show:
            continue
        if d["call"] and not dry:
            try:
                _place_call(d["phone"], d["tenant"])
                _mark_called(db)                 # only after a successful dispatch — a failed dial retries next tick
                placed += 1
                print(f"       → placed evening call to {d['tenant']}")
            except Exception as e:
                print(f"       ⚠️ place_call failed for {d['tenant']} (will retry next tick): {e}")
    if not dry and not show:
        print(f"scheduler: {placed} call(s) placed this tick")
    return 0


if __name__ == "__main__":
    sys.exit(main())
