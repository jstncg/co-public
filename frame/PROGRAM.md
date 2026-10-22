# PROGRAM.md — build the witness v1, end to end

You are the engineer building Frame's v1. This file is your single source of truth. Read `_private/00_CORE/GOALS_MEMO.md` first for why; this file is what. Build the full thing a real person can use, ship it by June 22, and do not build anything outside the four frozen capabilities below.

The convention here is borrowed from autoresearch (`projects/research/ai-researcher/autoresearch/program.md`): one file, a clear goal, a tight loop, hard constraints, a single metric. The thesis is borrowed from PraxLab: the model barely matters, the scaffolding does all the work. You are not training a model. You are building the body around a model so that it knows one person and tells them the truth.

## What this is

A phone number. The user texts it, and in the evening it calls them. Ten minutes, the conversation is the journal entry, and every conversation makes the next one know them better. No app. No dashboard. No setup screen. It works on any phone.

The whole company is one bet: being understood beats being agreed with. Your job is to build the smallest real thing that lets fifty people feel that, and that lets us watch whether they keep picking up the phone.

## What already exists (do not rebuild)

- `diyagi/pi/donna/agent.ts` — the thought-partner agent. Knows the user (carried core self + per-turn recall), will not flatter, challenges, names what they avoid, asks the one sharper question. Tools: recall / remember / update_belief / web_search. Accumulates across sessions, never resets. This is the brain. JOURNAL_V1 verified it end to end.
- `homebase/router/sendblue_router.py` (the Donna-era bridge lived here until 8/5;
  it is now `Secretary-Production/donna-bridge/`, outside this repo) — the iMessage rail. Watches chat.db, routes to the witness endpoint, replies via BlueBubbles, burst-coalesces, dedupes, typing indicators. The texting hallway works.
- `claims/journal_ingest.py` — the flywheel. At session end the user's own turns are extracted into the belief graph, calibrated, embedded. Every conversation deepens the model. Idempotent.
- `claims/harvest.py` — the other half of session end. The flywheel makes the next conversation know them better; harvest makes THIS one start work: anchors, watches and commissions off the same transcript, then the scout. Idempotent on the same watermark convention.
- The engine — claim graph, why-tree, forensic extraction, salience, calibration. The depth under the surface.
- `_private/02_BUILD/LIVEKIT_ARCH.md` — the voice plan. Voice is an I/O swap: LiveKit STT/TTS/SIP replace stdin/stdout, the agent and flywheel do not change.

Your job is to take these from "a thing Dennis runs in a terminal" to "a thing fifty strangers use through a phone number." That is integration and the four capabilities below, not a rewrite.

## The four frozen capabilities (the only things that ship)

### 1. The call (push, not pull) — this is the unlock
The product initiates. In the evening it calls the user over a real phone number, has a ten-minute conversation through the existing agent, and the transcript feeds `journal_ingest`. This is LiveKit outbound voice (SIP) wrapping the agent, per LIVEKIT_ARCH. The when-to-call trigger for v1 is simple: a user-chosen evening window, one call a day, the user can text "not tonight" to skip. Calibrated proactivity is v2; do not build it now. A call the user starts dreading is the same death as a journal they stopped filling, so the call must be skippable and must end cleanly.

Acceptance: a stranger gives a phone number, picks an evening time, and at that time their phone rings, they talk for a few minutes, they hang up, and the model is deeper for tomorrow.

### 2. The honest disposition (the bet)
The agent already challenges. Harden it into the product's soul and make it consistent. It tells the truth, names the avoidance, says the specific hard thing kindly. It never flatters to retain. Honesty is now table stakes in this category (Rosebud, Tomo, Tolan all claim "not sycophantic"), so the differentiator is not the claim, it is the graded record (capability 3). But the disposition still has to be real and reliable. Disposition rules, enforce in the prompt and in eval: no praise without evidence; no trait claims without a behavior trace; reframe strong convictions into questions; every interaction ends pointed outward (a call to make, a person to see, a thing to do), never deeper into the app; mark unknown as unknown and ask rather than assert (the agent only sees calls, texts, mail; most of life is offline; one false "you dodged it" destroys more trust than ten true reads build).

Acceptance: across a week of real use, the agent produces specific true reads, never a flattering generality, never a confident wrong assertion about something it could not know.

### 3. The silent ledger (the moat) — build it now, no UI
Every explicit read or prediction the agent makes about the user gets logged with a timestamp: what it claimed, and the basis. Later, resolve each against observed behavior, never against the user's say-so (behavior-graded, not verdict-graded — this is the predict.py correction; resolution fires from what the user actually did, surfaced in conversation or mail, not from asking "was I right?"). This is the asset that makes month six worth more than month one. v1 has zero user-facing surface for it. It runs internally, it is how we grade the honest arm, and it is the thing no dead competitor built. Store it where journal_ingest writes.

Acceptance: after two weeks of one user, you can pull a list of N graded predictions with accuracy, and none were graded by asking the user.

### 4. The weekly unasked (the gift, the share loop)
Once a week, one message: the essay, the person, the path adjacent to the user's life that they did not know existed, chosen from the model of them crossed with a live web search. Un-searchable by definition — not more of what they like, the thing just past the edge of their frame. First payload to support: the career gasp (one real posted job or opportunity with a real equivalency, matched to a capability the user exhibits but does not value). The bar: it fails the applies-to-a-stranger test, and the delivery says why it is for them. This is the delight half and the shareable artifact (verdicts stay private; gifts get screenshotted).

Acceptance: a real user gets one genuinely surprising, genuinely-about-them thing per week that they could not have searched for, and wants to show someone.

## The architecture (how the four get built — not new scope)

One invariant core — the memory and the disposition, the soul. Three pluggable seams around it — the model, the I/O surface, the data environment. The seams are only safe because the invariant is *measured* across every swap (the gate, below). This formalizes the "engine is the soul, I/O is swappable" line we have held all along; it adds no capability.

### Model-agnostic (Gemini / OpenAI / Anthropic)
One provider interface — `complete(messages, tools, stream) → token stream + tool calls` — with three adapters, tool schemas and streaming normalized. The plumbing is settled (lift the prefix-dispatch pattern already proven in the sota `_llm.py`). The trap is behavior, not plumbing: the three families diverge most exactly where the soul lives — Gemini flatters, GPT pads, Claude challenges. So **agnostic at the interface, verified at the disposition**: the eval gate runs per model, and a model ships behind Frame only if it clears the honesty bar. The payoff is not vendor insurance — it is different models at different stages: cheapest-fastest in the voice hot path (TTFT is ~70% of the 800ms budget), best-reasoning in the async passes (why-tree, calibration, the weekly gift). Caveat: the resident-core latency move leans on prompt caching, which is per-provider in price and semantics. The interface abstracts it; pick per stage with eyes open, do not assume the three are equal in the hot path.

### The memory (the invariant — this is the moat)
Already strong, keep all of it: carried-core + retrieved split, behavior-graded confidence, salience ≠ confidence, why-tree, calibration. What makes it *very* good rather than good:
- **Relevance is graph structure, not cosine.** Retrieve through the why-tree edges (connected to this commitment / person / thread); rank with embeddings + recency. Never embeddings alone — they surface topically-similar memories, not relevant ones.
- **Consolidation, not append-only.** The nightly async pass merges duplicate beliefs, supersedes stale ones, compresses episodic → semantic. Append-only memory gets slower and dumber with use.
- **Contradictions are signal.** A new belief that contradicts an old one records a contradiction edge + temporal order — never a silent overwrite. That the person *changed* is among the most valuable things you know about them.
- **Provenance on every belief** — learned when, from which turn, graded how. This is what earns the gasp: "you told me in March you'd quit by June," with a receipt.
- **Operational:** the embedding-bearing memory must be resident where the agent actually runs. A slim copy with embeddings stripped silently degrades recall to keyword — "knows you" becomes "keyword-matches you." Verify recall fidelity in the deploy env, not only locally.

### Two surfaces (voice + text), one engine
The OpenAI-compatible endpoint (LIVEKIT_ARCH path #1) is the shared engine; each channel is a **thin adapter** owning only its modality — turn-detection for voice, burst-coalesce/dedupe for text — translating to and from the engine's message interface. The engine never knows which channel it is on. But the surfaces are not behaviorally identical: a voice turn is short, no markdown, ends cleanly; a text can be a longer thought carrying the gift's link. So the engine takes a thin **channel descriptor** that conditions output *shape* (length, structure, format) while the disposition and memory stay invariant. **Soul invariant, surface conditioned.** The same descriptor pattern carries the *data environment* — Dennis's full substrate vs a phone-only stranger — so memory and the ledger degrade gracefully when the substrate is thin, rather than asserting what they cannot know.

### The gate (what makes the seams safe)
Every seam is a chance for the soul to break silently — Gemini flatters, a voice turn truncates the hard truth into a throwaway, thin data makes it assert the unknowable. So before any seam is trusted: the disposition + memory-fidelity eval (already called for in capability 2) runs across the model × channel matrix as a red/green gate. Build the interface clean, then build the eval so you *know* the soul survives every swap. Pluggable-without-verified is just three new ways to break the one thing that is the company.

## The end-to-end user journey (build this whole path)

1. **Discovery:** a friend sends a phone number. No app store, no download.
2. **First contact:** user texts the number. The agent replies like a person, asks two or three real questions (what is most on your mind, who is in your corner, what are you building), and by the end says one specific true thing drawn from what they said. Small gasp. It offers the evening call and asks for a good time.
3. **Day two onward:** the call comes at the chosen time. The conversation is the journal. Mid-day, sparingly, a text when it matters ("how did the thing at 2 go").
4. **Week two:** the first unasked delivery.
5. **Always, invisibly:** every exchange deepens the model (flywheel) and logs/grades predictions (ledger).
6. **Onboarding identity:** the witness needs its own number/identity so it is not Dennis's self-chat. Use a dedicated number (Twilio/LiveKit SIP for voice, the SMS/iMessage rail for text). This is the thing that makes it usable by someone who is not Dennis.

## The build loop

```
LOOP until June 22:
  1. Pick the next thinnest slice of the end-to-end path that a real stranger could use.
  2. Build it against the existing agent + flywheel + bridge. Integrate, do not rewrite.
  3. Dogfood it on yourself, then on Dennis, then on one non-Dennis human.
  4. If it breaks the Poke bar (a wrong read, a slop message, a missed call), fix before adding.
  5. Commit. Keep a short build log of what shipped and what is still stubbed.
  6. Never add a capability outside the four. New ideas go to the freezer (see below).
```

## What you do NOT build (the freezer)

Everything not in the four capabilities. Specifically, not now: any app or dashboard (the number is the product; the app is a year-two read-only window), the ledger UI, calibrated/proactive when-to-call, group/family/couples, the network, hardware, payments/billing infrastructure beyond a stub, the membrane, agent-spawning. If it is tempting and it is not one of the four, write it in `_private/00_CORE/CO_WISHLIST.md` with an unlock condition and move on.

## The metric and the kill criterion

One number: do people keep picking up the call. Pickup rate should hold through week six. Secondary: by call three, most users get a specific checkable read (a gasp). The bet fails if, by mid-August, pickup decays like every other AI app. We say so plainly if it does. You are not running an A/B test; the market is the control group. Build for the honest arm and instrument pickup, gasp incidence, and ledger accuracy so we can read the truth.

## Provenance

- Convention: autoresearch `program.md` (one file, tight loop, single metric).
- Thesis: PraxLab (the scaffolding does the work; build the body, not the brain).
- Soul and constraints: `_private/00_CORE/GOALS_MEMO.md`, `ONE_PAGER.md`, `CO_WISHLIST.md`, `RESEARCH_PROBLEMS.md`.
- Already shipped: `_private/02_BUILD/JOURNAL_V1.md`.

Ship the small thing. Make sure the small thing is the call, the honesty, the graded ledger, and the weekly gift. That is the whole company hiding inside a phone number.
