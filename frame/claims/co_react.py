#!/usr/bin/env python3
"""Co — v1 core loop: send → relate-to-you → RESTRAINED reaction → remember.

The product (V1_PRODUCT_SPEC.md): you text Co the things you scroll past or think (reels, tweets,
shorts, shower thoughts). It does NOT store or summarize. It REACTS with disposition — relates what
you sent to YOU (the model-of-you in claims.db) and, only when it genuinely matters, says the one line
that nails you. RESTRAINT is rule #1: most sends get a light touch (👀) or nothing; the product is the
RARE one-liner ("third quitting video this week. you're not researching it, you're working up the
nerve" style reads, minus the contrast template). Overdone = a needy assistant = dead by day 9.

Architecture mirrors cold_open.py: DETERMINISTIC relate + gate, LLM only PHRASES (never invents a claim).

  RELATE  — semantic recall over the model-of-you (voyage embeddings already in claims.db).
  GATE    — score each match for LINE-worthiness: a self-defining BEHAVIORAL dimension (what you avoid /
            chase / are becoming), not a LOG (what you own / subscribe to / visit). Re-ranks so a 0.82
            avoidance pattern beats 0.80 Docker-CI noise. Tiers: NONE → LIGHT(emoji) → LINE.
  PHRASE  — if the gate says LINE, turn the grounded pattern into ONE held-as-a-guess text. LLM if a
            client is available (claude-haiku), else a faithful deterministic constructor. Validated:
            one line, no checklist, grounded token survives, or it falls back to LIGHT.
  REMEMBER— append send + reaction + matched pattern to co_memory.db (NEW file; claims.db is read-only
            here). Powers the "third X this week" repetition mechanic.

LOCAL TEST ONLY — never sends an iMessage, never touches Sendblue. Sendblue wiring + the EOD voice call
are out of scope (see report). Run the demo:

  cd claims && python3 co_react.py            # 3 example sends (reel / tweet / shower thought)
  cd claims && python3 co_react.py "your own send text here"
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

DEFAULT_DB = str(HERE / "claims.db")
CO_MEMORY = str(HERE / "co_memory.db")   # NEW, bounded session memory — never the 144MB claims.db

# ── tiers ──────────────────────────────────────────────────────────────────────────────────────────
NONE, LIGHT, LINE = "none", "light", "line"

# ── restraint dials (tuned: ~2 of 3 sends land LIGHT/NONE, the rare one earns a LINE) ───────────────
# A LINE is expensive. It must clear LINE_BAR on (resonance × who-you-are weight × confidence).
LINE_BAR = 0.42          # the wire a match must cross to earn a one-liner
LIGHT_SIM = 0.46         # below LINE but the send is still genuinely ABOUT something you → a 👀
RECALL_K = 14            # pull wide; the right pattern is often buried under log-noise on raw cosine

# Self-defining BEHAVIORAL dimensions (how you operate / what you avoid / who you're becoming) — the gold.
# These are the reads that make you go "how would it even know to look at that." Lexicon over the claim.
# 9/3: every VALENCED term in here was a deficit — avoid, struggle, can't, won't, fear, flinch,
# never finish, almost ready. The neutral ones (identity, becoming, status) survived, but there was
# not one term for a strength, so the gate was structurally unable to surface what someone IS and
# could only ever surface what they fail at. That is why it has one move, and why it had nothing to
# say on the day the founder asked it what archetype he is. A model of a person that can only find
# flaws is not a model of a person.
DIMENSION = re.compile(
    r"\b(repeatedly|avoid|delay|procrastin|doesn'?t follow through|instead of|keeps?|tends? to|struggle|"
    r"can'?t|won'?t|wants? to (be|own|prove|seem)|identity|status|becoming|chasing|fear|flinch|comfort|"
    r"hype|drop(s|ped)?|commits? but|never finish|almost (ready|done)|over[- ]?engineer|refactor|"
    # the other half: how they operate when it works
    r"archetype|strength|good at|great at|style|taste|judgment|instinct|eye for|"
    r"consistently|reliably|always (?:the|been)|returns? to|goes? deep|finishes|ships|builds|"
    r"notices|catches|spots|decides|chooses|protects|defends|insists|holds? out for|"
    r"cares? about|drawn to|energ(?:y|ised|ized) by|thrives?|at their best)\b", re.I)

# LOG reads — what you own / subscribe to / where you go / which repo. The AI can obviously access these;
# they read a FILE, not how you operate. Strong penalty: NEVER the basis for the rare one-liner.
LOG = re.compile(
    r"\b(owns?|holds?|stock|subscrib|receives?|visits?|account|merchant|delivery|coffee|docker|repository|"
    r"ci/?cd|pipeline|github|uber|doordash|amazon|airbnb|newsletter|premium|venmo|paypal|credit card)\b", re.I)

# level → how much this claim is about WHO YOU ARE vs a transaction log.
LEVEL_W = {"frame": 1.15, "pattern": 1.0, "fact": 0.8}


def _now():
    return dt.datetime.now().isoformat(timespec="seconds")


# ── REMEMBER (and the repetition signal that powers "third X this week") ─────────────────────────────
def _memory(path=CO_MEMORY):
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE IF NOT EXISTS co_sends (id INTEGER PRIMARY KEY, ts TEXT, send TEXT, "
              "tier TEXT, reaction TEXT, matched TEXT, theme TEXT)")
    for col in ("sim REAL", "line_score REAL"):
        try:
            c.execute(f"ALTER TABLE co_sends ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass
    c.execute("CREATE TABLE IF NOT EXISTS callbacks (day TEXT PRIMARY KEY, kind TEXT)")
    c.commit()
    return c


# ── the callback budget (tasteful resurfacing, 7/1 addendum) ────────────────────────────────────────
# Referencing PRIOR sends (the count, the continuation, yesterday's thread) is a CALLBACK. Max ONE per
# tenant per day, across co_react AND daily_text (both write this table in the tenant's co_memory db).
# A missed callback costs nothing; a forced one reads as surveillance.
def callback_used_today(path=CO_MEMORY) -> bool:
    if not Path(path).exists():
        return False
    c = _memory(path)
    row = c.execute("SELECT 1 FROM callbacks WHERE day=?", (dt.date.today().isoformat(),)).fetchone()
    c.close()
    return bool(row)


def mark_callback(kind: str, path=CO_MEMORY) -> None:
    c = _memory(path)
    c.execute("INSERT OR IGNORE INTO callbacks (day, kind) VALUES (?,?)", (dt.date.today().isoformat(), kind))
    c.commit()
    c.close()


def _theme(statement: str) -> str:
    """A coarse key for 'the same kind of thing' — so two refactor-avoidance sends count as a repeat
    even if phrased differently. Cheap, deterministic; the LLM is not in this path."""
    s = (statement or "").lower()
    for key, pat in (("shipping-avoidance",
                      r"\bship(s|ped|ping)?\b|\brefactor|\bfollow through\b|\bfinish|\blaunch|\balmost ready\b|\bover[- ]?engineer"),
                     ("founder-identity", r"\bfounder|\bhype\b|\bstatus\b|\bdropout|\bown something\b|\bequity\b"),
                     ("quitting",
                      r"\bquit(s|ting)?\b|\bleav(e|es|ing)\b|\bleft (google|corporate|law|consult\w*)\b|\bburn ?out|\bdone with\b|\bescape|\brun ?away\b|\bmove abroad\b|\bvan ?life\b|\bsabbatical|\bsold everything\b|\bsail(s|ed|ing)?\b"),
                     ("relationships", r"\breach out\b|\binitiat|\bcooled\b|\bendearment|\bpriority contact\b|\bdrifted")):
        if re.search(pat, s):
            return key
    return "other"


def send_run_count(text: str, memory_path: str = CO_MEMORY, days: int = 7):
    """Deterministic 'this is the Nth send of this kind' (7/2 cycle-4 fix). Themed from the RAW send
    texts at count time — stored theme labels are claim-derived (unreliable pre-onboarding) and threads
    counts are Gemini-fuzzy (they conflate onboarding mentions with sends; the off-by-one bug). MUST be
    called BEFORE react() writes the current send. Returns (theme, n) with n INCLUDING the current send."""
    theme = _theme(text)
    if theme == "other":
        return "other", 1
    n = 1
    if Path(memory_path).exists():
        c = _memory(memory_path)
        cutoff = (dt.datetime.now() - dt.timedelta(days=days)).isoformat()
        rows = c.execute("SELECT send FROM co_sends WHERE ts>=?", (cutoff,)).fetchall()
        c.close()
        n += sum(1 for (prior,) in rows if _theme(prior) == theme)
    return theme, n


# count_hint() REMOVED (8/7). It handed the brain a literal ordinal ("this is the THIRTEENTH send of
# its kind") on every turn, from the router, on a path that bypassed gate() entirely — so the gate's
# fire-once-per-pattern rule and the one-callback-per-day budget could both say "hold it" and the model
# would still announce the tally. Counting sends back at someone is the single most complained-about
# behavior in the product; it reads as surveillance, not memory. The run count still exists as a GATE
# signal (send_run_count below, used by react()), where it shapes whether a line fires. It no longer
# reaches the mouth.


def theme_already_read(theme: str, days=30, path=CO_MEMORY) -> int:
    """How many times co has ALREADY DELIVERED a LINE on this theme (not how often THEY sent it).

    8/5, from every user log: "you keep bouncing on this" was told to a tester ~100 times, and
    "eighth one of these this week" fired unprompted. Both founders named it the most enraging
    behavior in the product. A pattern earns ONE surfacing — after that it is CONTEXT, not
    content: co may act on it, never announce it again."""
    if not Path(path).exists():
        return 0
    c = _memory(path)
    cutoff = (dt.datetime.now() - dt.timedelta(days=days)).isoformat()
    n = c.execute("SELECT COUNT(*) FROM co_sends WHERE theme=? AND tier=? AND ts>=?",
                  (theme, LINE, cutoff)).fetchone()[0]
    c.close()
    return n


def recent_theme_count(theme: str, days=7, path=CO_MEMORY) -> int:
    if not Path(path).exists():
        return 0
    c = _memory(path)
    cutoff = (dt.datetime.now() - dt.timedelta(days=days)).isoformat()
    n = c.execute("SELECT COUNT(*) FROM co_sends WHERE theme=? AND ts>=?", (theme, cutoff)).fetchone()[0]
    c.close()
    return n


# ── NOVELTY — "i have never seen you send something like this" (9/8) ───────────────────────
# The eyes used to mean "co read it", which is a fact about co and true of every send — a mark that
# fires always is not a signal, the same objection 8/7 made to the thumbs-up. Surprise is the opposite:
# it can only fire on the send that earns it. Measured off THEIR OWN history and nothing else, so the
# claim is literal rather than a mood: a host they have never sent co before.
#
# NOVEL_FLOOR exists because an empty shelf makes everything novel. In week one every link is a first,
# so the mark would fire on all of them and say nothing — the failure this is meant to avoid. Below the
# floor co has not seen enough of them to be surprised by anything, and says so by staying quiet.
NOVEL_FLOOR = 20         # prior sends before "never seen this" is a claim rather than an empty shelf


def _hosts(text: str) -> set:
    """The sources in a send. link_read owns URL-finding, urlsplit owns hosts.

    Per-URL try: urlsplit raises ValueError on a malformed one ("http://[oops" → Invalid IPv6 URL),
    and this runs over their whole history — one bad row from months ago would otherwise take the
    novelty check down for that member permanently, quietly, at log.debug."""
    import link_read
    from urllib.parse import urlsplit
    out = set()
    for u in link_read.find_urls(text or ""):
        try:
            h = urlsplit(u).hostname
        except ValueError:
            continue
        if h:
            out.add(h.lower().removeprefix("www."))
    return out


def novel_source(text: str, memory_path: str = CO_MEMORY) -> bool:
    """True when this send carries a link from a host they have never sent co before.

    A LINK, NOT A PHOTO: an attachment has no source to be new, so it takes the ordinary mark.

    ponytail: scans their whole send table per content send. co_memory is bounded and personal;
    index co_sends(ts) and window it if that stops being true."""
    here = _hosts(text)
    if not here or not Path(memory_path).exists():
        return False
    c = _memory(memory_path)
    rows = c.execute("SELECT send FROM co_sends").fetchall()
    c.close()
    if len(rows) < NOVEL_FLOOR:
        return False
    seen = set()
    for (prior,) in rows:
        seen |= _hosts(prior)
    return bool(here - seen)


def remember(send, tier, reaction, matched, theme, path=CO_MEMORY, sim=None, line_score=None):
    c = _memory(path)
    c.execute("INSERT INTO co_sends (ts, send, tier, reaction, matched, theme, sim, line_score) "
              "VALUES (?,?,?,?,?,?,?,?)",
              (_now(), send, tier, reaction, matched or "", theme, sim, line_score))
    c.commit()
    c.close()


# ── RELATE — semantic recall over the model-of-you, returning full structured candidates ─────────────
def relate(send: str, claims_db: str = DEFAULT_DB, k: int = RECALL_K):
    """Find the claims about you most related to what you sent. Reuses the voyage embeddings already in
    claims.db (the same vectors recall_semantic uses). Falls back to keyword recall if voyage/numpy are
    unavailable, so the loop still runs locally without VOYAGE_API_KEY."""
    if not Path(claims_db).exists():
        return []          # brand-new tenant: no model-of-you yet → nothing resonates → restraint (silence)
    def _ev_n(evidence) -> int:
        """Corroboration count for the anti-overfit gate (a LINE needs a claim with receipts)."""
        try:
            ev = json.loads(evidence or "[]")
            return len(ev) if isinstance(ev, list) else 1
        except (json.JSONDecodeError, TypeError):
            return 1
    try:
        import numpy as np
        import embed as _e
        c = sqlite3.connect(f"file:{claims_db}?mode=ro", uri=True)
        base = ("SELECT statement, type, level, confidence, evidence, embedding FROM claims "
                "WHERE embedding IS NOT NULL AND COALESCE(status,'active')!='retired' "
                "AND COALESCE(evidence,'') NOT LIKE '%\"source\": \"canon\"%' "   # co's docs are not him (8/29)
                "AND COALESCE(graded,'')!='demote'")
        try:      # superseded rows are history, not the present (7/2 supersede chains)
            rows = c.execute(base + " AND id NOT IN (SELECT supersedes FROM claims WHERE supersedes "
                                    "IS NOT NULL AND COALESCE(status,'active')!='retired')").fetchall()
        except sqlite3.OperationalError:
            rows = c.execute(base).fetchall()     # pre-migration db (read-only; migrates on next write)
        c.close()
        if not rows:
            return []
        M = np.array([np.frombuffer(r[5], dtype=np.float32) for r in rows])
        M = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-9)
        q = np.asarray(_e.voyage([send], input_type="query")[0], dtype=np.float32)
        q = q / (np.linalg.norm(q) + 1e-9)
        sims = M @ q
        top = sims.argsort()[::-1][:k]
        return [{"statement": rows[i][0], "type": rows[i][1], "level": rows[i][2],
                 "confidence": float(rows[i][3]), "sim": float(sims[i]), "ev_n": _ev_n(rows[i][4])} for i in top]
    except Exception as e:                                    # graceful, offline-safe
        print(f"  (semantic recall unavailable, keyword fallback: {e})", file=sys.stderr)
        c = sqlite3.connect(f"file:{claims_db}?mode=ro", uri=True)
        like = "%" + " ".join(re.findall(r"[a-z]{4,}", send.lower())[:4]) + "%"
        rows = c.execute("SELECT statement, type, level, confidence, evidence FROM claims WHERE statement LIKE ? "
                         "AND COALESCE(status,'active')!='retired' ORDER BY confidence DESC LIMIT ?",
                         (like, k)).fetchall()
        c.close()
        return [{"statement": s, "type": t, "level": lv, "confidence": float(cf), "sim": 0.4, "ev_n": _ev_n(ev)}
                for s, t, lv, cf, ev in rows]


# ── GATE — the restraint engine. Re-rank for LINE-worthiness, then pick a tier ──────────────────────
def _line_score(r) -> float:
    """How much this match earns the RARE one-liner. Resonance (the send is about it) × who-you-are
    weight (a behavioral dimension, not a log) × confidence."""
    s = r["sim"] * LEVEL_W.get(r["level"], 0.8) * (0.5 + 0.5 * r["confidence"])
    if DIMENSION.search(r["statement"]):
        s += 0.18                      # a 'how you operate' read — the thing worth interrupting for
    if LOG.search(r["statement"]):
        s -= 0.22                      # a 'what you own' read — never the basis for a one-liner
    return s


def gate(send: str, related: list, memory_path: str = CO_MEMORY):
    """Decide the tier. Default is SILENCE. The bar to speak is high; the bar for the one-liner is higher.

    ANTI-OVERFIT (7/1 addendum, hard rule): one send proves nothing. A LINE may only stand on a claim
    with 2+ evidence points OR a theme they've already sent 2+ times before this week. One tweet about
    quitting does NOT make them "the person who wants to quit" — single-evidence claims stay internal
    until corroborated."""
    if not related:
        return {"tier": NONE, "match": None, "score": 0.0, "repeat": 0,
                "why": "nothing in the model-of-you resonated"}
    ranked = sorted(related, key=_line_score, reverse=True)
    best = ranked[0]
    score = _line_score(best)
    theme = _theme(best["statement"])
    # Repetition only means something for a REAL theme — "other" is a catch-all, and "you've sent two
    # unrelated things this week" is noise, not a pattern. No lift, no corroboration from it.
    repeat = recent_theme_count(theme, path=memory_path) if theme != "other" else 0

    # repetition is the strongest signal there is — the "third X this week" effect. It can lift a
    # borderline match over the wire, and it changes what the line says.
    eff = score + (0.10 if repeat >= 2 else 0.05 if repeat == 1 else 0.0)
    # Corroborated = receipts. 2+ evidence points, OR they've sent this theme 2+ times this week, OR the
    # claim is PATTERN-level at high confidence (the extractor only grants `pattern` on repeated behavior,
    # so a high-confidence pattern has receipts by construction even when its evidence array holds one row).
    corroborated = (best.get("ev_n", 1) >= 2 or repeat >= 2
                    or (best["level"] == "pattern" and best["confidence"] >= 0.75))

    # LINE relevance floor (7/2): the send must ACTUALLY relate to the claim it fires on. Measured on the
    # founder graph: genuine reads land ~0.39+, junk that rides theme/dimension lifts sits lower. Floor at
    # 0.37, with the corroboration gate still applying on top.
    # AND the line-worthiness law made hard (the Bugatti receipt): a LINE stands on a BEHAVIORAL claim
    # (how they operate — avoid/chase/becoming), never a topical interest match, unless repetition itself
    # is the read (the count line). Topical matches are exactly the vague stranger-fit reads.
    behavioral = bool(DIMENSION.search(best["statement"]))
    # FIRE-ONCE PER PATTERN (8/5). Saying the same read twice is not emphasis, it is nagging —
    # the single most complained-about behavior across every log. Once a theme has been read
    # aloud, it stays in the model and out of the mouth.
    if theme != "other" and theme_already_read(theme, path=memory_path) >= 1:
        return {"tier": LIGHT, "match": best, "score": round(eff, 3), "repeat": repeat, "theme": theme,
                "why": f"already read the '{theme}' pattern aloud — it is context now, not content"}
    if eff >= LINE_BAR and best["sim"] >= 0.37:
        if not behavioral and repeat < 2:
            return {"tier": LIGHT, "match": best, "score": round(eff, 3), "repeat": repeat, "theme": theme,
                    "why": "topical match, not a behavioral claim — a glance, never the vague read"}
        if not corroborated:
            return {"tier": LIGHT, "match": best, "score": round(eff, 3), "repeat": repeat, "theme": theme,
                    "why": f"line-worthy but uncorroborated (evidence {best.get('ev_n', 1)}, repeat {repeat}) "
                           "— anti-overfit says hold it"}
        return {"tier": LINE, "match": best, "score": round(eff, 3), "repeat": repeat, "theme": theme,
                "why": f"behavioral dimension cleared the wire ({best['level']}, conf {best['confidence']:.0%}, "
                       f"evidence {best.get('ev_n', 1)}, repeat {repeat})"}
    top_sim = max(r["sim"] for r in related)
    if top_sim >= LIGHT_SIM:
        return {"tier": LIGHT, "match": best, "score": round(eff, 3), "repeat": repeat, "theme": theme,
                "why": "real resonance but nothing worth a sentence — a glance, not a lecture"}
    return {"tier": NONE, "match": best, "score": round(eff, 3), "repeat": repeat, "theme": theme,
            "why": "skimmed past it — holding back IS the product"}


# ── PHRASE — LINE only. LLM if available; faithful deterministic constructor otherwise ───────────────
# Cheap eyes, expensive mouth: Gemini flash-lite does the ingestion; THIS call is the product's mouth, so
# it gets the strongest available Claude (env CO_PHRASE_MODEL to override).
PHRASE_MODEL = os.getenv("CO_PHRASE_MODEL", "claude-sonnet-4-6")

PHRASE_SYS = """Someone just texted you something they scrolled past or thought (a reel, tweet, short, screenshot,
or shower thought). You are the sharp friend who's been paying attention the whole time. You quietly relate
what they sent to ONE true thing you already know about them (given below) and text back ONE line.

THE LINE: the rare text that lands so hard they screenshot it. Say it as fact, total conviction, warmth
under it. If they've sent this kind of thing before, the READ is the line, never the tally: say what the
run means ("still circling the same exit"), never how many times it happened. It ends pointed OUTWARD at
their life; it opens the thread, it never finishes the thought for them. And it carries belief in them:
they walk away seen AND backed, never just seen through.

HARD RULES (restraint is the whole product — overdone = a needy assistant = they leave):
- ONE line, under 200 characters. No second sentence of explanation. A text, not a memo.
- React, don't summarize. NEVER restate what they sent. Tie it to THEM (the true thing) and stop.
- Keep the grounded specific (the named thing/behavior). Do NOT add any new claim, motive, or psychology.
- Continuation, not recall: "still on the founder-burnout beat" is right; "you previously sent a video
  about quitting" reads as surveillance and is dead.
- No hedging ("have you considered maybe" is dead). No lecturing, no moralizing, no advice.
- The line is OWNED: your read, stated like you'd bet on it. No "maybe", no both-sides. Wrong-and-owned
  beats neutral-and-safe.
- ALWAYS lowercase (proper nouns and acronyms keep their caps), contractions, fragments fine. two humans texting.
- match the hour you're given: 2am = quiet and low, morning = brief and forward, evening can stretch.
- NEVER: em-dashes (the — character is banned; use a period or comma), bullet lists, "not X, it's Y"
  constructions, rule-of-three, more than one question, emoji spam, sycophancy, therapy-speak, assistant-speak.
Return ONLY JSON: {"text":"<the one line>"}"""


def _constructor(send, match, repeat, theme) -> str:
    """Deterministic, faithful one-liners grounded in the matched pattern — the offline phraser (and the
    spec of what 'good' looks like). Used when no LLM client; the LLM is the upgrade, not a requirement."""
    # No tally prefix (8/7): a repeat is why this line is allowed to fire, never something to announce.
    nth = "again. " if repeat >= 1 else ""
    if theme == "shipping-avoidance":
        return f"{nth}another 'cleaner rewrite' before launch. that's the flinch dressed as craftsmanship. ship the ugly one."
    if theme == "quitting":
        return f"{nth}the research phase on leaving ended a while ago. say the real thing out loud."
    if theme == "founder-identity":
        return "you don't want to be a founder, you want to have been one. the hype's only leverage if there's output under it."
    if theme == "relationships":
        return "you reply to some people in minutes and let others sit for days. you saw yourself in that, didn't you?"
    # generic, still grounded in the matched statement
    return f"this one's about you. {match['statement'].rstrip('.').lower()}. you already knew that's why you sent it."


def _validate_line(text: str) -> bool:
    """The disposition gate on the mouth: shared banned-patterns list (disposition.py) + line shape."""
    if not text:
        return False
    t = text.strip()
    if t.count("\n") > 0:            # multi-line = a memo, not a text
        return False
    try:
        import disposition
        if disposition.violations(t, max_chars=220):
            return False
    except ImportError:              # degrade to the local shape checks
        if len(t) > 220 or "—" in t:
            return False
    if re.search(r"^\s*[-*\d]\s", t) or "•" in t:   # any list marker = failure
        return False
    return True


def _local_now(claims_db: str = "") -> str:
    """TENANT-local time + register for the phraser — replies must never misreference the hour."""
    now = dt.datetime.now()
    if claims_db:
        try:
            import tz_dynamic
            now = tz_dynamic.now_in(claims_db)
        except Exception:
            pass
    h = now.hour
    reg = "late night, quiet register" if (h >= 23 or h < 5) else \
          "morning, brief and forward" if h < 12 else "afternoon" if h < 18 else "evening"
    return f"{now.strftime('%A %I:%M %p').lstrip('0')} ({reg})"


def _llm_phrase(send, match, repeat, theme, claims_db: str = "", spent_note: str | None = None):
    """One call to the strongest available Claude, constrained to the grounded pattern. Returns '' on any
    failure → caller falls back to the constructor. Auth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY."""
    if not (os.getenv("CLAUDE_CODE_OAUTH_TOKEN") or os.getenv("ANTHROPIC_API_KEY")):
        return ""
    import llm
    # The run count reaches the GATE, never the mouth (8/7). This payload used to carry the exact
    # ordinal and instruct the model to speak it; see the count_hint removal note above for why.
    # A run still earns the line, it just gets said as continuity ("still on this") not as a tally.
    payload = {"they_sent": send, "the_true_thing": match["statement"],
               "never_count_their_sends_aloud": "no ordinals, no tallies, no 'third one this week'",
               "right_now_their_time": _local_now(claims_db)}
    if spent_note:
        payload["already_sent_before_banned_verbatim_do_not_reuse_its_wording"] = spent_note
    # Provider-swappable phrasing (7/2): CO_PHRASE_MODEL + CO_MODEL_FALLBACKS chain; defaults keep
    # the strongest-available-Claude behavior (flagship, step down to haiku when the window caps).
    txt = llm.complete_with_fallbacks(llm.phrase_specs(), PHRASE_SYS, json.dumps(payload), max_tokens=120)
    if not txt:
        print("  (llm phrase unavailable on all specs, using constructor)", file=sys.stderr)
        return ""
    m = re.search(r"\{.*\}", txt, re.S)
    line = (json.loads(m.group(0)).get("text", "") if m else "").strip()
    try:
        import disposition
        line = disposition.sanitize(line)
    except ImportError:
        pass
    return line if _validate_line(line) else ""


def phrase(send, match, repeat, theme, claims_db: str = "", memory_path: str = CO_MEMORY):
    """Every LINE is phrased FRESH against the current send (no caching, by design). A phrasing ever sent
    before is SPENT: LLM lines get one rephrase with the spent list in view; the static constructor can
    fire at most once per tenant, ever."""
    spent_note = None
    for _ in range(2):
        line = _llm_phrase(send, match, repeat, theme, claims_db, spent_note)
        if not line:
            break
        if not line_spent(line, memory_path):
            return line, "llm"
        spent_note = line                          # rephrase once, told exactly what's burned
    line = _constructor(send, match, repeat, theme)
    if _validate_line(line) and not line_spent(line, memory_path):
        return line, "constructor"
    return "", "none"                              # nothing fresh clears the bar → the glance, not a rerun


# ── spent lines (a sent LINE is spent forever — the repeated-canned-line class of bug, 7/2) ─────────
def _norm_line(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (t or "").lower()).strip()


def _grams4(t: str) -> set:
    w = _norm_line(t).split()
    return {" ".join(w[i:i + 4]) for i in range(len(w) - 3)} if len(w) >= 4 else {" ".join(w)} if w else set()


def line_spent(candidate: str, path=CO_MEMORY) -> bool:
    """True if this phrasing (or a near-copy: >70% 4-gram overlap) was ever sent as a LINE to this tenant."""
    if not candidate or not Path(path).exists():
        return False
    cg = _grams4(candidate)
    if not cg:
        return False
    c = _memory(path)
    rows = c.execute("SELECT reaction FROM co_sends WHERE tier='line' AND reaction!=''").fetchall()
    c.close()
    norm_c = _norm_line(candidate)
    for (prior,) in rows:
        if _norm_line(prior) == norm_c:
            return True
        pg = _grams4(prior)
        if pg and len(cg & pg) / min(len(cg), len(pg)) > 0.7:
            return True
    return False


# ── the LIGHT touch ─────────────────────────────────────────────────────────────────────────────────
def _light_emoji(send: str) -> str:
    s = send.lower()
    if re.search(r"\b(win|beat|shipped|launched|huge|insane|record|up \d|moon|🔥)\b", s):
        return "🔥"
    if re.search(r"\b(tired|burn|stress|cooked|exhausted|ugh|fml)\b", s):
        return "😮‍💨"
    return "👀"


# ── react: the full loop ─────────────────────────────────────────────────────────────────────────────
def _line_tenant_allowed(claims_db: str) -> bool:
    """LINE was calibrated on the founder's graph — off for everyone else unless CO_LINE_TENANTS says so (8/10)."""
    base = os.path.basename(claims_db or "")
    if base == "claims.db":
        tenant = os.environ.get("CO_FOUNDER_TENANT", "dennis")
    elif base.startswith("claims_") and base.endswith(".db"):
        tenant = base[len("claims_"):-len(".db")]
    else:
        tenant = base
    allowed = {t.strip() for t in os.environ.get("CO_LINE_TENANTS", "").split(",") if t.strip()}
    allowed.add(os.environ.get("CO_FOUNDER_TENANT", "dennis"))
    return tenant in allowed


def react(send: str, claims_db: str = DEFAULT_DB, write: bool = True, memory_path: str = CO_MEMORY):
    # memory_path is PER-TENANT (like claims_db): one stranger's send-history must never set another's
    # repetition signal ("third quitting video this week") — that's a cross-tenant leak of the creepiest kind.
    related = relate(send, claims_db)
    g = gate(send, related, memory_path)
    if g["tier"] == LINE and not _line_tenant_allowed(claims_db):
        g["tier"] = LIGHT
        g["why"] = "LINE lane is founder-only until allowlisted — " + g["why"]
    tier, match = g["tier"], g["match"]
    # Deterministic run count for PHRASING (cycle-4): computed from raw send texts BEFORE this send is
    # written below. Stored theme labels stay as the gate's corroboration signal only.
    theme_txt, n_run = send_run_count(send, memory_path)

    reaction, how = "", "silent"
    if tier == LINE:
        # A repetition-based line references PRIOR sends = a callback. Budget: ONE per tenant per day
        # (shared with daily_text via the same co_memory db). Budget spent → phrase without the count if
        # the claim stands on its own receipts, else hold to a glance.
        repeat_for_phrase = (n_run - 1) if theme_txt != "other" else 0
        if repeat_for_phrase >= 1 and callback_used_today(memory_path):
            if match.get("ev_n", 1) >= 2:
                repeat_for_phrase = 0          # the read still stands, just no continuity reference
            else:
                tier = LIGHT
                g["why"] += " (callback budget spent today)"
        if tier == LINE:
            line, how = phrase(send, match, repeat_for_phrase, g.get("theme", "other"), claims_db, memory_path)
            if line:
                reaction = line
                if write and repeat_for_phrase >= 1:
                    mark_callback("co_line", memory_path)
            else:                          # phrasing whiffed → degrade to a glance, never force it
                tier, reaction, how = LIGHT, _light_emoji(send), "fallback"
    if tier == LIGHT and not reaction:
        reaction, how = _light_emoji(send), "emoji"

    theme = g.get("theme", "other")
    if write:
        remember(send, tier, reaction, match["statement"] if match else "", theme, path=memory_path,
                 sim=(match or {}).get("sim"), line_score=g.get("score"))
    return {"send": send, "tier": tier, "reaction": reaction, "how": how,
            "match": match, "score": g["score"], "repeat": g["repeat"], "why": g["why"],
            "top": related[:5]}


# ── demo / CLI ───────────────────────────────────────────────────────────────────────────────────────
DEMO = [
    ("reel caption", "POV: romanticizing your 5am morning routine — matcha, journaling, cold plunge ❄️📓"),
    ("tweet",        "nvidia earnings beat again, AI capex is genuinely insane 📈"),
    ("shower thought", "maybe i should rewrite the whole substrate pipeline to be cleaner before we launch"),
]


def _show(label, send, claims_db, write, memory_path=CO_MEMORY):
    r = react(send, claims_db, write=write, memory_path=memory_path)
    icon = {LINE: "🎯 LINE", LIGHT: "👀 LIGHT", NONE: "· NONE"}[r["tier"]]
    print(f"\n── {label} ─────────────────────────────────────────────")
    print(f'   send:  "{send}"')
    print(f"   tier:  {icon}   (score {r['score']}, repeat {r['repeat']}, via {r['how']})")
    print(f"   why:   {r['why']}")
    if r["match"]:
        print(f"   hook:  [{r['match']['level']} {r['match']['confidence']:.0%} sim {r['match']['sim']:.2f}] {r['match']['statement'][:78]}")
    if r["tier"] == NONE:
        print("   Co →   (says nothing — restraint)")
    else:
        print(f"   Co →   {r['reaction']}")
    return r


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    claims_db = next((a for a in args if a.endswith(".db")), DEFAULT_DB)
    custom = [a for a in args if not a.endswith(".db")]
    # Demo runs use a SCRATCH memory (fresh each run) so they never touch the live per-tenant session
    # memory / callback budget. --keep reuses the scratch across runs (to see the repetition mechanic).
    demo_memory = str(HERE / "co_memory_demo.db")
    if "--keep" not in sys.argv and Path(demo_memory).exists():
        Path(demo_memory).unlink()

    auth = f"LLM phrasing ON ({PHRASE_MODEL})" if (os.getenv("CLAUDE_CODE_OAUTH_TOKEN") or os.getenv("ANTHROPIC_API_KEY")) \
        else "LLM phrasing OFF → deterministic constructor (no Anthropic key in env)"
    emb = "semantic recall ON (voyage)" if os.getenv("VOYAGE_API_KEY") else "keyword recall (no VOYAGE_API_KEY)"
    print(f"🫧 Co v1 core loop — local test. {emb}; {auth}.")
    print(f"   model-of-you: {claims_db}   ·   scratch session memory: {demo_memory}")

    if custom:
        _show("your send", " ".join(custom), claims_db, write=True, memory_path=demo_memory)
    else:
        for label, send in DEMO:
            _show(label, send, claims_db, write=True, memory_path=demo_memory)
    print("\n(reaction logged to the scratch memory — the 'remember' step + the repetition signal.)")


if __name__ == "__main__":
    main()
