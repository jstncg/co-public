# Outcome-learning contract

`OutcomeLearner` is the narrow bridge between what a member explicitly says
about a delivered proactive message and what Co may interrupt them about next.
It is intentionally not autonomous prompt or skill mutation.

## Provenance chain

A feedback statement affects attention only when every link exists for the same
tenant:

```text
owner message.received + verified quote
  -> member_outcome_feedback
  -> preceding assistant relationship message
  -> message.delivery_accepted
  -> accepted outbound delivery intent
  -> exact proactive intervention and topic
```

Ordinary conversational praise and model-authored text may be measured or kept
as history, but cannot alter proactive policy through this path.

## Current projection

- `obvious` and `annoying` suppress a later interruption on the exact topic.
- The gate is checked when a candidate is admitted, before an admitted message
  reaches the provider, and before a held message is reactivated.
- A later correction about the same delivered message supersedes the current
  projection. Both feedback rows and both learning events remain in history.
- Positive feedback is visible to evaluation, but never raises a candidate's
  score, widens authority, raises the daily budget, or bypasses knownness.
- A new operational fact can override a negative topic outcome only when it is
  exceptionally urgent, has at least two pieces of evidence, and is materially
  novel. The decision reason records that override.

The current view is derived from canonical delivery and feedback evidence on
every read, so it can be rebuilt without a mutable learned-policy table.

## Tenure measurement

Product reporting uses the canonical `message.received` event time as the
feedback observation time. Recording or extracting an older owner statement
today therefore does not collapse months of evidence into the current month.
The record time remains separately visible and neither timestamp is rewritten.

Reactive praise and proactive outcomes are reported separately. A rating is
proactive only when the complete provenance chain above exists; an event named
`message.delivery_accepted` without its matching accepted outbound intent does
not qualify. Reports expose provider-accepted and member-delivered intervention
counts separately, proactive feedback coverage, proactive good/negative ratios,
and per-tenure-month owner messages, substantive responses, intervention
outcomes, and current owner ratings. A correction replaces the current metric
for one target but leaves both source statements in history.

Rated-only ratios are diagnostic. Promotion-facing good and negative ratios use
all substantive responses—or all provider-accepted proactive messages—as the
denominator, so missing feedback cannot become positive evidence. Context
advantage is counted only on member-validated useful surprises, not ordinary
`useful` ratings. `co product-qualify` also verifies that counts and ratios agree,
requires minimum sample sizes and separated tenure months, and exits nonzero
when the measurable single-member gate is not proven.

These are descriptive evidence, not an automatic declaration that quality
improved. The open tenure gate still needs enough real longitudinal member
outcomes to show a lift without rising interruption volume; sparse coverage and
missing delivery evidence remain visible rather than being imputed as success.
Even a passing single-member report cannot establish real non-founder identity,
cohort medians, deposit attribution, or causality.

## Deliberate exclusions

This mechanism does not infer approval from silence, optimize for praise, alter
standing mandates, change a model route, rewrite a distribution prompt, or
publish a learned skill. Retrieval and skill changes still follow the ordinary
proposal, replay, approval, release, canary, and rollback process.

## Deterministic evidence

`test/outcome-learner.test.ts` and `test/product-outcomes.test.ts` verify
exact-topic scope, tenant isolation, correction without erasure, weak-signal
rejection after positive feedback, urgent material-change override,
pre-provider suppression of queued work, retirement of held work, historical
owner-event timing, accepted-versus-delivered denominators, and the inability
of unlinked praise or an acceptance-shaped event to forge proactive evidence.
