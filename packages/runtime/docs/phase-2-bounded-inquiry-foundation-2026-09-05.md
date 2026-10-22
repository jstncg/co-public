# Phase 2 bounded-inquiry foundation — 2026-09-05

## Claim

One real source-to-inquiry path now runs inside the existing durable worker. An eligible conversation or enriched-artifact source is first evaluated by a no-tools inquiry planner. The planner can decline work, or it must name a concrete member benefit, answerability class, competing hypotheses, falsifiers, bounded retrieval plan, and stop condition before perception synthesis proceeds.

An admitted inquiry is durable and backstage by default. It cannot send or call a connector: `InquiryManager` depends only on the tenant store. Investigation, a recommendation to surface, attention admission, and transport remain different decisions.

## Restraint contract

- Curiosity, personalization, novelty, unused notification budget, and proof of background activity are not admission reasons.
- Invalid or incomplete plans fail closed and leave a causal rejection event.
- Human-answerable uncertainty does not itself authorize a question.
- A foreground recommendation below the material member-delta floor is rejected.
- A natural-opening recommendation must cite a tenant-owned relationship event that is still inside the bounded conversational window; old deposits cannot be relabeled as a current opening.
- An interruption recommendation additionally requires that waiting destroys material value and that the answer is unavailable privately.
- The relationship composer must compare its proposed message with the best quiet alternative.
- Semantic restatements are recorded as suppressed before the ordinary attention gate.
- Even an eligible inquiry foreground decision cannot send; the existing relationship arbiter remains the only route to transport.

## Preservation and inspection

Schema v54 adds tenant-scoped `inquiries` and append-only `inquiry_foreground_decisions`. The inquiry retains its trigger, plan, terminal finding, counterevidence, remaining uncertainty, and next permitted consequence. Both tables participate automatically in exact tenant export, restore, audit, and deletion. Their JSON plan columns are included in corruption scanning.

Operators can inspect, but not promote, this state through:

```text
co inquiries [--status STATUS]
co inquiry show <id>
GET /v1/inquiries
GET /v1/inquiries/:id
```

## Verification

Executed locally on 2026-09-05:

```text
npx tsc --noEmit
node --test test/inquiries.test.ts test/perception.test.ts
```

The final completed-diff `npm run check` passed TypeScript plus 384 tests with zero failures, skips, or todos.

The fixtures prove default backstage state, no connector effects from inquiry creation/resolution, failure on low member delta, failure without a natural opening, failure on weak interruption timing, source-to-inquiry-to-perception composition, semantic-knownness suppression, authenticated inspection, tenant-safe schema migration, and exact export/restore of inquiry state.

## Deliberate limits

- This slice exercises the longitudinal record/perception source path. It does not yet connect public-answerable inquiries to WorldScout automatically.
- It does not yet create a member question from a live production model; the structural gate for such a question exists and is tested independently.
- Inquiry expiry is durable, but the periodic expiry sweep belongs with the remaining Phase 2 source-health/wakeup work.
- Model judgment is tested with deterministic providers. Live quality and non-annoyance remain external pilot gates under `docs/product-quality-qualification.md`.
- No connector, source, deployment, private-data upload, or authority grant was activated by this implementation.
