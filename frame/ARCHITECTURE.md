# co — Architecture Map

The wiring as it actually is **today (2026-08-05)**, organized by the arc the product
owes the user: **SEEN → CLEAR → PREPARED → HAPPENING** (`docs/canon/the-arc.md`).
Each rung depends on the one before it, so the architecture reads best in that order —
and the gaps become obvious.

Product stance lives in `docs/canon/`; this file is the machine.

> **Rewritten 8/5.** The previous version was ~2 weeks stale and wrong in two ways that
> misdirect: it claimed `brain/*.ts` was a "committed mirror" running from `diyagi/pi`
> (it is not — the engine's cwd is `frame/brain`), and that `run.sh` execs the legacy
> `donna_router.py` (it execs `sendblue_router.py`). It also predated the Donna→co
> rename, the bridge removal, and half the live schedule.

---

## The three processes (everything else is an organ or a cron)

| Process | Port | What it is | Supervised by |
|---|---|---|---|
| **the rail** `homebase/router/sendblue_router.py` | 8099 | iMessage in/out, burst coalescing, the eyes, ALL web surfaces (`/w/<slug>`, `app.json`, search, capture, call), the VAPI voice proxy, the recovery sweep | `com.dennis.co-router` |
| **the brain** `brain/server.ts` | 8090 | OpenAI-compatible engine. Persona (`brain.ts`), carried memory (`memory.ts`), per-turn law assembly. Text + voice ride the same engine | launchd `com.dennis.co-brain` via `frame/brain/run.sh` |
| **the receiver** `apps/web` | 3010 | Next.js + Supabase dual-write target. Written to, never read from — a warm migration path, not the product | `com.dennis.co-receiver` |

State: `~/.co/` (journals, logs, thumbs, wrapped cache, work ledger) and
`frame/claims/claims*.db` (one belief graph per tenant) plus
`~/.co_<tenant>_sendblue_transcript.json` (the conversation, both roles).

---

## Rung 1 — SEEN (it knows me; I never had to explain)

**Strongest rung. The moat, because it is tenure-graded.**

- `journal.py` — every send captured (the Saga). Feeds the graph; `feed_transcript=False`
  keeps SYSTEM captures out of the conversation record.
- `link_read.py` — **the eyes**. YouTube (native watch + caption ladder), IG reels and
  carousels slide-by-slide, tweets with media/quotes/thread-walk/one-hop link follow
  (incl. t.co → X Articles), pages, PDFs, voice notes, images with EXIF. A read that
  carries no content SAYS so — the never-invent law lives in the data.
- `claimstore` / `extract_claims` / `infer` / `contradictions` / `salience` — typed,
  auditable beliefs, one SQLite graph per tenant. `salience.py` ranks what DEFINES a
  person (recomputed nightly in `ingest_sweep`).
- `brain/memory.ts` — the **carried core**: ~20 resident lines answering "who is this
  person" every turn. Excludes doc-derived and hedged claims; falls back to confidence
  when unscored (8/4: a scorer lag had made the core 17/20 lines of co's own spec).
- `co_react.py` — deterministic relate-and-restrain before the engine ever runs.
- Surfaces: the thread's reads · patterns with receipts (killable) · the world's **rooms**.

**Gap:** for a NEW tenant the graph is empty and extraction is nightly, so rung 1 does
not complete for days. See `docs/specs/onboarding-audit-2026-08-05.md`.

## Rung 2 — CLEAR (I can see my own situation)

- `wrapped.py` — generates BOTH the world page HTML and `app.json` from one source.
  Rooms (Inside-Out, not a graph), the wall, search, crowns, whispers.
- `ios/Kyo` — THE app (8/6: one app, Justin's; `apps/ios` is the retired prototype).
  Home / Archive / chat, plus **in your week** (`lived`). A **window onto the rail's
  state**, holding no logic of its own (my-world law).
- `_today()` (daily_prep, 05:40) — the read, THE ONE THING, setup, then.
- `threads.py` · `session_compact.py` — the rolling state that keeps continuity cheap.
- `find_engine.py` — recall over the whole corpus (reads everything, never top-k).

**Gap:** the thread still sometimes answers at the send's own altitude (a verdict),
which hands the work back. Measured by `giftrate.py` — currently 96%.

## Rung 3 — PREPARED (I have what I need; the hard part is small now)

**The weakest rung, and the wedge lives here.**

- `staff.py` — the groundwork organ: find the avoided thing (quotable or abstain),
  research it, deliver gift-shaped with the leap left theirs. **Staged-only, not
  cron-wired** — it has never sent.
- `research_engine.py` — commissioned research with a promised delivery day.
- `watch_engine.py` — standing watches (date / url / search), fire on material change.
- `wake.py` (08:30) — the morning read: yesterday's hottest thread × one web find.
- `unasked_delivery.py` (Fri) · `return_engine.py` · `anchors.py` · `episode_engine.py`.
- `harvest.py` — the SECOND door onto the three verbs above. Until 8/13 `anchors.extract`,
  `watch_engine.create` and `research_engine.commission` were reachable only from
  `sendblue_router.py`, so a voice call deepened the model (`journal_ingest`) but never
  started any work. Harvest hangs the same three off the call transcript at teardown, then
  runs the scout once so the implicit half gets picked up too. Creates rows, never speaks —
  the reply path still belongs to the router.
- All of it behind one **shared callback budget** (≤1 proactive resurface/day) plus
  quiet hours, the skip flag, the read-receipt gate, and the **reply-debt gate**
  (nothing proactive jumps an unanswered message).

**Gap:** groundwork is not reliably delivered — the organ abstains more than it acts,
and nothing schedules it.

## Rung 4 — HAPPENING (my life is actually moving)

**Nascent.**

- `work.py` — the staff ledger. Six verbs (watched/read/checked/found/researched/
  drafted), instrumented at five completion points, surfaced as `app_state.staff` and
  the world page's "while you were living".
- `ledger.py` / `predict.py` — what co CLAIMED about you, resolved against behavior.
- `markDone` on the one thing · `outcome probes` in episodes.

**Gap:** **first-times-per-month — the metric the line is falsified against — is
measured nowhere.** The ledger counts co's work, not the user's outcomes.

---

## The proactive spine (how anything reaches them)

Four entrypoints, one budget — and **THREE schedulers**, which is the real hazard here.
Corrected 8/6: the doc said `reconciler.py` was "not cron-wired". It has a `*/5` crontab
entry and has been running. Believing otherwise is how a live send path goes unexamined.

| scheduler | what it drives | where it logs |
|---|---|---|
| **crontab** | `proactive_tick.py` (`*/15 8-22`), `reconciler.py` (`*/5`) | `~/.co/*.log` |
| **launchd** `com.dennis.co-conductor` | `conductor.py`, every 3h (`StartInterval 10800`) | `/tmp/donna-conductor.log` |
| **launchd** `com.dennis.co-daily-text` | `daily_text.py` (`*/15 17-21`) | its own plist paths |

Until 8/6 the crontab redirected to `~/.donna/` — the pre-rename directory — so the
proactive spine looked 35 hours dead in `~/.co/` while running normally. Check BOTH paths
before concluding an organ is dead.

| Module | Wired | Schedule |
|---|---|---|
| `proactive_tick.py` | LIVE | */15 8-22 |
| `daily_text.py` | LIVE | */15 17-21 (`com.dennis.co-daily-text`) |
| `unasked_delivery.py` | LIVE | Fri 18:00 |
| `reconciler.py` | **LIVE** (crontab) | `*/5` |

## The nightly schedule (`frame/reconciler.json`)

```
03:10 backup        (encrypted; includes docs/ and .agents/ — both gitignored)
03:30 ingest_sweep  (per tenant: journal_ingest → ledger → salience)
04:15 weave         · 04:45 scout        · 05:10 thumbs
05:20 canon_ingest  · 05:40 daily_prep   · 08:30 wake
```
All tenant-looping organs use `daily_text.active_tenants()` — deliverable number AND
recent activity.

## The gate

`frame/evals/run_eval.sh` in the production interpreter. **38 checks, expect 0 fail.**
Every rail change runs it. `brain/eval.ts` guards the engine seam.
`giftrate.py` measures whether replies cost the user their next message.

---

## Flags (read before touching)

1. **`reconciler.py` IS wired (`*/5` crontab) — the old flag here said it was not.** Collapsing the three
   live cron paths onto it changes send behavior — deliberate, still pending.
2. **The viewer (`viewer/serve.py`, :8811) is DEAD** — no launchd job, no reconciler
   entry, port closed. Removal candidate.
3. **`homebase/router/donna_router.py`** is the legacy BlueBubbles rail. Nothing execs
   it (`run.sh` execs `sendblue_router.py`). Removal candidate.
4. **`reach_out.py`** has no importer since the bridge left (8/5). Clean delete.
5. **Supabase/trigger/packages** implement the account-based architecture the product
   rejected (phone number IS the identity). Dual-write is warm; nothing reads it.
6. **Single host.** Every tenant lives on one Mac. This is the scaling ceiling.
7. **TLS key was in git history** until 8/5 — rotate the Tailscale cert.
