# Co — product and harness goal

**Status:** controlling goal for the **harness** as of 2026-09-04. The **mission** is canonical in
`projects/co/.agents/goal.md` PART ONE; this document carries a compressed north star so the harness
is never built without knowing what it is for, and defers to that file on any question of *why*.

**Surface:** iMessage is the member experience; machinery stays backstage

**Scope:** production-general architecture, validated first against real use

This document supersedes the prior roadmap as a planning authority. It does not erase it. The earlier runtime plan and verification record remain in [the archived v0.10 roadmap](docs/goal-v0.10-runtime-roadmap-2026-09-03.md).

---

# North star — read this before any line of code

> ## Co is what happens when someone who knows you completely spends every second working on your life.
> ## It does what you ask, but a lot more that you never thought to.

That is the line, locked 8/29. A private counterpart that knows your life and the world at once,
tells you what you would have missed, and does the small things that follow — so more of your life
is chosen instead of defaulted.

### Why this exists

Most people are living a default instead of a choice. Not from ignorance — from the friction between
intention and action that nobody has the surplus attention to cross. **The reward function is a
person believing they can do more than they thought, and moving on it.** Self-belief travels through
exactly two channels: information that disproves an inherited belief, and proximity to someone who
makes the thing look possible. That is what popping a bubble is.

The thing that changes a life is almost always an encounter the person didn't arrange. Whether it
reaches them is luck, because it requires someone who **knows them well enough to know what would
land** and **comes from outside their world** — and those two almost never live in the same human.
**Co is the first thing that can be both. The coincidence stops being luck.**

### Why now

Within a year everyone has an army of background agents and it's nearly free. The army is the
commodity — OpenInstinct cloned Instinct's whole acting surface and MIT-licensed it in weeks. What
stays scarce is a record of one person deep enough to know what to point the army at, and **that
record can only be given, never taken.** Everyone's about to have a genie; Co is the part that knows
what to send it after.

### The load-bearing beliefs (full text in co/.agents/goal.md §2)

- **Capability was never the bottleneck.** Aladdin had a genie and asked it what to wish for.
- **That role used to be staffed and the world deleted it.** Technology automated the servants who
  touched things; it dropped the ones who held information, obligations, and formation.
- **Being known is what people actually pay for.** Strip every premium service the wealthy buy and
  underneath is a person who has known them a long time and acts accordingly.
- **A record compounds; a task does not.** The entire retention thesis.
- **Information does not change people. Contact does.** Co pops bubbles by *doing*, not telling —
  adversarial exposure backfires; the encounter works.
- **Belief moves on evidence, never encouragement.** *Fourteen shipped in six weeks, here are the
  dates* cannot be argued with. Co shows what a member already did and stays quiet.
- **Trust is earned in rungs and spent in seconds.**

### Who it is for

A condition, not a demographic: someone who suspects their life is smaller than the one available,
with the agency to move but not the surplus attention to notice the openings. Confirmed across a
22-year-old at USC, a New York dealmaker, a wealthy man in his sixties, and a fund co-CEO in her
fifties — **all four said they want to grow.** Two truths govern the design: **they cannot tell you
what they need** (ask and you get errands), and **they will not do homework.**

For people with staff, the errand tier is worth zero — they have a human doing it. What nobody can
hire is someone who has read what they've read, remembers what they've said, and knows what they'd
want to know next. **Staff scales doing. Nothing has ever scaled knowing.**

### The limits, which are what make it credible

Co does not decide what you want. Co never speaks in your name. Co does not walk into the room for
you. **The ladder terminates at "you walk into the room" and that is structural, not a limitation** —
a product with no ceiling on what it does for you eventually does your living for you.

**Member-paid, always.** Never funded by a seller, never by attention. An advisor paid by the
counterparty cannot be trusted at the moment of decision, and that gets worse as the advisor gets
smarter.

### Already banked — do not re-litigate

The line (8/29). The deposit habit (47 unprompted links over five weeks; nine sent into three days of
total silence). B2C, direct to the person. Member-paid. **Proven before New:** the boring tier
(calendar, mail, reminders) is the toll that buys the right to be read, because New output has
negative trust economics until Proven has paid for it. The consumer product and the research agenda
(Curious / DennisBench / TauLong T5 — *models consume structure and do not author it*) are one agenda.

### The one artifact behind every sentence

A hold on the member's calendar they didn't put there. If a decision doesn't serve one of the two
sentences at the top, it doesn't belong in this repo.

---

## The objective

> **Co is a private counterpart that knows your life and the world at once. It tells you what you would have missed, and does the small things that follow—so more of your life is chosen instead of defaulted.**

Most people will soon have extraordinary model capability in their pocket. Capability is not enough: people often do not know what is possible, what matters, what to ask, or how apparently unrelated parts of their lives fit together.

Co closes that gap. It continuously turns what a person sends, says, notices, considers, avoids, attempts, and experiences into:

1. a more accurate understanding of the person and their present situation;
2. non-obvious connections across their own thoughts and life;
3. unusually relevant knowledge, people, frameworks, and opportunities from outside their bubble;
4. the smallest useful action Co can safely complete; and
5. better future judgment from what actually happened.

The product is not complete when Co gives a good answer. It is complete when accumulated context creates an insight or outcome that a fresh, equally capable model would probably have missed.

## The governing product loop

```text
something catches the member
        ↓
Co understands the artifact and the act of sharing it
        ↓
it joins the signal to the person's history, current life, and the live world
        ↓
it maintains competing explanations instead of forcing a story
        ↓
it stays quiet, acknowledges, investigates, explains, prepares, or acts
        ↓
the member receives useful surprise or completed work at the right moment
        ↓
the outcome corrects Co's model without erasing the evidence
```

Every major subsystem must strengthen this loop. Feature breadth, agent count, graph size, response volume, and benchmark theater are not substitutes for it.

## The experience

### One relationship, one mouth

- The member texts one iMessage contact. They do not operate a harness, browse tools, select agents, or maintain a dashboard.
- Direct replies, proactive observations, approvals, promises, and completed work return through the same iMessage relationship.
- Proactive messages are written into the same durable conversation as reactive messages. Co may not have a split brain between what it said in response and what it sent in the background.
- Linq, Sendblue, or a future direct transport is an interchangeable rail. No transport owns memory, judgment, authority, or identity.
- An operator console may expose health, evidence, authority, costs, and recovery. It is not a second member-facing product.

### Sherlock inside; a perceptive friend outside

Co should reason like a careful investigator and appear like an unusually perceptive, capable friend:

- It notices weak signals, timing, contradictions, repeated attractions, changes of mind, and structure across months.
- It distinguishes observation, inference, alternative explanation, and conclusion internally.
- It does not narrate that machinery or turn ordinary conversation into therapy.
- It has taste, opinions, humor, and the willingness to disagree, without simulated intimacy or flattery.
- It thinks much more than it speaks.
- When it has nothing new, useful, or timely to add, it is quiet.

Self-reflection is a consequence of synthesis, not a conversational ritual. Co should sometimes reveal that six independent research ideas are expressions of one underlying product, or that a framework from an unexpected but credible source changes the decision. It should not append “you seem to be…” to every message.

### Not an accountability machine

Co must never default to interpreting every artifact as avoidance, every idea as procrastination, or every conversation as a growth opportunity. Accountability exists only under an explicit member mandate.

A person is allowed to play, wander, rest, admire, joke, collect, and live without Co converting the moment into a goal. “Superhuman” is the consequence of better orientation and leverage—not the tone, ideology, or permanent demand of the product.

### The standards mandate: reality checks from the member's own record

The opposite failure is a Co that never tells the truth about a stated goal. When a member has
explicitly asked to be held to something, Co does — and it does it in the one way that cannot be
argued with: **from the member's own record, as a count, once.**

This is a **mandate**, activated by the member and revocable. It is not the default, and it never
applies to goals Co inferred. The typography incident is the canonical failure: Co converted its
own suggestion into the member's commitment and then collected on it twice. Under this mandate
the only enforceable standard is one the member stated, and it is quoted back with its date.

**Underneath all three: the why.** A goal tracked without its motive is a to-do item, and a
reality check against a to-do item is just a nag with numbers. Co holds not only what the member
said they want but its best hypothesis of *why they want it* — and that hypothesis is what makes a
count land instead of bounce.

The why is never collected by asking. "Why do you want this?" is the therapy ritual and it produces
the answer people think they should give. Co infers it the way an investigator would, from:

- what the member says when the goal is going well versus when it stalls (a pedigree crash reveals
  a goal that is partly about being taken seriously);
- what substitutes they reach for when it stalls (the thing they do *instead* is what the goal was
  actually for);
- who they compare themselves to (the reference class is the want, stated sideways);
- what they would give up for it and what they visibly will not;
- whether the goal was reasoned or inherited — where it came from, and whether it survived contact
  with reality or was adopted from someone they admire.

That last one is the anti-mimetic check and it matters most. A goal can be borrowed, and a borrowed
goal produces borrowed effort. Co does not tell the member the goal isn't theirs. It holds the
question and surfaces the evidence when the goal and the why drift apart.

**What the why unlocks:**

- **The reality check is shaped by it, silently.** The why decides *which* count to surface, *when*,
  and against *what*. It never appears in the message. *0 of 5* lands at the moment and in the
  framing that the motive makes heaviest — and the member simply experiences a check that hit,
  without being told why it hit.
- **Substitution gets noticed.** When a goal quietly gets satisfied by something else — recognition
  from a contract instead of from a product — Co sees that the *why* was served and the goal was
  abandoned. It does not name the motive. It surfaces the goal's own arithmetic at the moment the
  substitute is being chosen, and lets the member notice.
- **Standards get raised in the right direction.** A peak is only a relevant ceiling if it served the
  same why. The record picks the reference performance by motive, not just by output.

**The hard limits on the why**, because this is the deepest possible place for Co to be wrong:

- It is an **inference**, held in the interpreted layer of the member model with a confidence
  ceiling and a stated falsifier. It is never asserted as fact and never used as leverage.
- **It is never surfaced.** Not as a hypothesis, not as a question, not as "if I've got this wrong
  tell me." Co *thinks about* why and lets that shape what it recommends, when, and how. Saying the
  motive out loud is the tell-instead-of-think failure, and it is the deepest form of the therapy
  ritual this document forbids.
- **The member owns the want. Co owns the consistency.** Co never decides the motive is wrong or
  supplies a better one — that is the line the product must not cross (*it must never be better at
  what you want*).
- **Correction happens through outcomes, not through being told.** If recommendations shaped by the
  why keep failing to land, the why was wrong. `OutcomeLearner` revises it from what the member
  actually did, and the superseded hypothesis stays in the record as rejected, so it cannot quietly
  return.

Three services, one mechanism:

**1. Goal reality checks.** Every stated goal becomes a row: the quote, the date, the horizon. Co
tracks the gap between what the member *says* they want and where their time, money, and attention
actually go (stated vs revealed). At a decision point that touches the goal — never on every deposit
— Co surfaces the gap as arithmetic and stops.

> *8/22: "going for the kilocorn." Since then: 0 members onboarded, 7 planning docs, 3 audits, 1
> executor still stubbed. Here are the dates.*

**2. Holding to stated standards.** The member's own retire-tests are the only bar. If they wrote
*"retired when: four straight weeks with something raw shipped to a real person each week,"* Co
tracks exactly that, and reports the streak. It does not invent a standard, and it does not
editorialize on a miss.

**3. Raising the standard from the member's own peaks.** This is the part no external coach can
do. Co keeps a projection of the member's personal bests — best shipping week, fastest turnaround,
the all-nighter that produced the whole synthesis — and uses *those* as the reference class, never a
borrowed one. "Elon works 100 hours" is a mimetic standard and it bounces. *"On 7/11 you produced
the entire frame synthesis in one night. That is your ceiling. This week is at 30% of it"* is the
member's own evidence and it cannot be dismissed.

The rules that keep this from becoming the nagging machine:

- **Stated only, quoted with date.** Never inferred. Never Co's own proposal.
- **Count, don't characterize.** *0 of 5* is a reality check. *You're avoiding* is an accusation.
  The number carries the judgment; Co does not add one.
- **Once, at a decision point.** A goal check fires when the member is about to act on something
  that touches the goal, or at a checkpoint they set. Repeating it is the mute button.
- **The record is the argument.** Co never says what the member is capable of. It shows what they
  already did, and lets them draw the conclusion, because a conclusion someone reached themselves
  is the only kind they keep.

Under this mandate, Co is the friend who remembers exactly what you said you'd do, has the receipts,
and says it one time. Not the coach. Not the accountability app. The witness with a ledger.

## The deposit contract

Actual founder use establishes the primary input behavior: people frequently send bare links, fragments, screenshots, voice notes, or unfinished thoughts without asking a question. These are deposits of attention, not automatic requests for prose.

For every deposit, Co must:

1. faithfully inspect what is accessible and state any coverage limitation;
2. preserve the original signal, timestamp, surrounding moment, and provenance;
3. treat sharing as evidence of attention, not proof of agreement, intent, or identity;
4. update several possible interpretations of why it mattered;
5. perform useful background work without blocking the thread; and
6. keep the member-facing response proportional.

Most deposits should receive silence, a tapback, or one natural line. Unrequested essays tax the act of sharing and eventually train the member to stop.

## The knownness gate

Before any substantive response or proactive intervention, Co must be able to answer internally:

> **What is the informational, interpretive, or practical delta between this and what the member already knows?**

A response earns attention only when it contributes at least one of:

- a material fact the member was unlikely to know;
- a non-obvious connection across otherwise separate evidence;
- a more accurate causal explanation with alternatives considered;
- an unusually apt outside framework, person, source, or counterexample;
- a changed implication for a live decision;
- completed work or a newly available option; or
- a time-sensitive risk or opportunity the member would probably have missed.

Polished restatement is not insight. Counting repeated topics is not insight. Generic advice from a famous person is not insight. If the delta is weak, Co should acknowledge, continue investigating, prepare work silently, or say nothing.

The response ladder is:

```text
silence → tapback → one line → useful answer → prepared work → high-value interruption
```

Co must use the lowest rung that carries the value.

## Personal synthesis

### Evidence, not a personality blob

The durable personal model is a temporal evidence graph, whether its physical store is relational, graph-native, or both. It represents:

- thoughts, questions, ideas, projects, decisions, people, relationships, places, and events;
- sources and channels that earn the member's respect;
- recurring concepts, tensions, analogies, desired qualities, and unresolved bets;
- claims with observation time, source, confidence, validity, contradiction, and correction;
- explicit commitments and authority separately from inferred interests; and
- outcomes that support, weaken, split, merge, or retire prior hypotheses.

Owner statements, external artifacts, connector data, and prior assistant prose are different trust classes. Assistant output can never become independent evidence merely because it was previously written.

### Anti-recency by construction

Retrieval and synthesis must:

- sample across meaningful time periods rather than rank only by recent similarity;
- distinguish a recent episode from a stable pattern;
- search for counterevidence and changes over time;
- prevent recalled or generated material from recursively laundering itself into evidence;
- preserve corrections and rejected interpretations; and
- compare a hypothesis against the strongest competing explanation before surfacing it.

### Finding the hidden thesis

Co must continuously test whether apparently independent deposits are manifestations of a deeper shared question, product, fear, desire, or decision. A candidate synthesis is not surfaced because clustering found repeated words. It must explain more evidence with less distortion and produce a useful implication the member has not already stated.

### Bringing the outside world in

Co maintains an evolving, correctable model of which thinkers, builders, researchers, publications, communities, and channels the member finds credible. It uses that model as a search prior—not an echo-chamber boundary.

When a live situation deserves it, Co should find the precise outside framework that illuminates or contradicts it, then explain:

- the original source and exact idea;
- why it maps to this member and this moment;
- where the analogy breaks;
- what it changes; and
- what, if anything, Co has already done with it.

“Steve Jobs would simplify this” is cosplay. A specific Jobs decision principle, primary-source passage, historical case, or serious counterexample that changes the member's reasoning is useful.

## Agency: an institution behind one contact

Co is not only a brain. It carries durable responsibility through:

- **matters:** evolving situations worth holding across conversations;
- **promises:** explicit burdens Co has accepted and must keep or repair;
- **watches:** conditions in the member's life or world worth monitoring;
- **mandates:** standing, revocable authority for a defined service;
- **work orders:** bounded outcomes with authority and success evidence fixed before execution;
- **specialists:** retained background agents with narrow tools and observable state;
- **receipts:** durable evidence of what actually occurred; and
- **outcomes:** what changed in reality and how the member judged it.

The authority ladder is:

```text
research → prepare → reversible local action → approved external action
         → bounded standing mandate → broader business operation
```

Progress up the ladder requires observed reliability and explicit authority. Co should do safe groundwork before asking a question, but it must never confuse initiative with permission.

Eventually Co may operate substantial parts of a business. That future is earned by the same primitives as sending one correct email: scoped authority, semantic success criteria, idempotent effects, inspectable state, and honest uncertainty.

## Proactivity

Co does not wait only for prompts. It may wake on a new message, completed call, calendar change, location context, expiring window, finished research job, public-world event, contradiction, or mature longitudinal synthesis.

Every proactive candidate is evaluated for:

- novelty relative to what the member already knows;
- personal specificity and evidentiary strength;
- urgency and option value;
- actionability or clarifying power;
- sensitivity, social pressure, and interruption cost;
- repetition and recent message burden; and
- whether silent preparation would be better than interruption.

Most candidates must die or wait. A message is sent only when delay would materially reduce value or the insight has clearly earned attention. Broken promises and uncertain consequential effects are exceptions: they must surface honestly rather than fail silently.

## Harness architecture

The Co-specific layer remains portable across models, agent loops, transports, and execution substrates. It should be expressed as eight explicit services:

1. `SignalRefinery` — understands text, links, video, audio, images, documents, and the sharing moment with honest coverage.
2. `EvidenceStore` — appends provenance-bearing evidence and supports correction, supersession, temporal retrieval, and export.
3. `PerceptionLab` — generates, criticizes, matures, rejects, and revises longitudinal hypotheses.
4. `WorldScout` — finds current facts, frameworks, people, sources, and opportunities outside the existing bubble.
5. `AttentionPolicy` — performs the knownness and interruption tests and chooses silence, hold, acknowledgment, or send.
6. `WorkOffice` — owns matters, promises, watches, mandates, work orders, approvals, receipts, and outcomes.
7. `RelationshipComposer` — gives many backstage processes one coherent iMessage mouth.
8. `OutcomeLearner` — uses corrections and real outcomes to improve retrieval, policies, and proposed skills without rewriting canonical history.

Commodity infrastructure should not be rebuilt without a written product-specific reason. OpenClaw-grade gateway, channel, browser, scheduler, and task machinery may serve as the outer shell. OpenInstinct's opaque, origin-bound credential broker is the security target. Prime-style retained specialists may perform bounded long-horizon work. DeepSeek-style service interfaces and Pi-style provider/terminal primitives are implementation references. Hermes-style skill distillation remains proposal-only and cannot alter authority.

If any outer harness is replaced, the eight Co services and canonical evidence must move without changing user identity, memory, or behavioral policy.

## Model and agent policy

- Foreground, deliberation, background, critic, and specialist roles are independently configurable by provider, model, reasoning effort, token budget, and cost ceiling.
- OpenAI, Anthropic, local, and future model providers share owned request, response, tool, and usage contracts.
- Backstage agents may collaborate, message one another, persist, pause, resume, and be monitored.
- Only `RelationshipComposer` may speak to the member.
- A specialist may produce evidence or a proposal. It may not silently change canonical memory, prompts, skills, permissions, or standing authority.
- Recursive improvement follows `observe → propose → evaluate → approve → version → canary → retain or roll back`.
- No model grades its own promotion alone.

## Production-general, personally specific

The runtime contains no hardcoded Dennis, Donna, personal phone number, private source list, psychological theory, preferred model, or credentials. Person-specific behavior arises from tenant-scoped evidence, explicit settings, learned source affinity, and approved mandates.

The founder's private corpus is a calibration and evaluation asset, never a product default and never committed in raw form. At least one non-founder tenant must pass onboarding, isolation, behavioral, and outcome tests before general production claims.

Onboarding begins with the first real iMessage, not a capability survey. Co provides immediate value with minimal context, progressively requests only the access or authority required for a concrete benefit, previews imports, and never modifies source logs. Existing local conversations remain canonical evidence and can be re-indexed without being rewritten.

## Trust floor: release blockers from the execution audit

The current local implementation clears the deterministic portion of this floor. These remain permanent P0 invariants; live-provider and deployment proof are tracked separately below.

### Truthful completion

- [x] Tool execution returns a typed semantic outcome: `succeeded`, `failed`, or `uncertain`; arbitrary JSON is never interpreted as success merely because no exception was thrown.
- [x] `process.run` succeeds only on an allowed successful exit; timeout, truncation, signal termination, cleanup uncertainty, and nonzero exit are explicit failure or uncertainty.
- [x] Delegation receipts distinguish admitted work, rejected work, partial admission, child completion, and child failure.
- [x] A `tool` or `external-write` work order cannot auto-complete from “any receipt.” It requires named tools and/or a typed postcondition fixed before execution.
- [x] Persisted evidence requirements use strict versioned decoding. Missing fields, wrong types, unknown policies, and corrupt JSON fail closed and become inspectable recovery incidents.
- [x] Read receipts cannot prove a write outcome. Prepared work cannot prove delivery. An accepted request cannot prove completion.

### Effect safety

- [x] Each tool call is claimed atomically by one current lease epoch before execution; conflict cannot reset another worker's running receipt.
- [x] Consequential connectors receive a stable idempotency key derived from tenant, work order, run, and tool-call identity.
- [x] Effects support reconciliation: `not_started`, `accepted`, `confirmed`, `failed`, or `uncertain`. Unknown outcomes are never blindly repeated or silently called complete.
- [x] Lease loss fences future local commits and effect initiation. Exactly-once claims rely on provider idempotency or reconciliation, not a timer alone.
- [x] Execute an explicit restart matrix at every connector boundary around intent persistence, pre/post remote request, acceptance persistence, delivery projection, status reconciliation, and member-conversation commit; keep the generic tool-effect and durable-file boundary matrix alongside it in [the effect crash contract](docs/effect-crash-matrix.md).

### Worker survival and recovery

- [x] One corrupt run, job, event, or projection row cannot terminate the daemon loop. It is quarantined or marked recovery-blocked through a raw, bounded path and processing continues.
- [x] Worker maintenance, scheduling, claiming, execution, finishing, and delivery each have explicit supervision and bounded backoff.
- [x] A job cannot become `completed` while its bound run or work order remains nonterminal unless a unique durable successor owns continuation; the intentional approval handoff is represented by the exact pending approval bound to that run. Restart reconciliation repairs mismatched states deterministically.
- [x] Stale-run recovery, exhausted attempts, lease loss, delayed retry, and connector redelivery execute in tests through `RuntimeWorker`, not only through store primitives.
- [x] Goal deadlines have a scheduler-backed sweep. Continuation budget admission is atomic. Per-run and per-tenant child admission are bounded independently from execution concurrency.

### Real dependency behavior

- [x] Provider and connector errors are classified as retryable, permanent, rate-limited, or uncertain.
- [x] Tests cover 408/429 with `Retry-After`, 5xx, disconnects, timeouts, malformed successful responses, partial responses, and recovery after restart.
- [x] Retryable provider failure actually retries the same durable work within budget; it does not become a completed job carrying a failed run.
- [x] Connector delivery retries only when idempotency or evidence makes it safe; otherwise it creates a visible reconciliation item.
- [x] DNS-pinned fetching tests hostname resolution, mixed public/private answers, redirects, IPv4/IPv6, rebinding resistance, and body limits.

## Product intelligence release gates

Technical durability does not establish good judgment. The semantic system must pass a private longitudinal replay drawn from months—not the latest eighteen hours—of real Co and Co Linq use.

Required eval families:

- **Deposit:** a bare link receives proportionate acknowledgment while full understanding continues backstage.
- **Knownness:** obvious restatement, repeated advice, polished paraphrase, and already-explicit conclusions are suppressed.
- **Hidden thesis:** separate ideas are correctly connected only when dated evidence supports a shared underlying concept.
- **Outside framework:** Co finds a precise, credible source the member would value, explains the mapping and limits, and avoids famous-person cosplay.
- **Anti-recency:** a recent episode cannot overwrite months of contrary evidence.
- **Counterevidence:** attractive stories with a stronger alternative are held or rejected.
- **Subtle reflection:** useful self-understanding appears naturally inside the live topic without therapy scripts or compulsory questions.
- **No growth overfit:** play, aesthetics, relationships, rest, and curiosity are not turned into productivity advice.
- **Useful action:** Co performs safe implied work before presenting menus or asking avoidable questions.
- **Silence:** low-value candidates produce no substantive message.
- **Repair:** a correction changes future behavior while preserving why the earlier interpretation was rejected.
- **Promise:** accepted work survives restart and returns an honest outcome through iMessage.

Evaluation must include blinded pairwise comparison against the current live Co, a fresh frontier model with the same immediate prompt, and the strongest relevant external harness. Scenario strings alone are not tests: the candidate must run, any claimed action must produce a real simulated or live receipt, and behavioral evals may not silently skip in CI.

## Metrics

### North star: useful surprise per interruption

A **useful surprise** is member-validated and does at least one of the following:

- reveals an unseen but supported connection;
- introduces an unusually apt outside framework or discovery;
- changes a decision or makes a situation materially clearer;
- catches a meaningful window, risk, person, or event the member would have missed; or
- completes valuable work the member did not realize could already be done.

Eloquence, praise, topic repetition, and the model's own confidence do not qualify.

### Primary measures

1. **Time to first wow:** elapsed time and meaningful deposits before the first member-validated useful surprise.
2. **Good-response ratio:** useful substantive responses divided by all substantive responses Co chose to send. Silence, tapbacks, transactional acknowledgments, requested delivery receipts, and safety notices are reported separately.
3. **Context advantage:** the share of useful surprises that materially fail when the same turn is evaluated without longitudinal evidence.
4. **Promise reliability:** due promises that are completed, consciously released, or proactively repaired, with outward evidence.
5. **Action truth:** claimed completed actions supported by the exact required semantic receipts.
6. **Deposit health:** whether people continue naturally sending signals without being taxed by unwanted interpretation.

Initial private-beta promotion targets:

- median first wow within 7 days and within 10 meaningful deposits;
- at least 70% good-response ratio and below 10% obvious/annoying substantive responses;
- at least half of validated wows demonstrate material context advantage;
- zero false completion claims, unauthorized actions, silently broken promises, or duplicated consequential effects in the release suite; and
- no declining deposit trend attributable to Co talking too much.

These targets may change only from recorded cohort evidence. They may not be improved by sending more messages, soliciting praise, manufacturing patterns, or narrowing the denominator.

Never optimize raw message count, response length, time in app, streaks, conversation duration, praise, number of memories, number of insights, number of agents, or unendorsed task completion.

## Delivery order

### 0 — make trust claims true

Complete every execution-audit blocker above. Add fault injection at the composed worker level. Rewrite README capability claims to distinguish implemented code, tested composition, live-smoked integration, and aspirational behavior.

### 1 — make iMessage one durable mind

- [x] Canonicalize inbound, outbound, proactive, approval, and result messages into one tenant session.
- [x] Support Linq and Sendblue through the same connector contract, signed callbacks, semantic status receipts, and an explicit operator smoke path.
- [ ] Validate a real signed inbound → reply acceptance → delivered/read status round trip through a deployed endpoint.
- [x] Make every accepted promise visible to a durable scheduler and recovery loop before acknowledging it.
- [x] Preserve fast foreground replies while links, media, memory, perception, and research continue asynchronously.

### 2 — make synthesis produce non-obvious value

- [x] Build the proactive knownness gate against retrieved member evidence without adding a model call.
- [x] Add concept, thought, source-affinity, and latent-thesis projections over the evidence store.
- [x] Separate generator, adversarial critic, counterevidence search, and member-facing composition.
- [ ] Replay the founder corpus across months and beat current Co on hidden-thesis, subtle-reflection, and obviousness evals.

### 3 — connect the right outside world

- [x] Give `WorldScout` provider-neutral external research and source-quality receipts; a deployment still needs to supply and live-smoke its web tools.
- [x] Learn correctable source affinity without trapping the member in an echo chamber.
- [x] Produce framework matches with exact provenance, mapping, limits, and changed implication.
- [x] Support asynchronous YouTube, direct podcast/audio, article, repository-overview, document, image, and conversation/transcript research with explicit coverage; full source-tree and arbitrary podcast-feed traversal remain WorldScout work, not implied media coverage.

### 4 — do the small things that follow

- [x] Convert implications into prepared artifacts, watches, reminder/scheduling/action options, outreach drafts, and research notes; actually scheduling, sending, or contacting still requires explicit authority.
- [x] Add consent-enforced plugin contracts for read-only calendar, email, call, file, browser, and optional location senses; live provider packages and smoke tests remain deployment work, and all member interaction remains in iMessage.
- [x] Add secure browser action through opaque, workspace-bound, origin-bound credential handles that never expose secrets to the model or screenshots; a live isolated-browser smoke remains a deployment gate.
- [x] Graduate external actions only through explicit approval or narrow standing mandates with receipts and revocation.

### 5 — earn 24/7 proactivity

- [x] Run persistent receipt-bound, change-only read scouts off the foreground path; live calendar/email/browser sensors remain deployment work.
- [x] Hold useful nonurgent work for a better moment; let weak or already-known consequence candidates die locally.
- [x] Detect expiring options, unusual coincidences, relevant people/events, cross-domain patterns, and business opportunities through a typed, evidence-bound ambient scanner; live precision and member value remain part of the tenure/product gate below.
- [ ] Demonstrate that proactive quality improves with tenure while interruption volume remains bounded.

### 6 — prove production scale

- [ ] Onboard a non-founder user entirely through conversation plus progressive consent.
- [x] Provide tenant-isolated secrets, evidence, agents, budgets, connectors, portable export/empty-tenant restore, deletion, and audit state; encrypted credential bytes are intentionally non-exportable and must be re-entered.
- [ ] Add Postgres, distributed queue, and blob adapters only when multi-host scale requires them.
- [x] Run local restore, upgrade, concurrent-load, fault, privacy, prompt-injection, and hostile-tenant boundary suites; real hostile infrastructure and sustained load remain deployment gates.
- [x] Canary model, prompt, skill, and policy changes with rollback and cohort-visible versioning.

## V1 definition of done

V1 is done only when all of the following are demonstrated end to end:

1. A new member can text or share something real without onboarding and receive an appropriately small, useful response.
2. A bare link is fully understood in the background without an unrequested essay or false media claim.
3. Co identifies one member-validated hidden thesis across separated, dated thoughts and contributes a genuinely new implication.
4. Co finds one unusually relevant external framework or person the member did not ask for and can show why it mattered.
5. Co catches one meaningful opportunity or closing window the member would otherwise have missed.
6. Co completes one useful implied action and proves the exact outcome with semantic receipts.
7. The same action survives provider failure, worker death, lease theft, restart, and duplicate delivery attempts without false completion or duplicate consequence.
8. A wrong personal inference is corrected once, preserved as rejected history, and not repeated.
9. All reactive and proactive communication appears through one coherent iMessage relationship with no split-brain history.
10. The private-beta metric targets are met, not merely the deterministic unit suite.
11. Another person can onboard without inheriting the founder's identity, taste, memories, permissions, sources, or model configuration.
12. Every original message, import, receipt, correction, and outcome remains exportable and no source log has been modified.

## Non-erasure invariant

- Raw local logs and imported source files are never modified automatically.
- Canonical evidence is append-only; derived projections are rebuildable.
- Corrections supersede claims without deleting the original evidence.
- Rejected hypotheses remain inspectable and cannot silently return as new evidence.
- Agent, goal, work-order, approval, effect, and delivery histories survive cancellation, failure, retirement, migration, and rollback.
- Model, prompt, policy, skill, connector, and schema changes are versioned.
- Onboarding previews imports and never overwrites an existing profile.
- No migration or replatforming may require sacrificing prior conversations or provenance.
- Reindex and rebuild operations preserve rich evidence rows and reconstruct only disposable projections; synthetic agent instructions can never become owner evidence.
- Explicit member/operator tenant deletion is the sole intentional exception: it requires a current verified export, exact tenant confirmation, leaves a non-content lifecycle receipt, and never touches source-log files.

## Current evidence and honest status

As of 2026-09-04 PDT, the local v0.10 working tree passes TypeScript and 331 deterministic tests against real SQLite, with 88.84% line coverage and 73.04% branch coverage across every `src/**/*.ts` file in the latest serial all-source verification run; the latest completed production dependency audit reports zero known vulnerabilities. The audit's false-completion, text-and-native-reaction process-crash matrices, generic effect-boundary, mandate-revocation, owner-quoted-goal, private-motive/substitution/reference-peak, model-cost-envelope, one-shot arithmetic-check, poison-row, orphaned-work, dependency-retry, deadline, child-admission, DNS-pinning, connector-ambiguity/reconciliation/qualification, progressive-consent/retention, opportunity-shape, outcome-learning, historical-tenure/proactive-provenance, external-baseline capture, portable tenant export/restore, immutable-release, backup/restore, concurrent-admission, prompt-injection, and hostile-tenant cases execute through the composed runtime. Tool outcomes are semantic; effects move through explicit reconciliation states; claims and effect initiation are lease-fenced; work evidence is strict and named; scheduled, work-order, and retained-agent instructions preserve agent provenance; corrupt run, job, event, and projection data is preserved in quarantine; and retryable provider work resumes the same run. Schema v47 is additive and preserves prior events, messages, imports, evidence, artifacts, behavior releases, goals, motive/substitution history, and source logs. `worker.ts` has 88.96% line coverage and 61.13% branch coverage. Its stale-job, stale-run, schedule, scheduled-authorization, member-ingress authorization, claim, malformed-claim, finish, attention-delivery, proactive-retry, retry-exhaustion, outcome-feedback preflight, private-motive generation/criticism, cost-ceiling rejection, every connector persistence/dispatch/projection boundary, connector-deduplication, legacy-scout repair, projection-failure, tenant-isolation, and release-rollback paths execute through `RuntimeWorker`; it remains the weakest critical composition surface and is not enough to claim every possible production failure composition is proven. `connector-qualification.ts` is at 98.85% line and 91.46% branch coverage across the normal, missing, forged, drifted, ambiguous, cross-tenant, authorization-rebinding, and status-before-acceptance paths. The OpenClaw adapter is at 89.89% line and 58.87% branch coverage; its successful real invocation and principal drift/error boundaries execute, but its remaining parser and filesystem error branches are not all covered. `product-outcomes.ts` is at 97.91% line and 83.90% branch coverage, including historical owner-event timing, conservative all-message denominators, and forged-proactive-link rejection. `product-qualification.ts` is at 100% line and 92.97% branch coverage across passing, sparse, temporally compressed, internally inconsistent, and acceptance-shaped histories.

Track 1 now has Linq and Sendblue behind the same connector contract, exact signed-webhook verification, replay rejection, normalized delivery statuses, and an explicit `co connector smoke` path that traverses the real durable intent/acceptance/deduplication boundary. Provider HTTP success is recorded only as `message.delivery_accepted`; delivered, read, and failed truth comes from an authenticated callback causally bound to the provider message ID. Both text and native tapback delivery traverse the complete nine-boundary crash matrix; an uncertain tapback can be operator-reconciled without becoming empty text or projecting twice. Member ingress authorization is now retained as the canonical message's exact cause and cannot be rebound on external-ID replay. The read-only `co connector qualify` gate walks that chain through the release-pinned non-mock run, recomputes the reply digest, and requires an authenticated delivered/read callback; normal, forged, drifted, ambiguous, cross-tenant, and callback-before-acceptance cases execute in deterministic tests without exposing message content. This makes the remaining deployed round-trip gate executable, but does not close it: no real deployed-endpoint qualification report was produced. Sendblue and Linq traffic for the same direct phone share one canonical `imessage` session while preserving the active delivery rail. The existing local Co credential file is recognized through migration-safe aliases without exposing values: Linq reports inbound/outbound ready, and Sendblue reports outbound ready but lacks its inbound webhook secret. No live message was sent. Accepted future promises are scheduled before acknowledgement and repair themselves visibly when overdue. Proactive attention has a local knownness veto over owner evidence and prior deliveries, so obvious restatement can die without another model call; retryable proactive delivery now persists bounded exponential backoff and creates visible held work after exhaustion.

Track 2 now has evidence-backed relational graph projections for thoughts, concepts, author/domain source affinity with stable artifact aliases, and latent theses. Shared sources begin as neutral attention rather than endorsement; explicit revisits, endorsements, dismissals, rejections, and actions form a correctable search prior and remain in the event ledger. The tenant-scoped personal-model projection can be transactionally rebuilt from retained evidence and lifecycle records; malformed canonical input rolls the rebuild back instead of erasing the prior view. Longitudinal synthesis uses separate generation, counterevidence, adversarial-critic, and relationship-composition passes, all off the foreground path. These mechanisms are deterministically tested; their actual judgment quality is not established until the private replay gate passes.

Track 3 now has durable `WorldScout` commissions, snapshotted provider-neutral retrieval authority, and source-quality receipts bound to exact successful read calls. Strong coverage and primary/secondary classification must come from a versioned retrieval-adapter envelope whose canonical metadata and SHA-256 content digest match the returned bytes; model arguments cannot promote a snippet or self-assign provenance. Findings require independent publishers, full-source rather than snippet coverage, primary evidence, exact mapping, limits, counterevidence, and a changed implication. A learned positive source affinity remains only a prior: once one exists, the evidence gate requires at least one source outside it. Forged URLs, self-attested classifications, same-domain padding, shallow results, missing primary evidence, and truncated reads fail deterministically. The mechanism has been exercised against a simulated conforming external reader, not a live web provider.

Shared-source enrichment now classifies and bounds articles, text/conversation transcripts, direct audio, images, documents, GitHub repository overviews, unsupported binaries, and YouTube. Coverage names what was actually inspected: visible HTML text is `fulltext`; a GitHub `repository-overview` is metadata plus README and never claims source-tree inspection; unanalyzed binaries stay `metadata`. Native document/image/audio analysis and YouTube watching use the provider-neutral analyzer boundary. Material refreshes append immutable content-and-metadata version rows and enrichment events while retaining the artifact table as the latest projection; migration snapshots the exact pre-versioning projection instead of erasing it.

Tracks 4 and 5 now have a deliberately non-agentic consequence boundary and persistent scouts. Accepted research, perception, artifact, and ambient assessments can be discarded, held, turned into a watching matter, or made into a private brief/draft/option; the planner has no tools or direct external-effect vocabulary. A scout snapshots one authorized read-only MCP/sensor call, its validated arguments, and its creation-time behavior release; it runs as a durable work order, accepts an observation only from the exact confirmed non-truncated receipt, and emits ambient evidence only when the runtime-computed fingerprint changes. Missed intervals do not flood. Three consecutive failed observations stop the scout in `repair_required`, preserve every run and failure event, and create exactly one held repair item. Preserved legacy scouts with no release binding are also held until an operator explicitly selects an assigned release. Only deliberate operator resume resolves that item and resets the failure window; the model cannot silently restart it. These mechanisms are locally proven with simulated sources and restart tests, not live calendar/email/browser connectors.

The browser credential boundary now stores AES-256-GCM ciphertext authenticated to tenant, workspace, credential ID, and exact origin, while returning only opaque handles and field names through CLI, authenticated HTTP, model tools, events, and receipts. The CDP path validates discovery and websocket boundaries, rechecks page origin at injection time, fills through native setters, installs screenshot masking, and never submits. Filling is a non-idempotent external write that crosses the ordinary exact-argument approval gate. These invariants are adversarially tested with a simulated page sink and hostile CDP discovery response; an actual isolated-browser smoke test is still required before deployment.

External action authority is no longer only a global risk switch. A versioned active mandate may cover an exact tool and a recursively matched non-empty argument subset, up to a per-rule use cap and optional expiry. Each allowance is claimed atomically against tenant, mandate, run, call, rule, and a full-argument hash before execution; action truth still comes from the ordinary semantic receipt. Changed call identity, constraint mismatch, exhaustion, expiry, pause, retirement, and cross-tenant use restore explicit approval. Existing descriptive mandate JSON remains valid history but grants no executable authority.

Plugin senses now have a first-class descriptor and progressive-consent boundary. A calendar, email, call, file, browser, or location sense must disclose purpose, data classes, retention, MCP server, and tool; that exact tool must be explicitly allowlisted and locally classified read-only. The runtime wraps it below the model and requires a tenant grant for the current descriptor hash before any read. Permission changes use the normal iMessage approval path or authenticated operator surfaces; plugin drift makes consent stale, revocation stops the next read, and no grant creates write authority or a scout by itself. Append-only tool events retain only sensor-data digests, and an hourly sweep replaces expired successful or failed receipt arguments, results, and provider error bodies with digest-bearing tombstones without rewriting the historical outcome. The contract is tested against a real stdio MCP round trip, but real provider/account connections remain untested deployment inputs.

Ambient opportunity assessment now has explicit `expiry`, `coincidence`, `person_event`, `cross_domain_pattern`, and `business_opportunity` classes rather than a generic “useful” bit. The scanner can cite only tenant event IDs from its bounded source/related-evidence bundle. Future deadlines are mandatory for expiry; coincidences and cross-domain claims require multiple evidence kinds; business claims require multiple events and a concrete changed implication; all results still cross the local knownness, quiet-hours, cooldown, and daily-interruption gates. Deterministic fixtures prove the acceptance and fail-closed shapes, not real-world precision.

Product-quality measurement now has an append-only member-outcome ledger. When an owner naturally and explicitly evaluates the immediately preceding substantive Co message, the selected model may record `useful_surprise`, `useful`, `obvious`, `annoying`, or `neutral` only with a verbatim quote verified against that owner message. A context-advantage claim requires its own owner quote and enters that metric only for a useful surprise. The runtime selects the target message, rejects model-authored sources, never treats silence as agreement, and uses the canonical owner-event time rather than later extraction time for longitudinal measurement. A rating enters proactive quality only through the exact assistant message, acceptance event, accepted outbound intent, and intervention chain; a forged acceptance-shaped event and unlinked praise remain non-proactive. Authenticated HTTP, CLI, and Prometheus separately report accepted versus member-delivered interventions, proactive feedback coverage, tenure-month owner and response volume, promise outcomes, and consequential-effect truth. Promotion-facing good/negative ratios now conservatively divide member-validated outcomes by every substantive response or provider-accepted proactive message; rated-only ratios remain diagnostic and cannot turn missing feedback into success. The read-only `MemberProductQualifier` recomputes projection consistency and applies a versioned single-member gate for first wow, response quality, context advantage, promise reliability, confirmed action, separated proactive-tenure lift, and interruption bounds. It refuses sparse, temporally compressed, internally inconsistent, or acceptance-shaped evidence. If the owner corrects feedback about the same response, both statements remain in history while only the latest one enters aggregates. This makes the measurable single-member portion executable; it still cannot self-attest a real non-founder, cohort median, deposit attribution, causality, or satisfy the open tenure/private-beta targets without real longitudinal member outcomes.

`OutcomeLearner` now closes the first bounded learning loop without allowing self-modification. It traces verified feedback through the exact assistant message, accepted delivery event, outbound intent, and proactive intervention. A current `obvious` or `annoying` classification suppresses only the same tenant/topic; the check runs both at attention admission and immediately before delivery, and it retires already-held matching work before reactivation. A later owner correction changes the derived current policy while both statements and their learning events remain append-only. Positive feedback never raises a score, expands an interruption budget, grants authority, mutates a prompt, or publishes a skill. An exceptionally urgent, evidenced, materially changed operational fact may pass with an explicit recorded override. This is a real policy feedback mechanism, not proof that broader retrieval or skill proposals improve from outcomes; those changes remain proposal/eval/approval work.

The standards-mandate boundary is now enforced below the prompt. A goal created from conversation must cite a short verbatim statement in the current owner-authored `message.received` event; assistant prose, a different tenant, a reused non-message event, and invented wording cannot become a durable commitment. The quote is retained on the goal and its creation event. `goal.transition` lets the owner pause, resume, or cancel through the same relationship with separately verified quoted evidence and append-only transition history. Operator-created goals remain available through authenticated control surfaces. An explicit countable event goal linked to an active member-approved standards mandate can produce one deterministic receipt-backed arithmetic check at a later owner-quoted decision point; changed counts cannot re-arm it, revocation suppresses it at the last safe delivery boundary, and accepted/delivered/read/failed truth remains distinct.

For those explicitly authorized goals only, a release-pinned background worker may now maintain one private, interpreted motive hypothesis. Generation and adversarial criticism are separate no-tool calls. Persistence requires the original commitment, the current owner trigger, and at least one additional owner-trust event spanning seven days; evidence is bounded across months, cannot come from after the trigger, and every future-decision cue must be a literal phrase in one cited owner record. The hypothesis carries a strongest alternative, concrete falsifier, reasoned/borrowed/mixed/unknown origin class, and a hard 0.65 confidence ceiling. It may also carry one lower-confidence substitution candidate, but only when two of the already-cited owner events span seven days and support literal cues for the competing activity; the candidate has its own alternative and falsifier, and generic procrastination or topic overlap is explicitly insufficient.

An explicitly countable goal may additionally opt into a comparable historical window with `referenceWindowDays`. A conversation-created window is accepted only when that exact duration is explicit in the owner's quoted commitment (for example, “this quarter” binds 90 days); the runtime never guesses the comparison horizon from a model interpretation. Before the commitment boundary, the runtime—not the model—computes up to five prior windows whose exact event count exceeded the stated target. The private generator can select only one of those stable candidate IDs, and persistence recomputes it from canonical events. Selection requires cited owner context inside that old window and the current trigger, plus an independent alternative, falsifier, and 0.50 confidence ceiling; output volume or topic similarity is not evidence of the same why. The model-facing reality-check tool receives only the event type, dates, duration, and count. The member sees one additional arithmetic line about their own earlier record, never the private motive match, context evidence, alternative, or confidence. Tampering with the count or window fails authoring, and a changed motive suppresses the already-authored check before delivery.

None of the private interpretations enter foreground context, member-facing tools, or evidence search. Literal decision cues can only determine whether the quoted goal and arithmetic tool are relevant. Verified `obvious` or `annoying` feedback can retire only the exact hypothesis causally bound to the delivered check; the rejection and reason remain append-only, and the same rejected interpretation cannot quietly reactivate. Corrupt motive, substitution, or reference-peak state is quarantined and removed from attention without deleting the interpretation; portable export and additive migration preserve the prior row. This proves the private-why, substitution, and motive-matched reference mechanisms and their safety boundaries. It does not prove that any inference or selected reference is good, or establish that the resulting intervention clears the longitudinal quality gate.

Conversation-first onboarding is now a tested relationship behavior: a fresh neutral tenant can state a preference in ordinary iMessage conversation, retain it with provenance, remain unconnected by default, and grant one descriptor-bound read sense only through the ordinary exact approval path. It inherits no founder memory or consent. This is simulated non-founder evidence; the checklist remains open until a real non-founder also clears the behavioral and outcome gates.

Tenant lifecycle is now explicit. Audit dynamically counts every tenant-scoped table. Portable v3 export captures those rows plus the exact referenced release-manifest/rollout dependency closure in an integrity-checked bundle while excluding browser credential ciphertext/IV/tag. Local restore accepts only a current v3 bundle and `RESTORE:<tenant>`, refuses merge or overwrite, imports the tenant and nonconflicting dependencies in one transaction, remaps database-local event sequence numbers while retaining event identity/time, rebuilds full-text search, and reports credentials requiring re-entry. A stale, tampered, cross-tenant, incomplete, or over-complete export cannot authorize deletion. Deletion is available only to the local operator, requires `DELETE:<tenant>`, securely removes matching database rows, truncates the WAL, preserves a tenant-hashed lifecycle receipt, and leaves imported source files untouched. No deletion or restore was run against the founder or any existing installation while implementing this capability.

The local release-hardening matrix now restores an online SQLite backup into a writable current-schema runtime, round-trips a portable tenant export into a fresh cell, retains the legacy upgrade fixture, admits 64 simultaneous turns through four runtime instances without lost or duplicated runs, exercises worker/provider/connector fault injection, tests credential and tenant-export privacy, proves history reindex cannot discard rich evidence or launder synthetic instructions into owner evidence, proves sensed prompt injection receives no tools and creates no effect receipt, and rejects HTTP tenant selectors against a neighboring row. These are bounded deterministic checks, not evidence of sustained production load or an independently attacked container deployment.

Behavior releases are now complete immutable snapshots of the distribution prompt, all model routes, exact skill revisions, and requested auto-approval policy. Each rollout persists deterministic tenant cohorts, and each run retains its release ID, manifest digest, rollout, and cohort after completion while resumable state pins the behavior itself. Every model-bearing durable job also carries that release through memory extraction, perception, research, content enrichment, ambient judgment, consequences, work orders, and retained-agent delegation; a rollback changes only newly admitted work. Environment-dependent `auto` routes become concrete before persistence, including the CLI release template. Canary, promotion, and rollback replace the active rollout transactionally with audit events; corrupt manifests and unavailable skill revisions fail before provider work. Stored policy is intersected with the deployment's configured authority ceiling. This proves the local mechanism and rollback semantics, not that a live cohort has established a quality lift.

Model routes now optionally pin an operator-priced request-cost envelope alongside provider, model, reasoning effort, and output-token limit. The envelope is complete or rejected: input price, output price, and maximum request cost must all be present, finite, and versioned in the behavior release. `ProviderRegistry` applies it below every foreground and background caller, computes a conservative preflight from the complete serialized request plus provider framing and maximum output, and rejects over-budget work before invoking the adapter. A configured route also rejects missing, invalid, or envelope-breaking response usage; accepted calls attach an estimated cost to immutable model events and the redacted run monitor. Profiles, onboarding verification, environment routes, canaries, and delayed jobs preserve the exact policy. The price schedule remains operator data rather than a stale built-in table. This is a per-request protective ceiling and estimated observability, not a vendor invoice, cumulative tenant billing ledger, or truthful dollar accounting for subscription-backed Codex/Claude CLI sessions; those routes retain token budgets and reject dollar ceilings.

The private replay runner now refuses to complete without a fifth blind baseline from the strongest relevant external harness. Its capture path invokes an operator-selected absolute runner directly over JSON stdin without a shell, and binds the executable, fixed arguments plus regular-file argument contents, configuration digest, exact case input, response, and semantic receipts into baseline schema v2. The shipped OpenClaw adapter additionally pins and rechecks a clean full commit, launcher executable, invoked source, generated runtime, dependency metadata, selected provider-runtime bytes, explicit OpenClaw configuration, and isolated state; it runs the actual `agent exec` interface and never promotes a generic tool summary into semantic outcome evidence. Replacing a response after capture invalidates the invocation before any private model call. The candidate itself runs through an isolated temporary Co cell seeded only with pre-checkpoint history, rather than through a hand-written imitation prompt; useful-action cases must predeclare exact tools and cannot pass without their confirmed outcome receipts. Current logged Co, the full-context candidate, same-model context ablation, fresh frontier model, and external harness then enter one five-way adversarial judgment. A real OpenClaw checkout at commit `8a5978154f692326dead71b40540aa5f13439227` completed a non-private synthetic hidden-thesis case through this boundary and produced a mode-`0600` schema-v2 baseline with zero invented receipts. A local mode-`0600`, timestamp-preserving founder corpus, twelve-family case manifest, and exact external packet have separately been prepared without modifying the source log. No private transcript has been uploaded; the founder-corpus OpenClaw baseline, action-receipt adapter, and five-way model judgment have not run.

This is still not production or product proof. Fresh, history-free tenants completed live synthetic turns through both the Codex CLI and Claude Code CLI provider adapters using the operator's existing authenticated sessions, the configured Gemini boundary completed a synthetic call through its Flash-Lite-first fallback chain, and the exact external-replay path completed a synthetic turn through OpenClaw's real Codex-backed agent harness. Local readiness checks also confirm Linq inbound/outbound and Sendblue outbound configuration. Live OpenAI/Anthropic API, signed Sendblue/Linq round-trip, email, native-video Gemini, WorldScout web-tool, browser, and sensor smoke tests have not run in this verification pass. The behavioral replay still requires explicit permission to send the private dated corpus to configured candidate/frontier/judge models and founder-corpus output from the pinned external harness, so ordinary CI cannot establish longitudinal judgment quality. A real non-founder outcome trial, tenure-based proactive-quality evidence, live calendar/email/call/file/browser/location senses, multi-host isolation, and real hostile-environment fault testing remain open.

The honest description is now:

> **A serious single-tenant agent-runtime candidate with an adversarially tested trust core, durable iMessage rail portability, explicit longitudinal-intelligence machinery, and provenance-bound outside research—but not yet a production service or proof that Co's judgment clears the private replay and member-outcome gates.**

The product evidence behind this goal is preserved in:

- [Founder usage and wow-metric review](../../co/docs/research/review-006-founder-usage-and-wow-metric.md)
- [Founder deposit-behavior analysis](../../co/docs/drops/2026-08-22-founder-usage-analysis.md)
- [Deep-dive behavior review](../../co/docs/research/review-005-deep-dive-behavior.md)
- [Co versus call-converged product gap audit](../../co/docs/research/gap-audit-2026-08-04.md)
- [Agent architecture review](../../co/docs/specs/agent-architecture-review-2026-08-09.md)
- [The Co essay audit](../../co/docs/canon/co-essay-audit.md)
- [v0.10 runtime roadmap and historical verification record](docs/goal-v0.10-runtime-roadmap-2026-09-03.md)

## Final decision rule

When choosing what to build next, ask:

> **Will this help Co notice something important the person would have missed, understand it better than they already do, or safely make the useful consequence happen—without charging more attention than the value returned?**

If not, it does not belong in the critical path.
