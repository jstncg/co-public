# Co experience: conversational, capable, quietly handled

Implementation checkpoint: 2026-09-05. Candidate runtime only; this is not a live cutover or a
claim that the full product is finished. The mission and migration gates remain in `goal.md`,
`FUNCTIONAL-PARITY.md`, and `MIGRATION.md`.

## The voice

Good company, good judgment, capable follow-through. Relaxed and conversational, sometimes dry,
never performing charisma on every turn. Be willing to disagree, without inventing motives.
Humor is optional; grief, frustration, and operational failure are not occasions for a punchline.
A greeting is not an intake questionnaire. An interesting thought is not automatically a goal.
A joke need not become troubleshooting. Finish the useful thing without a compulsory question.

"Handled" is an outcome, not a reassurance style. Report what happened and what remains, with
no invented completion, fabricated familiarity, or unsupported promise to come back later.

The portable voice lives in `distributions/co.json`, combined with shared operating principles
by `src/distributions.ts` and captured in immutable release manifests. It is not a founder
profile, a model-specific fine-tune, or a change to the incumbent brain. Existing pinned releases
do not acquire a new personality merely because a JSON file changed.

## What changed in the runtime

- `src/conversation.ts`: a bounded conversational contract and a referent index over the existing
  canonical transcript. Short follow-ups, greetings, and selected compound requests no longer
  have to contain a question mark to be protected from optional novelty suppression. Recent Co
  contributions retain message IDs, timestamps, and delivery uncertainty. This is not a second
  memory or send ledger.
- `src/source-context.ts`: already-inspected exact-URL sources reach first composition with their
  source IDs, dates, coverage, and bounded excerpts. Missing sources and omitted URLs are explicit.
  Follow-ups can reuse recent linked sources. Queries remain tenant/session bounded; cached source
  content is untrusted evidence, not an instruction or a member belief. This does not inspect a
  new URL synchronously or establish parity with every incumbent reader.
- `src/knownness.ts`: token overlap no longer certifies equivalence. Exact normalized repeats retain
  the cheap path; nonexact similarities remain unresolved until semantic comparison. Short
  negation, short locations, changed numbers, and reordered subjects have regression cases.
  High-overlap optional candidates also stay withheld during held-item revalidation. This is not
  a proof of universal semantic correctness or full historical retrieval coverage.
- `src/runtime.ts`: one shared, durable repair allowance for an omitted direct answer or a detected
  unbacked future promise. It uses the existing run's iteration, token, cost, lease, and authority
  boundaries. Recovery cannot reset the allowance. Rejected drafts never become user messages or
  visible assistant history. Continued failure produces an honest status, not an emoji placeholder.
- Promise detection now includes additional follow-up phrasing and forged tool-looking prose seen
  in a real-model probe. Only an actual successful, outcome-scoped `promise.accept` receipt passes
  that gate. It remains a conservative detector, not a complete semantic proof that every phrase
  refers to exactly the right future operation. Unrelated receipts and pasted-text endorsement
  require further adversarial qualification; do not call those problems completely solved.
- Canonical message ordering now has an insertion-order tie-breaker when timestamps are equal.

Ordinary successful replies do not acquire an unconditional style-polisher or another model call.
Repairs occur only after a detected failure. Source/referent context adds bounded input, so this
is not a zero-latency claim. Existing optional semantic verification still has its own cost.

## Verification and what it establishes

`test/conversation.test.ts` exercises the real runtime with controlled providers and real SQLite:
follow-ups, tenant isolation, delivery-state preservation, same-timestamp ordering, negation,
one-shot repair, dependency failure/reopen, fake tool text, shared repair limits, source coverage,
and source-to-first-compose context. Two composed paths additionally prove:

1. A natural-language correction invokes the actual memory tool; the new statement is carried
   after reopen while the old version remains superseded history.
2. A natural-language request admits a work order; after reopen the worker creates a private
   comparison artifact and completion requires its actual outcome receipt. No external send occurs.

These are plumbing and contract tests, not evidence that a scripted provider has good judgment.
The existing behavior corpus now includes 25 cases, adding warmth, wit, correction, attribution,
own-message continuity, and unsupported completion. Its candidate/judge runner remains a prompt
regression tool, not a substitute for testing the full runtime or independent live review.

Real-model probes also ran through isolated instances of the actual runtime, using only synthetic
conversation fixtures, no action tools, no connectors, and no private memory. Gemini Flash-Lite
was a stress-test provider, not a newly selected production conversation model. Sonnet 5, named
in the incumbent's code, was separately exercised through the existing Anthropic adapter.

The probes found real failures: invented tool-looking reminder prose, unsupported attribution to
a famous person, unnecessary questions after banter, and denial of a supplied prior contribution.
They informed the repairs and referent index above. After the referent index, a Sonnet recheck
unpacked its prior contribution while explicitly acknowledging that the full source was absent.
Other model-dependent weaknesses, including unsupported source extrapolation and overlong replies,
remain. This is neither a blinded comparison nor a passing live-quality qualification.

Run from the Co root:

```sh
pnpm check
node --test packages/runtime/test/conversation.test.ts
```

Verification on this working tree: full `pnpm check` passed, including 471 runtime tests
(12 new conversation integration tests), the incumbent boundary checks, workspace typechecks,
lint/format checks, and the existing workspace suites. This is local verification, not remote CI.

## What still blocks the full experience

No production traffic moved. The incumbent still answers iMessages; the existing candidate daemon
remains mock/no-send. Automatic host restart remains unqualified, and the system-level supervisor
test is not installed. Historical embeddings, full reader/burst/app/voice parity, accepted-duty
reconciliation, source authorization, real delivery canaries, and rollback still need completion.

The next release evidence must include real source comprehension, authorized practical work with a
verified postcondition, and a correction honored later, through the selected live relationship.
Run them under interruption and restart, then compare the experience over time. A personality
upgrade and a larger test count cannot satisfy those gates by themselves.
# Live-path qualification amendment — 2026-09-05, 20:26 Pacific

The candidate is now running a real API provider in a fresh, isolated no-send shadow database.
It selectively reads the existing provider credential below the model; incumbent connector secrets
are not loaded. The previous mock database, source archive, live brain, router and histories remain
intact. No traffic cutover or real outbound canary occurred.

The host's LaunchAgent KeepAlive failure was reproduced with `pended nondemand spawn = inefficient`.
Changing ProcessType did not solve it and was reverted. A user-cron watchdog now requests a start
only for the exact loaded, stopped shadow service. Existing cron entries were retained with a private
before-copy. This is an external process-recovery adapter, not a second work scheduler or sender.

Observed qualification: after a forced kill, a release-pinned synthetic `channel.turn` was admitted
while the candidate was stopped. The scheduler started a new PID without manual kickstart, and the
Anthropic-backed job completed on its first attempt (1,371 input / 6 output tokens). Authenticated
readiness returned 200; tool receipts and outbound deliveries both remained zero. Initial scheduler
startup also occurred without manual intervention. This establishes the tested crash-recovery path
within a logged-in GUI session, not logout/reboot, host-sleep, hung-worker or machine-failure recovery.

Comparison integrity was also corrected: each archived input gets an isolated candidate session
and a bounded incumbent-history window with an observation-sequence cutoff. Unsent drafts are not
indexed as conversation evidence; later incumbent answers, even backdated ones, cannot leak into a
comparison. Fixtures exercise this through the production worker and provider boundary, including
tenant/peer isolation and no delivery. The shadow is still missing pre-activation relationship
history and inspected media; it is not a full-parity quality comparison yet.

Remaining release gates: representative source/media and historical-memory parity, useful real-model
comparisons, retained app/voice compatibility, single-sender action/delivery canaries and rollback
reconciliation. The live iMessage service is still the incumbent. These changes do not claim that
the full runtime experience has reached the member's phone.

## Live experience boundary — 2026-09-06

The Dennis iMessage relationship now reaches this runtime for composition. The existing router is a
compatibility shell, not a competing conversational brain: it keeps the proven carrier, burst,
typing, media-reader, app/viewer, voice and transcript behavior, then makes an authenticated call to
the runtime with the tenant and stable peer. The runtime's configured Co distribution supplies the
portable relaxed-competence voice and the runtime owns model/tool policy for the turn.
The compatibility window is exact-suffix deduplicated against canonical runtime messages, so
continuity does not become a growing duplicate prompt or a fuzzy, lossy merge.

This means a normal Dennis text no longer receives prose from `frame/brain`; a nonempty real-model
reply was observed through the exact `ask_engine` call. The old brain is running separately only for
other tenant identities during migration. Voice-style streaming and the retained app/thread reads
also passed. No artificial confirmation text was pushed to the member to manufacture a delivery
canary.

The experience is not yet self-certified as "full Co." The router still performs carrier delivery
and several useful readers/duties, the runtime has not activated historical semantic backfill, and
no longitudinal review has established that its live judgment beats the incumbent. Those are the
next evidence requirements. The current claim is narrower and concrete: the number's Dennis
conversation is running on the runtime without erasing the old relationship or breaking the other
people on the shared router.
