# Co — Sprint 1

> **role of this repo (2026-07-24):** this is the LAB and the LIVE FOUNDER INSTANCE — the running
> iMessage rail, the organs it grew, and the founder's personal belief graph and thesis vault
> (untracked). the COMPANY CANON is `projects/co` (start at its README): clean-room, shareable,
> everything reachable from one place. same product, two roles: frame is where co is lived and
> proven on one person; co is where it becomes a company. integration between them happens only
> through the ingest contract (`projects/co/docs/ingest-contract.md`).

**Text one number anything you scroll past or think. It comes back tied to your life — the one true line, then silence.**

This is our Sprint 1 build. The short version of the bet: everyone's racing to make an assistant that *does more*. We built the opposite — a witness that mostly holds back, and earns the right to say the one thing you couldn't see yourself.

## The approach (why it's shaped like this)

Three commitments drive every design decision. They're the whole point — the code is just how we honored them.

**1. Witness, not assistant.** The product is *restraint*. Most sends get a glance (a tapback) or nothing; the rare payoff is a single line that actually nails you. An assistant that replies to everything is noise, and it's the crowded, commoditized lane. The scarce thing is being *seen* — so that's what we optimized, down to a hard `NONE / LIGHT / LINE` gate that would rather stay quiet than say something mid. Silence is a first-class output, not a failure.

**2. A model of you, not a chat log.** Every message relates back to a per-tenant belief graph: who you are, what you keep circling, the gap between what you say and what you do. Two tiers — literal claims extracted from what you share, and *inferred* higher-order ones (preoccupations, patterns over time, tensions). That inferred layer is the third-person read you can't give yourself. It's yours: correctable and editable.

**3. Anti-dependence.** It's on your side and it points you back at your life — makes you *more*, then gets out of the way. Retention comes from being worth it, never from hooking you. (This one isn't just taste — it's where the research says companion products live or die, and we built to that.)

## What we built this sprint

- **The engine** (`brain/`) — one conversational brain, per-tenant, voice and text on the same soul.
- **Per-tenant memory + inference** (`claims/`) — the belief graph, the two-tier inference pass, supersede + correction handling.
- **The eyes** (`claims/link_read.py`) — send a tweet, a YouTube video, a photo, a voice note; it actually reads / watches / hears it (native video understanding, vision + photo EXIF, audio transcription).
- **The house** (`viewer/`) — a calm web view of your own mind: what you've sent, what it noticed, the threads of your life. Editable.
- **Proactive, but restrained** (`claims/reconciler.py`) — a defer-and-hold reach-out engine, three lanes (hold you to what you *said*, surface something genuinely relevant, gently question a belief), that fires at most once a day and mostly stays silent.
- **An eval harness** (`claims/co_eval.py`) — the disposition is *testable*: restraint, honesty-when-it-doesn't-know, no canned lines, the count mechanic — all gated, so a model swap can't quietly break the voice.
- Live on iMessage (Sendblue) end to end.

## How it runs

```
you text the number
  → homebase/router/sendblue_router.py     (channel adapter; CO_MODE=co)
  → claims/link_read.py                            (reads any link / photo / video / voice note)
  → brain engine   or   claims/co_react.py      (relate to you → NONE / LIGHT / LINE → remember)
  → reply, or silence                              (silence is a common, valid output)
```

Everything is **per-tenant**: `claims/claims_<tenant>.db` is one person's belief graph. Fifty strangers share one process and never cross interiors.

## Try it (no live sends)

```bash
cd claims && python3 co_eval.py --all     # the disposition eval — restraint, honesty, no-canned-lines
./smoke.sh                                # simulate the whole loop locally; nothing sends
```

The live channel needs a Sendblue number + tunnel + a Gemini key for the eyes — happy to walk you through standing it up.

## The map

| Path | What |
|---|---|
| `claims/co_react.py` | the core loop: relate → gate → phrase → remember |
| `claims/infer.py` | two-tier memory: inferred higher-order claims + actionability tags |
| `claims/reconciler.py` | the proactive engine (defer-and-hold, three lanes, research-grounded) |
| `claims/link_read.py` | the eyes (video / photo / voice / link) |
| `claims/co_eval.py` | the disposition eval harness |
| `claims/` (rest) | claimstore, extract, embed, threads, session compaction, the ingest machinery |
| `brain/` | the conversational brain (TypeScript) |
| `viewer/` | the house — the web view of your mind |
| `homebase/router/` | the iMessage channel (Sendblue) |
| `voice/` | the call (LiveKit) — next up |

## Where it's honest / still open

Peer to peer, the real state:

- **Onboarding** still over-pushes "send me a screenshot" and leans on one guessing-game scaffold. Next pass makes it follow the user's mode and earn depth in rungs (a "trust ladder") instead of a turn-counter.
- **Proactive** is built but deliberately tuned conservative; real cadence should be set by real usage, not guessed.
- **The thing no eval settles:** does a stranger come back the next day, unprompted. That's what the testers are for — and it's the only question that actually matters.
