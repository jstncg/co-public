#!/usr/bin/env python3
"""The unasked delivery (PROGRAM cap 4, book-flavored v1) — one weekly find they didn't know existed.

Wired: NOT scheduled — the Fri 18:00 cron this claimed has never existed (checked 9/1). Supersedes the removed career-gasp unasked.py. To be subsumed by
reconciler.py's EXPOSURE lane (the canonical spine) — see ARCHITECTURE.md §3.

A friend flicking something at you, not a recommendation engine. Sources via Exa (Gemini grounding as
fallback), themed from the tenant's OWN claims (for the founder right now: the Barnes & Noble shelf runs —
anthropology, cult-building, group belief formation). The bar is the applies-to-a-stranger test: the
delivery must say why it's for THEM, or the composer abstains. Silence beats a card catalog.

Budgets: ONE per tenant per week (<db>.lastunasked.json), respects the 'not tonight' skip flag and the
shared daily callback budget. Staged by default; --send is allowlist-gated like daily_text.

  python3 unasked_delivery.py                       # stage for every due tenant
  python3 unasked_delivery.py --tenant dennis --force --samples 3   # generate N staged samples, ignore budgets
  python3 unasked_delivery.py --send                # real sends (CO_TEST_HANDLES-gated)
Cron: weekly (e.g. saturday morning), with --send once trusted.
"""
import datetime as dt
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

TEXTURE_SYS = """You are Co, texting first with a FIND: one real thing (a book, mostly) adjacent to this person's
life that they didn't know existed. You are given what they've been circling (their own claims) and live search
results. Write the one text, or abstain.

THE TEXTURE (a friend flicking something at you, never a recommendation engine):
- Opener shapes (vary, don't template): "watchu know about [thing]" / "the [their thing] shelf skipped the
  best one" / just the find + one beat of why it's THEIRS.
- The why-them is the whole point: tie it to the SPECIFIC thing they've been circling ("your bookstore haul
  says you're three weeks from finding him anyway"). If the why-them could apply to a stranger, ABSTAIN.
- It invites a riff (one beat, a dare or a hook), never delivers a review or a summary.
- Sometimes the point is the laugh. Funny-first is allowed when the find is genuinely for them.
- ONE find only. Under 220 characters. lowercase-leaning, two humans texting.
BANNED (recommendation-engine tells, instant death): "based on your", "you might enjoy", "you might like",
"i found something", "i came across", "recommend", "check out", "worth a read", "adding to your list",
bullet lists, more than one find, em-dashes, "since you're interested in".
Return ONLY JSON: {"text":"<the text>"} or {"text":null}"""


def _claims_db(tenant: str) -> Path:
    t = re.sub(r"[^a-z0-9_+\-]", "_", (tenant or "dennis").strip().lower()) or "dennis"
    return HERE / ("claims.db" if t == "dennis" else f"claims_{t}.db")


def _sent_this_week(db: Path) -> bool:
    p = Path(f"{db}.lastunasked.json")
    try:
        if p.exists():
            last = dt.date.fromisoformat(json.loads(p.read_text())["date"])
            return (dt.date.today() - last).days < 7
    except (json.JSONDecodeError, OSError, ValueError, KeyError):
        pass
    return False


def gather_themes(db: Path, k: int = 6) -> list:
    """What they've been circling lately — reading/interest-shaped claims, freshest first."""
    if not db.exists():
        return []
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    like = ("%book%", "%read%", "%anthropolog%", "%cult%", "%belief%", "%interested in%", "%drawn to%",
            "%watch%", "%circling%", "%obsess%")
    rows = []
    try:
        for pat in like:
            rows += c.execute(
                "SELECT statement, COALESCE(last_verified, first_seen) AS d FROM claims "
                "WHERE statement LIKE ? AND COALESCE(status,'active')!='retired' "
                "AND id NOT IN (SELECT supersedes FROM claims WHERE supersedes IS NOT NULL) "
                "ORDER BY d DESC LIMIT 4", (pat,)).fetchall()
    except sqlite3.OperationalError:
        pass
    finally:
        c.close()
    seen, out = set(), []
    for stmt, d in sorted(rows, key=lambda r: r[1] or "", reverse=True):
        if stmt not in seen:
            seen.add(stmt)
            out.append({"claim": stmt, "when": d})
        if len(out) >= k:
            break
    return out


def search_finds(themes: list, n: int = 6) -> list:
    """Live source material: Exa first, Gemini search-grounding fallback. Returns [{title,url,snippet}]."""
    topics = "; ".join(t["claim"][:90] for t in themes[:3])
    queries = [
        f"overlooked book recommendation adjacent to: {topics}",
        f"the book people who read about {themes[0]['claim'][:60]} always miss" if themes else "",
    ]
    finds = []
    key = os.environ.get("EXA_API_KEY")
    if key:
        import requests
        for q in [q for q in queries if q][:2]:
            try:
                r = requests.post("https://api.exa.ai/search", timeout=25,
                                  headers={"x-api-key": key, "Content-Type": "application/json"},
                                  json={"query": q, "numResults": n, "type": "auto",
                                        "contents": {"summary": {"query": "what book/idea is this and who is it for"}}})
                for res in (r.json().get("results") or []):
                    finds.append({"title": res.get("title"), "url": res.get("url"),
                                  "snippet": (res.get("summary") or "")[:300]})
            except Exception as e:
                print(f"  (exa: {e})", file=sys.stderr)
    if not finds:                                            # Gemini grounding fallback
        try:
            import link_read
            client = link_read._gemini_client()
            if client:
                from google.genai import types
                resp = client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=f"Find 4 specific real books adjacent to these interests, with one line each on "
                             f"why (title, author, year): {topics}",
                    config=types.GenerateContentConfig(tools=[types.Tool(google_search=types.GoogleSearch())]))
                if resp.text:
                    finds.append({"title": "grounded search", "url": "", "snippet": resp.text[:1200]})
        except Exception as e:
            print(f"  (grounding: {e})", file=sys.stderr)
    return finds[:8]


def compose(themes: list, finds: list) -> str | None:
    if not (os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")):
        return None
    import disposition
    try:
        from anthropic import Anthropic
        tok = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
        client = (Anthropic(auth_token=tok, default_headers={"anthropic-beta": "oauth-2025-04-20"})
                  if tok else Anthropic())
        payload = json.dumps({"what_theyve_been_circling": themes, "live_finds": finds})
        for model in (os.environ.get("CO_PHRASE_MODEL", "claude-sonnet-4-6"), "claude-haiku-4-5"):
            try:
                r = client.messages.create(model=model, system=TEXTURE_SYS, max_tokens=200,
                                           messages=[{"role": "user", "content": payload}])
            except Exception as e:
                if "rate_limit" in str(e):
                    continue
                return None
            txt = "".join(b.text for b in r.content if b.type == "text")
            m = re.search(r"\{.*\}", txt, re.S)
            text = (json.loads(m.group(0)).get("text") if m else None)
            if not text or str(text).lower() == "null":
                return None
            text = disposition.sanitize(str(text))
            if disposition.violations(text, max_chars=240) or texture_violations(text):
                return None                        # failed the gates — silence beats slop
            return text
    except Exception as e:
        print(f"  (compose: {e})", file=sys.stderr)
    return None


REC_ENGINE = re.compile(r"(?i)based on your|you might (enjoy|like)|i found something|i came across|recommend"
                        r"|check out|worth a read|adding to your list|since you'?re interested")


def texture_violations(text: str) -> list:
    v = []
    if REC_ENGINE.search(text):
        v.append("recommendation-engine phrasing")
    if text.count("\n") > 2:
        v.append("too many beats")
    return v


def run_tenant(tenant: str, send: bool, force: bool, samples: int = 1) -> list:
    db = _claims_db(tenant)
    if not force:
        if _sent_this_week(db):
            return [f"[hold] {tenant} — already delivered this week"]
        skip = Path(f"{db}.skip")
        if skip.exists() and skip.read_text().strip() == dt.date.today().isoformat():
            return [f"[hold] {tenant} — 'not tonight' flag"]
        import co_react
        if co_react.callback_used_today(f"{db}.co_memory.db"):
            return [f"[hold] {tenant} — callback budget spent today"]
    themes = gather_themes(db)
    if not themes:
        return [f"[hold] {tenant} — nothing they've been circling (abstain)"]
    finds = search_finds(themes)
    if not finds:
        return [f"[hold] {tenant} — no live source material (abstain)"]
    out = []
    staged = []
    for i in range(max(1, samples)):
        text = compose(themes, finds)
        if not text:
            out.append(f"[hold] {tenant} — composer abstained (sample {i+1})")
            continue
        staged.append(text)
        out.append(f"[stage] {tenant} → {text!r}")
    if staged:
        Path(f"{db}.staged_unasked.json").write_text(json.dumps(
            {"date": dt.date.today().isoformat(), "texts": staged,
             "themes": [t["claim"][:100] for t in themes[:3]]}, ensure_ascii=False, indent=1))
    if send and staged:
        import daily_text
        phone = daily_text.tenant_phone(tenant, daily_text._cfg(Path(db)))
        if phone and daily_text._allowlisted(phone) and daily_text._sendblue(phone, staged[0]):
            Path(f"{db}.lastunasked.json").write_text(json.dumps({"date": dt.date.today().isoformat()}))
            daily_text.record_outbound(tenant, staged[0])   # the engine must own its own words
            import co_react
            co_react.mark_callback("unasked", f"{db}.co_memory.db")
            try:
                import work
                theme = (themes[0]["claim"][:80] if themes else "a live thread of yours")
                work.log(tenant, "found", "sourced this week's unasked find",
                         why=f"themed from: {theme}")
            except Exception:
                pass
            out.append(f"[SENT] {tenant}")
        else:
            out.append(f"[hold] {tenant} — staged but not allowlisted/no phone")
    return out


def main():
    a = sys.argv[1:]
    send = "--send" in a
    force = "--force" in a
    samples = int(a[a.index("--samples") + 1]) if "--samples" in a else 1
    import daily_text
    tenants = [a[a.index("--tenant") + 1]] if "--tenant" in a else \
        ["dennis"] + [t for t in (p.name[len("claims_"):-len(".db")] for p in sorted(HERE.glob("claims_*.db"))
                                  if not p.name.endswith(".co_memory.db"))
                      if not daily_text._is_founder_alias(t)]
    print(f"unasked {'SEND' if send else 'stage-only'} — {dt.datetime.now().isoformat(timespec='seconds')}")
    for t in tenants:
        for line in run_tenant(t, send, force, samples):
            print(" " + line)


if __name__ == "__main__":
    main()
