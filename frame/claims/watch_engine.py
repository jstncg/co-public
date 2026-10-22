#!/usr/bin/env python3
"""WATCH — the mandate verb. "Keep an eye on this" becomes a standing promise that actually runs.

The missing half of the loop (docs/watch-architecture.md): recall looks backward, nothing looked
forward. A watch is a kept promise about the WORLD — price, availability, deadline, a page changing,
a topic developing — checked on the tick, firing ONLY on material change. Silence between changes is
the product working, not idle.

v0 scope, deliberately: explicit watches only (the user asked), three check kinds, one vendor call.
No WorldObserver abstraction until a second vendor exists; no proposals until explicit watches prove
the loop. Useful today beats architected next month.

  kinds:
    date    — a deadline/moment: fires when inside the lead window. Deterministic, zero API cost.
    url     — one page that matters: fetched and READ (the eyes), judged for material change.
    search  — a standing question about the world: Exa results, judged for material change vs last.

  the judge fires on MATERIAL change w.r.t. what the user said they care about — never on "the page
  has a new timestamp". A watch that cries wolf is worse than no watch (§18 spirit).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MODEL = os.environ.get("CO_JUDGE_MODEL", "claude-haiku-4-5")    # compile + judge: cheap, structured, off the reply path
CHECK_DEFAULT_HOURS = 24            # watches are patient by default; deadlines compute their own urgency
DATE_LEAD_DAYS = 3                  # deadline watches fire when inside this window (and again day-of)
MAX_ACTIVE = 25
SCOUT_MAX = 5                       # scout-created watches stay scarce: offers, not an inbox                     # possibility budget, enforced (dd-adjudication): watches stay scarce

COMPILE_SYS = """Compile a person's watch request into a checkable spec. Return ONLY JSON:
{"what": "<their ask, compressed to one line, their words>",
 "kind": "date" | "url" | "search",
 "target": "<ISO date YYYY-MM-DD | the url | a search query built for finding CHANGES/news about this>",
 "care": "<one sentence: what change actually matters to them — the firing condition in plain words>",
 "cadence_hours": <int, how often checking is worth it: 24 default; 6 for fast-moving; 168 for slow>}
Rules: if they gave a url, kind=url. If the ask has a date/deadline in it, kind=date and target is
the date. Otherwise kind=search. The `care` field is the contract — be precise about what counts as
material (a price DROP, tickets AVAILABLE, applications OPEN), not just the topic."""

JUDGE_SYS = """You are checking a standing watch for someone. You have what they care about, the
previous state, and the current evidence. Decide if something MATERIALLY changed with respect to
what they care about. New timestamps, reworded pages, and minor churn are NOT material. Being unsure
is a no.
Return ONLY JSON: {"changed": true|false, "state": "<one-line summary of current state, for next
time>", "line": "<if changed: one text-message-sized line telling them what changed and why it
matters to their ask — concrete, no preamble. else null>"}"""


def _db(tenant: str) -> str:
    d = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(d, "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")


def _conn(tenant: str):
    c = sqlite3.connect(_db(tenant), timeout=10)
    c.execute("""CREATE TABLE IF NOT EXISTS watches (
        id           INTEGER PRIMARY KEY,
        what         TEXT NOT NULL,
        kind         TEXT NOT NULL,
        target       TEXT NOT NULL,
        care         TEXT,
        cadence_h    INTEGER DEFAULT 24,
        created_at   TEXT NOT NULL,
        last_checked TEXT,
        last_state   TEXT,
        status       TEXT DEFAULT 'active',   -- active | fired | done | dead
        fire_count   INTEGER DEFAULT 0,
        origin       TEXT DEFAULT 'asked',     -- asked (promise) | scout (offer) | exposure (alert)
        expires_at   TEXT                      -- exposures die with the plan that made them
    )""")
    c.commit()
    return c


async def _ask(system: str, user: str, max_tokens: int = 400):
    import asyncio as _a
    # NO ANTHROPIC CREDENTIAL → the provider-neutral chain (8/13), so compile / judge / scout all run
    # on whatever key the machine actually holds. Placed ABOVE the `anthro` import on purpose: that
    # import and the constructor under it both fail without a credential, so a check below them
    # never runs. Nothing here prompt-caches, so unlike find_engine this path costs the same.
    import llm
    if not llm.have_anthropic():
        return await _a.to_thread(llm.ask_json, llm.json_specs(), system, user, max_tokens)
    from anthro import make_client
    client = make_client()
    for wait in (0, 3):
        if wait:
            await _a.sleep(wait)
        try:
            r = await client.messages.create(model=MODEL, system=system, max_tokens=max_tokens,
                                             messages=[{"role": "user", "content": user}])
            t = "".join(b.text for b in r.content if b.type == "text")
            m = re.search(r"\{.*\}", t, re.S)
            if m:
                return json.loads(m.group(0))
        except Exception as e:
            if not any(k in str(e) for k in ("429", "rate_limit", "overloaded", "529")):
                raise
    return None


# ── create ───────────────────────────────────────────────────────────────────
def create(tenant: str, ask: str):
    """Compile and store a watch. Returns {'what','kind','line'} or None. Never raises to callers."""
    try:
        import asyncio
        c = _conn(tenant)
        try:
            n = c.execute("SELECT count(*) FROM watches WHERE status='active'").fetchone()[0]
            if n >= MAX_ACTIVE:
                return {"what": ask, "kind": "over_budget",
                        "line": f"you've got {n} watches running — that's the cap. kill one first."}
            # TODAY, stamped (8/13). COMPILE_SYS asks the model to turn "thursday" into an ISO date
            # while telling it nothing about when now is, so an undated model guesses: "a pitch on
            # thursday" compiled to target 2024-04-25, two years stale, and a date watch whose
            # target is in the past can never fire. `exposure_scout` already stamps the date for
            # exactly this reason (below) — this is the same fix at the other call site.
            today = time.strftime("%Y-%m-%d")
            spec = asyncio.run(_ask(COMPILE_SYS, f"TODAY IS {today}.\n\n{ask}")) or {}
            kind = spec.get("kind")
            if kind not in ("date", "url", "search") or not spec.get("target"):
                return None
            # "watch this video" is a DEEP-WATCH ask, not a standing world-watch (8/5).
            # A video URL never materially changes, so compiling one into kind=url created
            # permanent watches that poll a YouTube link forever — and padded the user's
            # "watching N things" list with items he did not recognize as commitments.
            if kind == "url" and re.search(r"(youtu\.be|youtube\.com|tiktok\.com|instagram\.com|"
                                           r"vimeo\.com|x\.com/\w+/status|twitter\.com/\w+/status)",
                                           str(spec.get("target") or ""), re.I):
                return None
            # Normalized dedupe at insert: "buy Tuesday's..." vs "Buy Tuesday's..." were two
            # ACTIVE watches differing only in a capital B, and each fired its own text 15
            # minutes apart (8/9 audit). Same watch = same words or same target, case-blind.
            what_new = spec.get("what") or ask[:200]
            dupe = c.execute(
                "SELECT id, what FROM watches WHERE status='active' AND "
                "(lower(trim(what))=lower(trim(?)) OR lower(trim(target))=lower(trim(?)))",
                (what_new, spec["target"])).fetchone()
            if dupe:
                return {"what": dupe[1], "kind": kind, "care": spec.get("care") or "",
                        "line": None}
            c.execute("INSERT INTO watches (what,kind,target,care,cadence_h,created_at) VALUES (?,?,?,?,?,?)",
                      (what_new, kind, spec["target"], spec.get("care"),
                       int(spec.get("cadence_hours") or CHECK_DEFAULT_HOURS),
                       time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
            c.commit()
            return {"what": spec.get("what") or ask[:200], "kind": kind,
                    "care": spec.get("care") or "", "line": None}
        finally:
            c.close()
    except Exception:
        return None


# ── check ────────────────────────────────────────────────────────────────────
def _current_evidence(kind: str, target: str) -> str:
    """What the world looks like right now, as text. Small on purpose (judge reads it whole)."""
    if kind == "url":
        # A JS-rendered target (app listings, dashboards, most SPAs) leaves _page_read with a stub
        # under its 200-char floor, so it returns None and the evidence comes back "" — and an empty
        # evidence string is indistinguishable from "nothing changed". The watch then sits active
        # forever, never firing, never erroring: a promise the member cannot see is broken (8/7).
        # The rendered read is the floor under that.
        try:
            import link_read
            got = link_read._page_read(target, timeout=25) or link_read.read_raw(target, max_chars=2000)
            if got:
                return got[:2000]
        except Exception:
            pass
        return ""
    if kind == "search":
        try:
            import requests
            r = requests.post("https://api.exa.ai/search",
                              headers={"x-api-key": os.environ.get("EXA_API_KEY", ""),
                                       "Content-Type": "application/json"},
                              json={"query": target, "numResults": 5, "type": "auto",
                                    "contents": {"highlights": {"numSentences": 3}}},
                              timeout=30)
            if r.ok:
                out = []
                for res in (r.json().get("results") or [])[:5]:
                    hl = " ".join(res.get("highlights") or [])[:300]
                    out.append(f"- {res.get('title','')} [{(res.get('publishedDate') or '')[:10]}] {hl}")
                return "\n".join(out)[:2500]
        except Exception:
            pass
        return ""
    return ""


def check(tenant: str, watch_id: int):
    """Check one watch. Returns a fire line if it materially changed, else None. Updates state."""
    try:
        import asyncio
        import datetime as dt
        c = _conn(tenant)
        try:
            row = c.execute("SELECT id,what,kind,target,care,last_state FROM watches WHERE id=? AND status='active'",
                            (watch_id,)).fetchone()
            if not row:
                return None
            wid, what, kind, target, care, last_state = row
            now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

            if kind == "date":                              # deterministic: no API, no judge
                try:
                    due = dt.date.fromisoformat(target[:10])
                except ValueError:
                    c.execute("UPDATE watches SET status='dead', last_checked=? WHERE id=?", (now_iso, wid))
                    c.commit()
                    return None
                days = (due - dt.date.today()).days
                c.execute("UPDATE watches SET last_checked=? WHERE id=?", (now_iso, wid))
                if days < 0:
                    c.execute("UPDATE watches SET status='done' WHERE id=?", (wid,))
                    c.commit()
                    return None
                already = (last_state or "")
                stage = "dayof" if days == 0 else ("lead" if days <= DATE_LEAD_DAYS else None)
                if stage and stage not in already:           # fire once per stage, never re-nag (§18)
                    c.execute("UPDATE watches SET last_state=?, fire_count=fire_count+1 WHERE id=?",
                              ((already + " " + stage).strip(), wid))
                    c.commit()
                    when = "today" if days == 0 else f"in {days} day{'s' if days != 1 else ''}"
                    return f"{what} — {when}." + (f" ({care})" if care and days > 0 else "")
                c.commit()
                return None

            evidence = _current_evidence(kind, target)
            if not evidence:                                 # world unreachable ≠ world changed
                c.execute("UPDATE watches SET last_checked=? WHERE id=?", (now_iso, wid))
                c.commit()
                return None
            if not last_state:                               # first check just baselines — no firing
                verdict = asyncio.run(_ask(JUDGE_SYS,
                    f"CARE: {care}\nPREVIOUS: (first check — summarize baseline only, changed=false)\nCURRENT:\n{evidence}")) or {}
                c.execute("UPDATE watches SET last_checked=?, last_state=? WHERE id=?",
                          (now_iso, (verdict.get("state") or evidence[:300]), wid))
                c.commit()
                return None
            verdict = asyncio.run(_ask(JUDGE_SYS,
                f"CARE: {care}\nPREVIOUS: {last_state}\nCURRENT:\n{evidence}")) or {}
            c.execute("UPDATE watches SET last_checked=?, last_state=? WHERE id=?",
                      (now_iso, verdict.get("state") or last_state, wid))
            if verdict.get("changed") and verdict.get("line"):
                c.execute("UPDATE watches SET fire_count=fire_count+1 WHERE id=?", (wid,))
                c.commit()
                return str(verdict["line"])[:400]
            c.commit()
            return None
        finally:
            c.close()
    except Exception:
        return None


EXPOSURE_SYS = """You extract EXPOSURES from what one person has recently sent: concrete near-term
commitments where a world event could collide with their life — travel (a place they will BE),
flights/transport they depend on, events they're attending, visa/deadline dependencies, institutions
actively holding something of theirs. NOT interests, NOT aspirations — only commitments with a time
window that hasn't passed.

Return ONLY JSON: {"exposures": [{"what": "<the commitment, their words: 'flying to korea thursday'>",
"locus": "<the place/institution/carrier to watch news about>",
"window_end": "<ISO date the exposure ends, generous>",
"care": "<the collision contract: what kind of world event would change what they should DO — safety,
closures, cancellations, unrest, strikes, weather severe enough to matter>"}]}
Empty list is the common answer. Never invent a trip from an interest ('wants to visit japan' is not
an exposure; 'flying to tokyo on the 12th' is)."""


SCOUT_SYS = """You are the scout for one person's watch list — the recommendation engine inverted:
instead of ranking a catalog for their attention, you decide what few things in the changing world
are worth STANDING WATCH on for THIS person, based on everything they've actually sent.

You see their corpus (dated, one line each) and their current watches. Propose 0-3 NEW watches.
Return ONLY JSON: {"watches": [{"what": "<one line, framed as why-them: 'you keep circling X — watching for Y'>",
"kind": "url"|"search"|"date", "target": "<url | change-finding search query | ISO date>",
"care": "<the firing contract: what specific change is worth their attention, and why it connects to
what they've sent>", "cadence_hours": <int>}]}

The bar (most candidates fail it — and user-research-001 raised it):
- DECLARED INTENT beats recurrence. "I'm planning a trip this summer" is watchable; "saved 25 posts
  about japan" alone is NOT — the research verdict verbatim: recurrence without intent reads as
  Pinterest glaze ("shows me pictures I've already seen"). Recurrence qualifies only when paired
  with something they SAID they want to do, decide, or have.
- A CLOCK: the thing must actually CHANGE in ways that matter (prices, openings, releases, deadlines,
  people's moves). A static curiosity is not watchable — skip it.
- NOT ALREADY WATCHED, not obvious, not something their feed would hand them anyway. The best watch
  is one they'd never think to set but would thank you for when it fires.
- Zero is a fine answer. An almost-good watch is noise with a cadence."""


def _shadow_log(tenant: str, cand: dict, verdict: str) -> None:
    """The scout shadow ledger (kyo interest.py pattern): EVERY candidate the scout model proposes
    is logged — created or rejected, with the reason — so the bar's precision is measurable instead
    of vibes. Grading happens in shadow_review.py; any future LOWERING of the scout bar must cite
    the graded yes-rate (the pre-registered gate: >=90% graded-yes across 2 consecutive weeks)."""
    try:
        import json as _j
        d = os.path.expanduser("~/.co/scout_shadow")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{tenant}.jsonl"), "a") as f:
            f.write(_j.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                              "what": str(cand.get("what") or "")[:200],
                              "kind": cand.get("kind"), "target": str(cand.get("target") or "")[:300],
                              "care": str(cand.get("care") or "")[:300],
                              "verdict": verdict, "grade": None}, ensure_ascii=False) + "\n")
    except Exception:
        pass


def scout(tenant: str):
    """Propose and create scout watches from the corpus. Returns created list. Runs nightly, off
    the reply path. Scout fires spend the ORGANIC budget (offers), unlike asked watches (promises)."""
    try:
        import asyncio
        import find_engine
        index, n = find_engine._index(tenant)
        if n < 20:
            return []
        c = _conn(tenant)
        try:
            active = c.execute("SELECT what, target FROM watches WHERE status='active'").fetchall()
            n_scout = c.execute("SELECT count(*) FROM watches WHERE status='active' AND origin='scout'").fetchone()[0]
        finally:
            c.close()
        room = SCOUT_MAX - n_scout
        if room <= 0:
            return []
        cur = "\n".join(f"- {w} -> {t}" for w, t in active) or "(none)"
        got = asyncio.run(_ask(SCOUT_SYS,
            f"EVERYTHING THEY HAVE SENT:\n\n{index}\n\nCURRENT WATCHES (never duplicate):\n{cur}",
            max_tokens=1200)) or {}
        created = []
        c = _conn(tenant)
        try:
            proposals = got.get("watches") or []
            for w in proposals[room:]:
                _shadow_log(tenant, w, "rejected:room")
            for w in proposals[:room]:
                if w.get("kind") not in ("date", "url", "search") or not w.get("target"):
                    _shadow_log(tenant, w, "rejected:invalid")
                    continue
                _shadow_log(tenant, w, "created")
                c.execute("INSERT INTO watches (what,kind,target,care,cadence_h,created_at,origin) VALUES (?,?,?,?,?,?,'scout')",
                          (str(w.get("what"))[:200], w["kind"], str(w["target"])[:500], str(w.get("care") or "")[:500],
                           int(w.get("cadence_hours") or CHECK_DEFAULT_HOURS),
                           time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
                created.append(w.get("what"))
            c.commit()
        finally:
            c.close()
        return created
    except Exception:
        return []


def exposure_scout(tenant: str):
    """Derive ephemeral disruption watches from recent commitments. The reverse join: world -> life.
    A trip in the corpus instantiates its own news watch — country, carrier, event — living only as
    long as the plan does. Nobody asks for these; that is the point (the martial-law case: nobody
    watches for martial law, it collides with your thursday)."""
    try:
        import asyncio
        import find_engine
        index, n = find_engine._index(tenant)
        if n < 5:
            return []
        recent = "\n".join(index.split("\n")[-80:])          # exposures live in the recent past
        today = time.strftime("%Y-%m-%d")                     # anchor the year — an undated model
        got = asyncio.run(_ask(EXPOSURE_SYS,                  # guessed 2025 and the watch would have
            f"TODAY IS {today}. Window_end must be AFTER today.\n\nRECENTLY SENT:\n\n{recent}",
            max_tokens=800)) or {}                            # expired at birth (caught in demo)
        created = []
        c = _conn(tenant)
        try:
            active = {r[0] for r in c.execute("SELECT what FROM watches WHERE status='active'")}
            for e in (got.get("exposures") or [])[:4]:
                what, locus = str(e.get("what") or "")[:200], str(e.get("locus") or "")[:120]
                if not what or not locus or what in active:
                    _shadow_log(tenant, e, "rejected:dup-or-empty")
                    continue
                _shadow_log(tenant, e, "created:exposure")
                c.execute("INSERT INTO watches (what,kind,target,care,cadence_h,created_at,origin,expires_at) "
                          "VALUES (?,?,?,?,?,?,'exposure',?)",
                          (what, "search", f"{locus} breaking news disruption today", str(e.get("care") or "")[:400],
                           6, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                           str(e.get("window_end") or "")[:10] or None))
                created.append(what)
            c.commit()
        finally:
            c.close()
        return created
    except Exception:
        return []


def expire(tenant: str):
    """Exposures die with their window; nobody should be told about unrest in a city they left."""
    try:
        import datetime as dt
        c = _conn(tenant)
        try:
            c.execute("UPDATE watches SET status='done' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?",
                      (dt.date.today().isoformat(),))
            c.commit()
        finally:
            c.close()
    except Exception:
        pass


def origin_of(tenant: str, watch_id: int) -> str:
    try:
        c = _conn(tenant)
        try:
            row = c.execute("SELECT origin FROM watches WHERE id=?", (watch_id,)).fetchone()
            return (row[0] if row else "asked") or "asked"
        finally:
            c.close()
    except Exception:
        return "asked"


def due(tenant: str):
    """Ids of active watches past their cadence. Cheap; called by the tick."""
    try:
        c = _conn(tenant)
        try:
            rows = c.execute("SELECT id, cadence_h, last_checked FROM watches WHERE status='active'").fetchall()
        finally:
            c.close()
        out = []
        now = time.time()
        for wid, cad, lc in rows:
            if not lc:
                out.append(wid)
                continue
            try:
                # timegm, NOT mktime: last_checked is UTC (the Z is real). mktime read the
                # UTC struct as LOCAL, placing every check 7h in the future — so every
                # watch ran ~7h late; a concert postponement could have fired half a day
                # earlier (8/9 audit).
                import calendar
                t = calendar.timegm(time.strptime(lc, "%Y-%m-%dT%H:%M:%SZ"))
            except ValueError:
                out.append(wid)
                continue
            if now - t >= (cad or CHECK_DEFAULT_HOURS) * 3600:
                out.append(wid)
        return out
    except Exception:
        return []


def listing(tenant: str) -> str:
    """One line per active watch — the receipts of the mandate."""
    try:
        c = _conn(tenant)
        try:
            rows = c.execute("SELECT what, kind, last_checked, fire_count FROM watches WHERE status='active' ORDER BY id").fetchall()
        finally:
            c.close()
        if not rows:
            return "no watches running."
        return "\n".join(f"- {w} ({k}{', fired ' + str(f) + 'x' if f else ''})" for w, k, lc, f in rows)
    except Exception:
        return "no watches running."


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--scout":
        expire("dennis")
        made = (scout("dennis") or []) + (exposure_scout("dennis") or [])
        print(json.dumps(made, indent=2) if made else "(scout proposed nothing — the bar held)")
    elif args and args[0] == "--list":
        print(listing("dennis"))
    elif args and args[0] == "--check":
        for wid in due("dennis"):
            line = check("dennis", wid)
            print(f"  watch {wid}: {line or '(no material change)'}")
    elif args:
        got = create("dennis", " ".join(args))
        print(json.dumps(got, indent=2) if got else "(could not compile that into a watch)")
    else:
        print(listing("dennis"))
