# MORNING.md — Co v1, from coffee to live in ~15 minutes

Branch: `co-v1-overnight` (not pushed). Everything below was built + smoke-tested overnight 7/1→7/2.
No real message was sent. The loop is: text the Sendblue number → guessing-game onboarding (new person)
→ restrained reactions with the Co disposition (known person) → one proactive text/evening max.

## 0. Two-minute sanity (before anything live)

```bash
cd /Users/main/Projects/Secretary/Secretary-Production/projects/co/frame
./smoke.sh            # starts the engine if needed, runs the disposition eval, simulates the whole loop
```

Everything prints locally; nothing sends. If the eval gate is RED, stop and read the violations.

## 1. Start the engine (the ONE brain, :8090)

```bash
cd /Users/main/Projects/Secretary/Secretary-Production/projects/diyagi/pi
set -a; source /Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/.env; set +a
WITNESS_PORT=8090 node donna/server.ts >> ~/.co/engine.log 2>&1 &
curl -s localhost:8090/v1/models    # → {"object":"list",...}
```

(frame/brain is now ALSO self-contained — `cd frame/brain && npm install && node server.ts` works
standalone, verified overnight. Both copies are synced; diyagi/pi stays the default run-home.)

(If Anthropic 429s appear in engine.log — the sonnet window was capped overnight once — run with
`CO_MODEL=claude-haiku-4-5` prepended; the eval was green on both.)

## 2. Start the router (:8099)

```bash
cd /Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/homebase/router
set -a; source ../../.env; set +a
export CO_TEST_HANDLES="+1<founder-number>"      # YOUR number first; add testers comma-separated
export SENDBLUE_FROM_NUMBER="+1XXXXXXXXXX"    # ← the number from the Sendblue dashboard (not in .env yet!)
/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/.venv/bin/python3 sendblue_router.py
# (that venv has all deps: anthropic, google-genai, numpy, requests. plain python3 misses some.)
```

Notes: creds are read from .env (`SENDBLUE_API_KEY`/`SENDBLUE_SECRET_KEY` work as-is). Modes:
`CO_MODE=co` (default, the product) | `journal` | `engine` | `echo` (pipe test).

## 3. Tunnel + webhook registration

```bash
cloudflared tunnel --url http://localhost:8099
# copy the printed https://<random>.trycloudflare.com URL
```

Sendblue dashboard → API settings → **Webhook / receiving URL** → paste the tunnel URL (POST target).
If the dashboard has separate "message received" callbacks, use the same URL. Then send a test:
text the Sendblue number **"echo test"** with `CO_MODE=echo` once if you want a pure pipe check,
or just go straight to co mode.

## 4. First real text (the moment)

From your phone, text the number: `hey`
- You should get the guessing-game opener within ~5-10s.
- 2-4 exchanges → ONE honest read → "send me anything" close.
- Then send it a tweet link / reel / screenshot: instant 👀, and (rarely) the line as a follow-up.
- `not tonight` mutes tonight's proactive text + call.

Timing lands in `~/.co/homebase/router/timing.jsonl` (time-to-first-wow per tenant).

## 5. The daily proactive text (stage first, then cron)

```bash
cd /Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/claims
set -a; source ../.env; set +a
python3 daily_text.py                          # stage-only: prints what WOULD be sent per tenant
python3 daily_text.py --tenant p1714XXXXXXX --force   # force-stage one tenant to inspect quality
python3 daily_text.py --send                   # real sends (allowlist-gated by CO_TEST_HANDLES)
```

Cron (evenings, every 15 min — it self-gates to one text/tenant/day inside the 6-9pm window):
```
*/15 17-21 * * *  cd /Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/claims && set -a && . ../.env && set +a && CO_TEST_HANDLES="+1714...,+1..." /Users/main/Projects/Secretary/Secretary-Production/projects/substrate/.venv/bin/python3 daily_text.py --send >> ~/.co/daily_text.log 2>&1
```
Per-tenant window/tz: drop `claims_<tenant>.db.textcfg.json` → `{"window_start":"19:00","window_end":"21:30","tz":"America/New_York"}`.

## 6. Two-tier memory (inference) + the proactive reconciler

Two additions on the same raw stack (in-process, no framework), grounded in `_private/00_CORE/RESEARCH_proactive_witness.md`.

**Memory inference (`claims/infer.py`)** — periodically derives HIGHER-ORDER claims across a tenant's
atomics + send stream: preoccupations, temporal patterns (from send timestamps), tensions (value vs
behavior), trajectory (supersede chains), candidate insecurities (low-conf, careful), and the NON-OBVIOUS
hunt (correlations + negative space — what they conspicuously don't send). Each is stored `inferred=1` with
its supporting atomic-claim ids as evidence, and is correctable via the same `user_corrections` path as any
claim. It also TAGS every actionable claim with the `kind` the reconciler consumes.
```bash
python3 infer.py                 # derive + tag for the founder tenant, print what it found
python3 infer.py --dry           # derive + print, write nothing
python3 infer.py --tenant X --tag-only   # just (re)tag actionability
```
Cadence: nightly (planning happens at night). `0 3 * * *  … python3 infer.py`.

**The proactive reconciler (`claims/reconciler.py`)** — a defer-and-hold reconciler (durable desired-state +
fired-ledger, idempotent, at-most-once, err toward silence). Three research-grounded lanes: ACCOUNTABILITY
(open loops → an informational mirror flagged ONCE at the wire, never policing), EXPOSURE (interests →
fetch-first grounded via the shared `rec_grounding.py` gate — real title+author+resolving url or silence),
BUBBLE-POP (convictions → SOCRATIC elicitation; consequentialist challenged, SACRED witnessed never
contested). Scores relevance×novelty×timing×worth, holds until a SEAM (evening lull / weekend AM, never
mid-drive or mid-thread), fires ≤1/day per tenant against the shared callback budget. Usually nothing fires;
zero is correct.
```bash
python3 reconciler.py                              # every tenant, stage-only (mostly silence/held)
python3 reconciler.py --tenant dennis --explain    # one tenant, every lane's live/held/why
python3 reconciler.py --tenant dennis --seam --lane bubblepop   # demo one lane firing (still no send)
python3 reconciler.py --send                       # real sends (CO_TEST_HANDLES-gated)
```
Cron: the proactive-tick cadence (shares the ≤1/day budget with daily_text + proactive_tick):
`*/15 9-21 * * *  … python3 reconciler.py --send`. New eval half: `python3 co_eval.py --proactive`.

## What shipped overnight (map)

| Piece | Where |
|---|---|
| Co disposition (the 4 properties, restraint, bans) | `brain/brain.ts` → `CO_SYSTEM` |
| Guessing-game onboarding | `brain/firstcontact.ts` → `FIRST_CONTACT` |
| Channel/onboarding switch + time + open-threads injection | `brain/server.ts` |
| Restrained reaction engine (anti-overfit, callback budget) | `claims/co_react.py` |
| Banned-patterns gate (shared prompt↔eval) | `claims/disposition.py` |
| The eyes: IG (Apify, verified live), YouTube (native Gemini), X (fxtwitter), screenshots (Gemini vision) | `claims/link_read.py` |
| Open-threads rolling state (topics + commitments, 7-day decay) | `claims/threads.py` |
| Daily proactive text v0 | `claims/daily_text.py` |
| Router: two-phase always-pays, media, skip phrases, timing log | `homebase/router/sendblue_router.py` |
| Eval (phraser 4 + engine traps 8 + onboarding 3) — 15/15 GREEN, final run 7/2 ~00:40 | `claims/co_eval.py` |
| Local no-sends simulation | `homebase/router/smoke_driver.py`, `./smoke.sh` |
| The memory page (parallel overnight build, reads the same per-tenant state) | `viewer/` → `viewer/MORNING_VIEWER.md` |

Both TS copies are synced (`frame/brain/` ↔ `diyagi/pi/donna/`); the engine RUNS from diyagi/pi
(node deps live there).

## Known gaps (honest list)

1. **SENDBLUE_FROM_NUMBER is not in .env** — get it from the Sendblue dashboard (sends may work without
   it on a one-number account; the router tolerates its absence).
2. **Exa is out of credits** (`NO_MORE_CREDITS`) — the engine's `web_search` tool and `unasked.py`
   degrade gracefully but are effectively off. Top up at dashboard.exa.ai if wanted.
3. **Anthropic OAuth sonnet window got capped once overnight** (bare 429s ~10:45pm) — everything has a
   haiku fallback and the engine can pin `CO_MODEL=claude-haiku-4-5`. Eval was green regardless.
4. **Gemini flash-lite 503s in bursts** (high demand) — retries + gemini-2.5-flash fallback are in;
   threads-update falls back to a deterministic counter when Gemini is down.
5. **IG ingestion latency** — Apify run-sync takes 15-90s; the router acks instantly (👀) and the line
   follows. TikTok-without-caption (download+Gemini) is similar. This is by design (two-phase).
6. **The .env VOYAGE_API_KEY was stale/invalid — replaced overnight with the working key from Doppler**
   (local .env only, gitignored, nothing committed).
7. **journal_ingest/ledger offline sweep isn't cron'd for new tenants yet** — real-time `remember` works
   (verified: claims persisted during onboarding + co mode), so the graph deepens live. The offline
   extractors can be cron'd later: `CO_CLAIMS_DB=claims/claims_<t>.db python3 claims/journal_ingest.py`.
8. **Voice/EOD call is v1.5** — untouched tonight (scheduler + worker exist from slice 4, creds-gated).
9. `claims_smoketest_*.db` / `claims_p15559990077.db` are throwaway eval/smoke tenants — safe to delete
   (they regenerate on every eval/smoke run; all gitignored).
10. **Latency under token contention**: overnight, with evals + the build session sharing the OAuth token,
   engine replies occasionally took 60-90s (resample gate + provider retries). Normal path is 5-20s. If
   morning replies drag, check `~/.co/engine.log` for 429s; `CO_MODEL=claude-haiku-4-5` is the relief valve.
11. The engine resamples once (and surgically rewrites, haiku) when a reply leaks a banned pattern
   (reframing tic, signpost phrase, degenerate first-contact fragment) — you'll see `resampling once` lines
   in engine.log. That's the gate working, not an error.

## Model swapping (any provider, per role)

```bash
CO_BRAIN_MODEL=google/gemini-2.5-flash        # the conversation (anthropic/…, openai/…, google/…, openrouter/<any-id>)
CO_PHRASE_MODEL=anthropic/claude-sonnet-4-6   # co_react's line + daily/unasked composers
CO_EYES_MODEL=google/gemini-2.5-flash-lite    # ingestion/vision/compaction (google-only in practice)
CO_MODEL_FALLBACKS=anthropic/claude-haiku-4-5 # the step-down chain (comma-separated)
```

OpenRouter = the universal escape hatch: set `OPENROUTER_API_KEY` and `openrouter/<any-model-id>` just
works (engine + python side). THE GATE — a swap is only trusted after the eval passes on it:

```bash
# boot the engine with the candidate brain, then:
cd claims && python3 co_eval.py        # 7/2 reference: google 15/17 ≈ anthropic 15/17 (parity)
```

The disposition is enforced mechanically (resample gates, de-tic, stance-first, budgets), so swaps are
safe to TRY; the eval proves the voice survived. Defaults unchanged = zero behavior change.

## If a reply ever reads off-brand

Run `cd claims && python3 co_eval.py` and read which trap went red. The disposition lives in ONE place
per surface: `CO_SYSTEM` (conversation), `PHRASE_SYS` in co_react.py (the line), `COMPOSE_SYS` in
daily_text.py (the proactive text). The banned list they're all graded against: `claims/disposition.py`.

## Viewer — the memory page (read it AND correct it)

```bash
./viewer/run.sh --print     # prints every tenant's token URL (localhost / LAN / tailscale)
./viewer/run.sh             # start it if it's not already up (port 8811, it was left running)
```

Open your tenant URL on the phone (tailscale or home wifi). Three sections: the feed (what you
sent, Co's reactions inline), what co knows (the claims, grouped and human), threads.

**Editable memory** (added overnight, second pass): every claim in "what co knows" has two quiet
actions. "not right" strikes it and marks it noted; "edit" opens an inline box, your text shows
as pending. Tap undo to take it back. This is the viewer's ONLY write, everything else stays
read-only.

**Contract for the engine** (already agreed): corrections land in `user_corrections` in the SAME
per-tenant claims db — `(id, claim_id, action 'wrong'|'edit', text, created_at, processed=0)`.
Process a row (disconfirm / rewrite the claim), then set `processed=1`; the viewer's overlay only
shows `processed=0` rows. Endpoint, guarded by the per-tenant token:

```
POST /v/<token>/correct   {"claim_id": 7, "action": "wrong"|"edit"|"undo", "text": "..."}
```

Details + known gaps: `viewer/MORNING_VIEWER.md`.
