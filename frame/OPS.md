# frame ops — the moving parts (source of truth for what runs outside git)

*Created 2026-07-29 during the harness cleanup (P0.4: config made visible). The crontab and
supervision map were invisible state; this file is their record. Update it when they change.*

## The proactivity law (why two crons died today)

Every unprompted send must be one of:
1. **requested** — a watch or reminder the user asked for (bypasses budget; a kept promise)
2. **world-triggered** — an exposure/deadline/watch fire (bypasses budget; an alert)
3. **an offer that passed a high bar** — second opinion / scout / reflection (spends the one-a-day
   organic budget; abstain honored; quiet hours sovereign)

"It's 6pm and I haven't texted today" is none of these. `daily_text.py --send` (a 5–9pm quota that
manufactured questions, twice re-asking the same one) and `unasked_delivery.py --send` (Friday
quota) were removed from cron 2026-07-29 after the founder flagged a useless send. The modules
remain as libraries (the tick imports their send helpers). The evidence and the law: user-research-001
("never resurface on a schedule") + the class law in watch_engine/proactive_tick.

## Supervision map (current, warts and all)

| service | port | mechanism |
|---|---|---|
| sendblue router | :8099 | launchd `com.dennis.router` |
| **public ingress** | — | **tailscale funnel → `https://homebase.tail1f60f6.ts.net`** (STABLE hostname, persisted in tailscaled serve config, survives reboot). cloudflared RETIRED 7/29 after a real inbound confirmed the funnel path. Webhook path is `/hook/$WEBHOOK_TOKEN`. |
| witness engine (brain) | :8090 | launchd `com.dennis.co-brain`; needs Secretary-Production/.env |
| co-ingest receiver | :3010 | cron watchdog `co-ingest-watchdog` (1min); worktree moved to projects/co-ingest 2026-07-29 |
| voice endpoint | :8088 | doppler-run process (since June) |
| local supabase | :54321 | OrbStack containers |

## Cron (after 2026-07-29 cleanup)

- `*/15 8-22 * * *` proactive_tick.py --send — the rungs: anchors → watches → second opinion → return → reflection
- `30 3 * * *` predict + flywheel (journal_ingest) + ledger, for claims.db and per-tenant DBs
- `15 4 * * *` weave.py — the living documents
- `45 4 * * *` watch_engine.py --scout — expire → scout → exposure scout
- `* * * * *` co-ingest watchdog
- `* * * * *` engine watchdog
- `* * * * *` ingress watchdog (re-arms the funnel serve config if it stops answering)
- `10 3 * * *` encrypted data backup -> ~/Backups/donna + iCloud Drive (14-day retention; restore-tested)

## Health

`./doctor.sh` — the whole rail on one screen (curl probes with real budgets, never lsof). Run it before believing anything is down.

## Env sources (P0.4 debt: three of them)

- `Secretary-Production/.env` — the engine's keys (ANTHROPIC, GEMINI/GOOGLE, EXA)
- `frame/.env` — router/tick/dual-write (SENDBLUE, DONNA_*, CO_INGEST, APIFY, X_API_BEARER)
- `projects/co-ingest/apps/web/.env.local` — receiver (supabase, ingest token, pepper)

## 2026-07-29 — THE MONOREPO
frame lives at `projects/co/frame/` now — subtree-merged into DennwsLee/co with full
history. `projects/frame` is a SYMLINK there (old checkout archived at
`projects/frame.pre-monorepo`, delete after a week's soak). Everything that pointed at
the old path was flipped the same hour: 4 launchd plists, 7 crontab lines, 17 tracked
files with hardcoded paths. run.sh no longer starts a second engine from diyagi/pi —
that fork shipped a stale brain once; `brain/run.sh` is the ONE engine source and launchd owns its lifecycle.
Doctor green from the new path 15:57.

## 2026-07-29 — THE ENGINE (consolidation, phase 1)
`engine/co_engine` is now THE engine: new code imports organs through it (the seam), and
organs migrate in file-by-file. Native already: `ontology` (kyo's layer on frame's
claims.db — tensions, valid time, forget cascade; live dbs migrated additively, 14/14
tests) and `reconciler` (one spine: the 4 nightly cron lines are GONE, replaced by
`frame/reconciler.json` + one */5 cron running `reconciler.py --run`; ledger at
~/.co/reconciler_ledger.jsonl). Tick still cron'd — it migrates next. Watch tomorrow:
backup 03:10, ingest 03:30, weave 04:15, scout 04:45 must appear in the reconciler ledger.

## 2026-07-30 — THE DEAD GATE (the biggest silent failure to date)
The router venv NEVER contained the anthropic SDK — not in the old checkout either. Every
in-router Anthropic call failed silently since the recall wiring landed: the recall gate
logged 63x "recall:none" and ZERO real verdicts (THE FINDING, live episodes, commissions,
transcript-answers — none ever fired for a real text), llm's phrase chain fell to
"constructor", and _phrase shipped two raw transcripts into the founder's thread (the tell
that finally surfaced it). Nightly organs were never affected — crons run the substrate
venv, which has the SDK; that's why watches/scout/weave worked while the conversation
layer was dead. Fixed 7/30: anthropic installed + pinned in requirements.txt; verified
with a real call from inside the router venv. ALSO EXPLAINS: the returns table's zero
rows (system-review #4) — the reward stream was empty because the gate could not run.
LESSON: a probe that exercises the real dependency chain from inside the real venv
belongs in doctor.sh — "the module imports on my machine" proves nothing about launchd's.

## 2026-07-31 — OPEN MODE
Founder decision: the number IS the door — anyone can text it and gets the full product from
message one. The allowlist inverted to a blocklist (~/.co/blocklist.json, checked on both
inbound and proactive rails); a 150-msg/day flood cap per sender guards runaway cost; the IG
door binds only numbers that already have a conversation (SMS-code abuse vector stays closed).
CO_CLOSED=1 restores invite-only if a moment ever needs the gate back. The invite rail
(text command + tokened URL) still exists — it just isn't required anymore. Eval: 37/0/0.

## 2026-07-31 — THE BLANK-SLATE LAW + the number cutover
Founder ruling: real users start from nothing, so the founder tenant must too — no leaning
on ingested history the product can't give anyone else. 9,572 pre-co claims (substrate-era,
first_seen < 2026-07-01) quarantined: status='retired', graded='pre_co' (reversible:
`UPDATE claims SET status='active' WHERE graded='pre_co'`). 79 co-native claims remain —
the graph co actually earned. The Hailey incident (stale 14-year-old priority-contact claim
answering "Hello") is the class this kills. NEVER re-ingest external history into the
product graph.

Number cutover complete: outbound rides Justin's kyo Sendblue account from +1XXXXXXXXXX
(his plan is inbound_only — replies work because everyone texts first in open mode; full
upgrade pending). Old account webhook still live — delete it in the old dashboard to kill
the old thread. READ RECEIPTS: confirmed impossible on Sendblue (docs + endpoint probes:
DELIVERED is terminal, no mark-as-read API). The tapback is the read receipt, both
directions. The only real path to true "Read" is the BlueBubbles transport (drives
Messages.app directly, has a read API) — an architecture decision, not a patch.

## 2026-08-01 — THE CONVERSATIONS BECAME MEMORY
co's graph held 79 claims while months of strategic conversation sat in docs/*.md and the
working vault, invisible to the product — so the daily prep was reasoning from thumbnails.
canon_ingest.py now extracts DURABLE decisions/theses/constraints/findings from the canon
(32 docs) and the vault (goals, insights, patterns, corrections, people, facts) into the
graph with provenance (source='chat', evidence carries the doc), plus a digest into the
journal so recall and the orbit see them. 448 active claims now. Runs nightly at 05:20,
before the 05:40 daily prep, and only re-reads files whose mtime/size changed.
NOT a blank-slate violation: that law bans history a user could never give co (scraped
message archives). These are conversations about his own work — the pathway any user has.
